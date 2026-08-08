'use strict'

const test = require('brittle')
const core = require('hive-core')

const { openStore, StoreError, SCHEMA_VERSION, search } = require('hive-store')
const { identity, sign, message, uuid } = require('./helpers')

function fresh () {
  return openStore(':memory:')
}

function channel (store, owner, overrides = {}) {
  return store.createChannel({
    id: uuid(),
    name: 'general',
    createdBy: owner.pubkey,
    ...overrides
  })
}

// ------------------------------------------------------------- migrations --

test('store opens, migrates and is idempotent about it', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  t.is(store.schemaVersion, SCHEMA_VERSION)
  t.is(store.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)

  // Re-running migrations on an already-current database must be a no-op.
  const { migrate } = require('hive-store/lib/schema')
  t.is(migrate(store.db), SCHEMA_VERSION)
  t.is(store.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
})

// ------------------------------------------------------------------ events --

test('insert then read back an event', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const event = sign(alice, { kind: 1, content: 'hello' })

  const result = store.insertEvent(event)
  t.is(result.wasInserted, true)
  t.alike(result.stored.event, event)

  t.alike(store.getEvent(event.id), event)
  t.is(store.getEvent('missing'), null)
})

test('insert is idempotent — a duplicate is a no-op, not an error', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const event = sign(identity('alice'), { kind: 1, content: 'once' })

  t.is(store.insertEvent(event).wasInserted, true)
  const second = store.insertEvent(event)
  t.is(second.wasInserted, false, 'second insert reports no write')
  t.alike(second.stored.event, event, 'and still returns the stored event')

  t.is(store.countEvents([{ ids: [event.id] }]), 1, 'stored exactly once')
})

test('auth and ephemeral kinds are rejected with distinct codes', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')

  try {
    store.insertEvent(sign(alice, { kind: core.KIND_AUTH, content: '' }))
    t.fail('auth event was stored')
  } catch (err) {
    t.is(err.code, 'AUTH_EVENT_FORBIDDEN')
  }

  try {
    store.insertEvent(sign(alice, { kind: core.KIND_PRESENCE_UPDATE, content: 'online' }))
    t.fail('ephemeral event was stored')
  } catch (err) {
    t.is(err.code, 'EPHEMERAL_FORBIDDEN')
  }

  try {
    store.insertEvent(sign(alice, { kind: core.KIND_TYPING_INDICATOR, content: '' }))
    t.fail('ephemeral event was stored')
  } catch (err) {
    t.is(err.code, 'EPHEMERAL_FORBIDDEN')
  }
})

test('replaceable kinds keep only the newest event', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const older = sign(alice, { kind: core.KIND_AGENT_PROFILE, created_at: 1000, content: '{"v":1}' })
  const newer = sign(alice, { kind: core.KIND_AGENT_PROFILE, created_at: 2000, content: '{"v":2}' })

  store.insertEvent(older)
  const result = store.insertEvent(newer)

  t.is(result.wasInserted, true)
  t.is(result.replaced, older.id, 'reports which event it replaced')
  t.is(store.getEvent(older.id), null, 'the old version is gone')
  t.alike(store.getEvent(newer.id), newer)
})

test('an older replaceable event does not overwrite a newer one', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const newer = sign(alice, { kind: core.KIND_AGENT_PROFILE, created_at: 2000, content: 'new' })
  const older = sign(alice, { kind: core.KIND_AGENT_PROFILE, created_at: 1000, content: 'old' })

  store.insertEvent(newer)
  const result = store.insertEvent(older)

  t.is(result.wasInserted, false)
  t.is(result.stored.event.id, newer.id, 'the newer event is retained')
  t.is(store.getEvent(older.id), null)
})

