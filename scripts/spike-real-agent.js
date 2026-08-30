'use strict'

// SPIKE: one real agent turn driven by a real local model.
//
// Same wiring as scripts/demo.js, with exactly one substitution: the provider
// is a real QvacProvider (runtime "qvac") instead of MockProvider. Everything
// else — relay, channel, membership, NIP-98 CLI, threading — is untouched, so
// anything that breaks here is the inference boundary and nothing else.
//
// Runs against a LOCAL relay on an ephemeral port. Never touches production.

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')

const core = require('hive-core')
const { openStore } = require('hive-store')
const { Relay, WebSocketTransport, MediaStore } = require('hive-relay')
const { Agent, RelayConnection } = require('hive-agent')
const { providerFromPersona } = require('hive-agent/lib/qvac')
const { run } = require('hive-cli')

function identity () {
  const secretKey = core.generateSecretKey()
  return { secretKey, secretKeyHex: core.toHex(secretKey), pubkey: core.getPublicKey(secretKey) }
}

async function main () {
  const dir = path.join(os.tmpdir(), `hive-spike-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })

  const store = openStore(path.join(dir, 'hive.db'))
  const relay = new Relay(store, { url: 'ws://127.0.0.1' })
  const transport = new WebSocketTransport(relay, { port: 0, mediaStore: new MediaStore(path.join(dir, 'media')) })
  await transport.listen()

  const url = `http://127.0.0.1:${transport.port}`
  console.log(`relay listening on ${url} (local, ephemeral port)`)

  const alice = identity()
  const bot = identity()

  const cli = async (who, argv) => {
    const result = await run(argv, {
      env: { HIVE_RELAY_URL: url, HIVE_PRIVATE_KEY: who.secretKeyHex },
      readStdin: async () => null
    })
    if (result.exitCode !== 0) throw new Error(`hive ${argv.join(' ')} → ${result.stderr}`)
    return JSON.parse(result.stdout)
  }

  let agent = null
  try {
    const channel = await cli(alice, ['channels', 'create', '--name', 'engineering', '--visibility', 'open'])
    console.log(`channel ${channel.id}`)

    await cli(alice, ['channels', 'add-member', '--channel', channel.id, '--pubkey', bot.pubkey, '--role', 'bot'])

    // The only line that differs from the mock demo.
    const persona = {
      slug: 'honey',
      display_name: 'Honey',
      system_prompt: 'You are a terse incident summarizer. Answer in one short sentence.',
      runtime: 'qvac',
      model: 'LLAMA_3_2_1B_INST_Q4_0'
    }
    const provider = providerFromPersona(persona)
    console.log(`provider = ${provider.constructor.name}, model = ${persona.model}`)

    const connection = new RelayConnection({
      url: `ws://127.0.0.1:${transport.port}`, secretKey: bot.secretKey, reconnect: false
    })
    await connection.connect()

    agent = new Agent({ secretKey: bot.secretKey, owner: alice.pubkey, persona, provider, connection })
    await agent.start()
    await new Promise((resolve) => setTimeout(resolve, 300))

    // Model load is a cold download on first run; generation itself is fast.
    const replied = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('agent did not reply in time')), 600000)
      agent.once('reply', (reply) => { clearTimeout(timer); resolve(reply) })
    })

    const question = 'The checkout API returned 500s for 12 minutes after a bad deploy. What happened?'
    console.log(`\nalice → @honey: ${question}`)

    const t = Date.now()
    const mention = await cli(alice, [
      'messages', 'send', '--channel', channel.id, '--content', question, '--mention', bot.pubkey
    ])
    const reply = await replied
    const elapsed = ((Date.now() - t) / 1000).toFixed(1)

    console.log(`\n@honey → alice (${elapsed}s): ${reply.content}`)
    console.log('\n--- checks ---')
    console.log('reply authored by the agent :', reply.pubkey === bot.pubkey)
    console.log('reply is a signed event     :', core.verifyEvent(reply).ok === true)
    console.log('threaded under the question :', core.referencedEvents(reply).includes(mention.id))
    console.log('content is not the mock text:', !reply.content.startsWith('Acknowledged:'))
  } finally {
    if (agent !== null) await agent.stop()
    await transport.close()
    store.close?.()
  }
}

main().catch((e) => { console.log('SPIKE FAILED:', e.message) })
