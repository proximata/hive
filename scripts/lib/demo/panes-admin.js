'use strict'

// The operator's half of the demo: one pane, eight sub-tabs.
//
// Everything drawn here is a projection of world.state, and world.state is fed
// from the relay's own event stream and its own store. That matters most on the
// access tab: a rejection line appears because the relay refused a publish and
// the refusal was recorded, never because this file decided a member "should"
// be blocked. The pane has no way to invent one.
//
// Beyond the frozen world.state fields this reads a few slices the runner tops
// up each tick, all optional and all degrading to '-' when absent:
//   state.adminTab     one of the ids in TABS; defaults to 'overview'
//   state.relay        the /api/relay payload (NIP-11 doc + swarm/connections)
//   state.health       { swarm, connections, subscriptions, uptimeMs, kinds,
//                        events, payloadBytes, media, memory } — the shape the
//                        health scene already builds
//   state.series       recent world.metrics.eventsPerSecond() samples
//   state.connections  per-connection detail, when the transport exposes any
//   state.rejections   [{ actor, action, reason }] for refusals the CLI saw but
//                      the relay never routed through 'handler-error'

const core = require('hive-core')

const { pad, displayWidth } = require('../tui/screen')
const { box, table, kv, logPane, sparkline, tabstrip, style } = require('../tui/widgets')

// Derived from hive-core's registry rather than hand-listed, so a new kind
// shows up here with a readable name the day it is added to kinds.js.
const KIND_LABELS = new Map(
  Object.entries(core)
    .filter(([name, value]) => name.startsWith('KIND_') && typeof value === 'number')
    .map(([name, value]) => [value, name.slice(5).toLowerCase().replace(/_/g, ' ')])
)

const MODERATION_KINDS = new Set([
  core.KIND_MODERATION_BAN,
  core.KIND_MODERATION_UNBAN,
  core.KIND_MODERATION_TIMEOUT,
  core.KIND_MODERATION_UNTIMEOUT,
  core.KIND_MODERATION_RESOLVE_REPORT,
  core.KIND_REPORT,
  core.KIND_MUTE_LIST,
  core.KIND_NIP29_DELETE_EVENT
])

// Longest first: the banner is a promise about what the relay does not do, so
// a narrow terminal gets a shorter true sentence rather than a truncated one.
const MODERATION_BANNER = [
  'recorded - enforcement deferred (README status matrix)',
  'recorded - enforcement deferred',
  'not enforced'
]

// `focus` is the scene's word for which pane it is talking about; each sub-tab
// answers to the one its scenes use, so the highlighted box follows the script.
const TABS = [
  { id: 'overview', key: '1', label: 'Overview', short: 'Ovr', focus: 'relay' },
  { id: 'channels', key: '2', label: 'Channels', short: 'Chn', focus: 'channels' },
  { id: 'access', key: '3', label: 'Access', short: 'Acc', focus: 'members' },
  { id: 'moderation', key: '4', label: 'Moderation', short: 'Mod', focus: 'flow' },
  { id: 'audit', key: '5', label: 'Audit', short: 'Aud', focus: 'audit' },
  { id: 'workflows', key: '6', label: 'Workflows', short: 'Wfl', focus: 'workflows' },
  { id: 'agents', key: '7', label: 'Agents', short: 'Agt', focus: 'personas' },
  { id: 'health', key: '8', label: 'Health', short: 'Hlth', focus: 'relay' }
]

// Below this the pane stops trying to sit two boxes side by side.
const WIDE = 88

// --------------------------------------------------------------- formatting --

function short (value, width = 12) {
  return typeof value === 'string' ? value.slice(0, width) : '-'
}

function labelFor (kind) {
  return KIND_LABELS.get(kind) ?? `kind ${kind}`
}

function count (value) {
  return Number.isFinite(value) ? String(value) : '-'
}

function bytes (value) {
  if (!Number.isFinite(value)) return '-'
  const units = ['B', 'kB', 'MB', 'GB']
  let n = value
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return (i === 0 ? String(n) : n.toFixed(1)) + ' ' + units[i]
}

