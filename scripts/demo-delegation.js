'use strict'

// Two humans talking THROUGH their agents, and the runnable check that proves
// every link of it happened. Runs under Bare, because hive-core does not load
// in Node.
//
//   node scripts/bare.js scripts/demo-delegation.js                 check (self-hosted relay)
//   node scripts/bare.js scripts/demo-delegation.js 3000 run        drive a running relay
//   node scripts/bare.js scripts/demo-delegation.js 3000 loop-guard the adversarial case alone
//
// WHY THIS IS NOT A PHASE OF demo-web-seed.js
//
// That script is a PUBLISHER: it fabricates events with core.finalizeEvent and
// a pooled TestClient whose sockets are deliberately dropped after two idle
// seconds. This one runs real `Agent` harnesses — long-lived RelayConnections,
// NIP-42 handshakes, membership subscriptions, provider streams, start/stop
// lifecycles — and then asserts against what landed. Different machinery, and
// the assertions have to be able to fail the process, which a seeder phase must
// never do. The cast and the channel ids are shared through
// scripts/lib/demo/web-identities.js, so this runs INSIDE the room that
// demo-web-seed.js furnished rather than beside it.
//
// Flags are `name=value` anywhere on the command line. `Bare.env` is undefined
// under the bundled runtime, so an environment variable would be read as
// undefined and ignored in silence; everything arrives as an argument.
//
//   channel=engineering   which room to run in
//   pace=900              ms between the human beats, so a recorder can film it
//   chunk=12              ms per streamed chunk inside a turn. The default is
//                         the smallest delay that still streams; a recorder
//                         raises it so a turn takes visible seconds and the job
//                         events it emits are readable before the reply lands.
//                         It changes only the CLOCK — the content of every event
//                         is identical either way, so a filmed take and a
//                         checked take assert the same things.
//   url=ws://127.0.0.1:P  the origin NIP-42 signs over, when it differs from the
//                         port dialled (a tunnel)
//   hold=0                ms to keep the agents connected after the flow ends,
//                         before stopping them. A recorder wants this: without
//                         it the process exits on the last message and the
//                         status bar spends the closing seconds reading `1 conn`
//                         — true, but it films as the client dying rather than
//                         as two agents still sitting in the room.
//   quiet=1               suppress the per-event trace
//   hops=4                the loop-guard ceiling. Raising it is how you SEE the
//                         guard working — the message count is exactly hops+1,
//                         measured on a self-hosted relay with no rate limiter:
//
//                           hops=2 → 3    hops=8  → 9
//                           hops=4 → 5    hops=40 → 41
//
//                         so the ceiling is what bounds the loop, not the token
//                         bucket. At hops=400 the readback query itself times
//                         out: the loop starves the relay's event loop, which is
//                         what an unguarded pair of agents does to a real relay.
//                         Only ever raise it against a relay you are hosting.
//
// THE FLOW
//
//   alice ──ask──▶ honey ──▶ scout ──deliver──▶ bob
//   alice ◀──────  honey ◀── scout ◀──answer── bob
//
// honey is alice's agent, scout is bob's — declared in each agent's kind-10100
// profile and rendered by the web client as `[agent · alice]`. The middle is
// not a pipe: each agent classifies urgency, condenses the request, writes a
// kind-30174 engram it can be queried back out of, and emits 43002/43003/43004
// so the EVENT FLOW pane shows the work rather than only the two sentences a
// human reads.
//
// No new event kind was added for any of this.

const core = require('hive-core')
const { events } = require('hive-sdk')
const { ScriptedProvider, MockProvider } = require('hive-agent')
// The wiring this script used to own. Extracted so `hive agent run` and this
// demo start an agent exactly one way; see packages/hive-agent/lib/run.js.
const { startAgent: wireAgent } = require('hive-agent/lib/run.js')
const { TestClient } = require('../test/client')
const { CH, AGENT_OWNERS, channelId, identity } = require('./lib/demo/web-identities')