test('replaceable ties break on the lowest id, per NIP-01', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')

  // Same coordinate and timestamp, different content → different ids.
  const a = sign(alice, { kind: core.KIND_AGENT_PROFILE, created_at: 1000, content: 'a' })
  const b = sign(alice, { kind: core.KIND_AGENT_PROFILE, created_at: 1000, content: 'b' })
  const [low, high] = a.id < b.id ? [a, b] : [b, a]

  store.insertEvent(high)
  store.insertEvent(low)
  t.is(store.getEvent(low.id).id, low.id, 'lower id wins when it arrives second')

  const store2 = fresh()
  t.teardown(() => store2.close())
  store2.insertEvent(low)
  store2.insertEvent(high)
  t.is(store2.getEvent(low.id).id, low.id, 'and also when it arrived first')
  t.is(store2.getEvent(high.id), null)
})

test('parameterized-replaceable events are addressed by their d tag', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const owner = identity('owner')
  const honeyV1 = sign(owner, {
    kind: core.KIND_PERSONA, created_at: 1000, tags: [['d', 'honey']], content: 'v1'
  })
  const honeyV2 = sign(owner, {
    kind: core.KIND_PERSONA, created_at: 2000, tags: [['d', 'honey']], content: 'v2'
  })
  const comb = sign(owner, {
    kind: core.KIND_PERSONA, created_at: 1000, tags: [['d', 'comb']], content: 'other slug'
  })

  store.insertEvent(honeyV1)
  store.insertEvent(comb)
  store.insertEvent(honeyV2)

  t.is(store.getEvent(honeyV1.id), null, 'same slug replaced')
  t.alike(store.getEvent(honeyV2.id), honeyV2)
  t.alike(store.getEvent(comb.id), comb, 'a different slug is a different coordinate')
})

// ----------------------------------------------------------------- queries --

test('queries match on ids, authors, kinds, time and tags', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const bob = identity('bob')
  const chan = channel(store, alice).id

  const m1 = message(alice, chan, 'first')
  const m2 = message(bob, chan, 'second')
  const note = sign(alice, { kind: 1, content: 'a note' })
  for (const e of [m1, m2, note]) store.insertEvent(e)

  const ids = (filters) => store.queryEvents(filters).map((s) => s.event.id).sort()

  t.alike(ids([{ ids: [m1.id] }]), [m1.id])
  t.alike(ids([{ authors: [alice.pubkey] }]), [m1.id, note.id].sort())
  t.alike(ids([{ kinds: [core.KIND_STREAM_MESSAGE] }]), [m1.id, m2.id].sort())
  t.alike(ids([{ '#h': [chan] }]), [m1.id, m2.id].sort())
  t.alike(ids([{ kinds: [core.KIND_STREAM_MESSAGE], authors: [bob.pubkey] }]), [m2.id])
  t.alike(ids([{ kinds: [] }]), [], 'empty kinds matches nothing')
  t.alike(ids([{ '#h': [chan] }, { kinds: [1] }]), [m1.id, m2.id, note.id].sort(), 'filters OR')
})

test('id and author prefix matching works', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const event = sign(alice, { kind: 1, content: 'x' })
  store.insertEvent(event)

  t.is(store.queryEvents([{ ids: [event.id.slice(0, 8)] }]).length, 1)
  t.is(store.queryEvents([{ authors: [alice.pubkey.slice(0, 8)] }]).length, 1)
  t.is(store.queryEvents([{ ids: ['ff'.repeat(4)] }]).length, 0)
})

test('queries are deduplicated, ordered newest-first and capped', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  for (let i = 0; i < 10; i++) {
    store.insertEvent(sign(alice, { kind: 1, created_at: 1000 + i, content: `m${i}` }))
  }

  const results = store.queryEvents([{ kinds: [1] }, { authors: [alice.pubkey] }])
  t.is(results.length, 10, 'overlapping filters do not duplicate results')

  for (let i = 1; i < results.length; i++) {
    t.ok(results[i - 1].event.created_at >= results[i].event.created_at, 'newest first')
  }

  t.is(store.queryEvents([{ kinds: [1] }], { limit: 3 }).length, 3)
  t.is(store.queryEvents([{ kinds: [1], limit: 2 }]).length, 2, 'filter limit honoured')
})

