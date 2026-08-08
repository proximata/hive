'use strict'

// What a person sees: where they are, what was said, and what the relay did
// about it.
//
// Three columns — channels, transcript, event flow — because the point of the
// demo is that the middle column is not a mock: every line in it arrived as a
// signed event, and the right column shows the same events landing. Rendering
// is a pure function of world.state, so a frame can be diffed, recorded or
// asserted on without a terminal anywhere in the loop.

const { displayWidth, truncate, pad } = require('../tui/screen')
const { box, list, logPane, sparkline, statusbar, style } = require('../tui/widgets')

// Column budgets. The centre is whatever is left, so it grows first.
const LEFT_MIN = 20
const LEFT_MAX = 28
const RIGHT_MIN = 26
const RIGHT_MAX = 34
const DROP_RIGHT_BELOW = 100
const DROP_LEFT_BELOW = 60

const GUTTER = 1 // the one column that marks an agent's turn
const INDENT = 2

function clamp (value, min, max) {
  return Math.max(min, Math.min(max, value))
}

// Word wrap over plain text. widgets keeps its own copy for logPane, but that
// one owns the whole line; the transcript needs to hang continuation lines
// under an indent, which means wrapping to a narrower width than it renders at.
function wrap (text, width) {
  if (width <= 0) return ['']

  const lines = []
  let line = ''

  for (const word of String(text).split(/\s+/)) {
    if (word === '') continue

    const candidate = line === '' ? word : line + ' ' + word
    if (displayWidth(candidate) <= width) {
      line = candidate
      continue
    }

    if (line !== '') lines.push(line)

    // Long unbroken runs — ids, npubs, URLs — are cut rather than left to
    // overflow, since truncate would otherwise silently drop the tail.
    let rest = word
    while (displayWidth(rest) > width) {
      const head = truncate(rest, width)
      lines.push(head)
      rest = rest.slice(head.length)
    }
    line = rest
  }

  if (line !== '' || lines.length === 0) lines.push(line)
  return lines
}

function clock (ts) {
  if (!Number.isFinite(ts)) return '--:--'
  const date = new Date(ts * 1000)
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
}

// Who is a machine. Membership is the authority — the relay hands out the 'bot'
// role — with the published agent profiles as the fallback for channels whose
// roster has not synced yet.
function agentKeys (state) {
  const keys = new Set()
  for (const agent of state.agents ?? []) keys.add(agent.pubkey)
  for (const roster of Object.values(state.members ?? {})) {
    for (const member of roster) {
      if (member.role === 'bot' || member.role === 'agent') keys.add(member.pubkey)
    }
  }
  return keys
}

function activeChannel (state) {
  const id = state.activeChannel
  return (state.channels ?? []).find((channel) => channel.id === id) ?? null
}

