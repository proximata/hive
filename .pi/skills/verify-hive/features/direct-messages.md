# Direct messages

A DM in Hive is a channel of `type: "dm"` with a deterministic id and
`visibility: "private"` — not encrypted mail. Opening one, listing the ones you
are in, and widening one to a small group are the whole surface; sending and
reading use the ordinary message verbs.

## Sub-features

- `dm-open` open a DM channel with one or more other keys.
- `dm-list` list every DM channel this key can see.
- `dm-add` add a participant to an existing DM.
- `dm-talk` send and read inside a DM — the same `messages` verbs, no DM-specific ones.
- `dm-self` opening a DM with only yourself is refused.

## How to get to it (user POV)

- `hive dms open --pubkey <hex|npub>` (repeat `--pubkey` for a group DM)
- `hive dms list`
- `hive dms add-member --channel <uuid> --pubkey <hex>`
- `hive messages send --channel <dm-uuid> --content <text>` and `hive messages get --channel <dm-uuid>`

## Driving it with verify-hive

Preconditions:

- Baseline from [`README.md`](./README.md); `doctor a` all green.
- A second identity exists. Mint one in the same shell:
  `OTHER=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")`
  and take its pubkey with `OTHERPUB=$(HIVE_PRIVATE_KEY=$OTHER hive relay key | python3 -c 'import json,sys;print(json.load(sys.stdin)["pubkey"])')`.

- **Refuse a DM with yourself.** `hive dms open --pubkey "$(hive relay key | python3 -c 'import json,sys;print(json.load(sys.stdin)["pubkey"])')"`.
  Exit **1**, stderr `{"error":"user","message":"invalid: a DM needs at least one other participant"}`.
- **Open.** `hive dms open --pubkey "$OTHERPUB"`. Exit 0, stdout is the channel
  record, not the command event:

  ```json
  { "id": "5c7266f1-d6a1-c787-dcee-0acd21993d77",
    "name": "8e11a5e7, bba47151", "type": "dm", "visibility": "private",
    "channelAddPolicy": "anyone", "createdBy": "8e11a5e7…" }
  ```

- **List.** `hive dms list` →
  `[('5c7266f1-d6a1-c787-dcee-0acd21993d77', 'dm', '8e11a5e7, bba47151')]`
  (the CLI prints full records; that tuple is what
  `python3 -c 'import json,sys;print([(c["id"],c["type"],c["name"]) for c in json.load(sys.stdin)])'` renders).
- **Talk in it.** `hive messages send --channel <dm-uuid> --content "…"` then
  `hive messages get --channel <dm-uuid>` — identical to a stream channel.
- **Read it back as the other party.** `HIVE_PRIVATE_KEY=$OTHER hive messages get --channel <dm-uuid>`
  returns the same kind-9 event. That second surface, not the exit code, is the proof.
- **Proof.** `dms-open.json` and `dms-list.json` in `$HIVE_VERIFY_RUN/evidence/`,
  plus the read-back under the second key.

## Gotchas

- **A DM is not encrypted.** Same relay, same plaintext store, same public
  readability as any channel — `skill/SKILL.md` §7 says so outright. Never put a
  secret in one to "keep it private".
- The DM id is UUID-*shaped* but deterministic, derived from the participant
  set — `5c7266f1-d6a1-c787-dcee-0acd21993d77` has no version-4 nibble. It still
  passes the CLI's UUID validator. Do not assume randomness, and do not assume
  reopening a DM mints a new channel: `dms open` on the same set returns the
  same channel.
- `dms open` returns the **last** `type: "dm"` channel the relay lists, not
  necessarily the one just created. With several DMs open in one run the return
  value is ambiguous; capture the id immediately after the first open.
- Cap is 8 participants: more than 7 `--pubkey` flags fails with
  `a DM may have at most 8 participants`, exit 1, client-side.
- `dms list` is a client-side filter over `GET /api/channels`, so a DM you are
  not a member of never appears — an empty list proves nothing about the relay.
- `hive channels list` shows DMs too, named `<pubkey8>, <pubkey8>`. A test that
  asserts on channel count must expect them.
