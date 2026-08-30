'use strict'

const test = require('brittle')
const core = require('hive-core')
const { events } = require('hive-sdk')

const { openStore } = require('hive-store')
const { Relay, WebSocketTransport } = require('hive-relay')
const { Agent, MockProvider, RelayConnection, providerFromPersona, CAPABILITIES } = require('hive-agent')

const { identity, sign } = require('./helpers')

async function harness (t) {
  const store = openStore(':memory:')
  const relay = new Relay(store, { url: 'ws://127.0.0.1' })
  const transport = new WebSocketTransport(relay, { port: 0 })

  await transport.listen()

  const opened = []
  const connect = async (who) => {
    const connection = new RelayConnection({
      url: `ws://127.0.0.1:${transport.port}`,
      secretKey: who.secretKey,
      reconnect: false
    })
    await connection.connect()
    opened.push(connection)
    return connection
  }

  t.teardown(async () => {
    for (const connection of opened) await connection.close()
    relay.close()
    await transport.close()
    store.close()
  })

  return { store, relay, transport, connect, port: transport.port }
}

/** Wait for an emitter event, with a useful failure instead of a hang. */
function once (emitter, name, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${name}"`)), timeout)
    emitter.once(name, (...args) => {
      clearTimeout(timer)
      resolve(args)
    })
  })
}

// ------------------------------------------------------------ attestation --

test('NIP-OA attestation round-trips and binds to the agent key', (t) => {
  const owner = identity('owner')
  const agent = identity('agent')

  const tag = core.createAttestation({
    ownerSecretKey: owner.secretKey,
    ownerPubkey: owner.pubkey,
    agentPubkey: agent.pubkey
  })

  t.is(tag.length, 4)
  t.is(tag[0], 'auth')
  t.is(tag[1], owner.pubkey)

  const event = sign(agent, { kind: 1, tags: [tag], content: 'acting for my owner' })
  const result = core.verifyAttestation(event)

  t.is(result.ok, true)
  t.is(result.owner, owner.pubkey)
  t.is(event.pubkey, agent.pubkey, 'the event is still authored by the agent, not the owner')
})

test('an attestation minted for one agent does not work for another', (t) => {
  const owner = identity('owner')
  const agent = identity('agent')
  const impostor = identity('impostor')

  const tag = core.createAttestation({
    ownerSecretKey: owner.secretKey,
    ownerPubkey: owner.pubkey,
    agentPubkey: agent.pubkey
  })

  const stolen = sign(impostor, { kind: 1, tags: [tag], content: 'I am authorized, honest' })
  const result = core.verifyAttestation(stolen)

  t.is(result.ok, false)
  t.ok(result.reason.includes('invalid attestation signature'))
})

test('malformed attestations are rejected', (t) => {
  const owner = identity('owner')
  const agent = identity('agent')
  const good = core.createAttestation({
    ownerSecretKey: owner.secretKey,
    ownerPubkey: owner.pubkey,
    agentPubkey: agent.pubkey
  })

  const cases = [
    [[], 'absent'],
    [[good, good], 'more than one'],
    [[['auth', owner.pubkey, '']], 'exactly four'],
    [[['auth', 'nothex', '', 'f'.repeat(128)]], 'owner pubkey'],
    [[['auth', owner.pubkey, '', 'short']], 'signature must be']
  ]

  for (const [tags, expected] of cases) {
    const event = sign(agent, { kind: 1, tags, content: 'x' })
    const result = core.verifyAttestation(event)
    t.is(result.ok, false)
    t.ok(result.reason.includes(expected), `${JSON.stringify(tags)} → ${result.reason}`)
  }
})

