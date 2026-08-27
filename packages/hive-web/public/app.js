// The Hive web client.
//
// Same three panels as the TUI — channels, transcript, event flow — reading the
// same relay through the interfaces every other client uses: NIP-98 for the
// REST read-model and a NIP-42 WebSocket for history and live delivery. There
// is no privileged path here and no server-side rendering: what this page shows
// is what a signed key is allowed to see.
//
// No build step. The relay serves this file and /vendor/ maps the bare @noble
// specifiers onto the same package it verifies signatures with, so the browser
// and the relay run one implementation of secp256k1 between them.

import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'

// From hive-core's registry (packages/hive-core/lib/kinds.js). Only the four
// this client writes or filters on are restated; every other kind is labelled
// from the map /api/relay hands back, so the list cannot fall behind.
const KIND_STREAM_MESSAGE = 9
const KIND_AGENT_PROFILE = 10100
const KIND_PRESENCE_UPDATE = 20001
const KIND_AUTH = 22242
const KIND_HTTP_AUTH = 27235

const HISTORY_LIMIT = 200
const FLOW_CAP = 200
const RATE_WINDOW_MS = 5000

const $ = (id) => document.getElementById(id)

const utf8 = (s) => new TextEncoder().encode(s)

// btoa is latin1-only, so a URL with a non-ASCII path segment would throw
// halfway through building an Authorization header. Encode first.
const base64 = (s) => btoa(String.fromCharCode(...utf8(s)))

/**
 * Build an element. Children are appended as text nodes, never parsed.
 *
 * This is the XSS boundary: every name, message and channel title below is
 * relay-supplied and therefore ultimately user-supplied. `append` with a string
 * always produces a text node, so there is no path from stored content into
 * markup. Nothing in this file uses innerHTML.
 */
function el (tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    node.setAttribute(name, String(value))
  }
  for (const child of children) {
    if (child === null || child === undefined) continue
    node.append(child)
  }
  return node
}

function clock (unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return '--:--'
  const date = new Date(unixSeconds * 1000)
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
}

const short = (pubkey) => (typeof pubkey === 'string' ? pubkey.slice(0, 8) : '')

// --------------------------------------------------------------- identity --

// A throwaway key, generated in this tab and kept in sessionStorage so a reload
// does not change who you are mid-session. It is never sent anywhere: only
// signatures leave the page. Closing the tab discards it — this is a demo
// identity, not key custody, and the banner says so.
const KEY_STORAGE = 'hive.demo-secret-key'

function loadIdentity () {
  let hex = null
  try {
    hex = sessionStorage.getItem(KEY_STORAGE)
  } catch {
    // Storage can be blocked outright (some private modes, some embeddings).
    // The consequence is bounded and worth stating: the key still works, it
    // just does not survive a reload.
    note('sessionStorage is unavailable; a reload will generate a new identity')
  }

  if (hex === null || !/^[0-9a-f]{64}$/.test(hex)) {
    hex = bytesToHex(schnorr.utils.randomSecretKey())
    try {
      sessionStorage.setItem(KEY_STORAGE, hex)
    } catch {}
  }

  const secretKey = hexToBytes(hex)
  return { secretKey, pubkey: bytesToHex(schnorr.getPublicKey(secretKey)) }
}

const me = loadIdentity()

/**
 * NIP-01 canonical serialization — the exact bytes that are SHA-256'd to make
 * the event id. JSON.stringify produces precisely the escaping NIP-01 requires,
 * which is what every other implementation relies on. Do not reformat.
 */
function serializeEvent (event) {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
}

function finalizeEvent ({ kind, tags = [], content = '' }) {
  const event = { pubkey: me.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content }
  event.id = bytesToHex(sha256(utf8(serializeEvent(event))))
  event.sig = bytesToHex(schnorr.sign(hexToBytes(event.id), me.secretKey))
  return event
}

/**
 * NIP-98: one signature, bound to one request. The `u` tag carries the full URL
 * including its query, `method` the verb, and `payload` the hash of the body
 * when there is one — the relay validates all three
 * (packages/hive-auth/lib/nip98.js).
 */
