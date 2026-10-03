'use strict'

// Transports register under a name and a set of URL schemes. The relay side
// is chosen by name (configuration), the client side by the scheme of the
// address being dialed. A transport nobody dials (relay-to-relay replication)
// registers a server half and no schemes.

const definitions = new Map()

/**
 * @typedef {object} TransportDefinition
 * @property {string} id  Registry name, used in configuration.
 * @property {string[]} schemes  URL schemes clients dial, without `://`. Empty
 *   only for a transport with no client half.
 * @property {object} capabilities  What the transport provides.
 * @property {boolean} capabilities.encrypted  The link itself is encrypted.
 * @property {boolean} capabilities.http  The same port also serves the REST bridge.
 * @property {typeof import('./transport').Transport} [Server]
 * @property {typeof import('./transport').TransportClient} [Client]
 */

/**
 * Add a transport. Throws when the id or a scheme is already taken, so two
 * transports cannot silently shadow each other.
 *
 * @param {TransportDefinition} definition
 */
function registerTransport (definition) {
  const { id, schemes, capabilities, Server = null, Client = null } = definition

  if (typeof id !== 'string' || id === '') throw new Error('transport id must be a non-empty string')
  if (Server === null && Client === null) throw new Error(`transport ${id}: provide a Server, a Client, or both`)
  if (!Array.isArray(schemes)) throw new Error(`transport ${id}: schemes must be an array`)
  if (schemes.length === 0 && Client !== null) throw new Error(`transport ${id}: schemes must be a non-empty array when there is a Client`)
  if (definitions.has(id)) throw new Error(`transport ${id} is already registered`)

  for (const scheme of schemes) {
    const owner = schemeOwner(scheme)
    if (owner !== null) throw new Error(`transport ${id}: scheme ${scheme}:// is already used by ${owner.id}`)
  }

  definitions.set(id, Object.freeze({
    id,
    schemes: Object.freeze([...schemes]),
    capabilities: Object.freeze({ encrypted: false, http: false, ...capabilities }),
    Server,
    Client
  }))
}

/** Remove a transport. Meant for tests; returns whether it was registered. */
function unregisterTransport (id) {
  return definitions.delete(id)
}

function schemeOwner (scheme) {
  for (const definition of definitions.values()) {
    if (definition.schemes.includes(scheme)) return definition
  }
  return null
}

function getTransport (id) {
  const definition = definitions.get(id)
  if (definition === undefined) {
    throw new Error(`unknown transport "${id}" (registered: ${[...definitions.keys()].join(', ')})`)
  }
  return definition
}

/** Every registered definition, in registration order. */
function listTransports () {
  return [...definitions.values()]
}

/**
 * Build the server half of a registered transport.
 *
 * @param {string} id
 * @param {import('../relay').Relay} relay
 * @param {object} [opts]
 */
function createTransport (id, relay, opts = {}) {
  const { Server } = getTransport(id)
  if (Server === null) throw new Error(`transport ${id} has no server side`)
  return new Server(relay, opts)
}

/**
 * Build the client half that matches an address such as `hyper://<key>` or
 * `ws://host:3000`.
 *
 * @param {string} address
 * @param {object} [opts]
 */
function createClient (address, opts = {}) {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(address)
  if (match === null) throw new Error(`not a transport address: ${address}`)

  const definition = schemeOwner(match[1].toLowerCase())
  if (definition === null || definition.Client === null) {
    throw new Error(`no client transport for ${match[1]}:// (registered: ${listTransports().filter((d) => d.Client !== null).map((d) => d.schemes.join('|')).join(', ')})`)
  }
  return new definition.Client(opts)
}

module.exports = {
  registerTransport,
  unregisterTransport,
  getTransport,
  listTransports,
  createTransport,
  createClient
}
