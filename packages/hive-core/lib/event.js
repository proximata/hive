'use strict'

require('./platform')

const { schnorr } = require('@noble/curves/secp256k1.js')
const { sha256 } = require('@noble/hashes/sha2.js')
const b4a = require('b4a')

const bech32 = require('./bech32')

const HEX32 = /^[0-9a-f]{64}$/
const HEX64 = /^[0-9a-f]{128}$/

function toHex (bytes) {
  return b4a.toString(b4a.from(bytes), 'hex')
}

function fromHex (hex) {
  return Uint8Array.from(b4a.from(hex, 'hex'))
}

/**
 * The NIP-01 canonical serialization — the exact bytes that are SHA-256'd to
 * produce the event id:
 *
 *   [0,"<pubkey>",<created_at>,<kind>,<tags>,"<content>"]
 *
 * JSON.stringify produces precisely the escaping NIP-01 requires (\n \" \\ \r
 * \t \b \f, everything else literal UTF-8), which is what every other
 * implementation relies on. Do not reformat this.
 */
function serializeEvent (event) {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ])
}

function getEventHash (event) {
  return toHex(sha256(b4a.from(serializeEvent(event), 'utf8')))
}

/** Shape check only — no crypto. Returns null when valid, else a reason string. */
function validateEventShape (event) {
  if (event === null || typeof event !== 'object') return 'event must be an object'
  if (!HEX32.test(event.id ?? '')) return 'id must be 64 lowercase hex characters'
  if (!HEX32.test(event.pubkey ?? '')) return 'pubkey must be 64 lowercase hex characters'
  if (!HEX64.test(event.sig ?? '')) return 'sig must be 128 lowercase hex characters'
  if (!Number.isInteger(event.kind) || event.kind < 0 || event.kind > 0xffffffff) {
    return 'kind must be an unsigned integer'
  }
  if (!Number.isInteger(event.created_at)) return 'created_at must be an integer'
  if (typeof event.content !== 'string') return 'content must be a string'
  if (!Array.isArray(event.tags)) return 'tags must be an array'
  for (const tag of event.tags) {
    if (!Array.isArray(tag)) return 'each tag must be an array'
    for (const item of tag) {
      if (typeof item !== 'string') return 'tag items must be strings'
    }
  }
  return null
}

/**
 * Full verification: shape, id recomputation, then Schnorr signature.
 *
 * The id is checked independently of the signature so a forged id over valid
 * content is caught even when the signature verifies against the real id.
 */
function verifyEvent (event) {
  const shape = validateEventShape(event)
  if (shape !== null) return { ok: false, reason: shape }

  if (getEventHash(event) !== event.id) {
    return { ok: false, reason: 'id does not match the canonical event hash' }
  }

  let valid = false
  try {
    valid = schnorr.verify(fromHex(event.sig), fromHex(event.id), fromHex(event.pubkey))
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: 'invalid schnorr signature' }

  return { ok: true, reason: null }
}

function generateSecretKey () {
  return schnorr.utils.randomSecretKey()
}

function getPublicKey (secretKey) {
  const sk = typeof secretKey === 'string' ? fromHex(secretKey) : secretKey
  return toHex(schnorr.getPublicKey(sk))
}

/**
 * Fill in pubkey, created_at, id and sig on a partial event.
 * `template` supplies kind, tags and content; anything already set is kept.
 */
function finalizeEvent (template, secretKey) {
  const sk = typeof secretKey === 'string' ? fromHex(secretKey) : secretKey
  const event = {
    pubkey: getPublicKey(sk),
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
    kind: template.kind,
    tags: template.tags ?? [],
    content: template.content ?? ''
  }
  event.id = getEventHash(event)
  event.sig = toHex(schnorr.sign(fromHex(event.id), sk))
  return event
}

/** Sign an arbitrary message hash — used by NIP-OA attestations. */
function signHash (hash, secretKey) {
  const sk = typeof secretKey === 'string' ? fromHex(secretKey) : secretKey
  return toHex(schnorr.sign(typeof hash === 'string' ? fromHex(hash) : hash, sk))
}

function verifyHash (hash, sig, pubkey) {
  try {
    return schnorr.verify(
      typeof sig === 'string' ? fromHex(sig) : sig,
      typeof hash === 'string' ? fromHex(hash) : hash,
      typeof pubkey === 'string' ? fromHex(pubkey) : pubkey
    )
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ NIP-19 --

function encodeNpub (pubkeyHex) {
  return bech32.encodeBytes('npub', fromHex(pubkeyHex))
}

function encodeNsec (secretKey) {
  return bech32.encodeBytes('nsec', typeof secretKey === 'string' ? fromHex(secretKey) : secretKey)
}

function encodeNote (idHex) {
  return bech32.encodeBytes('note', fromHex(idHex))
}

/**
 * Accept a key in either bech32 or hex form and return lowercase hex.
 * `expectedHrp` guards against passing an npub where an nsec is required.
 */
function decodeKey (value, expectedHrp) {
  if (typeof value !== 'string') throw new Error('key must be a string')
  const trimmed = value.trim()

  if (HEX32.test(trimmed.toLowerCase())) return trimmed.toLowerCase()

  const { hrp, bytes } = bech32.decodeBytes(trimmed)
  if (expectedHrp !== undefined && hrp !== expectedHrp) {
    throw new Error(`expected a ${expectedHrp} key but got ${hrp}`)
  }
  if (bytes.length !== 32) throw new Error('key must decode to 32 bytes')
  return toHex(bytes)
}

module.exports = {
  serializeEvent,
  getEventHash,
  validateEventShape,
  verifyEvent,
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  signHash,
  verifyHash,
  encodeNpub,
  encodeNsec,
  encodeNote,
  decodeKey,
  toHex,
  fromHex,
  sha256
}