function nip98Header (url, method, body) {
  const tags = [['u', url], ['method', method.toUpperCase()]]
  if (body !== null && body !== undefined) tags.push(['payload', bytesToHex(sha256(utf8(body)))])
  return 'Nostr ' + base64(JSON.stringify(finalizeEvent({ kind: KIND_HTTP_AUTH, tags })))
}

// ------------------------------------------------------------------- REST --

/**
 * One authenticated request. Throws with the relay's own reason attached —
 * nothing here is allowed to return an empty result on failure, because a
 * silently empty panel is indistinguishable from an empty channel.
 */
async function api (pathname, { method = 'GET', body = null } = {}) {
  const url = new URL(pathname, location.origin).href
  const text = body === null ? null : JSON.stringify(body)

  const headers = { Authorization: nip98Header(url, method, text) }
  if (text !== null) headers['Content-Type'] = 'application/json'

  let res
  try {
    res = await fetch(url, { method, headers, body: text })
  } catch (err) {
    // fetch only rejects on a transport failure, so this really is "the relay
    // is not there", not "the relay said no".
    throw new Error(`relay unreachable — ${err.message}`)
  }

  let payload = null
  try {
    payload = await res.json()
  } catch {
    // A non-JSON body from an endpoint that always speaks JSON is itself the
    // information; keep the status and say so.
  }

  if (!res.ok) {
    const detail = payload === null
      ? res.statusText
      : `${payload.error ?? 'error'}: ${payload.message ?? ''}`
    throw new Error(`${method} ${pathname} → ${res.status} ${detail}`)
  }

  return payload
}

// ------------------------------------------------------------------ state --

const state = {
  relay: null,
  kindLabels: {},        // kind -> "stream message"
  flowKinds: [],         // every kind a global REQ is allowed to ask for
  channels: [],
  activeChannel: null,
  members: [],
  presence: new Map(),   // pubkey -> 'online' | 'away' | 'offline'
  profiles: new Map(),   // pubkey -> { name, agent }
  messages: [],
  seenMessages: new Set(),
  beats: [],             // arrival timestamps, for the ev/s meter
  connection: 'connecting',
  errors: []
}

const labelFor = (kind) => state.kindLabels[kind] ?? `kind ${kind}`

function nameFor (pubkey) {
  const profile = state.profiles.get(pubkey)
  if (profile !== undefined && profile.name) return profile.name
  return short(pubkey)
}

const isAgent = (pubkey) => state.profiles.get(pubkey)?.agent === true

/**
 * `[agent]`, or `[agent · alice]` when the kind-10100 profile names an owner.
 *
 * Whose agent this is, is protocol data — not a UI convention — so it is read
 * back off the log rather than configured here.
 *
 * ⚠ It is a CLAIM, not a proof. The profile is signed by the agent, so the
 * agent asserts its own owner; nothing on the relay verifies the NIP-OA
 * attestation that would bind the two keys. Do not read this as authorisation.
 */
function agentLabel (pubkey) {
  const owner = state.profiles.get(pubkey)?.owner ?? null
  return owner === null ? ' [agent]' : ` [agent · ${nameFor(owner)}]`
}

// ------------------------------------------------------------- messaging --

/** A hard failure the user has to see. Never swallowed, never only logged. */
function fail (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(err)
  state.errors.push(message)
  const box = $('error')
  box.textContent = state.errors.slice(-3).join('\n')
  box.hidden = false
}

/** A caveat rather than a failure: the page still works, with something less. */
function note (message) {
  console.warn(message)
  state.errors.push(message)
  const box = $('error')
  box.textContent = state.errors.slice(-3).join('\n')
  box.hidden = false
}

function renderStatus () {
  const beats = state.beats.filter((t) => t > Date.now() - RATE_WINDOW_MS)
  state.beats = beats
  const rate = (beats.length / (RATE_WINDOW_MS / 1000)).toFixed(1)

  const parts = [
    state.connection,
    `${rate} ev/s`,
    `${state.relay?.connections ?? 0} conn`,
    `${state.relay?.subscriptions ?? 0} subs`
  ]
  $('statusbar').textContent = parts.join(' · ')
  $('flow-foot').textContent = `${rate} ev/s`
}

