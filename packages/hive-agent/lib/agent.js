'use strict'

const EventEmitter = require('bare-events')

const core = require('hive-core')
const { events } = require('hive-sdk')

const { RelayConnection } = require('./connection')
const { MockProvider } = require('./provider')
const { providerFromPersona } = require('./qvac')

// How far a chain of agent-to-agent replies may travel before it is cut.
//
// Every reply an agent makes p-tags whoever triggered it, and nothing in this
// harness distinguishes a human sender from an agent one — which is exactly
// what makes agent-to-agent work with no new protocol, and exactly what makes
// two agents mentioning each other a guaranteed infinite loop. Measured before
// this guard existed: 143 messages per second between two agents, content
// compounding on every hop, terminated only by the relay's per-pubkey token
// bucket.
//
// So each reply carries `["hop", "n"]` and an agent refuses to answer anything
// already at the ceiling. 4 leaves room for human → A → B → human with slack.
//
// ponytail: the tag is self-signed and therefore forgeable — a hostile agent
// can reset its own hop count to 0 forever. Ceiling accepted because it
// terminates every honest topology and the rate limiter is still the
// adversarial backstop. Upgrade path: have the relay stamp the hop on ingest by
// reading it off the `e`-tagged parent, which a client cannot forge.
const HOP_TAG = 'hop'
const DEFAULT_MAX_HOPS = 4

function hopOf (event) {
  const value = Number(core.tagValue(event, HOP_TAG))
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

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

    // Who may spend the owner's key. `null` means anyone — the default, because
    // the relay's channels are the access control that already exists and an
    // agent invited to a channel is meant to answer the people in it. An
    // allowlist is opt-in, configured on the author-only persona (kind 30175)
    // so the roster is not world-readable, and the owner is always in it:
    // locking yourself out of your own agent is never the intent.
    const allow = opts.allow ?? this.persona?.allow ?? null
    this.allow = Array.isArray(allow) && allow.length > 0
      ? new Set([...allow, ...(this.owner === null ? [] : [this.owner])])
      : null

    this.historyLimit = opts.historyLimit ?? 12
    this.maxHops = opts.maxHops ?? DEFAULT_MAX_HOPS
    this.queues = new Map() // channelId -> { pending: [], running: boolean }
    this.handled = [] // recent trigger keys, newest last — see _triggerKey
    this.handledLimit = opts.handledLimit ?? 256
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

    // Set membership, before anything is queued and long before a token is
    // spent. A refusal is recorded as an ordinary 43006 job error rather than
    // dropped, so an operator reading the log can tell "nobody asked" from
    // "someone asked and was turned away".
    //
    // ponytail: an unknown sender therefore costs one signed publish, which is
    // an amplification lever a spammer can pull. Accepted because the relay's
    // per-pubkey token bucket is the backstop for volume and silent drops are
    // worse than cheap ones. Upgrade path: only record the first refusal per
    // sender per window.
    if (this.allow !== null && !this.allow.has(event.pubkey)) {
      this.emit('refused', event, channelId)
      this._publishJobEvent(core.KIND_JOB_ERROR, {
        channelId, jobId: event.id, requester: event.pubkey, content: 'sender not allowed'
      }).catch((err) => this._raise(err))
      return
    }

    // The loop guard. See HOP_TAG above: this is the only thing that stops two
    // agents that mention each other, and it must come before the queue, not
    // inside the turn — a dropped mention must cost nothing at all.
    const hop = hopOf(event)
    if (hop >= this.maxHops) {
      this.emit('hop-limit', event, channelId, hop)
      return
    }

    // One piece of work, answered once. A delegation lands twice by design — as
    // the chat message the delegate is mentioned in, and as the kind-43001 job
    // request that is the machine-readable half of the same act — and answering
    // both produced two identical replies to the same person. Keyed on the event
    // id the job request names, so the collapse is exact rather than a guess at
    // similar content, and order-independent: whichever arrives second is the
    // one dropped.
    const key = this._triggerKey(event)
    if (this.handled.includes(key)) {
      this.emit('duplicate', event, channelId)
      return
    }
    this.handled.push(key)
    while (this.handled.length > this.handledLimit) this.handled.shift()

    this._enqueue(channelId, event)
  }

  /**
   * What piece of work an incoming event represents.
   *
   * A job request names its subject in `d`; everything else is its own subject.
   * A human-issued 43001 carries an opaque job id there, which is unique anyway,
   * so this never collapses two genuinely different requests.
   */
  _triggerKey (event) {
    if (event.kind !== core.KIND_JOB_REQUEST) return event.id
    return core.tagValue(event, 'd') ?? event.id
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
    // Everything this turn emits sits one hop further out than what caused it.
    const hop = Math.max(...batch.map(hopOf)) + 1
    const hopTag = [HOP_TAG, String(hop)]

    await this._publishJobEvent(core.KIND_JOB_ACCEPTED, { channelId, jobId, requester: trigger.pubkey })

    try {
      const history = await this._buildHistory(channelId, batch)
      const run = this.provider.complete({ history })

      let text = ''
      for await (const chunk of run.events) {
        if (chunk.type === 'contentDelta') text += chunk.text
        // A provider that narrates its work gets that narration onto the log as
        // ordinary job progress. Nothing invents a kind for it: 43003 has always
        // meant "this job is partway through", it simply had no emitter.
        else if (chunk.type === 'progress' && typeof chunk.text === 'string') {
          await this._publishJobEvent(core.KIND_JOB_PROGRESS, {
            channelId, jobId, requester: trigger.pubkey, content: chunk.text
          })
        }
      }
      const final = await run.final
      const content = (final?.content ?? text).trim()

      // Recorded BEFORE the reply: if the relay refuses the reply, what the
      // agent worked out still survives on the log instead of being lost with
      // the turn that produced it.
      if (final?.memo?.slug) await this._publish(events.engram(this.secretKey, final.memo))

      // A provider may redirect the reply at a third party — that is the whole
      // delegation mechanism. Absent, the reply answers whoever asked, as before.
      const mentions = Array.isArray(final?.mentions) && final.mentions.length > 0
        ? final.mentions
        : [trigger.pubkey]

      const reply = events.message(this.secretKey, {
        channel: channelId,
        content: content.length > 0 ? content : '(no response)',
        replyTo: trigger.id,
        mentions,
        extraTags: [hopTag]
      })
      await this._publish(reply)

      // Handing work to another agent is a job request, the same kind a human
      // client sends. The chat message above is what people read; this is the
      // machine-readable half of the same act.
      if (final?.delegate?.to) {
        await this._publish(events.jobRequest(this.secretKey, {
          channel: channelId,
          agent: final.delegate.to,
          prompt: final.delegate.prompt ?? content,
          jobId: reply.id,
          extraTags: [hopTag]
        }))
      }

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

  /**
   * Publish, and treat a refusal as a failure.
   *
   * `RelayConnection.publish` resolves with the relay's OK frame whether or not
   * it was accepted, so a rate-limited reply used to vanish while the turn went
   * on to emit a kind-43004 job result pointing at an event the relay never
   * stored — an audit log claiming work that does not exist. Measured: 80
   * publishes, 22 refused, 0 raised. A turn that could not say what it worked
   * out is a failed turn, and the catch in `turn()` records it as 43006.
   */
  async _publish (event) {
    const ok = await this.connection.publish(event)
    if (ok !== undefined && ok !== null && ok.accepted === false) {
      throw new Error(`relay refused kind ${event.kind}: ${ok.reason || 'no reason given'}`)
    }
    return ok
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