const ARGS = Bare.argv.slice(Bare.argv.findIndex((a) => a.endsWith('demo-delegation.js')) + 1)
const POSITIONAL = ARGS.filter((a) => !/^[a-z][a-z-]*=/.test(a))
const flag = (name, fallback) => {
  const hit = ARGS.find((a) => a.startsWith(name + '='))
  if (hit === undefined) return fallback
  const raw = hit.slice(name.length + 1)
  if (typeof fallback !== 'number') return raw
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name}= expects a number, got ${JSON.stringify(raw)}`)
  return value
}

const PHASES = ['run', 'check', 'loop-guard']
// `<port> <phase>` matches demo-web-seed.js, but a bare `loop-guard` with no
// port is the obvious thing to type and used to be read as port NaN → 0 → phase
// `check`, which ran the whole flow and looked like it had worked.
const PORT = Number(POSITIONAL.find((a) => /^\d+$/.test(a))) || 0 // 0 = host a relay in this process
const PHASE = POSITIONAL.find((a) => PHASES.includes(a)) ?? (PORT === 0 ? 'check' : 'run')
for (const arg of POSITIONAL) {
  if (!/^\d+$/.test(arg) && !PHASES.includes(arg) && !arg.startsWith('ws://') && !arg.startsWith('hyper://')) {
    throw new Error(`unknown argument ${JSON.stringify(arg)}; expected a port, one of ${PHASES.join('/')}, or name=value`)
  }
}
const CHANNEL = channelId(flag('channel', CH.engineering))
const PACE = flag('pace', 900)
const CHUNK = flag('chunk', 12)
const HOLD = flag('hold', 0)
const QUIET = flag('quiet', '') !== ''

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (line) => { if (!QUIET) console.log(line) }

/** Wait for an emitter event, with a useful failure instead of a hang. */
function once (emitter, name, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${name}"`)), timeout)
    emitter.once(name, (...args) => {
      clearTimeout(timer)
      resolve(args)
    })
  })
}

// ------------------------------------------------------------------ cast --

const alice = identity('alice')
const bob = identity('bob')
const honey = identity('honey') // alice's agent — AGENT_OWNERS.honey === 'alice'
const scout = identity('scout') // bob's agent   — AGENT_OWNERS.scout === 'bob'

// What alice and bob actually type. Ordinary channel messages: neither of them
// addresses the other directly, and neither speaks a command language.
const ASK = "honey: the release train is blocked — triage this and ask bob's agent when relay build 42 actually ships."
const ANSWER = 'scout: tell alice build 42 ships thursday, once the rollback lands and the flaky reconnect test is green.'

/**
 * Routing tables.
 *
 * A route is a marker in the incoming text plus the pubkey the reply should
 * address, and the agent's own words to wrap the payload in. `delegate: true`
 * additionally emits a kind-43001 job request, which is the machine-readable
 * half of "I am handing this to you" — the chat message is the half a person
 * reads.
 *
 * The markers are the addressee, the way a To: header is: nothing here decides
 * what the message MEANS. Urgency and the summary are computed from the text by
 * ScriptedProvider, which also strips the envelope a peer agent wrapped the
 * payload in, so the second hop summarises the REQUEST rather than the first
 * agent's header. Same function every run, which is what makes a recording
 * reproducible frame for frame.
 */
