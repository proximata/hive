'use strict'

const test = require('brittle')
const core = require('hive-core')
const { events } = require('hive-sdk')

const { openStore } = require('hive-store')
const { Relay, WebSocketTransport } = require('hive-relay')
const { WorkflowEngine, parseWorkflow, evaluate, WorkflowError, resolveTemplate } = require('hive-workflow')

const { TestClient } = require('./client')
const { identity, sign } = require('./helpers')

async function harness (t, engineOpts = {}) {
  const store = openStore(':memory:')
  const relay = new Relay(store, { url: 'ws://127.0.0.1' })
  const engine = new WorkflowEngine(relay, engineOpts)
  relay.workflowEngine = engine

  const transport = new WebSocketTransport(relay, { port: 0 })
  await transport.listen()

  const clients = []
  const member = async (who) => {
    const client = await TestClient.openWebSocket({ port: transport.port })
    await client.authenticate(who, { relayUrl: relay.url })
    clients.push(client)
    return client
  }

  t.teardown(async () => {
    for (const client of clients) await client.destroy()
    relay.close()
    await transport.close()
    store.close()
  })

  return { store, relay, engine, transport, member, port: transport.port }
}

async function channel (h, owner, client, name = 'ops') {
  await client.publish(events.createChannel(owner.secretKey, { name, visibility: 'open' }))
  const channels = h.store.listChannels()
  return channels[channels.length - 1].id
}

// ------------------------------------------------------------- definitions --

test('YAML and JSON definitions both parse', (t) => {
  const yaml = `
name: Incident Triage
trigger:
  on: message_posted
  filter: "str_contains(trigger_text, 'P1')"
steps:
  - id: notify
    action: send_message
    text: "P1 detected: {{trigger.text}}"
`
  const fromYaml = parseWorkflow(yaml)
  t.is(fromYaml.name, 'Incident Triage')
  t.is(fromYaml.trigger.on, 'message_posted')
  t.is(fromYaml.steps.length, 1)
  t.is(fromYaml.steps[0].id, 'notify')

  const fromJson = parseWorkflow(JSON.stringify(fromYaml))
  t.alike(fromJson, fromYaml)
})

test('definitions are validated', (t) => {
  const cases = [
    ['steps:\n  - action: send_message', 'requires a name'],
    ['name: x\ntrigger:\n  on: telepathy\nsteps:\n  - action: send_message', 'trigger.on must be'],
    ['name: x\ntrigger:\n  on: message_posted', 'at least one step'],
    ['name: x\ntrigger:\n  on: message_posted\nsteps:\n  - action: launch_missiles', 'unknown action'],
    ['name: x\ntrigger:\n  on: schedule\nsteps:\n  - action: send_message', 'requires a cron'],
    ['name: x\ntrigger:\n  on: message_posted\nsteps:\n  - id: "bad id"\n    action: send_message', 'only letters'],
    ['name: x\ntrigger:\n  on: message_posted\nsteps:\n  - id: a\n    action: delay\n    seconds: 9999', 'between 0 and 300'],
    ['name: x\ntrigger:\n  on: message_posted\nsteps:\n  - id: a\n    action: send_message\n  - id: a\n    action: send_message', 'duplicate step id']
  ]

  for (const [source, expected] of cases) {
    try {
      parseWorkflow(source)
      t.fail(`should have rejected: ${expected}`)
    } catch (err) {
      t.ok(err instanceof WorkflowError)
      t.ok(err.message.includes(expected), err.message)
    }
  }
})

// ------------------------------------------------------------- expressions --

test('the condition evaluator handles the documented grammar', (t) => {
  const context = { trigger_text: 'P1 production outage', trigger_author: 'abc', count: 5 }

  t.is(evaluate("str_contains(trigger_text, 'P1')", context), true)
  t.is(evaluate("str_contains(trigger_text, 'P2')", context), false)
  t.is(evaluate("str_starts_with(trigger_text, 'P1')", context), true)
  t.is(evaluate("str_ends_with(trigger_text, 'outage')", context), true)
  t.is(evaluate('str_len(trigger_text) > 5', context), true)
  t.is(evaluate("trigger_author == 'abc'", context), true)
  t.is(evaluate("trigger_author != 'abc'", context), false)
  t.is(evaluate('count >= 5 && count <= 10', context), true)
  t.is(evaluate("count > 10 || str_contains(trigger_text, 'production')", context), true)
  t.is(evaluate("!str_contains(trigger_text, 'P2')", context), true)
  t.is(evaluate("(count == 5) && (trigger_author == 'abc')", context), true)
  t.is(evaluate('', context), true, 'an empty condition is always true')
  t.is(evaluate(undefined, context), true)
})

