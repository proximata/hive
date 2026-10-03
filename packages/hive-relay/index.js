'use strict'

const { Relay, Connection, MAX_FILTERS_PER_REQ, MAX_CREATED_AT_DRIFT_S } = require('./lib/relay')
const { SubscriptionRegistry, channelsFromFilters } = require('./lib/subscriptions')
const protocol = require('./lib/protocol')
const handlers = require('./lib/handlers')
const { MediaStore } = require('./lib/media')
const { MAX_AUDIT_ENTRIES } = require('./lib/rest')
const transports = require('./lib/transports')
const { replicationKeyPair, replicationTopic } = require('./lib/transports/replication')
const { resolveBind, resolveBootstrap, resolveReplication, resolveTransports, isLoopback, DEFAULT_HOST, DEFAULT_PORT } = require('./lib/bind')

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
  transports,
  Transport: transports.Transport,
  TransportClient: transports.TransportClient,
  WebSocketTransport: transports.WebSocketTransport,
  SwarmTransport: transports.SwarmTransport,
  ReplicationTransport: transports.ReplicationTransport,
  replicationKeyPair,
  replicationTopic,
  resolveBind,
  resolveBootstrap,
  resolveReplication,
  resolveTransports,
  isLoopback,
  DEFAULT_HOST,
  DEFAULT_PORT
}
