'use strict'

// The fs boundary of this package.
//
// `lib/home.js` requires nothing and takes an injected adapter so the harness
// still loads in a browser; this module is the one place that supplies the real
// one, and it is only ever reached from `hive agent run` and the demo scripts.
// Nothing in `index.js` imports it, so requiring `hive-agent` still costs no fs.
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')

const core = require('hive-core')

const { Agent } = require('./agent')
const { RelayConnection } = require('./connection')
const { AgentHome } = require('./home')

/**
 * Connect, construct, start, and do not return until the agent is watching.
 *
 * Extracted from scripts/demo-delegation.js, which was the ONLY place that knew
 * how to wire an agent — the reason configuring one meant editing a demo. The
 * demo now calls this, so there is one wiring and `hive agent run` cannot drift
 * away from the thing the demo proves works.
 *
 * `channel` is the join to wait for. An agent that has not joined yet ignores
 * every mention in silence, which turns a broken setup into an empty room
 * rather than an error.
 */
async function startAgent ({
  secretKey,
  owner = null,
  persona = null,
  provider = null,
  home = null,
  url = 'ws://127.0.0.1:3000',
  bootstrap = null,
  reconnect = true,
  maxHops = undefined,
  attestation = null,
  channel = null,
  timeout = 5000,
  onError = null
}) {
  const connection = new RelayConnection({ url: websocket(url), secretKey, bootstrap, reconnect })
  await connection.connect()

  const agent = new Agent({
    secretKey, owner, persona, provider, home, connection, maxHops, attestation
  })

  if (onError !== null) {
    agent.on('error', (err) => onError(err))
    agent.on('turn-error', (err) => onError(err))
  }

  await agent.start()

  if (channel !== null && !agent.channels.has(channel)) {
    await once(agent, 'joined', timeout).catch(() => {
      // Membership notifications are community-global and replayed on
      // subscribe, so missing one means the add never landed. Say which.
      throw new Error(`${agent.displayName} never joined ${channel}: it is not a member`)
    })
    if (!agent.channels.has(channel)) {
      throw new Error(`${agent.displayName} joined some channel, but not ${channel}`)
    }
  }

  return agent
}

function once (emitter, name, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${name}"`)), timeout)
    emitter.once(name, (...args) => {
      clearTimeout(timer)
      resolve(args)
    })
  })
}

