'use strict'

// Relay traffic for the web demo (docs/demo-web.gif). Runs under Bare, because
// hive-core does not load in Node.
//
//   node scripts/bare.js scripts/demo-web-seed.js <port> history
//   node scripts/bare.js scripts/demo-web-seed.js <port> a2a
//   node scripts/bare.js scripts/demo-web-seed.js <port> live-1
//   node scripts/bare.js scripts/demo-web-seed.js <port> live-2
//   node scripts/bare.js scripts/demo-web-seed.js <port> load [rate=40] [seconds=30]
//   node scripts/bare.js scripts/demo-web-seed.js <port> load-check [min=600]
//
// `history` is the room as it was before the camera started: profiles, two
// channels, membership, a backdated transcript. `live-1` and `live-2` are the
// same three identities publishing while the recorder films, so the event flow
// pane fills with events that are genuinely arriving rather than replayed.
//
// `a2a` furnishes the room scripts/demo-delegation.js runs its agents inside:
// three humans, three agents, one each, and a backdated transcript. Small on
// purpose — see the phase.
//
// `load` is the same idea at a workspace's real size: 18 humans, 6 agents, 6
// channels, a backdated transcript that is already full when the camera opens,
// and then a sustained stream for as long as the recorder films. `load-check`
// asks the relay to COUNT what landed, so a run that silently seeded nothing
// fails loudly instead of producing a quiet demo.
//
// `load` prints `[load] backfill complete: …` when the room is furnished and
// before the live stream starts. A recorder should wait for THAT LINE rather
// than for the process to exit — one process does both halves on purpose, so
// that the per-pubkey rate-limit budget it plans against is the one the relay
// is actually holding. Flags, all optional and all `name=value` anywhere on the
// command line:
//
//   rate=40        target events per second during the live stream
//   seconds=30     how long to stream for; 0 backfills and exits
//   backfill=220   backdated chatter messages; 0 streams without seeding
//   span=6000      seconds of history the backfill is spread across
//   tier=human     the relay's rate-limit tier, mirrored locally to plan
//                  against; it must MATCH workers/main.js or the plan is wrong
//   min=600        load-check only: the floor the stored count must clear
//
// Measured on this laptop (M-series, loopback, 24 identities): the backfill
// lands 415 events in ~2s and the live stream holds 40.0 ev/s for 30s with 0
// refusals. It is the per-pubkey token bucket that decides that number, not the
// relay — the relay accepted 1500 events in 1.6s (931 ev/s) when 25 identities
// spent their burst as fast as they could. See the budget line the phase prints.
//
// Identities are derived from a fixed string. Throwaway by construction: the
// secret is sha256("hive-web-demo/alice") and is regenerated on every run, so
// nothing here is a key anyone can lose. Every handle below is invented.

const core = require('hive-core')
const { TIERS, TokenBucket } = require('hive-auth')
const { TestClient } = require('../test/client')
// Shared with scripts/demo-delegation.js, which runs real agents in these same
// rooms: one derivation of the cast and the channel ids, so the two scripts
// cannot disagree about which pubkey is whose or where #engineering is.
const { CH, HUMAN_NAMES, AGENT_NAMES, AGENT_OWNERS, channelId, identity } = require('./lib/demo/web-identities')

// Bare has no `process`; argv carries the runtime and the script path too.
const ARGS = Bare.argv.slice(Bare.argv.findIndex((a) => a.endsWith('demo-web-seed.js')) + 1)
// `Bare.env` is undefined under the bundled runtime, so an environment variable
// would be read as undefined and ignored in silence. Everything the demo
// depends on therefore arrives as an argument: positional ones keep the meaning
// they always had, and `name=value` may appear anywhere after them.
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

const PORT = Number(POSITIONAL[0]) || 8899
const PHASE = POSITIONAL[1] || 'history'
// NIP-42 signs over the URL the relay advertises, so recording a relay reached
// through a tunnel would mean connecting to a local port while signing the
// public origin. Separate knobs for that reason.
const RELAY_URL = POSITIONAL[2] || `ws://127.0.0.1:${PORT}`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------ load phase --
//
// A workspace at working size. Invented handles only: no real person, customer,
// address or mailbox appears anywhere in this file, and the chatter is written
// to read like a standup rather than like filler.

// How the traffic is distributed. #engineering carries most of it because it is
// the channel the recorder selects; the rest still move, which is what makes
// the unselected rows look like a workspace rather than a backdrop.
const CHANNEL_WEIGHTS = [
  [CH.engineering, 40],
  [CH.incidents, 16],
  [CH.releases, 13],
  [CH.design, 13],
  [CH.product, 10],
  [CH.ops, 8]
]

// The kind mix. Messages are a minority on purpose: a real firehose is mostly
// reactions, typing and presence, and a transcript that scrolled at the full
// event rate would be unreadable rather than impressive.
const KIND_MIX = [
  ['message', 36],
  ['reaction', 20],
  ['typing', 19],
  ['presence', 12],
  ['job', 13]
]

