'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')

const core = require('hive-core')

// A frozen NIP-01 vector. The private key and template come from nostr-tools'
// own fixtures; the id was cross-checked against an independent Python
// implementation of the canonical serialization, so this pins interop rather
// than merely pinning our own output.
const VECTOR = {
  secretKey: 'd217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf',
  pubkey: '6af0f9de588f2c53cedcba26c5e2402e0d0aa64ec7b47c9f8d97b5bc562bab5f',
  created_at: 1617932115,
  kind: 1,
  tags: [],
  content: 'Hello, world!',
  canonical:
    '[0,"6af0f9de588f2c53cedcba26c5e2402e0d0aa64ec7b47c9f8d97b5bc562bab5f",1617932115,1,[],"Hello, world!"]',
  id: 'b2a44af84ca99b14820ae91c44e1ef0908f8aadc4e10620a6e6caa344507f03c'
}

function unsigned () {
  return {
    pubkey: VECTOR.pubkey,
    created_at: VECTOR.created_at,
    kind: VECTOR.kind,
    tags: VECTOR.tags,
    content: VECTOR.content
  }
}

// ------------------------------------------------------------------ crypto --

test('canonical serialization matches the frozen NIP-01 vector', (t) => {
  t.is(core.serializeEvent(unsigned()), VECTOR.canonical)
  t.is(core.getEventHash(unsigned()), VECTOR.id)
})

test('public key derives deterministically from the secret key', (t) => {
  t.is(core.getPublicKey(VECTOR.secretKey), VECTOR.pubkey)
  t.is(core.getPublicKey(core.fromHex(VECTOR.secretKey)), VECTOR.pubkey)
})

test('content escaping follows NIP-01 exactly', (t) => {
  const event = { ...unsigned(), content: 'line\nbreak "quoted" back\\slash\ttab' }
  const serialized = core.serializeEvent(event)

  t.ok(serialized.includes('\\n'), 'newline escaped')
  t.ok(serialized.includes('\\"'), 'double quote escaped')
  t.ok(serialized.includes('\\\\'), 'backslash escaped')
  t.ok(serialized.includes('\\t'), 'tab escaped')
  t.absent(serialized.includes('\n'), 'no literal newline survives')
})

test('non-ASCII content is not escaped', (t) => {
  const event = { ...unsigned(), content: 'héllo 🐝 世界' }
  t.ok(core.serializeEvent(event).includes('héllo 🐝 世界'))
})

test('sign then verify round-trips', (t) => {
  const event = core.finalizeEvent(
    { kind: 9, tags: [['h', 'abc']], content: 'hi' },
    VECTOR.secretKey
  )

  t.is(event.pubkey, VECTOR.pubkey)
  t.is(event.id, core.getEventHash(event))
  t.is(core.verifyEvent(event).ok, true)
})

test('verify rejects a tampered event', (t) => {
  const event = core.finalizeEvent({ kind: 1, content: 'original' }, VECTOR.secretKey)

  const contentTampered = { ...event, content: 'tampered' }
  const result = core.verifyEvent(contentTampered)
  t.is(result.ok, false)
  t.ok(result.reason.includes('id does not match'), 'caught by id recomputation')

  // Re-derive the id so the tamper survives the hash check — the signature
  // must still fail, which proves the two checks are independent.
  const reIded = { ...contentTampered }
  reIded.id = core.getEventHash(reIded)
  const sigResult = core.verifyEvent(reIded)
  t.is(sigResult.ok, false)
  t.ok(sigResult.reason.includes('signature'), 'caught by signature verification')
})

test('verify rejects malformed shapes', (t) => {
  const event = core.finalizeEvent({ kind: 1, content: 'x' }, VECTOR.secretKey)

  t.is(core.verifyEvent(null).ok, false)
  t.is(core.verifyEvent({ ...event, id: 'ZZ' }).ok, false)
  t.is(core.verifyEvent({ ...event, pubkey: 'short' }).ok, false)
  t.is(core.verifyEvent({ ...event, sig: 'short' }).ok, false)
  t.is(core.verifyEvent({ ...event, kind: -1 }).ok, false)
  t.is(core.verifyEvent({ ...event, kind: 1.5 }).ok, false)
  t.is(core.verifyEvent({ ...event, created_at: 'now' }).ok, false)
  t.is(core.verifyEvent({ ...event, content: 42 }).ok, false)
  t.is(core.verifyEvent({ ...event, tags: 'nope' }).ok, false)
  t.is(core.verifyEvent({ ...event, tags: [['e', 42]] }).ok, false)
  t.is(core.verifyEvent({ ...event, id: event.id.toUpperCase() }).ok, false, 'uppercase hex rejected')
})

