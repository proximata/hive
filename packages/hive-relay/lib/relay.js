'use strict'

const EventEmitter = require('bare-events')

const {
  verifyEvent,
  isEphemeral,
  isRelaySignedKind,
  isAuthorOnlyKind,
  isPGatedKind,
  isResultGatedKind,
  isUnsharedGatedEvent,
  requiresChannel,
  channelId: eventChannelId,
  referencedEvents,
  referencedPubkeys,
  tagValue,
  countTags,
  checkPGatedAuthorization,
  finalizeEvent,
  getPublicKey,
  generateSecretKey,
  toHex,
  KIND_AUTH,
  KIND_REACTION,
  KIND_DELETION,
  KIND_PRESENCE_UPDATE,
  KIND_TYPING_INDICATOR,
  SHARED_GATED_KINDS,
  WORKFLOW_EXECUTION_KINDS,
  KIND_GIFT_WRAP,
  LIMITS
} = require('hive-core')

const { randomChallenge, verifyAuthEvent, AccessPolicy, AlwaysAllowRateLimiter, TIERS } = require('hive-auth')

const { parseClientMessage, encode, ProtocolError } = require('./protocol')
const { SubscriptionRegistry, channelsFromFilters } = require('./subscriptions')
const { commandHandlers } = require('./handlers')

// Every filter in a REQ becomes its own SQL statement, so an uncapped REQ is
// one 64 KB frame buying ~4600 full-table scans on Bare's single loop. The
// ceiling was already named as TIERS.subscriptions and simply never read; this
// wires it rather than inventing a second number.
const MAX_FILTERS_PER_REQ = TIERS.human.subscriptions

// Every query orders created_at DESC, so an event dated year 30000 pins itself
// to the top of every result set forever - sticky spam for the price of one
// publish. 15 minutes is loose enough for a badly set clock and tight enough
// that the top of a feed stays the present.
//
// Only the future is bounded. Old timestamps are legitimate: imports and
// replication both carry them, and they sort to the bottom anyway.
const MAX_CREATED_AT_DRIFT_S = 900

// RateLimiter.sweep() existed from the start and had no caller, so the bucket
// map grew one entry per distinct publishing pubkey and never shrank. Once a
// minute is far cheaper than the leak and far coarser than the window.
const RATE_LIMIT_SWEEP_MS = 60000

let nextConnId = 1

/**
 * One client connection, independent of how its bytes arrive. A WebSocket and
 * a Hyperswarm stream produce exactly the same object, which is why the whole
 * protocol test suite can be run twice over two transports.
 */
class Connection {
  constructor (relay, { send, close, remote = null, url = null }) {
    this.relay = relay
    this.id = 'c' + nextConnId++
    this.remote = remote
    this.url = url ?? relay.url

    this._send = send
    this._close = close

    this.authState = 'pending'
    this.auth = null
    this.challenge = randomChallenge()
    this.closed = false
    this.slowStrikes = 0
  }

  get pubkey () {
    return this.auth === null ? null : this.auth.pubkey
  }

  send (frame) {
    if (this.closed) return false
    try {
      const accepted = this._send(frame)
      // A transport may signal backpressure by returning false. Three in a row
      // and the connection goes, rather than letting one stalled peer grow an
      // unbounded queue in the relay.
      if (accepted === false) {
        if (++this.slowStrikes >= LIMITS.SLOW_CLIENT_GRACE_LIMIT) {
          this.close('slow client')
          return false
        }
      } else {
        this.slowStrikes = 0
      }
      return true
    } catch (err) {
      this.relay.emit('connection-error', err, this)
      this.close('send failed')
      return false
    }
  }

  close (reason = '') {
    if (this.closed) return
    this.closed = true
    this.relay._teardown(this, reason)
    try {
      this._close?.(reason)
    } catch {
      // The transport may already be gone; closing twice is not an error.
    }
  }

  /** Feed one raw frame from the transport. */
  async message (raw) {
    if (this.closed) return

    let parsed
    try {
      parsed = parseClientMessage(raw)
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.send(encode.notice('invalid: ' + err.message))
        return
      }
      throw err
    }

    switch (parsed.type) {
      case 'AUTH': return this.relay._handleAuth(this, parsed.event)
      case 'EVENT': return this.relay._handleEvent(this, parsed.event)
      case 'REQ': return this.relay._handleReq(this, parsed.subId, parsed.filters)
      case 'COUNT': return this.relay._handleCount(this, parsed.subId, parsed.filters)
      case 'CLOSE': return this.relay._handleClose(this, parsed.subId)
    }
  }
}

