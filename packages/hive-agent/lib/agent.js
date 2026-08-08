'use strict'

const EventEmitter = require('bare-events')

const core = require('hive-core')
const { events } = require('hive-sdk')

const { RelayConnection } = require('./connection')
const { MockProvider } = require('./provider')
const { providerFromPersona } = require('./qvac')

/**
 * The agent harness.
 *
 * An agent is a Nostr keypair that joined some channels. It watches for
 * mentions, batches them per channel, asks its provider for a reply, and posts
 * the reply as an ordinary kind-9 message — signed by itself, audited like
 * anyone else's. Nothing about it is privileged; the relay cannot tell it from
 * a person.
 *
 * Backpressure is per channel: at most one turn is in flight per channel, and
 * mentions that arrive during a turn are batched into the next prompt. A slow
 * turn in one channel therefore never blocks another, and a burst of mentions
 * produces one considered reply rather than five racing ones.
 */
class Agent extends EventEmitter {
  constructor (opts = {}) {
    super()

    this.secretKey = typeof opts.secretKey === 'string' ? core.fromHex(opts.secretKey) : opts.secretKey
    this.pubkey = core.getPublicKey(this.secretKey)
    this.owner = opts.owner ?? null
    this.persona = opts.persona ?? null
    this.attestation = opts.attestation ?? null

    this.provider = opts.provider ?? (this.persona !== null
      ? providerFromPersona(this.persona, opts)
      : new MockProvider())

    this.connection = opts.connection ?? new RelayConnection({
      url: opts.url ?? 'ws://127.0.0.1:3000',
      secretKey: this.secretKey,
      bootstrap: opts.bootstrap ?? null
    })

    this.historyLimit = opts.historyLimit ?? 12
    this.queues = new Map() // channelId -> { pending: [], running: boolean }
    this.channels = new Set()
    this.started = false
  }

  /**
   * Report a non-fatal error.
   *
   * A bare `emit('error')` with no listener throws, which would turn a relay
   * hiccup or a shutdown race into a crashed process. An agent is a long-lived
   * background participant: it records the failure and keeps going, and callers
   * that care can attach a listener.
   */
  _raise (err) {
    this.lastError = err
    if (this.listenerCount('error') > 0) this.emit('error', err)
  }

  get displayName () {
    return this.persona?.display_name ?? 'agent'
  }

  async start () {
    if (this.started) return this
    this.started = true

    if (this.connection.authenticated === false) await this.connection.connect()

    this.connection.on('event', (event, subId) => this._onevent(event, subId))
    this.connection.on('error', (err) => this._raise(err))

    await this.publishProfile()

    // Mentions cannot be watched with one global subscription: channel-scoped
    // events are delivered only to subscriptions that name their channel, which
    // is the boundary that stops anyone draining private channels. So the agent
    // learns which channels it belongs to from membership notifications —
    // which are community-global precisely so a client can bootstrap without
    // knowing any channel id in advance — and then subscribes per channel.
    //
    // The historical batch replays every past add/remove, so a restart
    // reconstructs the full channel set before EOSE.
    this.connection.subscribe('membership', {
      kinds: [core.KIND_MEMBER_ADDED_NOTIFICATION, core.KIND_MEMBER_REMOVED_NOTIFICATION],
      '#p': [this.pubkey]
    })

    this.emit('started')
    return this
  }

  /**
   * Publish the agent's kind-10100 profile: who owns it, what runtime it uses,
   * and what it can actually do. This is the discovery surface — "who on this
   * relay can transcribe audio?" is a filter query, not an API call.
   */
  async publishProfile () {
    const capabilities = await this.provider.capabilities()

    const event = events.agentProfile(this.secretKey, {
      owner: this.owner ?? this.pubkey,
      persona: this.persona?.slug ?? null,
      runtime: this.persona?.runtime ?? 'mock',
      capabilities,
      models: this.persona?.model ? [this.persona.model] : [],
      delegation: this.persona?.provider ? { accepts: false, public_key: this.persona.provider } : null,
      sdkVersion: this.persona?.sdk_version ?? null
    })

    // Attach the owner attestation when there is one, so every action this
    // agent takes carries provenance without pretending to be the owner.
    if (this.attestation !== null) event.tags.push(this.attestation)
    const signed = this.attestation === null
      ? event
      : core.finalizeEvent({ kind: event.kind, tags: event.tags, content: event.content }, this.secretKey)

    await this.connection.publish(signed)
    this.emit('profile', signed)
    return signed
  }

