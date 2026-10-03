'use strict'

// The Bare worker. This is where the peer-to-peer half of the app lives: the
// pear-runtime updater, the store, the relay, and the swarm. `bin.mjs` and
// `app.js` are only a host that spawns it and relays its lifecycle messages.
//
// Arguments come from PearRuntime.run in app.js, positionally.

const path = require('bare-path')
const fs = require('bare-fs')
// Not `Bare.env`, which is undefined here: the two authorization switches below
// read as false whatever the environment said, so neither could be turned on.
const env = require('bare-env')
const FramedStream = require('framed-stream')

const { openStore } = require('hive-store')
const {
  Relay,
  MediaStore,
  transports,
  resolveBootstrap,
  resolveReplication
} = require('hive-relay')
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
  transportsArg,
  hostArg,
  publicUrlArg,
  webDirArg,
  bootstrapArg,
  replicateArg
] = Bare.argv

const updates = updatesArg !== 'false'
// Not `|| 3000`: port 0 is meaningful (let the OS pick), and the old form
// turned an explicit --port 0 back into 3000 here after bin.mjs had honoured it.
const port = Number.isInteger(Number(portArg)) ? Number(portArg) : 3000
// Registry names from bin.mjs (resolveTransports), in start order. An unknown
// name is caught below by createTransport, before anything is announced.
const transportIds = (transportsArg ?? 'ws,swarm').split(',').filter(Boolean)
// bin.mjs validated these; the fallback is only for a worker started by hand.
const host = hostArg === undefined || hostArg === '' ? '127.0.0.1' : hostArg
const publicUrl = publicUrlArg === undefined || publicUrlArg === '' ? null : publicUrlArg
const webDir = webDirArg === undefined || webDirArg === '' ? null : webDirArg
// bin.mjs already validated this; re-resolving here covers a worker started by
// hand with only HIVE_DHT_BOOTSTRAP set, and keeps the malformed case fatal at
// startup instead of at the first dial. `undefined` is the untouched default.
const bootstrap = resolveBootstrap(
  bootstrapArg === undefined || bootstrapArg === '' ? {} : { bootstrap: bootstrapArg },
  env
)
// null means replication is OFF, which is the default and the only behaviour a
// deployment that never passes --replicate can get.
const replicate = resolveReplication(
  replicateArg === undefined || replicateArg === '' ? {} : { replicate: replicateArg },
  env
)

const pipe = new FramedStream(Bare.IPC)
const say = (type, payload = {}) => {
  try {
    pipe.write(JSON.stringify({ type, ...payload }))
  } catch {
    // The host may already be gone during shutdown.
  }
}

/**
 * The directory to serve the web client from, or null for API-only.
 *
 * An explicit --web-dir is taken at its word and must exist: a deploy that
 * points at the wrong path should say so at boot, not answer 404 for the page
 * while /health stays green. Without the flag this looks for the source tree,
 * which only resolves in a dev run.
 */
function resolveWebDir () {
  if (webDir !== null) {
    const resolved = path.resolve(webDir)
    if (!fs.existsSync(path.join(resolved, 'index.html'))) {
      throw new Error(`--web-dir has no index.html: ${resolved}`)
    }
    return resolved
  }

  // __dirname is inside the bundle for a standalone binary, so this join
  // simply does not exist there and the check falls through to null.
  const fromSource = path.join(__dirname, '..', 'packages', 'hive-web', 'public')
  return fs.existsSync(path.join(fromSource, 'index.html')) ? fromSource : null
}