test('schnorr verification passes the official BIP-340 vectors', (t) => {
  const csv = fs.readFileSync(path.join(__dirname, 'fixtures', 'bip340-vectors.csv'), 'utf8')
  const rows = csv.trim().split('\n').slice(1)
  t.ok(rows.length >= 15, 'vector file loaded')

  let checked = 0
  for (const row of rows) {
    const [index, , pubkey, , message, signature, expected] = row.split(',')
    const want = expected.trim().toUpperCase() === 'TRUE'

    const got = core.verifyHash(message.toLowerCase(), signature.toLowerCase(), pubkey.toLowerCase())
    t.is(got, want, `BIP-340 vector ${index}`)
    checked++
  }
  t.ok(checked >= 15, 'every vector exercised')
})

test('signHash and verifyHash round-trip (NIP-OA primitive)', (t) => {
  const hash = core.toHex(core.sha256(Buffer.from('nostr:agent-auth:test')))
  const sig = core.signHash(hash, VECTOR.secretKey)

  t.is(core.verifyHash(hash, sig, VECTOR.pubkey), true)
  t.is(core.verifyHash(core.toHex(core.sha256(Buffer.from('other'))), sig, VECTOR.pubkey), false)
})

// ------------------------------------------------------------------ NIP-19 --

test('bech32 npub/nsec/note round-trip', (t) => {
  const npub = core.encodeNpub(VECTOR.pubkey)
  t.ok(npub.startsWith('npub1'))
  t.is(core.decodeKey(npub, 'npub'), VECTOR.pubkey)

  const nsec = core.encodeNsec(VECTOR.secretKey)
  t.ok(nsec.startsWith('nsec1'))
  t.is(core.decodeKey(nsec, 'nsec'), VECTOR.secretKey)

  const note = core.encodeNote(VECTOR.id)
  t.ok(note.startsWith('note1'))
  t.is(core.decodeKey(note, 'note'), VECTOR.id)
})

test('decodeKey accepts hex and rejects the wrong entity type', (t) => {
  t.is(core.decodeKey(VECTOR.pubkey), VECTOR.pubkey)
  t.is(core.decodeKey(VECTOR.pubkey.toUpperCase()), VECTOR.pubkey)
  t.exception(() => core.decodeKey(core.encodeNpub(VECTOR.pubkey), 'nsec'), /expected a nsec/)
  t.exception(() => core.decodeKey('nsec1invalid'))
  t.exception(() => core.decodeKey('not a key at all'))
})

test('bech32 rejects a corrupted checksum', (t) => {
  const npub = core.encodeNpub(VECTOR.pubkey)
  const corrupted = npub.slice(0, -1) + (npub.endsWith('q') ? 'p' : 'q')
  t.exception(() => core.decodeKey(corrupted), /checksum/)
})

// ------------------------------------------------------------------- kinds --

test('kind range predicates', (t) => {
  t.is(core.isRegular(1), true)
  t.is(core.isRegular(core.KIND_STREAM_MESSAGE), true)
  t.is(core.isReplaceable(core.KIND_AGENT_PROFILE), true, '10100 is replaceable')
  t.is(core.isEphemeral(core.KIND_PRESENCE_UPDATE), true, '20001 is ephemeral')
  t.is(core.isEphemeral(core.KIND_TYPING_INDICATOR), true)
  t.is(core.isEphemeral(core.KIND_AUTH), true, '22242 falls in the ephemeral range')
  t.is(core.isParameterizedReplaceable(core.KIND_PERSONA), true, '30175 is param-replaceable')
  t.is(core.isAddressable(core.KIND_TEAM), true)
  t.is(core.isAddressable(core.KIND_STREAM_MESSAGE), false)
})

test('kind registry pins the Buzz interop numbers', (t) => {
  // Changing any of these breaks compatibility with Buzz clients and agents.
  t.is(core.KIND_STREAM_MESSAGE, 9)
  t.is(core.KIND_REACTION, 7)
  t.is(core.KIND_DELETION, 5)
  t.is(core.KIND_AUTH, 22242)
  t.is(core.KIND_HTTP_AUTH, 27235)
  t.is(core.KIND_NIP29_CREATE_GROUP, 9007)
  t.is(core.KIND_NIP29_GROUP_METADATA, 39000)
  t.is(core.KIND_NIP29_GROUP_MEMBERS, 39002)
  t.is(core.KIND_STREAM_MESSAGE_V2, 40002)
  t.is(core.KIND_CANVAS, 40100)
  t.is(core.KIND_JOB_REQUEST, 43001)
  t.is(core.KIND_MEMBER_ADDED_NOTIFICATION, 44100)
  t.is(core.KIND_WORKFLOW_TRIGGERED, 46001)
  t.is(core.KIND_AGENT_PROFILE, 10100)
  t.is(core.KIND_PERSONA, 30175)
  t.is(core.KIND_MANAGED_AGENT, 30177)
  t.is(core.KIND_GIT_REPO_ANNOUNCEMENT, 30617)
  t.is(core.KIND_GIT_PATCH, 1617)
  t.is(core.KIND_HUDDLE_STARTED, 48100)
})

