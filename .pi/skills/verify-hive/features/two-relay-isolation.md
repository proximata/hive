# Two isolated relays

Two Hive relays can run side by side on one machine, each with its own port,
storage directory and identity keypair. Nothing crosses between them unless
`--replicate` is given the same group name. Proving the isolation is the
precondition for anything about replication: a replication test that passes
because both relays were secretly the same store proves nothing.

## Sub-features

- `iso-ports` a second relay comes up on a second port.
- `iso-storage` each relay owns a separate storage directory.
- `iso-identity` each relay derives a different NIP-11 pubkey from its storage.
- `iso-data` the same client key sees different content on each relay.
- `iso-collision` a relay whose port is taken never becomes reachable.
- `repl-group` `--replicate <group>` merges two relays' events. *(UNVERIFIED — not driven in this authoring pass; it joins a DHT.)*

## How to get to it (user POV)

- `hive relay --port 3737 --storage <dirA>` and `hive relay --port 3738 --storage <dirB>`
- Switch between them by changing `HIVE_RELAY_URL`.
- `hive relay --replicate <group>` on both, to turn replication on.

## Driving it with verify-hive

Preconditions:

- Baseline from [`README.md`](./README.md), relay `a` already up on 3737 with a
  channel created on it.

- **Second relay.** `.pi/skills/verify-hive/verify-hive.sh launch b 3738`. Output
  names a different pid, port, storage dir and pubkey.
- **Both healthy.** `doctor a` and `doctor b` both green, each matching its own
  recorded identity.
- **Distinct identities.**
  `diff "$HIVE_VERIFY_RUN/relay-a/relay.pubkey" "$HIVE_VERIFY_RUN/relay-b/relay.pubkey"`
  must report a difference. Observed:
  `a0904f3af698a369…` vs `132157ca8ba20713…`.
- **Distinct data, same key.** With `HIVE_PRIVATE_KEY` unchanged:

  ```sh
  HIVE_RELAY_URL=http://127.0.0.1:3738 hive channels list   # []
  HIVE_RELAY_URL=http://127.0.0.1:3737 hive channels list   # ['verify-messages']
  ```

  The empty array from B while A holds the channel is the isolation proof.
- **Collision refusal.** `.pi/skills/verify-hive/verify-hive.sh launch a 3737`
  from a *fresh* `$HIVE_VERIFY_RUN` exits **2**:

  ```
  REFUSE: port 3737 is already listening (pid 49650). Pick another port or clean that up yourself.
  ```

- **Proof.** Both `relay.pubkey` files, both `channels list` outputs, and both
  `relay.log` files copied into `$HIVE_VERIFY_RUN/evidence/`.

## Gotchas

- **A relay whose port is already taken prints NOTHING and hangs.** No
  `EADDRINUSE`, no exit. The launch-time port check is the only warning you get;
  without it you sit waiting on a relay that will never answer, while reading
  a *different* relay's data.
- Two relays must differ in port **and** storage dir. Same dir, different port
  is not isolation — it is two processes over one SQLite file.
- The relay identity keypair lives in the storage dir, so reusing a dir
  resurrects the old pubkey and `doctor`'s stale check goes quiet.
- Killing a relay's launcher pid does not free its port: the listening socket
  belongs to a grandchild Bare worker that gets reparented to init. Use
  `verify-hive.sh cleanup`, which kills the recorded listener pid too.
- `--replicate` joins a DHT (`hyperswarm`), so it reaches the network. Every
  verification launch here passes `--no-swarm`. Do not enable replication
  casually; if you must, use `--bootstrap` against a local DHT node.
- The default relay port is **3000**. Verification uses 3737+ so a developer's
  own relay on 3000 is never touched.