function duration (ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * The best name the state knows for a pubkey. Rosters are the only place the
 * pane learns names, so an actor nobody has met stays a hex prefix.
 */
function namesOf (state) {
  const names = new Map()
  for (const member of state.relayMembers ?? []) names.set(member.pubkey, member.name)
  for (const roster of Object.values(state.members ?? {})) {
    for (const member of roster) names.set(member.pubkey, member.name)
  }
  for (const agent of state.agents ?? []) names.set(agent.pubkey, agent.name)
  return names
}

function nameFor (names, pubkey) {
  return names.get(pubkey) ?? short(pubkey, 8)
}

// --------------------------------------------------------------- geometry --

/** Every panel ends here: exactly `height` rows of exactly `width` columns. */
function fit (lines, width, height) {
  const out = []
  for (let i = 0; i < height; i++) out.push(pad(i < lines.length ? lines[i] : '', width))
  return out
}

function halves (width) {
  const left = Math.floor((width - 1) / 2)
  return [left, width - 1 - left]
}

function beside (left, right, leftWidth, rightWidth) {
  const rows = []
  const height = Math.max(left.length, right.length)
  for (let i = 0; i < height; i++) {
    rows.push(pad(i < left.length ? left[i] : '', leftWidth) + ' ' + pad(i < right.length ? right[i] : '', rightWidth))
  }
  return rows
}

/** A full-width banner line, the one piece of chrome that is not a box. */
function banner (text, colorize, width) {
  return colorize(pad(' ' + text + ' ', width))
}

// --------------------------------------------------------------- overview --

function overview (state, { width, height, focus }) {
  const info = state.relay ?? {}
  const health = state.health ?? {}
  const series = Array.isArray(state.series) ? state.series : []
  const nips = Array.isArray(info.supported_nips) ? info.supported_nips : []
  const swarm = info.swarm ?? health.swarm ?? null

  const pairs = [
    ['relay', info.name ?? '-'],
    ['version', info.version ?? '-'],
    ['nips', nips.length === 0 ? '-' : `${nips.length}: ${nips.join(' ')}`],
    ['swarm', swarm === null ? style.dim('not reachable over the DHT') : 'hyper://' + short(swarm, 24)],
    ['uptime', duration(health.uptimeMs)],
    ['store', `${bytes(health.payloadBytes)} in ${count(health.events)} events`]
  ]

  // The sparkline is the first thing to go on a short terminal: it is the only
  // panel here whose information is also printed as a number elsewhere.
  const sparkHeight = height >= 9 ? 3 : 0
  const topHeight = height - sparkHeight

  const relayBox = (w, h) => box({
    title: 'Relay',
    width: w,
    height: h,
    body: kv({ pairs, width: Math.max(0, w - 4) }),
    active: focus === 'relay'
  })

  const connectionsBox = (w, h) => box({
    title: 'Connections',
    width: w,
    height: h,
    body: connections(state, Math.max(0, w - 4), Math.max(0, h - 2)),
    active: focus === 'connections'
  })

  let top
  if (width >= WIDE) {
    const [left, right] = halves(width)
    top = beside(relayBox(left, topHeight), connectionsBox(right, topHeight), left, right)
  } else {
    const relayHeight = Math.min(topHeight, pairs.length + 2)
    const rest = topHeight - relayHeight
    top = rest < 3
      ? relayBox(width, topHeight)
      : [...relayBox(width, relayHeight), ...connectionsBox(width, rest)]
  }

  if (sparkHeight === 0) return top

  const latest = series.length === 0 ? '-' : String(series[series.length - 1])
  return [
    ...top,
    ...box({
      title: 'events/s',
      footer: `now ${latest}`,
      width,
      height: sparkHeight,
      body: [sparkline(series, Math.max(0, width - 4))]
    })
  ]
}

function connections (state, width, height) {
  const live = Array.isArray(state.connections) ? state.connections : []
  const names = namesOf(state)

  if (live.length > 0) {
    return table({
      columns: [{ label: 'peer' }, { label: 'pubkey', width: 14 }, { label: 'subs', width: 5, align: 'right' }],
      rows: live.map((connection) => [
        connection.name ?? nameFor(names, connection.pubkey),
        short(connection.pubkey, 14),
        count(connection.subscriptions)
      ]),
      width,
      height
    })
  }

  // A websocket transport does not have to enumerate its peers, and the REST
  // relay never does — the counts are the honest answer, so say so.
  const info = state.relay ?? {}
  const series = Array.isArray(state.series) ? state.series : []
  return [
    ...kv({
      pairs: [
        ['connections', count(info.connections)],
        ['subscriptions', count(info.subscriptions)],
        ['events/s', series.length === 0 ? '-' : String(series[series.length - 1])]
      ],
      width
    }),
    '',
    style.dim('per-connection detail is not exposed')
  ]
}

// --------------------------------------------------------------- channels --

function channels (state, { width, height, focus }) {
  const all = state.channels ?? []
  const members = state.members ?? {}
  const compact = width < 64

  const columns = compact
    ? [{ label: '', width: 1 }, { label: 'name' }, { label: 'members', width: 7, align: 'right' }, { label: 'state', width: 8 }]
    : [{ label: '', width: 1 }, { label: 'name' }, { label: 'id', width: 12 }, { label: 'members', width: 7, align: 'right' }, { label: 'state', width: 8 }]

  const rows = all.map((channel) => {
    const selected = channel.id === state.activeChannel
    const name = selected ? style.bold(style.cyan(channel.name)) : channel.name
    const status = channel.archived ? style.dim('archived') : 'open'
    const cells = [selected ? style.cyan('>') : '', name, short(channel.id, 12), count((members[channel.id] ?? []).length), status]
    return compact ? cells.filter((_, i) => i !== 2) : cells
  })

  return box({
    title: `Channels (${all.length})`,
    footer: state.activeChannel === null || state.activeChannel === undefined ? '' : short(state.activeChannel, 12),
    width,
    height,
    body: table({ columns, rows, width: Math.max(0, width - 4), height: Math.max(0, height - 2) }),
    active: focus === 'channels'
  })
}

// ----------------------------------------------------------------- access --

/**
 * The NIP-01 machine-readable prefix, which is the part an operator reads:
 * "auth-required: authenticate before publishing" -> "auth-required".
 */
function reasonCode (reason) {
  const text = String(reason ?? '').trim()
  const head = text.split(':')[0]
  return /^[a-z][a-z-]*$/.test(head) ? head : text
}

/**
 * Refusals the relay actually produced, newest last. Two sources, because a
 * refusal takes two different routes out of the relay: the event pipeline
 * emits 'handler-error' (world puts it in state.flow with ok false), while the
 * access policy rejects at the door, before any event exists, and only the
 * caller sees it. Neither is synthesised here.
 */
function refusals (state) {
  const lines = []

  for (const entry of state.rejections ?? []) {
    lines.push(`${entry.actor ?? 'unknown'} -> ${entry.action ?? 'publish'} rejected: ${reasonCode(entry.reason)}`)
  }

  // A refusal recorded by both routes is one refusal. Repeats *within* a route
  // are kept, because trying again and being refused again is a real event and
  // the scene does exactly that.
  const recorded = new Set(lines)
  for (const entry of state.flow ?? []) {
    if (entry.ok !== false) continue
    const line = `${entry.author === '' ? 'unknown' : entry.author} -> ${entry.kind === 0 ? 'connect' : 'publish'} rejected: ${reasonCode(entry.note)}`
    if (!recorded.has(line)) lines.push(line)
  }

  return lines
}

function access (state, { width, height, focus }) {
  const roster = state.relayMembers ?? []
  const lines = refusals(state)

  // The roster is the store's table and nothing else. Someone who was refused
  // and then removed leaves the table, which is what removal means; the
  // refusal lines below say who it was. Minting a row for them here would be
  // this pane inventing a member the relay never had.
  const rows = roster.map((member) => [member.name, short(member.pubkey, 14), member.role, style.green('active')])

  const columns = [
    { label: 'name' },
    { label: 'pubkey', width: 14 },
    { label: 'role', width: 8 },
    { label: 'status', width: 8 }
  ]

  const refusalHeight = lines.length === 0 || height < 9
    ? 0
    : Math.min(lines.length + 2, Math.max(3, Math.floor(height / 3)))

  const rosterBox = box({
    title: `Relay roster (${roster.length})`,
    footer: 'requireRelayMembership',
    width,
    height: height - refusalHeight,
    body: table({ columns, rows, width: Math.max(0, width - 4), height: Math.max(0, height - refusalHeight - 2) }),
    active: focus === 'members'
  })

  if (refusalHeight === 0) return rosterBox

  return [
    ...rosterBox,
    ...box({
      title: style.red('refused by the relay'),
      width,
      height: refusalHeight,
      body: logPane({
        entries: lines.map((text) => ({ text, color: 'red' })),
        width: Math.max(0, width - 4),
        height: Math.max(0, refusalHeight - 2)
      })
    })
  ]
}

// ------------------------------------------------------------- moderation --

function moderation (state, { width, height, focus }) {
  const names = namesOf(state)
  const entries = (state.audit?.entries ?? [])
    .filter((entry) => MODERATION_KINDS.has(entry.kind))
    .map((entry) => `${entry.kind} ${labelFor(entry.kind)} by ${nameFor(names, entry.actor)}  ${short(entry.eventId, 8)}`)

  // The audit chain is the durable record; the flow ring buffer is what a
  // relay we only attached to can offer. Prefer the chain, fall back cleanly.
  const fallback = (state.flow ?? [])
    .filter((entry) => entry.ok && MODERATION_KINDS.has(entry.kind))
    .map((entry) => `${entry.kind} ${entry.label} by ${entry.author}  ${entry.note}`)

  const lines = entries.length > 0 ? entries : fallback
  const body = lines.length === 0 ? [style.dim('no moderation events yet')] : lines

  const text = MODERATION_BANNER.find((option) => option.length + 2 <= width) ?? MODERATION_BANNER[MODERATION_BANNER.length - 1]

  return [
    banner(text, style.yellow, width),
    ...box({
      title: `Moderation (${lines.length})`,
      width,
      height: height - 1,
      body: logPane({
        entries: body.map((text) => ({ text })),
        width: Math.max(0, width - 4),
        height: Math.max(0, height - 3)
      }),
      active: focus === 'flow'
    })
  ]
}

// ------------------------------------------------------------------ audit --

/**
 * Where the chain first disagrees with itself. The store reports this, but
 * world.state only keeps the verdict — and the entries carry enough to find
 * it again: every entry names its predecessor's hash.
 */
function brokenAt (audit) {
  if (Number.isFinite(audit.brokenAt)) return audit.brokenAt
  const entries = audit.entries ?? []
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].prevHash !== entries[i - 1].hash) return entries[i].seq
  }
  return null
}

