import os from 'bare-os'
import path from 'bare-path'
import process from 'bare-process'
// `Bare.env` does not exist on this runtime - reading it yields undefined, so
// every HIVE_* variable was silently ignored and the CLI could not be given a
// key at all. `bare-env` is the supported accessor: a Proxy over bare-os's
// getEnv, which reads the real environment.
import env from 'bare-env'
import App from './app.js'
import pkg from './package.json' with { type: 'json' }
import { run as runCli, commands } from 'hive-cli'
import { parseArgs } from 'hive-cli/lib/args.js'
import { resolveBind } from 'hive-relay/lib/bind.js'

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

  hive relay [--host 127.0.0.1] [--port 3000] [--public-url <origin>]
             [--storage <dir>] [--web-dir <dir>] [--no-updates] [--no-swarm]
      Run the workspace relay: WebSocket + HTTP on --host:--port, and (unless
      --no-swarm) reachable peer-to-peer at hyper://<relay pubkey>.
      --host defaults to loopback and nothing but --host widens it: pass
      --host 0.0.0.0 to accept connections from the network.
      --public-url is the origin clients reach when a TLS proxy sits in
      front, e.g. https://hive.example.com. NIP-98 signatures are bound to
      the full request URL, so behind a proxy this is not optional.
      --web-dir serves the web client from a directory. A standalone binary
      cannot carry it, so a deploy ships packages/hive-web/public (plus a
      vendor/ copy of @noble) beside the binary and points here. Omitted,
      the source tree is used if present and otherwise only the API is served.

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
  HIVE_PRIVATE_KEY / BUZZ_PRIVATE_KEY  nsec1… or 64-character hex
  HIVE_RELAY_HOST HIVE_RELAY_PORT      relay bind address; flags win
  HIVE_PUBLIC_URL                      relay public origin; --public-url wins
  HIVE_WEB_DIR                         web client directory; --web-dir wins`

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

// `relay` names both the daemon and a CLI group, so dispatching on the mode
// alone made `hive relay key` and `hive relay info` boot a relay on :3000 and
// print nothing. A second positional that names a real command is the
// disambiguator; bare `hive relay [--flags]` still runs the daemon.
const relaySubcommand = mode === 'relay' && positional[1] !== undefined
  ? commands[`relay ${positional[1]}`]
  : undefined

if (mode !== undefined && (mode !== 'relay' || relaySubcommand !== undefined)) {
  const result = await runCli(ARGV, {
    env,
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

let bind
try {
  bind = resolveBind(flags, env)
} catch (err) {
  console.error(`[relay] ${err.message}`)
  Bare.exit(1)
}

const app = new App({
  dir,
  app: isDev ? null : os.execPath(),
  updates,
  version: pkg.version,
  upgrade: pkg.upgrade,
  name: isWindows ? appName + '.exe' : appName,
  host: bind.host,
  port: bind.port,
  publicUrl: bind.publicUrl,
  webDir: flags.webDir ?? env.HIVE_WEB_DIR ?? null,
  swarm: flags.swarm
})

// Say it once, loudly, at the moment it becomes true. A relay reachable from
// the network is a deliberate act, and the operator should be able to see in
// the log that it was theirs.
if (!bind.loopback) {
  console.log(`[relay] BOUND TO ${bind.host} — reachable from the network, not just this machine`)
}

app.on('listening', (m) => {
  // With a --public-url the two differ, and printing only one of them makes a
  // failed connection impossible to diagnose from the log.
  const bound = `${m.host}:${m.port}`
  console.log(m.url.includes(bound) ? `[relay] listening on ${m.url}` : `[relay] listening on ${m.url} (bound ${bound})`)
})
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
  // These two were `Bare.env.X`, not `Bare.env?.X`, so on Linux and Windows
  // resolving the storage directory threw TypeError before it could return a
  // path. macOS returns above and never reached it, which is why it survived.
  if (isWindows) return env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  return env.XDG_CONFIG_HOME ?? path.join(home, '.config')
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
