'use strict'

const EventEmitter = require('bare-events')

const core = require('hive-core')

const { parseWorkflow, resolveTemplate, flattenContext, WorkflowError } = require('./definition')
const { evaluate } = require('./expression')

const MAX_CONCURRENT_RUNS = 100
const APPROVAL_TIMEOUT_S = 24 * 60 * 60

/**
 * YAML-as-code automation.
 *
 * Buzz leaves two things open here (WF-07 and WF-08): `send_dm` and
 * `set_channel_topic` return NotImplemented, and a run that hits an approval
 * gate is marked failed because the token is never persisted. Both are
 * implemented here — an approval gate suspends the run, stores a hashed
 * single-use token, and `resume()` continues from the next step.
 */
class WorkflowEngine extends EventEmitter {
  constructor (relay, opts = {}) {
    super()

    this.relay = relay
    this.store = relay.store
    this.maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_RUNS
    this.running = 0
    this.clock = opts.clock ?? (() => Date.now())
    this.fetch = opts.fetch ?? defaultFetch
    this.workflows = new Map() // id -> { definition, channelId, author }
  }

  // ------------------------------------------------------------ definition --

  /** Register a definition (from a kind 30620 event or directly). */
  register (id, definition, { channelId = null, author = null } = {}) {
    const parsed = typeof definition === 'object' && definition.steps !== undefined
      ? definition
      : parseWorkflow(definition)

    this.workflows.set(id, { definition: parsed, channelId, author })

    this.store.db
      .prepare(
        'INSERT INTO workflows (id, channel_id, name, definition, status, created_by, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET ' +
        'definition = excluded.definition, name = excluded.name, updated_at = excluded.updated_at'
      )
      .run(
        id, channelId, parsed.name, JSON.stringify(parsed), 'active',
        author ?? '', Math.floor(this.clock() / 1000), Math.floor(this.clock() / 1000)
      )

    this.emit('registered', id, parsed)
    return parsed
  }

  /** Load a definition published as a kind 30620 event. */
  registerFromEvent (event) {
    const id = core.dTag(event)
    if (id === '') throw new WorkflowError('workflow definitions require a d tag')

    return this.register(id, JSON.parse(event.content), {
      channelId: core.channelId(event),
      author: event.pubkey
    })
  }

  // --------------------------------------------------------------- triggers --

  /** Called by the relay for every stored event (loop-prevented upstream). */
  async onEvent (event, { channelId } = {}) {
    if (event.kind === core.KIND_WORKFLOW_DEF) {
      try {
        this.registerFromEvent(event)
      } catch (err) {
        this.emit('error', err)
      }
      return
    }

    // An approval grant or denial resumes a suspended run rather than starting
    // a new one.
    if (event.kind === core.KIND_APPROVAL_GRANT || event.kind === core.KIND_APPROVAL_DENY) {
      return this.resolveApproval(
        core.tagValue(event, 'token'),
        event.kind === core.KIND_APPROVAL_GRANT,
        { approver: event.pubkey, note: event.content }
      )
    }

    if (event.kind === core.KIND_WORKFLOW_TRIGGER) {
      const id = core.dTag(event)
      if (this.workflows.has(id)) return this.start(id, { manual: true, author: event.pubkey }, channelId)
      return null
    }

    const triggerType = event.kind === core.KIND_REACTION ? 'reaction_added' : 'message_posted'
    const isMessage = event.kind === core.KIND_STREAM_MESSAGE || event.kind === core.KIND_STREAM_MESSAGE_V2

    if (triggerType === 'message_posted' && !isMessage) return null

    for (const [id, entry] of this.workflows) {
      const { definition, channelId: scope } = entry
      if (definition.trigger.on !== triggerType) continue
      if (scope !== null && scope !== channelId) continue

      const context = this.#triggerContext(event, channelId)
      try {
        if (!evaluate(definition.trigger.filter, flattenContext(context))) continue
      } catch (err) {
        this.emit('error', err)
        continue
      }

      await this.start(id, context, channelId ?? scope)
    }

    return null
  }

  /** Webhook trigger. The secret is compared in constant time. */
  async onWebhook (id, secret, body) {
    const row = this.store.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
    if (row === undefined) return { ok: false, error: 'not_found' }

    const expected = row.webhook_secret ?? ''
    if (expected === '' || !constantTimeEqual(expected, secret ?? '')) {
      return { ok: false, error: 'forbidden' }
    }

    const context = { trigger: { type: 'webhook', body: body ?? {} } }
    const run = await this.start(id, context, row.channel_id)
    return { ok: true, run: run?.id ?? null }
  }