function audit (state, { width, height, focus }) {
  const chain = state.audit ?? { verified: true, head: null, entries: [] }
  const entries = chain.entries ?? []
  const names = namesOf(state)
  const compact = width < 72

  const broken = chain.verified ? null : brokenAt(chain)
  const head = chain.verified
    ? banner(`chain verified - ${entries.length} entries, head ${short(chain.head, 12)}`, style.green, width)
    : banner(`CHAIN BROKEN at seq ${broken === null ? '?' : broken}`, style.red, width)

  const columns = compact
    ? [{ label: 'seq', width: 5, align: 'right' }, { label: 'actor', width: 10 }, { label: 'action' }]
    : [
        { label: 'seq', width: 5, align: 'right' },
        { label: 'kind', width: 6, align: 'right' },
        { label: 'actor', width: 12 },
        { label: 'action' },
        { label: 'hash', width: 10 }
      ]

  // Tail-anchored like the log panes: the newest entries are the ones an
  // operator came here to see, and the head hash is one of them.
  const visible = Math.max(0, height - 2)
  const rows = entries.slice(Math.max(0, entries.length - visible)).map((entry) => {
    const seq = broken !== null && entry.seq >= broken ? style.red(String(entry.seq)) : String(entry.seq)
    const cells = [seq, count(entry.kind), nameFor(names, entry.actor), entry.action, short(entry.hash, 10)]
    return compact ? [cells[0], cells[2], cells[3]] : cells
  })

  return [
    head,
    ...box({
      title: 'Audit chain',
      width,
      height: height - 1,
      body: table({ columns, rows, width: Math.max(0, width - 4), height: Math.max(0, height - 3) }),
      active: focus === 'audit'
    })
  ]
}

