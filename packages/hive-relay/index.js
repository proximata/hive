'use strict'

const { Relay, Connection, MAX_FILTERS_PER_REQ, MAX_CREATED_AT_DRIFT_S } = require('./lib/relay')
const { SubscriptionRegistry, channelsFromFilters } = require('./lib/subscriptions')
const protocol = require('./lib/protocol')
const handlers = require('./lib/handlers')
const { MediaStore } = require('./lib/media')
const { MAX_AUDIT_ENTRIES } = require('./lib/rest')
const { WebSocketTransport } = require('./lib/transports/ws')
const { SwarmTransport } = require('./lib/transports/swarm')
const { resolveBind, resolveBootstrap, isLoopback, DEFAULT_HOST, DEFAULT_PORT } = require('./lib/bind')

module.exports = {
  Relay,
  Connection,
  MAX_FILTERS_PER_REQ,
  MAX_CREATED_AT_DRIFT_S,
  MAX_AUDIT_ENTRIES,
  SubscriptionRegistry,
  channelsFromFilters,
  protocol,
  handlers,
  MediaStore,
  WebSocketTransport,
  SwarmTransport,
  resolveBind,
  resolveBootstrap,
  isLoopback,
  DEFAULT_HOST,
  DEFAULT_PORT
}
