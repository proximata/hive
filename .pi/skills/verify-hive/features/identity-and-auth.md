# Identity and auth

Every Hive caller is a raw secp256k1 keypair. Nothing registers: the first
signed request from a key is that key's first appearance, and the relay accepts
any valid signature. The CLI takes the key from the environment only, REST
requests carry a NIP-98 signed event in `Authorization`, and WebSocket
connections complete a NIP-42 challenge.

## Sub-features

- `id-mint` mint a throwaway key and see the pubkey/npub it implies.
- `id-env` the CLI reads `HIVE_PRIVATE_KEY` and `HIVE_RELAY_URL` from env only.
- `id-missing` a missing or malformed key is an auth failure, exit 3.
- `id-nip98` an unsigned `GET /api/*` is 401; a NIP-98 header makes it 200.
- `id-nip42` a WebSocket connection is challenged and authenticates.

## How to get to it (user POV)

- Run `hive relay key` to see who you are on this relay.
- Export `HIVE_PRIVATE_KEY` before any other verb. There is no `--key` flag.
- Point at a relay with `HIVE_RELAY_URL`. There is no `--relay` flag on CLI verbs.
- Call the REST API directly with `curl` and an `Authorization: Nostr <base64>` header.
- Connect a WebSocket client and answer the relay's `AUTH` frame.

## Driving it with verify-hive

Preconditions:

- Baseline from [`README.md`](./README.md); `doctor a` all green.

- **Mint a key.** `export HIVE_PRIVATE_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")`.
  Write it nowhere inside the checkout. `verify-hive.sh launch` already put one
  in `$HIVE_VERIFY_RUN/key.env`, mode 0600, outside the repo.
- **See the identity.** `hive relay key`. Exit 0, stdout:

  ```json
  { "pubkey": "f4daf712…", "npub": "npub17nd0wynmasjl5jctmp0a2mdcg6th0hzvu789r4dxsmgwhq97pm8sm5aqj2" }
  ```

- **No key.** `(unset HIVE_PRIVATE_KEY; hive channels list)`. Exit **3**, stderr
  `{"error":"auth","message":"set HIVE_PRIVATE_KEY (or BUZZ_PRIVATE_KEY) to an nsec or 64-character hex key"}`.
- **Unsigned REST read.** `curl -sS -o /dev/null -w '%{http_code}\n' "$HIVE_RELAY_URL/api/channels"` → `401`.
- **Signed REST read.**
  `H=$(node scripts/bare.js scripts/nip98-header.js "$HIVE_RELAY_URL/api/channels" GET "$HIVE_PRIVATE_KEY")`
  then `curl -sS -H "Authorization: $H" "$HIVE_RELAY_URL/api/channels"` → `200`
  and the channel array.
- **WebSocket auth.**
  `node scripts/bare.js .pi/skills/verify-hive/ws-probe.js 3737 "$HIVE_PRIVATE_KEY" '{"kinds":[9]}'`
  prints `"authenticated": true` alongside the events the filter matched.
- **Proof.** Store `relay-key.json`, the 401 status line, the 200 body and the
  ws-probe JSON in `$HIVE_VERIFY_RUN/evidence/`.

## Gotchas

- Exit **3** means auth, not "relay down" — that is exit 2. A cold agent reads
  `{"error":"auth"}` and assumes the relay rejected it; usually the env var was
  simply lost across a subshell. Environment does not survive `cd` in a new
  `bash -c`; source `key.env` in the same shell as the verb.
- `HIVE_RELAY_URL=hyper://<pubkey>` is refused by the CLI with a user error. The
  HTTP CLI does not speak the swarm transport.
- NIP-98 signatures are bound to the **full request URL**. A relay behind a
  proxy needs `--public-url`, or every authenticated call 401s. Locally, do not
  mix `localhost` and `127.0.0.1` between the signature and the request.
- `scripts/nip98-header.js` signs with `body: null`. It is fine for GETs and
  worked for `POST /query` here, but for a body whose hash must match, sign
  through `hive-cli`'s `RelayClient` instead.
- An `npub` is never accepted where a secret key is wanted: the validator pins
  the bech32 prefix so an npub cannot be silently used as a secret.
