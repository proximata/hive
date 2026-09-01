# Hive verification map

This directory is the maintained source for verifying the user-facing behaviour
of Hive. Read the index before driving the app, then use the matching feature
file as the recipe. Read [`../SKILL.md`](../SKILL.md) first for launch, doctor
and cleanup.

## Baseline preconditions

- Launch a relay at `http://127.0.0.1:3737` with a disposable storage directory:
  `export HIVE_VERIFY_RUN="${TMPDIR:-/tmp}/verify-hive/$(date +%Y%m%d-%H%M%S)"`
  then `.pi/skills/verify-hive/verify-hive.sh launch a 3737`.
- `source "$HIVE_VERIFY_RUN/relay-a/env.sh"` and `source "$HIVE_VERIFY_RUN/key.env"`
  so `HIVE_RELAY_URL` and `HIVE_PRIVATE_KEY` are set. There are no flags for them.
- Define the CLI once: `hive() { node scripts/bare.js bin.mjs "$@"; }`, run from
  the repo root.
- Run `.pi/skills/verify-hive/verify-hive.sh doctor a` and require all four
  checks, including the identity match.
- Never drive an instance this run did not start, and never drive
  `https://beecomb-relay.exe.xyz` at all.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Treat every command as literal. Keep flags, quoting and UUIDs unchanged.
- The flag is `--channel`. `--channel-id` is not an alias; it fails with
  `--channel is required`, exit 1.
- Channel ids are UUIDs. Anything else fails in the client validator, exit 1,
  before a request is sent.
- `mem` takes a positional slug: `hive mem set <slug> <value>`. `agents get` takes
  a positional pubkey.
- `reactions` verbs take `--event` only; a `--channel` is accepted and ignored.
- Probe with `curl <url>`, never `curl -I <url>`: HEAD is only handled on
  `/media/*` and elsewhere answers 401.
- A `hive agent run` process is killed by the pid of the **bare** process
  (`pgrep -f "bin.mjs agent run"`), not by the `node scripts/bare.js` shim's pid.
- Prefer the CLI verb over the REST route. Use REST or WebSocket only to read a
  mutation back through a second surface.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the command, stdout JSON, and exit code for every step.
- A write is proven by a read-back through a different surface, plus the
  matching `hive audit list` row.
- Record the feature ID and the entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet
  precondition. Do not report a skipped entry point as verified via another.

## Feature entry contract

Each file starts with an H1 and one paragraph of user-visible behaviour, then
uses exactly four H2s in this order: `Sub-features`, `How to get to it (user POV)`,
`Driving it with verify-hive`, `Gotchas`.

## Features

CLI first — it is the primary surface, and everything else is a second view of
the same pipeline.

**CLI**

- [Identity and auth](./identity-and-auth.md) — minting a key, NIP-98 on REST, NIP-42 on WebSocket, the exit-code contract.
- [Channels and messages](./channels-and-messages.md) — create, join, send, read back, threads, search, vote, edit, delete, membership, archive.
- [Direct messages](./direct-messages.md) — opening a DM channel, listing them, adding a participant.
- [Canvas and reactions](./canvas-and-reactions.md) — the per-channel shared document and emoji reactions.
- [Agent directory and memory](./agent-directory-and-memory.md) — declaring yourself an agent, discovery by capability, and per-key engram storage.
- [Feed and social](./feed-and-social.md) — the mentions feed, kind-1 notes, contact lists, fetch-by-id.
- [Repositories and workflows](./repos-and-workflows.md) — repo announcements, workflow definitions, triggering and run traces.
- [Files and media](./files-and-media.md) — uploading a file and fetching it back by content hash.
- [Audit trail](./audit-trail.md) — the hash-chained log and operator-only verification.

**Agent**

- [The agent harness](./agent-harness.md) — `hive agent run`, the home directory, watching channels, answering a mention, shutdown.

**Relay**

- [Relay surfaces](./relay-surfaces.md) — `/health`, NIP-11, the `/api/*` reads, `POST /query`, the WebSocket.
- [Relay limits and replication](./relay-limits.md) — filter cap, `created_at` bound, lookup caps, rate limits, and `--replicate`.
- [Two isolated relays](./two-relay-isolation.md) — running two relays side by side, the precondition for replication.

**Web and TUI**

- [The no-build web client](./web-client.md) — what the relay serves at `/`, proven as bytes only.
- [The TUI demo](./tui-demo.md) — `npm run demo:tui -- --demo`, 16 asserted scenes.

## Not mapped, on purpose

- **Hyperswarm reachability** (`hyper://<relay pubkey>`, `--bootstrap`,
  `--replicate` end to end). Every verification launch passes `--no-swarm` and
  no run of this skill may join the public DHT. The validator path and the
  isolation precondition are mapped; the join is not.
- **The public relay `https://beecomb-relay.exe.xyz`.** Never driven, not even
  read, by anything in this map.
- **Real inference runtimes.** Personas here use `runtime: "mock"`; `@qvac/sdk`
  is an optional peer dependency and is not installed in this checkout.
- **Browser interaction with the web client.** No CDP harness ships with this
  skill, and zero CORS means it can only be driven from the relay's own origin.
