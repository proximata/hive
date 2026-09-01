# Repositories and workflows

Two announcement-shaped features. A repo announcement (NIP-34, kind 30617) says
"this git repo exists and here is where to clone it" — Hive stores and serves
the announcement and nothing else. A workflow (kind 30620) is YAML-or-JSON
automation the **relay** executes: triggered, it runs its steps and posts
messages signed with the relay's own key.

## Sub-features

- `repo-create` announce a repository.
- `repo-get` / `repo-list` fetch one by its `d` id, or list all.
- `wf-create` publish a workflow definition (`workflows update` is the same handler).
- `wf-list` / `wf-get` list definitions, optionally scoped to a channel.
- `wf-trigger` run one manually and see the run recorded.
- `wf-runs` read the run log with its per-step trace.
- `wf-approve` answer a `request_approval` step. *(UNVERIFIED — needs a run that pauses on approval.)*
- `wf-delete` tombstone a definition. *(UNVERIFIED.)*

## How to get to it (user POV)

- `hive repos create --id <slug> --name <name> --description <text> --clone <url>`
- `hive repos get --id <slug>`, `hive repos list`
- `hive workflows create --definition <yaml-or-json|-> [--channel <uuid>] [--id <slug>]`
- `hive workflows list [--channel <uuid>]`, `hive workflows get --workflow <slug>`
- `hive workflows trigger --workflow <slug> --channel <uuid>`
- `hive workflows runs [--workflow <slug>] [--limit n]`
- `hive workflows approve --token <token> [--approved false] [--note <text>]`

## Driving it with verify-hive

Preconditions:

- Baseline from [`README.md`](./README.md); `doctor a` all green.
- A channel `$CH` exists.

- **Announce a repo.** `hive repos create --id map-demo --name "Map Demo" --description "verification map repo" --clone "https://github.com/proximata/hive.git"`
  → exit 0, `kind 30617`, `tags [['d','map-demo'],['name','Map Demo'],['clone','https://github.com/proximata/hive.git']]`.
- **Read it back.** `hive repos get --id map-demo` returns the stored event;
  `hive repos list` returns `1`. A miss is exit 1,
  `{"error":"user","message":"repository announcement not found"}`.
- **Write a definition.** Minimum that parses — `trigger.on` and at least one
  step with a known `action`:

  ```json
  {"name":"Map Check","trigger":{"on":"message_posted"},
   "steps":[{"id":"greet","action":"send_message","text":"map check ran"}]}
  ```

- **Publish it.** `cat wf.json | hive workflows create --definition - --channel "$CH"`
  → exit 0, `kind 30620`, `tags [['d','map-check'],['name','Map Check'],['h','<uuid>']]`.
  The `d` slug is derived from the name (`Map Check` → `map-check`) unless `--id` says otherwise.
- **List and fetch.** `hive workflows list --channel "$CH"` → `1`.
  `hive workflows get --workflow map-check` → the same event.
- **Trigger.** `hive workflows trigger --workflow map-check --channel "$CH"`
  → exit 0, `kind 46020`.
- **Read the run.** After a second, `hive workflows runs --workflow map-check`:

  ```json
  [ { "id": "2498c11f5a87238647499c466bcf6f24", "workflowId": "map-check",
      "status": "completed",
      "trigger": { "manual": true, "author": "8e11a5e7…" },
      "trace": [ { "step": "greet", "output": { "event": "03a0211a…" } } ] } ]
  ```

- **Read the side effect on a second surface.** `hive messages get --channel "$CH"`
  contains a message with content `map check ran` and a `["buzz","workflow"]`
  tag — and its `pubkey` is the **relay's** identity
  (`47981b49…`, the same value `/info` reports), not yours.
- **Proof.** `repo.json`, `workflow.json`, `workflow-run.json` and the
  `messages get` output in `$HIVE_VERIFY_RUN/evidence/`.

## Gotchas

- **The message field is `text`, not `content`.** A `send_message` step written
  with `content` validates, publishes, triggers and completes — and posts an
  **empty message**. Observed: `[('map check ran', …), ('', …)]`. Nothing
  errors. The engine reads `step.text ?? step.message ?? ''`.
- **A definition without `trigger.on` is refused at publish time**, exit 0 on
  the pipe but stderr
  `{"error":"other","message":"trigger.on must be one of: message_posted, reaction_added, schedule, webhook"}`.
  Note the error class is `other`, not `user`, so a shell that switches on the
  class must handle both. Valid actions:
  `send_message, send_dm, set_channel_topic, add_reaction, call_webhook, request_approval, delay`.
- **Workflow output is signed by the relay, not by the triggering user.** A test
  that asserts authorship of the resulting message must expect the relay pubkey.
- `workflows update` is literally `workflows create` — same handler, same
  replaceable `d` coordinate. There is no partial update.
- The slug is the `d` tag, so two workflows whose names normalise to the same
  slug overwrite each other silently. Pass `--id` when the name is not unique.
- `workflows runs` with no `--workflow` returns every run on the relay, capped
  at 100.
- Repo announcements are metadata only. `/git/*` on the relay answers **501** by
  design — Hive does not host git. Cloning uses the `clone` URL in the
  announcement, nothing served here.
- `repos get --id` matches the `d` tag; the `id` field in the returned JSON is
  the *event* id and is a different thing entirely.