// -------------------------------------------------------------- workflows --

function workflows (state, { width, height, focus }) {
  const definitions = state.workflows ?? []
  const runs = state.runs ?? []
  const pending = runs.filter((run) => run.status === 'waiting_approval')

  const definitionsHeight = Math.max(3, Math.min(definitions.length + 3, Math.floor(height / 2)))
  const runsHeight = Math.max(0, height - definitionsHeight)

  const top = box({
    title: `Workflows (${definitions.length})`,
    width,
    height: definitionsHeight,
    body: table({
      columns: [{ label: 'name' }, { label: 'id', width: 12 }, { label: 'steps', width: 5, align: 'right' }, { label: 'channel', width: 12 }],
      rows: definitions.map((workflow) => [workflow.name, short(workflow.id, 12), count(workflow.steps), short(workflow.channelId, 12)]),
      width: Math.max(0, width - 4),
      height: Math.max(0, definitionsHeight - 2)
    }),
    active: focus === 'workflows'
  })

  if (runsHeight < 3) return top

  // A gate is the whole point of the workflow demo, so it is called out above
  // the table as well as coloured inside it.
  const gate = pending.length === 0 ? [] : [style.yellow(`! ${pending.length} run(s) waiting for approval`)]

  const statusOf = (run) => {
    if (run.status === 'waiting_approval') return style.yellow('approval pending')
    if (run.status === 'completed') return style.green(run.status)
    if (run.status === 'failed') return style.red(run.status)
    return run.status
  }

  return [
    ...top,
    ...box({
      title: `Runs (${runs.length})`,
      width,
      height: runsHeight,
      body: [
        ...gate,
        ...table({
          columns: [{ label: 'run', width: 12 }, { label: 'workflow' }, { label: 'status', width: 17 }],
          rows: runs.map((run) => [short(run.id, 12), run.workflowId, statusOf(run)]),
          width: Math.max(0, width - 4),
          height: Math.max(0, runsHeight - 2 - gate.length)
        })
      ]
    })
  ]
}