  #triggerContext (event, channelId) {
    return {
      trigger: {
        type: event.kind === core.KIND_REACTION ? 'reaction_added' : 'message_posted',
        text: event.content,
        author: event.pubkey,
        event: event.id,
        channel: channelId ?? '',
        kind: event.kind
      }
    }
  }

  // ------------------------------------------------------------- execution --

  async start (workflowId, context = {}, channelId = null) {
    const entry = this.workflows.get(workflowId)
    if (entry === undefined) return null

    // Reject rather than queue when saturated: an unbounded queue turns a burst
    // into an outage that outlives the burst.
    if (this.running >= this.maxConcurrent) {
      this.emit('capacity-exceeded', workflowId)
      return null
    }

    const runId = core.toHex(core.sha256(Buffer.from(`${workflowId}:${this.clock()}:${Math.random()}`))).slice(0, 32)
    const now = Math.floor(this.clock() / 1000)

    this.store.db
      .prepare(
        'INSERT INTO workflow_runs (id, workflow_id, status, trigger, trace, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(runId, workflowId, 'running', JSON.stringify(context), '[]', now, now)

    await this.#emitEvent(core.KIND_WORKFLOW_TRIGGERED, { runId, workflowId, channelId })

    this.running++
    try {
      return await this.#execute(runId, entry, context, channelId, 0)
    } finally {
      this.running--
    }
  }

  async #execute (runId, entry, context, channelId, fromStep) {
    const { definition } = entry
    const trace = []

    for (let index = fromStep; index < definition.steps.length; index++) {
      const step = definition.steps[index]

      try {
        if (!evaluate(step.if, flattenContext(context))) {
          trace.push({ step: step.id, skipped: true })
          continue
        }
      } catch (err) {
        return this.#failRun(runId, channelId, step.id, `condition error: ${err.message}`)
      }

      await this.#emitEvent(core.KIND_WORKFLOW_STEP_STARTED, { runId, stepId: step.id, channelId })

      let result
      try {
        result = await this.#runStep(step, context, channelId, entry)
      } catch (err) {
        await this.#emitEvent(core.KIND_WORKFLOW_STEP_FAILED, { runId, stepId: step.id, channelId, content: err.message })
        return this.#failRun(runId, channelId, step.id, err.message)
      }

      if (result?.suspended === true) {
        // Approval gate: persist the hashed token and where to resume, then
        // stop. This is the piece Buzz leaves unfinished (WF-08) — without it
        // the run is marked failed and the approval has nothing to resume.
        this.createApproval({
          runId,
          stepId: step.id,
          token: result.token,
          approver: result.approver,
          message: result.message,
          timeout: Number(step.timeout ?? APPROVAL_TIMEOUT_S)
        })

        this.store.db
          .prepare("UPDATE workflow_runs SET status = 'waiting_approval', resume_step = ?, trace = ?, updated_at = ? WHERE id = ?")
          .run(String(index + 1), JSON.stringify(trace), Math.floor(this.clock() / 1000), runId)

        await this.#emitEvent(core.KIND_WORKFLOW_APPROVAL_REQUESTED, {
          runId, stepId: step.id, channelId, content: result.token
        })

        this.emit('suspended', { runId, stepId: step.id, token: result.token })
        return { id: runId, status: 'waiting_approval', token: result.token }
      }

      context.steps = context.steps ?? {}
      context.steps[step.id] = { output: result?.output ?? {} }
      trace.push({ step: step.id, output: result?.output ?? {} })

      await this.#emitEvent(core.KIND_WORKFLOW_STEP_COMPLETED, { runId, stepId: step.id, channelId })
    }

    this.store.db
      .prepare("UPDATE workflow_runs SET status = 'completed', trace = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(trace), Math.floor(this.clock() / 1000), runId)

    await this.#emitEvent(core.KIND_WORKFLOW_COMPLETED, { runId, channelId })
    this.emit('completed', { runId })
    return { id: runId, status: 'completed' }
  }

  async #failRun (runId, channelId, stepId, message) {
    this.store.db
      .prepare("UPDATE workflow_runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(message, Math.floor(this.clock() / 1000), runId)

    await this.#emitEvent(core.KIND_WORKFLOW_FAILED, { runId, stepId, channelId, content: message })
    this.emit('failed', { runId, stepId, message })
    return { id: runId, status: 'failed', error: message }
  }

  // ----------------------------------------------------------------- steps --

  async #runStep (step, context, channelId, entry) {
    const flat = flattenContext(context)
    const text = resolveTemplate(step.text ?? step.message ?? '', context)

    switch (step.action) {
      case 'send_message': {
        const target = resolveTemplate(step.channel ?? channelId ?? '', context)
        if (target === '') throw new Error('send_message has no channel to post to')

        const event = this.#signAsRelay(core.KIND_STREAM_MESSAGE, [['h', target], ['buzz', 'workflow']], text)
        this.store.insertEvent(event, { channelId: target })
        this.relay.broadcast(event, target)
        return { output: { event: event.id, channel: target } }
      }

      case 'send_dm': {
        // Implemented rather than stubbed (Buzz WF-07).
        const to = resolveTemplate(step.to ?? step.pubkey ?? '', context)
        if (!/^[0-9a-f]{64}$/.test(to)) throw new Error(`send_dm needs a hex pubkey, got "${to}"`)

        const event = this.#signAsRelay(core.KIND_GIFT_WRAP, [['p', to], ['buzz', 'workflow']], text)
        this.store.insertEvent(event, { channelId: null })
        this.relay.broadcast(event, null)
        return { output: { event: event.id, to } }
      }

      case 'set_channel_topic': {
        // Implemented rather than stubbed (Buzz WF-07).
        const target = resolveTemplate(step.channel ?? channelId ?? '', context)
        if (target === '') throw new Error('set_channel_topic has no channel')

        this.store.updateChannel(target, { topic: text })
        return { output: { channel: target, topic: text } }
      }

      case 'add_reaction': {
        const targetEvent = resolveTemplate(step.event ?? flat.trigger_event ?? '', context)
        if (!/^[0-9a-f]{64}$/.test(targetEvent)) throw new Error('add_reaction needs a target event id')

        const stored = this.store.getStoredEvent(targetEvent)
        if (stored === null) throw new Error('add_reaction target not found')

        const event = this.#signAsRelay(core.KIND_REACTION, [['e', targetEvent], ['buzz', 'workflow']], step.emoji ?? '+')
        this.store.insertEvent(event, { channelId: stored.channelId })
        this.relay.broadcast(event, stored.channelId)
        return { output: { event: event.id } }
      }

      case 'call_webhook': {
        const url = resolveTemplate(step.url, context)
        return { output: await this.#callWebhook(url, step, context) }
      }

      case 'request_approval': {
        const approver = resolveTemplate(step.from, context)
        const token = core.toHex(core.sha256(Buffer.from(`approval:${this.clock()}:${Math.random()}`))).slice(0, 32)
        return { suspended: true, token, approver, message: text }
      }

      case 'delay': {
        const seconds = Number(step.seconds ?? 0)
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
        return { output: { delayed: seconds } }
      }
    }

    throw new Error(`unknown action "${step.action}"`)
  }

  async #callWebhook (url, step, context) {
    let target
    try {
      target = new URL(url)
    } catch {
      throw new Error(`call_webhook has an invalid url: ${url}`)
    }

    // A workflow definition is user-supplied, so its webhook destination is a
    // request-forgery primitive unless it is checked against every internal
    // range. Hostnames are resolved by the caller-supplied fetch, which must
    // re-check the resolved address.
    if (core.isPrivateIp(target.hostname)) {
      throw new Error(`call_webhook refused: ${target.hostname} is a private address`)
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error('call_webhook only supports http and https')
    }

    const body = resolveTemplate(
      typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? context),
      context
    )

    return this.fetch(target.href, {
      method: step.method ?? 'POST',
      body,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  #signAsRelay (kind, tags, content) {
    // The `buzz: workflow` tag is what keeps workflow output from re-triggering
    // workflows — without it, a workflow that posts a message can trigger
    // itself forever.
    return this.relay.signAsRelay({ kind, tags, content })
  }

  async #emitEvent (kind, { runId, workflowId = null, stepId = null, channelId = null, content = '' }) {
    const tags = [['d', runId], ['buzz', 'workflow']]
    if (workflowId !== null) tags.push(['workflow', workflowId])
    if (stepId !== null) tags.push(['step', stepId])
    if (channelId !== null) tags.push(['h', channelId])

    const event = this.relay.signAsRelay({ kind, tags, content })
    this.store.insertEvent(event, { channelId })
    this.relay.broadcast(event, channelId)
    return event
  }

  // -------------------------------------------------------------- approvals --

  /** Record an approval gate so a grant or denial can resume the run. */
  createApproval ({ runId, stepId, token, approver, message, timeout = APPROVAL_TIMEOUT_S }) {
    const now = Math.floor(this.clock() / 1000)

    this.store.db
      .prepare(
        'INSERT INTO workflow_approvals (id, run_id, step_id, token_hash, approver, message, status, expires_at, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        token.slice(0, 16), runId, stepId,
        // Stored hashed: a database reader must not be able to approve.
        core.toHex(core.sha256(Buffer.from(token))),
        approver, message, 'pending', now + timeout, now
      )
  }

  /**
   * Grant or deny. Single-use is enforced in the UPDATE itself
   * (`AND status = 'pending'`), so two concurrent approvals cannot both win.
   */
  async resolveApproval (token, approved, { approver = '', note = '' } = {}) {
    if (typeof token !== 'string' || token.length === 0) return { ok: false, error: 'missing token' }

    const hash = core.toHex(core.sha256(Buffer.from(token)))
    const row = this.store.db
      .prepare("SELECT * FROM workflow_approvals WHERE token_hash = ? AND status = 'pending'")
      .get(hash)

    if (row === undefined) return { ok: false, error: 'unknown or already-resolved token' }

    const now = Math.floor(this.clock() / 1000)
    if (row.expires_at !== null && row.expires_at < now) {
      this.store.db.prepare("UPDATE workflow_approvals SET status = 'expired' WHERE id = ?").run(row.id)
      return { ok: false, error: 'approval expired' }
    }

    const updated = this.store.db
      .prepare("UPDATE workflow_approvals SET status = ?, note = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(approved ? 'granted' : 'denied', note, now, row.id)

    if (updated.changes === 0) return { ok: false, error: 'already resolved' }

    const run = this.store.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(row.run_id)
    if (run === undefined) return { ok: false, error: 'run not found' }

    const entry = this.workflows.get(run.workflow_id)
    const channelId = entry?.channelId ?? null

    await this.#emitEvent(
      approved ? core.KIND_WORKFLOW_APPROVAL_GRANTED : core.KIND_WORKFLOW_APPROVAL_DENIED,
      { runId: run.id, stepId: row.step_id, channelId, content: approver }
    )

    if (!approved) {
      this.store.db
        .prepare("UPDATE workflow_runs SET status = 'cancelled', updated_at = ? WHERE id = ?")
        .run(now, run.id)
      await this.#emitEvent(core.KIND_WORKFLOW_CANCELLED, { runId: run.id, channelId })
      this.emit('denied', { runId: run.id })
      return { ok: true, resumed: false }
    }

    if (entry === undefined) return { ok: false, error: 'workflow definition not loaded' }

    const context = JSON.parse(run.trigger)
    const result = await this.#execute(run.id, entry, context, channelId, Number(run.resume_step ?? 0))
    this.emit('resumed', { runId: run.id })
    return { ok: true, resumed: true, result }
  }

  getRun (runId) {
    const row = this.store.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId)
    if (row === undefined) return null
    return {
      id: row.id,
      workflowId: row.workflow_id,
      status: row.status,
      trigger: JSON.parse(row.trigger),
      trace: JSON.parse(row.trace),
      error: row.error,
      resumeStep: row.resume_step
    }
  }

  listRuns (workflowId, limit = 50) {
    const rows = workflowId === undefined || workflowId === null
      ? this.store.db.prepare('SELECT id FROM workflow_runs ORDER BY created_at DESC LIMIT ?').all(limit)
      : this.store.db
        .prepare('SELECT id FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(workflowId, limit)

    return rows.map((row) => this.getRun(row.id))
  }
}

function constantTimeEqual (a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function defaultFetch () {
  throw new Error('no webhook transport configured; pass a fetch implementation to WorkflowEngine')
}

module.exports = { WorkflowEngine, MAX_CONCURRENT_RUNS, APPROVAL_TIMEOUT_S, constantTimeEqual }