test('dot notation folds to underscores, matching the template syntax', (t) => {
  t.is(evaluate("str_contains(trigger.text, 'P1')", { trigger_text: 'P1 outage' }), true)
})

test('unknown variables are empty rather than fatal', (t) => {
  t.is(evaluate("nothing == ''", {}), true)
  t.is(evaluate('str_len(nothing) == 0', {}), true)
})

test('the evaluator refuses code rather than running it', (t) => {
  // The whole point of hand-rolling this: a workflow definition is
  // user-supplied, so `eval` here would be remote code execution in the relay.
  for (const attack of [
    'process.exit(1)',
    'require("fs")',
    '(function(){return 1})()',
    'a["b"]',
    '1; process.exit()',
    'this.constructor.constructor("return 1")()'
  ]) {
    t.exception(() => evaluate(attack, {}), `refused: ${attack}`)
  }

  // A bare host identifier is not an error — it is simply an unknown variable,
  // which reads as empty. There is no path from a name to the host object.
  t.is(evaluate('globalThis', {}), false)
  t.is(evaluate("globalThis == ''", {}), true)
})

test('expression evaluation is time-bounded', (t) => {
  // A deeply nested expression must not be able to stall the pipeline.
  const deep = '(' .repeat(200) + 'true' + ')'.repeat(200)
  const started = Date.now()
  try {
    evaluate(deep, {}, { timeout: 20 })
  } catch {
    // Either it completes quickly or it times out; both are acceptable.
  }
  t.ok(Date.now() - started < 2000, 'bounded')
})

test('templates resolve in a single pass', (t) => {
  const context = { trigger: { text: 'hello', author: 'abc' }, steps: { notify: { output: { event: 'e1' } } } }

  t.is(resolveTemplate('Got: {{trigger.text}}', context), 'Got: hello')
  t.is(resolveTemplate('{{steps.notify.output.event}}', context), 'e1')
  t.is(resolveTemplate('{{unknown.path}}', context), '{{unknown.path}}', 'unknown variables stay literal')

  // Single pass: a message whose own text looks like a template is not
  // re-expanded, so it cannot reach into the context.
  const injected = { ...context, trigger: { text: '{{trigger.author}}', author: 'abc' } }
  t.is(resolveTemplate('{{trigger.text}}', injected), '{{trigger.author}}')
})

// -------------------------------------------------------------- execution --

test('a message trigger fires a send_message action', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('triage', parseWorkflow(`
name: Incident Triage
trigger:
  on: message_posted
  filter: "str_contains(trigger_text, 'P1')"
steps:
  - id: notify
    action: send_message
    text: "Paging on-call for: {{trigger.text}}"
`), { channelId })

  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'P1 database is down' }))
  await new Promise((resolve) => setTimeout(resolve, 200))

  const messages = h.store.queryEvents([{ kinds: [core.KIND_STREAM_MESSAGE], '#h': [channelId] }])
  const generated = messages.filter((m) => m.event.pubkey === h.relay.pubkey)

  t.is(generated.length, 1)
  t.is(generated[0].event.content, 'Paging on-call for: P1 database is down')
  t.is(core.tagValue(generated[0].event, 'buzz'), 'workflow', 'tagged so it cannot re-trigger workflows')
})

test('the trigger filter actually filters', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('triage', parseWorkflow(`
name: Triage
trigger:
  on: message_posted
  filter: "str_contains(trigger_text, 'P1')"
steps:
  - id: notify
    action: send_message
    text: "paged"
`), { channelId })

  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'lunch plans' }))
  await new Promise((resolve) => setTimeout(resolve, 200))

  t.is(h.engine.listRuns('triage').length, 0, 'a non-matching message starts no run')
})