test('the historical limit is a hard cap the caller cannot raise', (t) => {
  const store = openStore(':memory:', { maxHistoricalLimit: 5 })
  t.teardown(() => store.close())

  const alice = identity('alice')
  for (let i = 0; i < 20; i++) {
    store.insertEvent(sign(alice, { kind: 1, created_at: 1000 + i, content: `m${i}` }))
  }

  t.is(store.queryEvents([{ kinds: [1] }], { limit: 1000 }).length, 5)
  t.is(store.queryEvents([{ kinds: [1], limit: 1000 }]).length, 5)
})

test('countEvents deduplicates across filters', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  for (let i = 0; i < 4; i++) store.insertEvent(sign(alice, { kind: 1, created_at: 1000 + i, content: `m${i}` }))

  t.is(store.countEvents([{ kinds: [1] }]), 4)
  t.is(store.countEvents([{ kinds: [1] }, { authors: [alice.pubkey] }]), 4, 'not 8')
  t.is(store.countEvents([{ kinds: [99] }]), 0)
})

test('deleted events disappear from queries but stay on disk for the audit trail', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const event = sign(alice, { kind: 1, content: 'delete me' })
  store.insertEvent(event)

  t.is(store.deleteEvent(event.id), true)
  t.is(store.queryEvents([{ ids: [event.id] }]).length, 0)
  t.is(store.queryEvents([{ ids: [event.id] }], { includeDeleted: true }).length, 1)
  t.is(store.deleteEvent('unknown'), false)
})

// ------------------------------------------------------------------ search --

test('search finds events and requires every query token', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const chan = channel(store, alice).id

  const arch = message(alice, chan, 'the relay architecture is event sourced')
  const other = message(alice, chan, 'lunch plans for tomorrow')
  store.insertEvent(arch)
  store.insertEvent(other)

  t.is(store.search('architecture')[0].event.id, arch.id)
  t.is(store.search('relay architecture').length, 1, 'AND semantics')
  t.is(store.search('architecture lunch').length, 0, 'both tokens must be present')
  t.is(store.search('ARCHITECTURE')[0].event.id, arch.id, 'case insensitive')
  t.is(store.search('nonexistent').length, 0)
  t.is(store.search('').length, 0, 'an empty query matches nothing')
})

test('search scopes by channel, kind and author', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const bob = identity('bob')
  const a = channel(store, alice, { name: 'a' }).id
  const b = channel(store, alice, { name: 'b' }).id

  store.insertEvent(message(alice, a, 'deployment notes'))
  store.insertEvent(message(bob, b, 'deployment notes'))

  t.is(store.search('deployment').length, 2)
  t.is(store.search('deployment', { channelIds: [a] }).length, 1)
  t.is(store.search('deployment', { author: bob.pubkey })[0].channelId, b)
  t.is(store.search('deployment', { kinds: [core.KIND_STREAM_MESSAGE] }).length, 2)
  t.is(store.search('deployment', { kinds: [1] }).length, 0)
})

test('private kinds are never written to the search index', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')

  // Every persistent kind that must never surface through NIP-50.
  const secret = 'pineapple'
  const privateKinds = [
    core.KIND_GIFT_WRAP,
    core.KIND_EVENT_REMINDER,
    core.KIND_DM_VISIBILITY,
    core.KIND_AGENT_TURN_METRIC,
    core.KIND_PUSH_LEASE,
    core.KIND_PRIVATE_MANAGED_AGENT
  ]

  for (const kind of privateKinds) {
    const event = sign(alice, {
      kind,
      tags: core.isParameterizedReplaceable(kind) ? [['d', `slug-${kind}`]] : [],
      content: `${secret} for kind ${kind}`
    })
    store.insertEvent(event)
  }

  t.is(store.search(secret).length, 0, 'not one private event is searchable')

  const tokenRows = store.db
    .prepare(`SELECT COUNT(*) AS n FROM event_tokens WHERE kind IN (${privateKinds.join(',')})`)
    .get().n
  t.is(tokenRows, 0, 'and no index rows exist to leak in the first place')

  // A public message with the same word is still findable, proving the test
  // isn't passing because search is simply broken.
  const chan = channel(store, alice).id
  const visible = message(alice, chan, `${secret} is fine here`)
  store.insertEvent(visible)
  t.is(store.search(secret).length, 1)
})

