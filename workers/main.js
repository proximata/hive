'use strict'

// The Bare worker. This is where the peer-to-peer half of the app lives: the
// pear-runtime updater, the store, the relay, and the swarm. `bin.mjs` and
// `app.js` are only a host that spawns it and relays its lifecycle messages.
//
// Arguments come from PearRuntime.run in app.js, positionally.

const path = require('bare-path')
const fs = require('bare-fs')
const FramedStream = require('framed-stream')

const { openStore } = require('hive-store')
const { Relay, WebSocketTransport, SwarmTransport, MediaStore } = require('hive-relay')
const { WorkflowEngine } = require('hive-workflow')
const { RateLimiter } = require('hive-auth')
const core = require('hive-core')

const [
  ,
  ,
  updatesArg,
  version,
  upgrade,
  name,
  dir,
  app,
  portArg,
  swarmArg
] = Bare.argv

const updates = updatesArg !== 'false'
const port = Number(portArg) || 3000
const swarmEnabled = swarmArg !== 'false'

const pipe = new FramedStream(Bare.IPC)
const say = (type, payload = {}) => {
  try {
    pipe.write(JSON.stringify({ type, ...payload }))
  } catch {
    // The host may already be gone during shutdown.
  }
}

async function main () {
  fs.mkdirSync(dir, { recursive: true })

  // The relay's identity is persisted, because it is also its dial address:
  // regenerating it on restart would change the pear-style link every peer
  // uses to reach this workspace.
  const secretKey = loadOrCreateKey(path.join(dir, 'relay.key'))

  const store = openStore(path.join(dir, 'hive.db'))
  const mediaStore = new MediaStore(path.join(dir, 'media'))

  const relay = new Relay(store, {
    secretKey,
    url: `ws://127.0.0.1:${port}`,
    name,
    rateLimiter: new RateLimiter({ tier: 'human' }),
    requireRelayMembership: Bare.env?.HIVE_REQUIRE_RELAY_MEMBERSHIP === 'true',
    requireAllowlist: Bare.env?.HIVE_PUBKEY_ALLOWLIST === 'true'
  })

  relay.workflowEngine = new WorkflowEngine(relay)
  relay.on('error', (err) => say('error', { message: err.message }))
  relay.on('audit-error', (err) => say('error', { message: 'audit: ' + err.message }))

  // Any workflow definition already on the log is reloaded, so a restart does
  // not silently disable automation.
  for (const stored of store.queryEvents([{ kinds: [core.KIND_WORKFLOW_DEF] }])) {
    try {
      relay.workflowEngine.registerFromEvent(stored.event)
    } catch (err) {
      say('error', { message: `workflow ${core.dTag(stored.event)}: ${err.message}` })
    }
  }

  const wsTransport = new WebSocketTransport(relay, { port, mediaStore })
  await wsTransport.listen()
  say('listening', { url: `http://127.0.0.1:${wsTransport.port}`, port: wsTransport.port })

  let swarmTransport = null
  if (swarmEnabled) {
    swarmTransport = new SwarmTransport(relay)
    await swarmTransport.listen()
    say('swarm', { link: swarmTransport.link, publicKey: swarmTransport.publicKey })
  }

  say('ready', {
    pubkey: relay.pubkey,
    npub: core.encodeNpub(relay.pubkey),
    storage: dir,
    version
  })

  // ------------------------------------------------------------------ OTA --

  if (updates && typeof upgrade === 'string' && upgrade.startsWith('pear://')) {
    try {
      const PearRuntime = require('pear-runtime')
      const pear = new PearRuntime({
        dir,
        version,
        upgrade,
        name,
        app: app === '' ? null : app,
        updates: true
      })

      pear.on('error', (err) => say('error', { message: 'updater: ' + err.message }))
      pear.updater.on('updating', () => say('updating'))
      pear.updater.on('updated', () => {
        say('updated')
        pear.updater.applyUpdate()
        say('update-applied')
      })

      await pear.ready()
      say('updater-ready')
    } catch (err) {
      // A missing or placeholder upgrade link must not stop the relay: the
      // workspace is the product, the updater is a convenience.
      say('error', { message: 'updater disabled: ' + err.message })
    }
  } else {
    say('updater-disabled')
  }

  const shutdown = async () => {
    say('closing')
    relay.close()
    await wsTransport.close()
    if (swarmTransport !== null) await swarmTransport.close()
    store.close()
    Bare.exit(0)
  }

  pipe.on('data', (data) => {
    try {
      if (JSON.parse(data.toString()).type === 'close') shutdown()
    } catch {
      // Ignore malformed host messages.
    }
  })
}

/** Load the relay's persistent identity, creating it on first run. */
function loadOrCreateKey (file) {
  try {
    return core.fromHex(fs.readFileSync(file, 'utf8').trim())
  } catch {
    const secretKey = core.generateSecretKey()
    fs.writeFileSync(file, core.toHex(secretKey), { mode: 0o600 })
    return secretKey
  }
}

main().catch((err) => {
  say('error', { message: err.message, stack: err.stack })
  Bare.exit(1)
})