/** RelayConnection speaks WebSocket; an operator will type whatever they have. */
function websocket (url) {
  return url.replace(/^http(s?):\/\//, 'ws$1://')
}

/** Where homes live when the operator names none. */
function defaultRoot (env = {}) {
  return env.HIVE_HOME ?? path.join(os.homedir(), '.hive')
}

// A first run has to produce something that works, and the only runtime that
// needs no model, no GPU and no download is the mock one. An operator who wants
// a real model edits `runtime` and `model` in this file — which is the reason
// it is written out in full rather than defaulted in code.
function defaultMetadata (name) {
  return {
    persona: {
      slug: name,
      display_name: name,
      runtime: 'mock',
      model: 'mock-1',
      description: `the ${name} agent`,
      system_prompt: null
    }
  }
}

/**
 * Resolve everything `hive agent run` needs from the home directory.
 *
 * Nothing is created unless `create` is set. Minting a keypair on a mistyped
 * `--name` would silently produce a SECOND agent with a new identity and leave
 * the first one dark, so a missing home is an error with the fix in it.
 */
function resolveAgent ({ root, name, create = false, personaFile = null, env = {} }) {
  const home = new AgentHome({ root, name, fs })

  if (create) {
    home.create()
    if (home.readSecretKey() === null) home.writeSecretKey(core.toHex(core.generateSecretKey()))
    if (!fs.existsSync(home.metadataPath)) home.writeMetadata(defaultMetadata(name))
  }

  if (!home.exists) {
    throw new Error(`no agent home at ${home.dir} — run again with --create to mint one`)
  }

  // An explicit key in the environment beats the file, so a systemd unit with
  // an EnvironmentFile never needs the key on disk at all.
  const envKey = env.HIVE_AGENT_KEY ?? null
  const secretKeyHex = envKey ?? home.readSecretKey()
  if (secretKeyHex === null) {
    throw new Error(
      `no keypair at ${home.keypairPath} — run again with --create, or write a ` +
      '64-character hex secret key there yourself (mode 0600)'
    )
  }

  const metadata = home.readMetadata()
  const persona = personaFile !== null
    ? JSON.parse(fs.readFileSync(personaFile, 'utf8'))
    : metadata.persona ?? null

  if (persona === null) {
    throw new Error(
      `no persona: add a "persona" object to ${home.metadataPath}, or pass --persona <file.json>`
    )
  }

  return { home, persona, secretKey: core.fromHex(secretKeyHex), owner: metadata.owner ?? persona.owner ?? null }
}

/**
 * `hive agent run`: a long-lived agent process.
 *
 * It says what it is watching and as whom, because an agent that prints nothing
 * and answers nothing looks exactly like an agent that is working. Shutdown is
 * a real shutdown: the provider unloads its model and the socket closes, and a
 * second signal stops waiting for that.
 */
async function runAgent ({
  root = null,
  name,
  url = null,
  create = false,
  personaFile = null,
  bootstrap = null,
  channel = null,
  env = {},
  log = console.log,
  signals = true
} = {}) {
  const relayUrl = url ?? env.HIVE_RELAY_URL ?? env.BUZZ_RELAY_URL ?? 'ws://127.0.0.1:3000'
  const { home, persona, secretKey, owner } = resolveAgent({
    root: root ?? defaultRoot(env), name, create, personaFile, env
  })

  const pubkey = core.getPublicKey(secretKey)
  const described = home.describe()

  log(`[agent] ${name} — ${core.encodeNpub(pubkey)}`)
  log(`[agent] home    ${described.dir}`)
  log(`[agent] persona ${persona.slug ?? name} · runtime ${persona.runtime ?? 'mock'}` +
      `${persona.model ? ' · model ' + persona.model : ''}` +
      `${described.hasInstruction ? ' · instruction.md overrides the prompt' : ''}` +
      `${described.skills.length > 0 ? ' · skills ' + described.skills.join(', ') : ''}`)
  log(`[agent] relay   ${relayUrl}`)
  if (owner !== null) log(`[agent] owner   ${core.encodeNpub(owner)}`)

  const agent = await startAgent({
    secretKey,
    owner,
    persona,
    home,
    url: relayUrl,
    bootstrap,
    channel,
    onError: (err) => log(`[agent] error: ${err.message}`)
  })

  // The whole reason this command exists: without it, "is it working?" has no
  // answer short of querying the relay.
  agent.on('joined', (id) => log(`[agent] watching ${id}`))
  agent.on('left', (id) => log(`[agent] left ${id}`))
  agent.on('mention', (event) => log(`[agent] mention from ${event.pubkey.slice(0, 8)}… in ${core.channelId(event)}`))
  agent.on('reply', (reply) => log(`[agent] replied ${reply.id.slice(0, 8)}… (${reply.content.length} chars)`))
  agent.on('refused', (event) => log(`[agent] refused ${event.pubkey.slice(0, 8)}…: not on the allowlist`))

  // Membership is replayed asynchronously after subscribe, so a count taken
  // here is a lower bound, not the answer — say that rather than print a 0 the
  // `watching` lines above are about to contradict.
  log(`[agent] channels so far: ${agent.channels.size}; membership replays as it arrives`)
  log('[agent] running. Ctrl-C to stop.')

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
    log('\n[agent] shutting down')
    await agent.stop()
    log('[agent] stopped')
  }

  const handlers = []
  if (signals) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        // A second signal is an operator saying they will not wait for a model
        // to unload. Honour it rather than looking hung.
        if (stopping) return process.exit(130)
        stop().then(() => process.exit(0), () => process.exit(1))
      }
      handlers.push([signal, handler])
      process.on(signal, handler)
    }
  }

  return { agent, home, pubkey, stop }
}

module.exports = { startAgent, runAgent, resolveAgent, defaultRoot, defaultMetadata }
