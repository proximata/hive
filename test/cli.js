'use strict'

const test = require('brittle')
const core = require('hive-core')

const { openStore } = require('hive-store')
const { Relay, WebSocketTransport, MediaStore } = require('hive-relay')
const { run } = require('hive-cli')

const { identity } = require('./helpers')

// The CLI is the interface agents actually use, so these tests drive the real
// command surface against a real relay and assert on the exact JSON and exit
// codes a caller would see.

async function harness (t) {
  const os = require('bare-os')
  const path = require('bare-path')

  const store = openStore(':memory:')
  const relay = new Relay(store, { url: 'ws://127.0.0.1' })
  const mediaDir = path.join(os.tmpdir(), `hive-media-${Date.now()}`)
  const transport = new WebSocketTransport(relay, { port: 0, mediaStore: new MediaStore(mediaDir) })

  await transport.listen()

  t.teardown(async () => {
    relay.close()
    await transport.close()
    store.close()
  })

  const url = `http://127.0.0.1:${transport.port}`

  /** Invoke the CLI exactly as a shell would, returning parsed output. */
  const cli = async (who, argv, { stdin = null } = {}) => {
    const result = await run(argv, {
      env: { HIVE_RELAY_URL: url, HIVE_PRIVATE_KEY: who?.secretKeyHex },
      readStdin: async () => stdin
    })

    return {
      ...result,
      out: result.stdout === '' ? null : JSON.parse(result.stdout),
      err: result.stderr.startsWith('{') ? JSON.parse(result.stderr) : null
    }
  }

  return { store, relay, transport, url, cli }
}

// ---------------------------------------------------------------- contract --

test('every command prints JSON on stdout and exits 0', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const result = await h.cli(alice, ['relay', 'key'])
  t.is(result.exitCode, 0)
  t.is(result.stderr, '')
  t.is(result.out.pubkey, alice.pubkey)
  t.ok(result.out.npub.startsWith('npub1'))
})

test('exit codes match the buzz-cli contract', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  // 1 = user error
  const badUuid = await h.cli(alice, ['messages', 'get', '--channel', 'not-a-uuid'])
  t.is(badUuid.exitCode, 1)
  t.is(badUuid.stdout, '', 'nothing on stdout when a command fails')
  t.is(badUuid.err.error, 'user')
  t.ok(badUuid.err.message.includes('must be a UUID'))

  const unknown = await h.cli(alice, ['messages', 'teleport'])
  t.is(unknown.exitCode, 1)
  t.ok(unknown.err.message.includes('unknown subcommand'))

  // 2 = network
  const offline = await run(['channels', 'list'], {
    env: { HIVE_RELAY_URL: 'http://127.0.0.1:1', HIVE_PRIVATE_KEY: alice.secretKeyHex }
  })
  t.is(offline.exitCode, 2)
  t.is(JSON.parse(offline.stderr).error, 'network')

  // 3 = auth
  const noKey = await run(['channels', 'list'], { env: { HIVE_RELAY_URL: h.url } })
  t.is(noKey.exitCode, 3)
  t.is(JSON.parse(noKey.stderr).error, 'auth')
  t.ok(JSON.parse(noKey.stderr).message.includes('HIVE_PRIVATE_KEY'))
})

test('BUZZ_ environment variables work as aliases', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const result = await run(['relay', 'key'], {
    env: { BUZZ_RELAY_URL: h.url, BUZZ_PRIVATE_KEY: alice.secretKeyHex }
  })
  t.is(result.exitCode, 0)
  t.is(JSON.parse(result.stdout).pubkey, alice.pubkey)
})

test('keys are accepted in nsec and hex form', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  for (const key of [alice.secretKeyHex, core.encodeNsec(alice.secretKey)]) {
    const result = await run(['relay', 'key'], { env: { HIVE_RELAY_URL: h.url, HIVE_PRIVATE_KEY: key } })
    t.is(JSON.parse(result.stdout).pubkey, alice.pubkey)
  }

  const wrongType = await run(['relay', 'key'], {
    env: { HIVE_RELAY_URL: h.url, HIVE_PRIVATE_KEY: core.encodeNpub(alice.pubkey) }
  })
  t.is(wrongType.exitCode, 3, 'an npub is not a secret key')
})

