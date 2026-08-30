# Keet / Pears practices — what Hive should copy

Research note. Sources: `docs.pears.com` (scraped 2026-08-30, files cached under `.firecrawl/`),
`npm view` output, and this repo. Anything not backed by a URL or a file:line is marked
UNVERIFIED.

Keet itself is closed-source. Holepunch does not publish `keet-core`
(`rtk npm view keet-core` → `404 Unpublished on 2023-05-23`). So everything below about Keet's
internals comes from (a) Holepunch's own docs naming Keet as the reference app, and
(b) the open modules Holepunch extracted from Keet — `keet-identity-key`, `blind-pairing`,
`blind-peering`, `autopass` (the "Keet-shaped app, minus the chat" sample). Treat
module-level claims as solid, exact-Keet-internals claims as inference.

---

## 1. Architecture — the actual modules

| Concern | Module | Evidence |
|---|---|---|
| storage root | `corestore` (v7, RocksDB-backed) | autopass README L255 "Autopass needs Corestore 7 … backed by RocksDB for storage and atomicity" |
| append-only log | `hypercore` | docs.pears.com/reference/building-blocks/hypercore |
| multiwriter room state | `autobase` v7 | `rtk npm view autopass dependencies` → `autobase: ^7.19.4` |
| indexed KV over the base | `hyperbee` + `hyperdb` | same dep list: `hyperdb ^4.16.1`, `hyperbee ^2.26.5` |
| transport / discovery | `hyperswarm` → `hyperdht` (Noise, NAT hole-punch) | bare-native.md: core "runs Hyperswarm and HyperDHT … Noise-encrypted connections" |
| wire schema | `hyperschema` + `hyperdispatch` + `compact-encoding` | autopass deps; bare-native.md "typed RPC seam" |
| files / media | `hyperdrive` (fs) and `hyperblobs` (blobs) | docs.pears.com/how-to/stream-and-share-media/* |
| membership / invites | `blind-pairing` (+ `blind-pairing-core`) | autopass deps `blind-pairing ^2.3.1` |
| availability when everyone is offline | `blind-peering` client + `blind-peer` server | blind.md "Blind peering" section |
| identity | `keet-identity-key` | identity.md, whole page |
| app distribution | `hyperdrive` behind a `pear://` link + `pear-runtime` updater | deploy.md glossary |

The canonical "this is how a Keet-class app is assembled" reference is
[`autopass`](https://github.com/holepunchto/autopass) — Corestore + Autobase + hyperdb view +
blind-pairing invites + blind-peering. Its API is literally:

```
const pass = new Autopass(new Corestore('./pass'))
const inv  = await pass.createInvite()          // autopass README L269
const pair = Autopass.pair(new Corestore('./another-pass'), inv)  // L276
```

**Room model (inference, medium confidence):** a Keet room = one Autobase whose writers are the
member devices; `addWriter` is an operation appended to the base, so membership is itself part of
the replicated log, not a server-side ACL table. That is exactly the autobase README pattern
(`remote.append({ addWriter: local.local.key })`). Joining is `blind-pairing`: the invite code is
a capability, the inviter's node completes a handshake and appends the `addWriter`. There is no
membership server anywhere in the chain.

**Blind peering is the interesting bit** — Holepunch's phrase is
"putting the server in serverless" (blind.md):

> A **blind peer** is a dedicated replicator that stores and serves Hypercores **without
> decrypting or interpreting** their contents.

Run as `npm i -g blind-peer-cli && blind-peer`, default 100 GB budget, `-m <MB>` to cap,
`--trusted-peer <pubkey>` to authorise announcing (blind.md). It exists precisely because a phone
that is asleep cannot seed, and because you cannot seed a room you are not a member of.

---

## 2. Multi-device for one identity, and offline/sync

This is the part Hive has no answer for, and Holepunch's answer is a single small module:
**`keet-identity-key`** (`rtk npm view keet-identity-key` → v3.2.0, "Hierarchical Deterministic
Keys for Keet Identities", deps: `bip39-mnemonic`, `sodium-universal`, `sodium-hmac`,
`compact-encoding`, `b4a`, `nanoassert`).

The model (identity.md, verbatim table):

| Concept | What it is |
|---|---|
| **Mnemonic** | 24 words. The root secret—back it up like a wallet seed. |
| **Identity** | Derived from the mnemonic. Its `identityPublicKey` is stable everywhere. |
| **Device key pair** | A fresh, per-device key. Never leaves the device. |
| **Device proof** | The identity's signature attesting that the device key speaks for it. |
| **Data proof** | A signature over a payload, made with the device key, anchored to the identity. |

```js
const identity     = await Identity.from({ mnemonic })
const deviceKeyPair = crypto.keyPair()                       // per device, never exported
const deviceProof   = await identity.bootstrap(deviceKeyPair.publicKey)
const proof         = Identity.attestData(payload, deviceKeyPair, deviceProof)
const ok            = Identity.verify(proof, payload, { expectedIdentity: identity.identityPublicKey })
```

> "you can sign data on any device and anyone can verify it was authored by the same person,
> without ever copying the identity's secret onto that device" — identity.md

Key properties, and each one is a direct criticism of how Hive does keys today:

- the long-lived secret is a **seed**, not a signing key. Devices hold ephemeral keys.
- **revocation is per-device**, not per-account. Losing a laptop does not burn the identity.
- a **Hypercore key identifies a log, not a person** (identity.md, first line). Keet deliberately
  separates "who wrote this" from "which log is this".
- verification needs only the public `identityPublicKey` — no shared secret, no server.

Hive today conflates all three: the Nostr secp256k1 secret key *is* the identity, *is* the device
key, and — via `swarmKeyPair` — *is* the transport address
(`packages/hive-relay/lib/transports/swarm.js:24-27`: `sha256('hive:swarm:v1' || secret)`).
One key, three jobs, no revocation, no second device.

**Offline/sync.** Keet's answer is not a sync algorithm, it's a data structure: Autobase is a
CRDT-ish multiwriter log where each device appends to its own core and a deterministic `apply`
folds them into one view. Offline writes are just unreplicated blocks; reconnecting replicates
them. There is no "conflict resolution" step to write because there is no single mutable state.
Availability while everyone is offline is delegated to blind peers, which is a *separate* concern
from correctness. That separation — correctness in the data structure, availability in an
optional always-on node — is the practice worth stealing even if the data structure is not.

---

## 3. Packaging and shipping

### The split, which is the whole architecture

> - **Pear-end** — the peer-to-peer logic, business rules, and storage. Runs in a Bare worker.
> - **UI** — the platform-specific presentation. Talks to the Pear-end over an IPC stream.
>
> "This split is what powers Keet's identical experience across phones, laptops, and terminals:
> one Pear-end, three UIs." — langs.md

Rule of thumb, quoted from desktoparch.md: **main = shell + IPC, worker = data plane,
renderer = view.** The renderer never imports `hyperswarm`/`hypercore`. Native addons live only
on the worker side.

### Desktop

Electron shell + Bare worker, from the `hello-pear-electron` template — deploy.md says explicitly
this is "the same Electron + Bare worker template [Keet](https://keet.io/) and PearPass ship".
`pear-runtime` (v1.3.1 — already a dependency of this repo, `package.json`) lives *inside* the
worker; the Electron main process is a thin proxy. Production apps use the full
`new PearRuntime({...})` constructor rather than the `PearRuntime.run()` shortcut, and the OTA
updater gets **its own dedicated worker** so update traffic never blocks the app worker
(desktoparch.md).

### Mobile

- native shell (SwiftUI / Kotlin) or React Native; core runs as a Bare **worklet** via `bare-kit`.
- `react-native-bare-kit` v0.15.0 (deps: only `bare-events`, `bare-link`, `streamx`;
  peer deps react/react-native) exposes `Worklet` + `IPC` in JS.
- `expo-bare-kit` v0.1.1 exists for Expo.
- `pear-mobile` v4.3.0 "Embeddable Pear runtime for mobile applications" is the mobile counterpart
  of `pear-runtime` (deps include `corestore`, `hyperswarm`, `pear-runtime-updater`).
- worklet start: `worklet.start('/app.bundle', bundle)` — real apps ship a prebuilt bundle, not
  inlined source (rn.md "Next steps").
- worklet `console.*` → system log under the `bare` identifier (Console.app / `logcat`).

### The seam

Not raw bytes. `hyperschema` (versioned append-only schemas) → `compact-encoding` codecs →
`bare-rpc` framing, with generated bindings per language (JS today; Swift toolchain
`hyperschema-swift` / `bare-rpc-swift` / `hrpc-swift` shipped, C and Kotlin "following").
Supports unary, send-only, response-stream, request-stream, duplex. "Update the schema,
regenerate, and both sides get the new types — a compiler error if the shell and core drift
apart." (bare-native.md)

### OTA

App bytes live in a Hyperdrive behind a `pear://` link. Running app polls it; when the Hypercore
length advances:

```
new blocks → pear.updater 'updating' → fully on disk → 'updated'
           → updater.applyUpdate()  (renames app dir to new build, deletes old)
           → app.relaunch(); app.quit()   ← running code is still OLD until restart
```
(deploy.md, OTA lifecycle section.) Disable with `--no-updates` or `"updates": false`.
On Linux AppImage relaunch via `process.env.APPIMAGE`, not `process.execPath`.

Trust ladder — three commands, three assurance levels:

- `pear stage` — append a deployment dir into a release-line drive. Iteration, ephemeral links.
- `pear provision` — copy from a *versioned* stage link to a leaner prerelease link, compacting
  history.
- `pear multisig` (`request` → `sign` ×N → `verify` → `commit`) — production writes need a quorum,
  "so one compromised machine cannot redefine the release line".

Release lines are parallel tracks (development / staging / rc / prerelease / production), each its
own `pear://` link, and `package.json`'s `upgrade` field decides which line a shipped binary
follows. Note the trick: **rc's `upgrade` pins the production multisig key**, so rc builds don't
get casual OTA bumps. `pear seed` keeps a link alive.

Hive's `package.json` has `"upgrade": "pear://replace-with-pear-touch-output"` — the field is
present and unfilled. Nothing in the repo drives that pipeline.

### App stores

docs.pears.com/how-to/operate-an-app/build-and-package/submit-to-app-stores covers **Flathub and
Snap only**. Keet ships on Flathub as `io.keet.Keet`, distributables hosted at
`https://static.keet.io/downloads/` with a flatpak-external-data-checker rule scraping the version
out of the download index. There is **no Apple/Google submission guide in the Pear docs** —
UNVERIFIED how Keet clears App Store review. Docs do assert store distribution "complements,
rather than replaces" P2P: "apps installed from a store still update over the air through Pear
OTA" (appstore.md L66), which is a legally interesting claim for iOS and one this note will not
vouch for.

---

## 4. Bare-on-mobile constraints and gotchas

The suspension contract is the sharpest one, and it's a silent killer:

> "Getting suspension wrong is silent: the OS gives the app no warning before it force-terminates
> it. A backgrounded app that leaves an HTTP server listening, a TCP socket open, or a live timer
> running will be killed—usually within a few seconds on iOS and Android." — suspension.md

Lifecycle: host calls `Bare.suspend()` → `suspend` event → loop drains → `idle` → blocks →
`Bare.resume()`. The loop only reaches `idle` when **zero referenced handles** remain. Two
patterns:

- **A — `unref()`**: for handles that must survive (the bare-kit IPC channel).
  `Bare.on('suspend', () => IPC.unref())` / `ref()` on resume.
- **B — close and recreate**: everything else. `server.close()` is *not enough*, existing
  connections stay referenced — destroy them first.

Hyperswarm and Corestore have first-class support:

```js
Bare.on('suspend', async () => { await swarm.suspend(); await store.suspend() })
Bare.on('resume',  async () => { await store.resume();  await swarm.resume() })
```

`store.suspend()` flushes buffered writes — "if the OS force-terminates the app before a flush,
recent writes can be lost". `swarm.suspend()` keeps joined topics, so resume reconnects without
rejoining. Timers count as referenced handles too; `clearInterval` on suspend.

`react-native-bare-kit` already subscribes to RN `AppState` and calls `worklet.suspend()`/
`.resume()` for you — "adding your own listeners is redundant but harmless".

Other constraints:

- **background execution**: none, effectively. The documented model is "go quiet and die quietly",
  not "keep syncing". This is why blind peers exist.
- **push notifications**: no Pear doc found. UNVERIFIED how Keet does it. Structurally it cannot
  be done from a suspended worklet, so it must involve a push service that learns *something*
  about a room — the obvious tension with a blind peer that holds no plaintext. Do not guess;
  this needs its own research pass before Hive designs anything mobile-notification-shaped.
- **battery**: not addressed in the docs beyond the suspension rules. UNVERIFIED.
- **App Store rules for P2P + OTA**: UNVERIFIED, see above.

---

## 5. What Hive should copy — and what it should not

First, the honest contrast. Hive is not a Keet-shaped app:

- storage is SQLite, not Hypercore. `packages/hive-store/lib/sqlite-store.js`, `bare-sqlite` in
  `package.json`. No `autobase` and no `hyperdrive` in `node_modules` — checked.
- the swarm side channel is **not** Hyperswarm. It is raw `hyperdht` with 4-byte length-prefixed
  JSON frames (`packages/hive-relay/lib/transports/swarm.js:1-45`) carrying the same relay
  protocol the WebSocket transport carries. It's an alternate dial address, not replication.
- the model is client/server: one relay holds the truth, clients connect. Keet has no server.

So "adopt Keet's architecture" would mean rewriting Hive as a different product. Not on the table.
What follows is only the parts that transfer to a client/server app.

### Copy — cheap and directly applicable

**1. Split identity from device key. (`keet-identity-key`, ~high value, medium effort)**
This is the one genuine gap. Multi-device Nostr is unsolved *because* nsec is the identity. The
`identity → deviceProof → attestData → verify` chain gives per-device keys and per-device
revocation without a server. It transfers because it is pure crypto — no Hypercore, no swarm, no
Autobase. And Hive already has the shaped hole: `verifyAttestation` in
`packages/hive-core/lib/attestation.js` is correct code with no caller, and kind-10100 `owner` is
a self-signed claim. A device-proof chain is exactly what turns that claim into something
checkable. Caveat: `keet-identity-key` is ed25519/sodium; Nostr is secp256k1/schnorr. The
*shape* transfers, the library may not — check before assuming a dependency.

**2. The suspend/resume contract, everywhere, now. (low effort)**
Not mobile-specific and not optional later. Any long-lived Hive process that keeps a DHT socket
and timers open needs `Bare.on('suspend')` handlers before a mobile shell is even considered, and
`store.suspend()`-style flush-before-quiet is a data-loss issue on *any* platform that can kill
the process. Cheap, and retrofitting it after a mobile port exists is worse.

**3. Pear-end / UI split as a discipline. (low effort, mostly already true)**
Hive's packages are already logic-only with `hive-web/public/` as a separate browser client. Keep
it that way and keep the seam explicit: one duplex, no DOM in the packages, no protocol logic in
the client. This is the thing that makes a mobile shell possible later without a rewrite. It costs
nothing to preserve and is expensive to recover.

**4. Release lines + `upgrade` pinning, *if* Hive ever ships a desktop binary. (medium)**
The `rc-pins-production-key` trick is genuinely clever and costs one config field. The `upgrade`
field in `package.json` is already a placeholder.

**5. Blind peering as a *concept*, when there is a second relay. (defer)**
"Availability is a separate always-on node, not a property of the protocol" is the right shape
for Hive too. Not code to write today — Hive already has an always-on relay, which *is* its blind
peer, minus the blindness. Worth naming in the SPEC so the eventual multi-relay design does not
re-derive it.

### Do NOT adopt

**Autobase / Hypercore / Corestore as the store.** Hive's store is SQLite with a working audit
chain and 226 passing tests. Swapping in a multiwriter CRDT log buys conflict-free multiwriter
that a single-relay product does not have and does not need. This is a rewrite disguised as a
dependency bump. Ladder step 1: not needed at all.

**`hyperschema` + `bare-rpc` typed seam.** Hive's wire format is Nostr JSON — an existing,
specified, interoperable format with third-party clients. Replacing it with generated
compact-encoding codecs would break interop to save bytes nobody is counting. Adopt only if and
when a native mobile shell in Swift/Kotlin actually exists and hand-writing the bridge hurts.

**Multisig releases.** Quorum signing defends against one compromised signer on a
production release line. Hive has one maintainer and no release line. `ponytail:` single-signer
`pear stage` is the ceiling here; upgrade path is `pear multisig` when there is a second person
who could plausibly be a signer. Setting up a 2-of-3 quorum you sign alone is theatre.

**`pear provision` (the middle rung).** Stage → production directly. The compaction step matters
when the drive history is large enough that mirroring it is expensive. It is not.

**Flathub / Snap submission.** Two store review processes for a project that currently ships a
public web relay. Ladder step 1 again.

**Blind-peer server deployment.** Zero users are currently unable to reach data. Solving
availability before anyone is missing anything.

**A React Native app.** The suspension rules, push-notification gap and App Store uncertainty are
each unresolved research, not implementation. Anything mobile should start as a spike against
`react-native-bare-kit` + a hello-world worklet to measure the real constraints, not as a product.

### Sequencing, if any of this gets picked up

```
suspend/resume handlers   → low effort,  prevents silent data loss     → do first
device-key attestation    → med effort,  closes the real gap (10100)   → do next
keep the Pear-end split   → zero effort, preserves optionality         → ongoing
release lines             → only when a binary ships
everything else           → not yet
```

---

## Sources

Scraped 2026-08-30 into `.firecrawl/` (gitignored — add `.firecrawl/` to `.gitignore`, it is
currently not ignored):

- `identity.md` ← docs.pears.com/how-to/manage-identity/create-a-portable-identity-with-keet-identity-key
- `suspension.md` ← docs.pears.com/how-to/run-on-native/handle-app-suspension
- `bare-native.md` ← docs.pears.com/explanation/bare-on-native
- `deploy.md` ← docs.pears.com/explanation/deployment-releasing-apps-p2p
- `desktoparch.md` ← docs.pears.com/explanation/pear-desktop-architecture
- `blind.md` ← docs.pears.com/explanation/availability-and-blind-peering
- `rn.md` ← docs.pears.com/how-to/run-on-native/embed-bare-in-react-native
- `langs.md` ← docs.pears.com/explanation/runtime-and-languages
- `appstore.md` ← docs.pears.com/how-to/operate-an-app/build-and-package/submit-to-app-stores
- `autopass.md` ← github.com/holepunchto/autopass

npm metadata via `rtk npm view`: `keet-identity-key@3.2.0`, `autobase@7.28.1`,
`blind-pairing@2.3.1`, `blind-peering@2.6.3`, `pear-mobile@4.3.0`,
`react-native-bare-kit@0.15.0`, `expo-bare-kit@0.1.1`, `hyperdrive@13.3.3`, `hyperblobs@2.12.1`.
`keet-core` and `bare-kit` are not on npm (404).