test('deleting an event removes it from the search index', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const chan = channel(store, alice).id
  const event = message(alice, chan, 'ephemeral knowledge')
  store.insertEvent(event)

  t.is(store.search('knowledge').length, 1)
  store.deleteEvent(event.id)
  t.is(store.search('knowledge').length, 0)
})

test('the tokenizer drops stopwords and short tokens', (t) => {
  t.alike(search.tokenize('the quick brown fox'), ['quick', 'brown', 'fox'])
  t.alike(search.tokenize('a I x'), [], 'single characters are dropped')
  t.alike(search.tokenize('Hello, World!'), ['hello', 'world'])
  t.alike(search.tokenize('snake_case and CamelCase'), ['snake_case', 'camelcase'])
  t.alike(search.tokenize(''), [])
  t.alike(search.tokenize(null), [])
  t.is(search.tokenize('dup dup dup').length, 1, 'tokens are deduplicated')
})

// ---------------------------------------------------------------- channels --

test('creating a channel makes the creator its owner', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const chan = channel(store, alice, { name: 'engineering', visibility: 'private' })

  t.is(chan.name, 'engineering')
  t.is(chan.visibility, 'private')
  t.is(chan.type, 'stream', 'default type')
  t.is(store.getMember(chan.id, alice.pubkey).role, 'owner')
  t.is(store.countOwners(chan.id), 1)
})

test('membership add, remove and re-add', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const bob = identity('bob')
  const chan = channel(store, alice).id

  t.is(store.isMember(chan, bob.pubkey), false)
  store.addMember(chan, bob.pubkey)
  t.is(store.isMember(chan, bob.pubkey), true)

  t.is(store.removeMember(chan, bob.pubkey), true)
  t.is(store.isMember(chan, bob.pubkey), false)
  t.is(store.removeMember(chan, bob.pubkey), false, 'removing a non-member is a no-op')

  store.addMember(chan, bob.pubkey, 'admin')
  t.is(store.getMember(chan, bob.pubkey).role, 'admin', 're-adding reverses the soft delete')
})

test('the last owner cannot be removed or demoted', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const bob = identity('bob')
  const chan = channel(store, alice).id

  t.exception(() => store.removeMember(chan, alice.pubkey), /last owner/)
  t.exception(() => store.setMemberRole(chan, alice.pubkey, 'member'), /last owner/)

  // With a second owner in place both operations become legal.
  store.addMember(chan, bob.pubkey, 'owner')
  t.is(store.removeMember(chan, alice.pubkey), true)
  t.is(store.countOwners(chan), 1)
})

test('accessible channels: open to everyone, private to members', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const bob = identity('bob')

  const open = channel(store, alice, { name: 'open', visibility: 'open' }).id
  const secret = channel(store, alice, { name: 'secret', visibility: 'private' }).id

  const bobSees = store.accessibleChannelIds(bob.pubkey)
  t.is(bobSees.has(open), true)
  t.is(bobSees.has(secret), false, 'a non-member cannot see a private channel')

  store.addMember(secret, bob.pubkey)
  t.is(store.accessibleChannelIds(bob.pubkey).has(secret), true)

  t.is(store.listChannels({ pubkey: bob.pubkey }).length, 2)
})

test('channel update, archive and delete', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const chan = channel(store, alice).id

  t.is(store.updateChannel(chan, { topic: 'shipping v2' }).topic, 'shipping v2')
  t.is(store.updateChannel(chan, { id: 'hacked' }).id, chan, 'unknown columns are ignored')

  store.archiveChannel(chan)
  t.is(store.listChannels().length, 0, 'archived channels are hidden by default')
  t.is(store.listChannels({ includeArchived: true }).length, 1)

  store.archiveChannel(chan, false)
  store.deleteChannel(chan)
  t.is(store.getChannel(chan), null)
})