test('workflow output does not trigger workflows', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  // A workflow whose own output would match its own trigger: without loop
  // prevention this runs forever.
  h.engine.register('echo', parseWorkflow(`
name: Echo
trigger:
  on: message_posted
  filter: "str_contains(trigger_text, 'ping')"
steps:
  - id: reply
    action: send_message
    text: "ping received"
`), { channelId })

  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'ping' }))
  await new Promise((resolve) => setTimeout(resolve, 300))

  t.is(h.engine.listRuns('echo').length, 1, 'exactly one run, not an infinite cascade')
})

test('conditional steps are skipped without failing the run', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('conditional', parseWorkflow(`
name: Conditional
trigger:
  on: message_posted
steps:
  - id: always
    action: send_message
    text: "first"
  - id: sometimes
    action: send_message
    text: "second"
    if: "str_contains(trigger_text, 'production')"
`), { channelId })

  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'staging blip' }))
  await new Promise((resolve) => setTimeout(resolve, 200))

  const run = h.engine.listRuns('conditional')[0]
  t.is(run.status, 'completed')
  t.is(run.trace.length, 2)
  t.is(run.trace[1].skipped, true)
})

test('set_channel_topic and send_dm are implemented, not stubs', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('onboard', parseWorkflow(`
name: Onboarding
trigger:
  on: message_posted
steps:
  - id: topic
    action: set_channel_topic
    text: "Topic set by workflow"
  - id: dm
    action: send_dm
    to: "${bob.pubkey}"
    text: "welcome aboard"
`), { channelId })

  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'go' }))
  await new Promise((resolve) => setTimeout(resolve, 300))

  const run = h.engine.listRuns('onboard')[0]
  t.is(run.status, 'completed', 'Buzz fails here (WF-07); this completes')
  t.is(h.store.getChannel(channelId).topic, 'Topic set by workflow')

  const dms = h.store.queryEvents([{ kinds: [core.KIND_GIFT_WRAP], '#p': [bob.pubkey] }])
  t.is(dms.length, 1)
  t.is(dms[0].event.content, 'welcome aboard')
})

test('add_reaction reacts to the triggering message', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('ack', parseWorkflow(`
name: Acknowledge
trigger:
  on: message_posted
steps:
  - id: react
    action: add_reaction
    emoji: "👀"
`), { channelId })

  const message = events.message(alice.secretKey, { channel: channelId, content: 'please review' })
  await client.publish(message)
  await new Promise((resolve) => setTimeout(resolve, 300))

  const reactions = h.store.queryEvents([{ kinds: [core.KIND_REACTION], '#e': [message.id] }])
  t.is(reactions.length, 1)
  t.is(reactions[0].event.content, '👀')
})

test('a failing step fails the run and records why', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('broken', parseWorkflow(`
name: Broken
trigger:
  on: message_posted
steps:
  - id: bad_dm
    action: send_dm
    to: "not-a-pubkey"
    text: "hello"
  - id: never_runs
    action: send_message
    text: "unreachable"
`), { channelId })

  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'go' }))
  await new Promise((resolve) => setTimeout(resolve, 300))

  const run = h.engine.listRuns('broken')[0]
  t.is(run.status, 'failed')
  t.ok(run.error.includes('hex pubkey'))

  const failures = h.store.queryEvents([{ kinds: [core.KIND_WORKFLOW_FAILED] }])
  t.is(failures.length, 1)
})

// -------------------------------------------------------------- approvals --

