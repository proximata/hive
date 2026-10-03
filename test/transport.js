'use strict'

const test = require('brittle')
const os = require('bare-os')
const fs = require('bare-fs')
const path = require('bare-path')
const DHT = require('hyperdht')
const createTestnet = require('hyperdht/testnet')
const core = require('hive-core')

const { openStore } = require('hive-store')
const { Relay, Transport, TransportClient, transports } = require('hive-relay')

const { TestClient } = require('./client')
const { identity, sign } = require('./helpers')

// The contract suite. Every client-facing transport in the registry (one with
// both a server and a client half) runs the same tests, because the relay must
// not be able to tell them apart. A transport joins the suite by adding a
// fixture below; the last test fails until it does. Relay-to-relay transports
// have no client half and are covered by replication.js.
//
// A fixture starts the server half and returns whatever the client half needs:
//   { transport, clientOpts, cleanup? }

const fixtures = {
  ws: async (relay) => {
    const transport = transports.createTransport('ws', relay, { port: 0 })
    await transport.listen()
    return { transport, clientOpts: {} }
  },

  // A local DHT testnet keeps the suite off the public network.
  swarm: async (relay) => {
    const testnet = await createTestnet(3)
    const dht = new DHT({ bootstrap: testnet.bootstrap })
    const transport = transports.createTransport('swarm', relay, { dht })
    await transport.listen()

    return {
      transport,
      clientOpts: { bootstrap: testnet.bootstrap },
      cleanup: async () => {
        await dht.destroy()
        await testnet.destroy()
      }
    }
  },

  loopback: async (relay) => {
    const transport = transports.createTransport('loopback', relay, { name: 'contract-' + relay.pubkey.slice(0, 8) })
    await transport.listen()
    return { transport, clientOpts: {} }
  }
}

async function harness (t, id) {
  const store = openStore(':memory:')
  const relay = new Relay(store, { url: 'ws://127.0.0.1' })
  const { transport, clientOpts, cleanup } = await fixtures[id](relay)

  const clients = []
  const connect = async () => {
    const client = await TestClient.open(transport.link, clientOpts)
    clients.push(client)
    return client
  }

  // Tests may close the transport themselves; closing twice is not something
  // every transport supports, so teardown only closes it once.
  let closing = null
  const closeTransport = () => { closing ??= transport.close(); return closing }

  t.teardown(async () => {
    for (const client of clients) await client.destroy()
    relay.close()
    await closeTransport()
    await cleanup?.()
    store.close()
  })

  return { store, relay, transport, connect, closeTransport }
}

async function member (h, who) {
  const client = await h.connect()
  await client.authenticate(who, { relayUrl: h.transport.link })
  return client
}

async function eventually (predicate, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return true
}

const serverIds = transports.listTransports()
  .filter((d) => d.Server !== null && d.Client !== null)
  .map((d) => d.id)

