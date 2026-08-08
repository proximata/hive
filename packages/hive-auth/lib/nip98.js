'use strict'

const b4a = require('b4a')
const {
  verifyEvent,
  finalizeEvent,
  tagValue,
  sha256,
  toHex,
  KIND_HTTP_AUTH,
  LIMITS
} = require('hive-core')

const { AuthContext, allScopes } = require('./scopes')

/**
 * NIP-98 binds a signature to one HTTP request: the `u` tag is the URL and the
 * `method` tag the verb. Without both, a signed event captured from a GET could
 * be replayed against a DELETE.
 */
function validateNip98 (header, { url, method, tolerance = LIMITS.AUTH_TIMESTAMP_TOLERANCE_S, now, body }) {
  const at = now ?? Math.floor(Date.now() / 1000)

  if (typeof header !== 'string' || !header.toLowerCase().startsWith('nostr ')) {
    return { ok: false, context: null, reason: 'missing or malformed Authorization header' }
  }

  let event
  try {
    event = JSON.parse(b4a.toString(b4a.from(header.slice(6).trim(), 'base64'), 'utf8'))
  } catch {
    return { ok: false, context: null, reason: 'authorization payload is not base64 JSON' }
  }

  if (event.kind !== KIND_HTTP_AUTH) {
    return { ok: false, context: null, reason: `auth event must be kind ${KIND_HTTP_AUTH}` }
  }
  if (Math.abs(at - event.created_at) > tolerance) {
    return { ok: false, context: null, reason: 'auth event timestamp out of tolerance' }
  }

  const u = tagValue(event, 'u')
  if (u === null || !sameUrl(u, url)) {
    return { ok: false, context: null, reason: 'auth event url does not match the request' }
  }

  const eventMethod = tagValue(event, 'method')
  if (eventMethod === null || eventMethod.toUpperCase() !== String(method).toUpperCase()) {
    return { ok: false, context: null, reason: 'auth event method does not match the request' }
  }

  // The payload tag is optional in NIP-98, but when present it must be correct:
  // a stale hash means the body was swapped after signing.
  const payload = tagValue(event, 'payload')
  if (payload !== null && body !== undefined && body !== null) {
    const digest = toHex(sha256(b4a.isBuffer(body) ? body : b4a.from(body)))
    if (digest !== payload) {
      return { ok: false, context: null, reason: 'auth event payload hash does not match the body' }
    }
  }

  const verified = verifyEvent(event)
  if (!verified.ok) return { ok: false, context: null, reason: verified.reason }

  return {
    ok: true,
    context: new AuthContext({ pubkey: event.pubkey, scopes: allScopes(), method: 'nip98' }),
    reason: null
  }
}

function sameUrl (a, b) {
  const normalize = (value) => {
    try {
      const url = new URL(value)
      // Ignore the fragment, keep everything the server actually routes on.
      return `${url.protocol}//${url.host}${url.pathname}${url.search}`.replace(/\/$/, '')
    } catch {
      return String(value).replace(/\/$/, '')
    }
  }
  return normalize(a) === normalize(b)
}

/** Client side: produce the `Authorization: Nostr <base64>` header value. */
function buildNip98Header ({ url, method, secretKey, body, created_at: createdAt }) {
  const tags = [
    ['u', url],
    ['method', String(method).toUpperCase()]
  ]
  if (body !== undefined && body !== null) {
    tags.push(['payload', toHex(sha256(b4a.isBuffer(body) ? body : b4a.from(body)))])
  }

  const event = finalizeEvent({ kind: KIND_HTTP_AUTH, created_at: createdAt, tags, content: '' }, secretKey)
  return 'Nostr ' + b4a.toString(b4a.from(JSON.stringify(event), 'utf8'), 'base64')
}

module.exports = { validateNip98, buildNip98Header, sameUrl }