// Connections and subscriptions have no push channel — there is no SSE and no
// metrics event — so the choice is to poll them or not to show them. One small
// request every ten seconds is cheaper than a status bar that lies. The failure
// is reported once and then stays quiet: the socket's close handler already
// says when the relay is gone, and two messages for one outage is noise.
let metricsFailed = false

async function refreshMetrics () {
  try {
    state.relay = await api('/api/relay')
    metricsFailed = false
  } catch (err) {
    if (!metricsFailed) note(`relay metrics stopped updating — ${err.message}`)
    metricsFailed = true
    return
  }
  renderStatus()
}

// ----------------------------------------------------------------- render --

function renderChannels () {
  const list = $('channels')
  list.replaceChildren()

  if (state.channels.length === 0) {
    list.append(el('li', { class: 'empty' }, 'no channels on this relay yet'))
    $('channels-foot').textContent = ''
    return
  }

  for (const channel of state.channels) {
    const active = channel.id === state.activeChannel
    const button = el(
      'button',
      {
        type: 'button',
        class: 'rowbtn',
        'aria-current': active ? 'true' : null,
        'data-channel': channel.id
      },
      // The selection marker is a glyph, not just a colour: the TUI's rule is
      // that the distinction survives with colour off, and so does this.
      el('span', { class: 'gutter', 'aria-hidden': 'true' }, active ? '▸' : ' '),
      '#' + channel.name,
      channel.visibility === 'private' ? el('span', { class: 'badge' }, 'private') : null
    )
    button.addEventListener('click', () => selectChannel(channel.id))
    list.append(el('li', {}, button))
  }

  $('channels-foot').textContent = `${state.channels.length}`
}

function renderMembers () {
  const list = $('members')
  list.replaceChildren()

  if (state.activeChannel === null) {
    list.append(el('li', { class: 'empty' }, 'no channel selected'))
    $('members-foot').textContent = ''
    return
  }
  if (state.members.length === 0) {
    list.append(el('li', { class: 'empty' }, 'no members'))
    $('members-foot').textContent = '0 members'
    return
  }

  for (const member of state.members) {
    const presence = state.presence.get(member.pubkey) ?? 'offline'
    list.append(el(
      'li',
      { class: 'row', 'data-turn': isAgent(member.pubkey) ? 'agent' : null },
      el('span', { class: 'presence', 'data-presence': presence, role: 'img', 'aria-label': presence }, '●'),
      ' ',
      nameFor(member.pubkey),
      ' ',
      el('span', { class: 'role', 'data-role': isAgent(member.pubkey) ? 'agent' : 'human' },
        isAgent(member.pubkey) ? agentLabel(member.pubkey).trimStart() : `[${member.role}]`)
    ))
  }

  $('members-foot').textContent = `${state.members.length} members`
}

function renderTranscript () {
  const list = $('transcript')
  list.replaceChildren()

  const channel = state.channels.find((c) => c.id === state.activeChannel) ?? null
  $('channel-title').textContent = channel === null ? 'no channel' : '#' + channel.name
  $('transcript-foot').textContent = channel === null ? '' : (channel.topic || channel.about || '')

  if (channel === null) {
    list.append(el('li', { class: 'empty' }, 'select a channel'))
    return
  }
  if (state.messages.length === 0) {
    list.append(el('li', { class: 'empty' }, `no messages in #${channel.name} yet`))
    return
  }

  for (const event of state.messages) {
    const agent = isAgent(event.pubkey)
    list.append(el(
      'li',
      { class: 'row', 'data-turn': agent ? 'agent' : null },
      el('span', { class: 'gutter', 'aria-hidden': 'true' }, agent ? '│' : ' '),
      el('span', { class: 'time' }, clock(event.created_at)),
      ' ',
      el('span', { class: 'author' }, nameFor(event.pubkey)),
      agent ? el('span', { class: 'role', 'data-role': 'agent' }, agentLabel(event.pubkey)) : null,
      el('p', { class: 'msg' }, event.content)
    ))
  }

  const main = list.parentElement
  main.scrollTop = main.scrollHeight
}

