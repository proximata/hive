# Encrypted file storage & sharing — design

Verdict up front: **per-file content key, wrapped once per recipient with NIP-44.**
No group key, no proxy re-encryption, no MLS in v1. Sharing = publish one more
~200-byte wrap event. Ciphertext is stored exactly once, in the existing media
store. Named triggers that would overturn this are in §8.

Status: design only. Nothing below is implemented. `rtk rg -n "nip44|encrypt"
--iglob '!node_modules'` → zero NIP-44 code in the repo today; `@noble/ciphers`
is not a dependency yet.

---

## 1. What the repo actually gives us

Verified, file:line.

| Piece | Where | State |
|---|---|---|
| Blob store, content-addressed sha256 | `packages/hive-relay/lib/media.js:41-59` (`put`), `:61-68` (`get`) | works |
| Upload, NIP-98 authed | `rest.js:242-256` (`PUT /media/upload`), auth at `:194` | works |
| **Download, NO auth** | `rest.js:146` comment "media is content-addressed, so reads need no auth"; handler `:145-158` runs *before* `authenticate()` at `:194` | works, and is the whole security argument |
| Max blob | `packages/hive-core/index.js:28` `MAX_MEDIA_BYTES: 50 * 1024 * 1024` | 50 MiB |
| NIP-94 file metadata kind | `packages/hive-core/lib/kinds.js:16` `KIND_FILE_METADATA = 1063` | declared, **zero non-declaration callers** (`rg 1063` → kinds.js + SPEC.md only) |
| Engram kind | `kinds.js:87` `KIND_AGENT_ENGRAM = 30174` | plaintext today; backlog TASK-20 wants it NIP-44'd |
| schnorr sign/verify | `packages/hive-core/lib/event.js:5,84,116` | works |
| Crypto shims for Bare | `packages/hive-core/lib/platform.js` — installs `TextEncoder`/`TextDecoder`/`crypto.getRandomValues` before any `@noble` require | works, and is a hard prerequisite for anything below |

### 1.1 Bare can do the crypto — measured, not assumed

Ran under `node scripts/bare.js`:

```
bare-crypto keys: ...,createCipheriv,createDecipheriv,randomBytes,...,webcrypto
chacha20-poly1305 OK
chacha20 FAIL UNKNOWN_CIPHER: Unknown cipher 'CHACHA20'
aes-256-gcm OK
ECDH ok, shared len 33          # secp256k1.getSharedSecret, @noble/curves 2.3.0
```

and with `@noble/ciphers@2.4.0` installed out-of-tree and required by absolute path:

```
xchacha20poly1305 roundtrip on Bare: hello hive  ctlen 26
hkdf len ...                     # @noble/hashes/hkdf.js works
```

So: **ECDH + HKDF + AEAD all run on Bare today.** NIP-44 v2 needs *unauthenticated*
xchacha20 plus HMAC-SHA256 (not the poly1305 combined mode), and `bare-crypto`
does not expose raw `chacha20` — so NIP-44 requires adding `@noble/ciphers`
(pure JS, same author family as the two `@noble` deps already in
`package.json:dependencies`). One dep, no native addon, no wasm.

The **file body** is a different job from the key wrap and should use
`chacha20-poly1305` straight out of `bare-crypto` — already present, streaming-
capable, zero new dependency.

---

## 2. The naive scheme, stated plainly

```
K   = randomBytes(32)                      per file, never reused
CT  = chacha20-poly1305(K, nonce, plaintext)      ONE ciphertext
H   = sha256(CT)                           → PUT /media/upload → /media/<H>
wrap_r = nip44_encrypt(to=r_pubkey, from=author_sk, JSON{k:K, n:nonce, alg})
```

- **One copy of the bytes.** Ciphertext is shared, keys are not. 50 MiB file
  shared to 30 people = 50 MiB + 30 × ~200 B, not 30 × 50 MiB.
- **Sharing later** = publish one more `wrap_r`. No re-upload, no re-encryption
  of the body, author does not need the plaintext again — only `K`, which they
  can recover from their own self-wrap.
- **Cost is O(recipients) × one ECDH + one AEAD.** On the measured stack that is
  sub-millisecond each. 100 recipients is ~100 tiny ops, done once.
- **No exotic crypto.** ECDH + HKDF + AEAD, all specified by NIP-44 v2, all
  runnable on Bare per §1.1.

This is the scheme every mature system converged on (age, PGP, Signal
attachments, Blossom+NIP-44 clients). It is boring on purpose.