for (const id of serverIds) {
  const definition = transports.getTransport(id)

  test(`[${id}] the link is an address in one of the transport's schemes`, async (t) => {
    const h = await harness(t, id)

    const scheme = /^([a-z]+):\/\//.exec(h.transport.link)?.[1]
    t.ok(definition.schemes.includes(scheme), `${h.transport.link} uses a declared scheme`)
    t.is(typeof definition.capabilities.encrypted, 'boolean')
    t.is(typeof definition.capabilities.http, 'boolean')
    t.ok(h.transport instanceof Transport)
  })

  test(`[${id}] the relay challenges first and the client can authenticate`, async (t) => {
    const h = await harness(t, id)
    const alice = identity('alice')

    const client = await h.connect()
    t.is(client.challenge.length, 48, 'NIP-42 challenge arrives without being asked for')
    t.is(h.relay.connections.size, 1)

    const ok = await client.authenticate(alice, { relayUrl: h.transport.link })
    t.is(ok.accepted, true)
  })

  test(`[${id}] unauthenticated peers are refused`, async (t) => {
    const h = await harness(t, id)
    const alice = identity('alice')

    const client = await h.connect()
    const ok = await client.publish(sign(alice, { kind: 1, content: 'no auth' }))

    t.is(ok.accepted, false)
    t.ok(ok.reason.startsWith('auth-required:'))
  })

  test(`[${id}] publish, read back, and live delivery between two peers`, async (t) => {
    const h = await harness(t, id)
    const alice = identity('alice')
    const bob = identity('bob')

    const aliceClient = await member(h, alice)
    const bobClient = await member(h, bob)

    const first = sign(alice, { kind: 1, content: 'stored' })
    t.is((await aliceClient.publish(first)).accepted, true)

    const sub = await bobClient.subscribe('s1', { kinds: [1] })
    t.alike(sub.events, [first], 'history arrives before EOSE')

    const live = sign(alice, { kind: 1, content: 'live' })
    await aliceClient.publish(live)
    t.alike(await bobClient.nextEvent('s1'), live, 'live fan-out reaches the other peer')
  })

  test(`[${id}] a frame larger than one chunk arrives intact`, async (t) => {
    const h = await harness(t, id)
    const alice = identity('alice')
    const client = await member(h, alice)

    const big = 'x'.repeat(40000)
    const event = sign(alice, { kind: 1, content: big })
    t.is((await client.publish(event)).accepted, true)

    const sub = await client.subscribe('s1', { ids: [event.id] })
    t.is(sub.events[0].content.length, big.length)
  })

  test(`[${id}] a long history is delivered in full`, async (t) => {
    const h = await harness(t, id)
    const alice = identity('alice')
    const client = await member(h, alice)

    // Enough bytes to pass any stream's write buffer in one burst of sends.
    const filler = 'x'.repeat(1500)
    for (let i = 0; i < 150; i++) {
      t.is((await client.publish(sign(alice, { kind: 1, content: filler + i }))).accepted, true)
    }

    const sub = await client.subscribe('s1', { kinds: [1], limit: 150 })
    t.is(sub.events.length, 150, 'all stored events arrive before EOSE')
    t.is(h.relay.connections.size, 1, 'and the relay did not treat the reader as stalled')
  })

  test(`[${id}] a frame over MAX_FRAME_BYTES closes the connection`, async (t) => {
    const h = await harness(t, id)
    const alice = identity('alice')
    const client = await member(h, alice)

    const oversized = sign(alice, { kind: 1, content: 'x'.repeat(core.LIMITS.MAX_FRAME_BYTES + 1000) })
    client.send(['EVENT', oversized])

    t.ok(await eventually(() => h.relay.connections.size === 0), 'the relay dropped the peer')
    t.is(h.store.queryEvents([{ ids: [oversized.id] }]).length, 0, 'and stored nothing')
  })

  test(`[${id}] a dropped peer is cleaned up and the same identity can reconnect`, async (t) => {
    const h = await harness(t, id)
    const alice = identity('alice')

    const first = await member(h, alice)
    await first.subscribe('s1', { kinds: [1] })
    t.is(h.relay.connections.size, 1)

    await first.destroy()
    t.ok(await eventually(() => h.relay.connections.size === 0), 'the relay noticed the drop')
    t.is(h.relay.subscriptions.size, 0, 'and removed its subscriptions')

    const second = await member(h, alice)
    t.is((await second.publish(sign(alice, { kind: 1, content: 'back' }))).accepted, true)
  })

  test(`[${id}] close() disconnects every peer`, async (t) => {
    const h = await harness(t, id)
    const client = await member(h, identity('alice'))
    t.is(h.relay.connections.size, 1)

    await h.closeTransport()

    t.ok(await eventually(() => h.relay.connections.size === 0), 'the relay has no connections left')
    t.ok(await eventually(() => client.closed), 'the client saw the link close')
  })
}

test('every registered transport has a contract fixture', (t) => {
  for (const id of serverIds) t.ok(fixtures[id], `fixture for ${id}`)
  t.alike(Object.keys(fixtures).sort(), [...serverIds].sort(), 'and no fixture is orphaned')
})

// ---------------------------------------------------------------- registry --

test('the built-in transports are registered under their schemes', (t) => {
  t.alike(transports.listTransports().map((d) => d.id), ['ws', 'swarm', 'replication', 'loopback'])

  t.is(transports.createClient('ws://127.0.0.1:1') instanceof TransportClient, true)
  t.is(transports.createClient('http://127.0.0.1:1') instanceof TransportClient, true)
  t.is(transports.createClient('hyper://' + 'ab'.repeat(32), { dht: {} }) instanceof TransportClient, true)
  t.is(transports.createClient('loopback://x') instanceof TransportClient, true)
})

