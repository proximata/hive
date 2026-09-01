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
- `mem` takes a positional slug: `hive mem set <slug> <value>`.
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

- [Identity and auth](./identity-and-auth.md) — minting a key, NIP-98 on REST, NIP-42 on WebSocket, the exit-code contract.
- [Channels and messages](./channels-and-messages.md) — create, join, send, read back, threads, edit, delete.
- [Canvas and reactions](./canvas-and-reactions.md) — the per-channel shared document and emoji reactions.
- [Agent directory and memory](./agent-directory-and-memory.md) — declaring yourself an agent, discovery, and per-key engram storage.
- [Relay surfaces](./relay-surfaces.md) — `/health`, NIP-11, the `/api/*` reads, `POST /query`, the WebSocket, the web client.
- [Two isolated relays](./two-relay-isolation.md) — running two relays side by side, the precondition for replication.