test('an approval gate suspends the run and a grant resumes it', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('gated', parseWorkflow(`
name: Gated Deploy
trigger:
  on: message_posted
steps:
  - id: ask
    action: request_approval
    from: "{{trigger.author}}"
    message: "Deploy to production?"
  - id: deploy
    action: send_message
    text: "deploying"
`), { channelId })

  const suspended = new Promise((resolve) => h.engine.once('suspended', resolve))
  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'ship it' }))

  const gate = await suspended
  t.ok(gate.token, 'a token was issued')

  const run = h.engine.getRun(gate.runId)
  t.is(run.status, 'waiting_approval', 'Buzz marks this failed (WF-08); this suspends')
  t.is(run.resumeStep, '1', 'and remembers where to continue')

  // The token is stored hashed, so database access is not approval authority.
  const stored = h.store.db.prepare('SELECT * FROM workflow_approvals').get()
  t.not(stored.token_hash, gate.token)
  t.is(stored.token_hash, core.toHex(core.sha256(Buffer.from(gate.token))))
  t.is(stored.status, 'pending')

  // No deploy message yet.
  let generated = h.store
    .queryEvents([{ kinds: [core.KIND_STREAM_MESSAGE], '#h': [channelId] }])
    .filter((m) => m.event.pubkey === h.relay.pubkey)
  t.is(generated.length, 0)

  // Approving resumes from the next step.
  const result = await h.engine.resolveApproval(gate.token, true, { approver: alice.pubkey })
  t.is(result.ok, true)
  t.is(result.resumed, true)

  generated = h.store
    .queryEvents([{ kinds: [core.KIND_STREAM_MESSAGE], '#h': [channelId] }])
    .filter((m) => m.event.pubkey === h.relay.pubkey)
  t.is(generated.length, 1)
  t.is(generated[0].event.content, 'deploying')

  t.is(h.engine.getRun(gate.runId).status, 'completed')
})

test('an approval token is single use', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('gated', parseWorkflow(`
name: Gated
trigger:
  on: message_posted
steps:
  - id: ask
    action: request_approval
    from: "{{trigger.author}}"
    message: "ok?"
  - id: go
    action: send_message
    text: "done"
`), { channelId })

  const suspended = new Promise((resolve) => h.engine.once('suspended', resolve))
  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'go' }))
  const gate = await suspended

  t.is((await h.engine.resolveApproval(gate.token, true)).ok, true)

  const replay = await h.engine.resolveApproval(gate.token, true)
  t.is(replay.ok, false)
  t.ok(replay.error.includes('already-resolved'), 'a replayed token is refused')

  const unknown = await h.engine.resolveApproval('made-up-token', true)
  t.is(unknown.ok, false)
})

test('denying an approval cancels the run', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('gated', parseWorkflow(`
name: Gated
trigger:
  on: message_posted
steps:
  - id: ask
    action: request_approval
    from: "{{trigger.author}}"
    message: "ok?"
  - id: go
    action: send_message
    text: "should never appear"
`), { channelId })

  const suspended = new Promise((resolve) => h.engine.once('suspended', resolve))
  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'go' }))
  const gate = await suspended

  const result = await h.engine.resolveApproval(gate.token, false, { note: 'needs revision' })
  t.is(result.ok, true)
  t.is(result.resumed, false)
  t.is(h.engine.getRun(gate.runId).status, 'cancelled')

  const generated = h.store
    .queryEvents([{ kinds: [core.KIND_STREAM_MESSAGE], '#h': [channelId] }])
    .filter((m) => m.event.pubkey === h.relay.pubkey)
  t.is(generated.length, 0)

  const denials = h.store.queryEvents([{ kinds: [core.KIND_WORKFLOW_APPROVAL_DENIED] }])
  t.is(denials.length, 1)
})

test('an expired approval cannot be granted', async (t) => {
  let now = 1_700_000_000_000
  const h = await harness(t, { clock: () => now })

  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('gated', parseWorkflow(`
name: Gated
trigger:
  on: message_posted
steps:
  - id: ask
    action: request_approval
    from: "{{trigger.author}}"
    message: "ok?"
    timeout: 60
  - id: go
    action: send_message
    text: "done"
`), { channelId })

  const suspended = new Promise((resolve) => h.engine.once('suspended', resolve))
  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'go' }))
  const gate = await suspended

  now += 120_000 // past the 60-second timeout

  const result = await h.engine.resolveApproval(gate.token, true)
  t.is(result.ok, false)
  t.ok(result.error.includes('expired'))
})

