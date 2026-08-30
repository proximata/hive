# Transport & offline — Pear vs Bare, and what "works with no wifi" costs

Answers the owner's question: *"do we even use pears or only bare runtime? … if
low-level networking protocol unavailable — use ws proxy / https proxy / webrtc proxy /
bluetooth proxy, so p2p, delegated inference and relaying works even when there's no
wifi. possible?"*

Verdict up front:

- **Bare only.** Pear is declared, not used. One placeholder link and two unimported deps.
- **"No wifi" is two different problems.** *LAN, no uplink* = a bootstrap problem, mostly
  solved by a flag + one long-lived process. *No radio at all* = BLE = research project.
- Build ONE thing first: **`--bootstrap` passthrough on the relay CLI + a LAN bootstrap
  recipe.** Low effort, unblocks the realistic offline case, zero new dependencies.

---

## 1. Pear vs Bare, precisely

Four separate layers get called "Pears". Hive touches one and a half.

| Layer | What it is | Hive uses it? | Evidence |
|---|---|---|---|
| **Bare** | the runtime (JS engine + `bare-*` stdlib) | **YES, load-bearing** | every script runs `node scripts/bare.js …` (`package.json:44-48`); deps `bare-fs/http1/ws/sqlite/os/path/process/env` |
| **HyperDHT** | networking: Noise streams, NAT hole-punch, key-as-address | **YES, one transport** | `packages/hive-relay/lib/transports/swarm.js:3` `require('hyperdht')` |
| **Hyperswarm** | topic-based discovery on top of HyperDHT | **NO** | declared `package.json:90`; `rg hyperswarm` over `packages workers bin.mjs app.js` → 0 hits |
| **Hypercore / Corestore / Autobase** | the data layer (append-only logs, replication) | **NO** | `corestore` declared `package.json:86`, 0 imports. No hypercore/autobase dep at all. Storage is SQLite: `packages/hive-store/lib/sqlite-store.js:30` |
| **Pear (app platform)** | `pear://` links, staging, seeding, OTA | **declared only** | `package.json:16` `"upgrade": "pear://replace-with-pear-touch-output"` |

The Pear situation exactly:

`workers/main.js:159-188` — the updater is guarded:
```js
if (updates && typeof upgrade === 'string' && upgrade.startsWith('pear://')) {
  const PearRuntime = require('pear-runtime')
```
The placeholder *does* start with `pear://`, so `pear-runtime` loads, then fails on a
key that resolves to nothing, and the catch downgrades it to a log line:
`say('error', { message: 'updater disabled: ' + err.message })`.

There is **no `Pear` global anywhere in-tree** (`rg 'global\.Pear|Pear\.'` over the repo
minus node_modules/docs → 0 code hits). Hive is not run *by* Pear; it embeds a library
that would like to be.

**Becoming a real Pear app concretely requires:**

1. `pear stage <channel> .` → produces a key (`README.md:413`).
2. `pear seed <channel> .` → a long-lived seeder keeps that key alive (`docs/design/keet-practices.md:181`).
3. Replace `package.json:16` with the real `pear://<key>`.
4. Distribution flips from `bare-build` standalone binaries (`package.json:49-54`) to
   `pear install pear://<key>` (`SPEC.md:748`).
5. Staging pulls in Hyperdrive/Corestore replication *for the app bundle only* — it does
   **not** give Hive data replication. Different corestore, different problem.

Effort: **low** for 1-3 (a CLI run + one string). The real cost is 2 — a seeder is a
machine that must stay up, i.e. the same operational commitment as a bootstrap node.

`ponytail:` do steps 1-3 only when someone actually needs OTA. Today the placeholder is
honest — it disables cleanly. Ceiling: no auto-update. Upgrade path: run `pear stage`.

---

## 2. What HyperDHT gives Hive today

`packages/hive-relay/lib/transports/swarm.js`:

- `:23` keypair seeded from `sha256('hive:swarm:v1' || nostrSecret)` → the Nostr pubkey
  *is* the dial address, `hyper://<pubkey>` (`:73`).
- `:78-81` `dht.createServer(...).listen(keyPair)` — inbound Noise streams.
- `:132-160` `SwarmClient.connect()` dials by pubkey.
- Frames are 4-byte length-prefixed JSON — byte-identical to the WebSocket transport,
  which is why the protocol suite runs over both.

Value delivered: **no ports, no DNS, no TLS certs, NAT traversal, and identity ==
address.** That is real and it is the one genuinely Pears-y thing in the repo.

**Reachable in production? Effectively no.** `workers/main.js:145` constructs
`new SwarmTransport(relay)` with no opts, so it uses public bootstrap and it does listen —
but the key is only exposed via `GET /api/relay`, which is auth-gated on the live host
(`docs/design/peer-bootstrap.md:44-49`, verified curl → `{"error":"auth",…}`). Nobody can
learn the address, so every real user arrives over HTTPS. The swarm transport is live,
tested, and unused by humans.

**Does it need internet? Yes, for discovery.** Default bootstrap is three internet hosts:
```js
// node_modules/hyperdht/lib/constants.js:17
exports.BOOTSTRAP_NODES = ['88.99.3.86@node1.hyperdht.org:49737', …]
```
**Local/mDNS discovery: does not exist.**
`rg -i 'mdns|multicast|239\.|lan' node_modules/{hyperswarm,hyperdht}/index.js node_modules/dht-rpc/index.js` → **0 hits**.
`hyperswarm-mdns` / `@hyperswarm/mdns` / `bare-mdns` → all **E404 on npm**.
Hyperswarm v4 dropped the old `@hyperswarm/discovery` LAN layer; there is no zero-config
LAN peer finding in this stack. Anything local must be *pointed at* a node.

---

## 3. The "no wifi" claim, unsentimentally

First, split the case. "No wifi" almost always means **"wifi, but no uplink"** — a router
with dead internet, a hotspot, a venue AP, a phone's tethering. "No radio at all" is rare
and is a different, much harder product.

### 3a. LAN with no internet — the real case

What breaks: **only bootstrap.** UDP hole-punching between two hosts on the same subnet
is unnecessary; they can route directly. The DHT just cannot find anyone.

What fixes it, already shipped by an installed dep:
```js
// node_modules/dht-rpc/index.js:104-112
static bootstrapper(port, host, opts) {
  if (host === '0.0.0.0' || host === '::') throw new Error('Invalid host')
  if (!UDX.isIPv4(host)) throw new Error('Host must be a IPv4 address')
```
It demands an IPv4 — **not a public one.** `192.168.1.10` passes every check. So
`npx hyperdht --bootstrap --host 192.168.1.10 --port 49737`
(`node_modules/hyperdht/bin.js:24-35`) is a valid LAN-only DHT.

Missing piece in Hive: `workers/main.js:145` `new SwarmTransport(relay)` passes **no
opts**, so `bootstrap` never reaches the DHT from the CLI. `--no-swarm` is the only knob
(`docs/design/peer-bootstrap.md:30-38`). The plumbing already exists one layer down —
`swarm.js:68` `new DHT({ bootstrap: opts.bootstrap })`, and `hive-agent/lib/agent.js:69`
already threads `bootstrap`. Relay CLI is the only gap.

Verdict: **works today with a flag Hive does not expose.** Effort **low**.

### 3b. WS / HTTPS proxy

Two things already exist, and one of them is Hive itself.

- **Hive's own relay is the proxy.** `packages/hive-relay/lib/transports/ws.js` carries
  the identical frames. Any device that can reach a relay over WS gets full protocol
  access with no DHT at all. On a LAN with no uplink, one machine running `hive relay`
  plus everyone typing its `ws://192.168.x.x:port` is a **working offline Hive today,
  zero code**. This is the answer people actually want and it is already built.
