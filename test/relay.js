'use strict'

const test = require('brittle')
const core = require('hive-core')

const { openStore } = require('hive-store')
const { Relay, WebSocketTransport, resolveBind, MAX_FILTERS_PER_REQ, MAX_CREATED_AT_DRIFT_S } = require('hive-relay')
const { MAX_PUT_USER_TARGETS } = require('hive-relay').handlers
const { buildAuthEvent, buildNip98Header } = require('hive-auth')

const { TestClient } = require('./client')
const { request } = require('./http')
const { identity, sign, message } = require('./helpers')

/** Boot a relay on an ephemeral port and tear it all down afterwards. */
async function harness (t, opts = {}) {
  const store = openStore(':memory:')
  const relay = new Relay(store, { url: 'ws://127.0.0.1', ...opts })
  const transport = new WebSocketTransport(relay, { port: 0 })

  await transport.listen()

  const clients = []
  const connect = async () => {
    const client = await TestClient.openWebSocket({ port: transport.port })
    clients.push(client)
    return client
  }

  t.teardown(async () => {
    for (const client of clients) await client.destroy()
    relay.close()
    await transport.close()
    store.close()
  })

  return { store, relay, transport, connect, port: transport.port }
}

/** Connect, authenticate, and return the client. */
async function member (h, who) {
  const client = await h.connect()
  await client.authenticate(who, { relayUrl: h.relay.url })
  return client
}

/** Create a channel through the protocol, returning its id. */
async function makeChannel (h, owner, client, tags = [['name', 'general']]) {
  const event = sign(owner, { kind: core.KIND_NIP29_CREATE_GROUP, tags, content: '' })
  const ok = await client.publish(event)
  if (!ok.accepted) throw new Error('channel creation rejected: ' + ok.reason)

  const channels = h.store.listChannels()
  return channels[channels.length - 1].id
}

// -------------------------------------------------------------------- auth --

test('relay challenges immediately and accepts a valid NIP-42 response', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const client = await h.connect()
  t.ok(client.challenge, 'challenge arrives without being asked for')
  t.is(client.challenge.length, 48, '24 random bytes as hex')

  const ok = await client.authenticate(alice, { relayUrl: h.relay.url })
  t.is(ok.accepted, true)
})

test('unauthenticated clients cannot publish or subscribe', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const client = await h.connect()

  const ok = await client.publish(sign(alice, { kind: 1, content: 'hi' }))
  t.is(ok.accepted, false)
  t.ok(ok.reason.startsWith('auth-required:'))

  const sub = await client.subscribe('s1', { kinds: [1] })
  t.ok(sub.closed.startsWith('auth-required:'))
})

test('auth rejects a wrong challenge, a stale timestamp and a bad signature', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const wrongChallenge = await h.connect()
  const forged = buildAuthEvent({
    challenge: 'not-the-challenge',
    relayUrl: h.relay.url,
    secretKey: alice.secretKey
  })
  wrongChallenge.send(['AUTH', forged])
  let ok = await wrongChallenge.waitFor((m) => m.type === 'OK')
  t.ok(ok.reason.includes('challenge mismatch'))

  const stale = await h.connect()
  const old = buildAuthEvent({
    challenge: stale.challenge,
    relayUrl: h.relay.url,
    secretKey: alice.secretKey,
    created_at: Math.floor(Date.now() / 1000) - 3600
  })
  stale.send(['AUTH', old])
  ok = await stale.waitFor((m) => m.type === 'OK')
  t.ok(ok.reason.includes('out of tolerance'))

  const tampered = await h.connect()
  const event = buildAuthEvent({
    challenge: tampered.challenge,
    relayUrl: h.relay.url,
    secretKey: alice.secretKey
  })
  tampered.send(['AUTH', { ...event, sig: 'f'.repeat(128) }])
  ok = await tampered.waitFor((m) => m.type === 'OK')
  t.is(ok.accepted, false)
  t.ok(ok.reason.includes('signature'))
})

test('you may only publish as yourself', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const client = await member(h, alice)
  const ok = await client.publish(sign(bob, { kind: 1, content: 'impersonation' }))

  t.is(ok.accepted, false)
  t.ok(ok.reason.includes('does not match the authenticated pubkey'))
})

// ---------------------------------------------------------------- pipeline --

test('publish, then read back through a subscription', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const client = await member(h, alice)
  const event = sign(alice, { kind: 1, content: 'hello world' })

  const ok = await client.publish(event)
  t.is(ok.accepted, true)
  t.is(ok.reason, '')

  const sub = await client.subscribe('s1', { kinds: [1] })
  t.is(sub.events.length, 1)
  t.alike(sub.events[0], event)
})

test('a resubmitted event is accepted as a duplicate', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const client = await member(h, alice)
  const event = sign(alice, { kind: 1, content: 'once' })

  t.is((await client.publish(event)).accepted, true)

  const second = await client.publish(event)
  t.is(second.accepted, true, 'idempotent, not an error')
  t.is(second.reason, 'duplicate:')
})

test('malformed events and frames are rejected without killing the connection', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const client = await member(h, alice)
  const event = sign(alice, { kind: 1, content: 'valid' })

  const ok = await client.publish({ ...event, content: 'tampered' })
  t.is(ok.accepted, false)
  t.ok(ok.reason.startsWith('invalid:'))

  client._send('not json at all')
  const notice = await client.waitFor((m) => m.type === 'NOTICE')
  t.ok(notice.message.includes('not valid JSON'))

  // The connection still works.
  t.is((await client.publish(event)).accepted, true)
})

test('auth events are never stored', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const client = await member(h, alice)
  const authEvent = buildAuthEvent({ challenge: 'x', relayUrl: h.relay.url, secretKey: alice.secretKey })

  const ok = await client.publish(authEvent)
  t.is(ok.accepted, false)
  t.is(h.store.queryEvents([{ kinds: [core.KIND_AUTH] }]).length, 0)
})

