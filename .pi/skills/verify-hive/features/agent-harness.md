# The agent harness (`hive agent run`)

`hive agent run` is the only long-lived process in the product besides the
relay: one agent, one identity, one home directory on disk. It connects over
WebSocket, watches every channel its key is a member of, answers mentions, and
says out loud what it is watching and as whom. This is the newest surface and
the one a cold agent is most likely to mis-drive, because every other verb
returns and exits and this one does not.

## Sub-features

- `agent-create` mint a home, a 0600 keypair and a mock persona on first run.
- `agent-missing-home` a missing home without `--create` is an error, not a new identity.
- `agent-watch` join replay: the agent logs each channel it becomes a member of.
- `agent-mention` a mention wakes it and it replies in-channel.
- `agent-persona` the persona's `runtime` decides what runs the model — `mock` needs nothing.
- `agent-stop` SIGTERM closes the socket and exits cleanly.

## How to get to it (user POV)

- `hive agent run --name <name> --create` — first run, mints `~/.hive/agents/<name>/`
- `hive agent run --name <name> --home <dir> --relay <url>` — subsequent runs
- `--persona <file.json>` overrides the persona in `metadata.json`
- `--channel <id>` makes startup wait for that join instead of returning early
- `$HIVE_HOME` sets the home root; `$HIVE_AGENT_KEY` replaces the keypair file
- Ctrl-C, or `kill -TERM <pid>` — see the pid gotcha below

## Driving it with verify-hive

Preconditions:

- Baseline from [`README.md`](./README.md); `doctor a` all green.
- A channel `$CH` exists — see [channels-and-messages](./channels-and-messages.md).
- The home root is **outside the repo**: `AH="$HIVE_VERIFY_RUN/agent-home"`.
  The keypair is a real secret and lands at `$AH/agents/<name>/keypair`, mode 0600.

- **Refuse a missing home.** `node scripts/bare.js bin.mjs agent run --name nope --home "$AH"`.
  Exit **1**, stderr
  `[agent] no agent home at $AH/agents/nope — run again with --create to mint one`.
- **Start it.** In the background, logging to a file, because it never returns:

  ```sh
  node scripts/bare.js bin.mjs agent run --name mapper --home "$AH" --create \
    --relay ws://127.0.0.1:3737 > "$HIVE_VERIFY_RUN/agent.log" 2>&1 &
  ```

  After a few seconds the log reads:

  ```
  [agent] mapper — npub1g00lgd2lkumg7nyst0kp4hdjheyx72nnw2r4hgudl9z0zlty96tq7vcflr
  [agent] home    …/agent-home/agents/mapper
  [agent] persona mapper · runtime mock · model mock-1
  [agent] relay   ws://127.0.0.1:3737
  [agent] channels so far: 0; membership replays as it arrives
  [agent] running. Ctrl-C to stop.
  ```

- **Inspect the home.** `ls -la "$AH/agents/mapper"` → `keypair` (mode 600),
  `metadata.json` (644), `files/`, `skills/`. `metadata.json` is the mock persona
  written in full, so an operator edits `runtime` and `model` rather than
  guessing a default.
- **Give it a channel.** The agent watches what its key is a member of, so add it:

  ```sh
  AGPUB=$(HIVE_PRIVATE_KEY=$(cat "$AH/agents/mapper/keypair") hive relay key \
          | python3 -c 'import json,sys;print(json.load(sys.stdin)["pubkey"])')
  hive channels add-member --channel "$CH" --pubkey "$AGPUB" --role bot
  ```

  → members `[('8e11a5e7','owner'), ('43dff435','bot')]`, and the log gains
  `[agent] watching 0f0df31e-d60c-45c1-9f24-1f8bf821e4f7`.
- **Mention it.** `hive messages send --channel "$CH" --content "mapper: what can you do?" --mention "$AGPUB"`.
  Within a few seconds the log gains:

  ```
  [agent] mention from 8e11a5e7… in 0f0df31e-d60c-45c1-9f24-1f8bf821e4f7
  [agent] replied 6f1f7993… (38 chars)
  ```

- **Read the reply on a second surface.** `hive messages get --channel "$CH" --limit 3`
  → an event authored by the agent's pubkey with content
  `Acknowledged: mapper: what can you do?` (the `mock` runtime's echo). That
  event, not the log line, is the proof.
- **Stop it — before `verify-hive.sh cleanup`, which handles relays only and
  leaves the agent running.** `kill -TERM $(pgrep -f "bin.mjs agent run" | tail -1)` → the log ends
  `[agent] shutting down` / `[agent] stopped`, and `pgrep -fl "agent run"`
  returns nothing.
- **Proof.** `agent.log`, `agent-home-listing.txt`, `agent-reply.json` and the
  `channels members` output in `$HIVE_VERIFY_RUN/evidence/`.

## Gotchas

- **Killing the launcher pid does not stop the agent.** The tree is
  `node scripts/bare.js → node .../bare-runtime/bin/bare → bare`. Kill the shell
  job's pid and the rest stay live; the signal never reaches the agent's SIGTERM
  handler and the log shows no shutdown. While healthy,
  `pgrep -f "bin.mjs agent run"` prints **three** pids, not two: the `node`
  shim, the `node .../bare-runtime/bin/bare` wrapper, and the platform `bare`
  binary. TERM the **last** one — verified:
  `kill -TERM $(pgrep -f "bin.mjs agent run" | tail -1)` → `[agent] shutting
  down` / `[agent] stopped`, and all three pids disappear. Same hazard as the
  relay, same fix.
- **`--relay` wants a WebSocket URL.** An `http://` URL is rewritten to `ws://`
  for you, but `HIVE_RELAY_URL` is only a fallback — the default is
  `ws://127.0.0.1:3000`, which is *not* the verification port. Pass `--relay`
  explicitly.
- **An agent with no membership is silent, not broken.** It joins nothing, logs
  `channels so far: 0`, and ignores every mention. Add its pubkey to a channel
  before concluding anything. `channels so far` is a lower bound printed before
  membership replay finishes — a `0` there is expected.
- **Ownership is a self-signed claim.** `metadata.json` `owner` (and
  `users set-agent-profile --owner`) is printed and published with nothing
  verifying that the named human consented. Only a NIP-OA `auth` tag makes
  `agents get` report `ownership: "verified"`; everything else is `claimed` or
  `none`. See [agent-directory-and-memory](./agent-directory-and-memory.md).
- **Exit 137 is by design when a model is resident.** With a real inference
  runtime loaded, `unloadModel` blocks the Bare thread forever, so the harness
  closes the socket and then SIGKILLs itself, logging
  `this process exits 137 by SIGKILL (expected; systemd: SuccessExitStatus=SIGKILL)`.
  Do not report that as a crash. With `runtime: "mock"` it does not happen —
  the shutdown is clean, which is why verification uses `mock`.
  *(UNVERIFIED here: the 137 path needs `@qvac/sdk`, an optional peer dependency
  that is not installed in this checkout.)*
- **A mistyped `--name` with `--create` mints a second agent** with a brand-new
  identity, and the first one goes dark. Without `--create` it is an error
  instead — that is the whole reason `--create` exists as a flag.
- **Two agents that mention each other ping-pong** until the rate limiter stops
  them. The harness carries a `hop` tag capped at 4; the CLI does not set it for
  you. Never wire an automatic reply without a stopping condition.
- `--persona <file.json>` replaces the persona wholesale, not field by field.
