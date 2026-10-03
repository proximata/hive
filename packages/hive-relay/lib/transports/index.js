'use strict'

const registry = require('./registry')
const { Transport, TransportClient } = require('./transport')
const { WebSocketTransport, WebSocketClient } = require('./ws')
const { SwarmTransport, SwarmClient } = require('./swarm')
const { ReplicationTransport } = require('./replication')
const { LoopbackTransport, LoopbackClient } = require('./loopback')

registry.registerTransport({
  id: 'ws',
  schemes: ['ws', 'http'],
  capabilities: { encrypted: false, http: true },
  Server: WebSocketTransport,
  Client: WebSocketClient
})

registry.registerTransport({
  id: 'swarm',
  schemes: ['hyper'],
  capabilities: { encrypted: true, http: false },
  Server: SwarmTransport,
  Client: SwarmClient
})

// Relay to relay, not client to relay: nothing dials it, so it has no client
// half and claims no scheme (its link is a hyper:// feed key, but `hyper://`
// belongs to `swarm`). It needs a storage directory and a group name; see
// docs/transports.md.
registry.registerTransport({
  id: 'replication',
  schemes: [],
  capabilities: { encrypted: true, http: false },
  Server: ReplicationTransport
})

registry.registerTransport({
  id: 'loopback',
  schemes: ['loopback'],
  capabilities: { encrypted: false, http: false },
  Server: LoopbackTransport,
  Client: LoopbackClient
})

module.exports = {
  ...registry,
  Transport,
  TransportClient,
  WebSocketTransport,
  WebSocketClient,
  SwarmTransport,
  SwarmClient,
  ReplicationTransport,
  LoopbackTransport,
  LoopbackClient
}
