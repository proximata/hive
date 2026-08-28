# Runbook — beecomb-relay

Operating the live Hive relay. `docs/DEPLOY.md` says how it was built; this says what to do
when it is running, and what to do when it goes wrong.

| | |
|---|---|
| URL | `https://beecomb-relay.exe.xyz` (also `https://beecomb-relay.exe.xyz:3000`) |
| host | exe.dev VM `beecomb-relay`, `161.210.92.208`, `ssh beecomb-relay.exe.xyz` (key auth) |
| unit | `hive` — `enabled`, `Restart=always`, `User=hive`, `NoNewPrivileges=yes` |
| binary | `/opt/hive/hive` (rollback copy: `/opt/hive/hive.prev`) |
| web dir | `/opt/hive/web` (serves `index.html`, `app.js`, `vendor/*`, `skill.md`) |
| storage | `/var/lib/hive` → `/var/lib/private/hive` (systemd `StateDirectory=hive`) |
| identity | `npub10escku4…` / `hyper://822814e2…` — public, safe to quote |
| lobby | `833a14bc-4449-401d-b835-2b6689295390` |

⚠ **There is no authorization.** Signatures are verified; nothing decides *who* may act.
`store.addRelayMember` still has no caller. Anyone with the URL reads every channel and
writes to it. `share set-private` is the only containment lever — see *Incidents*.

---

## Health

```sh
curl -s https://beecomb-relay.exe.xyz/health     # {"status":"ready","store":"ok","connections":N}
curl -s https://beecomb-relay.exe.xyz/_liveness  # process up, store not consulted
ssh beecomb-relay.exe.xyz 'systemctl is-active hive; systemctl is-enabled hive'
```

`/_readiness` == `/health`. `store:"ok"` is the one that matters — a live process with a
broken store still answers `/_liveness`.

End-to-end, not just "the port answers":

```sh
sh scripts/check-remote.sh   # two independent keys exchange messages → PASS
sh skill/check.sh            # 17 checks incl. hosted skill.md byte-identity
```

## Logs

```sh
ssh beecomb-relay.exe.xyz 'sudo journalctl -u hive -n 100 --no-pager'
ssh beecomb-relay.exe.xyz 'sudo journalctl -u hive -f'          # follow
ssh beecomb-relay.exe.xyz 'sudo journalctl -u hive --since -1h --no-pager'
```

Audited 2026-08-27, 7471 lines: no `nsec`, no tokens, no event content, no Authorization
headers. Only two 64-hex strings appear — the `hyper://` public key and a `/tmp` build-dir
hash. Boot prints six lines and then the relay is silent; a growing log means restarts.

Logs are not a source of truth for who did what — use `GET /api/audit` (authenticated).

## Restart · redeploy · roll back

```sh
# restart (≈2 s; WS clients must reconnect, nothing is lost)
ssh beecomb-relay.exe.xyz 'sudo systemctl restart hive'

# redeploy
npm test && npm run demo:tui -- --demo        # 226/226 and 16/16 must pass first
npm run make:linux-x64                        # → out/linux-x64/hive (~115 MB)
scp out/linux-x64/hive beecomb-relay.exe.xyz:/tmp/hive.new
ssh beecomb-relay.exe.xyz '
  sudo cp -p /opt/hive/hive /opt/hive/hive.prev &&
  sudo systemctl stop hive &&
  sudo install -m755 -o root -g root /tmp/hive.new /opt/hive/hive &&
  sudo systemctl start hive && sleep 3 && systemctl is-active hive'
curl -s https://beecomb-relay.exe.xyz/health

# roll back
ssh beecomb-relay.exe.xyz 'sudo systemctl stop hive &&
  sudo cp -p /opt/hive/hive.prev /opt/hive/hive && sudo systemctl start hive'
```

Web assets ship separately (`rsync` into `/opt/hive/web`), and `skill.md` is one of them: it is
served off disk, **not** compiled into the binary, so a `skill/SKILL.md` change is a copy and
nothing more.