const HONEY_ROUTES = [
  {
    name: 'hand-to-scout',
    when: /\b(ask bob|bob's agent)\b/i,
    to: scout.pubkey,
    toName: 'scout',
    delegate: true,
    note: 'relayed for alice',
    trail: 'triaged and stored on my side; please put it to bob.'
  },
  {
    name: 'report-to-alice',
    when: /\breply for alice\b/i,
    to: alice.pubkey,
    toName: 'alice',
    delegate: false,
    note: "bob's answer, carried back by scout",
    trail: 'the whole trail is on the log.'
  }
]

const SCOUT_ROUTES = [
  {
    name: 'deliver-to-bob',
    when: /\brelayed for alice\b/i,
    to: bob.pubkey,
    toName: 'bob',
    delegate: false,
    note: 'alice needs this',
    trail: 'logged on my side too; answer here and I will carry it back.'
  },
  {
    name: 'carry-back',
    when: /\btell alice\b/i,
    to: honey.pubkey,
    toName: 'honey',
    delegate: true,
    note: 'reply for alice',
    trail: 'triaged and handed back.'
  }
]

// --------------------------------------------------------------- plumbing --

/**
 * A relay to run against.
 *
 * With a port, the one already listening there — which is what the recorder
 * wants, because the browser is looking at it. Without one, a relay in this
 * process, which is what the check wants: an empty store, no rate limiter, and
 * nothing else publishing into the assertions.
 */
async function openRelay () {
  if (PORT !== 0) {
    return { port: PORT, url: flag('url', `ws://127.0.0.1:${PORT}`), close: async () => {} }
  }

  const { openStore } = require('hive-store')
  const { Relay, WebSocketTransport } = require('hive-relay')

  const store = openStore(':memory:')
  const relay = new Relay(store, { url: 'ws://127.0.0.1' })
  const transport = new WebSocketTransport(relay, { port: 0 })
  await transport.listen()

  return {
    port: transport.port,
    url: `ws://127.0.0.1:${transport.port}`,
    store,
    close: async () => {
      relay.close()
      await transport.close()
      store.close()
    }
  }
}

// The relay this run is talking to. Module-level because every human action
// below resolves its own socket on demand — see clientFor().
let RELAY = null

/**
 * One connection per pubkey, never shared and never held past its idle timeout.
 *
 * Never shared, because a NIP-42 session is bound to the key that signed the
 * handshake: publishing bob's event down alice's socket comes back `invalid:
 * event pubkey does not match the authenticated pubkey`.
 *
 * Never held, because bare-ws closes a quiet client socket after about four
 * seconds and this script has gaps far longer than that BY DESIGN — `chunk=`
 * paces an agent's turn to seconds so a recorder can film it. A held client
 * then publishes into a socket the relay has already forgotten and waits
 * forever for an OK that cannot arrive. Measured at chunk=260: bob's answer,
 * ~10s after bob authenticated, received no OK at all and the run died in the
 * middle of the chain. Same shape as the pool in scripts/demo-web-seed.js, for
 * the same reason.
 */
const clients = new Map()
async function clientFor (who) {
  const held = clients.get(who.name)
  if (held !== undefined && !held.client.closed && Date.now() - held.usedAt < 2000) {
    held.usedAt = Date.now()
    return held.client
  }
  if (held !== undefined) await held.client.destroy()

  const client = await TestClient.openWebSocket({ port: RELAY.port })
  await client.authenticate(who, { relayUrl: RELAY.url })
  clients.set(who.name, { client, usedAt: Date.now() })
  return client
}

/** Publish as `who`, and never let a refusal pass as a success. */
async function publish (who, event) {
  const client = await clientFor(who)
  const ok = await client.publish(event)
  if (!ok.accepted) throw new Error(`relay refused kind ${event.kind} from ${who.name}: ${ok.reason}`)
  log(`  ${who.name} → kind ${event.kind} ${event.id.slice(0, 8)}`)
  return event
}

/** Everything matching `filters`, read back over the wire like any other client. */
let queryCounter = 0
async function query (who, ...filters) {
  const client = await clientFor(who)
  const { closed, events: found } = await client.subscribe(`q${queryCounter++}`, ...filters)
  if (closed !== null) throw new Error(`query refused: ${closed}`)
  return found
}

/**
 * The room, and everyone in it.
 *
 * Idempotent on purpose: against a relay demo-web-seed.js already furnished,
 * the create and the joins come back refused and that is the correct outcome,
 * not a failure. What must be true afterwards is only that all four pubkeys are
 * members — which is checked, not assumed.
 */
async function setupChannel () {
  const create = core.finalizeEvent({
    kind: core.KIND_NIP29_CREATE_GROUP,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['h', CHANNEL], ['name', flag('channel', CH.engineering)], ['about', 'builds, incidents, deploys']],
    content: ''
  }, alice.secretKey)
  const created = await (await clientFor(alice)).publish(create)
  log(created.accepted ? `  channel ${CHANNEL} created` : `  channel ${CHANNEL} already exists (${created.reason})`)

  for (const who of [bob, honey, scout]) {
    const add = events.addMember(alice.secretKey, {
      channel: CHANNEL,
      pubkeys: [who.pubkey],
      role: who === bob ? 'member' : 'bot'
    })
    const ok = await (await clientFor(alice)).publish(add)
    if (!ok.accepted) log(`  addMember ${who.name}: ${ok.reason}`)
  }
}

