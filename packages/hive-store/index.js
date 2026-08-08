'use strict'

const { SqliteStore, SCHEMA_VERSION, supersedes } = require('./lib/sqlite-store')
const { StoreError } = require('./lib/errors')
const search = require('./lib/search')
const audit = require('./lib/audit')
const query = require('./lib/query')

/**
 * Open a store. `driver` exists so a Postgres implementation can be dropped in
 * without touching a single call site — no SQLite value ever crosses this
 * boundary.
 */
function openStore (location = ':memory:', opts = {}) {
  const driver = opts.driver ?? 'sqlite'
  if (driver !== 'sqlite') throw StoreError.invalid(`unknown store driver: ${driver}`)
  return new SqliteStore(location, opts)
}

module.exports = {
  openStore,
  SqliteStore,
  StoreError,
  SCHEMA_VERSION,
  supersedes,
  search,
  audit,
  query
}