test('ALL_KINDS is sorted, deduplicated and excludes KIND_AUTH', (t) => {
  t.absent(core.ALL_KINDS.includes(core.KIND_AUTH), 'AUTH is never stored')
  t.is(new Set(core.ALL_KINDS).size, core.ALL_KINDS.length, 'no duplicate numbers')

  for (let i = 1; i < core.ALL_KINDS.length; i++) {
    t.ok(core.ALL_KINDS[i] > core.ALL_KINDS[i - 1], 'sorted ascending')
  }
  t.ok(core.ALL_KINDS.length > 100, 'registry is populated')
})

test('access-class membership', (t) => {
  t.is(core.isAuthorOnlyKind(core.KIND_EVENT_REMINDER), true)
  t.is(core.isAuthorOnlyKind(core.KIND_PRIVATE_MANAGED_AGENT), true)
  t.is(core.isAuthorOnlyKind(core.KIND_STREAM_MESSAGE), false)

  t.is(core.isPGatedKind(core.KIND_GIFT_WRAP), true)
  t.is(core.isPGatedKind(core.KIND_MEMBER_ADDED_NOTIFICATION), true)
  t.is(core.isPGatedKind(core.KIND_AGENT_TURN_METRIC), true)
  t.is(core.isPGatedKind(core.KIND_STREAM_MESSAGE), false)

  t.is(core.isResultGatedKind(core.KIND_DM_VISIBILITY), true)
  t.is(core.isSharedGatedKind(core.KIND_PERSONA), true)
  t.is(core.isSharedGatedKind(core.KIND_TEAM), false, 'teams are owner-private, not shared-gated')
})

test('every persistent p-gated kind is excluded from search', (t) => {
  for (const kind of core.P_GATED_KINDS) {
    if (core.isEphemeral(kind)) continue
    t.is(core.isSearchable(kind), false, `kind ${kind} must never be indexed`)
  }
  for (const kind of core.AUTHOR_ONLY_KINDS) {
    t.is(core.isSearchable(kind), false, `kind ${kind} must never be indexed`)
  }
  t.is(core.isSearchable(core.KIND_STREAM_MESSAGE), true, 'chat is searchable')

  // `hive agents find --query` matches the 10100 description through the
  // ordinary content index and adds no index of its own. If this ever flips,
  // free-text agent discovery silently returns nothing.
  t.is(core.isSearchable(core.KIND_AGENT_PROFILE), true, 'agent profiles are indexed for free')
})

test('eventIsShared requires an exact two-element tag', (t) => {
  const shared = (tags) => core.eventIsShared({ tags })

  t.is(shared([['shared', 'true']]), true)
  t.is(shared([['d', 'x'], ['shared', 'true']]), true)

  t.is(shared([]), false, 'absent')
  t.is(shared([['shared']]), false, 'one element')
  t.is(shared([['shared', 'true', 'extra']]), false, 'three elements fails closed')
  t.is(shared([['shared', 'yes']]), false, 'wrong value')
  t.is(shared([['shared', 'TRUE']]), false, 'case sensitive')
  t.is(shared([['shared', 'true'], ['shared', 'true']]), false, 'duplicate tags fail closed')
})

test('isUnsharedGatedEvent needs all three conditions', (t) => {
  const author = 'a'.repeat(64)
  const other = 'b'.repeat(64)

  const unsharedPersona = { kind: core.KIND_PERSONA, pubkey: author, tags: [['d', 'honey']] }
  t.is(core.isUnsharedGatedEvent(unsharedPersona, other), true, 'withheld from a foreign reader')
  t.is(core.isUnsharedGatedEvent(unsharedPersona, author), false, 'the author always reads it')

  const sharedPersona = { ...unsharedPersona, tags: [['d', 'honey'], ['shared', 'true']] }
  t.is(core.isUnsharedGatedEvent(sharedPersona, other), false, 'sharing opens it up')

  const message = { kind: core.KIND_STREAM_MESSAGE, pubkey: author, tags: [] }
  t.is(core.isUnsharedGatedEvent(message, other), false, 'non-gated kinds are unaffected')
})

