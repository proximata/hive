'use strict'

const { decodeKey, LIMITS } = require('hive-core')
const { CliError } = require('./errors')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX32 = /^[0-9a-f]{64}$/i

function required (value, name) {
  if (value === undefined || value === null || value === '') {
    throw new CliError('user', `--${name} is required`)
  }
  return value
}

function channelId (value) {
  required(value, 'channel')
  if (!UUID.test(value)) throw new CliError('user', `--channel must be a UUID, got: ${value}`)
  return value.toLowerCase()
}

function eventId (value, name = 'event') {
  required(value, name)
  if (!HEX32.test(value)) throw new CliError('user', `--${name} must be a 64-character hex event id`)
  return value.toLowerCase()
}

/** Accepts hex or npub and normalizes to hex. */
function pubkey (value, name = 'pubkey') {
  required(value, name)
  try {
    return decodeKey(value, value.startsWith('npub') ? 'npub' : undefined)
  } catch (err) {
    throw new CliError('user', `--${name} is not a valid public key: ${err.message}`)
  }
}

function secretKey (value) {
  if (value === undefined || value === null || value === '') {
    throw new CliError('auth', 'set HIVE_PRIVATE_KEY (or BUZZ_PRIVATE_KEY) to an nsec or 64-character hex key')
  }
  try {
    // Bech32 input must be an nsec: without pinning the prefix an npub decodes
    // to 32 valid-looking bytes and would silently be used as a secret key.
    return decodeKey(value, value.startsWith('n') ? 'nsec' : undefined)
  } catch (err) {
    throw new CliError('auth', `HIVE_PRIVATE_KEY is not a valid secret key: ${err.message}`)
  }
}

function content (value, name = 'content') {
  required(value, name)
  if (Buffer.byteLength(value) > LIMITS.MAX_CONTENT_BYTES) {
    throw new CliError('user', `--${name} exceeds ${LIMITS.MAX_CONTENT_BYTES} bytes`)
  }
  return value
}

function oneOf (value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new CliError('user', `--${name} must be one of: ${allowed.join(', ')}`)
  }
  return value
}

function integer (value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new CliError('user', `--${name} must be an integer between ${min} and ${max}`)
  }
  return n
}

module.exports = { required, channelId, eventId, pubkey, secretKey, content, oneOf, integer, UUID, HEX32 }