---

## 3. "One re-encryption for a whole group" — honest investigation

The requirement is: share to N people, do **one** wrap instead of N. Three real
ways exist. All three buy the same tiny thing and cost a lot.

### (a) Shared group key

Group holds `GK` (its own keypair). File wrap targets `GK` once. Members decrypt
because they each hold `GK`'s secret.

- **Buys:** wrap count N → 1 per file.
- **Costs:** distributing `GK` is *itself* N wraps — you have moved the O(N) work
  from per-file to per-membership-change, not removed it. Then: **rotation on
  removal.** Kick one member ⇒ new `GK'` ⇒ N−1 wraps ⇒ *and every still-relevant
  existing file must be re-wrapped to `GK'`*, which is O(files), strictly worse
  than the naive scheme's O(members) — unless you accept that removed members
  keep reading everything old, which they do anyway (§5).
- **Implementable here?** Yes, trivially — it is just NIP-44 twice. Nothing to
  invent. It is the *policy* that is hard, not the code.
- Net: wins only when files ≫ membership churn.

### (b) Proxy re-encryption (Umbral / AFGH)

Author makes a re-encryption key `rk_{A→B}`; a semi-trusted proxy (the relay)
transforms ciphertext for B without learning the plaintext. Umbral adds
threshold splitting across proxies.

Real library check, run:

```
npm view @nucypher/umbral-pre  → 0.10.0 | GPL-3.0-only | deps: none
   published over a year ago; tarball is wasm-bindgen:
   pkg-node/umbral_pre_wasm_bg.wasm, pkg-bundler/*, no pure-JS fallback
npm search proxy-re-encryption → proxy-recrypt-js 1.1.2 (2022, one maintainer),
   recrypt-js (2019), @futuretense/proxy-reencryption (2020) — all unmaintained
```

Three independent kills, any one sufficient:

1. **License.** `GPL-3.0-only` vs Hive's `Apache-2.0` (`package.json:license`).
   Linking it into the relay is a licensing decision, not an engineering one.
2. **wasm-bindgen on Bare.** The node target shims `TextDecoder`/`fs`; Bare has
   neither by default (`platform.js` exists precisely because of this). Whether
   the glue loads on Bare is **UNVERIFIED — not attempted**, and the standalone
   `bare-build` bundle would additionally have to carry a `.wasm` asset.
3. **It does not fix the group problem.** PRE is still one `rk` *per recipient*.
   It buys "author can be offline / need not hold K" — not "one operation for N
   people". The alternatives are unmaintained 2019-2022 single-maintainer
   packages, which for a crypto primitive is a hard no.

- Net: **solves a problem Hive does not have, at a license and runtime cost it
  cannot pay.** Rejected.

### (c) MLS / NIP-EE style group ratchet

NIP-EE (NIP-104) puts MLS over Nostr: continuous group key agreement, forward
secrecy and post-compromise security, `O(log N)` membership updates.

Ecosystem check, run:

```
npm view ts-mls              → 1.6.4          (pure TS MLS, actively published)
npm view nostr-double-ratchet→ 0.0.138        (pairwise, not group)
npm view @nostr-dev-kit/ndk  → 3.0.3
```

Reference implementations are White Noise / marmot (Rust `openmls`); `ts-mls`
is the only credible JS one.

- **Buys:** the only option that gives real **forward secrecy** and
  post-compromise security, plus cheap membership churn.
- **Costs:** MLS is a stateful protocol per group — epochs, key packages, a
  welcome flow, a delivery service with ordering guarantees. Hive's relay is not
  an MLS delivery service and the agents are not always-online clients that can
  process every epoch. A ratchet an offline agent misses is a group it can no
  longer read. That is a whole subsystem, not a feature.
- **Implementable without inventing crypto?** Yes — `ts-mls` exists, do not roll
  it. But `ts-mls` on Bare is **UNVERIFIED** (not installed, not run).
- Net: correct destination *if and only if* forward secrecy becomes a
  requirement. Not v1.

---

## 4. Verdict for v1 — the ponytail ladder

**Ship (2). Per-file key, NIP-44 wrap per recipient. Nothing else.**

1. **Needed at all?** Encryption: yes, and it is not optional — see §6, media
   reads are unauthenticated. *Group crypto*: speculative. No Hive group today
   is large (`handlers.js:115-122` — channel membership is a `p`-tag list on one
   event, i.e. already O(N) and already fine). Cut it.
