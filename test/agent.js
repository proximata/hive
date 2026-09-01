'use strict'

const test = require('brittle')
const core = require('hive-core')
const { events } = require('hive-sdk')

const { openStore } = require('hive-store')
const { Relay, WebSocketTransport } = require('hive-relay')
const { Agent, AgentHome, MockProvider, RelayConnection, providerFromPersona, CAPABILITIES } = require('hive-agent')

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

test('the web client mirrors the attestation preimage exactly', (t) => {
  // packages/hive-web/public/app.js re-implements the verification, because a
  // client that asks the server whether the owner's signature is valid has
  // verified nothing. There is no build step to share the code, so the one
  // thing that must not drift - the signing preimage - is asserted here.
  const fs = require('bare-fs')
  const path = require('bare-path')
  const app = fs.readFileSync(
    path.join(__dirname, '..', 'packages', 'hive-web', 'public', 'app.js'), 'utf8')

  t.ok(app.includes(`sha256(utf8('${core.DOMAIN}' + event.pubkey + ':' + conditions))`),
    'the browser hashes the same preimage hive-core signs')
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

test('a persona names a model by size, an SDK constant, or not at all', async (t) => {
  const { QvacProvider, MODELS, DEFAULT_MODEL } = require('hive-agent/lib/qvac.js')

  // The descriptor shape @qvac/sdk actually exports, trimmed to what is read.
  const fake = {
    LLAMA_3_2_1B_INST_Q4_0: { name: 'LLAMA_3_2_1B_INST_Q4_0', expectedSize: 807_000_000 },
    QWEN3_4B_INST_Q4_K_M: { name: 'QWEN3_4B_INST_Q4_K_M', expectedSize: 2_500_000_000 },
    loadModel: async (params) => {
      fake.params = params
      // Two ticks either side of a 10% boundary: the log must not repeat.
      params.onProgress?.({ percentage: 4 })
      params.onProgress?.({ percentage: 7 })
      params.onProgress?.({ percentage: 100 })
      return 'model-1'
    }
  }

  t.is(new QvacProvider({}).modelSrc, DEFAULT_MODEL, 'a persona with no model gets the smallest one')
  t.is(MODELS.small, 'LLAMA_3_2_1B_INST_Q4_0')

  const lines = []
  const sized = new QvacProvider({ model: 'medium', sdk: fake, log: (line) => lines.push(line) })
  await sized.ready()
  t.is(fake.params.modelSrc.name, 'QWEN3_4B_INST_Q4_K_M', 'the size alias resolved to a descriptor')

  // A silent multi-minute download is the failure this prevents.
  t.ok(lines[0].includes('2.5 GB'), `the size is said up front: ${lines[0]}`)
  t.ok(lines[0].includes('first load downloads'), 'and that the first load is a download')
  t.alike(lines.slice(1), ['[qvac] QWEN3_4B_INST_Q4_K_M: 0%', '[qvac] QWEN3_4B_INST_Q4_K_M: 100%'],
    'progress reports every 10%, not every tick')

  // An exact SDK constant still works, and one this SDK does not export is
  // passed through rather than refused — a caller may know a newer name.
  const exact = new QvacProvider({ model: 'LLAMA_3_2_1B_INST_Q4_0', sdk: fake })
  await exact.ready()
  t.is(fake.params.modelSrc.expectedSize, 807_000_000)

  const unknown = new QvacProvider({ model: 'LLAMA_9_FUTURE_Q4_0', sdk: fake })
  await unknown.ready()
  t.is(fake.params.modelSrc, 'LLAMA_9_FUTURE_Q4_0')

  // A lowercase name that is not an alias is a persona typo. Name the aliases.
  const typo = new QvacProvider({ model: 'llama-3.2-1b', sdk: fake })
  await t.exception(typo.ready(), /unknown model "llama-3\.2-1b": use one of small, medium, large/)
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

// ------------------------------------------------------------------- home --

/**
 * An in-memory fs adapter.
 *
 * The point of the injection is that `hive-agent` never requires bare-fs, and a
 * test that only ever drove it with the real one would not prove that. Files
 * are a flat Map keyed by path; directories are recorded as a Set, because
 * `readdirSync` on the skills directory is the only listing the class does.
 */
function memfs () {
  const files = new Map()
  const dirs = new Set()
  const modes = new Map()

  return {
    files,
    modes,
    existsSync: (p) => files.has(p) || dirs.has(p),
    mkdirSync: (p) => {
      const parts = p.split('/')
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
    },
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
      return files.get(p)
    },
    writeFileSync: (p, data) => {
      files.set(p, data)
      dirs.add(p.slice(0, p.lastIndexOf('/')))
    },
    readdirSync: (p) => {
      const prefix = p + '/'
      const names = new Set()
      for (const key of [...files.keys(), ...dirs]) {
        if (!key.startsWith(prefix)) continue
        names.add(key.slice(prefix.length).split('/')[0])
      }
      return [...names]
    },
    chmodSync: (p, mode) => modes.set(p, mode)
  }
}

test('an agent home is a layout over an injected fs, and rejects a name that escapes it', (t) => {
  const fs = memfs()
  const home = new AgentHome({ root: '/srv/hive', name: 'honey', fs }).create()

  t.is(home.dir, '/srv/hive/agents/honey')
  t.is(home.readInstruction(), null, 'a fresh home has no prompt override')
  t.alike(home.readSkills(), [])
  t.alike(home.readMetadata(), {})

  // A name is interpolated into a path and arrives from an operator flag.
  t.exception(() => new AgentHome({ root: '/srv/hive', name: '../../etc', fs }), /invalid agent name/)
  t.exception(() => new AgentHome({ root: '/srv/hive', name: 'a/b', fs }), /invalid agent name/)
  t.exception(() => new AgentHome({ root: '/srv/hive', name: 'honey' }), /injected fs adapter/,
    'the package has no fs of its own to fall back on')

  // The persona is authoritative for identity; the home overrides the prompt.
  const persona = { slug: 'honey', runtime: 'mock', system_prompt: 'from the persona event' }
  t.is(home.systemPrompt(persona), 'from the persona event')

  fs.writeFileSync('/srv/hive/agents/honey/files/instruction.md', 'from the file\n')
  t.is(home.systemPrompt(persona), 'from the file', 'instruction.md wins over the persona prompt')

  fs.writeFileSync('/srv/hive/agents/honey/skills/triage/SKILL.md', 'label every incident')
  fs.writeFileSync('/srv/hive/agents/honey/skills/aaa/SKILL.md', 'answer in one line')
  t.is(home.systemPrompt(persona),
    'from the file\n\n## Skill: aaa\n\nanswer in one line\n\n## Skill: triage\n\nlabel every incident',
    'skills append in name order, so the prompt is stable across restarts')

  t.alike(home.describe().skills, ['aaa', 'triage'])
  t.absent('secretKey' in home.describe(), 'describe() never carries key material')
})

test('the keypair file is written 0600', (t) => {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const path = require('bare-path')

  const root = path.join(os.tmpdir(), `hive-home-${Date.now()}`)
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))

  const bot = identity('bot')
  const home = new AgentHome({ root, name: 'honey', fs }).create()
  home.writeSecretKey(bot.secretKeyHex)

  const mode = fs.statSync(home.keypairPath).mode & 0o777
  t.is(mode, 0o600, 'key material is not readable by anyone else on the box')
  t.is(home.readSecretKey(), bot.secretKeyHex.toLowerCase())

  // A keypair that already existed with loose permissions is tightened, which
  // a create-only mode argument would not do.
  fs.chmodSync(home.keypairPath, 0o644)
  home.writeSecretKey(bot.secretKeyHex)
  t.is(fs.statSync(home.keypairPath).mode & 0o777, 0o600)

  fs.writeFileSync(home.keypairPath, 'not a key')
  t.exception(() => home.readSecretKey(), /not a 64-character hex secret key/)
})

test('editing instruction.md changes the next turn\'s system prompt, with no restart', async (t) => {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const path = require('bare-path')

  const h = await harness(t)
  const alice = identity('alice')
  const bot = identity('bot')

  const root = path.join(os.tmpdir(), `hive-home-turn-${Date.now()}`)
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))

  const home = new AgentHome({ root, name: 'honey', fs }).create()
  fs.writeFileSync(home.instructionPath, 'be terse')

  const human = await h.connect(alice)
  await human.publish(events.createChannel(alice.secretKey, { name: 'lobby', visibility: 'open' }))
  const channelId = h.store.listChannels()[0].id
  await human.publish(events.addMember(alice.secretKey, { channel: channelId, pubkeys: [bot.pubkey], role: 'bot' }))

  const provider = new MockProvider()
  const agent = new Agent({
    secretKey: bot.secretKey,
    owner: alice.pubkey,
    persona: { slug: 'honey', display_name: 'Honey', runtime: 'mock', system_prompt: 'from the persona' },
    provider,
    home,
    connection: await h.connect(bot)
  })
  t.teardown(() => agent.stop())
  await agent.start()

  const ask = async (content) => {
    const replied = once(agent, 'reply')
    await human.publish(events.message(alice.secretKey, { channel: channelId, content, mentions: [bot.pubkey] }))
    await replied
    return provider.calls[provider.calls.length - 1].history[0]
  }

  const first = await ask('first question')
  t.is(first.role, 'system')
  t.is(first.content, 'be terse', 'the file overrode the persona prompt')

  // The edit an operator makes between two messages, with the process running.
  fs.writeFileSync(home.instructionPath, 'answer only in questions')
  fs.mkdirSync(path.join(home.skillsDir, 'triage'), { recursive: true })
  fs.writeFileSync(path.join(home.skillsDir, 'triage', 'SKILL.md'), 'label every incident')

  const second = await ask('second question')
  t.is(second.content, 'answer only in questions\n\n## Skill: triage\n\nlabel every incident',
    'the next turn read the file again, and picked up the new skill too')
})

