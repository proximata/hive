'use strict'

// The connection pool, and the only file in the package that knows `pg` exists.
//
// Everything above it talks to `{ query, connect, end }`, which is why the
// conformance tests can drive the store through a real pool while the unit
// tests drive the same code through a recording stub.

const { StoreError } = require('../errors')
const { DEFAULTS } = require('./config')

// int8. `pg` returns BIGINT as a string, because an int8 does not always fit in
// a double. Every BIGINT in this schema is a Unix second count or a row
// sequence, so all of them fit comfortably, and returning strings here would
// mean `created_at` came back as a number under SQLite and a string under
// Postgres — the exact class of difference a driver swap must not have.
const INT8_OID = 20

/**
 * Resolve the driver on first use.
 *
 * `#pg` maps to `pg` on Node and to ./unsupported.js on Bare, so the specifier
 * is a static string the bundler can follow. The require is deferred anyway
 * because `pg` is an optional peer dependency: a SQLite-only install must be
 * able to load `hive-store` without it, and only fail — clearly — at the point
 * someone asks for a Postgres connection.
 */
let driver = null
function loadDriver () {
  if (driver !== null) return driver
  try {
    driver = require('#pg')
  } catch (err) {
    throw StoreError.invalid(
      'the postgres store driver needs the `pg` package: npm install pg ' +
      `(resolving it failed with: ${err.message})`
    )
  }
  return driver
}

class PgPool {
  constructor (config = {}) {
    const pg = loadDriver()
    const options = []
    if (typeof config.schema === 'string') options.push(`-c search_path=${config.schema}`)

    // Registering the int8 parser on the pool rather than through
    // `pg.types.setTypeParser` keeps the change local: a host application that
    // embeds hive and also talks to its own Postgres keeps its own parsers.
    const types = {
      getTypeParser (oid, format) {
        if (oid === INT8_OID) return Number
        return pg.types.getTypeParser(oid, format)
      }
    }

    this.pool = new pg.Pool({
      connectionString: config.connectionString,
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      max: config.poolMax ?? DEFAULTS.poolMax,
      idleTimeoutMillis: config.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      connectionTimeoutMillis: config.connectionTimeoutMs ?? DEFAULTS.connectionTimeoutMs,
      statement_timeout: config.statementTimeoutMs ?? DEFAULTS.statementTimeoutMs,
      options: options.length > 0 ? options.join(' ') : undefined,
      types
    })

    // A pool emits 'error' for a connection that dies while idle. Without a
    // listener that is an unhandled 'error' event, which takes the process
    // down — a relay must survive its database being restarted underneath it.
    this.pool.on('error', (err) => {
      this.lastError = err
    })

    this.lastError = null
    this.ended = false
  }

  async query (sql, params) {
    return this.pool.query(sql, params)
  }

  async connect () {
    return this.pool.connect()
  }

  async end () {
    if (this.ended) return
    this.ended = true
    await this.pool.end()
  }
}

/**
 * Build a pool, or adopt one the caller already has.
 *
 * Passing `pool` is how the integration tests share one container across
 * suites, and how an embedding application can hand over a pool it already
 * manages (its own metrics, its own shutdown ordering).
 */
function createPool (config = {}) {
  if (config.pool !== undefined && config.pool !== null) {
    const pool = config.pool
    if (typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw StoreError.invalid('opts.pool must expose query() and connect()')
    }
    return pool
  }
  return new PgPool(config)
}

module.exports = { PgPool, createPool, INT8_OID }
