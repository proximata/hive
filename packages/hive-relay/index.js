'use strict'

const { Relay, Connection, MAX_FILTERS_PER_REQ, MAX_CREATED_AT_DRIFT_S } = require('./lib/relay')
const { SubscriptionRegistry, channelsFromFilters } = require('./lib/subscriptions')
const protocol = require('./lib/protocol')
const handlers = require('./lib/handlers')
const { MediaStore } = require('./lib/media')
const { WebSocketTransport } = require('./lib/transports/ws')
const { SwarmTransport } = require('./lib/transports/swarm')
const { resolveBind, isLoopback, DEFAULT_HOST, DEFAULT_PORT } = require('./lib/bind')

module.exports = {
  Relay,
  Connection,
  MAX_FILTERS_PER_REQ,
  MAX_CREATED_AT_DRIFT_S,
  SubscriptionRegistry,
  channelsFromFilters,
  protocol,
  handlers,
  MediaStore,
  WebSocketTransport,
  SwarmTransport,
  resolveBind,
  isLoopback,
  DEFAULT_HOST,
  DEFAULT_PORT
}