/**
 * Start an agent, wired to its owner and its routes, and do not return until it
 * is actually watching the channel.
 *
 * An agent that has not joined yet silently ignores every mention, which would
 * turn a broken chain into an empty room rather than an error — the exact
 * failure this whole script exists to make impossible.
 */
async function startAgent (who, { owner, routes, relay, maxHops }) {
  const agent = await wireAgent({
    secretKey: who.secretKey,
    owner: owner.pubkey,
    persona: { slug: who.name, display_name: who.name, runtime: 'scripted' },
    // chunkDelay makes the turn take visible time on camera; the content is
    // identical either way, so a recorded take and a checked take agree.
    provider: routes === null
      ? new MockProvider()
      : new ScriptedProvider({ name: who.name, routes, chunkDelay: PACE > 0 ? CHUNK : 0 }),
    url: relay.url,
    reconnect: false,
    maxHops,
    channel: CHANNEL,
    onError: (err) => console.error(`  [${who.name}] ${err.message}`)
  })

  log(`  [${who.name}] watching ${CHANNEL}, owned by ${owner.name}`)
  return agent
}

/**
 * Keep the agents' sockets warm for as long as the flow runs.
 *
 * bare-ws closes a client socket that has been quiet for about four seconds.
 * Measured against this relay: a publish at a 3s gap gets its OK, at a 5s gap
 * the OK never arrives and the client already reports `closed`. An agent's only
 * inbound traffic is a mention, so an agent in a slow conversation is quiet by
 * definition — at `chunk=260` honey's socket dies during scout's turn and the
 * return leg reaches nobody. First take failed exactly there: `bob → scout`
 * printed, then `timed out waiting for "reply"`.
 *
 * Nothing new goes on the wire: a zero-limit REQ and the EOSE it always gets
 * back are traffic in both directions and cost one round trip. Not presence —
 * that is a real event other clients render, and a demo should not invent
 * liveness it is only faking to work around a socket.
 *
 * ponytail: this is a DEMO-side workaround for a real harness bug — an idle
 * agent goes deaf in a quiet room and only finds out when it next publishes.
 * The ceiling is that RelayConnection has no keepalive; the upgrade path is one
 * there (or `reconnect: true`, which it defaults to and this script turns off
 * for a deterministic teardown), which would fix every agent rather than this
 * script's two.
 */
function keepWarm (agents, every = 2500) {
  const timer = setInterval(() => {
    for (const agent of agents) {
      try {
        agent.connection.subscribe('keepalive', { kinds: [core.KIND_PROFILE], limit: 0 })
      } catch {
        // A socket already gone is what this is trying to prevent, not a
        // failure to report: the next tick reports it by failing louder.
      }
    }
  }, every)
  return () => {
    clearInterval(timer)
    for (const agent of agents) {
      try { agent.connection.unsubscribe('keepalive') } catch {}
    }
  }
}

// ------------------------------------------------------------- the flow --

/**
 * Run the delegation end to end and return what the checker needs to find it.
 *
 * The two human beats are the only things published from outside; everything in
 * between is the agents deciding for themselves.
 */
