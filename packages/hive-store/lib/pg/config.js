'use strict'

// Store configuration resolved from the environment.
//
// A multi-node deployment is configured by the orchestrator, not by a file
// checked into the repo, so every knob has an environment variable. Parsing
// lives here rather than in the pool so it can be unit-tested on any runtime —
// no `pg`, no socket, no container.

const { StoreError } = require('../errors')

const DEFAULTS = {
  poolMax: 10,
  idleTimeoutMs: 30_000,
  connectionTimeoutMs: 10_000,
  statementTimeoutMs: 30_000
}

function defaultEnv () {
  // Bare exposes `Bare.env`; Node exposes `process.env`. Reading through
  // globalThis keeps this file free of a runtime-specific import.
  return globalThis.Bare?.env ?? globalThis.process?.env ?? {}
}

function first (env, ...names) {
  for (const name of names) {
    const value = env[name]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function integer (env, name, fallback, { min = 0 } = {}) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) {
    throw StoreError.invalid(`${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * Postgres TLS. `require` trusts whatever certificate the server presents,
 * which is what managed providers hand out; `verify-full` is the setting that
 * actually authenticates the server, so it is spelled out separately rather
 * than hidden behind a bare `true`.
 */
function ssl (env) {
  const raw = first(env, 'HIVE_PG_SSL', 'PGSSLMODE')
  if (raw === undefined) return undefined

  switch (raw.toLowerCase()) {
    case 'false':
    case 'disable':
      return false
    case 'true':
    case 'require':
    case 'no-verify':
      return { rejectUnauthorized: false }
    case 'verify-ca':
    case 'verify-full':
      return { rejectUnauthorized: true }
    default:
      throw StoreError.invalid(
        `HIVE_PG_SSL must be one of disable, require, no-verify, verify-ca, verify-full; got ${JSON.stringify(raw)}`
      )
  }
}

/**
 * Connection and pool settings. `HIVE_PG_*` wins over the standard `PG*` and
 * `DATABASE_URL` names, so a host that already has libpq variables set for
 * something else can still be pointed somewhere specific.
 */
function postgresConfigFromEnv (env = defaultEnv()) {
  const config = {
    connectionString: first(env, 'HIVE_PG_URL', 'DATABASE_URL'),
    host: first(env, 'HIVE_PG_HOST', 'PGHOST'),
    port: integer(env, 'HIVE_PG_PORT', undefined, { min: 1 }) ?? integer(env, 'PGPORT', undefined, { min: 1 }),
    database: first(env, 'HIVE_PG_DATABASE', 'PGDATABASE'),
    user: first(env, 'HIVE_PG_USER', 'PGUSER'),
    password: first(env, 'HIVE_PG_PASSWORD', 'PGPASSWORD'),
    schema: first(env, 'HIVE_PG_SCHEMA'),
    ssl: ssl(env),
    poolMax: integer(env, 'HIVE_PG_POOL_MAX', DEFAULTS.poolMax, { min: 1 }),
    idleTimeoutMs: integer(env, 'HIVE_PG_IDLE_TIMEOUT_MS', DEFAULTS.idleTimeoutMs),
    connectionTimeoutMs: integer(env, 'HIVE_PG_CONNECT_TIMEOUT_MS', DEFAULTS.connectionTimeoutMs),
    statementTimeoutMs: integer(env, 'HIVE_PG_STATEMENT_TIMEOUT_MS', DEFAULTS.statementTimeoutMs)
  }

  // An empty config would silently fall back to libpq's "connect to a unix
  // socket as the current user" behaviour, which on a server is never what was
  // meant and produces a confusing error several layers down.
  if (config.connectionString === undefined && config.host === undefined) {
    throw StoreError.invalid(
      'the postgres driver needs HIVE_PG_URL (or DATABASE_URL), or at least HIVE_PG_HOST'
    )
  }

  for (const key of Object.keys(config)) {
    if (config[key] === undefined) delete config[key]
  }
  return config
}

/**
 * The whole store configuration. `HIVE_STORE_DRIVER` selects the driver; every
 * other variable is driver-specific, so an unset Postgres deployment cannot
 * accidentally half-configure a SQLite one.
 */
function storeConfigFromEnv (env = defaultEnv()) {
  const driver = (first(env, 'HIVE_STORE_DRIVER') ?? 'sqlite').toLowerCase()

  if (driver === 'sqlite') {
    return { driver, location: first(env, 'HIVE_STORE_LOCATION') ?? ':memory:' }
  }
  if (driver === 'postgres') {
    return { driver, postgres: postgresConfigFromEnv(env) }
  }

  throw StoreError.invalid(`unknown store driver: ${driver}`)
}

module.exports = { storeConfigFromEnv, postgresConfigFromEnv, DEFAULTS }