test('live events reach existing subscribers', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const listener = await member(h, bob)
  const publisher = await member(h, alice)

  const sub = await listener.subscribe('live', { kinds: [1] })
  t.is(sub.events.length, 0)

  const event = sign(alice, { kind: 1, content: 'broadcast' })
  await publisher.publish(event)

  t.alike(await listener.nextEvent('live'), event)
})

test('CLOSE stops delivery', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const client = await member(h, alice)
  await client.subscribe('temp', { kinds: [1] })
  client.close('temp')

  // Give the CLOSE a moment to be processed before publishing.
  await new Promise((resolve) => setTimeout(resolve, 50))
  await client.publish(sign(alice, { kind: 1, content: 'after close' }))
  await new Promise((resolve) => setTimeout(resolve, 50))

  const delivered = client.messages.filter((m) => m.type === 'EVENT' && m.subId === 'temp')
  t.is(delivered.length, 0)
  t.is(h.relay.subscriptions.count(h.relay.connections.keys().next().value), 0)
})

test('EOSE arrives after the historical batch, in order', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const client = await member(h, alice)
  for (let i = 0; i < 3; i++) {
    await client.publish(sign(alice, { kind: 1, created_at: 1000 + i, content: `m${i}` }))
  }

  const before = client.messages.length
  client.send(['REQ', 'hist', { kinds: [1] }])
  await client.waitFor((m) => m.type === 'EOSE' && m.subId === 'hist')

  const sequence = client.messages.slice(before).map((m) => m.type)
  t.alike(sequence, ['EVENT', 'EVENT', 'EVENT', 'EOSE'], 'every stored event precedes EOSE')
})

// ------------------------------------------------------------------- COUNT --

test('COUNT returns the number of authorized matches', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const client = await member(h, alice)
  for (let i = 0; i < 4; i++) {
    await client.publish(sign(alice, { kind: 1, created_at: 1000 + i, content: `m${i}` }))
  }

  t.is((await client.count('c1', { kinds: [1] })).count, 4)
  t.is((await client.count('c2', { kinds: [99] })).count, 0)
})

// -------------------------------------------------------------- protocol --

test('protocol errors produce NOTICEs, not crashes', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await member(h, alice)

  const cases = [
    [['REQ'], 'subscription id'],
    [['REQ', 'x'], 'at least one filter'],
    [['NONSENSE', {}], 'unknown message type'],
    [['EVENT'], 'requires an event object'],
    [['CLOSE'], 'requires a subscription id']
  ]

  for (const [frame, expected] of cases) {
    client.send(frame)
    const notice = await client.waitFor((m) => m.type === 'NOTICE')
    t.ok(notice.message.includes(expected), `${JSON.stringify(frame)} → ${notice.message}`)
  }

  // And the connection is still usable.
  t.is((await client.publish(sign(alice, { kind: 1, content: 'still here' }))).accepted, true)
})

test('oversized frames are refused', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await member(h, alice)

  client._send(JSON.stringify(['EVENT', { content: 'x'.repeat(core.LIMITS.MAX_FRAME_BYTES + 100) }]))
  const notice = await client.waitFor((m) => m.type === 'NOTICE')
  t.ok(notice.message.includes('too large') || notice.message.includes('exceeds'))
})

// ---------------------------------------------------------------- NIP-11 --

test('NIP-11 relay info is served over HTTP', async (t) => {
  const h = await harness(t)

  const response = await request(`http://127.0.0.1:${h.port}/info`)
  t.is(response.status, 200)

  const info = response.json
  t.is(info.name, 'hive')
  t.is(info.pubkey, h.relay.pubkey)
  t.ok(info.supported_nips.includes(29), 'advertises NIP-29')
  t.ok(info.supported_nips.includes(42), 'advertises NIP-42')
  t.is(info.limitation.max_message_length, core.LIMITS.MAX_FRAME_BYTES)
  t.is(info.limitation.auth_required, true)
})

test('health and readiness probes answer', async (t) => {
  const h = await harness(t)

  for (const path of ['/health', '/_liveness', '/_readiness']) {
    const response = await request(`http://127.0.0.1:${h.port}${path}`)
    t.is(response.status, 200, path)
  }
})

test('readiness reports the store, not a flag', async (t) => {
  const h = await harness(t)

  const before = await request(`http://127.0.0.1:${h.port}/health`)
  t.is(before.status, 200)
  t.is(before.json.store, 'ok')

  // Kill the database out from under the store without going through close(),
  // which is what a probe reading `store.closed` cannot see. The old probe
  // answered 200 here while every real request threw DATABASE_NOT_OPEN.
  h.store.db.close()

  const after = await request(`http://127.0.0.1:${h.port}/health`)
  t.is(after.status, 503, 'a dead database is not healthy')
  t.is(after.json.store, 'unavailable')
  t.absent(JSON.stringify(after.json).includes('DATABASE_NOT_OPEN'), 'no driver detail on an unauthenticated probe')

  // Liveness is a different question and still answers: the process is up.
  const live = await request(`http://127.0.0.1:${h.port}/_liveness`)
  t.is(live.status, 200, 'liveness is about the process, not the store')

  // The handle is gone, so tell the store's own close() to skip it; the shared
  // teardown would otherwise throw DATABASE_NOT_OPEN closing it twice.
  h.store.closed = true
})

// ------------------------------------------------------------- bind host --

// The regression this guards: a relay that binds 0.0.0.0 by default puts a
// write endpoint on every dev's LAN, silently, with nothing on screen to say
// so. Assert the default at both levels — the flag resolver bin.mjs calls, and
// the socket the transport actually opens.