  _onevent (event, subId) {
    if (event.pubkey === this.pubkey) return // never answer yourself

    if (subId === 'membership') {
      const channelId = core.tagValue(event, 'h')
      if (channelId === null) return

      if (event.kind === core.KIND_MEMBER_ADDED_NOTIFICATION) this.watch(channelId)
      else this.unwatch(channelId)
      return
    }

    if (!subId.startsWith('chan:')) return

    const channelId = core.channelId(event)
    if (channelId === null) return

    // Only mentions are answered. Everything else in the channel is context the
    // agent can read but should not react to — an agent that replies to every
    // message is a chat bot, not a teammate.
    if (!core.referencedPubkeys(event).includes(this.pubkey)) return

    this._enqueue(channelId, event)
  }

  /** Start watching a channel for mentions. Idempotent. */
  watch (channelId) {
    if (this.channels.has(channelId)) return
    this.channels.add(channelId)

    this.connection.subscribe(`chan:${channelId}`, {
      kinds: [core.KIND_STREAM_MESSAGE, core.KIND_STREAM_MESSAGE_V2, core.KIND_JOB_REQUEST],
      '#h': [channelId],
      '#p': [this.pubkey],
      // Only what happens from now on: replaying old mentions on every restart
      // would have the agent answer conversations that ended days ago.
      since: Math.floor(Date.now() / 1000)
    })

    this.emit('joined', channelId)
  }

  unwatch (channelId) {
    if (!this.channels.has(channelId)) return
    this.channels.delete(channelId)
    this.connection.unsubscribe(`chan:${channelId}`)
    this.emit('left', channelId)
  }

  _enqueue (channelId, event) {
    let queue = this.queues.get(channelId)
    if (queue === undefined) {
      queue = { pending: [], running: false }
      this.queues.set(channelId, queue)
    }

    queue.pending.push(event)
    this.emit('mention', event, channelId)

    if (!queue.running) this._drain(channelId).catch((err) => this._raise(err))
  }

  async _drain (channelId) {
    const queue = this.queues.get(channelId)
    if (queue === undefined || queue.running) return

    queue.running = true
    try {
      while (queue.pending.length > 0) {
        // Everything queued during the previous turn is answered together.
        const batch = queue.pending.splice(0, queue.pending.length)
        await this.turn(channelId, batch)
      }
    } finally {
      queue.running = false
    }
  }

  /** One complete turn: prompt in, reply out, job lifecycle recorded. */
  async turn (channelId, batch) {
    const trigger = batch[batch.length - 1]
    const jobId = trigger.id
    const startedAt = Date.now()

    await this._publishJobEvent(core.KIND_JOB_ACCEPTED, { channelId, jobId, requester: trigger.pubkey })

    try {
      const history = await this._buildHistory(channelId, batch)
      const run = this.provider.complete({ history })

      let text = ''
      for await (const chunk of run.events) {
        if (chunk.type === 'contentDelta') text += chunk.text
      }
      const final = await run.final
      const content = (final?.content ?? text).trim()

      const reply = events.message(this.secretKey, {
        channel: channelId,
        content: content.length > 0 ? content : '(no response)',
        replyTo: trigger.id,
        mentions: [trigger.pubkey]
      })
      await this.connection.publish(reply)

      await this._publishJobEvent(core.KIND_JOB_RESULT, {
        channelId,
        jobId,
        requester: trigger.pubkey,
        content: reply.id
      })

      // Turn metrics are encrypted to the owner in production and p-gated
      // either way, so cost and latency stay between agent and owner.
      if (this.owner !== null) {
        await this.connection.publish(events.turnMetric(this.secretKey, {
          owner: this.owner,
          jobId,
          metrics: {
            channel: channelId,
            batched: batch.length,
            duration_ms: Date.now() - startedAt,
            model: final?.model ?? null,
            stats: final?.stats ?? null
          }
        }))
      }

      this.emit('reply', reply, { channelId, batch })
      return reply
    } catch (err) {
      await this._publishJobEvent(core.KIND_JOB_ERROR, {
        channelId,
        jobId,
        requester: trigger.pubkey,
        content: err.message
      })
      this.emit('turn-error', err, { channelId, batch })
      return null
    }
  }

  /** Recent channel messages plus this batch, as provider-shaped turns. */
  async _buildHistory (channelId, batch) {
    const history = []

    if (this.persona?.system_prompt) {
      history.push({ role: 'system', content: this.persona.system_prompt })
    }

    for (const event of batch) {
      history.push({
        role: 'user',
        content: event.content,
        name: event.pubkey.slice(0, 8)
      })
    }

    return history.slice(-this.historyLimit)
  }

  async _publishJobEvent (kind, { channelId, jobId, requester, content = '' }) {
    try {
      await this.connection.publish(
        events.jobEvent(this.secretKey, kind, { channel: channelId, jobId, requester, content })
      )
    } catch (err) {
      // Job telemetry must never take down a turn.
      this._raise(err)
    }
  }

  async stop () {
    this.started = false
    await this.provider.close?.()
    await this.connection.close()
    this.emit('stopped')
  }
}

module.exports = { Agent }