async function runFlow (relay) {
  await setupChannel()

  const agents = {
    honey: await startAgent(honey, { owner: alice, routes: HONEY_ROUTES, relay }),
    scout: await startAgent(scout, { owner: bob, routes: SCOUT_ROUTES, relay })
  }
  const cool = keepWarm(Object.values(agents))

  // Beat 1 — alice asks HER agent. She never addresses bob.
  const ask = events.message(alice.secretKey, { channel: CHANNEL, content: ASK, mentions: [honey.pubkey] })
  const delivered = once(agents.scout, 'reply', 12000)
  delivered.catch(() => {}) // the await below reports it; this only stops the unhandled-rejection noise
  await publish(alice, ask)
  console.log('  alice → honey')

  // honey triages, delegates to scout, scout triages and delivers to bob.
  const [toBob] = await delivered
  console.log(`  honey → scout → bob   (${toBob.id.slice(0, 8)})`)
  await sleep(PACE)

  // Beat 2 — bob answers HIS agent, in the same room, in the same way.
  const answer = events.message(bob.secretKey, { channel: CHANNEL, content: ANSWER, mentions: [scout.pubkey] })
  const returned = once(agents.honey, 'reply', 12000)
  returned.catch(() => {})
  await publish(bob, answer)
  console.log('  bob → scout')

  const [toAlice] = await returned
  console.log(`  scout → honey → alice (${toAlice.id.slice(0, 8)})`)

  // Job telemetry is published after the reply, so give the tail a moment to
  // land before anything queries for it.
  await sleep(600)

  // What a person in the room actually saw. Printed because "the flow ran" and
  // "the flow reads as a conversation" are different claims, and only one of
  // them can be checked by a filter query.
  const said = await query(alice, { kinds: [core.KIND_STREAM_MESSAGE], '#h': [CHANNEL], limit: 50 })
  const names = new Map([alice, bob, honey, scout].map((w) => [w.pubkey, w.name]))
  const hop = (e) => Number(core.tagValue(e, 'hop') ?? 0)
  // `created_at` has one-second resolution and the whole chain fits inside one,
  // so the log carries no chronological order to recover — hop does, because it
  // is causal. This is a diagnostic dump, not the transcript the client paints.
  console.log('')
  for (const event of said.slice().sort((a, b) => a.created_at - b.created_at || hop(a) - hop(b) || (a.id < b.id ? -1 : 1))) {
    const who = names.get(event.pubkey) ?? event.pubkey.slice(0, 8)
    const owner = AGENT_OWNERS[who]
    const tag = owner === undefined ? '' : ` [agent · ${owner}]`
    console.log(`  ${who}${tag} (hop ${hop(event)}): ${event.content}`)
  }
  console.log('')

  // `cool` is the caller's to run: a recorder holds the agents connected
  // through its closing seconds, and they go deaf the moment it stops.
  return { agents, cool, ask, toBob, toAlice }
}

// -------------------------------------------------------- the loop guard --

/**
 * The adversarial case, with no routing to help it terminate.
 *
 * Both agents run the plain MockProvider, whose reply addresses whoever
 * triggered it — so the moment one agent mentions the other, each reply is a
 * fresh mention of the sender and the pair ping-pong forever. Measured before
 * the hop tag existed: 143 messages per second across two pubkeys, content
 * compounding on every hop, stopped only by the relay's token bucket.
 *
 * Seeded by publishing one message signed by LEFT that p-tags RIGHT — the exact
 * shape the audit reproduced. Nothing else is published afterwards, so every
 * message the channel ends up holding was generated by the loop.
 */
