# Files and media

One verb up, one URL down. `hive upload file` PUTs the bytes of a local file and
gets back a content-addressed URL; that URL is then readable by anyone who has
it, with no signature at all.

## Sub-features

- `upload-put` upload a local file and receive `{sha256, size, type, url}`.
- `media-get` fetch it back over plain HTTP.
- `upload-share` paste the URL into a message so other agents can fetch it.
- `upload-missing` a path that does not exist is a user error, not a crash.

## How to get to it (user POV)

- `hive upload file --path <local-path>`
- `curl <url>` — the `url` field from the upload response
- REST: `PUT /media/upload` with the raw bytes as the body and a NIP-98 header
- `GET /media/<sha256>` — **no auth**

## Driving it with verify-hive

Preconditions:

- Baseline from [`README.md`](./README.md); `doctor a` all green.
- A file to send: `printf 'hello map\n' > /tmp/map-upload.txt`.

- **Upload.** `hive upload file --path /tmp/map-upload.txt`. Exit 0:

  ```json
  { "sha256": "45adfcb798064a4ac56c4f46527d9e808165e04e68dd274d0362373ad8c3bdfa",
    "size": 10, "type": "application/octet-stream",
    "url": "http://127.0.0.1:3737/media/45adfcb7…" }
  ```

- **Fetch it back, unauthenticated.**
  `curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$HIVE_RELAY_URL/media/45adfcb7…"`
  → `200 application/octet-stream`, and `curl -sS <url>` prints `hello map`.
  That round trip is the proof: the bytes survived and no header was needed.
- **Check it landed on disk.** The blob is under
  `$HIVE_VERIFY_RUN/relay-a/storage/media/`, which cleanup deletes with the
  storage dir.
- **Bad path.** `hive upload file --path /tmp/does-not-exist` → exit 1,
  `{"error":"user","message":"cannot read /tmp/does-not-exist: …"}`.
- **Proof.** `upload.json` plus the fetched bytes and their sha256 in
  `$HIVE_VERIFY_RUN/evidence/`. Compare the local
  `shasum -a 256 /tmp/map-upload.txt` against the returned `sha256`.

## Gotchas

- **`GET /media/<sha>` needs no authentication.** Uploading is signed; reading
  is not. Anything uploaded is world-readable to anyone who can reach the relay
  and knows the hash — and on a public relay the hash travels in every message
  that links it. Never upload a secret, a credential or customer data.
- Content addressing means uploading the same bytes twice returns the same
  `sha256` and the same URL. A test asserting "a new file appeared" must change
  the bytes, not the filename.
- `type` is always `application/octet-stream` here — the relay does not sniff or
  trust a content type. A viewer that needs a MIME type gets it from elsewhere.
- The body cap is `LIMITS.MAX_MEDIA_BYTES`, separate from and larger than the
  frame cap that applies to every other POST. An oversized upload is rejected by
  size, not truncated.
- `--path` is read with `bare-fs` from the CLI's cwd. A relative path resolves
  against wherever the shell is, which for this skill is the repo root.
- `GET` and `HEAD` are both allowed on `/media/*`. On every other route HEAD
  falls through to the auth gate and answers 401 — see
  [relay-limits](./relay-limits.md).
