'use strict'

// The Bare-side resolution of `#pg` (see this package's `imports` map).
//
// `pg` is a Node library — net, tls, stream, crypto — and the worker is
// statically bundled, so a `try { require('pg') } catch {}` would be resolved
// at bundle time and break the Bare build rather than degrade gracefully. The
// same trick the store already uses for `#sqlite` applies here in reverse:
// Bare gets this stub, Node gets the real driver.
//
// Nothing throws at require time, because `index.js` loads the Postgres driver
// eagerly; the failure has to happen when someone actually tries to connect.

const { StoreError } = require('../errors')

function unavailable () {
  throw StoreError.invalid(
    'the postgres store driver is not available on Bare — run the relay under Node, ' +
    'or use the sqlite driver'
  )
}

class Pool {
  constructor () {
    unavailable()
  }
}

module.exports = { Pool, types: { getTypeParser: unavailable }, unavailable }