test('hyper:// relays are rejected with an explanation, not a timeout', async (t) => {
  const alice = identity('alice')
  const result = await run(['channels', 'list'], {
    env: { HIVE_RELAY_URL: 'hyper://' + 'ab'.repeat(32), HIVE_PRIVATE_KEY: alice.secretKeyHex }
  })

  t.is(result.exitCode, 1)
  t.ok(JSON.parse(result.stderr).message.includes('agent harness'))
})

// ---------------------------------------------------------------- channels --

test('channels create, list, get, topic', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const created = await h.cli(alice, [
    'channels', 'create', '--name', 'engineering', '--type', 'stream', '--visibility', 'open'
  ])
  t.is(created.exitCode, 0)
  t.is(created.out.name, 'engineering')
  t.ok(created.out.id, 'the created channel id is returned, not just the command event')

  const id = created.out.id

  const listed = await h.cli(alice, ['channels', 'list'])
  t.is(listed.out.length, 1)
  t.is(listed.out[0].id, id)

  const got = await h.cli(alice, ['channels', 'get', '--channel', id])
  t.is(got.out.name, 'engineering')

  const topic = await h.cli(alice, ['channels', 'topic', '--channel', id, '--topic', 'shipping v2'])
  t.is(topic.out.topic, 'shipping v2')

  const members = await h.cli(alice, ['channels', 'members', '--channel', id])
  t.is(members.out.length, 1)
  t.is(members.out[0].role, 'owner')
})

test('channels create validates its flags', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const noName = await h.cli(alice, ['channels', 'create'])
  t.is(noName.exitCode, 1)
  t.ok(noName.err.message.includes('--name is required'))

  const badVisibility = await h.cli(alice, ['channels', 'create', '--name', 'x', '--visibility', 'sideways'])
  t.is(badVisibility.exitCode, 1)
  t.ok(badVisibility.err.message.includes('must be one of'))
})

test('add-member and remove-member accept hex and npub', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const created = await h.cli(alice, ['channels', 'create', '--name', 'team', '--visibility', 'private'])
  const id = created.out.id

  const added = await h.cli(alice, [
    'channels', 'add-member', '--channel', id, '--pubkey', core.encodeNpub(bob.pubkey)
  ])
  t.is(added.exitCode, 0)
  t.is(added.out.length, 2)
  t.ok(added.out.some((m) => m.pubkey === bob.pubkey), 'npub was decoded to hex')

  const removed = await h.cli(alice, ['channels', 'remove-member', '--channel', id, '--pubkey', bob.pubkey])
  t.is(removed.out.length, 1)
})

test('a non-member gets exit code 3 for a private channel', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const eve = identity('eve')

  const created = await h.cli(alice, ['channels', 'create', '--name', 'secret', '--visibility', 'private'])

  const denied = await h.cli(eve, ['channels', 'get', '--channel', created.out.id])
  t.is(denied.exitCode, 3)
  t.is(denied.err.error, 'auth')
})

// ---------------------------------------------------------------- messages --

test('messages send, get, thread and search', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const created = await h.cli(alice, ['channels', 'create', '--name', 'general'])
  const id = created.out.id

  const sent = await h.cli(alice, ['messages', 'send', '--channel', id, '--content', 'the deploy is green'])
  t.is(sent.exitCode, 0)
  t.is(sent.out.kind, core.KIND_STREAM_MESSAGE)
  t.is(sent.out.content, 'the deploy is green')
  t.is(core.tagValue(sent.out, 'h'), id)

  const reply = await h.cli(alice, [
    'messages', 'send', '--channel', id, '--content', 'confirmed', '--reply-to', sent.out.id
  ])
  t.is(reply.exitCode, 0)

  const got = await h.cli(alice, ['messages', 'get', '--channel', id])
  t.is(got.out.length, 2)

  const thread = await h.cli(alice, ['messages', 'thread', '--event', sent.out.id])
  t.is(thread.out.root.id, sent.out.id)
  t.is(thread.out.replies.length, 1)
  t.is(thread.out.replies[0].id, reply.out.id)

  const found = await h.cli(alice, ['messages', 'search', '--query', 'deploy'])
  t.is(found.out.length, 1)
  t.is(found.out[0].id, sent.out.id)

  const missing = await h.cli(alice, ['messages', 'search', '--query', 'unicorn'])
  t.is(missing.out.length, 0, 'no matches is an empty array, not an error')
})

