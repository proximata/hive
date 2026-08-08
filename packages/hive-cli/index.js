'use strict'

const { commands } = require('./lib/commands')
const { RelayClient } = require('./lib/client')
const { CliError, EXIT_CODES } = require('./lib/errors')
const { parseArgs } = require('./lib/args')
const validate = require('./lib/validate')

const USAGE = `hive <group> <subcommand> [flags]

  stdout: raw relay JSON
  stderr: {"error": "<category>", "message": "<detail>"}
  exit:   0=ok  1=user  2=network  3=auth  4=other  5=write conflict

Environment:
  HIVE_RELAY_URL / BUZZ_RELAY_URL    http://…, ws://… or hyper://<pubkey>  (default http://localhost:3000)
  HIVE_PRIVATE_KEY / BUZZ_PRIVATE_KEY  nsec1… or 64-character hex

Groups: ${[...new Set(Object.keys(commands).map((k) => k.split(' ')[0]))].join(', ')}

Use "-" as a content argument to read the body from stdin.`

/**
 * Run one command. Returns `{ stdout, stderr, exitCode }` rather than writing
 * and exiting, so tests can drive the real command surface in-process instead
 * of asserting on spawned output.
 */
async function run (argv, { env = {}, readStdin = async () => null, client = null } = {}) {
  const { positional, flags } = parseArgs(argv)

  // Asking for help is a success; being invoked with nothing is a usage error.
  if (flags.help === true) return { stdout: '', stderr: USAGE, exitCode: 0 }
  if (positional.length === 0) return { stdout: '', stderr: USAGE, exitCode: 1 }

  const [group, subcommand] = positional
  const name = `${group} ${subcommand ?? ''}`.trim()
  const handler = commands[name]

  if (handler === undefined) {
    const available = Object.keys(commands).filter((k) => k.startsWith(group + ' '))
    const message = available.length > 0
      ? `unknown subcommand "${subcommand}" for ${group}; try: ${available.map((k) => k.split(' ')[1]).join(', ')}`
      : `unknown command "${name}"`
    return fail(new CliError('user', message))
  }

  try {
    const secretKey = validate.secretKey(env.HIVE_PRIVATE_KEY ?? env.BUZZ_PRIVATE_KEY)
    const url = normalizeUrl(env.HIVE_RELAY_URL ?? env.BUZZ_RELAY_URL ?? 'http://localhost:3000')

    const ctx = {
      flags,
      positional: positional.slice(2),
      secretKey,
      readStdin,
      client: client ?? new RelayClient({ url, secretKey })
    }

    const result = await handler(ctx)
    return { stdout: JSON.stringify(result, null, 2), stderr: '', exitCode: 0 }
  } catch (err) {
    return fail(err)
  }
}

function fail (err) {
  const cliError = err instanceof CliError ? err : new CliError('other', err.message)
  return {
    stdout: '',
    stderr: JSON.stringify(cliError.toJSON()),
    exitCode: cliError.exitCode
  }
}

/**
 * `hyper://<pubkey>` is accepted everywhere a URL is, but the CLI speaks HTTP,
 * so it is rejected with a clear message rather than a confusing connection
 * error. (Dialling a relay by key from the CLI goes through the agent harness.)
 */
function normalizeUrl (url) {
  if (url.startsWith('hyper://')) {
    throw new CliError('user', 'hyper:// relays are reachable from the agent harness, not the HTTP CLI; use http://')
  }
  return url.replace(/^ws(s?):\/\//, 'http$1://')
}

module.exports = { run, commands, RelayClient, CliError, EXIT_CODES, USAGE }