/**
 * The flow is append-only, not re-rendered: it is an aria-live region, and
 * rebuilding it would make a screen reader re-announce every past event.
 */
function pushFlow ({ kind, author, ok, note: detail }) {
  const list = $('flow')
  const label = labelFor(kind)

  list.append(el(
    'li',
    {},
    el('span', {
      class: 'glyph',
      'data-state': ok ? 'ok' : 'fail',
      role: 'img',
      'aria-label': ok ? 'accepted' : 'refused'
    }, ok ? '✓' : '✗'),
    ' ',
    el('span', { class: 'kind' }, `${kind} ${label}`),
    ' ',
    el('span', { class: 'who' }, author),
    detail ? el('span', { class: 'note' }, ' ' + detail) : null
  ))

  while (list.children.length > FLOW_CAP) list.firstElementChild.remove()

  const pane = list.parentElement
  pane.scrollTop = pane.scrollHeight

  state.beats.push(Date.now())
  renderStatus()
}

// ------------------------------------------------------------- profiles --

/**
 * Who is a machine, and what is everyone called.
 *
 * Agents are kind 10100 (SPEC.md §agents): one query for the whole page rather
 * than a lookup per message. Humans come from the users projection, which is
 * where kind 0 profiles land. `/api/users` answers with a bare `{pubkey}` for
 * anyone it has never seen, so every field has to be null-guarded.
 */
async function loadAgents () {
  const events = await api('/query', { method: 'POST', body: [{ kinds: [KIND_AGENT_PROFILE], limit: 500 }] })
  const owners = []

  for (const event of events) {
    let persona = null
    let owner = null
    try {
      const content = JSON.parse(event.content)
      persona = content?.persona ?? null
      // Self-owned is the same as unowned for display purposes: an agent that
      // names itself is what the harness writes when no owner was configured.
      owner = typeof content?.owner === 'string' && content.owner !== event.pubkey ? content.owner : null
    } catch {
      persona = null // an agent profile with unparseable content is still an agent
    }
    const existing = state.profiles.get(event.pubkey)
    state.profiles.set(event.pubkey, { name: existing?.name || persona || short(event.pubkey), agent: true, owner })
    if (owner !== null) owners.push(owner)
  }

  // The owner's own kind-0 has to be resolved now, or the very first agent line
  // painted would read `[agent · 4b06e74d]` and only settle later.
  if (owners.length > 0) await ensureProfiles(owners)
}

async function ensureProfiles (pubkeys) {
  const missing = [...new Set(pubkeys)].filter((pubkey) => !state.profiles.has(pubkey))
  if (missing.length === 0) return

  // The endpoint slices at 200; chunk rather than silently lose the tail.
  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200)
    const query = chunk.map((pubkey) => `pubkey=${encodeURIComponent(pubkey)}`).join('&')
    for (const user of await api(`/api/users?${query}`)) {
      const existing = state.profiles.get(user.pubkey)
      if (existing?.agent === true) continue
      state.profiles.set(user.pubkey, { name: user.displayName || short(user.pubkey), agent: false })
    }
  }
}

async function loadPresence (pubkeys) {
  if (pubkeys.length === 0) return
  const query = pubkeys.slice(0, 200).map((pubkey) => `pubkey=${encodeURIComponent(pubkey)}`).join('&')
  for (const row of await api(`/api/presence?${query}`)) state.presence.set(row.pubkey, row.presence)
}

// ------------------------------------------------------------- WebSocket --

// NIP-42 lives entirely in-band: the relay sends its challenge on connect,
// before the client says anything, so a browser WebSocket — which cannot set
// headers — authenticates exactly like any other client.
let socket = null
let authEventId = null
let backoff = 1000

/**
 * History order, oldest first.
 *
 * The store hands history back newest-first, tie-broken by event id
 * (hive-store/lib/sqlite-store.js:263). `created_at` has one-second resolution,
 * so a burst inside a single second carries NO chronological order on the wire
 * — no client can recover it. This mirrors the store's own key in the direction
 * a transcript reads, which is the most order the data actually has. Live events
 * are appended in arrival order and never re-sorted, exactly as the TUI does it.
 */
