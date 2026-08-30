# Peer bootstrap (Pears/DHT) — research

Verdict up front: **not yet.** Hive needs no own bootstrap node today. Ship a
`--bootstrap` / `HIVE_DHT_BOOTSTRAP` passthrough only when a trigger below fires.

---

## 1. What Hive does today

`packages/hive-relay/lib/transports/swarm.js`

- `:23` `swarmKeyPair(nostrSecretKey)` — DHT keypair seeded from
  `sha256('hive:swarm:v1' || secret)`. Nostr pubkey ⇒ dial address.
- `:67` `SwarmTransport`: `this.dht = opts.dht ?? new DHT({ bootstrap: opts.bootstrap })`
- `:142` `SwarmClient`: same line, same shape.
- `:78` `createServer` + `server.listen(keyPair)`; frames are length-prefixed
  JSON, identical payloads to the WebSocket transport.

Note: **`hyperswarm` is a dependency in package.json but is not imported anywhere
in-tree.** Only `hyperdht` is used (`rtk grep -rn "hyperswarm" --include=*.js packages workers bin.mjs app.js` → no hits).

Plumbing from the CLI:

- `bin.mjs:163` `swarm: flags.swarm` → `app.js:29` `this.swarm = opts.swarm !== false`
  → `app.js:49` positional arg → `workers/main.js:32` `swarmArg`,
  `:42` `const swarmEnabled = swarmArg !== 'false'`.
- `workers/main.js:144-148`:
  ```js
  if (swarmEnabled) {
    swarmTransport = new SwarmTransport(relay)   // ← no opts, no bootstrap
    await swarmTransport.listen()
    say('swarm', { link: swarmTransport.link, publicKey: swarmTransport.publicKey })
  }
  ```
  ∴ `--no-swarm` is the ONLY swarm knob. `opts.bootstrap` reaches
  `SwarmTransport` from tests and from `hive-agent` only — never from the CLI.

Bootstrap already threaded elsewhere:
- `packages/hive-agent/lib/agent.js:69` `bootstrap: opts.bootstrap ?? null`
- `packages/hive-agent/lib/connection.js:17,41` → `new SwarmClient({ bootstrap })`
- `test/swarm.js:24,33` + `test/client.js:41` use `hyperdht/testnet` so the suite
  never touches the public DHT.

Production surface: `GET /api/relay` (which would expose `swarm: relay.swarmKey`,
`packages/hive-relay/lib/rest.js:334`) is auth-gated on the live server —
`rtk curl -s https://beecomb-relay.exe.xyz/api/relay` →
`{"error":"auth","message":"missing or malformed Authorization header"}`.
`/health` → `{"status":"ready","store":"ok","connections":0}`. So **the swarm key
of the public relay is not publicly discoverable**; every real user reaches it over
HTTPS. That fact drives the verdict.

## 2. Default bootstrap

`node_modules/hyperdht/index.js:28`
```js
const bootstrap = opts.bootstrap || BOOTSTRAP_NODES
```
`node_modules/hyperdht/lib/constants.js:17`
```js
exports.BOOTSTRAP_NODES = [
  '88.99.3.86@node1.hyperdht.org:49737',
  '142.93.90.113@node2.hyperdht.org:49737',
  '138.68.147.8@node3.hyperdht.org:49737'
]
```
(hyperdht 6.33.2, dht-rpc 6.27.0 — `rtk node -e "require('./node_modules/hyperdht/package.json').version"`)

The `ip@host:port` form is a hint-with-fallback:
`node_modules/dht-rpc/index.js:878-900` pings the literal IP first, falls back to a
DNS lookup of the hostname if that ping fails. So a Holepunch DNS outage alone
does not kill bootstrap; the pinned IPs do.

`opts.bootstrap === false` ⇒ empty list (`dht-rpc/index.js:36`) ⇒ isolated node.

## 3. Running your own

Minimum, already shipped by the dependency (`node_modules/hyperdht/bin.js:24-35`):

```
npx hyperdht --bootstrap --host <public.ipv4> --port 49737
```
which is `HyperDHT.bootstrapper(port, host)` — `dht-rpc/index.js:104-119`:
```js
const dht = new this({ port, ephemeral: false, firewalled: false,
                       anyPort: false, bootstrap: [], ...opts })
dht._nat.add(host, port)
```