class Relay extends EventEmitter {
  constructor (store, opts = {}) {
    super()

    this.store = store
    this.url = opts.url ?? 'ws://localhost:3000'
    this.name = opts.name ?? 'hive'
    this.description = opts.description ?? 'A hive mind communication platform on the Pears stack'
    this.icon = opts.icon ?? null

    this.secretKey = opts.secretKey ?? generateSecretKey()
    this.pubkey = getPublicKey(this.secretKey)

    this.subscriptions = new SubscriptionRegistry()
    this.connections = new Map()
    this.policy = opts.policy ?? new AccessPolicy(store, opts)
    this.rateLimiter = opts.rateLimiter ?? new AlwaysAllowRateLimiter()
    this.maxConnections = opts.maxConnections ?? LIMITS.MAX_CONNECTIONS
    this.requireAuth = opts.requireAuth !== false
    this.workflowEngine = opts.workflowEngine ?? null

    this.handlers = new Map(commandHandlers)

    // unref'd on purpose: a housekeeping timer must never be the reason Bare's
    // loop fails to reach idle, which is what mobile suspension depends on.
    this.sweepTimer = setInterval(() => this.rateLimiter.sweep(), RATE_LIMIT_SWEEP_MS)
    this.sweepTimer.unref?.()
  }

  // ------------------------------------------------------------ lifecycle --

  /** Admit a connection and immediately issue the NIP-42 challenge. */
  connect (transport) {
    if (this.connections.size >= this.maxConnections) {
      transport.close?.('rate-limited: relay at capacity')
      return null
    }

    const connection = new Connection(this, transport)
    this.connections.set(connection.id, connection)
    connection.send(encode.auth(connection.challenge))
    this.emit('connection', connection)
    return connection
  }

  _teardown (connection, reason) {
    this.subscriptions.removeConnection(connection.id)
    this.connections.delete(connection.id)
    this.emit('disconnect', connection, reason)
  }

  close () {
    clearInterval(this.sweepTimer)
    for (const connection of [...this.connections.values()]) connection.close('relay closing')
  }

  /** Sign an event with the relay's own key (discovery, system messages). */
  signAsRelay (template) {
    return finalizeEvent(template, this.secretKey)
  }

  // ----------------------------------------------------------------- auth --

  _handleAuth (connection, event) {
    const result = verifyAuthEvent(event, { challenge: connection.challenge, relayUrl: connection.url })

    if (!result.ok) {
      connection.authState = 'failed'
      connection.send(encode.ok(event?.id ?? '', false, result.reason))
      this._audit({ action: 'AuthFailure', actor: event?.pubkey ?? '', metadata: { reason: result.reason } })
      return false
    }

    const policy = this.policy.check(result.context.pubkey)
    if (!policy.ok) {
      connection.authState = 'failed'
      connection.send(encode.ok(event.id, false, policy.reason))
      this._audit({ action: 'AuthFailure', actor: result.context.pubkey, metadata: { reason: 'policy' } })
      return false
    }

    connection.authState = 'authenticated'
    connection.auth = result.context
    connection.send(encode.ok(event.id, true, ''))
    this._audit({ action: 'AuthSuccess', actor: result.context.pubkey, metadata: {} })
    this.emit('authenticated', connection)
    return true
  }