test('a content argument of "-" reads stdin', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const created = await h.cli(alice, ['channels', 'create', '--name', 'general'])
  const body = '# Release notes\n\nEverything shipped.'

  const sent = await h.cli(
    alice,
    ['messages', 'send', '--channel', created.out.id, '--content', '-'],
    { stdin: body }
  )
  t.is(sent.exitCode, 0)
  t.is(sent.out.content, body, 'multi-line stdin survives intact')

  const empty = await h.cli(
    alice,
    ['messages', 'send', '--channel', created.out.id, '--content', '-'],
    { stdin: '' }
  )
  t.is(empty.exitCode, 1)
  t.ok(empty.err.message.includes('stdin was empty'))
})

test('send-diff carries repo and commit metadata', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const created = await h.cli(alice, ['channels', 'create', '--name', 'code'])
  const diff = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n'

  const sent = await h.cli(
    alice,
    ['messages', 'send-diff', '--channel', created.out.id, '--diff', '-',
      '--repo', 'https://github.com/org/repo', '--commit', 'abc123'],
    { stdin: diff }
  )

  t.is(sent.exitCode, 0)
  t.is(sent.out.kind, core.KIND_STREAM_MESSAGE_DIFF)
  t.is(core.tagValue(sent.out, 'repo'), 'https://github.com/org/repo')
  t.is(core.tagValue(sent.out, 'commit'), 'abc123')
  t.is(sent.out.content, diff)
})

test('edit and delete a message', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const created = await h.cli(alice, ['channels', 'create', '--name', 'general'])
  const sent = await h.cli(alice, ['messages', 'send', '--channel', created.out.id, '--content', 'typo'])

  const edited = await h.cli(alice, [
    'messages', 'edit', '--channel', created.out.id, '--event', sent.out.id, '--content', 'fixed'
  ])
  t.is(edited.out.kind, core.KIND_STREAM_MESSAGE_EDIT)

  const deleted = await h.cli(alice, ['messages', 'delete', '--event', sent.out.id])
  t.is(deleted.exitCode, 0)

  const remaining = await h.cli(alice, ['messages', 'get', '--channel', created.out.id])
  t.absent(remaining.out.some((e) => e.id === sent.out.id), 'the deleted message is gone')
})

// --------------------------------------------------------------- reactions --

test('reactions add and get', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const created = await h.cli(alice, ['channels', 'create', '--name', 'general'])
  const sent = await h.cli(alice, ['messages', 'send', '--channel', created.out.id, '--content', 'ship it'])

  const reacted = await h.cli(alice, ['reactions', 'add', '--event', sent.out.id, '--emoji', '🚀'])
  t.is(reacted.exitCode, 0)
  t.is(reacted.out.content, '🚀')

  const listed = await h.cli(alice, ['reactions', 'get', '--event', sent.out.id])
  t.is(listed.out.length, 1)
  t.is(listed.out[0].content, '🚀')
})

// ------------------------------------------------------------------ canvas --

test('canvas set and get', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const created = await h.cli(alice, ['channels', 'create', '--name', 'design'])

  const empty = await h.cli(alice, ['canvas', 'get', '--channel', created.out.id])
  t.is(empty.out.content, '')

  const set = await h.cli(alice, [
    'canvas', 'set', '--channel', created.out.id, '--content', '# Welcome\n\nStart here.'
  ])
  t.is(set.out.content, '# Welcome\n\nStart here.')

  const got = await h.cli(alice, ['canvas', 'get', '--channel', created.out.id])
  t.is(got.out.content, '# Welcome\n\nStart here.')
})

// -------------------------------------------------------------------- DMs --

test('dms open creates a hidden channel both participants can see', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const opened = await h.cli(alice, ['dms', 'open', '--pubkey', bob.pubkey])
  t.is(opened.exitCode, 0)
  t.is(opened.out.type, 'dm')
  t.is(opened.out.visibility, 'private')

  const aliceList = await h.cli(alice, ['dms', 'list'])
  t.is(aliceList.out.length, 1)

  const bobList = await h.cli(bob, ['dms', 'list'])
  t.is(bobList.out.length, 1, 'the other participant was added as a member')
  t.is(bobList.out[0].id, opened.out.id)

  // Opening the same conversation again converges rather than forking.
  const again = await h.cli(alice, ['dms', 'open', '--pubkey', bob.pubkey])
  t.is(again.out.id, opened.out.id)

  const tooMany = await h.cli(alice, ['dms', 'open'])
  t.is(tooMany.exitCode, 1)
})

// ------------------------------------------------------------------ users --