const CHATTER = {
  [CH.engineering]: [
    'rebased onto main, the only conflict was the lockfile',
    'CI is red again on the swarm transport reconnect test',
    'build {n} is green on all three runners',
    'PR #{n} is up, it is small but it touches the ingest path',
    'that flaky test is a timing assumption, not a race',
    'moved the retry into the transport so callers stop caring',
    'p99 on the query path is {n}ms after the index change',
    'the storage dir was not being cleaned between runs — that was it',
    'I can take the reconnect test if nobody has started',
    'reading the ingest pipeline now, the ordering is subtle',
    'we sign before we store, so a bad signature never reaches disk',
    'benchmark says {n} events/s accepted on this laptop',
    'dropping the extra round trip saved {n}ms per publish',
    'the subscription registry is a map of maps, it is fine at this size',
    'merged. thanks for the quick look',
    'that stack trace is the worker, not the host process',
    'the token bucket is per pubkey, so one noisy client cannot starve the rest',
    'swapped the linear scan for the channel index, {n}x on the hot path',
    'that assertion fires once in {n} runs, I have a repro now',
    'the migration is additive, old rows keep working',
    'nothing on the wire changes, only what we store',
    'pushed a fix for the off-by-one in the concat list',
    'the ephemeral kinds never touch disk, that is the whole trick',
    'holding review until the fuzz job finishes',
    'load test held {n} events/s for a full minute',
    'the socket closes idle after four seconds, that was the bug'
  ],
  [CH.incidents]: [
    'relay {n} stopped answering /health, looking now',
    'ack — on it',
    'it is the disk filling, not the process',
    'mitigated: rolled back to build {n}',
    'no user-visible impact, the socket reconnected on its own',
    'timeline is in the canvas, postmortem tomorrow',
    'error rate back to baseline for {n} minutes now',
    'closing this one out',
    'paging the on-call for the storage box, not for the relay',
    'confirmed: retry number {n} is what tips it over',
    'traffic is shifted away from that node while we look',
    'the alert fired on a stale metric, fixing the rule',
    'customer-visible for {n} seconds, status page updated',
    'root cause is the disk, the process was innocent'
  ],
  [CH.releases]: [
    'cutting {n} at the top of the hour',
    'staging is on build {n}, prod is still one behind',
    'release notes drafted, someone sanity check the wording',
    'holding the cut until the reconnect fix lands',
    'shipped. {n} minutes end to end',
    'rollback tested from the artefact, not from a rebuild',
    'tagging {n} once CI goes green on the last runner',
    'the changelog is generated from the commits, do not hand edit it',
    'signing the artefact before it leaves the builder',
    'no schema change in this one, so the rollback is clean'
  ],
  [CH.design]: [
    'the panel border carries the title, like the TUI',
    'and the footer rides in the bottom rule',
    'the selection marker is a glyph, so it survives with colour off',
    'contrast on the muted text is {n}:1, that clears AA',
    'the gutter is one column, agents get the bar',
    'no animation on arrival — the movement is the data',
    'spacing is a 4px grid everywhere except the status bar',
    'the flow pane is a live region, so it appends and never re-renders',
    'focus ring is the same glyph the TUI uses for selection',
    'agents get the bar in the gutter, humans get the space',
    'the status bar is the only place we spend colour on state',
    'the empty panel copy tells you what to do, not that it is empty',
    'type scale is 15px at the root and nothing below 12'
  ],
  [CH.product]: [
    'moved onboarding behind the first message, not before it',
    'people ask for search before they ask for threads',
    'the empty room is the worst screen we have',
    '{n} workspaces created this week, {m} of them with an agent',
    'writing this up as a one-pager for tomorrow',
    'the agents are the reason people stay, not the reason they arrive',
    '{n}% of rooms have an agent in them by day three',
    'nobody asked for threads this week, {n} asked for search',
    'cut the tour, the first message is the tour'
  ],
  [CH.ops]: [
    'rotated the deploy key, nothing to do on your side',
    'backup restore rehearsal passed, {n} seconds to first byte',
    'the relay runs unprivileged now, the port is proxied',
    'disk at {n}% on the recorder box, cleaning old frames',
    'the bind address defaults to loopback, exposure is opt in',
    'certificates renew {n} days out, unattended',
    'moved the storage dir onto its own volume',
    'nothing listens on the public interface except the proxy'
  ]
}

// Agents speak in a different register on purpose: they report rather than
// chat, which is how the [agent] role reads as a role and not a costume.
const AGENT_CHATTER = [
  'summary: {n} messages in the last hour, {m} open threads, 0 incidents',
  'indexed {n} events since the last checkpoint',
  'watching #incidents — nothing matches the alert rule',
  'drafted the release note for build {n}, it is in the canvas',
  'mention me and I answer in this channel',
  'the deploy key is held by the relay identity, not by a person',
  // Not '{n} of the last {m}': the two placeholders draw independently, so it
  // rendered as '30 of the last 11 builds were green' on camera.
  '{m} of the last 20 builds were green',
  'that question was answered {n} minutes ago — linking the message',
  'running the reconnect test locally, {n}% complete',
  'triaged {n} alerts, {m} need a human',
  'no answer in the transcript for that one, escalating',
  'the last {n} deploys are summarised in the pinned message',
  'context window held the whole thread, no truncation',
  'answering from the transcript only — nothing outside this room',
  'flagged {n} messages that look like the same question',
  'checkpoint written, {n} events behind the head'
]

const JOB_TASKS = ['summarise-thread', 'triage-incident', 'draft-release-note', 'index-transcript', 'answer-mention']
const REACTIONS = ['+', '🐝', '✅', '👀', '🔥']

// A small deterministic PRNG rather than Math.random: two runs of the recorder
// should differ in timing (that is real) but not in cast, so a demo that looked
// wrong can be re-rendered and compared.
//
// mulberry32, and specifically not the textbook `seed * 1103515245 + 12345`:
// that product exceeds 2^53, so JS loses the low bits before the mask ever runs
// and the "random" stream is badly non-uniform. Measured, not assumed — with the
// LCG a mix declared as 36% messages / 31% ephemeral came back from the relay as
// 23% / 45%. Every step below is int32-exact.
let seed = 0x5eed1e
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(rnd() * list.length) % list.length]

