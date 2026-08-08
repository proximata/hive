'use strict'

const { normalizeFilter, LIMITS } = require('hive-core')

// NIP-01 wire messages. Parsing is deliberately strict: a malformed frame gets
// a NOTICE, never a stack trace, and never a half-registered subscription.

class ProtocolError extends Error {
  constructor (message) {
    super(message)
    this.name = 'ProtocolError'
  }
}

function parseClientMessage (raw) {
  if (typeof raw !== 'string') raw = String(raw)
  if (raw.length > LIMITS.MAX_FRAME_BYTES) {
    throw new ProtocolError(`frame exceeds ${LIMITS.MAX_FRAME_BYTES} bytes`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ProtocolError('frame is not valid JSON')
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== 'string') {
    throw new ProtocolError('frame must be a JSON array beginning with a message type')
  }

  const type = parsed[0].toUpperCase()

  switch (type) {
    case 'EVENT': {
      if (typeof parsed[1] !== 'object' || parsed[1] === null) {
        throw new ProtocolError('EVENT requires an event object')
      }
      return { type, event: parsed[1] }
    }

    case 'AUTH': {
      if (typeof parsed[1] !== 'object' || parsed[1] === null) {
        throw new ProtocolError('AUTH requires an event object')
      }
      return { type, event: parsed[1] }
    }

    case 'REQ':
    case 'COUNT': {
      const subId = parsed[1]
      if (typeof subId !== 'string' || subId.length === 0 || subId.length > 64) {
        throw new ProtocolError(`${type} requires a subscription id of 1-64 characters`)
      }

      const filters = []
      for (const raw of parsed.slice(2)) {
        const filter = normalizeFilter(raw)
        if (filter === null) throw new ProtocolError(`${type} contains a malformed filter`)
        filters.push(filter)
      }
      // A REQ with no filters would mean "everything", which no client wants
      // and every relay would regret.
      if (filters.length === 0) throw new ProtocolError(`${type} requires at least one filter`)

      return { type, subId, filters }
    }

    case 'CLOSE': {
      if (typeof parsed[1] !== 'string') throw new ProtocolError('CLOSE requires a subscription id')
      return { type, subId: parsed[1] }
    }

    default:
      throw new ProtocolError(`unknown message type: ${parsed[0]}`)
  }
}

const encode = {
  event: (subId, event) => JSON.stringify(['EVENT', subId, event]),
  eose: (subId) => JSON.stringify(['EOSE', subId]),
  ok: (id, accepted, reason = '') => JSON.stringify(['OK', id, accepted, reason]),
  closed: (subId, reason) => JSON.stringify(['CLOSED', subId, reason]),
  notice: (message) => JSON.stringify(['NOTICE', message]),
  auth: (challenge) => JSON.stringify(['AUTH', challenge]),
  count: (subId, count) => JSON.stringify(['COUNT', subId, { count }])
}

/** Parse a relay→client frame. Used by the client library and by tests. */
function parseRelayMessage (raw) {
  const parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw))
  if (!Array.isArray(parsed)) throw new ProtocolError('relay message must be an array')

  switch (parsed[0]) {
    case 'EVENT': return { type: 'EVENT', subId: parsed[1], event: parsed[2] }
    case 'EOSE': return { type: 'EOSE', subId: parsed[1] }
    case 'OK': return { type: 'OK', id: parsed[1], accepted: parsed[2], reason: parsed[3] ?? '' }
    case 'CLOSED': return { type: 'CLOSED', subId: parsed[1], reason: parsed[2] ?? '' }
    case 'NOTICE': return { type: 'NOTICE', message: parsed[1] }
    case 'AUTH': return { type: 'AUTH', challenge: parsed[1] }
    case 'COUNT': return { type: 'COUNT', subId: parsed[1], count: parsed[2]?.count ?? 0 }
    default: throw new ProtocolError(`unknown relay message type: ${parsed[0]}`)
  }
}

module.exports = { parseClientMessage, parseRelayMessage, encode, ProtocolError }