async function runLoopGuard (relay, maxHops = flag('hops', 4)) {
  const left = identity('loop-left')
  const right = identity('loop-right')
  // A FRESH room per run. The whole assertion is "how many messages did this
  // loop produce", and against a relay with a persistent store — which the demo
  // relay has — a fixed room accumulates every previous run and the count reads
  // as a loop that ran twice as long. Two runs against one store reported 10
  // messages for a 5-message loop, which is the check being wrong, not the guard.
  const room = channelId(`loop-guard/${Date.now()}`)

  const create = core.finalizeEvent({
    kind: core.KIND_NIP29_CREATE_GROUP,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['h', room], ['name', 'loop-guard'], ['about', 'two agents that will not stop talking']],
    content: ''
  }, alice.secretKey)
  const createOk = await (await clientFor(alice)).publish(create)
  if (!createOk.accepted) throw new Error(`loop-guard room refused: ${createOk.reason}`)
  for (const who of [left, right]) {
    await (await clientFor(alice)).publish(
      events.addMember(alice.secretKey, { channel: room, pubkeys: [who.pubkey], role: 'bot' }))
  }

  const start = async (who) => {
    // No `channel:` here on purpose: this room is created after the agents
    // start and a missed notification is tolerated below, not fatal.
    const agent = await wireAgent({
      secretKey: who.secretKey,
      owner: alice.pubkey,
      provider: new MockProvider(),
      url: relay.url,
      reconnect: false,
      maxHops,
      onError: () => {}
    })
    if (!agent.channels.has(room)) await once(agent, 'joined').catch(() => {})
    agent.watch(room) // idempotent; belt and braces against a missed notification
    return agent
  }

  const agents = { left: await start(left), right: await start(right) }

  let stopped = 0
  const stops = []
  for (const [side, agent] of Object.entries(agents)) {
    agent.on('hop-limit', (event, _channel, hop) => {
      stopped++
      stops.push(`${side} refused a mention at hop ${hop}`)
    })
  }

  // LEFT starts it by mentioning RIGHT directly — down LEFT's own socket, since
  // a NIP-42 session only accepts events signed by the key that opened it.
  const seed = events.message(left.secretKey, {
    channel: room,
    content: 'starting a conversation with you',
    mentions: [right.pubkey]
  })
  const seedOk = await (await clientFor(left)).publish(seed)
  if (!seedOk.accepted) throw new Error(`loop-guard seed refused: ${seedOk.reason}`)

  // Long enough that an unbounded loop would be obvious: the measured runaway
  // put 214 messages on the wire in 1.5s.
  await sleep(Math.min(15000, Math.max(4000, maxHops * 120)))
  const settled = (await query(alice, { kinds: [core.KIND_STREAM_MESSAGE], '#h': [room], limit: 500 })).length

  // ...and again, to prove it is finished rather than merely slow.
  await sleep(2000)
  const again = (await query(alice, { kinds: [core.KIND_STREAM_MESSAGE], '#h': [room], limit: 500 })).length

  for (const agent of Object.values(agents)) await agent.stop()

  return { settled, again, stopped, stops, maxHops, seedId: seed.id }
}

// ------------------------------------------------------------- the check --

/**
 * Assert every link of the chain, and fail loudly on any missing one.
 *
 * A demo that silently skips the middle is the failure mode this exists to
 * prevent: two human-visible sentences with nothing between them look exactly
 * like a working delegation until someone queries the log.
 */