function weighted (pairs) {
  const total = pairs.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = rnd() * total
  for (const [value, weight] of pairs) {
    roll -= weight
    if (roll <= 0) return value
  }
  return pairs[pairs.length - 1][0]
}

/** Fill {n}/{m} with numbers that look like build ids and counts, not like lorem. */
const phrase = (template) =>
  template
    .replace('{n}', String(Math.floor(rnd() * 90) + 10))
    .replace('{m}', String(Math.floor(rnd() * 12) + 2))

async function main () {
  const alice = identity('alice')
  const bob = identity('bob')
  const honey = identity('honey')

  // Connections are opened on demand and dropped when they go quiet, because
  // bare-ws closes an idle client socket after about four seconds — measured:
  // authenticate, sleep 7.5s, publish, and the publish gets no OK because the
  // socket is already gone. The live phases have gaps that long by design, so a
  // long-lived connection per identity silently loses every beat after the
  // first. The browser is not affected; its WebSocket is the platform's.
  const conns = new Map()

  async function connection (who) {
    const held = conns.get(who.name)
    if (held !== undefined && !held.client.closed && Date.now() - held.usedAt < 2000) {
      held.usedAt = Date.now()
      return held.client
    }
    if (held !== undefined) await held.client.destroy()

    const client = await TestClient.openWebSocket({ port: PORT })
    await client.authenticate(who, { relayUrl: RELAY_URL })
    // Under load every identity is a client, and a client watches something.
    // Presence is the cheapest honest thing to watch — a few frames a second
    // rather than the whole firehose — and it makes the `subs` counter in the
    // status bar count real subscriptions instead of standing at zero.
    if (PHASE === 'load') await client.subscribe('presence', { kinds: [core.KIND_PRESENCE_UPDATE], limit: 0 })
    conns.set(who.name, { client, usedAt: Date.now() })
    return client
  }

  // A refusal is printed, never swallowed: a demo recorded against a relay that
  // rejected half the script would otherwise look like an empty room.
  const pub = async (who, template) => {
    const event = core.finalizeEvent(
      { created_at: Math.floor(Date.now() / 1000), ...template },
      who.secretKey
    )
    // One line per event is a useful trace for the four-event phases and a
    // thousand lines of noise for the load phase, which reports rates instead.
    if (PHASE !== 'load') console.log(`${who.name} -> kind ${template.kind}`)
    const ok = await (await connection(who)).publish(event)
    if (!ok.accepted) console.error(`  REFUSED kind ${template.kind} from ${who.name}: ${ok.reason}`)
    return ok
  }

  if (PHASE === 'history') {
    for (const who of [alice, bob, honey]) {
      await pub(who, {
        kind: core.KIND_PROFILE,
        tags: [],
        content: JSON.stringify({ name: who.name, display_name: who.name })
      })
    }

    // What makes honey render as an agent rather than a third human: kind 10100
    // is the only thing the client keys the [agent] role and the │ gutter off.
    await pub(honey, {
      kind: core.KIND_AGENT_PROFILE,
      tags: [['p', alice.pubkey]],
      content: JSON.stringify({
        owner: alice.pubkey,
        persona: 'honey',
        runtime: 'qvac',
        capabilities: ['text-generation'],
        models: ['L']
      })
    })

    for (const [name, about] of [
      [CH.design, 'surfaces and motion'],
      [CH.engineering, 'builds, incidents, deploys']
    ]) {
      await pub(alice, {
        kind: core.KIND_NIP29_CREATE_GROUP,
        tags: [['h', channelId(name)], ['name', name], ['about', about]],
        content: ''
      })
    }

    for (const name of [CH.design, CH.engineering]) {
      for (const who of [bob, honey]) {
        await pub(who, { kind: core.KIND_NIP29_JOIN_REQUEST, tags: [['h', channelId(name)]], content: '' })
      }
    }

    // Backdated so the transcript reads as a room with a past. 47s apart puts
    // visibly different clock times on the rows.
    const transcripts = [
      [CH.design, [
        [alice, 'the panel border carries the title, like the TUI'],
        [bob, 'and the footer rides in the bottom rule']
      ]],
      [CH.engineering, [
        [alice, 'relay build 42 is green on the swarm transport'],
        [bob, 'nice, I will take the flaky reconnect test'],
        [honey, 'honey here — mention me and I answer in this channel'],
        [alice, 'who owns the deploy key for staging?'],
        [bob, 'I will deploy build 42 after lunch'],
        [honey, 'the deploy key is held by the relay identity, not by a person']
      ]]
    ]

    for (const [name, script] of transcripts) {
      const t0 = Math.floor(Date.now() / 1000) - script.length * 47
      for (const [i, [who, content]] of script.entries()) {
        await pub(who, {
          kind: core.KIND_STREAM_MESSAGE,
          tags: [['h', channelId(name)]],
          content,
          created_at: t0 + i * 47
        })
      }
    }

    for (const who of [alice, bob, honey]) {
      await pub(who, { kind: core.KIND_PRESENCE_UPDATE, tags: [], content: 'online' })
    }

    console.log(`seeded #engineering = ${channelId(CH.engineering)}`)
  }

  // ---------------------------------------------------------------- a2a --
  //
  // The room scripts/demo-delegation.js runs inside, furnished for the camera
  // (docs/demo-a2a.gif). Deliberately SMALL where `load` is deliberately big:
  // the claim this take has to carry is "whose agent is whose", so every human
  // and every agent has to be on screen at once, in a members panel that is
  // about nine rows tall. 24 members would put honey and scout below the fold
  // and the ownership — which is the whole point — would be invisible.
  //
  // Three humans, three agents, one each. forge belongs to cass and never says
  // a word during the delegation: an idle third agent is what makes "each
  // member has their own" read as a property of the room rather than as a
  // two-agent special case.
  //
  // Everything here is published BEFORE the browser loads, because the client
  // resolves kind-10100 once at boot (app.js loadAgents). An agent whose
  // profile lands later renders as a fourth human for the rest of the take.
  if (PHASE === 'a2a') {
    const cass = identity('cass')
    const scout = identity('scout')
    const forge = identity('forge')

    const humans = [alice, bob, cass]
    const bots = [honey, scout, forge]

    for (const who of humans) {
      await pub(who, {
        kind: core.KIND_PROFILE,
        tags: [],
        content: JSON.stringify({ name: who.name, display_name: who.name })
      })
    }

    // Kind 10100 is the only thing the client keys the [agent] role, the │
    // gutter and the `[agent · alice]` suffix off. `owner` is what makes it
    // whose. AGENT_OWNERS is the single source of that pairing, shared with
    // scripts/demo-delegation.js so the two cannot disagree.
    for (const who of bots) {
      const holder = identity(AGENT_OWNERS[who.name])
      await pub(who, {
        kind: core.KIND_AGENT_PROFILE,
        tags: [['p', holder.pubkey]],
        content: JSON.stringify({
          owner: holder.pubkey,
          persona: who.name,
          runtime: 'scripted',
          capabilities: ['text-generation'],
          models: ['L']
        })
      })
    }

    // #design first so it sorts first (listChannels is ORDER BY created_at
    // ASC) and the page boots somewhere other than #engineering — which keeps
    // the recorder's click a real navigation rather than a no-op.
    const rooms = [
      [CH.design, 'surfaces and motion'],
      [CH.engineering, 'builds, incidents, deploys'],
      [CH.releases, 'what is shipping and when'],
      [CH.incidents, 'page here, talk here, resolve here']
    ]
    for (const [name, about] of rooms) {
      await pub(alice, {
        kind: core.KIND_NIP29_CREATE_GROUP,
        tags: [['h', channelId(name)], ['name', name], ['about', about]],
        content: ''
      })
    }

    for (const [name] of rooms) {
      for (const who of [bob, cass, ...bots]) {
        await pub(who, { kind: core.KIND_NIP29_JOIN_REQUEST, tags: [['h', channelId(name)]], content: '' })
      }
    }

    // A room with a past, so the transcript is full in frame one and the
    // delegation arrives into a conversation rather than into a blank pane.
    // The subject matter is the one alice is about to ask about: the take
    // should read as a normal Tuesday, not as a scripted set-up.
    const transcripts = [
      [CH.design, [
        [alice, 'the panel border carries the title, like the TUI'],
        [cass, 'and the footer rides in the bottom rule'],
        [forge, 'contrast pass: every pair in tokens.css clears AA, the red had to be lifted'],
        [bob, 'good — the old one was 3.93:1 and it was body text'],
        [alice, 'selection stays a glyph as well as a colour, so it survives colour off']
      ]],
      [CH.releases, [
        [bob, 'cut list for build 42 is frozen apart from the rollback path'],
        [forge, 'nightly: 3 suites green, 1 flaky — the reconnect test again'],
        [cass, 'holding the tag until that one is understood, not just re-run']
      ]],
      [CH.engineering, [
        [bob, 'swarm transport is green on all three runners this morning'],
        [honey, 'overnight: 0 open incidents, 1 flaky suite, 2 PRs waiting on review'],
        [cass, 'the storage dir was not being cleaned between runs — that was it'],
        [alice, 'release train for build 42 is still amber'],
        [cass, 'I will take the flaky reconnect test after standup'],
        [forge, 'reran it 40 times on the runner: 2 failures, both on cold start'],
        [alice, 'cold start meaning no warm socket? that is a timing assumption, not a race'],
        [bob, 'rollback path wants one more review before we cut'],
        [honey, 'honey here — mention me in this channel and I answer']
      ]]
    ]

    for (const [name, script] of transcripts) {
      const t0 = Math.floor(Date.now() / 1000) - script.length * 47
      for (const [i, [who, content]] of script.entries()) {
        await pub(who, {
          kind: core.KIND_STREAM_MESSAGE,
          tags: [['h', channelId(name)]],
          content,
          created_at: t0 + i * 47
        })
      }
    }

    // Presence is ephemeral — broadcast, never stored — so these move the dots
    // in the members panel for any client already connected, and the relay's
    // presence projection answers /api/presence for one that connects later.
    for (const who of [alice, bob, honey, scout, forge]) {
      await pub(who, { kind: core.KIND_PRESENCE_UPDATE, tags: [], content: 'online' })
    }
    await pub(cass, { kind: core.KIND_PRESENCE_UPDATE, tags: [], content: 'away' })

    console.log(`[a2a] seeded #engineering = ${channelId(CH.engineering)}`)
    console.log('[a2a] seed complete: 3 humans, 3 agents, 4 channels')
  }

  if (PHASE === 'live-1') {
    const eng = [['h', channelId(CH.engineering)]]
    const beats = [
      [0, () => pub(alice, { kind: core.KIND_STREAM_MESSAGE, tags: eng, content: 'staging is back — build 42 rolled out clean' })],
      [2600, () => pub(bob, { kind: core.KIND_STREAM_MESSAGE, tags: eng, content: 'confirmed, the reconnect test is green now' })],
      // Presence is broadcast and never stored, so the firehose IS the presence
      // feed: this one event moves bob's dot in the members panel.
      [2400, () => pub(bob, { kind: core.KIND_PRESENCE_UPDATE, tags: [], content: 'away' })],
      [2200, () => pub(honey, { kind: core.KIND_STREAM_MESSAGE, tags: eng, content: 'summary: build 42 deployed, 1 flaky test fixed, 0 open incidents' })]
    ]
    for (const [delay, beat] of beats) {
      await sleep(delay)
      await beat()
    }
  }

  if (PHASE === 'live-2') {
    await pub(honey, {
      kind: core.KIND_STREAM_MESSAGE,
      tags: [['h', channelId(CH.engineering)]],
      content: 'on call tonight is bob — the rotation lives in the channel canvas'
    })
  }

  // --------------------------------------------------------------- load --

  if (PHASE === 'load') {
    const RATE = flag('rate', 40)
    const SECONDS = flag('seconds', 30)
    const BACKFILL = flag('backfill', 220)
    const SPAN = flag('span', 100 * 60) // seconds of backdated history

    const humans = HUMAN_NAMES.map(identity)
    const agents = AGENT_NAMES.map(identity)
    const everyone = [...humans, ...agents]
    const owner = humans[0]

    // The relay enforces a per-pubkey token bucket (hive-auth/lib/ratelimit.js)
    // and workers/main.js configures it at the `human` tier: 30 events per 60s,
    // burst 60. That is the ceiling this phase runs into, so the schedule is
    // planned against a MIRROR of the relay's own bucket, built from the relay's
    // own tier table — the mirror cannot drift from what is enforced. Without
    // it the demo would film a wall of refusals a few seconds in.
    //
    // Raise the relay's tier and pass the same tier= here to go faster. The
    // relay's default is untouched and stays `human`.
    const tierName = flag('tier', 'human')
    const tier = TIERS[tierName] ?? TIERS.human
    //
    // Buckets are created on first use, exactly as RateLimiter does it, and not
    // up front: a bucket born at process start has accrued refill the relay's
    // has not, and that drift alone was worth four refusals at the tail of a
    // 30s run.
    const buckets = new Map()
    const bucket = (who) => {
      let held = buckets.get(who.name)
      if (held === undefined) {
        // Two tokens of headroom: the mirror is a model, and a model that is
        // occasionally optimistic produces a `rate-limited: slow down` in the
        // recorder's stderr, which the recorder treats as a failed take. Being
        // 2 events per pubkey stricter than the relay costs ~3% of the budget
        // and makes a refusal a real signal again.
        held = new TokenBucket(tier.burst - 2, tier.events / tier.window, Date.now())
        buckets.set(who.name, held)
      }
      return held
    }
    let starved = 0

    /** A speaker from `pool` who can still afford a token, or null if all are dry. */
    function speaker (pool) {
      // Probing from a random offset rather than from index 0: a scan would let
      // the first identities do all the talking and drain in name order.
      const start = Math.floor(rnd() * pool.length)
      for (let i = 0; i < pool.length; i++) {
        const who = pool[(start + i) % pool.length]
        if (bucket(who).take(1, Date.now())) return who
      }
      starved++
      return null
    }

    /**
     * Publish, and keep the mirror honest.
     *
     * A `rate-limited` refusal is proof that the relay's bucket for that pubkey
     * is emptier than ours, so ours is emptied to match rather than being left
     * to argue with the relay for the rest of the run. Self-correcting beats
     * assuming the model is right.
     */
    const publish = async (who, template) => {
      const ok = await pub(who, template)
      if (!ok.accepted && String(ok.reason).startsWith('rate-limited')) bucket(who).tokens = 0
      if (ok.accepted) histogram.set(template.kind, (histogram.get(template.kind) ?? 0) + 1)
      return ok
    }

    // Every publish in this phase is charged to the mirror, setup included. An
    // earlier version charged only the chatter, and the ~150 uncharged profile,
    // create, join and presence events were exactly the drift that produced a
    // run with 89 `rate-limited: slow down` refusals in it.
    const spend = async (who, template) => {
      if (!bucket(who).take(1, Date.now())) {
        starved++
        console.error(`  BUDGET ${who.name} is out of tokens; skipping kind ${template.kind}`)
        return { accepted: false }
      }
      return publish(who, template)
    }

    // Who is in which channel. Everyone is in #engineering because that is the
    // channel the recorder films; the rest get a plausible subset. Derived from
    // the seeded PRNG and never from the store, so the live half can run against
    // a relay this process did not seed.
    const roster = new Map(Object.values(CH).map((name) => [name, []]))
    for (const who of everyone) {
      roster.get(CH.engineering).push(who)
      for (const name of Object.values(CH)) {
        if (name !== CH.engineering && rnd() < 0.45) roster.get(name).push(who)
      }
    }
    // A channel with one member cannot hold a conversation.
    for (const [name, list] of roster) {
      while (list.length < 4) list.push(everyone[(list.length * 7 + name.length) % everyone.length])
    }
    const agentsIn = (name) => roster.get(name).filter((who) => AGENT_NAMES.includes(who.name))

    // Reaction targets: a reaction's channel is taken from the event it points
    // at (relay.js:370), so reacting to a message we watched land is the only
    // way to be sure the reaction is legal.
    const recent = new Map(Object.values(CH).map((name) => [name, []]))
    const remember = (name, id) => {
      const list = recent.get(name)
      list.push(id)
      if (list.length > 40) list.shift()
    }

    // Repetition is not only a cosmetic problem here.
    //
    // An event id is the hash of (pubkey, created_at, kind, tags, content), and
    // created_at has one-second resolution. Two identical lines from one author
    // inside one second are therefore the SAME event: the relay answers OK,
    // stores nothing, and — the part that matters — returns before it
    // broadcasts (relay.js, `result.wasInserted`). The browser never sees it,
    // while the seeder counts it as sent, so the reported rate drifts above the
    // rate that arrives. Measured with this window removed: 700 stream messages
    // published, 693 stored, so 7 events (1%) were silently swallowed. Small,
    // but it is the one way this script can lie about throughput — and not
    // saying the same sentence twice in forty lines reads better anyway.
    //
    // Deduped on the TEMPLATE and not on the rendered line, which is the fix
    // for the visible half of the problem: phrase() fills in {n}, so two draws
    // of one sentence differ by a number and slip past a text-level check. On
    // camera that reads as filler — the first high-load take had "p99 on the
    // query path is {n}ms" four times on a single screen of #engineering. One
    // window per pool PER CHANNEL, kept shorter than the pool so the retry
    // always has somewhere to go. Per channel matters for the agents, who share
    // one pool across six rooms: with a single global window, three of the nine
    // agent lines on one screen of #incidents were the same sentence, because
    // the repeats were spaced far apart in a stream that the viewer only ever
    // sees one channel of.
    const said = new Map()
    function line (name, isAgent) {
      const pool = isAgent ? AGENT_CHATTER : CHATTER[name]
      const key = isAgent ? name + '/agent' : name
      let window = said.get(key)
      if (window === undefined) said.set(key, window = [])

      // Drawn from what is LEFT rather than redrawn until it is fresh: with a
      // window one short of the pool there is exactly one legal answer, and 16
      // random redraws find it only two times in three — which is how two
      // agents said 'answering from the transcript only' five lines apart on
      // camera. Filtering cannot miss.
      const fresh = pool.filter((candidate) => !window.includes(candidate))
      const template = pick(fresh.length > 0 ? fresh : pool)
      window.push(template)
      while (window.length > Math.min(pool.length - 1, 24)) window.shift()
      return phrase(template)
    }

    // Same rule for reactions, whose content space is only five glyphs wide.
    // Measured at 0 collisions either way — forty candidate targets is a lot of
    // entropy — so this one is a guard rather than a fix.
    const reacted = []
    function reaction (who, id) {
      let glyph = pick(REACTIONS)
      for (let i = 0; i < 5 && reacted.includes(`${who.name}:${id}:${glyph}`); i++) glyph = pick(REACTIONS)
      reacted.push(`${who.name}:${id}:${glyph}`)
      if (reacted.length > 400) reacted.shift()
      return glyph
    }

    // What actually went out, by kind. Printed at the end and reconciled
    // against `load-check`: published − ephemeral should equal stored.
    const histogram = new Map()
    let total = 0

    // ---- backfill: the room as it already was --------------------------

    if (BACKFILL > 0) {
      for (const who of everyone) {
        await spend(who, {
          kind: core.KIND_PROFILE,
          tags: [],
          content: JSON.stringify({ name: who.name, display_name: who.name })
        })
        total++
      }

      // Kind 10100 is the only thing the client keys the [agent] role and the
      // │ gutter off, so without these six the agents read as six more humans.
      //
      // Each one names a DIFFERENT owner (AGENT_OWNERS). An earlier version
      // pointed all six at humans[0], which rendered as one person owning every
      // machine in the building — the opposite of the point. The client reads
      // this `owner` back and renders `[agent · alice]`.
      for (const who of agents) {
        const holder = identity(AGENT_OWNERS[who.name] ?? owner.name)
        await spend(who, {
          kind: core.KIND_AGENT_PROFILE,
          tags: [['p', holder.pubkey]],
          content: JSON.stringify({
            owner: holder.pubkey,
            persona: who.name,
            runtime: 'qvac',
            capabilities: ['text-generation', 'summarisation'],
            models: ['L']
          })
        })
        total++
      }

      const about = {
        [CH.design]: 'surfaces and motion',
        [CH.engineering]: 'builds, incidents, deploys',
        [CH.incidents]: 'page here, talk here, resolve here',
        [CH.releases]: 'what is shipping and when',
        [CH.product]: 'what we are building and why',
        [CH.ops]: 'keys, disks, boxes'
      }
      // #design first, so the page still boots somewhere other than
      // #engineering and the recorder's click stays a real navigation.
      for (const name of [CH.design, CH.engineering, CH.incidents, CH.releases, CH.product, CH.ops]) {
        await spend(owner, {
          kind: core.KIND_NIP29_CREATE_GROUP,
          tags: [['h', channelId(name)], ['name', name], ['about', about[name]]],
          content: ''
        })
        total++
      }

      for (const [name, list] of roster) {
        for (const who of list) {
          if (who.name === owner.name) continue // the creator is already in
          await spend(who, { kind: core.KIND_NIP29_JOIN_REQUEST, tags: [['h', channelId(name)]], content: '' })
          total++
        }
      }

      // Backdated across SPAN seconds and stopping short of now, so the
      // transcript reads as a room with a past rather than as a burst that
      // arrived one second before the camera.
      const now = Math.floor(Date.now() / 1000)
      for (let i = 0; i < BACKFILL; i++) {
        const name = weighted(CHANNEL_WEIGHTS)
        const who = speaker(roster.get(name))
        if (who === null) break
        const isAgent = AGENT_NAMES.includes(who.name)
        const createdAt = now - SPAN + Math.floor((i / BACKFILL) * (SPAN - 45))
        const ok = await publish(who, {
          kind: core.KIND_STREAM_MESSAGE,
          tags: [['h', channelId(name)]],
          content: line(name, isAgent),
          created_at: createdAt
        })
        total++
        if (ok.accepted) remember(name, ok.id)

        // A fifth of the backfill carries a reaction, so the flow pane's first
        // forty events are not forty rows of the same kind.
        if (ok.accepted && rnd() < 0.2) {
          const fan = speaker(roster.get(name))
          if (fan !== null) {
            await publish(fan, {
              kind: core.KIND_REACTION,
              tags: [['e', ok.id]],
              content: reaction(fan, ok.id),
              created_at: createdAt + 1
            })
            total++
          }
        }
      }

      for (const who of everyone) {
        const state = rnd() < 0.75 ? 'online' : 'away'
        await spend(who, { kind: core.KIND_PRESENCE_UPDATE, tags: [], content: state })
        total++
      }

      // The recorder waits for this line before it opens the browser: the
      // transcript has to be full in the very first frame.
      console.log(`[load] backfill complete: ${total} events, ${everyone.length} identities, ${roster.size} channels`)
      console.log(`[load] #engineering = ${channelId(CH.engineering)}`)
    }

    // ---- live: a sustained stream while the camera runs -----------------

    if (SECONDS > 0) {
      // The mirror is per-process. Backfilling in one process and streaming in
      // another gives the second process 24 full buckets that the relay knows
      // are two-thirds empty, and the difference comes back as refusals. One
      // process doing both is the supported shape; the recorder waits for the
      // `backfill complete` line instead of waiting for the process to exit.
      if (BACKFILL === 0) {
        console.log('[load] NOTE: backfill=0, so the rate-limit mirror starts full. Against a relay that was seeded moments ago by another process, expect refusals until its buckets refill (60 tokens at 0.5/s = 2 minutes).')
      }

      /** One event. Returns false when the rate limit has drained the pool. */
      async function beat () {
        const kind = weighted(KIND_MIX)
        // Three tries at a channel before giving up on the beat: a small
        // channel's roster drains long before the workspace does, and moving
        // the traffic elsewhere is what a busy room actually looks like. Only
        // when every channel is dry is the run genuinely saturated.
        let name = weighted(CHANNEL_WEIGHTS)
        for (let i = 0; i < 2 && !roster.get(name).some((who) => bucket(who).tokens >= 1); i++) {
          name = weighted(CHANNEL_WEIGHTS)
        }
        const h = [['h', channelId(name)]]

        if (kind === 'reaction' && recent.get(name).length > 0) {
          const who = speaker(roster.get(name))
          if (who === null) return false
          // Tagged with the target only: the relay derives the channel from it.
          const target = pick(recent.get(name))
          return (await publish(who, { kind: core.KIND_REACTION, tags: [['e', target]], content: reaction(who, target) })).accepted
        }

        if (kind === 'typing') {
          const who = speaker(roster.get(name))
          if (who === null) return false
          return (await publish(who, { kind: core.KIND_TYPING_INDICATOR, tags: h, content: '' })).accepted
        }

        if (kind === 'presence') {
          const who = speaker(everyone)
          if (who === null) return false
          return (await publish(who, { kind: core.KIND_PRESENCE_UPDATE, tags: [], content: rnd() < 0.7 ? 'online' : 'away' })).accepted
        }

        // A job belongs to an agent, and a channel may have few of them, so a
        // dry agent pool falls through to the message path rather than dropping
        // the beat: the rate stays honest and the mix shifts, which is what
        // happens when the machines in a room are busy.
        if (kind === 'job') {
          const pool = agentsIn(name)
          const who = pool.length === 0 ? null : speaker(pool)
          if (who !== null) {
            const stage = weighted([[core.KIND_JOB_REQUEST, 3], [core.KIND_JOB_PROGRESS, 4], [core.KIND_JOB_RESULT, 3]])
            return (await publish(who, {
              kind: stage,
              tags: h,
              content: JSON.stringify({ task: pick(JOB_TASKS), percent: Math.floor(rnd() * 100) })
            })).accepted
          }
        }

        const who = speaker(roster.get(name))
        if (who === null) return false
        const isAgent = AGENT_NAMES.includes(who.name)
        const ok = await publish(who, {
          kind: core.KIND_STREAM_MESSAGE,
          tags: h,
          content: line(name, isAgent)
        })
        if (ok.accepted) remember(name, ok.id)
        return ok.accepted
      }

      // The arithmetic that decides whether this demo is possible at all.
      //
      // The tier refills at events/window per pubkey, so the workspace's
      // SUSTAINED ceiling is identities x refill — 12 ev/s at the human tier
      // with this cast. Everything above that is financed out of burst, which
      // is a fixed pot: at RATE ev/s it runs dry after `affordable` seconds.
      // A demo longer than that does not need a faster relay, it needs more
      // identities, a smaller backfill or a higher tier.
      const refill = everyone.length * (tier.events / tier.window)
      const pot = everyone.length * tier.burst - total
      const affordable = RATE <= refill ? Infinity : pot / (RATE - refill)

      console.log(`[load] live: target ${RATE} ev/s for ${SECONDS}s, tier ${tierName} (burst ${tier.burst}, ${tier.events}/${tier.window}s per pubkey)`)
      console.log(`[load] budget: ${refill.toFixed(1)} ev/s sustained across ${everyone.length} identities, ${pot} burst tokens left after the backfill — ${RATE} ev/s is affordable for ~${affordable === Infinity ? '∞' : affordable.toFixed(0)}s`)
      if (SECONDS > affordable) {
        console.log(`[load] WARNING: ${SECONDS}s at ${RATE} ev/s exceeds the burst budget; the tail of the run will thin out`)
      }

      const t0 = Date.now()
      const deadline = t0 + SECONDS * 1000
      let sent = 0
      let failed = 0
      let scheduled = 0
      let reportedAt = t0
      let reportedSent = 0

      while (Date.now() < deadline) {
        // Scheduled against absolute time, not by sleeping the interval: sleep
        // drift would quietly turn a 40 ev/s target into 31 ev/s and the demo
        // would report a rate it never achieved.
        const due = t0 + (scheduled * 1000) / RATE
        const wait = due - Date.now()
        if (wait > 0) await sleep(wait)
        scheduled++

        if (await beat()) sent++
        else failed++

        if (Date.now() - reportedAt >= 5000) {
          const window = (Date.now() - reportedAt) / 1000
          console.log(`[load] t+${Math.round((Date.now() - t0) / 1000)}s  ${((sent - reportedSent) / window).toFixed(1)} ev/s  (${sent} sent, ${failed} not sent, ${starved} starved)`)
          reportedAt = Date.now()
          reportedSent = sent
        }
      }

      const elapsed = (Date.now() - t0) / 1000
      total += sent
      console.log(`[load] live done: ${sent} events in ${elapsed.toFixed(1)}s = ${(sent / elapsed).toFixed(1)} ev/s achieved of ${RATE} targeted`)
      // Starvation is the honest failure mode here: it means the per-pubkey
      // rate limit, not the relay, decided the ceiling. Reported, never hidden.
      if (failed > 0 || starved > 0) {
        console.log(`[load] SATURATED: ${failed} beats produced no event and ${starved} found a dry pool — the ${tierName} tier is the ceiling here, not the relay's ingest`)
      }
      console.log(`[load] total published this run: ${total}`)
      const rows = [...histogram].sort((a, b) => b[1] - a[1])
      for (const [kind, count] of rows) {
        console.log(`  ${String(count).padStart(5)}  kind ${kind}${core.isEphemeral(kind) ? ' (ephemeral — broadcast, never stored)' : ''}`)
      }
    }
  }

  // Reads back what the load phase claims to have written. Ephemeral kinds
  // (presence, typing) are verified by the relay and deliberately never stored,
  // so they are absent here by design and the totals will not match the ev/s.
  if (PHASE === 'load-check') {
    const MIN = flag('min', 600)
    const client = await connection(identity(HUMAN_NAMES[0]))

    // COUNT does not count: relay.js `_handleCount` answers with
    // `_queryAuthorized(filters).length`, and that query is clamped to
    // LIMITS.MAX_HISTORICAL_LIMIT (500) — the store's own countEvents() runs a
    // real SQL COUNT and is not used on this path. So a single COUNT for kind 9
    // reports exactly 500 once the room holds more than that, which is how a
    // 919-message run first looked like a 500-message run. Messages are
    // therefore counted one channel at a time, and any bucket that comes back
    // at the cap is called out rather than summed as if it were a number.
    const CAP = 500
    const groups = [
      ...Object.values(CH).map((name) =>
        [`stream messages in #${name}`, [{ kinds: [core.KIND_STREAM_MESSAGE], '#h': [channelId(name)] }]]),
      // Reactions carry only an `e` tag — the relay derives their channel from
      // the target — so there is no #h to split them by.
      ['reactions', [{ kinds: [core.KIND_REACTION] }]],
      ['profiles', [{ kinds: [core.KIND_PROFILE] }]],
      ['agent profiles', [{ kinds: [core.KIND_AGENT_PROFILE] }]],
      ['channel creates', [{ kinds: [core.KIND_NIP29_CREATE_GROUP] }]],
      ['join requests', [{ kinds: [core.KIND_NIP29_JOIN_REQUEST] }]],
      ['agent jobs', [{ kinds: [core.KIND_JOB_REQUEST, core.KIND_JOB_PROGRESS, core.KIND_JOB_RESULT] }]]
    ]

    let stored = 0
    let capped = 0
    for (const [label, filters] of groups) {
      const { closed, count } = await client.count('check', ...filters)
      if (closed !== null) throw new Error(`COUNT ${label} refused: ${closed}`)
      stored += count
      if (count === CAP) capped++
      console.log(`  ${String(count).padStart(5)}  ${label}${count === CAP ? '  (at the COUNT cap — the real number is higher)' : ''}`)
    }

    const ok = stored >= MIN
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${stored} stored events${capped > 0 ? ` (${capped} buckets saturated the cap, so this is a floor)` : ''}, expected at least ${MIN}`)
    console.log('note: presence and typing are ephemeral — verified and broadcast by the relay, never stored, so they are absent here by design')
    if (!ok) Bare.exitCode = 1
  }

  for (const { client } of conns.values()) await client.destroy()
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