- **`@hyperswarm/dht-relay` v0.4.3 exists** ("Relaying the Hyperswarm DHT over framed
  streams"), deps on `hyperdht` + `ws` + `protomux` — all in Hive's tree already. It
  proxies *DHT access* to a client that cannot speak UDP (browser, restricted network).
  Effort **med** (new dep, new server surface, new auth boundary). It solves
  "browser wants to be a peer" — which is Phase 1's *explicit non-goal* in issue #17.
  `ponytail:` don't. Not needed for offline; needed for browser P2P later.

### 3c. WebRTC

**No WebRTC for Bare.** `bare-webrtc` → E404. `@bare/webrtc` → E404. Nothing in the
holepunch org. Options are `node-datachannel` v0.33.2 (a Node N-API addon — Node, not
Bare; would need a Bare addon port) or the browser's built-in `RTCPeerConnection`.

So WebRTC is a **browser-side** answer, not a Bare-side one. And it does not help
offline anyway: WebRTC needs a signalling server and usually STUN/TURN — i.e. internet —
to establish a connection. It buys nothing over 3a/3b.

Verdict: **not available, and would not solve the stated problem.** Cut.

### 3d. Bluetooth / BLE

This one is more real than expected: **`bare-bluetooth` v0.3.0 exists, from Holepunch.**
"BLE central and peripheral roles, GATT services and characteristics, and **L2CAP
channels**". L2CAP CoC matters — it is a stream, not 20-byte GATT pokes, so framed JSON
would actually fit.

But read the fine print, straight from the tarball:

- `README.md:1-2`: *"This module is **experimental**. The API is subject to change and
  may break at any time."*
- `package.json` `imports["#bluetooth"]` maps **only** `android`, `darwin`, `ios`.
  **No linux, no win32.** A Linux relay — i.e. the live one — cannot load it at all.

Realistic numbers, UNVERIFIED (no device test run): BLE 4.2/5 L2CAP CoC lands roughly
**20-100 kB/s** in practice. Text chat fits. A model weight or a media blob does not.
iOS background execution is the killer: a backgrounded app keeps only a restricted
advertising/central mode, the local-name goes out of the advert, and there is no
long-lived background scanning without the user foregrounding the app. Pairing/bonding
is a per-device UX ritual, not a network.

Verdict: **exists, mobile-only, experimental, no Linux, and would need an entire new
discovery + framing + retry layer.** Effort **high** and it is a research project, not
a feature. Correct move: write the finding down (this doc), build nothing.

---

## 4. Delegated inference and "strongest nodes host data for all"

**Delegated inference** — partly scaffolded, entirely non-functional.
- `packages/hive-agent/lib/qvac.js:81-88` builds a `delegate` param
  (`providerPublicKey`, `timeout`, `fallbackToLocal`), fed from a persona at `:204`.
- `SPEC.md:633` advertises `"delegation": { "accepts": true, "public_key": "<hyperdht pubkey>" }`,
  and `agent.js:141` hardcodes `accepts: false`.
- The consumer of that param is `@qvac/sdk` — an **uninstalled optional peer dep**
  (`lib/qvac-absent.js` throws by design). `@qvac/sdk` v0.18.2 *is* published.
- Independently, providers return `toolCalls: []` (`provider.js:104`), so there is no
  tool loop for an agent to delegate *within* either.

Missing: install + a real accept path + an authorisation model. Today "delegation" means
one agent @-mentioning another over Nostr (`agent.js:324`), not remote compute. That is a
routing feature wearing an inference costume. Effort to make real: **high**, and it is
gated on trust — you are inviting a stranger's machine to run your prompt.

**"Strongest nodes host data for all"** — nothing exists.
- Store is per-relay SQLite (`sqlite-store.js:59`), no replication anywhere in-tree.
- Media is local disk, content-addressed but not shared:
  `packages/hive-relay/lib/media.js:32,45,51` `mkdirSync` / `writeFile` into a two-level
  sha256 fan-out.
- `corestore` — the exact dependency that would give replication — is installed with
  **zero imports**.

To deliver it you need an append-only replicated log: Hypercore per writer, Autobase to
merge multiple writers, Corestore to hold them, Hyperswarm to replicate, Hyperblobs for
media (`docs/design/keet-practices.md:20-30` already maps this). That is a **storage
engine swap**, not a transport tweak. Effort **high**, and it invalidates the current
SQLite query layer including the hand-rolled inverted index (`lib/search.js:5`).

Note the ordering trap: replication is what makes offline *useful* (peers reconcile when
they meet), but transport is what makes it *possible*. Doing replication first with no
offline transport gains nothing; doing transport first is immediately usable via 3b.

---

## 5. Verdict + the one thing to build

Ranked by (real users unblocked) / effort:

| Fallback | Exists for this stack? | Solves no-uplink? | Effort | Verdict |
|---|---|---|---|---|
| **Hive relay over WS on the LAN** | ✓ already shipped (`transports/ws.js`) | ✓ fully | none | **✓ document it, ship nothing** |
| **DHT LAN bootstrap** | ✓ `dht-rpc` bootstrapper accepts private IPv4 | ✓ | low | **✓ BUILD THIS** |
| **HTTPS proxy** | ✓ relay REST already | ✓ | none | ✓ same as row 1 |
| `@hyperswarm/dht-relay` | ✓ v0.4.3, deps all present | ✗ (needs a reachable relay anyway) | med | ⚠ defer — it's for browser peers, not offline |
| **WebRTC** | ✗ no Bare binding (E404 ×2); browser-only | ✗ needs signalling + STUN | high | ✗ cut |
| **BLE** | ⚠ `bare-bluetooth` 0.3.0, experimental, android/darwin/ios only | ⚠ only true-no-radio case | high | ✗ research, not roadmap |
| **Replicated store** | ✗ `corestore` installed, 0 imports | n/a | high | ✗ separate epic |
| **Delegated inference** | ⚠ params scaffolded, SDK uninstalled | n/a | high | ✗ gated on trust model |

The evidence agrees with the prior: **LAN-without-internet is the realistic offline case
and it is almost entirely a bootstrap problem. BLE is a research project.**

The sharpest finding is the one that costs nothing: **an offline LAN Hive already works
today over WebSocket.** No DHT required. One host runs `hive relay`, everyone else points
at its LAN IP. The only reason this is not the answer is that nobody wrote it down.

### The single first step

**Thread `--bootstrap` / `HIVE_DHT_BOOTSTRAP` through the relay CLI to `SwarmTransport`,
and ship a LAN-offline recipe in the runbook.**

Concretely, `workers/main.js:145`:
```js
-  swarmTransport = new SwarmTransport(relay)
+  swarmTransport = new SwarmTransport(relay, { bootstrap })
```
plus the arg in `bin.mjs`/`app.js` alongside the existing `swarm` flag, defaulting to
`undefined` so today's behaviour is byte-identical. `SwarmTransport` already accepts it
(`swarm.js:68`); `hive-agent` already threads it (`agent.js:69`); tests already use it
(`test/swarm.js:24`). This is **~5 lines and one doc section**, no new dependency.

Why this and not the others: it is the only item where the code is 95% written, the
dependency is already installed, the test harness already exercises the path, and the
user story ("we're at a venue, the wifi has no internet, Hive still works") is real.

`ponytail:` deliberately NOT included — auto-detecting a LAN bootstrap, mDNS, an embedded
bootstrapper mode, or any fallback chain. Ceiling: an operator must type one IP.
Upgrade path: if that typing turns out to be the friction, *then* add discovery — and
the honest way to add it is a small mDNS/UDP-broadcast announce, not BLE.

Gates unaffected: `rtk npm test` (226), `npm run demo:tui -- --demo` (16/16),
`./skill/check.sh` (22). Live relay untouched — the flag defaults to current behaviour.