const byOldestFirst = (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1)

// Both subscriptions buffer until EOSE rather than re-sorting a growing list on
// every frame.
// The firehose is two subscriptions, not one — see subscribe(). Both feed the
// same pane and the pane opens once BOTH have sent EOSE, so the first paint is
// in chronological order across the two.
const FLOW_SUBS = new Set(['flow', 'flow-chan'])
const flowBuffer = []
let flowLoaded = false
let flowPending = 0
const chanBuffer = []
let chanLoaded = false

/** Paint the buffered history, once every flow subscription has reported in. */
function drainFlow () {
  if (flowPending > 0 || flowLoaded) return
  flowBuffer.sort(byOldestFirst)
  if (flowBuffer.length > 0) $('flow').querySelector('.empty')?.remove()
  // The two subscriptions overlap on HISTORY only: the global one's stored
  // query is not channel-scoped, so an event in an open channel can come back
  // on both. Live delivery cannot double up — a channel-scoped event reaches
  // the channel tier alone (lib/subscriptions.js).
  const seen = new Set()
  for (const event of flowBuffer) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    renderFlowEvent(event)
  }
  flowBuffer.length = 0
  flowLoaded = true
}

function send (frame) {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(frame))
  return true
}

function setConnection (value) {
  state.connection = value
  const composerReady = value === 'authenticated' && state.activeChannel !== null
  $('compose-input').disabled = !composerReady
  $('composer').querySelector('button').disabled = !composerReady
  $('compose-input').title = composerReady ? '' : `composer disabled: ${value}`
  renderStatus()
}

function connect () {
  const url = location.origin.replace(/^http/, 'ws')
  socket = new WebSocket(url)

  socket.addEventListener('open', () => {
    setConnection('connected')
    backoff = 1000
  })

  socket.addEventListener('message', (message) => {
    let frame
    try {
      frame = JSON.parse(message.data)
    } catch (err) {
      fail(new Error(`relay sent a frame that is not JSON: ${err.message}`))
      return
    }
    onFrame(frame)
  })

  socket.addEventListener('close', () => {
    setConnection('disconnected — retrying')
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 15000)
  })

  // 'error' is always followed by 'close', which owns the retry; reporting both
  // would double every message.
  socket.addEventListener('error', () => {})
}

function onFrame (frame) {
  const [type] = frame

  if (type === 'AUTH') {
    const event = finalizeEvent({
      kind: KIND_AUTH,
      tags: [['relay', location.origin], ['challenge', frame[1]]]
    })
    authEventId = event.id
    send(['AUTH', event])
    return
  }

  if (type === 'OK') {
    const [, id, accepted, reason] = frame
    if (id === authEventId) {
      if (!accepted) return fail(new Error(`relay refused the NIP-42 auth: ${reason}`))
      setConnection('authenticated')
      subscribe()
      return
    }
    // A publish result. Refusals are the interesting ones and they belong in
    // the flow exactly as the TUI shows them, with the relay's own wording.
    pushFlow({ kind: KIND_STREAM_MESSAGE, author: nameFor(me.pubkey), ok: accepted, note: accepted ? '' : reason })
    if (!accepted) fail(new Error(`message refused: ${reason}`))
    return
  }

  if (type === 'EVENT') {
    const [, subId, event] = frame
    if (FLOW_SUBS.has(subId)) onFlowEvent(event)
    else if (subId === 'chan') onChannelEvent(event)
    return
  }

  if (type === 'EOSE') {
    if (FLOW_SUBS.has(frame[1])) {
      // boot() reads /api/relay BEFORE connect(), so the status bar opens
      // holding a snapshot taken while this page was not yet a connection and
      // had no subscription — it read `0 conn · 0 subs` however busy the relay
      // was, until the 10s poll corrected it. EOSE is the first moment the
      // relay has definitely counted both, so re-read here. The interval stays
      // as the backstop.
      refreshMetrics()
      flowPending--
      drainFlow()
    }
    if (frame[1] === 'chan') {
      chanBuffer.sort(byOldestFirst)
      state.messages = chanBuffer.slice()
      chanBuffer.length = 0
      chanLoaded = true
      ensureProfiles(state.messages.map((e) => e.pubkey)).then(renderTranscript, (err) => {
        note(err.message)
        renderTranscript()
      })
    }
    return
  }

  if (type === 'CLOSED') {
    // The channel-scoped half of the firehose is the one subscription this page
    // can lose and still be correct: the pane narrows to channel-less events
    // rather than going wrong. A relay that restricts it (every channel private
    // to this key, say) is doing its job, so say so and carry on.
    if (frame[1] === 'flow-chan') {
      flowPending--
      drainFlow()
      note(`the event flow is narrower than usual — ${frame[2]}`)
      return
    }
    fail(new Error(`subscription ${frame[1]} closed by the relay: ${frame[2]}`))
    return
  }

  if (type === 'NOTICE') {
    note(`relay notice: ${frame[1]}`)
  }
}

