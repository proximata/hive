'use strict'

const test = require('brittle')
const os = require('bare-os')
const fs = require('bare-fs')
const path = require('bare-path')
const b4a = require('b4a')
const createTestnet = require('hyperdht/testnet')

const { openStore } = require('hive-store')
const { Relay, WebSocketTransport, ReplicationTransport, resolveReplication } = require('hive-relay')
const { replicationKeyPair, replicationTopic } = require('hive-relay/lib/transports/replication')
const { swarmKeyPair } = require('hive-relay/lib/transports/swarm')
const { RateLimiter } = require('hive-auth')
const core = require('hive-core')

const { events } = require('hive-sdk')

const { TestClient } = require('./client')
const { identity, sign, message } = require('./helpers')

// Relay-to-relay replication: one hypercore per relay, merged through the
// ordinary ingest path. These tests run two whole relays against each other
// over a piped corestore stream, so convergence is asserted and not narrated.

let counter = 0

/** One relay with its own SQLite store and its own replication core. */
async function node (t, opts = {}) {
  const dir = path.join(os.tmpdir(), `hive-repl-${Date.now()}-${counter++}`)
  const store = openStore(':memory:')
  const relay = new Relay(store, { url: 'ws://127.0.0.1', ...opts.relay })
  const replication = new ReplicationTransport(relay, { storageDir: dir, ...opts.replication })

  await replication.listen()

  t.teardown(async () => {
    await replication.close()
    relay.close()
    store.close()
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  return { dir, store, relay, replication }
}

/**
 * Replicate two nodes over an in-process pipe.
 *
 * The stream is what a Hyperswarm connection would hand `attach()`; peer core
 * keys are derived from the replication public key either way, so this covers
 * everything except the DHT itself.
 */
function connect (a, b) {
  const s1 = a.replication.corestore.replicate(true)
  const s2 = b.replication.corestore.replicate(false)
  s1.pipe(s2).pipe(s1)

  a.replication.follow(b.replication.publicKey)
  b.replication.follow(a.replication.publicKey)

  return () => {
    s1.destroy()
    s2.destroy()
  }
}

async function waitFor (predicate, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

/** Publish straight through the ingest pipeline, as a client would. */
async function accept (n, event) {
  const result = await n.relay.ingestFromPeer(event)
  await n.replication.flush()
  return result
}

// ------------------------------------------------------------- addressing --

test('the replication identity is derived from the relay secret and is not the client-facing one', (t) => {
  const secretKey = core.generateSecretKey()

  t.alike(replicationKeyPair(secretKey).publicKey, replicationKeyPair(secretKey).publicKey, 'deterministic')
  t.alike(replicationKeyPair(core.toHex(secretKey)).publicKey, replicationKeyPair(secretKey).publicKey, 'hex and buffer agree')
  t.unlike(
    replicationKeyPair(secretKey).publicKey,
    swarmKeyPair(secretKey).publicKey,
    'replicating does not hand peers the key clients dial'
  )
  t.unlike(replicationKeyPair(secretKey).publicKey, replicationKeyPair(core.generateSecretKey()).publicKey)
})

test('a replication topic is a namespaced 32-byte hash of the group name', (t) => {
  const topic = replicationTopic('hive')
  t.is(topic.byteLength, 32)
  t.alike(topic, replicationTopic('hive'), 'deterministic')
  t.unlike(topic, replicationTopic('hive2'))
  t.unlike(topic, b4a.from(core.sha256(b4a.from('hive'))), 'namespaced, not the bare word')
})

// -------------------------------------------------------------------- off --

test('replication is off unless it is asked for', (t) => {
  t.is(resolveReplication({}, {}), null, 'no flag, no env, no replication')
  t.is(resolveReplication({}, { HIVE_REPLICATE_TOPIC: 'hive' }), 'hive')
  t.is(resolveReplication({ replicate: 'flag' }, { HIVE_REPLICATE_TOPIC: 'env' }), 'flag', 'the flag wins')
  t.exception(() => resolveReplication({ replicate: true }, {}), /--replicate requires a value/)
  t.exception(() => resolveReplication({ replicate: 'a b' }, {}), /--replicate must be a group name/)
  t.exception(() => resolveReplication({ replicate: 'x'.repeat(65) }, {}), /--replicate must be a group name/)
})

// -------------------------------------------------------------- acceptance --

test('an event posted to relay A over WebSocket reaches relay B by replication', async (t) => {
  const a = await node(t)
  const b = await node(t)

  const transport = new WebSocketTransport(a.relay, { port: 0 })
  await transport.listen()
  const client = await TestClient.openWebSocket({ port: transport.port })
  t.teardown(async () => {
    await client.destroy()
    await transport.close()
  })

  const stop = connect(a, b)
  t.teardown(stop)

  const alice = identity('alice')
  await client.authenticate(alice, { relayUrl: a.relay.url })

  const event = sign(alice, { kind: 1, content: 'posted to A' })
  const ok = await client.publish(event)
  t.is(ok.accepted, true, 'A accepted it from a client')

  t.ok(await waitFor(() => b.store.getEvent(event.id) !== null), 'B has the event')
  t.is(b.relay.connections.size, 0, 'B never had a client connection: it arrived by replication')
  t.alike(b.store.getEvent(event.id), a.store.getEvent(event.id), 'byte-identical event on both')
})

test('two relays fed the same events in opposite order converge', async (t) => {
  const a = await node(t)
  const b = await node(t)

  const alice = identity('alice')
  const bob = identity('bob')
  const events = [
    sign(alice, { kind: 1, created_at: 1700000001, content: 'one' }),
    sign(bob, { kind: 1, created_at: 1700000002, content: 'two' }),
    sign(alice, { kind: 1, created_at: 1700000003, content: 'three' })
  ]

  // Same events, opposite arrival order, and each relay only ever sees its own
  // half as a local accept — the rest has to arrive by replication.
  for (const event of events) await accept(a, event)
  for (const event of [...events].reverse()) await accept(b, event)

  const stop = connect(a, b)
  t.teardown(stop)

  const ids = events.map((event) => event.id).sort()
  const converged = () => {
    const from = (n) => n.store.queryEvents([{ kinds: [1] }]).map((s) => s.event.id).sort()
    return from(a).join() === ids.join() && from(b).join() === ids.join()
  }
  t.ok(await waitFor(converged), 'both relays hold exactly the same set')

  t.alike(
    a.store.queryEvents([{ kinds: [1] }]).map((s) => s.event),
    b.store.queryEvents([{ kinds: [1] }]).map((s) => s.event),
    'identical query results, in identical order'
  )
})

test('a replaceable event converges on the same winner whichever way it arrives', async (t) => {
  const a = await node(t)
  const b = await node(t)

  const alice = identity('alice')
  // A replaceable kind (10000-19999), where the store keeps exactly one
  // version per author and picks it by created_at with an id tiebreak.
  const kind = core.KIND_BOOKMARK_LIST
  const older = sign(alice, { kind, created_at: 1700000001, content: 'old' })
  const newer = sign(alice, { kind, created_at: 1700000002, content: 'new' })

  await accept(a, older)
  await accept(a, newer)
  await accept(b, newer)
  await accept(b, older)

  const stop = connect(a, b)
  t.teardown(stop)

  const winner = (n) => n.store.queryEvents([{ kinds: [kind], authors: [alice.pubkey] }]).map((s) => s.event.id)
  t.ok(await waitFor(() => winner(a).join() === newer.id && winner(b).join() === newer.id), 'created_at decides, not arrival')
})

test('re-replicating a full history inserts no duplicates and does not grow the store', async (t) => {
  const a = await node(t)
  const b = await node(t)

  const alice = identity('alice')
  const events = []
  for (let i = 0; i < 12; i++) events.push(sign(alice, { kind: 1, created_at: 1700000000 + i, content: 'e' + i }))
  for (const event of events) await accept(a, event)

  const stop = connect(a, b)
  const count = () => b.store.queryEvents([{ kinds: [1] }]).length
  t.ok(await waitFor(() => count() === events.length), 'B caught up')

  const before = count()
  const ingestedBefore = b.replication.stats.ingested

  // Drop the peer and read its whole feed again from block 0, which is exactly
  // what a restart or a reconnect does.
  stop()
  b.replication.peers.delete(a.replication.publicKey)
  const stop2 = connect(a, b)
  t.teardown(stop2)

  t.ok(await waitFor(() => b.replication.stats.duplicates >= events.length), 'every block was re-seen')
  t.is(count(), before, 'not one extra row')
  t.is(b.replication.stats.ingested, ingestedBefore, 'no second insert')
  t.is(a.replication.local.length, events.length, "and A's core did not grow either")
})

test('an id we already hold is answered before the signature is checked, and still cannot overwrite it', async (t) => {
  const b = await node(t)

  const alice = identity('alice')
  const original = sign(alice, { kind: 1, content: 'the real one' })
  t.is((await accept(b, original)).accepted, true)

  // Same id, different bytes: what an attacker would send to overwrite a
  // stored event through the cheap path. Counted as a duplicate and discarded;
  // the store is not touched, which is why skipping verification here is safe.
  const impostor = { ...original, content: 'swapped after the fact' }
  const duplicatesBefore = b.replication.stats.duplicates
  await b.replication._ingest(b4a.from(JSON.stringify(impostor)), 'peer')

  t.is(b.replication.stats.duplicates, duplicatesBefore + 1, 'recognised without verifying')
  t.is(b.replication.stats.ingested, 0, 'and nothing was inserted')
  t.is(b.store.getEvent(original.id).content, 'the real one', 'the stored event is untouched')
})

// ------------------------------------------------------------------- caps --

test('the per-pubkey client limiter does not throttle a replicated backlog', async (t) => {
  // 'human' is 30 events/minute with a burst of 60: a client publishing this
  // many would be cut off, and a peer replaying history must not be, or the
  // two stores stay divergent forever.
  const a = await node(t, { relay: { rateLimiter: new RateLimiter({ tier: 'human' }) } })
  const b = await node(t, { relay: { rateLimiter: new RateLimiter({ tier: 'human' }) } })

  const alice = identity('alice')
  const events = []
  for (let i = 0; i < 80; i++) events.push(sign(alice, { kind: 1, created_at: 1700000000 + i, content: 'burst ' + i }))

  // Straight onto A's core, bypassing A's own limiter, which is precisely the
  // situation relay B inherits: a peer's volume is not a peer's signature.
  for (const event of events) await a.replication._append(event)
  await a.replication.flush()

  const stop = connect(a, b)
  t.teardown(stop)

  t.ok(await waitFor(() => b.store.queryEvents([{ kinds: [1] }]).length === events.length), 'all 80 stored')
})

test('replication ingest is capped per feed, and paces rather than dropping', async (t) => {
  const a = await node(t)
  const b = await node(t, { replication: { maxEventsPerSecond: 20 } })

  const alice = identity('alice')
  const events = []
  for (let i = 0; i < 30; i++) events.push(sign(alice, { kind: 1, created_at: 1700000000 + i, content: 'paced ' + i }))
  for (const event of events) await a.replication._append(event)
  await a.replication.flush()

  const started = Date.now()
  const stop = connect(a, b)
  t.teardown(stop)

  t.ok(await waitFor(() => b.store.queryEvents([{ kinds: [1] }]).length === events.length), 'nothing was dropped')
  // 30 events, a 20-token bucket refilling at 20/s: the last 10 cost ~500ms.
  t.ok(Date.now() - started > 300, 'and the feed was slowed down rather than let through at once')
  t.is(b.replication.stats.rejected, 0)
})

// ------------------------------------------------------------ what is fed --

test('a relay appends what it accepted and never re-publishes a peer event', async (t) => {
  const a = await node(t)
  const b = await node(t)

  const alice = identity('alice')
  const event = sign(alice, { kind: 1, content: 'one hop only' })
  await accept(a, event)

  const stop = connect(a, b)
  t.teardown(stop)

  t.ok(await waitFor(() => b.store.getEvent(event.id) !== null), 'B stored it')
  await b.replication.flush()
  t.is(b.replication.local.length, 0, "B's own core carries only what B accepted from a client")
  t.is(a.replication.local.length, 1)
})

test('ephemeral events are never written to the feed', async (t) => {
  const a = await node(t)
  const alice = identity('alice')

  await accept(a, sign(alice, { kind: core.KIND_PRESENCE_UPDATE, content: 'online' }))
  await a.replication.flush()
  t.is(a.replication.local.length, 0, 'nothing to replicate: it was never stored')
})

test('a peer feed is trusted for bytes and nothing else', async (t) => {
  const a = await node(t)
  const b = await node(t)

  const alice = identity('alice')
  const forged = sign(alice, { kind: 1, content: 'signed' })
  forged.content = 'tampered after signing'

  // Straight onto the wire, past A's own validation, which is what a hostile or
  // simply buggy peer would do.
  await a.replication.local.append(b4a.from(JSON.stringify(forged)))
  await a.replication.local.append(b4a.from('not json at all'))
  const good = sign(alice, { kind: 1, content: 'genuine' })
  await a.replication.local.append(b4a.from(JSON.stringify(good)))

  const stop = connect(a, b)
  t.teardown(stop)

  t.ok(await waitFor(() => b.store.getEvent(good.id) !== null), 'the valid event still lands')
  t.is(b.store.getEvent(forged.id), null, 'the tampered one is rejected by B, not trusted from A')
  t.is(b.replication.stats.rejected, 2, 'one bad signature, one unparseable block')
})

// ------------------------------------------------- the product's own path --

test('a channel created through the SDK gets the SAME id on both relays, so its messages replicate', async (t) => {
  const a = await node(t)
  const b = await node(t)
  const stop = connect(a, b)
  t.teardown(stop)

  const alice = identity('alice')

  // `events.createChannel` sends NO h tag (hive-sdk index.js), which is what
  // the CLI and the web client both use. The relay therefore mints the id in
  // `apply`, and it must mint it from the event rather than at random: a
  // random one forks, and every later message is 'unknown channel' on the peer.
  const create = events.createChannel(alice.secretKeyHex, { name: 'general' })
  await accept(a, create)

  t.ok(await waitFor(() => b.store.getEvent(create.id) !== null), 'B applied the create')
  const channelId = a.store.listChannels()[0].id
  t.is(b.store.listChannels()[0].id, channelId, 'one signed create event, one channel id')

  const msg = message(alice, channelId, 'hello everyone')
  t.is((await accept(a, msg)).accepted, true, 'A accepted the message')

  t.ok(await waitFor(() => b.store.getEvent(msg.id) !== null), 'and B stored it in the same channel')
  t.is(b.replication.stats.rejected, 0, 'nothing was rejected as an unknown channel')
})

test('a relay-signed kind does NOT cross: a peer relay is not this relay', async (t) => {
  // Named because the transport's own header calls the event set a commutative
  // CRDT, and this is the documented hole in that: relay-signed kinds carry the
  // ORIGIN relay's pubkey, and `_validateIngest` rejects any of them not signed
  // by the relay doing the ingesting. Membership notifications, group metadata,
  // system messages and thread summaries stay local by construction.
  const a = await node(t)
  const b = await node(t)
  const stop = connect(a, b)
  t.teardown(stop)

  const system = a.relay.signAsRelay({
    kind: core.KIND_SYSTEM_MESSAGE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: 'system'
  })
  t.is((await accept(a, system)).accepted, true, 'A accepts what A signed')

  t.ok(await waitFor(() => b.replication.stats.rejected === 1), 'B rejected it')
  t.is(b.store.getEvent(system.id), null, 'a peer cannot make this relay speak in its own name')
})

// ------------------------------------------------------------------ swarm --

test('two relays find each other on a shared topic and replicate over the swarm', async (t) => {
  // The production path, on a private DHT testnet: no key exchange happens
  // here, the peer's core key IS its swarm public key.
  const testnet = await createTestnet(3)
  t.teardown(() => testnet.destroy())

  const opts = { replication: { topic: 'hive-test-' + Date.now(), bootstrap: testnet.bootstrap } }
  const a = await node(t, opts)
  const b = await node(t, opts)

  const alice = identity('alice')
  const event = sign(alice, { kind: 1, content: 'over the topic' })
  await accept(a, event)

  t.ok(await waitFor(() => b.store.getEvent(event.id) !== null, 30000), 'B replicated it without being told A existed')
})

test('an event dated far in the future is rejected on ingest, as it is on the client path', async (t) => {
  const a = await node(t)
  const b = await node(t)

  const alice = identity('alice')
  const future = sign(alice, { kind: 1, created_at: Math.floor(Date.now() / 1000) + 86400, content: 'sticky' })
  await a.replication.local.append(b4a.from(JSON.stringify(future)))

  const stop = connect(a, b)
  t.teardown(stop)

  t.ok(await waitFor(() => b.replication.stats.rejected === 1), 'B applied its own ingest rules')
  t.is(b.store.getEvent(future.id), null)
})