test('profile, presence and status', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const profile = await h.cli(alice, ['users', 'set-profile', '--display-name', 'Alice', '--about', 'builder'])
  t.is(profile.exitCode, 0)
  t.is(profile.out[0].displayName, 'Alice')

  const presence = await h.cli(alice, ['users', 'set-presence', '--status', 'online'])
  t.is(presence.out.status, 'online')

  const read = await h.cli(alice, ['users', 'presence'])
  t.is(read.out[0].presence, 'online')

  const bad = await h.cli(alice, ['users', 'set-presence', '--status', 'transcendent'])
  t.is(bad.exitCode, 1)

  const status = await h.cli(alice, ['users', 'set-status', '--text', 'heads down', '--emoji', '🚀'])
  t.is(status.out.content, 'heads down')
})

test('users get batches lookups', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  await h.cli(bob, ['users', 'set-profile', '--display-name', 'Bob'])

  const batch = await h.cli(alice, ['users', 'get', '--pubkey', alice.pubkey, '--pubkey', bob.pubkey])
  t.is(batch.out.length, 2)
  t.ok(batch.out.some((u) => u.displayName === 'Bob'))

  const own = await h.cli(alice, ['users', 'get'])
  t.is(own.out.length, 1)
  t.is(own.out[0].pubkey, alice.pubkey)
})

// ----------------------------------------------------------------- agents --

/** Seed two agents and a plain human, which is the only interesting case. */
async function seedAgents (h) {
  const bot = identity('bot')
  const scribe = identity('scribe')
  const human = identity('human')

  await h.cli(human, ['users', 'set-profile', '--display-name', 'Human'])
  await h.cli(bot, ['users', 'set-agent-profile',
    '--persona', 'honey', '--runtime', 'claude-code',
    '--description', 'reviews pull requests and triages bugs',
    '--capability', 'code', '--capability', 'text-generation',
    '--owner', human.pubkey])
  await h.cli(scribe, ['users', 'set-agent-profile',
    '--persona', 'scribe', '--runtime', 'qvac',
    '--description', 'turns meeting audio into notes',
    '--capability', 'transcription'])

  return { bot, scribe, human }
}

test('agents list returns declared machines only', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const { bot, scribe, human } = await seedAgents(h)

  const all = await h.cli(alice, ['agents', 'list'])
  t.is(all.exitCode, 0)
  t.is(all.out.length, 2)
  t.absent(all.out.some((a) => a.pubkey === human.pubkey), 'a kind-0 profile is not an agent')

  const honey = all.out.find((a) => a.pubkey === bot.pubkey)
  t.is(honey.persona, 'honey')
  t.is(honey.runtime, 'claude-code')
  t.is(honey.description, 'reviews pull requests and triages bugs')
  t.alike(honey.capabilities, ['code', 'text-generation'])

  const self = all.out.find((a) => a.pubkey === scribe.pubkey)
  t.is(self.ownerClaimed, null, 'a self-owned profile reports no owner')
})

test('an owner is reported as a claim, never as a verified fact', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const { bot, human } = await seedAgents(h)

  const got = await h.cli(alice, ['agents', 'get', '--pubkey', bot.pubkey])
  t.is(got.out.ownerClaimed, human.pubkey)
  t.is(got.out.ownerVerified, false, 'nothing verifies the owner consented')
  t.absent('owner' in got.out, 'no bare `owner` field a caller could read as fact')
})

test('agents find matches capabilities exactly, never by substring', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const { bot, scribe } = await seedAgents(h)

  const code = await h.cli(alice, ['agents', 'find', '--capability', 'code'])
  t.is(code.out.length, 1)
  t.is(code.out[0].pubkey, bot.pubkey)

  // 'cod' is a substring of 'code' and must match nothing; 'CODE' must match,
  // because the comparison is case-folded and not case-sensitive.
  const substring = await h.cli(alice, ['agents', 'find', '--capability', 'cod'])
  t.is(substring.out.length, 0)
  const folded = await h.cli(alice, ['agents', 'find', '--capability', 'CODE'])
  t.is(folded.out.length, 1)

  // Several capabilities are an AND, not an OR.
  const both = await h.cli(alice, ['agents', 'find',
    '--capability', 'code', '--capability', 'transcription'])
  t.is(both.out.length, 0)

  const scribed = await h.cli(alice, ['agents', 'find', '--capability', 'transcription'])
  t.is(scribed.out[0].pubkey, scribe.pubkey)

  const empty = await h.cli(alice, ['agents', 'find'])
  t.is(empty.exitCode, 1)
  t.is(empty.err.error, 'user')
})