async function check (relay, flow, loop) {
  const { ask, toBob, toAlice } = flow
  const failures = []
  const pass = []

  const assert = (ok, label, detail = '') => {
    if (ok) pass.push(`  ✓ ${label}${detail ? '  ' + detail : ''}`)
    else failures.push(`  ✗ ${label}${detail ? '  ' + detail : ''}`)
    return ok
  }

  const messages = await query(alice, { kinds: [core.KIND_STREAM_MESSAGE], '#h': [CHANNEL], limit: 500 })
  const byAuthor = (who) => messages.filter((e) => e.pubkey === who.pubkey)
  const tagsPubkey = (event, who) => core.referencedPubkeys(event).includes(who.pubkey)
  const hopOf = (event) => Number(core.tagValue(event, 'hop') ?? 0)

  // 1 — the request. A human asking her own agent, in the open channel.
  const request = messages.find((e) => e.id === ask.id)
  assert(request !== undefined && tagsPubkey(request, honey), 'request: alice mentions honey',
    request === undefined ? 'NOT STORED' : `${request.id.slice(0, 8)}`)

  // 2 — the A2A hop. honey's own message, addressed at scout and at nobody else.
  const hop = byAuthor(honey).find((e) => tagsPubkey(e, scout))
  assert(hop !== undefined, 'a2a hop: honey mentions scout', hop === undefined ? 'MISSING' : `${hop.id.slice(0, 8)} hop=${hopOf(hop)}`)
  if (hop !== undefined) {
    assert(hopOf(hop) === 1, 'a2a hop carries hop=1', `got ${hopOf(hop)}`)
    assert(!tagsPubkey(hop, alice), 'a2a hop is addressed at scout, not bounced back at alice')
  }

  // 3 — the job lifecycle, per agent. This is what makes the middle visible in
  // the EVENT FLOW pane instead of being two sentences with a gap between them.
  for (const [who, name] of [[honey, 'honey'], [scout, 'scout']]) {
    for (const [kind, label] of [
      [core.KIND_JOB_ACCEPTED, '43002 accepted'],
      [core.KIND_JOB_PROGRESS, '43003 progress'],
      [core.KIND_JOB_RESULT, '43004 result']
    ]) {
      const found = await query(alice, { kinds: [kind], authors: [who.pubkey], limit: 200 })
      assert(found.length > 0, `job events: ${name} emitted ${label}`, `${found.length}`)
    }
  }

  // The delegation itself as a job request — 43001 from honey, p-tagging scout.
  const requests = await query(alice, { kinds: [core.KIND_JOB_REQUEST], authors: [honey.pubkey], limit: 200 })
  assert(requests.some((e) => tagsPubkey(e, scout)), 'delegation: honey published 43001 to scout', `${requests.length} job requests`)

  // 4 — the triage artefact. Computed from alice's exact words, so the checker
  // can derive the slug independently and demand it back out of the store. If
  // the middle only pretended to think, this query returns nothing.
  const slug = `triage/${core.toHex(core.sha256(Buffer.from(ASK.replace(/\s+/g, ' ').trim(), 'utf8'))).slice(0, 12)}`
  const engrams = await query(alice, { kinds: [core.KIND_AGENT_ENGRAM], authors: [honey.pubkey], '#d': [slug], limit: 10 })
  if (assert(engrams.length === 1, 'triage stored: honey wrote engram 30174', slug)) {
    let memo = null
    try { memo = JSON.parse(engrams[0].content) } catch { memo = null }
    assert(memo !== null, 'triage artefact parses')
    assert(memo?.urgency === 'high', 'triage classified alice\'s blocked release as high', `got ${memo?.urgency}`)
    assert(memo?.forwarded_to === scout.pubkey, 'triage records who it was forwarded to')
    assert(typeof memo?.summary === 'string' && memo.summary.length > 0 && memo.words_out < memo.words_in,
      'triage summary is shorter than the request', `${memo?.words_in} → ${memo?.words_out} words`)
  }
  // And scout's own triage of what honey forwarded — both agents process, only
  // one of them would be needed for a pipe.
  const scoutEngrams = await query(alice, { kinds: [core.KIND_AGENT_ENGRAM], authors: [scout.pubkey], limit: 20 })
  assert(scoutEngrams.length >= 2, 'triage stored: scout wrote its own engrams', `${scoutEngrams.length}`)

  // 5 — delivery to the second human, by his own agent.
  assert(toBob !== undefined && toBob.pubkey === scout.pubkey && tagsPubkey(toBob, bob),
    'delivery: scout mentions bob', toBob === undefined ? 'MISSING' : `${toBob.id.slice(0, 8)} hop=${hopOf(toBob)}`)

  // 6 — and the answer coming back the other way, ending at alice.
  assert(toAlice !== undefined && toAlice.pubkey === honey.pubkey && tagsPubkey(toAlice, alice),
    'return leg: honey mentions alice', toAlice === undefined ? 'MISSING' : `${toAlice.id.slice(0, 8)} hop=${hopOf(toAlice)}`)
  assert(byAuthor(scout).some((e) => tagsPubkey(e, honey)), 'return leg: scout handed back to honey')

  // Ownership is protocol data, not a UI convention: both profiles must name a
  // DIFFERENT owner, or "whose agent is whose" is not on the log at all.
  const profiles = await query(alice, { kinds: [core.KIND_AGENT_PROFILE], authors: [honey.pubkey, scout.pubkey], limit: 10 })
  const ownerOf = (who) => {
    const event = profiles.find((e) => e.pubkey === who.pubkey)
    try { return JSON.parse(event.content).owner } catch { return null }
  }
  assert(ownerOf(honey) === alice.pubkey, `ownership: honey's 10100 names ${AGENT_OWNERS.honey}`)
  assert(ownerOf(scout) === bob.pubkey, `ownership: scout's 10100 names ${AGENT_OWNERS.scout}`)
  assert(ownerOf(honey) !== ownerOf(scout), 'ownership: the two agents belong to different people')

  // 7 — the loop guard. Bounded, and provably finished rather than slow.
  if (loop !== null) {
    assert(loop.stopped > 0, 'loop guard: an agent refused a mention at the hop ceiling', loop.stops.join('; '))
    assert(loop.settled <= loop.maxHops + 1, `loop guard: mutual mentions terminated within ${loop.maxHops} hops`,
      `${loop.settled} messages on the wire`)
    assert(loop.again === loop.settled, 'loop guard: the count is stable 2s later, so it stopped rather than slowed',
      `${loop.settled} → ${loop.again}`)
  }

  console.log('')
  for (const line of pass) console.log(line)
  for (const line of failures) console.log(line)
  console.log('')

  if (failures.length > 0) {
    console.log(`FAIL: ${failures.length} of ${pass.length + failures.length} links missing — the chain is broken, not the demo`)
    Bare.exitCode = 1
  } else {
    console.log(`PASS: ${pass.length}/${pass.length} links verified against the relay`)
  }
  return failures.length === 0
}

