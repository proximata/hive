'use strict'

require('./lib/platform')

const kinds = require('./lib/kinds')
const event = require('./lib/event')
const filter = require('./lib/filter')
const tags = require('./lib/tags')
const net = require('./lib/net')
const bech32 = require('./lib/bech32')
const attestation = require('./lib/attestation')

// Protocol limits (SPEC.md §3.2). Shared so relay, client and tests cannot
// drift apart on them.
const LIMITS = {
  MAX_FRAME_BYTES: 65536,
  MAX_SUBSCRIPTIONS: 1024,
  MAX_HISTORICAL_LIMIT: 500,
  FEED_MAX_LIMIT: 100,
  MAX_CONNECTIONS: 1024,
  MAX_CONCURRENT_HANDLERS: 1024,
  SLOW_CLIENT_GRACE_LIMIT: 3,
  HEARTBEAT_INTERVAL_MS: 30000,
  MISSED_PONG_LIMIT: 3,
  AUTH_TIMESTAMP_TOLERANCE_S: 60,
  PRESENCE_TTL_S: 180,
  TYPING_WINDOW_S: 5,
  MAX_MEDIA_BYTES: 50 * 1024 * 1024,
  MAX_CONTENT_BYTES: 65536
}

module.exports = {
  ...kinds,
  ...event,
  ...filter,
  ...tags,
  ...net,
  ...attestation,
  bech32,
  LIMITS
}