test('agents find free-text is token-AND over the search index', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const { scribe } = await seedAgents(h)

  const hit = await h.cli(alice, ['agents', 'find', '--query', 'meeting audio'])
  t.is(hit.out.length, 1)
  t.is(hit.out[0].pubkey, scribe.pubkey)

  // Every token must be present: one unmatched word drops the hit entirely,
  // which is what makes this AND rather than OR.
  const miss = await h.cli(alice, ['agents', 'find', '--query', 'meeting unicorn'])
  t.is(miss.out.length, 0)
})

test('agents get says plainly when a pubkey is not an agent', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const { human } = await seedAgents(h)

  const person = await h.cli(alice, ['agents', 'get', '--pubkey', human.pubkey])
  t.is(person.exitCode, 0)
  t.is(person.out.agent, false)
  t.is(person.out.displayName, 'Human')
  t.ok(person.out.reason.includes('10100'))

  // A pubkey the relay has never seen answers with a bare {pubkey}; the verb
  // must null-guard it rather than crash or invent a name.
  const stranger = identity('stranger')
  const unknown = await h.cli(alice, ['agents', 'get', '--pubkey', stranger.pubkey])
  t.is(unknown.exitCode, 0)
  t.is(unknown.out.agent, false)
  t.is(unknown.out.displayName, null)

  const bad = await h.cli(alice, ['agents', 'get', '--pubkey', 'not-a-key'])
  t.is(bad.exitCode, 1)
  t.is(bad.err.error, 'user')
})

// ------------------------------------------------------------------- feed --

test('the feed shows mentions', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const created = await h.cli(alice, ['channels', 'create', '--name', 'general'])
  await h.cli(bob, ['channels', 'join', '--channel', created.out.id])

  await h.cli(bob, [
    'messages', 'send', '--channel', created.out.id, '--content', 'ping @alice', '--mention', alice.pubkey
  ])

  const feed = await h.cli(alice, ['feed', 'get'])
  t.is(feed.out.length, 1)
  t.is(feed.out[0].content, 'ping @alice')

  t.is((await h.cli(bob, ['feed', 'get'])).out.length, 0)
})

// ----------------------------------------------------------------- social --

test('social publish, notes and contacts', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const note = await h.cli(alice, ['social', 'publish', '--content', 'hello nostr'])
  t.is(note.out.kind, core.KIND_TEXT_NOTE)

  const notes = await h.cli(alice, ['social', 'notes', '--pubkey', alice.pubkey])
  t.is(notes.out.length, 1)

  await h.cli(alice, ['social', 'set-contacts', '--pubkey', bob.pubkey])
  const contacts = await h.cli(alice, ['social', 'contacts', '--pubkey', alice.pubkey])
  t.is(contacts.out.length, 1)
  t.alike(core.referencedPubkeys(contacts.out[0]), [bob.pubkey])

  const byId = await h.cli(alice, ['social', 'event', '--event', note.out.id])
  t.is(byId.out.id, note.out.id)

  const missing = await h.cli(alice, ['social', 'event', '--event', 'ff'.repeat(32)])
  t.is(missing.exitCode, 1)
})

// ------------------------------------------------------------------ repos --

test('repos announce, get and list (NIP-34 event surface)', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')

  const created = await h.cli(alice, [
    'repos', 'create', '--id', 'hive', '--name', 'Hive',
    '--description', 'the relay', '--clone', 'https://example.com/hive.git'
  ])
  t.is(created.exitCode, 0)
  t.is(created.out.kind, core.KIND_GIT_REPO_ANNOUNCEMENT)
  t.is(core.dTag(created.out), 'hive')

  const got = await h.cli(alice, ['repos', 'get', '--id', 'hive'])
  t.is(got.out.id, created.out.id)

  const listed = await h.cli(alice, ['repos', 'list'])
  t.is(listed.out.length, 1)

  const missing = await h.cli(alice, ['repos', 'get', '--id', 'nope'])
  t.is(missing.exitCode, 1)
})

// -------------------------------------------------------------------- mem --