// ----------------------------------------------------------------- agents --

function agents (state, { width, height, focus }) {
  const personas = state.personas ?? []
  const live = state.agents ?? []

  const personaBox = (w, h) => box({
    title: `Personas (${personas.length}) kind ${core.KIND_PERSONA}`,
    width: w,
    height: h,
    body: table({
      columns: [{ label: 'persona' }, { label: 'runtime', width: 8 }, { label: 'model', width: 10 }],
      rows: personas.map((persona) => [
        persona.display_name ?? persona.slug ?? '-',
        persona.runtime ?? '-',
        persona.model ?? '-'
      ]),
      width: Math.max(0, w - 4),
      height: Math.max(0, h - 2)
    }),
    active: focus === 'personas'
  })

  const agentBox = (w, h) => box({
    title: `Agents (${live.length}) kind ${core.KIND_AGENT_PROFILE}`,
    width: w,
    height: h,
    body: table({
      columns: [{ label: 'agent' }, { label: 'pubkey', width: 12 }, { label: 'state', width: 7 }],
      rows: live.map((agent) => [
        agent.name,
        short(agent.pubkey, 12),
        agent.online ? style.green('online') : style.dim('offline')
      ]),
      width: Math.max(0, w - 4),
      height: Math.max(0, h - 2)
    }),
    active: focus === 'agents'
  })

  if (width >= WIDE) {
    const [left, right] = halves(width)
    return beside(personaBox(left, height), agentBox(right, height), left, right)
  }

  // +3, not +2: a table spends one of its body rows on the header, and a box
  // that shows only a header is worse than no box at all.
  const top = Math.min(height, Math.max(4, personas.length + 3))
  const rest = height - top
  return rest < 4 ? personaBox(width, height) : [...personaBox(width, top), ...agentBox(width, rest)]
}