Requirements, and they are hard ones:
- **public static IPv4** (`throw` on non-IPv4, on `0.0.0.0`, on `::`)
- **fixed reachable UDP port**, no NAT in front (`firewalled: false`)
- long uptime — a bootstrap node that moves invalidates every baked-in address

Clients then: `new DHT({ bootstrap: ['<ip>:49737'] })`.

⚠ **`bootstrap: []` means a SEPARATE DHT, not a helper for the public one.** A node
pointed at only your bootstrapper lives on a private island and cannot dial any
peer on the public Holepunch DHT, and vice-versa. That is a fork of the address
space, not redundancy. Redundancy would be `bootstrap: [...HyperDHT.BOOTSTRAP, mine]`
— and then your node must itself have joined the public DHT (pass the public list
into `bootstrapper`'s `opts`, which the `...opts` spread permits). UNVERIFIED that
Holepunch's own nodes would route to it; a non-well-known bootstrapper is only ever
an entry point for clients that name it, so the win is availability, not sovereignty.

Cost: low CPU/RAM (routing table + UDP), continuous but small bandwidth, and a
box that must never change IP. Real cost is operational, not compute.

## 4. Ponytail ladder — is it needed at all?

1. **Needed?** Every deployed path to the relay today is HTTPS/WSS to
   `beecomb-relay.exe.xyz`. The swarm is a side channel whose key isn't even
   published (`/api/relay` is auth-gated, §1). Tests use `hyperdht/testnet`, never
   the public DHT. So an own bootstrap node solves a problem nobody currently has.
   **Cut it.**
2. Stdlib? n/a. 3. Native? The dependency already ships `HyperDHT.bootstrapper`
   and a CLI — nothing to write. 4. Installed dep? Yes, `hyperdht`. 5. One line?
   The client half genuinely is one line (§5). 6. Minimum code: the passthrough,
   nothing else — no config file, no discovery protocol, no registry of nodes.

**Triggers that flip this to yes** (any one):
- swarm becomes a primary transport for real users, i.e. `hyper://<pubkey>` is
  published somewhere a client actually reads
- a deployment must run air-gapped / on a private LAN with no route to
  `node1..3.hyperdht.org:49737` — this is the strongest and most likely trigger
- observed bootstrap failures against the public nodes in the field
- pear-runtime auto-update over the swarm (README:418) becomes load-bearing for
  users who cannot reach the public DHT

## 5. If/when it is worth doing — what "easy" is

One flag, one env var, zero new modules. Mirrors `resolveBind`'s
flag-beats-env-beats-default precedence (`packages/hive-relay/lib/bind.js:39-47`).

```js
// workers/main.js — alongside swarmArg
const bootstrap = (env.HIVE_DHT_BOOTSTRAP ?? '').trim()
swarmTransport = new SwarmTransport(relay, {
  bootstrap: bootstrap === '' ? undefined : bootstrap.split(',')
})
```
`undefined` must be preserved, not `null`/`[]` — `opts.bootstrap || BOOTSTRAP_NODES`
(hyperdht/index.js:28) treats any falsy value as "use defaults", but an empty array
passed deliberately would silently mean defaults too, hiding an operator typo.
Validate: each entry `host:port`, else throw at boot, same as `--host`.

Effort: **low** (worker + `bin.mjs` USAGE env block + one test asserting the
split/validate). Ripple: none — `SwarmTransport`/`SwarmClient` already accept the
option and tests already exercise it.

Operator story, three lines of README:
```
# on a box with a public static IPv4
npx hyperdht --bootstrap --host 203.0.113.10 --port 49737
# everywhere else
HIVE_DHT_BOOTSTRAP=203.0.113.10:49737 hive relay
```

`ponytail:` ceiling — one address, comma-separated list, no health checking, no
failover ordering, no auto-publication of the address. Upgrade path if that bites:
carry the list in the same place the relay's public URL already comes from, rather
than inventing a config file for one value.

## Not done / unverified

- not implemented — research only, no code changed
- production untouched; only `GET /health` and `GET /api/relay` were fetched
- whether Holepunch's public bootstrappers would route toward a third-party
  bootstrapper: UNVERIFIED