test('the default bind is loopback and only --host widens it', (t) => {
  const bare = resolveBind({}, {})
  t.is(bare.host, '127.0.0.1', 'no flags, no env: loopback')
  t.is(bare.port, 3000)
  t.is(bare.publicUrl, null)
  t.ok(bare.loopback)

  // No other flag may widen it as a side effect.
  const noisy = resolveBind({ port: '8080', storage: '/tmp/x', swarm: false, updates: false, publicUrl: 'https://hive.example.com' }, {})
  t.is(noisy.host, '127.0.0.1', 'unrelated flags do not change the bind address')
  t.is(noisy.port, 8080)
  t.is(noisy.publicUrl, 'wss://hive.example.com', 'https becomes wss; relay.url is ws-shaped')

  // Env is a lever too, so it gets the same scrutiny; the flag still wins.
  t.is(resolveBind({}, { HIVE_RELAY_HOST: '0.0.0.0' }).host, '0.0.0.0')
  t.is(resolveBind({}, { HIVE_RELAY_HOST: '0.0.0.0' }).loopback, false)
  t.is(resolveBind({ host: '127.0.0.1' }, { HIVE_RELAY_HOST: '0.0.0.0' }).host, '127.0.0.1', 'flag beats env')

  const open = resolveBind({ host: '0.0.0.0' }, {})
  t.is(open.host, '0.0.0.0', 'explicit --host is honoured')
  t.absent(open.loopback, 'and is reported as not loopback, so bin.mjs can say so')

  // Malformed input fails fast rather than falling back to a default: a typo
  // becoming 0.0.0.0 is the exact accident this module exists to prevent.
  t.exception(() => resolveBind({ host: true }, {}), /--host requires a value/)
  t.exception(() => resolveBind({ host: 'a b' }, {}), /--host must be an address/)
  t.exception(() => resolveBind({ port: 'http' }, {}), /--port must be an integer/)
  t.exception(() => resolveBind({ port: '70000' }, {}), /--port must be an integer/)
  t.exception(() => resolveBind({ publicUrl: 'hive.example.com' }, {}), /--public-url must be an absolute URL/)
  t.exception(() => resolveBind({ publicUrl: 'https://h/prefix' }, {}), /--public-url must be an origin/)

  // --port 0 means "pick one", which the old `Number(flags.port) || 3000`
  // turned into 3000. The tests below depend on 0 meaning 0.
  t.is(resolveBind({ port: '0' }, {}).port, 0)
})

test('the transport opens a loopback socket when no host is given', async (t) => {
  const h = await harness(t)

  const address = h.transport.address()
  t.is(address.address, '127.0.0.1', 'listening socket is loopback, not 0.0.0.0')
  t.is(h.transport.host, '127.0.0.1')
  t.is(h.relay.url, `ws://127.0.0.1:${h.port}`, 'relay.url follows the bind address')
})

test('--public-url becomes relay.url so NIP-98 verifies behind a proxy', async (t) => {
  const store = openStore(':memory:')
  const relay = new Relay(store, { url: 'ws://127.0.0.1' })
  const transport = new WebSocketTransport(relay, { port: 0, publicUrl: 'wss://hive.example.com' })
  t.teardown(async () => {
    relay.close()
    await transport.close()
    store.close()
  })

  await transport.listen()
  t.is(transport.address().address, '127.0.0.1', 'a public URL does not widen the bind address')
  t.is(relay.url, 'wss://hive.example.com', 'clients sign against the origin they reached')

  // rest.js resolves request URLs against this, and NIP-98 compares the result
  // to the signed `u` tag character for character.
  t.is(relay.url.replace(/^ws/, 'http'), 'https://hive.example.com')
})

test('stubbed surfaces answer 501, not 404', async (t) => {
  const h = await harness(t)

  for (const path of ['/git/owner/repo/info/refs', '/huddle/abc/audio']) {
    const response = await request(`http://127.0.0.1:${h.port}${path}`)
    t.is(response.status, 501, path)
    t.is(response.json.error, 'not_implemented')
  }
})

// ---------------------------------------------------------------- channels --

test('creating a channel emits discovery events and makes the creator owner', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await member(h, alice)

  const channelId = await makeChannel(h, alice, client, [
    ['name', 'engineering'],
    ['visibility', 'open']
  ])

  const channel = h.store.getChannel(channelId)
  t.is(channel.name, 'engineering')
  t.is(h.store.getMember(channelId, alice.pubkey).role, 'owner')

  const metadata = h.store.queryEvents([{ kinds: [core.KIND_NIP29_GROUP_METADATA], '#d': [channelId] }])
  t.is(metadata.length, 1)
  t.is(metadata[0].event.pubkey, h.relay.pubkey, 'discovery events are relay-signed')
  t.is(core.tagValue(metadata[0].event, 'name'), 'engineering')
  t.ok(core.hasTag(metadata[0].event, 'closed'), 'closed is always emitted per NIP-29')

  const members = h.store.queryEvents([{ kinds: [core.KIND_NIP29_GROUP_MEMBERS], '#d': [channelId] }])
  t.alike(core.referencedPubkeys(members[0].event), [alice.pubkey])
})

test('channel creation validates its tags', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await member(h, alice)

  const cases = [
    [[], 'requires a name tag'],
    [[['name', 'x'], ['visibility', 'sideways']], 'visibility must be'],
    [[['name', 'x'], ['channel_type', 'telepathy']], 'unknown channel_type']
  ]

  for (const [tags, expected] of cases) {
    const ok = await client.publish(sign(alice, { kind: core.KIND_NIP29_CREATE_GROUP, tags, content: '' }))
    t.is(ok.accepted, false)
    t.ok(ok.reason.includes(expected), ok.reason)
  }

  t.is(h.store.listChannels().length, 0, 'no channel was created by a rejected command')
})

test('messages require an h tag naming a real channel', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await member(h, alice)

  const noTag = await client.publish(sign(alice, { kind: core.KIND_STREAM_MESSAGE, content: 'lost' }))
  t.is(noTag.accepted, false)
  t.ok(noTag.reason.includes('must include an h tag'))

  const unknown = await client.publish(message(alice, 'no-such-channel', 'lost'))
  t.is(unknown.accepted, false)
  t.ok(unknown.reason.includes('unknown channel'))
})