test('relay-signed and channel-required kind sets', (t) => {
  t.is(core.isRelaySignedKind(core.KIND_MEMBER_ADDED_NOTIFICATION), true)
  t.is(core.isRelaySignedKind(core.KIND_NIP29_GROUP_METADATA), true)
  t.is(core.isRelaySignedKind(core.KIND_STREAM_MESSAGE), false)

  t.is(core.requiresChannel(core.KIND_STREAM_MESSAGE), true)
  t.is(core.requiresChannel(core.KIND_REACTION), false, 'reactions derive their channel from #e')
})

// ----------------------------------------------------------------- filters --

const EVENT = {
  id: 'aa'.repeat(32),
  pubkey: 'bb'.repeat(32),
  created_at: 1000,
  kind: 9,
  tags: [['h', 'chan-1'], ['e', 'cc'.repeat(32)], ['p', 'dd'.repeat(32)]],
  content: 'hello'
}

test('filter matching: ids, authors, kinds, time, tags', (t) => {
  t.is(core.filterMatches({}, EVENT), true, 'empty filter matches all')
  t.is(core.filterMatches({ ids: [EVENT.id] }, EVENT), true)
  t.is(core.filterMatches({ ids: ['aaaa'] }, EVENT), true, 'id prefix matching')
  t.is(core.filterMatches({ ids: ['abab'] }, EVENT), false)
  t.is(core.filterMatches({ authors: [EVENT.pubkey] }, EVENT), true)
  t.is(core.filterMatches({ authors: ['bbbb'] }, EVENT), true, 'author prefix matching')
  t.is(core.filterMatches({ kinds: [9] }, EVENT), true)
  t.is(core.filterMatches({ kinds: [7] }, EVENT), false)
  t.is(core.filterMatches({ since: 999 }, EVENT), true)
  t.is(core.filterMatches({ since: 1001 }, EVENT), false)
  t.is(core.filterMatches({ until: 1000 }, EVENT), true, 'until is inclusive')
  t.is(core.filterMatches({ until: 999 }, EVENT), false)
  t.is(core.filterMatches({ '#h': ['chan-1'] }, EVENT), true)
  t.is(core.filterMatches({ '#h': ['chan-2'] }, EVENT), false)
  t.is(core.filterMatches({ '#p': [EVENT.tags[2][1]] }, EVENT), true)
  t.is(core.filterMatches({ '#x': ['anything'] }, EVENT), false, 'absent tag never matches')
})

test('filter constraints AND within a filter', (t) => {
  t.is(core.filterMatches({ kinds: [9], '#h': ['chan-1'] }, EVENT), true)
  t.is(core.filterMatches({ kinds: [9], '#h': ['chan-2'] }, EVENT), false)
  t.is(core.filterMatches({ kinds: [7], '#h': ['chan-1'] }, EVENT), false)
})

test('filters OR across the list', (t) => {
  t.is(core.filtersMatch([{ kinds: [7] }, { kinds: [9] }], EVENT), true)
  t.is(core.filtersMatch([{ kinds: [7] }, { kinds: [1] }], EVENT), false)
  t.is(core.filtersMatch([], EVENT), false, 'no filters matches nothing')
})

test('the NIP-01 kinds edge case: [] matches nothing, absent matches all', (t) => {
  t.is(core.filterMatches({ kinds: [] }, EVENT), false, 'explicit empty array matches nothing')
  t.is(core.filterMatches({ '#h': ['chan-1'] }, EVENT), true, 'absent kinds matches all kinds')
  t.is(core.filterMatches({ '#h': [] }, EVENT), false, 'an empty tag filter also matches nothing')
})

test('normalizeFilter drops junk and preserves valid constraints', (t) => {
  const normalized = core.normalizeFilter({
    ids: ['abc', 42],
    kinds: [9, 'nine', 7],
    '#h': ['x'],
    '#toolong': ['y'],
    since: 5,
    limit: -1,
    search: 'query',
    nonsense: true
  })

  t.alike(normalized.ids, ['abc'])
  t.alike(normalized.kinds, [9, 7])
  t.alike(normalized['#h'], ['x'])
  t.absent('#toolong' in normalized, 'multi-character tag filters are not NIP-01')
  t.is(normalized.since, 5)
  t.absent('limit' in normalized, 'negative limit dropped')
  t.is(normalized.search, 'query')
  t.absent('nonsense' in normalized)

  t.is(core.normalizeFilter(null), null)
  t.is(core.normalizeFilter([]), null)
})