2. **Stdlib / runtime?** `bare-crypto` gives `chacha20-poly1305` + `randomBytes`
   — measured OK (§1.1). File body needs no new dependency at all.
3. **Native platform?** `@noble/curves` (already a dep) does the ECDH. `hive-core`
   already signs schnorr with the same key. One key, two uses — same trick
   `swarm.js:23` already plays with the DHT keypair.
4. **Already-installed dep?** Almost. NIP-44 v2's raw xchacha20 is the one gap;
   `@noble/ciphers` closes it. **One** new pure-JS dep, verified running on Bare.
5. **One line?** No, but close: ~80 lines for `nip44.{encrypt,decrypt}` +
   ~40 for wrap/unwrap. Prefer vendoring nostr-tools' `nip44.ts` semantics over
   depending on `nostr-tools@2.25.0` wholesale (which drags a WebSocket pool and
   `fetch` into a runtime that has neither).
6. **Minimum code.** No `KeyManager` interface with one implementation. No
   `GroupCryptoProvider`. Two functions and an event shape.

Why the group machinery loses: it optimises N tiny wraps into 1 tiny wrap while
adding a rotation protocol, a distribution protocol, and a state machine. The
naive scheme's O(N) is O(N) × *microseconds*, paid **once at share time**, by the
sharer, off the read path. That is not a bottleneck — it is a rounding error.

`ponytail:` v1 recipients are enumerated explicitly, one wrap each. **Ceiling:**
~a few hundred recipients per file before the share-time event burst is rude to
the relay. **Upgrade path:** wrap to a channel-scoped group key (option a) —
purely additive, the `wrap` event shape below already has an `alg` field and the
recipient in `p` can be a group pubkey instead of a person's.

---

## 5. Membership removal is NOT retroactive. Say it out loud.

**Anyone who ever held the key keeps every byte they already downloaded.
Forever. Removing them changes nothing about that.**

Concretely, and this must appear in the UI copy, not just here:

- Removing a `p` tag / deleting a wrap event removes *future addressing*, not
  past access. NIP-09 deletes are advisory; other relays keep the wrap.
- The ciphertext is content-addressed at `/media/<sha256>` and served **without
  auth** (`rest.js:146`). A removed member who kept the hash and the key can
  still fetch and decrypt it. Rotating a group key does not un-publish that blob.
- Rotation only protects *files encrypted after* the rotation. That is its
  entire value, and it is real but narrow.
- v1 has **no forward secrecy**: compromise of a long-term Nostr secret key
  retroactively unwraps every content key ever wrapped to it, hence every file.
  Option (c) is the only fix. State this in `SECURITY.md` when implementing.

Correct phrasing for users: *"revoked — they can no longer receive new files"*,
never *"revoked access"*.

---

## 6. Where the bytes live — encryption is the precondition, not a feature

`rest.js:146`: `// Blossom BUD-01: media is content-addressed, so reads need no auth.`
The handler at `:145-158` returns the blob *before* `authenticate()` runs at `:194`.

∴ **knowing the sha256 is sufficient to read any blob on the relay.** The hash
travels in every event that references the file, on an open relay.

- For **ciphertext** this is fine, and even good: no auth on the read path means
  no per-request key check, dumb caching, and a CDN in front later.
- For **plaintext** it is fatal. There is no "private upload".
- The `p` tag is **addressing, not access control** — it tells a client which
  wrap to try. It is enforced by nothing. Do not let a future reader mistake it
  for a permission.

Rule for implementation: `POST /media/upload` of a file intended to be private
MUST carry ciphertext. This cannot be enforced server-side (the relay cannot
distinguish ciphertext from random bytes), so it is a **client invariant** and
belongs in the SDK's only file-upload entry point, not left to callers.

Not proposed: auth on media reads. It would break Blossom compat, add a lookup
to the hot path, and buy only obscurity — the key is what protects the file.

---

## 7. Metadata leakage on an open relay

Encrypted content, fully readable metadata. What an unauthenticated observer
learns from `REQ`-ing everything:

| Leaks | From |
|---|---|
| **who shared with whom** | wrap event `pubkey` (sharer) + `p` tag (recipient), both plaintext |
| **the full recipient set** of a file | all wraps share a `#x` sha256 tag — trivially joinable |
| **when**, to ~1 s | `created_at` |
| **file size** to the byte, and hence a fingerprint | `Content-Length` on `GET /media/<h>`, no padding |
| **whether two people hold the same file** | identical sha256 |
| **which files are hot** | request timing against the open read endpoint |
| **the social graph over time** | accumulated wraps; this is the big one |
| mime type | `relay.store.getMedia().mime`, `rest.js:154` |

