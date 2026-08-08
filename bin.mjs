import os from 'bare-os'
import path from 'bare-path'
import process from 'bare-process'
import App from './app.js'
import pkg from './package.json' with { type: 'json' }
import { run as runCli } from 'hive-cli'
import { parseArgs } from 'hive-cli/lib/args.js'

// Entry point, following the hello-pear-bare shape: parse flags, resolve a
// storage directory, construct the App, log its lifecycle.
//
// Two modes in one binary:
//   hive relay [flags]        run the workspace relay
//   hive <group> <sub> ...    the agent-first CLI against a running relay

const appName = pkg.productName ?? pkg.name
const isWindows = os.platform() === 'win32'
const isDev = Bare.argv[1]?.endsWith('bin.mjs') ?? false

// One parser for both modes: the relay flags and the CLI share a grammar, and
// two parsers would inevitably disagree about something like `--content -`.
const { positional, flags } = parseArgs(Bare.argv.slice(2))
const mode = positional[0]

const USAGE = `${appName} ${pkg.version} — ${pkg.description}

  hive relay [--port 3000] [--storage <dir>] [--no-updates] [--no-swarm]
      Run the workspace relay: WebSocket + HTTP on --port, and (unless
      --no-swarm) reachable peer-to-peer at hyper://<relay pubkey>.

  hive <group> <subcommand> [flags]
      The agent-first CLI. Groups: channels, messages, canvas, reactions, dms,
      users, feed, social, repos, workflows, upload, mem, audit, relay.

Environment:
  HIVE_RELAY_URL / BUZZ_RELAY_URL      default http://localhost:3000
  HIVE_PRIVATE_KEY / BUZZ_PRIVATE_KEY  nsec1… or 64-character hex`

if (flags.version === true || flags.v === true) {
  console.log(pkg.version)
  Bare.exit(0)
}

// Anything that is not `relay` is a CLI command, so one binary covers both
// "run the workspace" and "talk to a workspace".
if ((flags.help === true || flags.h === true) && mode === undefined) {
  console.log(USAGE)
  Bare.exit(0)
}

if (mode !== undefined && mode !== 'relay') {
  const result = await runCli(Bare.argv.slice(2), {
    env: Bare.env ?? {},
    readStdin: readStdin
  })

  if (result.stdout !== '') console.log(result.stdout)
  if (result.stderr !== '') console.error(result.stderr)
  Bare.exit(result.exitCode)
}

if (mode === undefined) {
  console.error(USAGE)
  Bare.exit(1)
}

// ------------------------------------------------------------------ relay --

const updates = flags.updates
const storage = flags.storage ?? flags.s ?? (isDev ? null : path.join(persistent(), appName))
const dir = storage ?? path.join(os.tmpdir(), 'hive', appName)

const app = new App({
  dir,
  app: isDev ? null : os.execPath(),
  updates,
  version: pkg.version,
  upgrade: pkg.upgrade,
  name: isWindows ? appName + '.exe' : appName,
  port: Number(flags.port) || 3000,
  swarm: flags.swarm
})

app.on('listening', (m) => console.log(`[relay] listening on ${m.url}`))
app.on('swarm', (m) => console.log(`[relay] reachable at ${m.link}`))
app.on('ready-relay', (m) => {
  console.log(`[relay] identity ${m.npub}`)
  console.log(`[relay] storage  ${m.storage}`)
  console.log(`[relay] updates  ${updates === false ? 'disabled' : 'enabled'}`)
})

app.on('updating', () => console.log('[updater] fetching a new version'))
app.on('updated', () => console.log('[updater] update staged, applying'))
app.on('update-applied', () => console.log('[updater] applied — restart to run the latest version'))
app.on('updater-disabled', () => {})
app.on('worker-error', (m) => console.error('[relay:error]', m.message))
app.on('error', (err) => console.error('[app:error]', err.message))

await app.ready()

for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n[relay] shutting down')
    app.exit(0)
  })
}

/** Per-user application data directory, matching where Pear installs apps. */
function persistent () {
  const home = os.homedir()
  if (os.platform() === 'darwin') return path.join(home, 'Library', 'Application Support')
  if (isWindows) return Bare.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  return Bare.env.XDG_CONFIG_HOME ?? path.join(home, '.config')
}

function readStdin () {
  return new Promise((resolve) => {
    const chunks = []
    if (process.stdin.isTTY) return resolve(null)

    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString().replace(/\n$/, '')))
    process.stdin.on('error', () => resolve(null))
  })
}
