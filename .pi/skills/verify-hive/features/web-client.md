# The no-build web client

The relay serves a browser client from `packages/hive-web/public` — plain HTML,
CSS and ES modules, no bundler, no build step. It signs in the browser using
`@noble` mounted at `/vendor/`, so the page is a real Nostr client and not a
thin view over a server session.

## Sub-features

- `web-serve` `GET /` returns the client from the source tree.
- `web-assets` `app.js` and `tokens.css` are served with correct content types.
- `web-vendor` `@noble` is mounted at `/vendor/` for the page's import map.
- `web-allowlist` anything outside the allow-list is not served.
- `web-webdir` `--web-dir` points a standalone binary at a shipped copy. *(UNVERIFIED.)*
- `web-interact` clicking through the client in a browser. *(UNVERIFIED — see gotchas.)*

## How to get to it (user POV)

- Open `http://127.0.0.1:3737/` in a browser while the relay is running.
- `curl http://127.0.0.1:3737/` for the bytes.
- Deploy: `hive relay --web-dir <dir>` when the source tree is not present.

## Driving it with verify-hive

Preconditions:

- Baseline from [`README.md`](./README.md); `doctor a` all green.
- The relay was started **from the source checkout**, so it finds
  `packages/hive-web/public` on its own. `verify-hive.sh launch` does exactly that.

- **The page.** `curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$HIVE_RELAY_URL/"`
  → `200 text/html; charset=utf-8`. `/index.html` → `200` as well.
- **The module and the stylesheet.**
  `/app.js` → `200 text/javascript; charset=utf-8`;
  `/tokens.css` → `200 text/css; charset=utf-8`.
  Those are the only two assets `index.html` references
  (`<link rel="stylesheet" href="/tokens.css">`, `<script type="module" src="/app.js">`).
- **The vendored signer.** `/vendor/curves/secp256k1.js` → `200`. The page's
  import map maps `@noble/curves/` → `/vendor/curves/`, so this 200 is what
  makes in-browser signing possible at all.
- **The allow-list.** `/style.css`, `/main.css`, `/nope.js` → **401**, not 404 —
  they fall past the static server into the authenticated API routes.
- **No CORS.** `curl -sSI "$HIVE_RELAY_URL/"` has no `Access-Control-Allow-Origin`
  header. Only `GET /.well-known/nostr.json` carries `Access-Control-Allow-Origin: *`.
- **Proof.** A `web-assets.txt` in `$HIVE_VERIFY_RUN/evidence/` with the status
  and content type of each of `/`, `/app.js`, `/tokens.css`,
  `/vendor/curves/secp256k1.js`, and one 401 line for a path outside the
  allow-list.

## Gotchas

- **This feature is proven as served bytes only.** No browser drive happened.
  Asserting on rendered UI needs a real browser session (CDP) against the
  relay's own origin, and this skill ships no browser harness. Do not report
  "the web client works" from a 200.
- **Zero CORS means the page must be loaded from the relay's own origin.** A
  local file, a dev server on another port, or a hosted page cannot call the
  API. There is no proxy and no allow-list to add an origin to.
- **A missing static file answers 401.** Anything outside the allow-list falls
  through to the API routes, which demand a NIP-98 header. A 401 for
  `/whatever.css` means "not served", not "you are unauthenticated".
- `GET /` returns **426 upgrade_required** when the relay has no web directory —
  a standalone binary carries no source tree and needs `--web-dir`, with a
  `vendor/` copy of `@noble` beside it. *(UNVERIFIED here: the source checkout
  always finds the directory.)*
- The client is a real signing client, so it needs a key in the browser. Nothing
  in this skill provisions one; the throwaway key in `$HIVE_VERIFY_RUN/key.env`
  is for the CLI.
- There is no SSE and no long-poll. The page's live updates are the WebSocket on
  the same origin, so a network-blocked WebSocket looks exactly like an idle
  relay.