test('unknown names and schemes fail with a message that lists what exists', (t) => {
  const relay = { pubkey: 'ab'.repeat(32) }

  t.exception(() => transports.createTransport('carrier-pigeon', relay), /unknown transport "carrier-pigeon" \(registered: ws, swarm, replication, loopback\)/)
  t.exception(() => transports.createClient('gopher://host'), /no client transport for gopher:\/\//)
  t.exception(() => transports.createClient('not an address'), /not a transport address/)
})

test('registering rejects duplicate ids, taken schemes and empty definitions', (t) => {
  const Server = class extends Transport {}

  t.exception(() => transports.registerTransport({ id: 'ws', schemes: ['x'], Server }), /already registered/)
  t.exception(() => transports.registerTransport({ id: 'extra', schemes: ['hyper'], Server }), /scheme hyper:\/\/ is already used by swarm/)
  t.exception(() => transports.registerTransport({ id: 'extra', schemes: [], Server, Client: class extends TransportClient {} }), /schemes must be a non-empty array when there is a Client/)
  t.exception(() => transports.registerTransport({ id: 'extra', Server }), /schemes must be an array/)
  t.exception(() => transports.registerTransport({ id: 'extra', schemes: ['extra'] }), /provide a Server, a Client, or both/)
})

test('a registered transport is reachable by name and by scheme, and can be removed', (t) => {
  class Toy extends Transport {}
  class ToyClient extends TransportClient {}

  transports.registerTransport({ id: 'toy', schemes: ['toy'], capabilities: { encrypted: true }, Server: Toy, Client: ToyClient })
  t.teardown(() => transports.unregisterTransport('toy'))

  t.is(transports.getTransport('toy').capabilities.http, false, 'missing capabilities default to false')
  t.is(transports.getTransport('toy').capabilities.encrypted, true)
  t.ok(transports.createTransport('toy', { pubkey: 'ab'.repeat(32) }) instanceof Toy)
  t.ok(transports.createClient('toy://anywhere') instanceof ToyClient)

  t.is(transports.unregisterTransport('toy'), true)
  t.exception(() => transports.getTransport('toy'), /unknown transport "toy"/)
})

test('the base classes name the method a transport forgot to implement', async (t) => {
  const relay = { pubkey: 'ab'.repeat(32) }

  t.exception(() => new Transport(relay).link, /must implement link/)
  await t.exception(() => new Transport(relay).listen(), /must implement listen/)
  await t.exception(() => new Transport(relay).close(), /must implement close/)
  await t.exception(() => new TransportClient().connect('x://y'), /must implement connect/)
  t.exception(() => new TransportClient().send('frame'), /must implement send/)
})

test('swarm: a failed dial rejects with the reason instead of hanging', async (t) => {
  const testnet = await createTestnet(3)
  t.teardown(() => testnet.destroy())

  const client = transports.createClient('hyper://' + 'cd'.repeat(32), { bootstrap: testnet.bootstrap })
  t.teardown(() => client.close())

  await t.exception(() => client.connect('hyper://' + 'cd'.repeat(32)), /PEER_NOT_FOUND|closed/i)
})

// ------------------------------------------------------------- replication --

test('replication is a registered relay-to-relay transport: no client half, no scheme', async (t) => {
  const definition = transports.getTransport('replication')
  t.alike(definition.schemes, [])
  t.is(definition.Client, null)
  t.is(definition.capabilities.encrypted, true)

  // `hyper://` stays with `swarm`, so a client dialing a feed key is not
  // handed a transport that cannot talk to it.
  t.ok(transports.createClient('hyper://' + 'ab'.repeat(32), { dht: {} }) instanceof transports.SwarmClient)
  t.exception(() => transports.createTransport('replication', { pubkey: 'ab'.repeat(32) }), /replication needs a storageDir/)

  const dir = path.join(os.tmpdir(), `hive-transport-${Date.now()}`)
  const store = openStore(':memory:')
  const relay = new Relay(store, { url: 'ws://127.0.0.1' })
  const transport = transports.createTransport('replication', relay, { storageDir: dir, topic: 'contract' })
  t.teardown(async () => {
    relay.close()
    store.close()
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  t.ok(transport instanceof Transport, 'it shares the lifecycle of the contract')
  t.is(transport.link, 'hyper://' + transport.publicKey)
  t.alike(transport.describe(), { group: 'contract', feed: transport.link }, 'describe() names the group and the feed')

  // Never started, so only the corestore it created needs closing.
  await transport.corestore.close()
})