  #requireAuth (connection) {
    if (!this.requireAuth) return true
    return connection.authState === 'authenticated'
  }

  // ------------------------------------------------------- event pipeline --

  /** The 12-step pipeline from SPEC.md §4.2, in order. */
  async _handleEvent (connection, event) {
    const id = typeof event?.id === 'string' ? event.id : ''

    // 1. AUTH
    if (!this.#requireAuth(connection)) {
      return connection.send(encode.ok(id, false, 'auth-required: authenticate before publishing'))
    }

    // 2. PUBKEY MATCH — you may only publish as yourself.
    if (connection.auth !== null && event.pubkey !== connection.auth.pubkey) {
      return connection.send(encode.ok(id, false, 'invalid: event pubkey does not match the authenticated pubkey'))
    }

    if (!this.rateLimiter.allow(event.pubkey)) {
      this._audit({ action: 'RateLimitExceeded', actor: event.pubkey, metadata: {} })
      return connection.send(encode.ok(id, false, 'rate-limited: slow down'))
    }

    // 3. AUTH events are never stored.
    if (event.kind === KIND_AUTH) {
      return connection.send(encode.ok(id, false, 'invalid: auth events are not stored'))
    }

    // 5. VERIFY (before the ephemeral split, so unsigned ephemerals cannot
    //    be used to spoof presence).
    const verified = verifyEvent(event)
    if (!verified.ok) {
      return connection.send(encode.ok(id, false, 'invalid: ' + verified.reason))
    }

    // 6. Ingest rules that depend on kind rather than on membership.
    const ingest = this._validateIngest(event)
    if (ingest.reason !== null) {
      return connection.send(encode.ok(id, false, ingest.reason))
    }
    const channelId = ingest.channelId

    // 4. EPHEMERAL ROUTE — verified, never stored, never audited.
    if (isEphemeral(event.kind)) {
      return this._handleEphemeral(connection, event, channelId)
    }

    // 7. MEMBERSHIP / COMMAND AUTHORIZATION
    //
    // Command kinds carry their own rules — a join request comes from someone
    // who is by definition not yet a member — so they authorize themselves and
    // skip the generic membership gate. Authorization runs BEFORE the store, so
    // a rejected command leaves nothing behind.
    const handler = this.handlers.get(event.kind)

    if (handler !== undefined && typeof handler.authorize === 'function') {
      const reason = handler.authorize(this, event, { connection, channelId })
      if (reason !== null) return connection.send(encode.ok(id, false, reason))
    } else if (channelId !== null) {
      const channel = this.store.getChannel(channelId)
      if (channel === null) {
        return connection.send(encode.ok(id, false, 'invalid: unknown channel'))
      }
      if (!this._canWriteChannel(channel, event.pubkey)) {
        return connection.send(encode.ok(id, false, 'restricted: not a channel member'))
      }
    }

    // 8. STORE
    let result
    try {
      result = this.store.insertEvent(event, { channelId })
    } catch (err) {
      this.emit('error', err)
      return connection.send(encode.ok(id, false, 'error: ' + err.message))
    }

    if (!result.wasInserted) {
      // Either a byte-identical resubmission or a losing replaceable update.
      // Both are successes from the client's point of view.
      const reason = result.stored.event.id === event.id ? 'duplicate:' : 'invalid: a newer version of this event exists'
      return connection.send(encode.ok(id, result.stored.event.id === event.id, reason))
    }

    // 9. SIDE EFFECTS — NIP-29 commands and friends. Runs after the command
    //    event is durably stored, so the log explains every state change.
    if (handler !== undefined && typeof handler.apply === 'function') {
      try {
        await handler.apply(this, event, { connection, channelId })
      } catch (err) {
        this.emit('handler-error', err, event)
        const reason = err.isReject === true ? err.reason : 'error: ' + err.message
        return connection.send(encode.ok(id, false, reason))
      }
    }

    // 10. FAN-OUT
    this.broadcast(event, channelId)

    // 11. AUDIT (fire-and-forget: a failure here must not fail the submission)
    this._audit({
      action: 'EventCreated',
      actor: event.pubkey,
      eventId: event.id,
      kind: event.kind,
      channelId,
      metadata: {}
    })

    // 12. WORKFLOW TRIGGERS
    this._triggerWorkflows(event, channelId)

    connection.send(encode.ok(id, true, ''))
    this.emit('event', event, channelId)
    return true
  }

  _handleEphemeral (connection, event, channelId) {
    if (event.kind === KIND_PRESENCE_UPDATE) {
      // Presence skips the membership check: it is relay-wide, not per channel.
      this.store.setPresence(event.pubkey, event.content || 'online')
      this.broadcast(event, null)
      return connection.send(encode.ok(event.id, true, ''))
    }

    if (channelId !== null && !this.store.isMember(channelId, event.pubkey)) {
      return connection.send(encode.ok(event.id, false, 'restricted: not a channel member'))
    }

    this.broadcast(event, channelId)
    return connection.send(encode.ok(event.id, true, ''))
  }

  /**
   * Kind-specific ingest rules. Returns `{ channelId, reason }`; a non-null
   * reason rejects the event.
   */
  _validateIngest (event) {
    const reject = (reason) => ({ channelId: null, reason })

    if (event.created_at > Math.floor(Date.now() / 1000) + MAX_CREATED_AT_DRIFT_S) {
      return reject(`invalid: created_at is more than ${MAX_CREATED_AT_DRIFT_S}s in the future`)
    }

    // Relay-signed kinds may only come from the relay's own key. Without this
    // a client could forge membership notifications or group metadata.
    if (isRelaySignedKind(event.kind) && event.pubkey !== this.pubkey) {
      return reject(`invalid: kind ${event.kind} may only be signed by the relay`)
    }

    // The shared tag is an access-control switch, so an ambiguous shape must
    // never reach storage.
    if (SHARED_GATED_KINDS.includes(event.kind)) {
      const shared = countTags(event, 'shared')
      if (shared > 1) return reject('invalid: at most one shared tag is allowed')
      if (shared === 1 && tagValue(event, 'shared') !== 'true') {
        return reject('invalid: the shared tag value must be "true"')
      }
    }

    if (event.kind === KIND_REACTION) {
      // A reaction's channel comes from its target, never from a client-supplied
      // h tag — otherwise a reaction could smuggle itself into another channel.
      const targets = referencedEvents(event)
      if (targets.length === 0) return reject('invalid: reaction must reference an event')

      const target = this.store.getStoredEvent(targets[targets.length - 1])
      if (target === null) return reject('invalid: reaction target event not found')
      return { channelId: target.channelId, reason: null }
    }

    if (event.kind === KIND_DELETION) {
      const targets = referencedEvents(event)
      if (targets.length === 0) return reject('invalid: deletion must reference an event')

      for (const target of targets) {
        const stored = this.store.getStoredEvent(target)
        if (stored === null) continue
        if (stored.event.pubkey !== event.pubkey) {
          return reject('restricted: only the author may delete an event')
        }
      }
      return { channelId: eventChannelId(event), reason: null }
    }

    const channelId = eventChannelId(event)
    if (requiresChannel(event.kind) && channelId === null) {
      return reject('invalid: channel-scoped events must include an h tag')
    }

    return { channelId, reason: null }
  }

  _canWriteChannel (channel, pubkey) {
    if (this.store.isMember(channel.id, pubkey)) return true
    // Open channels accept posts from non-members, matching Buzz: the `closed`
    // tag in discovery describes the membership model, not write access.
    return channel.visibility === 'open'
  }

  // ------------------------------------------------------------- delivery --

  /** Fan out to every matching subscription. */
  broadcast (event, channelId) {
    let delivered = 0

    for (const entry of this.subscriptions.match(event, channelId ?? null)) {
      const connection = this.connections.get(entry.connId)
      if (connection === undefined || connection.closed) continue
      if (!this._canRead(connection, event, channelId)) continue

      connection.send(encode.event(entry.subId, event))
      delivered++
    }

    return delivered
  }

  /**
   * The per-event read gate, applied to both live fan-out and historical
   * results so the two paths cannot disagree.
   */
  _canRead (connection, event, channelId) {
    const pubkey = connection.pubkey

    if (isAuthorOnlyKind(event.kind) && event.pubkey !== pubkey) return false
    if (isUnsharedGatedEvent(event, pubkey)) return false

    if ((isPGatedKind(event.kind) || isResultGatedKind(event.kind)) && event.pubkey !== pubkey) {
      if (!referencedPubkeys(event).includes(pubkey)) return false
    }

    if (channelId !== null && channelId !== undefined) {
      const channel = this.store.getChannel(channelId)
      if (channel !== null && channel.visibility !== 'open' && !this.store.isMember(channelId, pubkey)) {
        return false
      }
    }

    return true
  }

  // ------------------------------------------------------------------ REQ --

  _handleReq (connection, subId, filters) {
    if (!this.#requireAuth(connection)) {
      return connection.send(encode.closed(subId, 'auth-required: authenticate before subscribing'))
    }

    if (filters.length > MAX_FILTERS_PER_REQ) {
      return connection.send(encode.closed(subId, `invalid: too many filters (max ${MAX_FILTERS_PER_REQ})`))
    }

    if (this.subscriptions.count(connection.id) >= LIMITS.MAX_SUBSCRIPTIONS &&
        this.subscriptions.get(connection.id, subId) === null) {
      return connection.send(encode.closed(subId, 'rate-limited: too many subscriptions'))
    }

    // Access is checked BEFORE registration. Registering first would leak live
    // events in the window between registering and rejecting.
    const channelIds = channelsFromFilters(filters)

    if (channelIds.length > 0) {
      const accessible = this.store.accessibleChannelIds(connection.pubkey)
      for (const channelId of channelIds) {
        if (!accessible.has(channelId)) {
          return connection.send(encode.closed(subId, 'restricted: not a channel member'))
        }
      }
    } else {
      // The #p requirement applies to GLOBAL subscriptions only. P-gated events
      // are stored community-global, so a channel-scoped filter cannot reach
      // them — and demanding #p there would break the most ordinary query a
      // client makes: "everything in this channel". Per-event authorization in
      // _canRead is the actual enforcement on both paths.
      const gate = checkPGatedAuthorization(filters, connection.pubkey)
      if (gate !== null) return connection.send(encode.closed(subId, gate))
    }

    this.subscriptions.register(connection.id, subId, filters, channelIds)

    // Historical results, then EOSE, then live delivery via broadcast().
    for (const stored of this._queryAuthorized(connection, filters)) {
      connection.send(encode.event(subId, stored.event))
    }
    connection.send(encode.eose(subId))
    return true
  }

  _handleCount (connection, subId, filters) {
    if (!this.#requireAuth(connection)) {
      return connection.send(encode.closed(subId, 'auth-required: authenticate before counting'))
    }

    if (filters.length > MAX_FILTERS_PER_REQ) {
      return connection.send(encode.closed(subId, `invalid: too many filters (max ${MAX_FILTERS_PER_REQ})`))
    }

    if (channelsFromFilters(filters).length === 0) {
      const gate = checkPGatedAuthorization(filters, connection.pubkey)
      if (gate !== null) return connection.send(encode.closed(subId, gate))
    }

    // Counted through the same authorization gate as reads, so a COUNT cannot
    // be used to probe for the existence of events you may not read.
    return connection.send(encode.count(subId, this._queryAuthorized(connection, filters).length))
  }

  _handleClose (connection, subId) {
    this.subscriptions.unregister(connection.id, subId)
    return true
  }

  /** Historical query results this connection is allowed to see. */
  _queryAuthorized (connection, filters) {
    const searchFilters = filters.filter((f) => typeof f.search === 'string' && f.search.length > 0)
    const plain = filters.filter((f) => typeof f.search !== 'string' || f.search.length === 0)

    const results = []
    if (plain.length > 0) results.push(...this.store.queryEvents(plain))

    for (const filter of searchFilters) {
      results.push(...this.store.search(filter.search, {
        kinds: filter.kinds,
        channelIds: filter['#h'],
        limit: filter.limit
      }))
    }

    const seen = new Set()
    return results.filter((stored) => {
      if (stored === null || seen.has(stored.event.id)) return false
      seen.add(stored.event.id)
      return this._canRead(connection, stored.event, stored.channelId)
    })
  }

  // ------------------------------------------------------------ internals --

  _audit (entry) {
    try {
      this.store.appendAudit(entry)
    } catch (err) {
      // Fire-and-forget: an audit failure must never fail the submission it
      // describes. It is surfaced as an event so an operator can alert on it.
      this.emit('audit-error', err, entry)
    }
  }

  _triggerWorkflows (event, channelId) {
    if (this.workflowEngine === null) return
    if (WORKFLOW_EXECUTION_KINDS.includes(event.kind)) return // loop prevention
    if (event.kind === KIND_GIFT_WRAP) return
    if (event.pubkey === this.pubkey && tagValue(event, 'buzz') === 'workflow') return

    Promise.resolve(this.workflowEngine.onEvent(event, { channelId }))
      .catch((err) => this.emit('workflow-error', err, event))
  }

  /** NIP-11 relay information document. */
  info () {
    return {
      name: this.name,
      description: this.description,
      pubkey: this.pubkey,
      contact: '',
      supported_nips: [1, 9, 10, 11, 16, 17, 23, 25, 29, 33, 34, 42, 43, 45, 50, 56, 98],
      software: 'https://github.com/hive/hive',
      version: require('../package.json').version,
      icon: this.icon,
      limitation: {
        max_message_length: LIMITS.MAX_FRAME_BYTES,
        max_subscriptions: LIMITS.MAX_SUBSCRIPTIONS,
        max_limit: LIMITS.MAX_HISTORICAL_LIMIT,
        auth_required: this.requireAuth,
        payment_required: false
      }
    }
  }
}

module.exports = { Relay, Connection, MAX_FILTERS_PER_REQ, MAX_CREATED_AT_DRIFT_S }
