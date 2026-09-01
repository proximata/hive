# Relay surfaces

Behind the CLI, the relay serves four things on one port: unauthenticated probes
(`/health`, NIP-11 `/info`), NIP-98-signed REST reads under `/api/*` plus
`POST /events` and `POST /query`, the Nostr WebSocket protocol on the same
origin, and the no-build web client as static files.

## Sub-features

- `relay-health` `GET /health` — liveness plus a real store query.
- `relay-nip11` `GET /info` (or `Accept: application/nostr+json` on `/`) — identity and supported NIPs.
- `relay-api` signed `GET /api/*` convenience reads.
- `relay-query` signed `POST /query` — arbitrary NIP-01 filters, and the only way to read channel messages over HTTP.
- `relay-ws` the WebSocket: `AUTH` challenge, `REQ`, `EVENT`s, `EOSE`.
- `relay-web` the browser client served from `packages/hive-web/public`.
- `relay-audit` the hash-chained audit log.

## How to get to it (user POV)

- `curl http://127.0.0.1:3737/health`
- `curl http://127.0.0.1:3737/info`
- `hive relay info`, `hive audit list --limit 5`, `hive audit verify`
- `curl -H "Authorization: Nostr <base64>" http://127.0.0.1:3737/api/channels`
- Open `http://127.0.0.1:3737/` in a browser.
- Any Nostr client pointed at `ws://127.0.0.1:3737`.

## Driving it with verify-hive

Preconditions:

- Baseline from [`README.md`](./README.md). `HIVE_RELAY_URL` is set.

- **Health.** `curl -sS "$HIVE_RELAY_URL/health"` → `{"status":"ready","store":"ok","connections":0}`.
  This is what `verify-hive.sh launch` polls; it touches the store, so a 200 means
  more than "the process is alive".
- **NIP-11.** `curl -sS "$HIVE_RELAY_URL/info"` → `{"name":…,"pubkey":"a0904f3a…",
  "supported_nips":[1,9,10,11,16,17,23,25,29,33,34,42,43,45,50,56,98],…}`.
  The `pubkey` is the relay's own identity, derived from its storage dir — the
  handle `doctor` uses to spot a stale relay.
- **Unsigned `/api/*`.** `curl -sS -o /dev/null -w '%{http_code}\n' "$HIVE_RELAY_URL/api/channels"` → `401`.
- **Signed `/api/*`.** mint a header with `scripts/nip98-header.js`, then curl → `200`
  and the channel array.
- **`POST /query`.**
  ```sh
  H=$(node scripts/bare.js scripts/nip98-header.js "$HIVE_RELAY_URL/query" POST "$HIVE_PRIVATE_KEY")
  curl -sS -X POST -H "Authorization: $H" -H 'Content-Type: application/json' \
    -d '[{"kinds":[9],"#h":["'"$CH"'"]}]' "$HIVE_RELAY_URL/query"
  ```
  → the kind-9 events for that channel. Equivalent repo helper:
  `node scripts/bare.js scripts/query-remote.js "$HIVE_RELAY_URL" "$HIVE_PRIVATE_KEY" '[{…}]'`.
- **WebSocket.** `node scripts/bare.js .pi/skills/verify-hive/ws-probe.js 3737 "$HIVE_PRIVATE_KEY" '{"kinds":[9]}'`
  → `{"pubkey":…,"authenticated":true,"closed":null,"events":[{"kind":9,"content":"seed"}]}`.
- **Web client.** `curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$HIVE_RELAY_URL/"`
  → `200 text/html; charset=utf-8`, and `/app.js` → `200 text/javascript; charset=utf-8`.
- **Audit.** `hive audit list --limit 5` → an array of rows carrying `seq`, `action`
  (`ChannelCreated`, `EventCreated`), `actor`, `prevHash` and `hash`. Genesis row
  has `prevHash` all zeroes.
- **Proof.** `health.json`, `info.json`, the 401/200 status lines, `query.json`,
  `ws-probe.json` and `audit.json` in `$HIVE_VERIFY_RUN/evidence/`.

## Gotchas

- **Zero CORS.** No `Access-Control-Allow-Origin` on the API, so a page served
  from any other origin cannot call it. Test the web client from the relay's own
  origin only. (`/.well-known/nostr.json` is the single exception.)
- **No SSE, no long-poll.** Live receiving is WebSocket or polling. Do not go
  looking for an events stream endpoint.
- Channel messages have no GET route. It is `POST /query` with an `#h` filter.
- `GET /` returns `426 upgrade_required` when no web directory is present. From
  a source checkout the relay finds `packages/hive-web/public` and serves it;
  from a standalone binary it needs `--web-dir`.
- `/git/*` and `/huddle/*` answer **501**, deliberately, so a client can tell
  "not implemented" from "wrong URL". A 501 there is not a failure.
- `audit list` returns the entries array only. The chain `verification` field is
  non-null solely for the relay's own key, so from a client key it is always
  `null` — use `hive audit verify` for the chain check, not `list`.
- `GET /api/audit` is rate limited. Hammering it returns 429.
- `/health` and `/_readiness` are the same handler; `/_liveness` is weaker and
  does not touch the store. Poll `/health`.