test('join request works on open channels and is refused on private ones', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const aliceClient = await member(h, alice)
  const bobClient = await member(h, bob)

  const open = await makeChannel(h, alice, aliceClient, [['name', 'open'], ['visibility', 'open']])
  const secret = await makeChannel(h, alice, aliceClient, [['name', 'secret'], ['visibility', 'private']])

  const joined = await bobClient.publish(
    sign(bob, { kind: core.KIND_NIP29_JOIN_REQUEST, tags: [['h', open]], content: '' })
  )
  t.is(joined.accepted, true)
  t.is(h.store.isMember(open, bob.pubkey), true)

  const refused = await bobClient.publish(
    sign(bob, { kind: core.KIND_NIP29_JOIN_REQUEST, tags: [['h', secret]], content: '' })
  )
  t.is(refused.accepted, false)
  t.ok(refused.reason.includes('does not accept join requests'))
  t.is(h.store.isMember(secret, bob.pubkey), false)
})

test('the authorization matrix for membership changes', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')
  const carol = identity('carol')

  const aliceClient = await member(h, alice)
  const bobClient = await member(h, bob)

  const chan = await makeChannel(h, alice, aliceClient, [['name', 'team'], ['visibility', 'private']])

  // A non-member cannot add anyone to a private channel.
  let ok = await bobClient.publish(
    sign(bob, { kind: core.KIND_NIP29_PUT_USER, tags: [['h', chan], ['p', carol.pubkey]], content: '' })
  )
  t.is(ok.accepted, false)
  t.ok(ok.reason.includes('owners and admins'))

  // The owner can.
  ok = await aliceClient.publish(
    sign(alice, { kind: core.KIND_NIP29_PUT_USER, tags: [['h', chan], ['p', bob.pubkey]], content: '' })
  )
  t.is(ok.accepted, true)
  t.is(h.store.getMember(chan, bob.pubkey).role, 'member')

  // A plain member still cannot add others to a private channel.
  ok = await bobClient.publish(
    sign(bob, { kind: core.KIND_NIP29_PUT_USER, tags: [['h', chan], ['p', carol.pubkey]], content: '' })
  )
  t.is(ok.accepted, false)

  // But a member may remove themselves.
  ok = await bobClient.publish(
    sign(bob, { kind: core.KIND_NIP29_REMOVE_USER, tags: [['h', chan], ['p', bob.pubkey]], content: '' })
  )
  t.is(ok.accepted, true)
  t.is(h.store.isMember(chan, bob.pubkey), false)
})

test('the last owner cannot be removed or leave', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await member(h, alice)
  const chan = await makeChannel(h, alice, client)

  const removed = await client.publish(
    sign(alice, { kind: core.KIND_NIP29_REMOVE_USER, tags: [['h', chan], ['p', alice.pubkey]], content: '' })
  )
  t.is(removed.accepted, false)
  t.ok(removed.reason.includes('last owner'))

  const left = await client.publish(
    sign(alice, { kind: core.KIND_NIP29_LEAVE_REQUEST, tags: [['h', chan]], content: '' })
  )
  t.is(left.accepted, false)
  t.ok(left.reason.includes('last owner'))
  t.is(h.store.isMember(chan, alice.pubkey), true)
})

test('metadata edits split governance from day-to-day fields', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const aliceClient = await member(h, alice)
  const bobClient = await member(h, bob)

  const chan = await makeChannel(h, alice, aliceClient, [['name', 'team'], ['visibility', 'open']])
  await bobClient.publish(sign(bob, { kind: core.KIND_NIP29_JOIN_REQUEST, tags: [['h', chan]], content: '' }))

  // Any member may set the topic.
  let ok = await bobClient.publish(
    sign(bob, { kind: core.KIND_NIP29_EDIT_METADATA, tags: [['h', chan], ['topic', 'shipping v2']], content: '' })
  )
  t.is(ok.accepted, true)
  t.is(h.store.getChannel(chan).topic, 'shipping v2')

  // Renaming the channel takes admin.
  ok = await bobClient.publish(
    sign(bob, { kind: core.KIND_NIP29_EDIT_METADATA, tags: [['h', chan], ['name', 'hijacked']], content: '' })
  )
  t.is(ok.accepted, false)
  t.ok(ok.reason.includes('owners and admins'))
  t.is(h.store.getChannel(chan).name, 'team')

  ok = await aliceClient.publish(
    sign(alice, { kind: core.KIND_NIP29_EDIT_METADATA, tags: [['h', chan], ['name', 'platform']], content: '' })
  )
  t.is(ok.accepted, true)
  t.is(h.store.getChannel(chan).name, 'platform')
})

test('only the owner may delete a channel', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const aliceClient = await member(h, alice)
  const bobClient = await member(h, bob)
  const chan = await makeChannel(h, alice, aliceClient, [['name', 'temp'], ['visibility', 'open']])
  await bobClient.publish(sign(bob, { kind: core.KIND_NIP29_JOIN_REQUEST, tags: [['h', chan]], content: '' }))

  let ok = await bobClient.publish(sign(bob, { kind: core.KIND_NIP29_DELETE_GROUP, tags: [['h', chan]], content: '' }))
  t.is(ok.accepted, false)
  t.ok(h.store.getChannel(chan) !== null)

  ok = await aliceClient.publish(sign(alice, { kind: core.KIND_NIP29_DELETE_GROUP, tags: [['h', chan]], content: '' }))
  t.is(ok.accepted, true)
  t.is(h.store.getChannel(chan), null)
})

// --------------------------------------------------- the security boundary --