// ------------------------------------------------------------------- users --

test('profiles merge on update', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  store.upsertUser(alice.pubkey, { displayName: 'Alice', about: 'builder' })
  store.upsertUser(alice.pubkey, { displayName: 'Alice B.' })

  const user = store.getUser(alice.pubkey)
  t.is(user.displayName, 'Alice B.')
  t.is(user.about, 'builder', 'unspecified fields survive')
})

test('presence expires rather than being cleared', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  t.is(store.getPresence(alice.pubkey), 'offline', 'unknown pubkeys are offline')

  store.setPresence(alice.pubkey, 'online')
  t.is(store.getPresence(alice.pubkey), 'online')

  store.setPresence(alice.pubkey, 'away', -1) // already expired
  t.is(store.getPresence(alice.pubkey), 'offline', 'an expired heartbeat reads as offline')

  store.setPresence(alice.pubkey, 'online')
  store.setPresence(alice.pubkey, 'offline')
  t.is(store.getPresence(alice.pubkey), 'offline', 'explicit offline clears')

  store.setPresence(alice.pubkey, 'x'.repeat(500))
  t.is(store.getPresence(alice.pubkey).length, 128, 'status truncated to 128 characters')
})

// ------------------------------------------------------------------- audit --

test('the audit chain links and verifies', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')

  const first = store.appendAudit({ action: 'ChannelCreated', actor: alice.pubkey, channelId: 'c1' })
  t.is(first.seq, 1)
  t.is(first.prev_hash, '0'.repeat(64), 'genesis is 64 zeros')

  const second = store.appendAudit({ action: 'EventCreated', actor: alice.pubkey, eventId: 'e1', kind: 9 })
  t.is(second.prev_hash, first.hash, 'each entry links to the previous')

  const result = store.verifyAuditChain()
  t.is(result.ok, true)
  t.is(result.entries, 2)
  t.is(result.brokenAt, null)
})

test('tampering with any audit row breaks the chain at that row', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  for (let i = 0; i < 5; i++) {
    store.appendAudit({ action: 'EventCreated', actor: alice.pubkey, eventId: `e${i}`, kind: 9 })
  }
  t.is(store.verifyAuditChain().ok, true)

  // Edit the middle entry's metadata directly, leaving its hash in place —
  // exactly what an attacker with database access would attempt.
  store.db.prepare("UPDATE audit_log SET action = 'EventDeleted' WHERE seq = 3").run()

  const result = store.verifyAuditChain()
  t.is(result.ok, false)
  t.is(result.brokenAt, 3, 'detected at the earliest tampered entry')
  t.ok(result.reason.includes('hash'))
})

test('recomputing the tampered row is not enough — the chain still breaks', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  for (let i = 0; i < 4; i++) {
    store.appendAudit({ action: 'EventCreated', actor: alice.pubkey, eventId: `e${i}`, kind: 9 })
  }

  // A more sophisticated attacker recomputes the hash of the row they edited.
  // The next row's prev_hash still points at the old value, so it is caught.
  const { entryHash } = require('hive-store').audit
  const row = store.db.prepare('SELECT * FROM audit_log WHERE seq = 2').get()
  const forged = { ...row, event_id: 'forged', metadata: JSON.parse(row.metadata) }
  store.db
    .prepare('UPDATE audit_log SET event_id = ?, hash = ? WHERE seq = 2')
    .run('forged', entryHash(forged))

  const result = store.verifyAuditChain()
  t.is(result.ok, false)
  t.is(result.brokenAt, 3, 'the following entry exposes the edit')
  t.ok(result.reason.includes('prev_hash'))
})

test('audit metadata hashing is order-independent', (t) => {
  const { entryHash } = require('hive-store').audit

  const base = {
    seq: 1, ts: '2026-08-08T00:00:00.000Z', event_id: 'e', kind: 9,
    actor: 'a', action: 'EventCreated', channel_id: null, prev_hash: '0'.repeat(64)
  }

  const a = entryHash({ ...base, metadata: { zebra: 1, alpha: 2 } })
  const b = entryHash({ ...base, metadata: { alpha: 2, zebra: 1 } })
  t.is(a, b, 'key order must not change the hash')

  const c = entryHash({ ...base, metadata: { alpha: 2, zebra: 2 } })
  t.not(a, c, 'but values must')
})