test('agent memory set, get, hash, ls and rm', async (t) => {
  const h = await harness(t)
  const agent = identity('agent')

  const set = await h.cli(agent, ['mem', 'set', 'mem/preferences', 'terse replies'])
  t.is(set.exitCode, 0)
  t.is(core.dTag(set.out), 'mem/preferences')

  const got = await h.cli(agent, ['mem', 'get', 'mem/preferences'])
  t.is(got.out.content, 'terse replies')

  const hashed = await h.cli(agent, ['mem', 'hash', 'mem/preferences'])
  t.is(hashed.out.hash, core.toHex(core.sha256(Buffer.from('terse replies'))))

  const piped = await h.cli(agent, ['mem', 'set', 'mem/notes', '-'], { stdin: 'from stdin' })
  t.is(piped.out.content, 'from stdin')

  const listed = await h.cli(agent, ['mem', 'ls'])
  t.is(listed.out.length, 2)

  // Parameterized-replaceable: writing the same slug replaces rather than adds.
  await h.cli(agent, ['mem', 'set', 'mem/preferences', 'even terser'])
  t.is((await h.cli(agent, ['mem', 'ls'])).out.length, 2)
  t.is((await h.cli(agent, ['mem', 'get', 'mem/preferences'])).out.content, 'even terser')

  await h.cli(agent, ['mem', 'rm', 'mem/notes'])
  t.is((await h.cli(agent, ['mem', 'ls'])).out.length, 1)

  const missing = await h.cli(agent, ['mem', 'get', 'mem/nothing'])
  t.is(missing.exitCode, 1)
})

test('one agent cannot read another agent’s memory', async (t) => {
  const h = await harness(t)
  const agent = identity('agent')
  const nosy = identity('nosy')

  await h.cli(agent, ['mem', 'set', 'mem/secret', 'the plan'])

  // `mem get` scopes to the caller's own pubkey, so a different agent finds
  // nothing at the same slug.
  const attempt = await h.cli(nosy, ['mem', 'get', 'mem/secret'])
  t.is(attempt.exitCode, 1)
  t.ok(attempt.err.message.includes('no memory'))
})

// ------------------------------------------------------------------ audit --

test('audit verify reports an intact chain, and a broken one', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  // Chain verification is a full scan and is gated to the relay's own key.
  const operator = { secretKeyHex: core.toHex(h.relay.secretKey) }

  await h.cli(alice, ['channels', 'create', '--name', 'general'])

  const intact = await h.cli(operator, ['audit', 'verify'])
  t.is(intact.out.ok, true)
  t.is(intact.out.brokenAt, null)

  // An ordinary key is told why, rather than being shown a null that reads
  // like an intact chain.
  const refused = await h.cli(alice, ['audit', 'verify'])
  t.is(refused.exitCode, 1)
  t.ok(refused.err.message.includes('operator-only'))

  const listed = await h.cli(alice, ['audit', 'list', '--limit', '10'])
  t.ok(listed.out.length > 0)
  t.ok(listed.out.some((entry) => entry.action === 'ChannelCreated'))

  // Tamper directly with the database, as an attacker with disk access would.
  h.store.db.prepare("UPDATE audit_log SET actor = 'someone-else' WHERE seq = 2").run()

  const broken = await h.cli(operator, ['audit', 'verify'])
  t.is(broken.out.ok, false)
  t.is(broken.out.brokenAt, 2)
})

// ----------------------------------------------------------------- upload --

test('upload file stores a blob and returns its address', async (t) => {
  const h = await harness(t)
  const fs = require('bare-fs')
  const os = require('bare-os')
  const path = require('bare-path')

  const alice = identity('alice')
  const file = path.join(os.tmpdir(), `hive-upload-${Date.now()}.txt`)
  fs.writeFileSync(file, 'attachment contents')
  t.teardown(() => {
    try {
      fs.unlinkSync(file)
    } catch {}
  })

  const uploaded = await h.cli(alice, ['upload', 'file', '--path', file])
  t.is(uploaded.exitCode, 0)
  t.is(uploaded.out.sha256, core.toHex(core.sha256(Buffer.from('attachment contents'))))
  t.is(uploaded.out.size, 19)
  t.ok(uploaded.out.url.includes(uploaded.out.sha256))

  const missing = await h.cli(alice, ['upload', 'file', '--path', '/no/such/file'])
  t.is(missing.exitCode, 1)
})

// ------------------------------------------------------------------ usage --

test('no arguments prints usage and exits 1', async (t) => {
  const result = await run([], { env: {} })
  t.is(result.exitCode, 1)
  t.ok(result.stderr.includes('hive <group> <subcommand>'))

  const help = await run(['--help'], { env: {} })
  t.is(help.exitCode, 0)
  t.ok(help.stderr.includes('exit:   0=ok'))
})