test('a global subscription never receives private channel events', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const eve = identity('eve')

  const aliceClient = await member(h, alice)
  const eveClient = await member(h, eve)

  const secret = await makeChannel(h, alice, aliceClient, [['name', 'secret'], ['visibility', 'private']])

  // Eve subscribes to every kind-9 message on the relay, with no channel scope.
  const sub = await eveClient.subscribe('drag', { kinds: [core.KIND_STREAM_MESSAGE] })
  t.is(sub.closed, null, 'the subscription itself is allowed')
  t.is(sub.events.length, 0)

  await aliceClient.publish(message(alice, secret, 'the launch code is 1234'))
  await new Promise((resolve) => setTimeout(resolve, 100))

  const leaked = eveClient.messages.filter((m) => m.type === 'EVENT' && m.subId === 'drag')
  t.is(leaked.length, 0, 'channel events are structurally excluded from global fan-out')

  // And the history is not readable either.
  const history = await eveClient.subscribe('drag2', { kinds: [core.KIND_STREAM_MESSAGE] })
  t.is(history.events.length, 0)
})

test('subscribing to a private channel you are not in is refused', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const eve = identity('eve')

  const aliceClient = await member(h, alice)
  const eveClient = await member(h, eve)

  const secret = await makeChannel(h, alice, aliceClient, [['name', 'secret'], ['visibility', 'private']])

  const sub = await eveClient.subscribe('probe', { '#h': [secret] })
  t.is(sub.closed, 'restricted: not a channel member')
  t.is(h.relay.subscriptions.size, 0, 'and nothing was registered before the check')
})

test('members do receive their private channel events', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const aliceClient = await member(h, alice)
  const bobClient = await member(h, bob)

  const chan = await makeChannel(h, alice, aliceClient, [['name', 'secret'], ['visibility', 'private']])
  await aliceClient.publish(
    sign(alice, { kind: core.KIND_NIP29_PUT_USER, tags: [['h', chan], ['p', bob.pubkey]], content: '' })
  )

  const sub = await bobClient.subscribe('mine', { '#h': [chan], kinds: [core.KIND_STREAM_MESSAGE] })
  t.is(sub.closed, null)

  const event = message(alice, chan, 'members only')
  await aliceClient.publish(event)

  t.alike(await bobClient.nextEvent('mine'), event)
})

test('p-gated kinds require a self-only #p filter', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const client = await member(h, alice)

  const noFilter = await client.subscribe('dm1', { kinds: [core.KIND_GIFT_WRAP] })
  t.is(noFilter.closed, 'restricted: p-gated events require #p matching your pubkey')

  const someoneElse = await client.subscribe('dm2', { kinds: [core.KIND_GIFT_WRAP], '#p': [bob.pubkey] })
  t.is(someoneElse.closed, 'restricted: p-gated events require #p matching your pubkey')

  const kindless = await client.subscribe('dm3', { authors: [bob.pubkey] })
  t.is(kindless.closed, 'restricted: p-gated events require #p matching your pubkey',
    'a kindless filter can match gated kinds, so it needs the same proof')

  const mine = await client.subscribe('dm4', { kinds: [core.KIND_GIFT_WRAP], '#p': [alice.pubkey] })
  t.is(mine.closed, null)
})

test('a channel-scoped kindless subscription is allowed but still leaks nothing', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const aliceClient = await member(h, alice)
  const bobClient = await member(h, bob)

  const chan = await makeChannel(h, alice, aliceClient, [['name', 'team'], ['visibility', 'open']])
  await bobClient.publish(sign(bob, { kind: core.KIND_NIP29_JOIN_REQUEST, tags: [['h', chan]], content: '' }))

  // "Everything in this channel" is the most ordinary query a client makes, so
  // it must not be refused for hypothetically matching a p-gated kind.
  const sub = await bobClient.subscribe('all', { '#h': [chan] })
  t.is(sub.closed, null)

  // A gift wrap addressed to Alice is published while Bob holds that
  // subscription. The per-event gate, not the filter gate, is what stops it.
  const wrap = sign(alice, {
    kind: core.KIND_GIFT_WRAP,
    tags: [['p', alice.pubkey], ['h', chan]],
    content: 'for alice only'
  })
  await aliceClient.publish(wrap)
  await new Promise((resolve) => setTimeout(resolve, 100))

  const delivered = bobClient.messages.filter((m) => m.type === 'EVENT' && m.subId === 'all')
  t.is(delivered.filter((m) => m.event.kind === core.KIND_GIFT_WRAP).length, 0,
    'a p-gated event never reaches a reader outside its #p')

  // And it is not in the history either.
  const history = await bobClient.subscribe('all2', { '#h': [chan] })
  t.is(history.events.filter((e) => e.kind === core.KIND_GIFT_WRAP).length, 0)
})

test('gift wraps only reach their addressee', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')
  const eve = identity('eve')

  const aliceClient = await member(h, alice)
  const bobClient = await member(h, bob)
  const eveClient = await member(h, eve)

  await bobClient.subscribe('dms', { kinds: [core.KIND_GIFT_WRAP], '#p': [bob.pubkey] })
  await eveClient.subscribe('dms', { kinds: [core.KIND_GIFT_WRAP], '#p': [eve.pubkey] })

  const wrap = sign(alice, {
    kind: core.KIND_GIFT_WRAP,
    tags: [['p', bob.pubkey]],
    content: 'encrypted-payload'
  })
  await aliceClient.publish(wrap)

  t.alike(await bobClient.nextEvent('dms'), wrap, 'the addressee receives it')

  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(eveClient.messages.filter((m) => m.type === 'EVENT' && m.subId === 'dms').length, 0)

  // Knowing the id is not enough: the per-event gate still withholds it. This
  // is the path the filter-level check deliberately lets through.
  const byId = await eveClient.subscribe('probe', { ids: [wrap.id] })
  t.is(byId.closed, null, 'an id lookup is not refused outright')
  t.is(byId.events.length, 0, 'but it returns nothing')

  t.is((await eveClient.count('c', { ids: [wrap.id] })).count, 0, 'and COUNT agrees')
})