function renderFlowEvent (event) {
  pushFlow({ kind: event.kind, author: nameFor(event.pubkey), ok: true, note: '' })
}

function onFlowEvent (event) {
  if (!flowLoaded) {
    flowBuffer.push(event)
    return
  }
  const placeholder = $('flow').querySelector('.empty')
  if (placeholder !== null) placeholder.remove()
  renderFlowEvent(event)

  // Presence is ephemeral: it is broadcast and never stored as an event, so the
  // firehose IS the presence feed. Reading it here means the member list stays
  // live without a second poll (relay.js:332).
  if (event.kind === KIND_PRESENCE_UPDATE) {
    state.presence.set(event.pubkey, event.content || 'online')
    renderMembers()
  }

  // A live author nobody has seen before: name it, then repaint what is on
  // screen. Fire-and-forget is fine, a failure here is not fatal.
  if (!state.profiles.has(event.pubkey)) {
    ensureProfiles([event.pubkey]).then(renderTranscript, (err) => note(err.message))
  }
}

function onChannelEvent (event) {
  if (state.seenMessages.has(event.id)) return
  state.seenMessages.add(event.id)

  if (!chanLoaded) {
    chanBuffer.push(event)
    return
  }

  // Appended, not re-sorted: after EOSE, arrival order is real chronological
  // order and is finer-grained than created_at can express.
  state.messages.push(event)

  if (state.profiles.has(event.pubkey)) {
    renderTranscript()
  } else {
    ensureProfiles([event.pubkey]).then(renderTranscript, (err) => {
      note(err.message)
      renderTranscript()
    })
  }
}

/**
 * Three subscriptions.
 *
 * `flow` is the firehose. It has to name its kinds explicitly: a kindless
 * global REQ can match p-gated kinds — DMs, membership notifications, agent
 * turn metrics — and the relay closes it (hive-core/lib/filter.js:108). So the
 * page asks for every kind the relay says is not p-gated, which means the flow
 * pane is honestly a little narrower than the TUI's in-process tap. That is the
 * access control working, not a gap.
 *
 * `flow-chan` is the rest of that firehose, and it has to be a SEPARATE
 * subscription. A channel-scoped event is delivered only to subscriptions that
 * NAMED its channel — global ones are structurally excluded, which is what
 * stops `{"kinds":[9]}` draining every private room on the relay
 * (hive-relay/lib/subscriptions.js). So a page with only the global REQ sees
 * presence and profiles and nothing else: measured against a relay carrying 40
 * ev/s, the pane received 4.3 ev/s and the status bar reported that as the
 * relay's rate. Naming the channels fixes it, and it cannot over-report:
 * `_handleReq` refuses a channel this key may not read, and every event still
 * passes the same per-event read gate as history. One REQ carrying both filters
 * would not work — one unscoped filter makes the whole subscription global
 * again (channelsFromFilters).
 *
 * `chan` is the transcript: history, EOSE, then live delivery on the same
 * subscription. No polling, no cursor to get wrong.
 */