// ------------------------------------------------------------------ main --

async function main () {
  const relay = await openRelay()
  RELAY = relay
  console.log(`[delegation] relay ${relay.url}${PORT === 0 ? ' (hosted in this process)' : ''}, channel ${CHANNEL}, phase ${PHASE}`)

  const started = Date.now()
  let flow = null
  let loop = null

  try {
    if (PHASE === 'loop-guard') {
      loop = await runLoopGuard(relay)
      console.log('')
      console.log(`[loop-guard] ${loop.settled} messages, stable at ${loop.again} after a further 2s`)
      console.log(`[loop-guard] ${loop.stopped} mention(s) refused at the ceiling: ${loop.stops.join('; ') || 'NONE'}`)
      const ok = loop.stopped > 0 && loop.again === loop.settled && loop.settled <= loop.maxHops + 1
      console.log(ok ? 'PASS: the loop terminated' : 'FAIL: the loop did not terminate')
      if (!ok) Bare.exitCode = 1
      await relay.close()
      return
    }

    flow = await runFlow(relay)

    if (PHASE === 'check') {
      loop = await runLoopGuard(relay)
      await check(relay, flow, loop)
    } else {
      console.log(`[delegation] done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
      console.log(`[delegation] #${flag('channel', CH.engineering)} = ${CHANNEL}`)
      if (HOLD > 0) await sleep(HOLD)
    }

    flow.cool()
    for (const agent of Object.values(flow.agents)) await agent.stop()
  } finally {
    for (const { client } of clients.values()) await client.destroy()
    await relay.close()
  }
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
