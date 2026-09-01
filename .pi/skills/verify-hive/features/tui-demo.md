# The TUI demo

`hive demo` is the guided terminal walkthrough: it boots a relay of its own and
plays 16 scenes against it, from connecting through channels, conversation,
moderation, workflows and personas to a health dashboard. With `--demo` every
scene asserts, so it doubles as the repo's widest end-to-end gate.

## Sub-features

- `tui-assert` `--demo` plays every scene and asserts it, exiting non-zero on a failure.
- `tui-record` `--record` plays at real pace for a screen capture.
- `tui-attach` `--relay <url>` attaches to a running relay; scenes needing the relay's own store report SKIP.
- `tui-scenes` the 16 scenes: connect, channels, join, converse, search, react, dm,
  mention, dashboard, admin-channels, access, moderation, audit, workflows, personas, health.

## How to get to it (user POV)

- `npm run demo:tui -- --demo` — assert every scene
- `hive demo` — watch it interactively
- `hive demo --record --speed <n>` — real-pace playback for a capture
- `hive demo --relay http://127.0.0.1:3737` — attach to an existing relay
- `hive demo --help` — the demo prints its own flags and key bindings

## Driving it with verify-hive

Preconditions:

- Repo root, dependencies installed.
- **No relay of yours needs to be running.** The demo boots its own on its own
  port with `--no-swarm`; it does not touch the relay `verify-hive.sh launch`
  started, and it never touches the public relay.

- **Run the gate.** `npm run demo:tui -- --demo`. Exit 0, last line:

  ```
  16/16 scene(s) passed
  ```

- **See the per-scene verdicts.** `npm run demo:tui -- --demo 2>&1 | grep -E '^(PASS|FAIL|SKIP)'`:

  ```
  PASS connect          PASS dm              PASS moderation
  PASS channels         PASS mention         PASS audit
  PASS join             PASS dashboard       PASS workflows
  PASS converse         PASS admin-channels  PASS personas
  PASS search           PASS access          PASS health
  PASS react
  ```

- **Proof.** The full transcript in `$HIVE_VERIFY_RUN/evidence/demo-tui.txt`,
  including the `16/16` line and the per-scene verdicts. A scene list without a
  count, or a count without the list, is half a proof.

## Gotchas

- **`--demo` is what makes it a gate.** Without it the demo plays and exits 0
  whatever happened on screen; the assertions only run under `--demo`.
- The demo is the **widest** check in the repo but not the deepest: it drives
  its own seeded scenario, not your change. `npm test` (268 assertions) and the
  per-feature recipes here cover what it does not.
- `hive demo --help` is handled by the demo itself, not by the top-level usage
  text — the one flag combination that does not print the binary's usage.
- Attaching with `--relay` turns some scenes into **SKIP**, not FAIL: those
  scenes need the relay's own store or event stream, which an attached relay
  does not expose. A `SKIP` in that mode is expected; a `SKIP` in the default
  mode is not.
- It writes to a relay it started. Never point `--relay` at
  `https://beecomb-relay.exe.xyz`.
- The output is a full-screen TUI, so a transcript captured without redirecting
  is full of escape sequences. Redirect to a file and grep for
  `PASS`/`FAIL`/`SKIP` and the final count.
