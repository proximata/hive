'use strict'

class StoreError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }

  static authEventForbidden () {
    return new StoreError('AUTH_EVENT_FORBIDDEN', 'kind 22242 auth events are never stored')
  }

  static ephemeralForbidden (kind) {
    return new StoreError('EPHEMERAL_FORBIDDEN', `kind ${kind} is ephemeral and is never stored`)
  }

  static notFound (what) {
    return new StoreError('NOT_FOUND', `${what} not found`)
  }

  static conflict (message) {
    return new StoreError('CONFLICT', message)
  }

  static invalid (message) {
    return new StoreError('INVALID', message)
  }

  static chainBroken (seq, message) {
    const err = new StoreError('CHAIN_BROKEN', message)
    err.seq = seq
    return err
  }
}

module.exports = { StoreError }