test('attestation conditions are enforced and unknown ones fail closed', (t) => {
  const owner = identity('owner')
  const agent = identity('agent')

  const mint = (conditions) => core.createAttestation({
    ownerSecretKey: owner.secretKey,
    ownerPubkey: owner.pubkey,
    agentPubkey: agent.pubkey,
    conditions
  })

  const kindBound = sign(agent, { kind: 9, tags: [mint('kind=9')], content: 'ok' })
  t.is(core.verifyAttestation(kindBound).ok, true)

  const wrongKind = sign(agent, { kind: 1, tags: [mint('kind=9')], content: 'nope' })
  t.is(core.verifyAttestation(wrongKind).ok, false)
  t.ok(core.verifyAttestation(wrongKind).reason.includes('condition not met'))

  const expired = sign(agent, {
    kind: 1,
    created_at: 2000,
    tags: [mint('created_at<1000')],
    content: 'stale'
  })
  t.is(core.verifyAttestation(expired).ok, false)

  const unknown = sign(agent, { kind: 1, tags: [mint('phase_of_moon=waxing')], content: 'x' })
  const result = core.verifyAttestation(unknown)
  t.is(result.ok, false)
  t.ok(result.reason.includes('unsupported condition'), 'restrictions we cannot evaluate are not ignored')
})

// -------------------------------------------------------------- providers --

test('the mock provider is deterministic and streams', async (t) => {
  const provider = new MockProvider()

  const run = provider.complete({ history: [{ role: 'user', content: 'summarize the outage' }] })

  let streamed = ''
  let deltas = 0
  for await (const event of run.events) {
    if (event.type === 'contentDelta') {
      streamed += event.text
      deltas++
    }
  }

  const final = await run.final
  t.is(streamed, final.content, 'the stream reassembles into the final content')
  t.ok(deltas > 1, 'it actually streams rather than emitting one blob')
  t.ok(final.content.includes('summarize the outage'))

  const again = new MockProvider().complete({ history: [{ role: 'user', content: 'summarize the outage' }] })
  t.is((await again.final).content, final.content, 'same input, same output')
})

test('provider capabilities are advertised', async (t) => {
  const provider = new MockProvider()
  const capabilities = await provider.capabilities()

  t.ok(capabilities.includes(CAPABILITIES.TEXT_GENERATION))
  t.ok(capabilities.includes(CAPABILITIES.EMBEDDINGS))

  const vectors = await provider.embed(['hello', 'world'])
  t.is(vectors.length, 2)
  t.is(vectors[0].length, 8)
})

test('unsupported capabilities fail with a clear message', async (t) => {
  const provider = new MockProvider()
  await t.exception(provider.transcribe(Buffer.alloc(0)), /does not support transcription/)
  await t.exception(provider.speak('hi'), /does not support speech synthesis/)
})

test('a persona selects its provider by runtime', (t) => {
  const mock = providerFromPersona({ runtime: 'mock', model: 'mock-1', system_prompt: 'be terse' })
  t.is(mock.constructor.name, 'MockProvider')
  t.is(mock.systemPrompt, 'be terse')

  const qvac = providerFromPersona({
    runtime: 'qvac',
    model: 'LLAMA_3_2_1B_INST_Q4_0',
    system_prompt: 'review diffs',
    provider: 'ab'.repeat(32)
  })
  t.is(qvac.constructor.name, 'QvacProvider')
  t.is(qvac.modelSrc, 'LLAMA_3_2_1B_INST_Q4_0')
  t.is(qvac.delegate.providerPublicKey, 'ab'.repeat(32), 'a named provider becomes a delegation target')

  t.exception(() => providerFromPersona({ runtime: 'telepathy' }), /unknown persona runtime/)
})