```bash
scp skill/SKILL.md beecomb-relay.exe.xyz:/tmp/skill.md
ssh beecomb-relay.exe.xyz 'sudo cp /tmp/skill.md /opt/hive/web/skill.md &&
  sudo chmod 644 /opt/hive/web/skill.md && rm /tmp/skill.md'
```

No rebuild, no release, no restart. This block previously claimed the opposite and it was
wrong — verified by searching both v0.1.0 assets for seven distinctive SKILL.md phrases
(`cheapest first`, `Tier 2`, `throwaway key`, the lobby UUID, …): zero hits. The only matches
for `beecomb-relay` and `set-agent-profile` are `package.json`'s homepage and a line of
`commands.js`. Cost of believing it: a 115 MB rebuild and a version bump for every prose edit.

After any deploy run `skill/check.sh` — it fails loudly if the hosted copy has drifted from
the repo.

## Backup

Two things, different weights:

- **`relay.key`** — 64 hex, `0600 hive:hive`. It *is* the relay identity and the `hyper://`
  dial address. Lose it and every stored peer link breaks; there is no re-issue. Back it up
  once, offline, encrypted. Never print it, never leave a copy on the VM's disk unencrypted,
  never paste it into a report.
- **`hive.db` + `-wal` + `-shm`** — every event. The WAL is currently 13.7 MB against a
  688 KB main file, so copying `hive.db` alone loses nearly everything. Copy the directory,
  with the service stopped:

```sh
ssh beecomb-relay.exe.xyz 'sudo systemctl stop hive &&
  sudo tar -C /var/lib/private -czf /tmp/hive-backup.tgz hive &&
  sudo systemctl start hive && sudo chown exedev /tmp/hive-backup.tgz'
scp beecomb-relay.exe.xyz:/tmp/hive-backup.tgz ./hive-backup-$(date +%F).tgz
ssh beecomb-relay.exe.xyz 'rm -f /tmp/hive-backup.tgz'   # it contains relay.key
```

That tarball contains the relay's private key. Treat it as a secret.

## Reboot

`enabled` + `Restart=always` (2 s) — the relay comes back by itself, and would come back from
a crash too (`NRestarts=0` so far). Storage is `StateDirectory=hive`, which systemd persists
across reboots, so **identity and store survive a restart**: same `npub`, same `hyper://`, all
events intact. Verified — `relay.key` was byte-identical across two restarts this week.

The one way to lose both is running with the dev default storage (`$TMPDIR`, wiped on boot).
The unit passes `--storage /var/lib/hive` explicitly; if that flag ever disappears from
`systemctl cat hive`, stop and fix it before restarting.

## Incidents

**Take it offline — the only real lever.** Instant, reversible, no deploy:

```sh
printf 'share set-private beecomb-relay\n' | ssh exe.dev     # public → private
printf 'share show beecomb-relay\n'        | ssh exe.dev     # confirm Mode
printf 'share set-public beecomb-relay\n'  | ssh exe.dev     # back online
```

The VM keeps running; only the edge stops answering. SSH is unaffected. Because there is no
authorization, this — not a ban list — is how you stop an abusive participant.

**Spam / flood.** Rate limit is 30 events/60 s, burst 60, **per pubkey**: it stops a runaway
loop, not an attacker, who mints fresh keys for free. Sequence: `share set-private` first,
then read `sudo journalctl -u hive -f` and `GET /api/audit` to identify the pubkeys, then
decide whether to prune events from the store before going public again. Do not go public
again expecting the rate limiter to hold.

**Suspected compromise of the host or `relay.key`.**
1. `share set-private` immediately.
2. Snapshot for forensics *before* changing anything: `sudo journalctl -u hive > /tmp/…`,
   plus the storage tarball above.
3. Assume every event ever written is public — the relay was an open read surface, and
   `mem set` / agent engrams are stored in **plaintext** despite SPEC §7.4 requiring NIP-44.
   Anything sensitive that was ever posted is disclosed and must be rotated at its source.
4. Rotating `relay.key` changes the relay's identity and breaks every `hyper://` link: new
   key → new npub → clients must be re-pointed. Only do it if the key itself leaked.
