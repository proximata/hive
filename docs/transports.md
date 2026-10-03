# Adding a transport

A transport is the thing that carries NIP-01 frames between a peer and the relay. The relay does not know which one it is talking to: every transport hands it the same `Connection` object, and the same contract test runs against all of them.

Four transports ship in `packages/hive-relay/lib/transports/`:

| id | schemes | what it is |
|---|---|---|
| `ws` | `ws://`, `http://` | WebSocket and the REST bridge on one port (`bare-ws`, `bare-http1`) |
| `swarm` | `hyper://` | HyperDHT stream, length-prefixed frames |
| `replication` | none | relay to relay: one hypercore per relay, merged on ingest. Has no client half; see the last section |
| `loopback` | `loopback://` | in-process, no sockets; the example below and a test fixture |

## The contract

A frame is one NIP-01 message as a JSON string: `["EVENT", ...]`, `["REQ", ...]`, `["AUTH", "<challenge>"]`. The transport moves whole frames and never parses them.

Server half, `class extends Transport` (`lib/transports/transport.js`):

| member | what it does |
|---|---|
| `constructor(relay, opts)` | keep `relay`; read your own options from `opts` |
| `get link` | the address clients dial, for example `hyper://<key>` |
| `async listen()` | start accepting peers |
| `async close()` | close every peer and stop listening; resolve when nothing is left open |
| `describe()` | optional: extra facts for the operator (a port, a key) |
| `this.accept(peer)` | hand an inbound peer to the relay; returns a session or `null` |

`accept({ send, close, remote, url })` takes:

- `send(frame)`: write one frame; return `false` when the link is backed up (three in a row make the relay drop the peer)
- `close(reason)`: close the underlying link
- `remote`: transport-level identity of the peer, if there is one (informational)
- `url`: what the peer dialed; defaults to `this.link`. NIP-42 binds the AUTH event to it.

It returns a session, or `null` when the relay is at capacity (`close` has already been called):

- `session.receive(frame)`: feed one inbound frame
- `session.closed(reason)`: the link went away
- `session.fail(err)`: the link broke or the peer misbehaved; reported as `connection-error`

Client half, `class extends TransportClient`:

| member | what it does |
|---|---|
| `async connect(address, { onframe, onclose, onerror })` | dial and start delivering frames |
| `send(frame)` | send one frame |
| `async close()` | end the connection and release what the client owns |

Rules:

- Identity is not the transport's job. Nostr identity comes from NIP-42 on top. A transport may derive its own wire key from `relay.secretKey` (`swarm` and `replication` do) but never signs events.
- Enforce `LIMITS.MAX_FRAME_BYTES` on inbound frames and drop the peer that exceeds it.

## Five steps, with the loopback transport

The whole implementation is `packages/hive-relay/lib/transports/loopback.js`.

**1. Write the server half.** Extend `Transport`, name the address, and bridge each peer into `accept`.

```js
class LoopbackTransport extends Transport {
  constructor (relay, opts = {}) {
    super(relay, opts)
    this.name = opts.name ?? 'relay-' + relay.pubkey.slice(0, 8)
    this.links = new Set()
  }

  get link () { return 'loopback://' + this.name }

  async listen () {
    listening.set(this.name, this)
    return this.link
  }

  async close () {
    listening.delete(this.name)
    for (const link of [...this.links]) link.end()
  }
}
```

A new peer arrives through `_dial`, which calls `this.accept({ send, close })`. `send` delivers the frame to the client on a later tick; `close` ends the link.

**2. Write the client half.** Extend `TransportClient`. `connect` finds the server and wires `onframe` and `onclose`; `send` pushes a frame to the server's session.

```js
class LoopbackClient extends TransportClient {
  async connect (address, { onframe, onclose } = {}) {
    const server = listening.get(address.replace(/^loopback:\/\//, ''))
    if (server === undefined) throw new Error('no loopback transport is listening there')
    this.link = server._dial({ onframe, onclose })
  }

  send (frame) { this.link.send(frame); return true }
  async close () { this.link?.end() }
}
```

**3. Register it.** In `transports/index.js`, or from your own package through `require('hive-relay').transports`:

```js
registerTransport({
  id: 'loopback',
  schemes: ['loopback'],
  capabilities: { encrypted: false, http: false },
  Server: LoopbackTransport,
  Client: LoopbackClient
})
```

Registering throws if the id or a scheme is already taken. `capabilities.encrypted` says the link itself is encrypted; `capabilities.http` says the same port also serves the REST bridge. A transport with a client half needs at least one scheme.

**4. Join the contract suite.** `test/transport.js` runs every registered transport that has both halves through the same tests: the challenge arrives first, unauthenticated peers are refused, publish and live delivery work between two peers, a 40 KB frame arrives intact, a long history is delivered in full, a frame over `MAX_FRAME_BYTES` drops the peer, a dropped peer is cleaned up and can reconnect, and `close()` disconnects everyone. Add a fixture that starts your server half:

```js
const fixtures = {
  // ...
  loopback: async (relay) => {
    const transport = transports.createTransport('loopback', relay, { name: 'contract-' + relay.pubkey.slice(0, 8) })
    await transport.listen()
    return { transport, clientOpts: {} }
  }
}
```

The last test in the file fails while a registered transport has no fixture, so a transport cannot skip the suite by accident. Run it with `npm test`, or only this file with `bare test/transport.js`.

**5. Use it.** Create it by name, and dial it by scheme:

```js
const transport = transports.createTransport('loopback', relay, { name: 'my-relay' })
await transport.listen()

const connection = new RelayConnection({ url: 'loopback://my-relay', secretKey })
```

`hive relay --transport ws,<id>` picks a transport by name when starting a relay. `loopback` is reachable only from the process that started it, so it belongs in code and tests, not on the command line.

`workers/main.js` passes options per transport id in `transportOptions`: `ws` gets `host`, `port`, `publicUrl`, `mediaStore` and `publicDir`, `swarm` gets `bootstrap`, `replication` gets `storageDir`, `topic` and `bootstrap`. If your transport needs options from the command line, add an entry there. A transport that must be in the standalone binary has to be required from `transports/index.js`, because the worker is bundled statically.

## What the contract does not cover

- Backpressure. `send` may return `false` to report a stalled peer, and the relay drops a peer after three in a row. No built-in transport does: the streams buffer past their high-water mark, so a `false` from a tight loop (a client reading a long history) would disconnect a healthy peer. Detecting a really stalled peer needs the relay to wait for `drain`; it does not yet.
- Discovery. A transport that finds peers by topic can do it inside `listen()` (`replication` joins a Hyperswarm topic there) and call `accept` for each client that arrives.

## Replication: a transport between relays

`replication` extends `Transport` for the lifecycle (`link`, `listen`, `close`, `describe`) but never calls `accept`. Its peers are other relays' hypercores, not Nostr clients, so there is no `Connection`, no NIP-42 challenge and no frame. Instead it appends every event the relay accepted from a client to its own core, and reads each peer's core through `relay.ingestFromPeer(event)`, which runs the ordinary event pipeline with a pre-authenticated connection and no per-pubkey rate limit.

It registers with `schemes: []` and no `Client`, which the registry allows only for a transport nobody dials. That also puts it outside the contract suite, which exercises a client talking to a relay; `test/replication.js` covers it. The design and its limits (direct propagation only, unbounded storage, no backfill of existing history) are at the top of `lib/transports/replication.js`. It starts only when a group name is given: `hive relay --replicate <group>`.