test('the QVAC provider explains itself when the SDK is absent', async (t) => {
  const { QvacProvider } = require('hive-agent')
  const provider = new QvacProvider({ model: 'LLAMA_3_2_1B_INST_Q4_0' })

  // @qvac/sdk is optional. This used to assert that provider.ready() rejects,
  // which only held while the SDK was uninstalled: the moment it landed, the
  // case failed. A test that passes only when the dependency is absent is
  // testing the machine, not the code. Drive the fallback module directly
  // instead, so the absent path is asserted whether or not the SDK is present.
  t.exception(() => require('../packages/hive-agent/lib/qvac-absent.js'), /@qvac\/sdk is not installed/)

  // With an injected SDK the adapter drives the documented API shape.
  const calls = []
  const fake = {
    loadModel: async (params) => {
      calls.push(['loadModel', params])
      return 'model-1'
    },
    completion: (params) => {
      calls.push(['completion', params])
      return {
        events: (async function * () {
          yield { type: 'contentDelta', text: 'delegated ' }
          yield { type: 'contentDelta', text: 'reply' }
        })(),
        final: Promise.resolve({ content: 'delegated reply', model: 'model-1' })
      }
    },
    unloadModel: async () => {}
  }

  const injected = new QvacProvider({
    model: 'LLAMA_3_2_1B_INST_Q4_0',
    systemPrompt: 'be helpful',
    delegate: { providerPublicKey: 'cd'.repeat(32) },
    sdk: fake
  })

  const run = injected.complete({ history: [{ role: 'user', content: 'hello' }] })
  let text = ''
  for await (const event of run.events) {
    if (event.type === 'contentDelta') text += event.text
  }
  t.is(text, 'delegated reply')

  const [name, params] = calls[0]
  t.is(name, 'loadModel')
  t.is(params.modelSrc, 'LLAMA_3_2_1B_INST_Q4_0')
  t.is(params.delegate.providerPublicKey, 'cd'.repeat(32))
  t.is(params.delegate.timeout, 60000, 'a generous first-call timeout for a cold DHT')
  t.is(params.delegate.fallbackToLocal, true)

  const completionParams = calls[1][1]
  t.is(completionParams.history[0].role, 'system', 'the persona system prompt is prepended')
  t.is(completionParams.history[0].content, 'be helpful')
})

// ---------------------------------------------------------------- harness --

test('an agent publishes a capability profile on start', async (t) => {
  const h = await harness(t)
  const owner = identity('owner')
  const bot = identity('bot')

  const agent = new Agent({
    secretKey: bot.secretKey,
    owner: owner.pubkey,
    persona: { slug: 'honey', display_name: 'Honey', runtime: 'mock', model: 'mock-1' },
    description: 'reviews pull requests and triages bugs',
    connection: await h.connect(bot)
  })
  t.teardown(() => agent.stop())

  await agent.start()

  const stored = h.store.queryEvents([{ kinds: [core.KIND_AGENT_PROFILE], authors: [bot.pubkey] }])
  t.is(stored.length, 1)

  const profile = JSON.parse(stored[0].event.content)
  t.is(profile.owner, owner.pubkey)
  t.is(profile.persona, 'honey')
  t.is(profile.runtime, 'mock')
  t.ok(profile.capabilities.includes('text-generation'))
  t.alike(profile.models, ['mock-1'])
  // Without this, every agent the harness publishes is invisible to
  // `hive agents find --query` — the discovery verbs read this field.
  t.is(profile.description, 'reviews pull requests and triages bugs')
})

test('a persona description reaches the published profile', async (t) => {
  const h = await harness(t)
  const bot = identity('bot')

  const agent = new Agent({
    secretKey: bot.secretKey,
    persona: { slug: 'scribe', display_name: 'Scribe', runtime: 'mock', description: 'turns meeting audio into notes' },
    connection: await h.connect(bot)
  })
  t.teardown(() => agent.stop())
  await agent.start()

  const stored = h.store.queryEvents([{ kinds: [core.KIND_AGENT_PROFILE], authors: [bot.pubkey] }])
  t.is(JSON.parse(stored[0].event.content).description, 'turns meeting audio into notes')
})

