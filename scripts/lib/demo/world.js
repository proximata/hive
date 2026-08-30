'use strict'

// The demo's model layer: one real relay, five real identities, and a plain
// object the TUI panes read from.
//
// Nothing here is a mock. The world boots the same relay scripts/demo.js does
// and drives it through the same CLI a user would type, then projects the
// relay's own event stream into `world.state`. The panes never query the store
// and never poll — if a pane shows it, an event put it there.

const os = require('bare-os')
const path = require('bare-path')
const fs = require('bare-fs')
const b4a = require('b4a')

const core = require('hive-core')
const { openStore } = require('hive-store')
const { Relay, WebSocketTransport, SwarmTransport, MediaStore } = require('hive-relay')
const { WorkflowEngine } = require('hive-workflow')
const { Agent, MockProvider, RelayConnection } = require('hive-agent')
const { run } = require('hive-cli')

const DHT = require('hyperdht')
const createTestnet = require('hyperdht/testnet')

const ACTORS = ['admin', 'alice', 'bob', 'carol', 'honey']

const FLOW_CAP = 200
const NOTICE_CAP = 20
const MESSAGE_CAP = 200
const AUDIT_LIMIT = 100
const RATE_WINDOW_MS = 10000
const SYNC_DEBOUNCE_MS = 20
const ATTACH_POLL_MS = 1000

const HONEY_PERSONA = {
  slug: 'honey',
  display_name: 'Honey',
  system_prompt: 'You summarize incidents for the engineering channel.',
  runtime: 'mock',
  model: 'mock-1'
}

// A reverse index of hive-core's kind registry. The flow pane needs a human
// label for every kind that can appear, and that list keeps growing — deriving
// it means this file can never fall behind kinds.js.
const KIND_LABELS = new Map(
  Object.entries(core)
    .filter(([name, value]) => name.startsWith('KIND_') && typeof value === 'number')
    .map(([name, value]) => [value, name.slice(5).toLowerCase().replace(/_/g, ' ')])
)

const MESSAGE_KINDS = new Set([
  core.KIND_STREAM_MESSAGE,
  core.KIND_STREAM_MESSAGE_V2,
  core.KIND_STREAM_MESSAGE_DIFF,
  core.KIND_SYSTEM_MESSAGE
])

// kind -> which derived slices of the state it invalidates.
const DERIVED = new Map([
  [core.KIND_NIP29_CREATE_GROUP, ['channels', 'members']],
  [core.KIND_NIP29_EDIT_METADATA, ['channels']],
  [core.KIND_NIP29_DELETE_GROUP, ['channels', 'members']],
  [core.KIND_NIP29_PUT_USER, ['members']],
  [core.KIND_NIP29_REMOVE_USER, ['members']],
  [core.KIND_NIP29_JOIN_REQUEST, ['members']],
  [core.KIND_NIP29_LEAVE_REQUEST, ['members']],
  [core.KIND_MEMBER_ADDED_NOTIFICATION, ['members']],
  [core.KIND_MEMBER_REMOVED_NOTIFICATION, ['members']],
  [core.KIND_IA_ARCHIVED, ['channels']],
  [core.KIND_IA_UNARCHIVED, ['channels']],
  [core.KIND_CANVAS, ['channels']],
  [core.KIND_DM_CREATED, ['channels', 'members']],
  [core.KIND_DM_OPEN, ['channels', 'members']],
  [core.KIND_DM_ADD_MEMBER, ['channels', 'members']],
  [core.KIND_NIP43_MEMBER_ADDED, ['relayMembers']],
  [core.KIND_NIP43_MEMBER_REMOVED, ['relayMembers']],
  [core.KIND_NIP43_ADD_MEMBER, ['relayMembers']],
  [core.KIND_NIP43_REMOVE_MEMBER, ['relayMembers']],
  [core.KIND_NIP43_CHANGE_ROLE, ['relayMembers']],
  [core.KIND_WORKFLOW_DEF, ['workflows']],
  [core.KIND_WORKFLOW_TRIGGER, ['runs']],
  [core.KIND_AGENT_PROFILE, ['agents']],
  [core.KIND_PERSONA, ['personas']]
])