function subscribe () {
  flowBuffer.length = 0
  flowLoaded = false
  flowPending = 1
  send(['REQ', 'flow', { kinds: state.flowKinds, limit: 40 }])

  const channelIds = state.channels.map((channel) => channel.id)
  if (channelIds.length > 0) {
    flowPending++
    send(['REQ', 'flow-chan', { kinds: state.flowKinds, '#h': channelIds, limit: 40 }])
  }

  if (state.activeChannel !== null) {
    send(['REQ', 'chan', { kinds: [KIND_STREAM_MESSAGE], '#h': [state.activeChannel], limit: HISTORY_LIMIT }])
  }
}

// ------------------------------------------------------------ navigation --

async function selectChannel (id) {
  state.activeChannel = id
  state.messages = []
  state.seenMessages.clear()
  state.members = []
  chanBuffer.length = 0
  chanLoaded = false

  renderChannels()
  renderTranscript()
  renderMembers()
  setConnection(state.connection)

  if (socket !== null && socket.readyState === WebSocket.OPEN) {
    send(['CLOSE', 'chan'])
    send(['REQ', 'chan', { kinds: [KIND_STREAM_MESSAGE], '#h': [id], limit: HISTORY_LIMIT }])
  }

  try {
    state.members = await api(`/api/channels/${encodeURIComponent(id)}/members`)
    const pubkeys = state.members.map((m) => m.pubkey)
    await ensureProfiles(pubkeys)
    await loadPresence(pubkeys)
  } catch (err) {
    fail(err)
  }
  renderMembers()
}

/** ↑/↓ move between channels, matching the TUI's own key hints. */
function channelKeys (event) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const buttons = [...$('channels').querySelectorAll('button')]
  const at = buttons.indexOf(document.activeElement)
  if (at === -1) return
  event.preventDefault()
  const next = buttons[at + (event.key === 'ArrowDown' ? 1 : -1)]
  if (next !== undefined) next.focus()
}

// --------------------------------------------------------------- composer --

async function onCompose (event) {
  event.preventDefault()
  const input = $('compose-input')
  const content = input.value.trim()
  if (content === '' || state.activeChannel === null) return

  const signed = finalizeEvent({
    kind: KIND_STREAM_MESSAGE,
    tags: [['h', state.activeChannel]],
    content
  })

  // Over the socket, not POST /events: it is already authenticated with the
  // same key, and the OK frame comes back on the same connection.
  if (!send(['EVENT', signed])) {
    fail(new Error('not connected to the relay; message not sent'))
    return
  }
  input.value = ''
}

// ------------------------------------------------------------------- boot --

async function boot () {
  $('identity').textContent = `demo key ${short(me.pubkey)}… (this tab only)`
  setConnection('connecting')

  try {
    state.relay = await api('/api/relay')
  } catch (err) {
    fail(err)
    $('relay-name').textContent = 'relay unreachable'
    $('channels').replaceChildren(el('li', { class: 'empty' }, 'could not reach the relay'))
    $('transcript').replaceChildren(el('li', { class: 'empty' }, 'could not reach the relay'))
    return
  }

  $('relay-name').textContent = state.relay.name ?? 'hive'
  state.kindLabels = state.relay.kinds ?? {}
  const gated = new Set((state.relay.pGatedKinds ?? []).map(Number))
  state.flowKinds = Object.keys(state.kindLabels).map(Number).filter((kind) => !gated.has(kind))

  try {
    await loadAgents()
  } catch (err) {
    note(`agent profiles unavailable, every author will read as human — ${err.message}`)
  }

  try {
    state.channels = await api('/api/channels')
  } catch (err) {
    fail(err)
    $('channels').replaceChildren(el('li', { class: 'empty' }, 'could not load channels'))
    return
  }

  renderChannels()
  await ensureProfiles([me.pubkey]).catch((err) => note(err.message))

  if (state.channels.length > 0) await selectChannel(state.channels[0].id)
  else renderTranscript()

  connect()
}

$('composer').addEventListener('submit', (event) => { onCompose(event).catch(fail) })
$('channels').addEventListener('keydown', channelKeys)
setInterval(renderStatus, 1000)
setInterval(refreshMetrics, 10000)

// An unhandled rejection anywhere in the app is a bug the user should see, not
// a silent dead panel.
addEventListener('unhandledrejection', (event) => fail(event.reason))

boot().catch(fail)