test('an agent answers a mention and records the job lifecycle', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bot = identity('bot')

  const human = await h.connect(alice)

  // Alice opens a channel and invites the agent, exactly as she would a person.
  const create = events.createChannel(alice.secretKey, { name: 'engineering', visibility: 'open' })
  await human.publish(create)
  const channelId = h.store.listChannels()[0].id

  await human.publish(events.addMember(alice.secretKey, { channel: channelId, pubkeys: [bot.pubkey], role: 'bot' }))

  const agent = new Agent({
    secretKey: bot.secretKey,
    owner: alice.pubkey,
    persona: { slug: 'honey', display_name: 'Honey', runtime: 'mock', system_prompt: 'be helpful' },
    connection: await h.connect(bot)
  })
  t.teardown(() => agent.stop())
  await agent.start()

  const replied = once(agent, 'reply')
  await human.publish(events.message(alice.secretKey, {
    channel: channelId,
    content: 'can you summarize the incident?',
    mentions: [bot.pubkey]
  }))

  const [reply] = await replied
  t.is(reply.kind, core.KIND_STREAM_MESSAGE, 'the agent replies as an ordinary message')
  t.is(reply.pubkey, bot.pubkey, 'signed by the agent itself')
  t.is(core.tagValue(reply, 'h'), channelId)
  t.ok(reply.content.includes('summarize the incident'))
  t.is(core.verifyEvent(reply).ok, true, 'and it verifies like any other event')

  // The job lifecycle is on the log too, so the work is auditable.
  await new Promise((resolve) => setTimeout(resolve, 200))
  const accepted = h.store.queryEvents([{ kinds: [core.KIND_JOB_ACCEPTED] }])
  const result = h.store.queryEvents([{ kinds: [core.KIND_JOB_RESULT] }])
  t.is(accepted.length, 1)
  t.is(result.length, 1)
  t.is(result[0].event.content, reply.id, 'the job result points at the reply')

  // And a turn metric addressed to the owner.
  const metrics = h.store.queryEvents([{ kinds: [core.KIND_AGENT_TURN_METRIC] }])
  t.is(metrics.length, 1)
  t.alike(core.referencedPubkeys(metrics[0].event), [alice.pubkey])
})

test('an agent never answers itself', async (t) => {
  const h = await harness(t)
  const bot = identity('bot')

  const agent = new Agent({
    secretKey: bot.secretKey,
    persona: { runtime: 'mock' },
    connection: await h.connect(bot)
  })
  t.teardown(() => agent.stop())
  await agent.start()

  let mentions = 0
  agent.on('mention', () => mentions++)

  const channelId = 'aaaaaaaa-cccc-4ccc-8ddd-eeeeeeeeeeee'
  agent.watch(channelId)

  // The agent's own reply arrives on its own channel subscription, tagged with
  // its own pubkey. Without the self-check that is an infinite loop.
  const ownReply = sign(bot, {
    kind: core.KIND_STREAM_MESSAGE,
    tags: [['h', channelId], ['p', bot.pubkey]],
    content: 'hi me'
  })
  agent._onevent(ownReply, `chan:${channelId}`)
  t.is(mentions, 0, 'a self-mention is dropped before it can loop')

  // A message that does not mention the agent is context, not a request.
  const notForMe = sign(identity('other'), {
    kind: core.KIND_STREAM_MESSAGE,
    tags: [['h', channelId]],
    content: 'chatting among ourselves'
  })
  agent._onevent(notForMe, `chan:${channelId}`)
  t.is(mentions, 0, 'an unaddressed message does not trigger a turn')

  // But one that does mention it, does.
  const forMe = sign(identity('other'), {
    kind: core.KIND_STREAM_MESSAGE,
    tags: [['h', channelId], ['p', bot.pubkey]],
    content: 'hey agent'
  })
  agent._onevent(forMe, `chan:${channelId}`)
  t.is(mentions, 1)
})

