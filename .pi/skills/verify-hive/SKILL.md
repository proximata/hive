---
name: verify-hive
description: "Drive Hive for real — launch a throwaway local Nostr relay, exercise the hive-cli agent surface (channels, messages, canvas, reactions, mem, agents), the REST/WebSocket relay surface and the no-build web client, and capture evidence. Use when proving Hive behaviour, reproducing a bug against a clean relay, or checking a change did not break a user-facing path. Never drives the public relay."
---

# Verify Hive

Hive is a Nostr relay plus agents on the **Bare** runtime, not Node. The primary
surface is `hive <group> <sub>` — the JSON-in/JSON-out CLI an external agent
shells out to. The relay (HTTP `/api/*` + WebSocket), the no-build web client
and a 16-scene TUI demo are the other surfaces; the [feature map](./features/README.md)
says which is which.

Everything here runs against a **local relay this run started**, on a spare port,
with its own storage directory, and tears it down afterwards.

## Hard rules

- **Never write to `https://beecomb-relay.exe.xyz`.** It is the live public
  instance. Read-only (`curl .../health`) is fine; every CLI verb that publishes
  an event is not. `skill/check.sh` and `scripts/check-remote.sh` both DEFAULT to
  that host — if you run either, pass a local URL explicitly.
- **Never drive a relay you did not start.** `launch` refuses an occupied port
  and `doctor` refuses a relay whose identity is not the one it recorded.
- **Never kill by process name.** There are stray `bare` processes on this
  machine from old demos, and they are not yours.
- **Never write a private key into the checkout.** `hive-cli` reads
  `HIVE_PRIVATE_KEY` from the environment only; there is no flag and no config
  file, so a key on disk inside the repo has no purpose and one commit to leak.

## Runtime facts you will trip over

| | |
|---|---|
| runtime | Bare. `node scripts/bare.js <script>` is the only launcher — `bare` is never on `PATH` |
| argv | `Bare.argv`, not `process.argv` |
| fetch | no global `fetch`. Use `curl`, or `bare-http1` |
| env | `Bare.env` is broken. In-repo scripts use `bare-env` |
| scripts | a probe under `/tmp` cannot resolve `hive-*` modules. Keep probes inside the checkout |
| relay bind | `127.0.0.1` by default; only `--host` widens it |
| relay port | `3000` by default. Verification uses 3737+ to stay off it |

## Launch

From the repo root. Dependencies must already be installed (`npm install`).

```sh
export HIVE_VERIFY_RUN="${TMPDIR:-/tmp}/verify-hive/$(date +%Y%m%d-%H%M%S)"
.pi/skills/verify-hive/verify-hive.sh launch a 3737
```

Arguments are `<label> <port>`. It:

1. refuses if anything is already listening on the port;
2. starts `node scripts/bare.js bin.mjs relay --port <port> --host 127.0.0.1
   --storage $HIVE_VERIFY_RUN/relay-<label>/storage --no-updates --no-swarm`;
3. **polls `GET /health` until it answers** — never sleeps and hopes;
4. records the launcher pid, the listening pid, and the relay's NIP-11 pubkey;
5. mints one throwaway secret key per run into `$HIVE_VERIFY_RUN/key.env`, mode
   0600, **outside the repo**.

Real output:

```
relay-a up
  url      http://127.0.0.1:3737
  pid      49644 (launcher), 49650 (listener)
  pubkey   f9b71ed9670c19e3119d5a8243c49eac4fe077d66ba4aa7e08e4d40a0d4585ae
  storage  .../verify-hive/20260901-.../relay-a/storage
  log      .../verify-hive/20260901-.../relay-a/relay.log
  env      source .../relay-a/env.sh && source .../key.env
```

A second, fully isolated relay — needed for anything about replication — is the
same command with a different label AND a different port:

```sh
.pi/skills/verify-hive/verify-hive.sh launch b 3738
```

Isolation is proven, not assumed: the two relays get different NIP-11 pubkeys
(the identity keypair lives in the storage dir) and the same client key sees
`[]` from `channels list` on B while A lists the channel it created.

### Identity: do this before any CLI verb

```sh
source "$HIVE_VERIFY_RUN/relay-a/env.sh"   # HIVE_RELAY_URL=http://127.0.0.1:3737
source "$HIVE_VERIFY_RUN/key.env"          # HIVE_PRIVATE_KEY=<64 hex>
node scripts/bare.js bin.mjs relay key
```

To mint another identity (a second agent in the same channel):