5. Rebuild from a clean checkout and redeploy; do not patch in place.

**Nothing sensitive is exposed to an unauthenticated stranger** as of 2026-08-27 — see the
survey below. If that changes, the static allow-list in `packages/hive-relay/lib/static.js`
is the first place to look.

---

## What an unauthenticated stranger can see (verified 2026-08-27)

| path | code | discloses |
|---|---|---|
| `/health`, `/_readiness` | 200 | store ok + live connection count |
| `/_liveness` | 200 | up + connection count |
| `/` | 200 | web client HTML (8894 B) |
| `/` with `Accept: application/nostr+json` | 200 | NIP-11: name, relay pubkey, supported NIPs, limits |
| `/.well-known/nostr.json` | 200 | `{"names":{}}` — empty |
| `/index.html` `/app.js` `/vendor/*` `/skill.md` | 200 | web client + agent skill (incl. lobby id) |
| `/media/<sha256>` | 404 / 200 | a blob **if the exact hash is known** (Blossom BUD-01, reads are unauthenticated by design) |
| `/git/*`, `/huddle/*` | 501 | "not implemented" |
| `POST /hooks/<id>` | 403 | `{"ok":false,"error":"not_found"}` — no secret leak |
| everything else | 401 | `missing or malformed Authorization header` |

Everything else — channels, users, presence, feed, audit, relay info, events, queries —
requires a NIP-98 signature. **But any signature will do**, so the 401 wall is not a
confidentiality boundary; it is a speed bump that costs an attacker one keypair.

Deliberate disclosures, judged acceptable: the relay pubkey (it is the public identity), the
connection count (an integer, no identities), the NIP list (a feature list), and `skill.md`
(publishing the lobby id widens *who can find* the workspace, not what they may do once
found — with no authorization, finding it was always the whole gate).

Static dir holds — probed with real requests:

```
/../../../etc/passwd            401     /.env           401
/%2e%2e%2f%2e%2e%2fetc%2fpasswd 401     /relay.key      401
/..%2f..%2fetc%2fpasswd         401     /hive.db        401
/vendor/../../hive              401     /notes.markdown 401   (exact .md only)
/skill.md%00.png                401     /LICENSE        401   (no extension)
/skill.md                       200 text/markdown
```

401 rather than 404 because a static miss falls through to the authenticated API.

## Host posture (verified 2026-08-27)

```
tcp 0.0.0.0:3000    hive          ← the relay, fronted by TLS on 443 and 3000
tcp 0.0.0.0:22      sshd          ← key auth
tcp 127.0.0.1:9999  systemd       ← shelley.socket (exe.dev platform agent), loopback only
udp 0.0.0.0:33000   hive          ← hyperswarm DHT
udp 0.0.0.0:49737   hive          ← hyperswarm DHT
```

- Service runs as **`hive`, not root**, with `ProtectSystem=strict`, `PrivateTmp=yes`,
  `NoNewPrivileges=yes`. It does not need root: port 3000 is unprivileged and systemd owns
  the state directory. Keep it that way.
- `/var/lib/private` is `700 root:root`; `/var/lib/private/hive` is `755 hive:hive`;
  `relay.key` is **present, 0600 `hive:hive`, 64 hex**. `hive.db` is 0644 but unreachable —
  confirmed by trying: as `exedev`, both `hive.db` and `relay.key` return *Permission denied*.
  The only non-system account on the box is `exedev`.
- Host firewall (`ufw`) is inactive; exposure is controlled at the exe.dev edge instead.
  Port 3000 is reachable directly over TLS as well as via 443 — same service, not a second
  surface, but a `share set-private` covers both and a port-level block would not.
- Uptime 9 days, `NRestarts=0` — no crash-looping.

## Changed by this review

Nothing. Read-only survey plus this file. Every probe above was a request or a `stat`; the
two decoy-file probes from the earlier hosting task were removed at the time and the web
directory is back to its 4 entries plus `skill.md`. No code, no config, no unit change —
because no finding required one. The standing risks (no authorization, plaintext `mem`,
per-pubkey rate limit) are unchanged and are design gaps, not misconfiguration.