// world.metrics exposes live getters; a recorded frame carries plain numbers.
// The pane accepts either so a cast can be replayed without a relay behind it.
function readMetrics (state) {
  const source = state.metrics ?? {}
  const read = (key) => {
    const value = typeof source[key] === 'function' ? source[key]() : source[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  return {
    rate: read('eventsPerSecond'),
    connections: read('connections'),
    subscriptions: read('subscriptions')
  }
}

function rateHistory (state) {
  if (Array.isArray(state.rateHistory)) return state.rateHistory
  return (state.samples ?? []).map((sample) => sample.eventsPerSecond ?? 0)
}

// ------------------------------------------------------------------- left --

function leftColumn (state, { width, height, focus }) {
  const channels = state.channels ?? []
  const dms = state.dms ?? []

  // The DM box is sized to its contents but never eats more than a third of
  // the column: the channel list is the primary navigation.
  const dmRows = Math.max(1, Math.min(dms.length, Math.max(1, Math.floor((height - 4) / 3))))
  const dmHeight = Math.min(Math.max(0, height - 4), dmRows + 2)
  const channelHeight = height - dmHeight

  const selectedChannel = channels.findIndex((channel) => channel.id === state.activeChannel)
  const selectedDm = dms.findIndex((dm) => dm.id === state.activeChannel)

  const channelBox = box({
    title: 'Channels',
    width,
    height: channelHeight,
    active: focus === 'channels',
    footer: channels.length > channelHeight - 2 ? `${channels.length}` : '',
    body: list({
      items: channels.map((channel) => ({
        label: '#' + channel.name,
        badge: channel.unread > 0 ? String(channel.unread) : '',
        dim: channel.archived === true
      })),
      selected: Math.max(0, selectedChannel),
      width: Math.max(0, width - 4),
      height: Math.max(0, channelHeight - 2)
    })
  })

  const dmBox = box({
    title: 'DMs',
    width,
    height: dmHeight,
    active: focus === 'dms',
    body: list({
      items: dms.length === 0
        ? [{ label: 'no direct messages', dim: true }]
        : dms.map((dm) => ({ label: '@' + dm.label, badge: '', dim: false })),
      selected: selectedDm === -1 ? -1 : selectedDm,
      width: Math.max(0, width - 4),
      height: Math.max(0, dmHeight - 2)
    })
  })

  return channelBox.concat(dmBox)
}

// ----------------------------------------------------------------- centre --

function highlight (line, query) {
  const needle = query.toLowerCase()
  const hay = line.toLowerCase()
  let out = ''
  let at = 0

  for (;;) {
    const found = hay.indexOf(needle, at)
    if (found === -1) return out + line.slice(at)
    out += line.slice(at, found) + style.inverse(line.slice(found, found + needle.length))
    at = found + needle.length
  }
}

function searchLines (state, width) {
  const query = state.searchQuery
  const messages = state.messages?.[state.activeChannel] ?? []
  const hits = state.searchResults ?? messages.filter((message) =>
    String(message.content).toLowerCase().includes(query.toLowerCase()))

  const lines = [style.dim(truncate(`${hits.length} hit(s) for "${query}"`, width)), '']

  for (const hit of hits) {
    lines.push(style.bold(truncate(hit.author ?? hit.pubkey ?? '', width)))
    for (const piece of wrap(hit.content, Math.max(1, width - INDENT))) {
      lines.push(' '.repeat(INDENT) + highlight(piece, query))
    }
  }

  return lines
}

function transcriptLines (state, width) {
  const messages = state.messages?.[state.activeChannel] ?? []
  const agents = agentKeys(state)
  const lines = []

  for (const message of messages) {
    const bot = agents.has(message.pubkey)
    const selected = state.selectedMessage === message.id

    // The gutter, not the colour, is what marks an agent's turn: --demo and the
    // tests render without colour and the distinction has to survive that.
    const mark = selected ? '▸' : (bot ? '│' : ' ')
    const gutter = bot ? style.magenta(mark) : (selected ? style.cyan(mark) : mark)
    const name = bot ? style.magenta(message.author) : style.bold(message.author)

    lines.push(gutter + ' ' + style.dim(clock(message.ts)) + ' ' + truncate(name, Math.max(0, width - 8)))
    for (const piece of wrap(message.content, Math.max(1, width - GUTTER - INDENT))) {
      lines.push(gutter + ' '.repeat(INDENT) + piece)
    }

    const reactions = Object.entries(message.reactions ?? {})
    if (reactions.length > 0) {
      const row = reactions.map(([emoji, count]) => `${emoji} ${count}`).join('  ')
      lines.push(gutter + ' '.repeat(INDENT) + style.dim(truncate(row, Math.max(0, width - GUTTER - INDENT))))
    }
  }

  return lines
}

function composer (state, width, focused) {
  const typed = state.composer ?? ''
  const cursor = focused ? style.inverse(' ') : ''
  const text = typed === ''
    ? (focused ? cursor : style.dim('write a message'))
    : truncate(typed, Math.max(0, width - 3)) + cursor

  return style.cyan('❯') + ' ' + text
}

function centreColumn (state, { width, height, focus }) {
  const channel = activeChannel(state)
  const searching = typeof state.searchQuery === 'string' && state.searchQuery !== ''
  const inner = Math.max(0, width - 4)
  const rows = Math.max(0, height - 2)

  const roster = state.members?.[state.activeChannel] ?? []
  const title = searching
    ? 'search'
    : (channel === null ? 'no channel' : '#' + channel.name)

  const body = searching ? searchLines(state, inner) : transcriptLines(state, inner)

  // Tail-anchored, like any chat: the newest turn is the one that must be
  // on screen, and the composer keeps the last row for itself.
  const visible = rows <= 1 ? [] : body.slice(Math.max(0, body.length - (rows - 1)))
  while (visible.length < rows - 1) visible.unshift('')
  if (rows >= 1) visible.push(composer(state, inner, focus === 'messages' || focus === 'composer'))

  return box({
    title,
    width,
    height,
    active: focus === 'messages' || focus === 'members' || focus === 'composer' || focus === 'search',
    footer: roster.length === 0 ? '' : `${roster.length} members · ${roster.map((m) => m.name).join(' ')}`,
    body: visible
  })
}

// ------------------------------------------------------------------ right --

function flowEntries (state, width) {
  return (state.flow ?? []).map((entry) => {
    const mark = entry.ok === false ? style.red('✗') : style.green('✓')
    const note = entry.ok === false && entry.note ? ' ' + entry.note : ''
    const text = `${mark} ${entry.kind ?? ''} ${entry.label ?? ''}${note} ${style.dim(entry.author ?? '')}`

    // Single-spaced and pre-truncated: logPane re-flows its entries word by
    // word, so any column alignment built with runs of spaces would be eaten,
    // and one line per event keeps the firehose showing history rather than
    // wrapped tails.
    return { text: truncate(text, width), color: null }
  })
}

function rightColumn (state, { width, height, focus }) {
  const inner = Math.max(0, width - 4)
  const { rate, connections, subscriptions } = readMetrics(state)
  const history = rateHistory(state)

  // The full wording first, the abbreviation only when the column cannot hold
  // it — a truncated "5 su" is worse than a terse "5s".
  const full = `${rate} ev/s · ${connections} conn · ${subscriptions} subs`
  const meter = displayWidth(full) <= inner ? full : `${rate}/s ${connections}c ${subscriptions}s`

  // The meter and its sparkline share a row when the column is wide enough for
  // the spark to say anything; below that the spark gets a row of its own.
  const inlineSpark = inner - displayWidth(meter) - 1
  const footerRows = inlineSpark >= 8
    ? [pad(style.dim(meter), inner - inlineSpark) + sparkline(history, inlineSpark)]
    : [style.dim(truncate(meter, inner)), sparkline(history, inner)]

  const logHeight = Math.max(0, height - 2 - footerRows.length)

  return box({
    title: 'EVENT FLOW',
    width,
    height,
    active: focus === 'flow' || focus === 'relay',
    body: logPane({ entries: flowEntries(state, inner), width: inner, height: logHeight }).concat(footerRows)
  })
}

// ------------------------------------------------------------------ frame --

const HINTS = [
  '↑↓ move · enter open · / search · 1 user · 2 admin · q quit',
  '↑↓ move · / search · q quit',
  'q quit'
]

const CAPTION_ROOM = 44

// The caption is the demo's narration and outranks the key list: the longest
// set of hints that still leaves the caption room to speak wins.
function hints (width, caption) {
  const wanted = Math.min(displayWidth(caption), CAPTION_ROOM)
  for (const variant of HINTS) {
    if (width - displayWidth(variant) - 3 >= wanted) return variant
  }
  return HINTS[HINTS.length - 1]
}

function render (state, { width, height, focus = null } = {}) {
  if (height <= 0 || width <= 0) return []

  // The hints are fixed furniture, the caption is prose: when they collide the
  // caption gives way, otherwise statusbar would eat the key list from the right.
  const keys = hints(width, state.caption ?? '')
  const caption = truncate(state.caption ?? '', Math.max(0, width - displayWidth(keys) - 3))
  const bar = statusbar({ left: caption, right: keys, width })
  if (height === 1) return [bar]

  const paneHeight = height - 1
  const showLeft = width >= DROP_LEFT_BELOW
  const showRight = width >= DROP_RIGHT_BELOW

  const leftWidth = showLeft ? clamp(Math.round(width * 0.22), LEFT_MIN, LEFT_MAX) : 0
  const rightWidth = showRight ? clamp(Math.round(width * 0.28), RIGHT_MIN, RIGHT_MAX) : 0
  const centreWidth = width - leftWidth - rightWidth

  const columns = []
  if (showLeft) columns.push(leftColumn(state, { width: leftWidth, height: paneHeight, focus }))
  columns.push(centreColumn(state, { width: centreWidth, height: paneHeight, focus }))
  if (showRight) columns.push(rightColumn(state, { width: rightWidth, height: paneHeight, focus }))

  const lines = []
  for (let row = 0; row < paneHeight; row++) {
    lines.push(columns.map((column) => column[row] ?? '').join(''))
  }
  lines.push(bar)

  // The rectangle invariant is the contract with Screen and with the tests, so
  // it is re-established here rather than trusted from three sources at once.
  return lines.slice(0, height).map((line) => pad(line, width))
}

module.exports = { render }