test('an unshared persona is invisible to everyone but its author', async (t) => {
  const h = await harness(t)
  const owner = identity('owner')
  const other = identity('other')

  const ownerClient = await member(h, owner)
  const otherClient = await member(h, other)

  const persona = sign(owner, {
    kind: core.KIND_PERSONA,
    tags: [['d', 'honey']],
    content: JSON.stringify({ display_name: 'Honey', system_prompt: 'secret instructions' })
  })
  t.is((await ownerClient.publish(persona)).accepted, true)

  t.is((await ownerClient.subscribe('p1', { kinds: [core.KIND_PERSONA] })).events.length, 1, 'author sees it')
  t.is((await otherClient.subscribe('p2', { kinds: [core.KIND_PERSONA] })).events.length, 0, 'nobody else does')

  // Even asking for it by id reveals nothing.
  t.is((await otherClient.subscribe('p3', { ids: [persona.id] })).events.length, 0)

  // Sharing flips it, and the system prompt becomes catalog-visible by choice.
  const shared = sign(owner, {
    kind: core.KIND_PERSONA,
    created_at: persona.created_at + 1,
    tags: [['d', 'honey'], ['shared', 'true']],
    content: persona.content
  })
  t.is((await ownerClient.publish(shared)).accepted, true)
  t.is((await otherClient.subscribe('p4', { kinds: [core.KIND_PERSONA] })).events.length, 1)
})

test('a malformed shared tag is refused at ingest', async (t) => {
  const h = await harness(t)
  const owner = identity('owner')
  const client = await member(h, owner)

  const cases = [
    [[['d', 'a'], ['shared', 'yes']], 'must be "true"'],
    [[['d', 'b'], ['shared', 'true'], ['shared', 'true']], 'at most one shared tag']
  ]

  for (const [tags, expected] of cases) {
    const ok = await client.publish(sign(owner, { kind: core.KIND_PERSONA, tags, content: '{}' }))
    t.is(ok.accepted, false)
    t.ok(ok.reason.includes(expected), ok.reason)
  }
})

test('clients cannot forge relay-signed kinds', async (t) => {
  const h = await harness(t)
  const eve = identity('eve')
  const client = await member(h, eve)

  for (const kind of [core.KIND_MEMBER_ADDED_NOTIFICATION, core.KIND_NIP29_GROUP_METADATA, core.KIND_NIP29_GROUP_MEMBERS]) {
    const ok = await client.publish(sign(eve, { kind, tags: [['d', 'x'], ['p', eve.pubkey]], content: '' }))
    t.is(ok.accepted, false, `kind ${kind} refused`)
    t.ok(ok.reason.includes('may only be signed by the relay'))
  }
})

// --------------------------------------------------------------- reactions --

test('a reaction takes its channel from its target, not from its own h tag', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const aliceClient = await member(h, alice)
  const bobClient = await member(h, bob)

  const real = await makeChannel(h, alice, aliceClient, [['name', 'real'], ['visibility', 'private']])
  const decoy = await makeChannel(h, bob, bobClient, [['name', 'decoy'], ['visibility', 'open']])

  const target = message(alice, real, 'private message')
  await aliceClient.publish(target)

  // Alice reacts, but lies about the channel in her own h tag.
  const reaction = sign(alice, {
    kind: core.KIND_REACTION,
    tags: [['e', target.id], ['h', decoy]],
    content: '👍'
  })
  t.is((await aliceClient.publish(reaction)).accepted, true)

  const stored = h.store.getStoredEvent(reaction.id)
  t.is(stored.channelId, real, 'the relay used the target’s channel, ignoring the client tag')

  // So it did not leak into the open channel Bob can read.
  const sub = await bobClient.subscribe('decoy', { '#h': [decoy], kinds: [core.KIND_REACTION] })
  t.is(sub.events.length, 0)
})

test('a reaction to an unknown event is refused', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await member(h, alice)

  const ok = await client.publish(sign(alice, {
    kind: core.KIND_REACTION,
    tags: [['e', 'ff'.repeat(32)]],
    content: '+'
  }))
  t.is(ok.accepted, false)
  t.ok(ok.reason.includes('target event not found'), 'fails closed')
})

// --------------------------------------------------------------- deletions --

test('only the author may delete their own event', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const aliceClient = await member(h, alice)
  const bobClient = await member(h, bob)

  const chan = await makeChannel(h, alice, aliceClient, [['name', 'open'], ['visibility', 'open']])
  const target = message(alice, chan, 'delete me')
  await aliceClient.publish(target)

  const byOther = await bobClient.publish(sign(bob, {
    kind: core.KIND_DELETION,
    tags: [['e', target.id], ['h', chan]],
    content: ''
  }))
  t.is(byOther.accepted, false)
  t.ok(byOther.reason.includes('only the author'))

  const byAuthor = await aliceClient.publish(sign(alice, {
    kind: core.KIND_DELETION,
    tags: [['e', target.id], ['h', chan]],
    content: 'mistake'
  }))
  t.is(byAuthor.accepted, true)
})

test('an admin may delete another member’s message with kind 9005', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const aliceClient = await member(h, alice)
  const bobClient = await member(h, bob)

  const chan = await makeChannel(h, alice, aliceClient, [['name', 'open'], ['visibility', 'open']])
  await bobClient.publish(sign(bob, { kind: core.KIND_NIP29_JOIN_REQUEST, tags: [['h', chan]], content: '' }))

  const target = message(bob, chan, 'spam spam spam')
  await bobClient.publish(target)

  const ok = await aliceClient.publish(sign(alice, {
    kind: core.KIND_NIP29_DELETE_EVENT,
    tags: [['e', target.id], ['h', chan]],
    content: 'spam'
  }))
  t.is(ok.accepted, true)
  t.is(h.store.queryEvents([{ ids: [target.id] }]).length, 0)
})

// --------------------------------------------------------------- ephemeral --