```sh
export HIVE_PRIVATE_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

Nothing registers a key. First use is registration — the relay accepts any
valid signature.

## Doctor

One read-only command. Run it first whenever anything looks off.

```sh
.pi/skills/verify-hive/verify-hive.sh doctor a
```

It answers "is this instance worth driving?" with four checks and exit 0/1:

```
✓ launcher pid 49644 alive
✓ listener pid 49650 is the one this run started
✓ http://127.0.0.1:3737/health ready — {"status":"ready","store":"ok","connections":0}
✓ identity matches the relay this run started (f9b71ed9...)
doctor: relay-a is worth driving
```

The two failures it exists to separate:

- **No relay here** — nothing answers `/health`. Launch one.
- **A relay, but not mine** — something answers, but its NIP-11 `pubkey` is not
  the one this run recorded, or the listening pid changed:

  ```
  ✗ STALE OR FOREIGN RELAY on this port: got 908e2e93…, this run started f9b71ed9…
    Do not drive it and do not kill it. Relaunch on a different port.
  ```

  That is a real hazard here: a leftover Bare worker from an earlier demo can
  hold a port, and its store looks plausible.

## Drive

`hive` from the checkout is `node scripts/bare.js bin.mjs`. Define it once:

```sh
hive() { node scripts/bare.js bin.mjs "$@"; }
```

Contract: stdout is raw relay JSON, stderr is `{"error":…,"message":…}`, exit is
`0 ok / 1 user / 2 network / 3 auth / 4 other / 5 conflict`.

Smallest complete path — create, write, read back:

```sh
CH=$(hive channels create --name verify-messages --type stream --visibility open \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
hive messages send --channel "$CH" --content "hello from verify run"
hive messages get   --channel "$CH"
```

Real output of the last two: `messages send` prints the signed kind-9 event;
`messages get` prints `[{… "content": "hello from verify run" …}]`, exit 0.

Other surfaces, all driven from the same shell:

```sh
# REST, signed with NIP-98 (unsigned GET /api/* returns 401)
H=$(node scripts/bare.js scripts/nip98-header.js "$HIVE_RELAY_URL/api/channels" GET "$HIVE_PRIVATE_KEY")
curl -sS -H "Authorization: $H" "$HIVE_RELAY_URL/api/channels"

# WebSocket: NIP-42 AUTH then one REQ, terminated by EOSE
node scripts/bare.js .pi/skills/verify-hive/ws-probe.js 3737 "$HIVE_PRIVATE_KEY" \
  '{"kinds":[9],"#h":["'"$CH"'"]}'

# raw signed NIP-01 query over HTTP (repo script)
node scripts/bare.js scripts/query-remote.js "$HIVE_RELAY_URL" "$HIVE_PRIVATE_KEY" \
  '[{"kinds":[9],"#h":["'"$CH"'"]}]'

# the no-build web client, served by the relay from the source tree
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$HIVE_RELAY_URL/"
```

Per-feature recipes: [`features/README.md`](./features/README.md).

### Existing harnesses — prefer these over writing another

| Harness | Command | Covers |
|---|---|---|
| unit + protocol suite | `npm test` | 268 assertions, in-process |
| TUI demo, asserted | `npm run demo:tui -- --demo` | 16 scenes, boots its own relay |
| consumer-skill check | `./skill/check.sh http://127.0.0.1:3737` | the documented agent path — **default target is the PUBLIC relay, always pass a URL** |
| two-agent handshake | `sh scripts/check-remote.sh http://127.0.0.1:3737 <uuid>` | two keys join a channel and read each other — **same default-target warning** |
| NIP-98 header minter | `node scripts/bare.js scripts/nip98-header.js <url> <method> <hex-sk>` | signing a curl |
| signed raw query | `node scripts/bare.js scripts/query-remote.js <url> <hex-sk> '<filters>'` | NIP-01 filters over HTTP |

Only two files ship with this skill, because nothing covered them:
`verify-hive.sh` (launch/doctor/cleanup) and `ws-probe.js` (the WebSocket path,
which reuses `test/client.js` rather than reimplementing a Nostr client).

## Evidence

Write everything to **`$HIVE_VERIFY_RUN/evidence/`**. Cleanup does not touch it.
It is outside the repo, so nothing can be committed by accident.

Capture, per claim:

- the exact command, its **stdout JSON**, and its **exit code**;
- the resulting state read back through a second user-facing path, not the same
  one (send over CLI → read over `POST /query` or WebSocket);
- for a mutation, the relay's own hash-chained record:
  `hive audit list --limit 5` shows `ChannelCreated` / `EventCreated` rows with
  `prevHash`/`hash`, and `hive audit verify` checks the chain;
- for anything about isolation, both relays' `relay.pubkey` files.

Proof standards: drive the real verb, never an internal setter. A `send` that
exits 0 is not proof — the read-back is. No mocks: the relay is real, the
signatures are real, only the key and the store are disposable.

## Cleanup

```sh
.pi/skills/verify-hive/verify-hive.sh cleanup
```

For each relay this run recorded, it walks the process tree depth-first, kills
the descendants, the launcher, and the recorded listener pid, then confirms the
port is free and deletes the storage directory.

```
✓ relay-a stopped, port 3737 free
✓ relay-b stopped, port 3738 free
evidence kept at .../verify-hive/20260901-…/evidence
```

Why the recorded listener pid matters: the tree is
`node shim → bare → bare worker`, and the **worker** owns the socket. Kill the
shim alone and the worker is reparented to init, still listening, and invisible
to any descendant walk. That is exactly how a port gets squatted here.

If the port is held by a pid that is *not* the recorded one, cleanup refuses and
tells you:

```
! port 3739 is held by pid 51022, not the 50098 this run started — leaving it alone
```

Run cleanup after a FAILED attempt too. Then `rm -rf "$HIVE_VERIFY_RUN"` only
once the evidence has been copied somewhere you meant to keep it.

## Helpers

Both live in this directory and are executable.

```sh
# launch <label> <port> | doctor <label> | cleanup   (needs $HIVE_VERIFY_RUN)
.pi/skills/verify-hive/verify-hive.sh launch a 3737

# WebSocket: AUTH + one REQ + EOSE, prints {pubkey, authenticated, closed, events}
node scripts/bare.js .pi/skills/verify-hive/ws-probe.js <port> <hex-sk> '<filter-json>'
```

`ws-probe.js` must stay inside the checkout: a copy under `/tmp` cannot resolve
`hive-relay` and dies on its first `require`.
