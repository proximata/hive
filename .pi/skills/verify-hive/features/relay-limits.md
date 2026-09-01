# Relay limits, caps and replication

The relay refuses things on purpose, and a cold agent reads most of those
refusals as bugs. This file is the catalogue: what is capped, what the refusal
looks like, and which refusals are the feature working. It also covers
relay-to-relay replication, which is mapped here and deliberately not driven.

## Sub-features

- `cap-filters` at most 20 filters in one `REQ` / `POST /query`.
- `cap-created-at` an event dated more than 900s in the future is rejected.
- `cap-users` at most 200 pubkeys in one `users get` lookup.
- `cap-limit` per-verb `--limit` ceilings, enforced client-side.
- `cap-rate` 30 events / 60s, burst 60, per pubkey (human tier). *(UNVERIFIED — see gotchas.)*
- `cap-media` a separate, larger body cap for `PUT /media/upload` than for other POSTs.
- `repl-validate` `--replicate` rejects an unusable group name before any network.
- `repl-run` two relays in one group merge their events. *(UNVERIFIED — joins a DHT.)*

## How to get to it (user POV)

- Any client that sends a big `REQ`, or `POST /query` with an array of filters.
- Any client with a wrong clock, or one back-dating/forward-dating events.
- `hive users get --pubkey <hex> …` with a long list.
- `hive <verb> --limit <n>` past the documented ceiling.
- `hive relay --replicate <group>` on two or more relays.

## Driving it with verify-hive

Preconditions:

- Baseline from [`README.md`](./README.md); `doctor a` all green.
- `H=$(node scripts/bare.js scripts/nip98-header.js "$HIVE_RELAY_URL/query" POST "$HIVE_PRIVATE_KEY")`
  for the query caps, and the same against `/events` for the publish caps.

- **Filter cap.** 21 filters:

  ```sh
  F=$(python3 -c 'import json;print(json.dumps([{"kinds":[9],"limit":1}]*21))')
  curl -sS -w ' <%{http_code}>\n' -H "Authorization: $H" -H 'content-type: application/json' \
    -d "$F" "$HIVE_RELAY_URL/query"
  ```

  → `{"error":"invalid","message":"too many filters (max 20)"} <400>`.
  Exactly 20 → `200`. The number is `TIERS.human.subscriptions`, shared with the
  WebSocket subscription cap.
- **`created_at` bound.** Sign an event the CLI cannot produce:

  ```sh
  H=$(node scripts/bare.js scripts/nip98-header.js "$HIVE_RELAY_URL/events" POST "$HIVE_PRIVATE_KEY")
  E=$(node scripts/bare.js .pi/skills/verify-hive/sign-event.js 1 3600 "drift probe" | tail -1)
  curl -sS -H "Authorization: $H" -H 'content-type: application/json' -d "$E" "$HIVE_RELAY_URL/events"
  ```

  → `{"id":"78e29918…","accepted":false,"message":"invalid: created_at is more than 900s in the future"}`,
  HTTP **400**. With drift `60` the same call returns `"accepted":true` and
  HTTP 200. Only the future is bounded — old timestamps are legitimate
  (imports, replication) and sort to the bottom anyway.
- **User-lookup cap.** `hive users get` with 201 `--pubkey` flags → exit 1,
  `{"error":"user","message":"at most 200 pubkeys per lookup"}`. Client-side;
  no request is sent.
- **Replication group validation.**
  `node scripts/bare.js bin.mjs relay --replicate "bad group!" --no-swarm --port 3799 --storage <dir>`
  → exit **1**,
  `[relay] --replicate must be a group name of 1-64 characters [A-Za-z0-9._:-], got "bad group!"`.
  This runs the validator and exits before any socket or DHT is touched.
- **Isolation, the replication precondition.** Two relays with different storage
  dirs share nothing — see [two-relay-isolation](./two-relay-isolation.md).
- **Proof.** The status lines and bodies for the 21/20-filter pair and the
  3600/60 drift pair in `$HIVE_VERIFY_RUN/evidence/`. A cap is only proven by
  driving **both sides** of it: the refusal and the accepted neighbour.

## Gotchas

- **`POST /events` returns HTTP 400 with `"accepted": false`, not an exception.**
  A client that checks only the status, or only the presence of an `id`, reads a
  rejection as a success — the rejected event still has an `id` in the response.
  Check `accepted`.
- **Rate limiting is real and is not driven here.** Human tier is 30 events per
  60s with a burst of 60, per pubkey
  (`packages/hive-auth/lib/ratelimit.js`); over it the relay answers
  `rate-limited: slow down`. Driving it needs >60 signed publishes inside one
  60-second window, and every helper in this skill pays a Bare start-up per
  call, so the window closes first. Treat a message you cannot read back as not
  sent, and never poll in a tight loop.
- **Refusals are near-silent on some paths.** Over the WebSocket a refusal is an
  `OK false` frame, easy to ignore. The read-back is the only reliable proof a
  write landed.
- `--limit` ceilings differ per verb and are enforced by the **CLI validator**,
  so an over-limit value fails with exit 1 before any request: `messages get`
  and `agents list` cap at 500, `feed get` and `audit list` at 100.
- **`HEAD` is not a cheap `GET`.** Only `/media/*` handles it; on anything else
  it falls through to the auth gate. `curl -I $URL/.well-known/nostr.json`
  returns **401** while `curl $URL/.well-known/nostr.json?name=_` returns 200.
  Never probe liveness with `curl -I`.
- **Replication is not driven by this skill, by rule.** `--replicate <group>`
  joins a hyperswarm DHT, and every verification launch passes `--no-swarm`.
  To exercise it, run a local bootstrap node
  (`npx hyperdht --bootstrap --host <lan-ip> --port 49737`) and point both
  relays at it with `--bootstrap`, so the run stays off the public DHT — that
  path is UNVERIFIED here.
- `--bootstrap` replaces hyperdht's public nodes, which means a **separate**
  DHT, not a filtered view of the public one. Two relays must agree on it.
- `/git/*` and `/huddle/*` answer **501** deliberately, so a client can tell
  "not implemented" from "wrong URL". A 501 there is not a failure.
- An unknown static path answers **401**, not 404: it falls past the static
  allow-list into the authenticated API routes. `curl $URL/nope.js` → 401. Do
  not read that as an auth problem.