// -------------------------------------------------------------------- run --

test('hive agent run starts an agent from a home directory and stops cleanly', async (t) => {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const path = require('bare-path')
  const { runAgent, resolveAgent } = require('hive-agent/lib/run.js')

  const h = await harness(t)
  const alice = identity('alice')

  const root = path.join(os.tmpdir(), `hive-run-${Date.now()}`)
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))

  // A mistyped --name must not quietly mint a second identity and leave the
  // real agent dark, so a missing home is an error carrying its own fix.
  t.exception(() => resolveAgent({ root, name: 'honey' }), /--create/)

  const lines = []
  const handle = await runAgent({
    root,
    name: 'honey',
    create: true,
    url: `ws://127.0.0.1:${h.port}`,
    signals: false,
    log: (line) => lines.push(line)
  })
  t.teardown(() => handle.stop())

  t.is(fs.statSync(handle.home.keypairPath).mode & 0o777, 0o600, '--create minted a 0600 keypair')
  t.alike(handle.home.readMetadata().persona.runtime, 'mock', 'a first run needs no model')

  const banner = lines.join('\n')
  t.ok(banner.includes(core.encodeNpub(handle.pubkey)), 'the output says as whom')
  t.ok(banner.includes(`ws://127.0.0.1:${h.port}`), 'and against which relay')
  t.ok(banner.includes(handle.home.dir), 'and out of which home')
  t.absent(banner.includes(handle.home.readSecretKey()), 'and never the secret key')

  // The operator adds the printed key to a channel; the process picks it up
  // without a restart, which is the whole reason it is long-lived.
  const human = await h.connect(alice)
  await human.publish(events.createChannel(alice.secretKey, { name: 'ops', visibility: 'open' }))
  const channelId = h.store.listChannels()[0].id
  const joined = once(handle.agent, 'joined')
  await human.publish(events.addMember(alice.secretKey, {
    channel: channelId, pubkeys: [handle.pubkey], role: 'bot'
  }))
  await joined

  const replied = once(handle.agent, 'reply')
  await human.publish(events.message(alice.secretKey, {
    channel: channelId, content: 'are you up?', mentions: [handle.pubkey]
  }))
  const [reply] = await replied
  t.is(reply.pubkey, handle.pubkey, 'the process answered a mention')

  await handle.stop()
  t.is(handle.agent.connection.closed, true, 'shutdown closed the relay socket')
  await handle.stop() // idempotent: a second signal must not throw
})

test('an agent run refuses a name that would escape the home root', (t) => {
  const { resolveAgent } = require('hive-agent/lib/run.js')
  t.exception(() => resolveAgent({ root: '/tmp/hive-run-none', name: '../../etc' }), /invalid agent name/)
})
