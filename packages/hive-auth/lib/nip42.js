'use strict'

const {
  verifyEvent,
  finalizeEvent,
  tagValue,
  KIND_AUTH,
  LIMITS,
  toHex
} = require('hive-core')

const { AuthContext, allScopes } = require('./scopes')

function randomChallenge () {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  return toHex(bytes)
}

/**
 * Strip trailing slashes without a regex: `/\/+$/` retries from every slash in
 * a long run, which is quadratic on input the client controls.
 */
function trimTrailingSlashes (value) {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return value.slice(0, end)
}

/**
 * Compare relay URLs the way NIP-42 intends: scheme and trailing slashes are
 * cosmetic, the host is what matters. Ignoring the scheme keeps clients working
 * that connect over ws:// but were told about http://. The host comparison
 * stays exact, since a looser one would let a challenge signed for another
 * relay be replayed at this one.
 */
function sameRelay (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false

  const normalize = (value) => {
    try {
      const url = new URL(value.replace(/^ws/, 'http'))
      return url.host.toLowerCase()
    } catch {
      return trimTrailingSlashes(value.replace(/^\w+:\/\//, '')).toLowerCase()
    }
  }

  return normalize(a) === normalize(b)
}

/**
 * Verify a NIP-42 AUTH response.
 * Returns `{ ok, context, reason }`.
 */
function verifyAuthEvent (event, { challenge, relayUrl, tolerance = LIMITS.AUTH_TIMESTAMP_TOLERANCE_S, now }) {
  const at = now ?? Math.floor(Date.now() / 1000)

  if (event === null || typeof event !== 'object') {
    return { ok: false, context: null, reason: 'auth-required: malformed auth event' }
  }
  if (event.kind !== KIND_AUTH) {
    return { ok: false, context: null, reason: `auth-required: auth event must be kind ${KIND_AUTH}` }
  }

  // Timestamp first: it is the cheapest check and bounds replay windows.
  if (Math.abs(at - event.created_at) > tolerance) {
    return { ok: false, context: null, reason: 'auth-required: auth event timestamp out of tolerance' }
  }

  const eventChallenge = tagValue(event, 'challenge')
  if (eventChallenge === null || eventChallenge !== challenge) {
    return { ok: false, context: null, reason: 'auth-required: challenge mismatch' }
  }

  if (relayUrl !== undefined && relayUrl !== null) {
    const eventRelay = tagValue(event, 'relay')
    if (eventRelay === null || !sameRelay(eventRelay, relayUrl)) {
      return { ok: false, context: null, reason: 'auth-required: relay mismatch' }
    }
  }

  const verified = verifyEvent(event)
  if (!verified.ok) {
    return { ok: false, context: null, reason: `auth-required: ${verified.reason}` }
  }

  return {
    ok: true,
    context: new AuthContext({ pubkey: event.pubkey, scopes: allScopes(), method: 'nip42' }),
    reason: null
  }
}

/** Client side: sign the relay's challenge. */
function buildAuthEvent ({ challenge, relayUrl, secretKey, created_at: createdAt }) {
  return finalizeEvent(
    {
      kind: KIND_AUTH,
      created_at: createdAt,
      tags: [
        ['relay', relayUrl],
        ['challenge', challenge]
      ],
      content: ''
    },
    secretKey
  )
}

module.exports = { randomChallenge, verifyAuthEvent, buildAuthEvent, sameRelay }
