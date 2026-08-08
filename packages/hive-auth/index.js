'use strict'

const nip42 = require('./lib/nip42')
const nip98 = require('./lib/nip98')
const scopes = require('./lib/scopes')
const ratelimit = require('./lib/ratelimit')

/**
 * Gate that runs after a signature verifies but before a connection is trusted.
 *
 * Both checks fail closed: a store error denies the connection rather than
 * letting it through, and the reason returned to the client is deliberately
 * generic so it never reveals which gate rejected them.
 */
class AccessPolicy {
  constructor (store, opts = {}) {
    this.store = store
    this.requireAllowlist = opts.requireAllowlist === true
    this.requireRelayMembership = opts.requireRelayMembership === true
  }

  check (pubkey) {
    if (!this.requireAllowlist && !this.requireRelayMembership) return { ok: true, reason: null }

    try {
      if (this.requireAllowlist && !this.store.isPubkeyAllowed(pubkey)) {
        return { ok: false, reason: 'auth-required: verification failed' }
      }
      if (this.requireRelayMembership && this.store.getRelayMember(pubkey) === null) {
        return { ok: false, reason: 'auth-required: verification failed' }
      }
      return { ok: true, reason: null }
    } catch {
      return { ok: false, reason: 'auth-required: verification failed' }
    }
  }
}

module.exports = {
  ...nip42,
  ...nip98,
  ...scopes,
  ...ratelimit,
  AccessPolicy
}