async function main () {
  // An unknown transport name fails here, before the store is opened or
  // anything listens.
  for (const id of transportIds) transports.getTransport(id)

  fs.mkdirSync(dir, { recursive: true })

  // The relay's identity is persisted, because it is also its dial address:
  // regenerating it on restart would change the pear-style link every peer
  // uses to reach this workspace.
  const secretKey = loadOrCreateKey(path.join(dir, 'relay.key'))

  const store = openStore(path.join(dir, 'hive.db'))
  const mediaStore = new MediaStore(path.join(dir, 'media'))

  const relay = new Relay(store, {
    secretKey,
    url: publicUrl ?? `ws://${host}:${port}`,
    // No `name`: that argument is the executable name the updater needs, and
    // passing it here made the NIP-11 name follow the binary filename.
    rateLimiter: new RateLimiter({ tier: 'human' }),
    requireRelayMembership: env.HIVE_REQUIRE_RELAY_MEMBERSHIP === 'true',
    requireAllowlist: env.HIVE_PUBKEY_ALLOWLIST === 'true'
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

  // The web client is a directory on disk, not a bundled asset.
  //
  // require.asset() cannot carry it. Bare links any .js asset as a module at
  // startup, and the browser's app.js imports '@noble/curves/secp256k1.js',
  // which is a bare specifier the *browser* resolves through an import map.
  // Bare tries to resolve it from the unpacked asset directory, where no
  // node_modules exists, and the process dies before it listens:
  //   Uncaught ModuleTraverseError: MODULE_NOT_FOUND: Cannot find module
  //   '@noble/curves/secp256k1.js' imported from '/tmp/hive-<sha>/.../app.js'
  // A directory asset fails the same way. @noble also has to reach the browser
  // as real files, which a bundle cannot provide either.
  //
  // So: --web-dir points at a directory, and it ships next to the binary.
  // Unset, it falls back to the source tree, which is what a dev run wants and
  // what a standalone binary will not find. In that case no web client is
  // served and every API route behaves exactly as before.
  const publicDir = resolveWebDir()
  if (publicDir === null) say('notice', { message: 'no web client directory; serving the API only' })

  // Options that only some transports take. Everything else uses defaults.
  const transportOptions = {
    ws: { host, port, publicUrl, mediaStore, publicDir },
    swarm: { bootstrap },
    // Relay-to-relay replication. Only started when the list names it, which
    // resolveTransports does for --replicate and nothing else: with no
    // --replicate this opens no corestore, joins no topic and leaves the event
    // path untouched.
    replication: { storageDir: path.join(dir, 'replication'), topic: replicate, bootstrap }
  }

  const active = []
  for (const id of transportIds) {
    const transport = transports.createTransport(id, relay, transportOptions[id] ?? {})
    await transport.listen()
    active.push(transport)
    // describe() carries what an operator needs for each transport: the bound
    // URL and port for ws (the port the OS picked for --port 0, or the public
    // origin), the key for swarm, the group and feed for replication.
    say('transport', { id, link: transport.link, ...transport.describe() })
  }

  say('ready', {
    pubkey: relay.pubkey,
    npub: core.encodeNpub(relay.pubkey),
    storage: dir,
    version
  })

  // ------------------------------------------------------------------ OTA --

  let pear = null

  if (updates && typeof upgrade === 'string' && upgrade.startsWith('pear://')) {
    try {
      const PearRuntime = require('pear-runtime')
      pear = new PearRuntime({
        dir,
        version,
        upgrade,
        name,
        app: app === '' ? null : app,
        updates: true
      })

      pear.on('error', (err) => say('error', { message: 'updater: ' + err.message }))
      pear.updater.on('updating', () => say('updating'))
      pear.updater.on('updated', async () => {
        say('updated')
        // applyUpdate() is async: it swaps the staged binary in. Saying
        // 'update-applied' before it resolves reported a swap that had not
        // happened, and a failure surfaced as an unhandled rejection.
        try {
          await pear.updater.applyUpdate()
          say('update-applied')
        } catch (err) {
          say('error', { message: 'updater: ' + err.message })
        }
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
    for (const transport of active) await transport.close()

    // pear-runtime opens a Corestore and a swarm of its own, and only close()
    // releases them.
    try {
      await pear?.close()
    } catch (err) {
      say('error', { message: 'updater close: ' + err.message })
    }

    store.close()
    // The host waits for this instead of guessing how long a close takes.
    say('closed')

    // Let the pipe flush the last message before this thread ends.
    setTimeout(() => Bare.exit(0), 50)
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