test('an approval published as an event resumes the run end to end', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('gated', parseWorkflow(`
name: Gated
trigger:
  on: message_posted
steps:
  - id: ask
    action: request_approval
    from: "{{trigger.author}}"
    message: "ok?"
  - id: go
    action: send_message
    text: "approved and shipped"
`), { channelId })

  const suspended = new Promise((resolve) => h.engine.once('suspended', resolve))
  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'go' }))
  const gate = await suspended

  // The whole loop through the protocol: an approval is just a signed event.
  const resumed = new Promise((resolve) => h.engine.once('resumed', resolve))
  await client.publish(events.approval(alice.secretKey, { token: gate.token, approved: true }))
  await resumed

  const generated = h.store
    .queryEvents([{ kinds: [core.KIND_STREAM_MESSAGE], '#h': [channelId] }])
    .filter((m) => m.event.pubkey === h.relay.pubkey)
  t.is(generated.length, 1)
  t.is(generated[0].event.content, 'approved and shipped')
})

// --------------------------------------------------------------- webhooks --

test('call_webhook refuses private addresses', async (t) => {
  const calls = []
  const h = await harness(t, {
    fetch: async (url) => {
      calls.push(url)
      return { status: 200 }
    }
  })

  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('ssrf', parseWorkflow(`
name: SSRF
trigger:
  on: message_posted
steps:
  - id: call
    action: call_webhook
    url: "http://169.254.169.254/latest/meta-data/"
`), { channelId })

  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'go' }))
  await new Promise((resolve) => setTimeout(resolve, 300))

  t.is(calls.length, 0, 'the cloud metadata endpoint was never dialled')

  const run = h.engine.listRuns('ssrf')[0]
  t.is(run.status, 'failed')
  t.ok(run.error.includes('private address'))
})

test('call_webhook posts to a public address', async (t) => {
  const calls = []
  const h = await harness(t, {
    fetch: async (url, opts) => {
      calls.push({ url, opts })
      return { status: 202 }
    }
  })

  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('notify', parseWorkflow(`
name: Notify
trigger:
  on: message_posted
steps:
  - id: call
    action: call_webhook
    url: "https://example.com/hook"
    body: '{"text":"{{trigger.text}}"}'
`), { channelId })

  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'deployed' }))
  await new Promise((resolve) => setTimeout(resolve, 300))

  t.is(calls.length, 1)
  t.is(calls[0].url, 'https://example.com/hook')
  t.is(calls[0].opts.body, '{"text":"deployed"}', 'the template was resolved')
  t.is(h.engine.listRuns('notify')[0].status, 'completed')
})

test('the webhook trigger checks its secret', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('hooked', parseWorkflow(`
name: Hooked
trigger:
  on: webhook
steps:
  - id: notify
    action: send_message
    text: "webhook fired"
`), { channelId })

  h.store.db.prepare('UPDATE workflows SET webhook_secret = ? WHERE id = ?').run('s3cret', 'hooked')

  t.is((await h.engine.onWebhook('hooked', 'wrong', {})).ok, false)
  t.is((await h.engine.onWebhook('hooked', null, {})).ok, false)
  t.is((await h.engine.onWebhook('missing', 's3cret', {})).ok, false)

  const ok = await h.engine.onWebhook('hooked', 's3cret', { source: 'ci' })
  t.is(ok.ok, true)

  const generated = h.store
    .queryEvents([{ kinds: [core.KIND_STREAM_MESSAGE], '#h': [channelId] }])
    .filter((m) => m.event.pubkey === h.relay.pubkey)
  t.is(generated.length, 1)
})

// --------------------------------------------------------------- capacity --

test('the engine rejects rather than queues when saturated', async (t) => {
  const h = await harness(t, { maxConcurrent: 0 })
  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  h.engine.register('busy', parseWorkflow(`
name: Busy
trigger:
  on: message_posted
steps:
  - id: notify
    action: send_message
    text: "should not run"
`), { channelId })

  const rejected = new Promise((resolve) => h.engine.once('capacity-exceeded', resolve))
  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'go' }))

  t.is(await rejected, 'busy')
  t.is(h.engine.listRuns('busy').length, 0, 'no run was queued for later')
})

// ---------------------------------------------------- definitions as events --