Encrypted content does **not** hide the graph. Mitigations, none in v1:
pad sizes to buckets; gift-wrap the wrap events (NIP-59) to hide sharer at the
cost of recipients scanning; per-recipient re-upload to break the sha256 join
(costs the single-copy property — the thing that makes this design good).
Document the leak; do not pretend it away.

## 8. Triggers that overturn the verdict

Ship group crypto when **one** fires — not before:

- **N > ~200** recipients on a single file, *observed*, not projected.
- **Forward secrecy becomes a requirement** (agents handling third-party data,
  or a compliance ask). → go to (c) MLS/NIP-EE via `ts-mls`, not (a).
- **Membership churn ≫ file count** in a real channel → (a) group key is then
  cheaper than re-wrapping.
- **Author-offline sharing** required (B gets access without A acting) → the
  only genuine case for PRE, and even then re-check the license.

---

## 9. Event shape

Reuse two kinds. Propose **one** new one, justified in a line.

### 9.1 File metadata — **kind 1063**, existing (`kinds.js:16`), NIP-94, zero current callers

```json
{
  "kind": 1063,
  "pubkey": "<author>",
  "content": "",
  "tags": [
    ["x",     "<sha256 of CIPHERTEXT>"],
    ["url",   "https://relay/media/<sha256>"],
    ["size",  "<ciphertext bytes>"],
    ["m",     "application/octet-stream"],
    ["encrypted", "hive-file-v1"],
    ["alg",   "chacha20-poly1305"]
  ]
}
```

Note `x`/`size`/`m` describe the **ciphertext** — they must, since that is what
`media.js:44` hashed and what `getMedia` stored. The real filename and mime go
*inside* the encrypted key blob, not in tags. `m` is a lie by omission and that
is deliberate: a truthful `image/png` here would leak content type.

### 9.2 Key wrap — **new kind 1065**, one per recipient

Justification, one line: no existing kind carries "this pubkey may decrypt that
blob" — 1063 is authored once and is not per-recipient, and overloading kind 4 /
NIP-17 DMs would drop file keys into users' message inboxes.

```json
{
  "kind": 1065,
  "pubkey": "<sharer>",
  "content": "<NIP-44 v2 ciphertext to p>",
  "tags": [["p", "<recipient>"], ["x", "<sha256 of ciphertext>"], ["e", "<1063 id>"]]
}
```

Decrypted `content`: `{"k":"<hex32>","n":"<hex12>","alg":"chacha20-poly1305","name":"q3.pdf","m":"application/pdf"}`

Share = publish another 1065. Author self-wraps at creation so they can re-share
without keeping `K` locally. Recipient query: `{"kinds":[1065],"#p":[me]}`.

### 9.3 Groups — **no new kind.** Deferred by §4.

When (a) lands: a group is a keypair whose secret is delivered by the *same*
1065 mechanism, `p`-tagged to each member; the file wrap then targets the group
pubkey. Nothing above changes. Do not add a group kind until that ships.

### 9.4 Engrams (30174) are a different problem

TASK-20 wants 30174 NIP-44'd. That is a *small inline* payload with a
channel-scoped audience — it needs the same wrap primitive but not the blob
path. Build `nip44.encrypt/decrypt` first, use it for both, and keep the
content-key indirection only where a blob exists (a 2 KB engram wrapped N times
is fine; a 50 MiB file is not).

---

## 10. Open questions / what is not verified

- `ts-mls@1.6.4` on Bare — never installed, never run. **UNVERIFIED.**
- `@nucypher/umbral-pre` wasm-bindgen glue on Bare — **not attempted**; the
  GPL-3.0 conflict made it moot.
- Whether an agent can hold a secret key at all: `rg 'fs\.' packages/hive-agent`
  → 0 hits. **Agents have no disk today.** An agent that decrypts files needs
  somewhere to keep its Nostr secret, and there is no fs sandbox
  (`bare-fs` is unrestricted). Key custody for agents is a prerequisite task,
  not part of this one, and it is the real blocker.
- Streaming: `rest.js:245` passes a fully buffered `body` to `mediaStore.put`,
  and `media.js:66` `readFile`s the whole blob. 50 MiB in memory per transfer,
  both directions. Encryption does not make that worse, but it does make
  chunked-AEAD a natural time to fix it.
