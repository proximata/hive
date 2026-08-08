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
//   hive demo [flags]         the guided TUI demo, on a relay of its own
//   hive <group> <sub> ...    the agent-first CLI against a running relay

const appName = pkg.productName ?? pkg.name
const isWindows = os.platform() === 'win32'
const isDev = Bare.argv[1]?.endsWith('bin.mjs') ?? false

// Argument vectors differ between running from source and running the built
// binary: `bare bin.mjs --version` carries the entry script at argv[1], while
// `./hive --version` does not. Slicing a fixed 2 ate the first real flag in the
// standalone build, so `hive --version` printed usage instead of a version.
// Drop the entry script only when it is actually there.
const rest = Bare.argv.slice(1)
const ARGV = /(^|[/\\])bin\.mjs$/.test(rest[0] ?? '') ? rest.slice(1) : rest

// One parser for both modes: the relay flags and the CLI share a grammar, and
// two parsers would inevitably disagree about something like `--content -`.
const { positional, flags } = parseArgs(ARGV)
const mode = positional[0]

const USAGE = `${appName} ${pkg.version} — ${pkg.description}

  hive relay [--port 3000] [--storage <dir>] [--no-updates] [--no-swarm]
      Run the workspace relay: WebSocket + HTTP on --port, and (unless
      --no-swarm) reachable peer-to-peer at hyper://<relay pubkey>.

  hive demo [--demo] [--record] [--relay <url>] [--speed <n>] [--no-swarm]
           [--seed <n>] [--cols <n>] [--rows <n>]
      The guided demo, in the terminal: it boots a relay of its own and plays
      the whole script against it. --demo asserts every scene and exits
      non-zero if one fails; --record plays it at real pace for a capture;
      --relay attaches to a relay that is already running, where the scenes
      that need the relay's own store or event stream report SKIP.

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

// `--help` prints usage whatever precedes it. Gating this on "no mode given"
// meant `hive relay --help` fell straight through and booted a relay on :3000
// instead of explaining itself.
//
// `demo` is the exception: it owns a screenful of flags and key bindings that
// this usage only summarises, so it answers `--help` itself below.
if ((flags.help === true || flags.h === true) && mode !== 'demo') {
  console.log(USAGE)
  Bare.exit(0)
}

// ------------------------------------------------------------------- demo --

// Ahead of the CLI dispatch below, which claims every mode that is not `relay`.
//
// Imported dynamically, but with a literal specifier: `hive channels list`
// must not pay to load a relay, a DHT testnet and the scene script, while the
// bundler still sees the edge and packs the demo into the standalone binary.
//
// That only holds because the graph resolves without `@qvac/sdk`, which the
// agent harness names as an optional peer dependency. See the `#qvac-sdk`
// import in packages/hive-agent/package.json — without it, bare-pack fails the
// whole build over a module nobody installs.
if (mode === 'demo') {
  const { start } = await import('./scripts/demo-tui.js')

  // The demo reads flags only, so passing the mode word along is harmless and
  // saves guessing where in ARGV it sat.
  await start(ARGV)
}

// Anything that is not `relay` is a CLI command, so one binary covers both
// "run the workspace" and "talk to a workspace".

if (mode !== undefined && mode !== 'relay') {
  const result = await runCli(ARGV, {
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