test('presence is fanned out but never stored', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const aliceClient = await member(h, alice)
  const bobClient = await member(h, bob)

  await bobClient.subscribe('presence', { kinds: [core.KIND_PRESENCE_UPDATE] })

  const event = sign(alice, { kind: core.KIND_PRESENCE_UPDATE, content: 'online' })
  t.is((await aliceClient.publish(event)).accepted, true)

  t.alike(await bobClient.nextEvent('presence'), event, 'delivered live')
  t.is(h.store.queryEvents([{ kinds: [core.KIND_PRESENCE_UPDATE] }]).length, 0, 'never stored')
  t.is(h.store.getPresence(alice.pubkey), 'online', 'but the status is tracked')
})

test('typing indicators require channel membership', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const eve = identity('eve')

  const aliceClient = await member(h, alice)
  const eveClient = await member(h, eve)

  const chan = await makeChannel(h, alice, aliceClient, [['name', 'secret'], ['visibility', 'private']])

  const ok = await eveClient.publish(sign(eve, {
    kind: core.KIND_TYPING_INDICATOR,
    tags: [['h', chan]],
    content: ''
  }))
  t.is(ok.accepted, false)
  t.ok(ok.reason.includes('not a channel member'))
})

// ------------------------------------------------------------------ search --

test('NIP-50 search returns matches and respects channel access', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const eve = identity('eve')

  const aliceClient = await member(h, alice)
  const eveClient = await member(h, eve)

  const secret = await makeChannel(h, alice, aliceClient, [['name', 'secret'], ['visibility', 'private']])
  await aliceClient.publish(message(alice, secret, 'the pineapple deployment is delayed'))

  const found = await aliceClient.subscribe('s1', { kinds: [core.KIND_STREAM_MESSAGE], search: 'pineapple' })
  t.is(found.events.length, 1)

  const denied = await eveClient.subscribe('s2', { kinds: [core.KIND_STREAM_MESSAGE], search: 'pineapple' })
  t.is(denied.events.length, 0, 'search cannot be used to read a channel you are not in')
})

test('put-user refuses a fan-out bomb and non-hex p tags', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await member(h, alice)
  const chan = await makeChannel(h, alice, client)

  const before = h.store.listMembers(chan).length

  // One over the line. Each target would cost an addMember, an audit row and
  // a relay signature.
  const many = []
  for (let i = 0; i < MAX_PUT_USER_TARGETS + 1; i++) many.push(['p', identity(`x${i}`).pubkey])
  const bomb = await client.publish(
    sign(alice, { kind: core.KIND_NIP29_PUT_USER, tags: [['h', chan], ...many], content: '' })
  )
  t.absent(bomb.accepted, 'the fan-out bomb is refused')
  t.ok(bomb.reason.includes('at most'), `reason says the limit: ${bomb.reason}`)

  const junk = await client.publish(
    sign(alice, { kind: core.KIND_NIP29_PUT_USER, tags: [['h', chan], ['p', 'notahexkey']], content: '' })
  )
  t.absent(junk.accepted, 'a p tag that is not a pubkey is refused')
  t.ok(junk.reason.includes('hex pubkey'))

  t.is(h.store.listMembers(chan).length, before, 'and neither refusal added a member')

  // Exactly the cap, and an ordinary single add, both still work.
  const ok = await client.publish(
    sign(alice, { kind: core.KIND_NIP29_PUT_USER, tags: [['h', chan], ...many.slice(0, MAX_PUT_USER_TARGETS)], content: '' })
  )
  t.ok(ok.accepted, 'exactly the cap is still served')
})

test('a far-future created_at cannot pin itself to the top of every feed', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await member(h, alice)
  const chan = await makeChannel(h, alice, client)

  const now = Math.floor(Date.now() / 1000)

  const year30000 = await client.publish(
    sign(alice, { kind: core.KIND_STREAM_MESSAGE, created_at: 32503680000, tags: [['h', chan]], content: 'sticky' })
  )
  t.absent(year30000.accepted, 'year 30000 is refused')
  t.ok(year30000.reason.includes('created_at'), `reason names the field: ${year30000.reason}`)

  // One second past the line is still refused; well inside it is fine, because
  // a slightly fast clock is not an attack.
  const justOver = await client.publish(
    sign(alice, { kind: core.KIND_STREAM_MESSAGE, created_at: now + MAX_CREATED_AT_DRIFT_S + 60, tags: [['h', chan]], content: 'over' })
  )
  t.absent(justOver.accepted, 'past the drift allowance is refused')

  const skewed = await client.publish(
    sign(alice, { kind: core.KIND_STREAM_MESSAGE, created_at: now + 60, tags: [['h', chan]], content: 'fast clock' })
  )
  t.ok(skewed.accepted, 'a minute of clock skew is not an attack')

  // The past is untouched: imports and replication carry old timestamps.
  const old = await client.publish(
    sign(alice, { kind: core.KIND_STREAM_MESSAGE, created_at: 1000, tags: [['h', chan]], content: 'ancient' })
  )
  t.ok(old.accepted, 'old events are still accepted')

  const feed = await client.subscribe('s', { kinds: [core.KIND_STREAM_MESSAGE], '#h': [chan] })
  t.absent(feed.events.some((e) => e.content === 'sticky'), 'nothing sticky reached the store')
})

// ------------------------------------------------------------------- audit --

test('the audit chain records the pipeline and verifies', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await member(h, alice)

  const chan = await makeChannel(h, alice, client)
  await client.publish(message(alice, chan, 'audited'))

  const verification = h.store.verifyAuditChain()
  t.is(verification.ok, true)
  t.ok(verification.entries >= 4, 'auth, channel creation, membership and message all logged')

  const actions = h.store.listAudit({ limit: 100 }).map((entry) => entry.action)
  t.ok(actions.includes('AuthSuccess'))
  t.ok(actions.includes('ChannelCreated'))
  t.ok(actions.includes('EventCreated'))
})