for (const kind of [
  core.KIND_WORKFLOW_TRIGGERED, core.KIND_WORKFLOW_STEP_STARTED, core.KIND_WORKFLOW_STEP_COMPLETED,
  core.KIND_WORKFLOW_STEP_FAILED, core.KIND_WORKFLOW_COMPLETED, core.KIND_WORKFLOW_FAILED,
  core.KIND_WORKFLOW_CANCELLED, core.KIND_WORKFLOW_APPROVAL_REQUESTED,
  core.KIND_WORKFLOW_APPROVAL_GRANTED, core.KIND_WORKFLOW_APPROVAL_DENIED,
  core.KIND_APPROVAL_GRANT, core.KIND_APPROVAL_DENY
]) DERIVED.set(kind, ['runs'])

function labelFor (kind) {
  return KIND_LABELS.get(kind) ?? `kind ${kind}`
}

function safeJson (text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * A demo identity. With a seed the key is derived rather than random, so a
 * recorded run replays with the same pubkeys, the same npubs and the same
 * audit hashes frame for frame.
 */
function identity (name, seed) {
  const secretKey = seed === null
    ? core.generateSecretKey()
    : core.sha256(b4a.from(`hive-demo/${seed}/${name}`, 'utf8'))

  const pubkey = core.getPublicKey(secretKey)
  return { name, secretKey, secretKeyHex: core.toHex(secretKey), pubkey, npub: core.encodeNpub(pubkey) }
}

async function createWorld ({ dir = null, relayUrl = null, swarm = true, seed = null } = {}) {
  const attached = relayUrl !== null
  const ephemeral = dir === null && !attached
  const root = dir ?? path.join(os.tmpdir(), `hive-demo-${Date.now()}`)
  if (!attached) fs.mkdirSync(root, { recursive: true })

  const actors = {}
  for (const name of ACTORS) actors[name] = identity(name, seed)

  const state = {
    channels: [],
    activeChannel: null,
    messages: {},
    dms: [],
    members: {},
    relayMembers: [],
    flow: [],
    audit: { verified: true, head: null, entries: [] },
    workflows: [],
    runs: [],
    personas: [],
    agents: [],
    caption: '',
    notices: []
  }

  const beats = [] // event timestamps inside the rate window
  const unread = new Map() // channelId -> count since it was last active
  const remote = { connections: 0, subscriptions: 0 }

  let dirty = new Set()
  let syncTimer = null
  let pollTimer = null
  let closed = false
  let agent = null
  let localPersonas = []

  let testnet = null
  let store = null
  let relay = null
  let transport = null
  let swarmTransport = null
  let url = relayUrl

  // ------------------------------------------------------------------ boot --

  if (!attached) {
    if (swarm) testnet = await createTestnet(3)

    store = openStore(path.join(root, 'hive.db'))
    relay = new Relay(store, { url: 'ws://127.0.0.1' })
    relay.workflowEngine = new WorkflowEngine(relay)

    transport = new WebSocketTransport(relay, { port: 0, mediaStore: new MediaStore(path.join(root, 'media')) })
    await transport.listen()
    url = `http://127.0.0.1:${transport.port}`

    if (swarm) {
      swarmTransport = new SwarmTransport(relay, { dht: new DHT({ bootstrap: testnet.bootstrap }) })
      await swarmTransport.listen()
    }
  }

  // --------------------------------------------------------------- helpers --

  function notice (text, level = 'info') {
    state.notices.push({ text, level })
    if (state.notices.length > NOTICE_CAP) state.notices.shift()
  }

  function nameFor (pubkey) {
    for (const actor of Object.values(actors)) {
      if (actor.pubkey === pubkey) return actor.name
    }
    if (relay !== null && pubkey === relay.pubkey) return 'relay'
    const user = store === null ? null : store.getUser(pubkey)
    return user?.displayName ?? pubkey.slice(0, 8)
  }

  function pushFlow (entry) {
    state.flow.push(entry)
    if (state.flow.length > FLOW_CAP) state.flow.shift()
  }

  function trimBeats () {
    const cutoff = Date.now() - RATE_WINDOW_MS
    while (beats.length > 0 && beats[0] < cutoff) beats.shift()
  }

  // ------------------------------------------------------------ projection --

  function appendMessage (event, channelId) {
    if (typeof channelId !== 'string') return

    const list = state.messages[channelId] ?? (state.messages[channelId] = [])
    if (list.some((message) => message.id === event.id)) return

    list.push({
      id: event.id,
      pubkey: event.pubkey,
      author: nameFor(event.pubkey),
      content: event.content,
      ts: event.created_at,
      reactions: {},
      kind: event.kind
    })
    if (list.length > MESSAGE_CAP) list.shift()

    if (channelId !== state.activeChannel) unread.set(channelId, (unread.get(channelId) ?? 0) + 1)
    touch('channels')
  }

  function findMessage (id) {
    for (const list of Object.values(state.messages)) {
      const found = list.find((message) => message.id === id)
      if (found !== undefined) return found
    }
    return null
  }

  function applyReaction (event) {
    // NIP-25 puts the target last, so a reaction to a reply is attributed to
    // the reply rather than to the thread root.
    const referenced = core.referencedEvents(event)
    const message = referenced.length === 0 ? null : findMessage(referenced[referenced.length - 1])
    if (message === null) return

    const emoji = event.content === '' ? '+' : event.content
    message.reactions[emoji] = (message.reactions[emoji] ?? 0) + 1
  }

  function applyDeletion (event) {
    const removed = new Set(core.referencedEvents(event))
    for (const [channelId, list] of Object.entries(state.messages)) {
      state.messages[channelId] = list.filter((message) => !removed.has(message.id))
    }
  }

  function onEvent (event, channelId) {
    beats.push(Date.now())

    pushFlow({
      kind: event.kind,
      author: nameFor(event.pubkey),
      label: labelFor(event.kind),
      ok: true,
      note: typeof channelId === 'string' ? channelId.slice(0, 8) : ''
    })

    if (MESSAGE_KINDS.has(event.kind)) appendMessage(event, channelId)
    else if (event.kind === core.KIND_REACTION) applyReaction(event)
    else if (event.kind === core.KIND_DELETION) applyDeletion(event)

    for (const key of DERIVED.get(event.kind) ?? []) touch(key)
    touch('audit')
  }

  function onRejected (err, event) {
    pushFlow({
      kind: event?.kind ?? 0,
      author: event === undefined ? '' : nameFor(event.pubkey),
      label: labelFor(event?.kind ?? 0),
      ok: false,
      note: err.message
    })
  }

  // --------------------------------------------------------- derived state --

  function channelSummary (channel) {
    return {
      id: channel.id,
      name: channel.name,
      about: channel.about,
      topic: channel.topic,
      unread: unread.get(channel.id) ?? 0,
      archived: channel.archivedAt !== null && channel.archivedAt !== undefined
    }
  }

  const syncers = {
    channels () {
      const all = store.listChannels({ includeArchived: true })
      state.channels = all.filter((channel) => channel.type !== 'dm').map(channelSummary)
      state.dms = all.filter((channel) => channel.type === 'dm').map((channel) => {
        const members = store.listMembers(channel.id).map((member) => member.pubkey)
        return { id: channel.id, members, label: members.map(nameFor).join(', ') }
      })
    },

    members () {
      for (const channel of store.listChannels({ includeArchived: true })) {
        state.members[channel.id] = store.listMembers(channel.id).map((member) => ({
          pubkey: member.pubkey,
          name: nameFor(member.pubkey),
          role: member.role
        }))
      }
    },

    relayMembers () {
      state.relayMembers = store.listRelayMembers().map((member) => ({
        pubkey: member.pubkey,
        name: nameFor(member.pubkey),
        role: member.role
      }))
    },

    audit () {
      const verification = store.verifyAuditChain()
      const entries = store.listAudit({ limit: AUDIT_LIMIT })
      state.audit = {
        verified: verification.ok,
        head: entries.length === 0 ? null : entries[entries.length - 1].hash,
        entries
      }
    },

    workflows () {
      state.workflows = [...relay.workflowEngine.workflows].map(([id, entry]) => ({
        id,
        name: entry.definition.name,
        channelId: entry.channelId,
        steps: entry.definition.steps.length
      }))
    },

    runs () {
      state.runs = relay.workflowEngine.listRuns(null, 50)
    },

    agents () {
      state.agents = store.queryEvents([{ kinds: [core.KIND_AGENT_PROFILE], limit: 50 }]).map((stored) => {
        const profile = safeJson(stored.event.content) ?? {}
        return {
          pubkey: stored.event.pubkey,
          name: profile.display_name ?? nameFor(stored.event.pubkey),
          capabilities: profile.capabilities ?? [],
          online: agent !== null && agent.pubkey === stored.event.pubkey
        }
      })
    },

    personas () {
      const published = store.queryEvents([{ kinds: [core.KIND_PERSONA], limit: 50 }])
        .map((stored) => safeJson(stored.event.content))
        .filter((persona) => persona !== null)

      const bySlug = new Map(localPersonas.map((persona) => [persona.slug, persona]))
      for (const persona of published) bySlug.set(persona.slug ?? persona.display_name, persona)
      state.personas = [...bySlug.values()]
    }
  }

  /**
   * Mark a derived slice stale. Recomputing on every event would run
   * verifyAuditChain once per message; coalescing keeps a burst of a hundred
   * events to a single pass while staying well inside one frame.
   */
  function touch (key) {
    if (closed || attached) return
    dirty.add(key)
    if (syncTimer !== null) return
    syncTimer = setTimeout(() => {
      syncTimer = null
      flush()
    }, SYNC_DEBOUNCE_MS)
  }

  function flush () {
    if (syncTimer !== null) {
      clearTimeout(syncTimer)
      syncTimer = null
    }

    // Whoever set activeChannel has seen it, whether that was setActiveChannel
    // or a scene assigning the field directly.
    if (state.activeChannel !== null) unread.delete(state.activeChannel)

    const keys = dirty
    dirty = new Set()
    for (const key of keys) syncers[key]()
  }

  // ------------------------------------------------------------ attach mode --

  async function attempt (label, fn) {
    try {
      await fn()
    } catch (err) {
      notice(`${label}: ${err.message}`, 'warn')
    }
  }

  async function refreshRemote () {
    await attempt('relay info', async () => {
      const info = await cli(actors.admin, ['relay', 'info'])
      remote.connections = info.connections ?? 0
      remote.subscriptions = info.subscriptions ?? 0
    })

    await attempt('channels', async () => {
      const all = await cli(actors.admin, ['channels', 'list'])
      state.channels = all.filter((channel) => channel.type !== 'dm').map(channelSummary)
      state.dms = all.filter((channel) => channel.type === 'dm')
        .map((channel) => ({ id: channel.id, members: [], label: channel.name }))
    })

    const active = state.activeChannel
    if (active !== null) {
      await attempt('messages', async () => {
        const events = await cli(actors.admin, ['messages', 'get', '--channel', active, '--limit', '100'])
        state.messages[active] = events.map((event) => ({
          id: event.id,
          pubkey: event.pubkey,
          author: nameFor(event.pubkey),
          content: event.content,
          ts: event.created_at,
          // No reactions: REST hands back a page of messages and nothing else,
          // and one reactions query per message per poll is a stampede, not a
          // projection. The scenes that need counts degrade instead of being
          // shown a zero that looks like an answer.
          reactions: {},
          kind: event.kind
        }))
      })

      await attempt('members', async () => {
        state.members[active] = (await cli(actors.admin, ['channels', 'members', '--channel', active]))
          .map((member) => ({ pubkey: member.pubkey, name: nameFor(member.pubkey), role: member.role }))
      })
    }

    await attempt('audit', async () => {
      // A remote relay does not hand out its key, so there is nobody here who
      // may verify the chain; report unknown rather than a fabricated green.
      const verification = relay === null
        ? { ok: null }
        : await cli({ secretKeyHex: core.toHex(relay.secretKey) }, ['audit', 'verify'])
      const entries = await cli(actors.admin, ['audit', 'list', '--limit', String(AUDIT_LIMIT)])
      state.audit = {
        verified: verification.ok,
        head: entries.length === 0 ? null : entries[entries.length - 1].hash,
        entries
      }
    })

    await attempt('workflow runs', async () => {
      state.runs = await cli(actors.admin, ['workflows', 'runs'])
    })
  }

  // --------------------------------------------------------------- surface --

  const cli = async (actor, argv, stdin = null) => {
    const result = await run(argv, {
      env: { HIVE_RELAY_URL: url, HIVE_PRIVATE_KEY: actor.secretKeyHex },
      readStdin: async () => stdin
    })

    if (result.exitCode !== 0) {
      const err = new Error(`hive ${argv.join(' ')} → exit ${result.exitCode}: ${result.stderr.trim()}`)
      // The category the CLI exited with, carried on the error: it is the only
      // way a caller can tell a refusal the relay sent back (auth, conflict)
      // from a command this process got wrong before anything was dialled.
      err.exitCode = result.exitCode
      err.stderr = result.stderr.trim()
      throw err
    }

    // The command has already been through the pipeline, so settle the derived
    // state before returning: a scene that asserts right after a CLI call sees
    // exactly what the panes will draw.
    if (!attached) flush()
    return JSON.parse(result.stdout)
  }

  async function startAgent () {
    if (agent !== null) return agent

    const honey = actors.honey
    // Reconnecting, unlike the scripted client sessions: an idle websocket does
    // not survive the gaps between scenes, and an agent that answers mentions
    // only until the first quiet stretch is not the thing being demonstrated.
    // RelayConnection replays its subscriptions, so the recovery is invisible.
    const connection = new RelayConnection({
      url: url.replace(/^http/, 'ws'),
      secretKey: honey.secretKey,
      reconnect: true
    })
    await connection.connect()

    agent = new Agent({
      secretKey: honey.secretKey,
      owner: actors.alice.pubkey,
      persona: HONEY_PERSONA,
      provider: new MockProvider({ systemPrompt: HONEY_PERSONA.system_prompt }),
      connection
    })
    // An agent is a background participant: a relay hiccup must not become an
    // unhandled 'error' that takes the whole demo down.
    agent.on('error', (err) => notice(`agent: ${err.message}`, 'warn'))
    await agent.start()

    world.agent = agent
    localPersonas = [HONEY_PERSONA]
    touch('agents')
    touch('personas')
    return agent
  }

  async function stopAgent () {
    if (agent === null) return
    const stopping = agent
    agent = null
    world.agent = null
    await stopping.stop()
    touch('agents')
  }

  const metrics = {
    eventsPerSecond () {
      trimBeats()
      return Math.round((beats.length / (RATE_WINDOW_MS / 1000)) * 10) / 10
    },
    connections () {
      return relay === null ? remote.connections : relay.connections.size
    },
    subscriptions () {
      return relay === null ? remote.subscriptions : relay.subscriptions.size
    },
    sample () {
      return {
        at: Date.now(),
        eventsPerSecond: metrics.eventsPerSecond(),
        connections: metrics.connections(),
        subscriptions: metrics.subscriptions()
      }
    }
  }

  async function close () {
    if (closed) return
    closed = true

    if (syncTimer !== null) clearTimeout(syncTimer)
    if (pollTimer !== null) clearInterval(pollTimer)

    await stopAgent()

    if (relay !== null) {
      relay.removeAllListeners()
      relay.close()
    }
    if (transport !== null) await transport.close()
    if (swarmTransport !== null) {
      await swarmTransport.close()
      // The DHT was passed in, so SwarmTransport will not destroy it for us.
      await swarmTransport.dht.destroy()
    }
    if (store !== null) store.close()
    if (testnet !== null) await testnet.destroy()
    if (ephemeral) fs.rmSync(root, { recursive: true, force: true })
  }

  const world = {
    url,
    relay,
    store,
    transport,
    swarmTransport,
    swarmKey: swarmTransport === null ? null : swarmTransport.publicKey,
    actors,
    // The relay's own key. `audit verify` is a full-chain scan and the relay
    // gates it to this key; null when attached to a remote relay, whose key
    // this process does not hold.
    operator: relay === null ? null : { name: 'operator', secretKeyHex: core.toHex(relay.secretKey) },
    cli,
    agent: null,
    startAgent,
    stopAgent,
    state,
    metrics,
    notice,
    /** Clearing unread is the whole reason this is a method and not a field. */
    setActiveChannel (channelId) {
      state.activeChannel = channelId
      unread.delete(channelId)
    },
    refresh: attached ? refreshRemote : async () => flush(),
    close
  }

  // ------------------------------------------------------------------ wire --

  if (attached) {
    notice('attached to a remote relay: the swarm key is not exposed over REST', 'warn')
    notice('attached to a remote relay: the flow pane polls instead of tapping events', 'warn')
    await refreshRemote()
    pollTimer = setInterval(() => { refreshRemote() }, ATTACH_POLL_MS)
  } else {
    relay.on('event', onEvent)
    relay.on('handler-error', onRejected)
    relay.on('workflow-error', onRejected)
    relay.on('connection', () => pushFlow({ kind: 0, author: '', label: 'connection', ok: true, note: 'open' }))
    relay.on('disconnect', (connection, reason) => {
      pushFlow({ kind: 0, author: nameFor(connection.pubkey ?? ''), label: 'disconnect', ok: true, note: reason })
    })
    relay.on('authenticated', (connection) => {
      pushFlow({ kind: core.KIND_AUTH, author: nameFor(connection.pubkey), label: 'auth', ok: true, note: 'nip-42' })
    })
    relay.on('error', (err) => notice(`relay: ${err.message}`, 'error'))

    if (!swarm) notice('running without the swarm: peer-to-peer reach is not demonstrated', 'warn')

    for (const key of Object.keys(syncers)) dirty.add(key)
    flush()
  }

  return world
}

module.exports = { createWorld }
