'use strict'

// Where the relay listens, and what it calls itself from outside.
//
// This is one function rather than a few lines in bin.mjs because the default
// it encodes is a security default. A relay that binds 0.0.0.0 by accident puts
// a write endpoint on the network; a second copy of this logic somewhere else
// would eventually disagree about which of the two defaults is the safe one.
// test/relay.js asserts against this module, so the regression is caught here
// rather than by whoever notices their laptop relay answering from the LAN.
//
// Binding beyond loopback is therefore never implied: only an explicit
// `--host` / `HIVE_RELAY_HOST` does it, and no other flag changes it.

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3000

const LOOPBACK_NAMES = new Set(['localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1'])

/** True for anything that can only be reached from this machine. */
function isLoopback (host) {
  const value = String(host).toLowerCase()
  return LOOPBACK_NAMES.has(value) || /^127\./.test(value)
}

/**
 * Resolve the listen address from parsed flags and the environment.
 *
 * Flag beats env beats default, which is the usual precedence and the one the
 * rest of the CLI already follows. Returns
 * `{ host, port, publicUrl, loopback }`; `publicUrl` is ws-shaped (`ws://` or
 * `wss://`) because that is what `relay.url` holds, and rest.js turns it back
 * into http by swapping the scheme prefix.
 *
 * Throws on anything malformed rather than falling back to a default: a typo in
 * `--host` silently becoming 127.0.0.1 would make a deploy look healthy while
 * being unreachable, and a typo becoming 0.0.0.0 would be worse.
 */
function resolveBind (flags = {}, env = {}) {
  const host = one(flags.host, env.HIVE_RELAY_HOST, DEFAULT_HOST, '--host')
  // Addresses and hostnames only. The value reaches server.listen(), not the
  // filesystem or a shell, so this is a fail-fast check and not a sandbox.
  if (!/^[A-Za-z0-9._:[\]-]+$/.test(host)) {
    throw new Error(`--host must be an address or hostname, got ${JSON.stringify(host)}`)
  }

  const port = Number(one(flags.port, env.HIVE_RELAY_PORT, String(DEFAULT_PORT), '--port'))
  // 0 is meaningful (pick an ephemeral port), so this cannot use `|| 3000` the
  // way the old inline version did — that turned `--port 0` into 3000.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be an integer 0-65535, got ${JSON.stringify(port)}`)
  }

  const raw = flags.publicUrl ?? env.HIVE_PUBLIC_URL ?? null
  const publicUrl = raw === null ? null : publicOrigin(one(raw, null, null, '--public-url'))

  return { host, port, publicUrl, loopback: isLoopback(host) }
}

/**
 * Normalise the origin clients actually reach, e.g. behind a TLS proxy.
 *
 * Needed because NIP-98 compares the signed `u` tag against the URL the relay
 * derives from `relay.url`, character for character. Without this the browser
 * signs `https://hive.example.com/api/channels`, the relay derives
 * `http://0.0.0.0:3000/api/channels`, and every authenticated call 401s.
 */
function publicOrigin (value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`--public-url must be an absolute URL, got ${JSON.stringify(value)}`)
  }

  const scheme = { 'http:': 'ws:', 'https:': 'wss:', 'ws:': 'ws:', 'wss:': 'wss:' }[url.protocol]
  if (scheme === undefined) {
    throw new Error(`--public-url scheme must be http, https, ws or wss, got ${JSON.stringify(url.protocol)}`)
  }
  // An origin, not a mount point. A path prefix would be silently dropped when
  // rest.js resolves request URLs against it, so refuse it out loud instead.
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`--public-url must be an origin with no path, got ${JSON.stringify(url.pathname)}`)
  }

  return `${scheme}//${url.host}`
}

/**
 * Resolve the DHT bootstrap list from `--bootstrap` / `HIVE_DHT_BOOTSTRAP`.
 *
 * Returns `undefined` when neither is given, which is not the same as an empty
 * list: hyperdht does `opts.bootstrap || BOOTSTRAP_NODES` (hyperdht/index.js:28),
 * so `[]` would silently mean "the three public nodes" and hide an operator
 * typo. `undefined` is the untouched default path.
 *
 * The value is a comma-separated list of `host:port`, e.g.
 * `HIVE_DHT_BOOTSTRAP=192.168.1.10:49737`. A malformed entry throws here, at
 * startup, rather than at the first dial — a LAN deployment whose bootstrap
 * address is wrong should refuse to boot, not look healthy and never discover
 * a peer.
 *
 * ponytail: one flat list, no health checks, no failover ordering, no
 * auto-publication. Upgrade path if that bites: carry the list wherever the
 * relay's public URL already comes from, not a new config file for one value.
 */
function resolveBootstrap (flags = {}, env = {}) {
  const raw = flags.bootstrap ?? env.HIVE_DHT_BOOTSTRAP ?? null
  if (raw === null) return undefined

  const value = one(raw, null, null, '--bootstrap')
  const entries = value.split(',').map((entry) => entry.trim())
  for (const entry of entries) {
    // `host:port`, where host may be an IPv4 address or a hostname, optionally
    // prefixed `ip@host` the way hyperdht's own defaults are written.
    if (!/^(?:[0-9.]+@)?[A-Za-z0-9._-]+:\d{1,5}$/.test(entry)) {
      throw new Error(`--bootstrap entries must be host:port, got ${JSON.stringify(entry)}`)
    }
    const port = Number(entry.slice(entry.lastIndexOf(':') + 1))
    if (port < 1 || port > 65535) {
      throw new Error(`--bootstrap port must be 1-65535, got ${JSON.stringify(entry)}`)
    }
  }

  return entries
}

/** First supplied value, rejecting the shapes parseArgs produces for a flag with no argument. */
function one (flag, fromEnv, fallback, label) {
  const value = flag ?? fromEnv ?? fallback
  if (value === null || value === undefined) throw new Error(`${label} requires a value`)
  if (typeof value !== 'string') throw new Error(`${label} requires a value`)
  if (value === '') throw new Error(`${label} requires a value`)
  return value
}

module.exports = { resolveBind, resolveBootstrap, isLoopback, DEFAULT_HOST, DEFAULT_PORT }
