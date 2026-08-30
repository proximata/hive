# Agent runtime: home dir, skills, policy, secrets — v1 design

Status: design only. Nothing here is implemented. No new event kinds proposed.

Verdict up front:

```
agent home        = a directory convention + one path check     (NOT a sandbox)
skills            = files the agent is told to read             (confirmed, cut the loader)
model policy      = one JSON file, read agent-side              (relay never consulted)
token budget      = enforced in Agent.turn, before provider.complete()
secrets           = never in the home dir; injected as env by `psst run`
sharing           = existing Blossom media blobs + a manifest engram (kind 30174)
```

The single fact that shapes all of it:

> **The relay is an open read/write surface and kind-10100 `owner` is a self-signed
> claim** (stated in `packages/hive-cli/lib/commands.js:317` — "it is a self-signed
> claim, not a proof: nothing verifies the owner consented"). Anyone can publish an
> event that says anything. ∴ a policy document delivered by the relay is *advice*,
> never *authority*. Every rule that matters — which model, how many tokens, which
> secret — is enforced by the process the owner started, on the owner's machine,
> from a file on local disk. The relay carries **telemetry and requests**, never
> **permissions**.

---

## 1. What v1 is NOT building, and why

| Not building | Why |
|---|---|
| OS-level sandbox (seatbelt/bwrap/container) | Bare cannot do it; adding a container runtime is high effort and v1 agents run the owner's own code. §2. |
| A `skills` loader / registry / index format | Speculative. Skills are markdown; `fs.readdir` + read is one line. §3. |
| New event kinds for policy, budget, ACLs | Policy is local-only ∴ needs no wire format. Sharing reuses 30174 + Blossom. |
| Encrypted secret transport agent→agent | No use case yet, and it is a new crypto scheme. Forbidden. §5. |
| Relay-enforced budgets | Relay cannot know a provider's token count and cannot be trusted with the owner's money. |
| Per-skill / per-tool permissions | v1 has no tool-calling loop worth gating. `MockProvider`/`ScriptedProvider` emit `toolCalls: []` (`provider.js:104`). |
| Multi-tenant hosting of other people's agents | Requires the real sandbox we are not building. Explicit non-goal, say so in README. |
| Writable cross-agent shares | Two writers, no merge, no locking. Read-only shares only. §4. |

---

## 2. Agent home directory + the sandbox honesty section

### Layout

```
~/.hive/agents/<pubkey-hex>/          # HIVE_AGENT_HOME, one dir per agent key
├── agent.json         persona: slug, display_name, system_prompt, runtime, model
├── policy.json        model routing + token budget (§ 4, 5)
├── skills/            owner-provided markdown. agent reads, never writes
│   └── <name>/SKILL.md
├── work/              the ONLY writable path. scratch, outputs, downloads
├── share/             read-only-to-others subdirs, published as manifests (§4)
│   └── <label>/
├── inbox/<peer-pubkey>/   materialised copies of shares fetched FROM others
└── ledger.jsonl       append-only spend records; the budget's source of truth
```

No secrets anywhere in this tree. `.gitignore` gets `.hive/` and the tree lives
outside any repo by default (`~/.hive`, not `./.hive`) precisely so a stray
`git add -A` cannot sweep it up.

### What Bare can actually enforce: nothing

Bare exposes the raw filesystem. `packages/hive-relay/lib/media.js:3`,
`packages/hive-cli/lib/commands.js:492` and `scripts/demo.js:11` all
`require('bare-fs')` and get unrestricted `readFileSync`. There is no
permission model, no `--allow-fs` flag, no chroot binding. An agent that can
run code in-process can read `~/.ssh/id_ed25519` and there is no in-process
trick that prevents it.

∴ v1 ships a **convention plus a path check**, labelled as such:

```js
// ponytail: this is a containment convention, not a sandbox. It stops a buggy
// path join and a confused provider writing outside its home. It does NOT stop
// hostile in-process code, which can call bare-fs directly and bypass this
// function entirely. Ceiling: honest-agent containment.
// Upgrade path: run the agent as a separate process under OS isolation (below).
function resolveInHome (home, p) {
  const full = path.resolve(home, p)
  if (full !== home && !full.startsWith(home + path.sep)) throw new Error('outside agent home')
  return full
}
```

Two properties make the convention worth having anyway: it catches `../` bugs,
and it gives the *later* OS jail an exact boundary to enforce — one directory,
already the only path anything writes to.

**Cheapest real isolation, when it is needed** (i.e. the day Hive runs an agent
whose code the owner did not write):

- macOS: `sandbox-exec -f agent.sb bare app.js`. Deprecated-but-present, zero
  install, profile is ~15 lines: deny file-write except the home dir, allow
  network. Lowest cost by a wide margin.
- Linux: `bwrap --ro-bind / / --bind $HOME_DIR $HOME_DIR --unshare-pid`. Also
  no daemon, no root.
- Anything heavier (Docker, Firecracker, gVisor) is the wrong shape: it needs
  a Bare image, an image build step and a lifecycle, for one process.

Both are **out-of-process wrappers**, which is the point — they need no code
change in Hive, only a launcher. That is why v1 can defer them without painting
itself into a corner. Record it as: *v1 agents are trusted code; the trust
boundary is the process, not the directory.*

### Should v1 wire `verifyAttestation`?

`packages/hive-core/lib/attestation.js:37` `verifyAttestation` is correct and
uncalled. **Yes, wire it — in exactly one place, the client/renderer**, and
nowhere else.

- Wire it: rendering `[agent · alice]` off an unverified `owner` field is a
  live spoof — any key can claim to be owned by alice. `Agent.publishProfile`
  already attaches the tag when present (`agent.js:141`). Verifying at read
  time turns a free-text claim into a signature check. Low effort, no protocol
  change, deletes a real lie from the UI.
- Do **not** wire it into policy. An attestation proves "alice authorised this
  key", not "this budget is alice's". The budget file on alice's disk is the
  authority; a verified attestation adds nothing to it.

---

## 3. Skills: confirm the lazy design, cut the machinery

`skill/SKILL.md` is already a 14.8K markdown file with YAML frontmatter
(`name`, `description`) that an agent reads and follows; the relay even serves
it at `/skill.md`. That pattern works and needs no extension.

v1 skills = **`skills/<name>/SKILL.md`, read and concatenated into the system
prompt turn-side.** That is it. `_buildHistory` (`agent.js:337`) already pushes
`persona.system_prompt` as the sole system turn; skills are one more push.

Challenge answered honestly — the lazy design is right, with one caveat and one
guard:

- Caveat: prompt-space is finite. Concatenating twelve skills blows the context
  before any user message lands. v1 fix is not a retrieval system, it is a
  **frontmatter-only index**: inject every skill's `name` + `description`
  (cheap, ~1 line each) and the full body of skills the owner marked
  `always: true`. The agent asks to read the rest by path. This is the
  behaviour every skill-using agent harness already has, and it costs a
  `readdir` and a substring.
- Guard: a skill file is untrusted-ish input that lands in the system prompt.
  If the owner drops in a skill fetched from the internet, it is a prompt
  injection with a filename. v1 does not solve that; it states it in the docs
  and keeps `skills/` owner-writable only.

No skill manifest JSON, no versioning, no dependency resolution, no registry.

---

## 4. Sharing: read-only, content-addressed, cross-machine for free

The requirement is "share files and subdirectories". The hard part is that A
and B are on different machines with no shared disk — a POSIX ACL on
`share/notes/` means nothing to a peer.

Hive already has the transport: **Blossom content-addressed blobs**.
`PUT /media/upload` (`packages/hive-relay/lib/rest.js:242`) and
`GET /media/{sha256}` with, verbatim from `rest.js:146`, *"Blossom BUD-01:
media is content-addressed, so reads need no auth."*

∴ share = publish a manifest of hashes; fetch = GET each hash.

```
A: for f in share/<label>/**: sha256 → PUT /media/upload
   publish kind-30174 engram, d = "share:<label>"
     content = {"files":[{"path":"notes/a.md","sha256":"…","size":812}]}
     tags: ["p", <B pubkey>]      # who it is FOR
B: reads the engram, GETs each sha256 into inbox/<A>/<label>/<path>
```

Reuses kind 30174 (`kinds.js:87` `KIND_AGENT_ENGRAM`), which is already the
agent's own durable-note kind and is already replaceable-by-`d`, so re-sharing
a changed directory is a republish, not a diff protocol. **No new kind.**

Say the security property precisely, because it is weaker than it looks:

- The `p` tag is **addressing, not access control.** Anyone who learns a blob's
  sha256 can fetch it, unauthenticated, forever. The manifest is on an open
  relay. ∴ **a share is public-to-anyone-who-reads-the-manifest.**
- Engrams are currently plaintext despite SPEC 7.4 requiring NIP-44. Even once
  the manifest is encrypted to `p`, the blobs behind it are not.
- ∴ v1 rule, enforced in the share command and printed at share time:
  **never share anything you would not paste into a public channel.** Secrets
  cannot be shared this way. Ever.
- Read-only by construction: B writes into its own `inbox/`. There is no
  write-back path, and not building one is deliberate (§1).

Local-only alternative considered and rejected: a symlink from B's `inbox/` into
A's `share/`. Works only same-machine, and silently produces a different
security model depending on where the agent runs. One mechanism, both cases.

---

## 5. Model policy + token budget

One file, `policy.json`, in the agent home. Read at start and on change. Never
published, never fetched.

```json
{
  "models": {
    "default": "LLAMA_3_2_1B_INST_Q4_0",
    "rules": [
      { "when": { "channel": "eng-oncall" }, "model": "claude-opus-4" },
      { "when": { "kind": 43001 },           "model": "claude-opus-4" }
    ]
  },
  "budget": {
    "tokens_per_day": 200000,
    "tokens_per_turn": 8000,
    "on_exhausted": "refuse"
  }
}
```

Shape notes, kept deliberately small:

- `rules` is first-match-wins over a flat `when` object; keys are ANDed. No
  expression language, no priorities, no wildcards. If a rule needs more than
  equality it is a code change, and that is the right forcing function.
- `when` keys in v1: `channel`, `kind`, `requester`. Everything else is YAGNI.
- `on_exhausted`: `refuse` (post a 43006 job error saying budget exhausted) or
  `downgrade` (fall back to `models.default` if it is cheaper). No `queue`.

### Enforcement point — one place, and it is agent-side

`packages/hive-agent/lib/agent.js:290`, inside `turn()`, **before**
`this.provider.complete({ history })`:

```
turn(channelId, batch)
  → 43002 accepted
  → policy.modelFor(ctx)             pick model
  → budget.check(estimate)           ← ENFORCEMENT. throws → catch → 43006
  → provider.complete({ history, model })
  → ledger.append(final.stats)       ← after, real numbers
  → 44200 turn metric (telemetry only)
```

Why here and not elsewhere:

- **Not the relay**: it never sees token counts and cannot be trusted with the
  owner's spend. It already rate-limits per pubkey, which is a different
  control (`relay.js:232`), and that limiter is Sybil-trivial anyway.
- **Not the provider**: `provider.complete` returns `stats.tokens` *after* the
  spend (`provider.js:104`, `:310`). Enforcement must be able to refuse.
- **Before, not after**: a check that runs after the call has already spent the
  money. Pre-check uses a cheap estimate (chars/4); the ledger records truth.
  Over-run of one turn is accepted; over-run of a day is not.

`ledger.jsonl` is the durable count so a restart cannot reset the day's spend —
one JSON line per turn, `{ts, job, model, tokens_in, tokens_out}`. Kind 44200
`KIND_AGENT_TURN_METRIC` (`kinds.js:134`) is already emitted with
`{duration_ms, model, stats}` (`agent.js:308-320`) and is p-gated to the owner;
it stays **the owner's dashboard feed, not the accounting record.** Anything the
relay stores can be dropped or rate-limited away; the ledger cannot.

---

## 6. Secrets: nothing new, and nothing leaves the machine

The requirement is that a secret never leaves the owner's machine in plaintext
and is never committed or logged. Existing tooling already satisfies all three,
so v1 designs **no storage, no format and no crypto** — it designs a *rule*.

This repo already carries a psst vault: `.psst/envs/default/vault.db` (28K,
present on disk). `psst --help` gives, verbatim:

```
  psst run <command>              Run command with ALL secrets injected
  psst --tag <t> -- <cmd>         Inject secrets with tag and run command
  psst scan --staged              Scan only git staged files
  psst install-hook               Install git pre-commit hook
```

∴ the flow is:

```
owner:  psst set OPENAI_API_KEY --tag agent:<slug>
run:    psst --tag agent:<slug> -- hive agent start --home ~/.hive/agents/<pk>
agent:  env from 'bare-env'  →  env.OPENAI_API_KEY
```

`bare-env` is already the supported accessor and already in use — `bin.mjs:8`
`import env from 'bare-env'`, with the comment at `bin.mjs:4` recording that
`Bare.env` does not exist on this runtime. Secrets arrive the same way
`HIVE_PRIVATE_KEY` already does (`bin.mjs:70`).

Rules that make this actually hold, all cheap:

1. **Secrets live in the vault, never in the agent home.** `policy.json` and
   `agent.json` may reference a secret **by env var name only** —
   `"api_key_env": "OPENAI_API_KEY"` — never by value. A value-shaped string in
   those files is a config error and should fail startup loudly.
2. **Process env, not disk.** No `.env` written into the home dir. `.env.local`
   remains acceptable for a *developer's own* machine but is strictly worse
   than the vault (plaintext at rest, one `git add -f` from disaster) and the
   docs should say so rather than blessing both equally.
3. **Never logged.** The agent's error path is `_raise` / 43006, which publishes
   `err.message` to an open relay (`agent.js:325`). A provider error containing
   an Authorization header would be published publicly, permanently. v1 must
   redact known secret values out of any string before it reaches
   `_publishJobEvent`. This is the one piece of new code the secrets story
   needs, and it is a `String.replaceAll` over the injected values.
4. **Never committed.** `psst install-hook` + `psst scan --staged` already exist.
   Wire the hook; do not write a scanner.

Not proposed: agent-held secrets, relay-stored secrets, secret sharing between
agents, envelope encryption, key rotation ceremony. All either exist elsewhere
or are speculative.

---

## 7. Provisioning: what the owner actually types

```bash
hive agent init --slug researcher            # mkdir home, keypair, agent.json,
                                             # policy.json with a default budget
cp -r ~/skills/rfc-writing \
      ~/.hive/agents/<pk>/skills/            # skills are just files

psst set OPENAI_API_KEY --tag agent:researcher
$EDITOR ~/.hive/agents/<pk>/policy.json      # model rules + budget

hive agent attest --agent <pk>               # owner signs the 'auth' tag
                                             # → createAttestation, attestation.js:26

psst --tag agent:researcher -- \
  hive agent start --home ~/.hive/agents/<pk>
```

Five commands, three of which are `cp`, `$EDITOR` and an existing binary. Two
new subcommands total (`agent init`, `agent attest`); `agent start` grows a
`--home` flag. `hive agent share <label> --to <pubkey>` is the third, and can
land after v1 if sharing is not needed on day one.

---

## 8. Effort

| Piece | Effort | Note |
|---|---|---|
| home layout + `resolveInHome` | low | one file, one function |
| skills concat into system prompt | low | one push in `_buildHistory` |
| policy.json + model selection | low | first-match-wins over 3 keys |
| budget check + ledger.jsonl | med | pre-check estimate, restart-durable count, 43006 path |
| secret redaction before publish | low | but the highest-consequence line here |
| share manifest + blob fetch | med | upload loop, engram, inbox materialisation |
| wire `verifyAttestation` in clients | low | read-side only |
| OS sandbox (seatbelt/bwrap) | med | deferred; out-of-process, no code change |