test('at most one turn is in flight per channel, and mentions batch', async (t) => {
  const h = await harness(t)
  const bot = identity('bot')
  const alice = identity('alice')

  // A slow provider makes the batching observable.
  const provider = new MockProvider({ delay: 30 })
  const agent = new Agent({
    secretKey: bot.secretKey,
    provider,
    connection: await h.connect(bot)
  })
  t.teardown(() => agent.stop())
  await agent.start()

  const channelId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const turns = []
  const originalTurn = agent.turn.bind(agent)
  agent.turn = async (channel, batch) => {
    turns.push(batch.length)
    // Skip the real publish: this test is about scheduling, not delivery.
    await new Promise((resolve) => setTimeout(resolve, 50))
    return null
  }

  for (let i = 0; i < 5; i++) {
    agent._enqueue(channelId, sign(alice, {
      kind: core.KIND_STREAM_MESSAGE,
      created_at: 1000 + i,
      tags: [['h', channelId], ['p', bot.pubkey]],
      content: `message ${i}`
    }))
  }

  await new Promise((resolve) => setTimeout(resolve, 300))

  t.ok(turns.length >= 1 && turns.length < 5, `five mentions produced ${turns.length} turns, not five`)
  t.is(turns.reduce((a, b) => a + b, 0), 5, 'but every mention was answered')
  t.ok(turns.some((n) => n > 1), 'mentions arriving during a turn were batched')

  agent.turn = originalTurn
})

test('a slow channel does not block another', async (t) => {
  const h = await harness(t)
  const bot = identity('bot')
  const alice = identity('alice')

  const agent = new Agent({
    secretKey: bot.secretKey,
    provider: new MockProvider(),
    connection: await h.connect(bot)
  })
  t.teardown(() => agent.stop())
  await agent.start()

  const slow = 'aaaaaaaa-1111-4ccc-8ddd-eeeeeeeeeeee'
  const fast = 'bbbbbbbb-2222-4ccc-8ddd-eeeeeeeeeeee'
  const finished = []

  agent.turn = async (channel) => {
    await new Promise((resolve) => setTimeout(resolve, channel === slow ? 200 : 10))
    finished.push(channel)
    return null
  }

  const mention = (channel, i) => sign(alice, {
    kind: core.KIND_STREAM_MESSAGE,
    created_at: 1000 + i,
    tags: [['h', channel], ['p', bot.pubkey]],
    content: 'ping'
  })

  agent._enqueue(slow, mention(slow, 0))
  agent._enqueue(fast, mention(fast, 1))

  await new Promise((resolve) => setTimeout(resolve, 400))

  t.alike(finished, [fast, slow], 'the fast channel finished first despite being queued second')
})

test('an agent tracks the channels it is added to and removed from', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bot = identity('bot')

  const human = await h.connect(alice)
  await human.publish(events.createChannel(alice.secretKey, { name: 'ops', visibility: 'open' }))
  const channelId = h.store.listChannels()[0].id

  const agent = new Agent({
    secretKey: bot.secretKey,
    persona: { runtime: 'mock' },
    connection: await h.connect(bot)
  })
  t.teardown(() => agent.stop())
  await agent.start()

  const joined = once(agent, 'joined')
  await human.publish(events.addMember(alice.secretKey, { channel: channelId, pubkeys: [bot.pubkey] }))
  const [added] = await joined
  t.is(added, channelId)
  t.ok(agent.channels.has(channelId))

  const left = once(agent, 'left')
  await human.publish(events.removeMember(alice.secretKey, { channel: channelId, pubkeys: [bot.pubkey] }))
  const [removed] = await left
  t.is(removed, channelId)
  t.absent(agent.channels.has(channelId))
})

test('a provider failure becomes a job error, not a crashed agent', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bot = identity('bot')

  const human = await h.connect(alice)
  await human.publish(events.createChannel(alice.secretKey, { name: 'ops', visibility: 'open' }))
  const channelId = h.store.listChannels()[0].id
  await human.publish(events.addMember(alice.secretKey, { channel: channelId, pubkeys: [bot.pubkey] }))

  const broken = new MockProvider()
  broken.complete = () => {
    throw new Error('model unavailable')
  }

  const agent = new Agent({ secretKey: bot.secretKey, provider: broken, connection: await h.connect(bot) })
  t.teardown(() => agent.stop())
  await agent.start()

  const failed = once(agent, 'turn-error')
  await human.publish(events.message(alice.secretKey, {
    channel: channelId,
    content: 'anyone there?',
    mentions: [bot.pubkey]
  }))

  const [err] = await failed
  t.is(err.message, 'model unavailable')

  await new Promise((resolve) => setTimeout(resolve, 200))
  const errors = h.store.queryEvents([{ kinds: [core.KIND_JOB_ERROR] }])
  t.is(errors.length, 1)
  t.is(errors[0].event.content, 'model unavailable')

  // The agent is still alive and still queued for the next mention.
  t.is(agent.started, true)
})