test('p-gated subscriptions require a self-only #p filter', (t) => {
  const me = 'aa'.repeat(32)
  const you = 'bb'.repeat(32)
  const reason = 'restricted: p-gated events require #p matching your pubkey'

  t.is(core.checkPGatedAuthorization([{ kinds: [core.KIND_GIFT_WRAP], '#p': [me] }], me), null)
  t.is(core.checkPGatedAuthorization([{ kinds: [core.KIND_STREAM_MESSAGE] }], me), null, 'ungated kind is fine')

  t.is(core.checkPGatedAuthorization([{ kinds: [core.KIND_GIFT_WRAP] }], me), reason, 'no #p')
  t.is(core.checkPGatedAuthorization([{ kinds: [core.KIND_GIFT_WRAP], '#p': [you] }], me), reason, "someone else's")
  t.is(
    core.checkPGatedAuthorization([{ kinds: [core.KIND_GIFT_WRAP], '#p': [me, you] }], me),
    reason,
    'every #p value must be mine'
  )
  t.is(core.checkPGatedAuthorization([{}], me), reason, 'a kindless filter can match gated kinds')
  t.is(
    core.checkPGatedAuthorization([{ ids: ['aa'.repeat(32)] }], me),
    null,
    'an id lookup is a point read, gated per event rather than at the filter'
  )
  t.is(
    core.checkPGatedAuthorization([{ kinds: [core.KIND_STREAM_MESSAGE] }, { kinds: [core.KIND_GIFT_WRAP] }], me),
    reason,
    'any offending filter in the list closes the subscription'
  )
})

// -------------------------------------------------------------------- tags --

test('tag accessors', (t) => {
  t.is(core.tagValue(EVENT, 'h'), 'chan-1')
  t.is(core.tagValue(EVENT, 'missing'), null)
  t.is(core.channelId(EVENT), 'chan-1')
  t.alike(core.referencedPubkeys(EVENT), [EVENT.tags[2][1]])
  t.alike(core.referencedEvents(EVENT), [EVENT.tags[1][1]])
  t.is(core.hasTag(EVENT, 'e'), true)
  t.is(core.countTags(EVENT, 'h'), 1)
  t.is(core.dTag({ tags: [['d', 'slug']] }), 'slug')
  t.is(core.dTag({ tags: [] }), '', 'a missing d tag addresses the empty coordinate')
})

test('NIP-10 thread references prefer markers over position', (t) => {
  const root = 'aa'.repeat(32)
  const parent = 'bb'.repeat(32)

  const marked = { tags: [['e', root, '', 'root'], ['e', parent, '', 'reply']] }
  t.alike(core.threadRefs(marked), { root, reply: parent })

  const positional = { tags: [['e', root], ['e', parent]] }
  t.alike(core.threadRefs(positional), { root, reply: parent })

  const single = { tags: [['e', root]] }
  t.alike(core.threadRefs(single), { root, reply: root })

  t.alike(core.threadRefs({ tags: [] }), { root: null, reply: null })

  const rootOnly = { tags: [['e', root, '', 'root']] }
  t.alike(core.threadRefs(rootOnly), { root, reply: root })
})

test('only single-letter tags are indexable', (t) => {
  const event = { tags: [['h', 'x'], ['e', 'y'], ['alt', 'z'], ['shared', 'true'], ['H', 'w']] }
  t.alike(core.indexableTags(event), [['h', 'x'], ['e', 'y'], ['H', 'w']])
})

// --------------------------------------------------------------------- net --

test('isPrivateIp covers the IPv4 ranges', (t) => {
  for (const address of [
    '0.0.0.0', '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '255.255.255.255'
  ]) {
    t.is(core.isPrivateIp(address), true, `${address} is private`)
  }

  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '11.0.0.1', '99.64.0.1']) {
    t.is(core.isPrivateIp(address), false, `${address} is public`)
  }
})

test('isPrivateIp covers the IPv6 ranges including IPv4-mapped', (t) => {
  for (const address of [
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '[::1]'
  ]) {
    t.is(core.isPrivateIp(address), true, `${address} is private`)
  }

  for (const address of ['2606:4700::1111', '::ffff:8.8.8.8']) {
    t.is(core.isPrivateIp(address), false, `${address} is public`)
  }
})

test('isPrivateIp fails closed on garbage and passes hostnames through', (t) => {
  t.is(core.isPrivateIp(''), true)
  t.is(core.isPrivateIp(null), true)
  t.is(core.isPrivateIp('999.1.1.1'), false, 'not an IP literal — caller must resolve it')
  t.is(core.isPrivateIp('example.com'), false, 'hostname needs resolution before the check')
  t.is(core.isPrivateIp(':::::'), true, 'malformed IPv6 fails closed')
})