test('GET /api/audit hides private-channel rows and gates verification', async (t) => {
  const { RateLimiter } = require('hive-auth')
  const h = await harness(t, { rateLimiter: new RateLimiter({ tier: 'human' }) })

  const alice = identity('alice')
  const eve = identity('eve')
  const aliceClient = await member(h, alice)

  const secret = await makeChannel(h, alice, aliceClient, [['name', 'secret'], ['visibility', 'private']])
  await aliceClient.publish(message(alice, secret, 'private business'))

  // Eve holds a perfectly good key and is in nothing.
  const seen = await rest(h, eve, '/api/audit')
  t.is(seen.status, 200)
  t.absent(seen.text.includes(secret), 'a private channel id is not disclosed to a non-member')
  t.is(seen.json.verification, null, 'chain verification is operator-only')

  // Alice is the owner, so her own channel's rows are hers to see.
  const mine = await rest(h, alice, '/api/audit')
  t.ok(mine.text.includes(secret), 'a member still sees their own channel')
  t.is(mine.json.verification, null, 'membership is not operatorship')

  // The operator is whoever holds the relay key.
  const operator = { secretKey: h.relay.secretKey }
  const opView = await rest(h, operator, '/api/audit')
  t.is(opView.json.verification.ok, true, 'the operator gets the full-scan integrity check')

  // And the endpoint is on the limiter now, so it cannot be used as a free
  // scan loop the way it could when only EVENT was limited.
  let limited = 0
  for (let i = 0; i < 80; i++) {
    if ((await rest(h, eve, '/api/audit')).status === 429) limited++
  }
  t.ok(limited > 0, 'repeated audit reads are rate limited')
})

// -------------------------------------------------------------- rate limits --

test('rate limiting refuses excess events', async (t) => {
  const { RateLimiter } = require('hive-auth')
  const h = await harness(t, { rateLimiter: new RateLimiter({ tier: 'human' }) })

  const alice = identity('alice')
  const client = await member(h, alice)

  let limited = 0
  for (let i = 0; i < 70; i++) {
    const ok = await client.publish(sign(alice, { kind: 1, created_at: 1000 + i, content: `m${i}` }))
    if (!ok.accepted && ok.reason.startsWith('rate-limited:')) limited++
  }

  t.ok(limited > 0, 'the burst allowance is finite')
  t.ok(limited < 70, 'but it is not zero')
})

test('rate-limit buckets are swept, so they do not leak per pubkey', async (t) => {
  const { RateLimiter } = require('hive-auth')

  // A hand-driven clock, because the leak is about elapsed time and the test
  // must not be about elapsed time.
  let now = 0
  const limiter = new RateLimiter({ tier: 'human', clock: () => now })

  for (let i = 0; i < 50; i++) limiter.allow(`pubkey-${i}`)
  t.is(limiter.buckets.size, 50, 'one bucket per publishing pubkey')

  // Not yet refilled: sweeping early must not forget a bucket that still owes
  // tokens, or the limit is trivially reset by waiting a moment.
  limiter.allow('pubkey-0', 60)
  limiter.sweep()
  t.is(limiter.buckets.size, 50, 'a bucket that has not refilled is kept')

  now += 10 * 60 * 1000
  limiter.sweep()
  t.is(limiter.buckets.size, 0, 'once refilled, the entry costs nothing and goes')

  // And the relay actually calls it, on a timer that cannot hold the loop open.
  const h = await harness(t, { rateLimiter: limiter })
  t.ok(h.relay.sweepTimer !== undefined && h.relay.sweepTimer !== null, 'the sweep is wired')
  t.is(h.relay.sweepTimer.hasRef(), false, "and it is unref'd, so Bare can still reach idle")
})

// -------------------------------------------------------- connection limits --

test('a connection that goes away is cleaned up', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const client = await member(h, alice)
  await client.subscribe('s1', { kinds: [1] })

  t.is(h.relay.connections.size, 1)
  t.is(h.relay.subscriptions.size, 1)

  await client.destroy()
  await new Promise((resolve) => setTimeout(resolve, 100))

  t.is(h.relay.connections.size, 0, 'connection deregistered')
  t.is(h.relay.subscriptions.size, 0, 'and its subscriptions with it')
})

// ------------------------------------------------------------ filter caps --

/** A NIP-98 authenticated REST call against the harness relay. */
function rest (h, who, path, { method = 'GET', body = null } = {}) {
  const url = `http://127.0.0.1:${h.port}${path}`
  return request(url, {
    method,
    body,
    headers: { Authorization: buildNip98Header({ url, method, secretKey: who.secretKey, body }) }
  })
}

test('a REQ over the filter cap is refused, not silently truncated', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await member(h, alice)

  const filters = []
  for (let i = 0; i < MAX_FILTERS_PER_REQ + 1; i++) filters.push({ kinds: [1], limit: 1 })

  const over = await client.subscribe('over', ...filters)
  t.ok(over.closed !== null && over.closed.includes('too many filters'), 'CLOSED says what to fix')
  t.is(h.relay.subscriptions.size, 0, 'and nothing was registered')

  // One under the line still works, so the cap is a cap and not an outage.
  const at = await client.subscribe('at', ...filters.slice(0, MAX_FILTERS_PER_REQ))
  t.is(at.closed, null, 'exactly the cap is still served')

  // COUNT fans out to the same per-filter SQL, so it carries the same cap.
  const counted = await client.count('c', ...filters)
  t.ok(counted.closed !== null && counted.closed.includes('too many filters'), 'COUNT is capped too')
})

test('POST /query is capped the same way as REQ', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const filters = []
  for (let i = 0; i < MAX_FILTERS_PER_REQ + 1; i++) filters.push({ kinds: [1], limit: 1 })

  const over = await rest(h, alice, '/query', { method: 'POST', body: JSON.stringify(filters) })
  t.is(over.status, 400, 'the HTTP transport does not route around the cap')
  t.ok(over.json.message.includes('too many filters'))

  const at = await rest(h, alice, '/query', { method: 'POST', body: JSON.stringify(filters.slice(0, MAX_FILTERS_PER_REQ)) })
  t.is(at.status, 200, 'exactly the cap is still served')
})
