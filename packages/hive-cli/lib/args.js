'use strict'

const { CliError } = require('./errors')

/**
 * `hive <group> <subcommand> [--flag value] [--bool] [positional]`
 *
 * Repeated flags collect into an array, so `--pubkey a --pubkey b` works the
 * way buzz-cli's batch lookups do. `--no-x` sets `x` to false.
 */
function parseArgs (argv) {
  const positional = []
  const flags = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }

    let name = arg.slice(2)
    let value

    const eq = name.indexOf('=')
    if (eq !== -1) {
      value = name.slice(eq + 1)
      name = name.slice(0, eq)
    } else if (name.startsWith('no-')) {
      name = name.slice(3)
      value = false
    } else {
      const next = argv[i + 1]
      // A following token that looks like a flag means this one is a boolean.
      if (next === undefined || (next.startsWith('--') && next !== '--')) {
        value = true
      } else {
        value = next
        i++
      }
    }

    const key = camelCase(name)
    if (flags[key] === undefined) {
      flags[key] = value
    } else if (Array.isArray(flags[key])) {
      flags[key].push(value)
    } else {
      flags[key] = [flags[key], value]
    }
  }

  return { positional, flags }
}

function camelCase (name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

/** Always an array, so callers do not have to special-case a single value. */
function list (value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * Resolve a value that may be `-`, meaning "read it from stdin". buzz-cli's
 * convention, and the reason an agent can pipe a diff or a file without
 * worrying about shell escaping.
 */
async function resolveStdin (value, readStdin, name) {
  if (value !== '-') return value

  const input = await readStdin()
  if (input === null || input.length === 0) {
    throw new CliError('user', `--${name} was "-" but stdin was empty`)
  }
  return input
}

module.exports = { parseArgs, list, resolveStdin, camelCase }