// -------------------------------------------------------------------- feed --

test('mentions feed and threads', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const bob = identity('bob')
  const chan = channel(store, alice).id

  const root = message(alice, chan, 'anyone seen the deploy?')
  store.insertEvent(root)

  const reply = message(bob, chan, 'looking now', [
    ['e', root.id, '', 'reply'],
    ['p', alice.pubkey]
  ])
  store.insertEvent(reply)

  const mentions = store.queryMentions(alice.pubkey)
  t.is(mentions.length, 1)
  t.is(mentions[0].event.id, reply.id)
  t.is(store.queryMentions(bob.pubkey).length, 0)

  const thread = store.getThread(root.id)
  t.is(thread.root.event.id, root.id)
  t.is(thread.replies.length, 1)
  t.is(thread.replies[0].event.id, reply.id)

  const meta = store.db.prepare('SELECT * FROM thread_metadata WHERE root_id = ?').get(root.id)
  t.is(meta.reply_count, 1)
})

test('the feed limit is a hard cap', (t) => {
  const store = openStore(':memory:', { feedMaxLimit: 3 })
  t.teardown(() => store.close())

  const alice = identity('alice')
  const bob = identity('bob')
  const chan = channel(store, alice).id

  for (let i = 0; i < 10; i++) {
    store.insertEvent(message(bob, chan, `ping ${i}`, [['p', alice.pubkey]]))
  }
  t.is(store.queryMentions(alice.pubkey, { limit: 100 }).length, 3)
})

// ------------------------------------------------------- relay membership --

test('relay membership and the pubkey allowlist', (t) => {
  const store = fresh()
  t.teardown(() => store.close())

  const alice = identity('alice')
  const bob = identity('bob')

  store.addRelayMember(alice.pubkey, 'admin')
  t.is(store.getRelayMember(alice.pubkey).role, 'admin')
  t.is(store.getRelayMember(bob.pubkey), null)

  store.addRelayMember(alice.pubkey, 'member')
  t.is(store.getRelayMember(alice.pubkey).role, 'member', 're-adding updates the role')
  t.is(store.listRelayMembers().length, 1)

  t.is(store.removeRelayMember(alice.pubkey), true)
  t.is(store.removeRelayMember(alice.pubkey), false)

  t.is(store.isPubkeyAllowed(bob.pubkey), false)
  store.addAllowedPubkey(bob.pubkey)
  t.is(store.isPubkeyAllowed(bob.pubkey), true)
})

// -------------------------------------------------------------- durability --

test('a file-backed store survives reopening', (t) => {
  const os = require('bare-os')
  const path = require('bare-path')
  const fs = require('bare-fs')

  const file = path.join(os.tmpdir(), `hive-test-${Date.now()}.db`)
  t.teardown(() => {
    try {
      fs.unlinkSync(file)
    } catch {}
  })

  const alice = identity('alice')
  const event = sign(alice, { kind: 1, content: 'persisted' })

  const first = openStore(file)
  first.insertEvent(event)
  const chan = first.createChannel({ id: uuid(), name: 'durable', createdBy: alice.pubkey })
  first.appendAudit({ action: 'ChannelCreated', actor: alice.pubkey, channelId: chan.id })
  first.close()

  const second = openStore(file)
  t.teardown(() => second.close())

  t.alike(second.getEvent(event.id), event)
  t.is(second.getChannel(chan.id).name, 'durable')
  t.is(second.verifyAuditChain().ok, true)
  t.is(second.schemaVersion, SCHEMA_VERSION, 'no re-migration surprises')
})

test('openStore rejects unknown drivers', (t) => {
  t.exception(() => openStore(':memory:', { driver: 'postgres' }), /unknown store driver/)
  t.ok(StoreError.invalid('x') instanceof Error)
})
