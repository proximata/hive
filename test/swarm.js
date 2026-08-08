'use strict'

const test = require('brittle')
const DHT = require('hyperdht')
const createTestnet = require('hyperdht/testnet')
const core = require('hive-core')

const { openStore } = require('hive-store')
const { Relay, SwarmTransport } = require('hive-relay')
const { swarmKeyPair } = require('hive-relay/lib/transports/swarm')

const { TestClient } = require('./client')
const { identity, sign, message } = require('./helpers')

// The whole point of this suite: the relay behaves identically over Hyperswarm
// and over WebSocket, because both transports feed the same protocol engine.
// Tests run against a local DHT testnet so nothing touches the public network.

async function harness (t) {
  const testnet = await createTestnet(3)
  const store = openStore(':memory:')
  const relay = new Relay(store, { url: 'ws://127.0.0.1' })
  const transport = new SwarmTransport(relay, {
    dht: new DHT({ bootstrap: testnet.bootstrap })
  })

  await transport.listen()

  const clients = []
  const connect = async () => {
    const client = await TestClient.openSwarm({
      publicKey: transport.publicKey,
      bootstrap: testnet.bootstrap
    })
    clients.push(client)
    return client
  }

  t.teardown(async () => {
    for (const client of clients) await client.destroy()
    relay.close()
    await transport.close()
    await transport.dht.destroy()
    store.close()
    await testnet.destroy()
  })

  return { store, relay, transport, connect, testnet }
}

async function member (h, who) {
  const client = await h.connect()
  await client.authenticate(who, { relayUrl: h.transport.link })
  return client
}

test('the swarm key derives deterministically from the Nostr secret', (t) => {
  const secretKey = core.generateSecretKey()

  const a = swarmKeyPair(secretKey)
  const b = swarmKeyPair(secretKey)
  t.alike(a.publicKey, b.publicKey, 'same secret, same dial address')

  const other = swarmKeyPair(core.generateSecretKey())
  t.unlike(a.publicKey, other.publicKey)

  // Hex and buffer forms of the same key must agree, since the CLI passes hex.
  t.alike(swarmKeyPair(core.toHex(secretKey)).publicKey, a.publicKey)
})

test('a peer dials the relay by key, authenticates and publishes', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  t.ok(h.transport.link.startsWith('hyper://'), 'the relay advertises a hyper link')
  t.is(h.transport.link.length, 'hyper://'.length + 64)

  const client = await h.connect()
  t.ok(client.challenge, 'NIP-42 challenge arrives over the swarm too')

  const ok = await client.authenticate(alice, { relayUrl: h.transport.link })
  t.is(ok.accepted, true, 'the Noise handshake authenticates the transport; NIP-42 the identity')

  const event = sign(alice, { kind: 1, content: 'over the DHT' })
  t.is((await client.publish(event)).accepted, true)

  const sub = await client.subscribe('s1', { kinds: [1] })
  t.alike(sub.events[0], event)
})

test('two peers exchange live events through the swarm relay', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const aliceClient = await member(h, alice)
  const bobClient = await member(h, bob)

  const create = sign(alice, {
    kind: core.KIND_NIP29_CREATE_GROUP,
    tags: [['name', 'p2p'], ['visibility', 'open']],
    content: ''
  })
  t.is((await aliceClient.publish(create)).accepted, true)
  const channelId = h.store.listChannels()[0].id

  await bobClient.publish(sign(bob, { kind: core.KIND_NIP29_JOIN_REQUEST, tags: [['h', channelId]], content: '' }))
  await bobClient.subscribe('chan', { '#h': [channelId], kinds: [core.KIND_STREAM_MESSAGE] })

  const event = message(alice, channelId, 'hello from the other side')
  await aliceClient.publish(event)

  t.alike(await bobClient.nextEvent('chan'), event)
})

test('the security boundary holds over the swarm transport as well', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const eve = identity('eve')

  const aliceClient = await member(h, alice)
  const eveClient = await member(h, eve)

  await aliceClient.publish(sign(alice, {
    kind: core.KIND_NIP29_CREATE_GROUP,
    tags: [['name', 'secret'], ['visibility', 'private']],
    content: ''
  }))
  const secret = h.store.listChannels()[0].id

  const refused = await eveClient.subscribe('probe', { '#h': [secret] })
  t.is(refused.closed, 'restricted: not a channel member')

  const global = await eveClient.subscribe('drag', { kinds: [core.KIND_STREAM_MESSAGE] })
  t.is(global.closed, null)

  await aliceClient.publish(message(alice, secret, 'private over p2p'))
  await new Promise((resolve) => setTimeout(resolve, 100))

  t.is(eveClient.messages.filter((m) => m.type === 'EVENT' && m.subId === 'drag').length, 0)
})

test('unauthenticated swarm peers are still refused', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const client = await h.connect()
  const ok = await client.publish(sign(alice, { kind: 1, content: 'no auth' }))

  t.is(ok.accepted, false)
  t.ok(ok.reason.startsWith('auth-required:'), 'transport encryption is not identity')
})

test('framing survives messages larger than one chunk', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await member(h, alice)

  // Well under MAX_FRAME_BYTES but far larger than a TCP segment, so the frame
  // reader has to reassemble across chunks.
  const big = 'x'.repeat(40000)
  const event = sign(alice, { kind: 1, content: big })

  t.is((await client.publish(event)).accepted, true)

  const sub = await client.subscribe('s1', { ids: [event.id] })
  t.is(sub.events.length, 1)
  t.is(sub.events[0].content.length, big.length, 'reassembled intact')
})

test('a dropped peer is cleaned up and can reconnect', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const first = await member(h, alice)
  await first.subscribe('s1', { kinds: [1] })
  t.is(h.relay.connections.size, 1)

  await first.destroy()
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.is(h.relay.connections.size, 0, 'the relay noticed the drop')
  t.is(h.relay.subscriptions.size, 0)

  const second = await member(h, alice)
  const event = sign(alice, { kind: 1, content: 'reconnected' })
  t.is((await second.publish(event)).accepted, true)
})