test('a workflow published as kind 30620 registers itself', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await h.member(alice)
  const channelId = await channel(h, alice, client)

  const definition = parseWorkflow(`
name: Published
trigger:
  on: message_posted
steps:
  - id: notify
    action: send_message
    text: "from a published workflow"
`)

  await client.publish(events.workflowDefinition(alice.secretKey, {
    id: 'published',
    channel: channelId,
    name: definition.name,
    definition
  }))
  await new Promise((resolve) => setTimeout(resolve, 200))

  t.ok(h.engine.workflows.has('published'), 'the relay handed the definition to the engine')

  await client.publish(events.message(alice.secretKey, { channel: channelId, content: 'trigger me' }))
  await new Promise((resolve) => setTimeout(resolve, 300))

  const generated = h.store
    .queryEvents([{ kinds: [core.KIND_STREAM_MESSAGE], '#h': [channelId] }])
    .filter((m) => m.event.pubkey === h.relay.pubkey)
  t.is(generated.length, 1)
  t.is(generated[0].event.content, 'from a published workflow')
})

// ------------------------------------------------- git and huddle stubs --

test('NIP-34 git events are stored and queryable', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const client = await h.member(alice)

  const repo = events.repoAnnouncement(alice.secretKey, {
    id: 'hive',
    name: 'Hive',
    description: 'the relay',
    clone: ['https://example.com/hive.git']
  })
  t.is((await client.publish(repo)).accepted, true)

  const patch = events.patch(alice.secretKey, {
    repo: 'hive',
    diff: '--- a/x\n+++ b/x\n',
    commit: 'abc123'
  })
  t.is((await client.publish(patch)).accepted, true)

  const issue = sign(alice, {
    kind: core.KIND_GIT_ISSUE,
    tags: [['a', `30617:hive`]],
    content: 'the relay drops frames over 64k'
  })
  t.is((await client.publish(issue)).accepted, true)

  t.is(h.store.queryEvents([{ kinds: [core.KIND_GIT_REPO_ANNOUNCEMENT] }]).length, 1)
  t.is(h.store.queryEvents([{ kinds: [core.KIND_GIT_PATCH] }]).length, 1)
  t.is(h.store.queryEvents([{ kinds: [core.KIND_GIT_ISSUE] }]).length, 1)

  // Searchable like any other content, which is most of the value of the
  // event surface even without hosting.
  t.is(h.store.search('frames').length, 1)
})

test('huddle lifecycle events are recorded even though audio is not built', async (t) => {
  const h = await harness(t)
  const alice = identity('alice')
  const bob = identity('bob')

  const aliceClient = await h.member(alice)
  const bobClient = await h.member(bob)
  const channelId = await channel(h, alice, aliceClient, 'standup')
  await bobClient.publish(events.joinChannel(bob.secretKey, { channel: channelId }))

  const lifecycle = [
    [alice, core.KIND_HUDDLE_STARTED],
    [alice, core.KIND_HUDDLE_PARTICIPANT_JOINED],
    [bob, core.KIND_HUDDLE_PARTICIPANT_JOINED],
    [bob, core.KIND_HUDDLE_PARTICIPANT_LEFT],
    [alice, core.KIND_HUDDLE_ENDED]
  ]

  for (const [who, kind] of lifecycle) {
    const client = who === alice ? aliceClient : bobClient
    const ok = await client.publish(events.huddleEvent(who.secretKey, kind, { channel: channelId }))
    t.is(ok.accepted, true, `kind ${kind} accepted`)
  }

  const recorded = h.store.queryEvents([{
    kinds: [
      core.KIND_HUDDLE_STARTED,
      core.KIND_HUDDLE_PARTICIPANT_JOINED,
      core.KIND_HUDDLE_PARTICIPANT_LEFT,
      core.KIND_HUDDLE_ENDED
    ],
    '#h': [channelId]
  }])
  t.is(recorded.length, 5, 'the whole huddle is on the audit log')

  // But the audio endpoint is honest about not existing.
  const { request } = require('./http')
  const response = await request(`http://127.0.0.1:${h.port}/huddle/${channelId}/audio`)
  t.is(response.status, 501)
})
