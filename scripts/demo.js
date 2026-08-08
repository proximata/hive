'use strict'

// End-to-end demo: a human and an agent share a workspace.
//
// Everything here goes through the same interfaces a user would touch — the
// CLI for the human, the agent harness for the agent, and the relay for both.
// If this passes, the product works.

const os = require('bare-os')
const path = require('bare-path')
const fs = require('bare-fs')

const core = require('hive-core')
const { events } = require('hive-sdk')
const { openStore } = require('hive-store')
const { Relay, WebSocketTransport, SwarmTransport, MediaStore } = require('hive-relay')
const { WorkflowEngine, parseWorkflow } = require('hive-workflow')
const { Agent, MockProvider, RelayConnection } = require('hive-agent')
const { run } = require('hive-cli')

const DHT = require('hyperdht')
const createTestnet = require('hyperdht/testnet')

let step = 0
let failures = 0

function say (message) {
  console.log(`\n\x1b[1m${++step}. ${message}\x1b[0m`)
}

function check (label, condition, detail = '') {
  if (condition) {
    console.log(`   \x1b[32m✓\x1b[0m ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    failures++
    console.log(`   \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`)
  }
}

function identity () {
  const secretKey = core.generateSecretKey()
  return { secretKey, secretKeyHex: core.toHex(secretKey), pubkey: core.getPublicKey(secretKey) }
}

async function main () {
  const dir = path.join(os.tmpdir(), `hive-demo-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })

  const testnet = await createTestnet(3)
  const store = openStore(path.join(dir, 'hive.db'))
  const relay = new Relay(store, { url: 'ws://127.0.0.1' })
  relay.workflowEngine = new WorkflowEngine(relay)

  const transport = new WebSocketTransport(relay, { port: 0, mediaStore: new MediaStore(path.join(dir, 'media')) })
  await transport.listen()

  const swarm = new SwarmTransport(relay, { dht: new DHT({ bootstrap: testnet.bootstrap }) })
  await swarm.listen()

  const url = `http://127.0.0.1:${transport.port}`
  const alice = identity()
  const bot = identity()

  const cli = async (who, argv, stdin = null) => {
    const result = await run(argv, {
      env: { HIVE_RELAY_URL: url, HIVE_PRIVATE_KEY: who.secretKeyHex },
      readStdin: async () => stdin
    })
    if (result.exitCode !== 0) {
      throw new Error(`hive ${argv.join(' ')} → exit ${result.exitCode}: ${result.stderr}`)
    }
    return JSON.parse(result.stdout)
  }

  let agent = null

  try {
    // ------------------------------------------------------------------ 1 --
    say('The relay is up and describes itself over NIP-11')
    const { request } = require('../test/http')
    const info = (await request(`${url}/`, { headers: { Accept: 'application/nostr+json' } })).json
    check('NIP-11 document served', info.name === 'hive', `${info.supported_nips.length} NIPs advertised`)
    check('reachable peer-to-peer', swarm.link.startsWith('hyper://'), swarm.link)

    // ------------------------------------------------------------------ 2 --
    say('Alice opens a channel with the CLI')
    const channel = await cli(alice, ['channels', 'create', '--name', 'engineering', '--visibility', 'open'])
    check('channel created', typeof channel.id === 'string', channel.id)
    check('Alice is its owner',
      (await cli(alice, ['channels', 'members', '--channel', channel.id]))[0].role === 'owner')

    // ------------------------------------------------------------------ 3 --
    say('An agent is defined by a persona and joins the channel')
    const persona = {
      slug: 'honey',
      display_name: 'Honey',
      system_prompt: 'You summarize incidents for the engineering channel.',
      runtime: 'mock',
      model: 'mock-1'
    }

    await cli(alice, [
      'channels', 'add-member', '--channel', channel.id, '--pubkey', bot.pubkey, '--role', 'bot'
    ])

    const connection = new RelayConnection({ url: `ws://127.0.0.1:${transport.port}`, secretKey: bot.secretKey, reconnect: false })
    await connection.connect()

    agent = new Agent({
      secretKey: bot.secretKey,
      owner: alice.pubkey,
      persona,
      provider: new MockProvider({ systemPrompt: persona.system_prompt }),
      connection
    })
    await agent.start()
    await new Promise((resolve) => setTimeout(resolve, 300))

    const profiles = store.queryEvents([{ kinds: [core.KIND_AGENT_PROFILE], authors: [bot.pubkey] }])
    const capabilities = JSON.parse(profiles[0].event.content).capabilities
    check('agent published its capabilities', capabilities.includes('text-generation'), capabilities.join(', '))
    check('agent is watching the channel', agent.channels.has(channel.id))

    // ------------------------------------------------------------------ 4 --
    say('Alice mentions the agent; the agent answers')
    const replied = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the agent did not reply in time')), 8000)
      agent.once('reply', (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
    })

    const mention = await cli(alice, [
      'messages', 'send', '--channel', channel.id,
      '--content', 'can you summarize the incident?', '--mention', bot.pubkey
    ])
    const reply = await replied

    check('the agent replied', reply.pubkey === bot.pubkey)
    check('the reply is a signed event', core.verifyEvent(reply).ok === true)
    check('it is threaded under the question', core.referencedEvents(reply).includes(mention.id))

    const thread = await cli(alice, ['messages', 'thread', '--event', mention.id])
    check('the thread shows both turns', thread.replies.length === 1, `root + ${thread.replies.length} reply`)

    // ------------------------------------------------------------------ 5 --
    say('A workflow with an approval gate runs, suspends, and resumes')
    relay.workflowEngine.register('deploy', parseWorkflow(`
name: Guarded Deploy
trigger:
  on: message_posted
  filter: "str_contains(trigger_text, 'deploy')"
steps:
  - id: ask
    action: request_approval
    from: "{{trigger.author}}"
    message: "Deploy to production?"
  - id: announce
    action: send_message
    text: "Deploying, approved by {{trigger.author}}"
`), { channelId: channel.id })

    const suspended = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the workflow never suspended')), 8000)
      relay.workflowEngine.once('suspended', (gate) => {
        clearTimeout(timer)
        resolve(gate)
      })
    })

    await cli(alice, ['messages', 'send', '--channel', channel.id, '--content', 'please deploy v2'])
    const gate = await suspended

    check('the run is waiting for approval',
      relay.workflowEngine.getRun(gate.runId).status === 'waiting_approval')
    check('the token is stored hashed, not in the clear',
      store.db.prepare('SELECT token_hash FROM workflow_approvals').get().token_hash !== gate.token)

    const resumed = new Promise((resolve) => relay.workflowEngine.once('resumed', resolve))
    await cli(alice, ['workflows', 'approve', '--token', gate.token])
    await resumed

    const announced = store
      .queryEvents([{ kinds: [core.KIND_STREAM_MESSAGE], '#h': [channel.id] }])
      .filter((m) => m.event.pubkey === relay.pubkey)
    check('the gated step ran after approval', announced.length === 1, announced[0]?.event.content)
    check('and the run completed', relay.workflowEngine.getRun(gate.runId).status === 'completed')

    // ------------------------------------------------------------------ 6 --
    say('A second peer reaches the relay over the DHT, with no ports or DNS')
    const { TestClient } = require('../test/client')
    const peer = await TestClient.openSwarm({ publicKey: swarm.publicKey, bootstrap: testnet.bootstrap })
    await peer.authenticate(alice, { relayUrl: swarm.link })

    const history = await peer.subscribe('sync', { '#h': [channel.id], kinds: [core.KIND_STREAM_MESSAGE] })
    check('the peer authenticated over Hyperswarm', history.closed === null)
    check('and read the channel history', history.events.length >= 3, `${history.events.length} messages`)
    await peer.destroy()

    // ------------------------------------------------------------------ 7 --
    say('Search, media and the canvas work')
    const found = await cli(alice, ['messages', 'search', '--query', 'incident'])
    check('full-text search finds the message', found.length >= 1, `${found.length} hit(s)`)

    const file = path.join(dir, 'notes.txt')
    fs.writeFileSync(file, 'postmortem notes')
    const upload = await cli(alice, ['upload', 'file', '--path', file])
    check('media is content-addressed',
      upload.sha256 === core.toHex(core.sha256(Buffer.from('postmortem notes'))))

    await cli(alice, ['canvas', 'set', '--channel', channel.id, '--content', '# Runbook'])
    check('the canvas round-trips',
      (await cli(alice, ['canvas', 'get', '--channel', channel.id])).content === '# Runbook')

    // ------------------------------------------------------------------ 8 --
    say('The audit chain covers everything and detects tampering')
    const verification = await cli(alice, ['audit', 'verify'])
    check('the chain verifies', verification.ok === true, `${verification.entries} entries`)

    const actions = new Set((await cli(alice, ['audit', 'list', '--limit', '100'])).map((e) => e.action))
    check('it records auth, channels, membership and events',
      ['AuthSuccess', 'ChannelCreated', 'MemberAdded', 'EventCreated'].every((a) => actions.has(a)),
      [...actions].join(', '))

    store.db.prepare("UPDATE audit_log SET actor = 'tampered' WHERE seq = 2").run()
    const broken = await cli(alice, ['audit', 'verify'])
    check('and a single edited row breaks it', broken.ok === false, `detected at entry ${broken.brokenAt}`)

    // ------------------------------------------------------------------ 9 --
    say('The CLI honours its error contract')
    const bad = await run(['messages', 'get', '--channel', 'not-a-uuid'], {
      env: { HIVE_RELAY_URL: url, HIVE_PRIVATE_KEY: alice.secretKeyHex }
    })
    check('a bad argument exits 1 with JSON on stderr',
      bad.exitCode === 1 && JSON.parse(bad.stderr).error === 'user' && bad.stdout === '')

    const eve = identity()
    const secret = await cli(alice, ['channels', 'create', '--name', 'secret', '--visibility', 'private'])
    const denied = await run(['channels', 'get', '--channel', secret.id], {
      env: { HIVE_RELAY_URL: url, HIVE_PRIVATE_KEY: eve.secretKeyHex }
    })
    check('a private channel is not readable by a stranger', denied.exitCode === 3)
  } finally {
    if (agent !== null) await agent.stop()
    relay.close()
    await transport.close()
    await swarm.close()
    await swarm.dht.destroy()
    store.close()
    await testnet.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log(
    failures === 0
      ? '\n\x1b[32m✓ demo passed\x1b[0m — humans and agents shared a workspace end to end\n'
      : `\n\x1b[31m✗ ${failures} check(s) failed\x1b[0m\n`
  )
  Bare.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31mdemo failed:\x1b[0m', err.message)
  console.error(err.stack)
  Bare.exit(1)
})