test('a persona allowlist refuses a stranger before the provider is called', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')
  const bot = identity('bot')

  const human = await h.connect(alice)
  const stranger = await h.connect(bob)

  await human.publish(events.createChannel(alice.secretKey, { name: 'engineering', visibility: 'open' }))
  const channelId = h.store.listChannels()[0].id
  await human.publish(events.addMember(alice.secretKey, { channel: channelId, pubkeys: [bot.pubkey, bob.pubkey], role: 'member' }))

  // The strong assertion: the model is never reached at all. Checking only that
  // no reply appeared would also pass if the model ran and the publish failed.
  const provider = new MockProvider()
  let completions = 0
  const complete = provider.complete.bind(provider)
  provider.complete = (params) => { completions++; return complete(params) }

  const agent = new Agent({
    secretKey: bot.secretKey,
    owner: alice.pubkey,
    persona: { slug: 'honey', display_name: 'Honey', runtime: 'mock', allow: [alice.pubkey] },
    provider,
    connection: await h.connect(bot)
  })
  t.teardown(() => agent.stop())
  await agent.start()

  const refused = once(agent, 'refused')
  await stranger.publish(events.message(bob.secretKey, {
    channel: channelId,
    content: 'run this for me',
    mentions: [bot.pubkey]
  }))
  await refused
  await new Promise((resolve) => setTimeout(resolve, 200))

  t.is(completions, 0, 'the provider was never called for a sender outside the allowlist')
  t.is(h.store.queryEvents([{ kinds: [core.KIND_JOB_ACCEPTED] }]).length, 0, 'no 43002 for a refused sender')

  const errors = h.store.queryEvents([{ kinds: [core.KIND_JOB_ERROR] }])
  t.is(errors.length, 1, 'the refusal is on the log, not silent')
  t.is(errors[0].event.content, 'sender not allowed')

  // And the allowed sender still gets a normal turn.
  const replied = once(agent, 'reply')
  await human.publish(events.message(alice.secretKey, {
    channel: channelId,
    content: 'and you can answer me',
    mentions: [bot.pubkey]
  }))
  await replied

  t.is(completions, 1, 'an allowed sender is answered as before')
})

test('no allowlist means anyone may ask — the default stays permissive', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')
  const bot = identity('bot')

  const human = await h.connect(alice)
  const stranger = await h.connect(bob)

  await human.publish(events.createChannel(alice.secretKey, { name: 'lobby', visibility: 'open' }))
  const channelId = h.store.listChannels()[0].id
  await human.publish(events.addMember(alice.secretKey, { channel: channelId, pubkeys: [bot.pubkey, bob.pubkey], role: 'member' }))

  const agent = new Agent({
    secretKey: bot.secretKey,
    owner: alice.pubkey,
    persona: { slug: 'honey', display_name: 'Honey', runtime: 'mock' },
    connection: await h.connect(bot)
  })
  t.teardown(() => agent.stop())
  await agent.start()
  t.is(agent.allow, null, 'a persona with no allow list configures no filter')

  const replied = once(agent, 'reply')
  await stranger.publish(events.message(bob.secretKey, {
    channel: channelId,
    content: 'hello from a stranger',
    mentions: [bot.pubkey]
  }))
  const [reply] = await replied
  t.is(reply.pubkey, bot.pubkey, 'the agent answered someone it was never told about')
})