// ----------------------------------------------------------------- health --

function health (state, { width, height, focus }) {
  const stats = state.health ?? {}
  const info = state.relay ?? {}
  const kinds = stats.kinds ?? []
  const media = stats.media ?? {}
  const memory = typeof stats.memory === 'object' && stats.memory !== null ? stats.memory.rss ?? stats.memory.heapUsed : stats.memory

  const pairs = [
    ['events', count(stats.events)],
    ['payload', bytes(stats.payloadBytes)],
    ['blobs', `${count(media.count)} / ${bytes(media.bytes)}`],
    ['memory', bytes(memory)],
    ['uptime', duration(stats.uptimeMs)],
    ['conns', `${count(stats.connections ?? info.connections)} / ${count(stats.subscriptions ?? info.subscriptions)} subs`]
  ]

  const kindsBox = (w, h) => box({
    title: `Events by kind (${kinds.length})`,
    width: w,
    height: h,
    body: table({
      columns: [{ label: 'kind', width: 6, align: 'right' }, { label: 'name' }, { label: 'count', width: 7, align: 'right' }],
      rows: kinds.map((row) => [String(row.kind), labelFor(row.kind), count(row.n)]),
      width: Math.max(0, w - 4),
      height: Math.max(0, h - 2)
    }),
    active: focus === 'relay'
  })

  const statsBox = (w, h) => box({
    title: 'Store',
    width: w,
    height: h,
    body: kv({ pairs, width: Math.max(0, w - 4) })
  })

  if (width >= WIDE) {
    const [left, right] = halves(width)
    return beside(kindsBox(left, height), statsBox(right, height), left, right)
  }

  const top = Math.min(height, pairs.length + 2)
  const rest = height - top
  return rest < 3 ? statsBox(width, height) : [...statsBox(width, top), ...kindsBox(width, rest)]
}

// ------------------------------------------------------------------- pane --

const PANELS = { overview, channels, access, moderation, audit, workflows, agents, health }

/**
 * The sub-tab strip, in three sizes. Names first, abbreviations when they stop
 * fitting, and on a very narrow terminal just the tab you are on — a strip cut
 * off mid-word tells an operator less than "3/8" does.
 */
function header (active, width) {
  const fits = (labels) => displayWidth(labels.map((tab) => `[${tab.key}] ${tab.label}`).join('  ')) + 2 <= width

  const full = TABS.map((tab) => ({ key: tab.key, label: tab.label }))
  if (fits(full)) return tabstrip({ tabs: full, active: active.key, width })

  const abbreviated = TABS.map((tab) => ({ key: tab.key, label: tab.short }))
  if (fits(abbreviated)) return tabstrip({ tabs: abbreviated, active: active.key, width })

  const position = TABS.indexOf(active) + 1
  return pad(' ' + style.bold(style.cyan(`[${active.key}] ${active.label}`)) + style.dim(`  ${position}/${TABS.length}`) + ' ', width)
}

function render (state, { width, height, focus = null } = {}) {
  if (width <= 0 || height <= 0) return []

  const active = TABS.find((tab) => tab.id === state.adminTab) ?? TABS[0]
  const strip = pad(header(active, width), width)
  if (height === 1) return [strip]

  // A scene that has not said what it is looking at still gets the sub-tab's
  // own pane highlighted, so the active box is never ambiguous.
  const body = PANELS[active.id](state, { width, height: height - 1, focus: focus ?? active.focus })
  return [strip, ...fit(body, width, height - 1)]
}

module.exports = { render, TABS }
