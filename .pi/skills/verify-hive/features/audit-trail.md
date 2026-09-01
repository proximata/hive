# Audit trail

Every accepted mutation appends a row to a hash-chained audit log: a sequence
number, an action, an actor, and the previous row's hash. `audit list` reads the
rows; `audit verify` walks the whole chain and says whether it is intact. This
is the answer to "prove the relay did what it says it did".

## Sub-features

- `audit-list` read the most recent rows, with `prevHash`/`hash`.
- `audit-verify` full-chain verification — **operator-only**.
- `audit-deny` a non-operator key is told so, rather than shown a null.
- `audit-actions` the action vocabulary: `ChannelCreated`, `EventCreated`, `EventDeleted`, `AuthSuccess`, …

## How to get to it (user POV)

- `hive audit list [--limit n]`
- `hive audit verify` — only meaningful with the relay's own key
- REST: signed `GET /api/audit?limit=n`

## Driving it with verify-hive

Preconditions:

- Baseline from [`README.md`](./README.md).
- Some mutations have already happened — create a channel and send a message
  first, or the log is empty and proves nothing.

- **List.** `hive audit list --limit 8` → exit 0, rows in sequence:

  ```
  [(1,'ChannelCreated'), (2,'EventCreated'), (3,'EventCreated'), (4,'EventCreated'),
   (5,'EventCreated'), (6,'EventCreated'), (7,'EventDeleted'), (8,'EventCreated')]
  ```

  Each row carries `seq`, `action`, `actor`, `prevHash`, `hash`. The genesis
  row's `prevHash` is all zeroes.
- **Verify as a client key.** `hive audit verify` → exit **1**,
  `{"error":"user","message":"audit verify is operator-only; run it with the relay key"}`.
  That refusal is the correct behaviour, not a failure of the run.
- **Verify as the operator.** The relay's own secret key is in its storage
  directory, which this run created:

  ```sh
  export HIVE_PRIVATE_KEY=$(tr -d '\n' < "$HIVE_VERIFY_RUN/relay-a/storage/relay.key")
  node scripts/bare.js bin.mjs audit verify
  ```

  → exit 0:

  ```json
  { "ok": true, "entries": 53, "brokenAt": null, "reason": null }
  ```

- **Tie a mutation to a row.** After `hive channels create --name X`, the newest
  `ChannelCreated` row's payload names that channel's UUID, and the `hash` of
  the row before it is the next row's `prevHash`. That chaining, not the row's
  existence, is what makes it evidence.
- **Proof.** `audit-list.json` and `audit-verify.json` in
  `$HIVE_VERIFY_RUN/evidence/`, captured **before** cleanup deletes the storage
  directory.

## Gotchas

- **`audit verify` is operator-only and says so.** `GET /api/audit` returns
  `verification: null` to every other key; the CLI turns that null into an
  explicit error rather than printing `null`, which would read exactly like an
  intact chain. Never treat a null verification as a pass.
- Reading `relay.key` out of the storage directory only works because **this
  run started that relay**. Do not do it to a relay you did not start, and never
  to the public one.
- `--limit` is capped at 100 (`MAX_AUDIT_ENTRIES = LIMITS.FEED_MAX_LIMIT`).
  A larger value is rejected by the CLI validator with exit 1.
- `audit list` returns only the `entries` array — the chain-verification field
  is stripped. Use `audit verify` for the chain.
- `GET /api/audit` is rate limited; hammering it returns 429.
- The log lives in the relay's storage directory. `verify-hive.sh cleanup`
  deletes it. Copy anything you want to keep into `$HIVE_VERIFY_RUN/evidence/`
  first — cleanup does not touch that directory.
- Row count grows with *everything*, including `AuthSuccess` from your own
  probes. Assert on the presence and ordering of specific actions, never on a
  total.
