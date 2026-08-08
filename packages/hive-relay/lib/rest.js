'use strict'

const b4a = require('b4a')

const { LIMITS, normalizeFilter, checkPGatedAuthorization } = require('hive-core')
const { validateNip98, AuthContext, allScopes } = require('hive-auth')
const { channelsFromFilters } = require('./subscriptions')

const MAX_BODY_BYTES = LIMITS.MAX_MEDIA_BYTES

function readBody (req, limit = LIMITS.MAX_FRAME_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0

    req.on('data', (chunk) => {
      size += chunk.byteLength
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(b4a.concat(chunks)))
    req.on('error', reject)
  })
}

function json (res, status, payload) {
  // Content-Length is left to the server: bare-http1 sets it from the body, and
  // setting it here too produces a duplicate header the client rejects.
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/**
 * Every HTTP endpoint authenticates with NIP-98, so an agent needs no session,
 * no cookie and no bearer token — only its key.
 */
function authenticate (relay, req, url, body) {
  const result = validateNip98(req.headers.authorization, {
    url: url.href,
    method: req.method,
    body
  })
  if (!result.ok) return result

  const policy = relay.policy.check(result.context.pubkey)
  if (!policy.ok) return { ok: false, context: null, reason: policy.reason }

  return result
}

function createRestRouter (relay, opts = {}) {
  const mediaStore = opts.mediaStore ?? null

  return async function route (req, res) {
    const base = relay.url.replace(/^ws/, 'http')
    const url = new URL(req.url, base)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    // ------------------------------------------------------------ public --

    if (req.method === 'GET' && (path === '/' || path === '/info')) {
      const accept = req.headers.accept ?? ''
      if (path === '/info' || accept.includes('application/nostr+json')) {
        res.writeHead(200, { 'Content-Type': 'application/nostr+json' })
        res.end(JSON.stringify(relay.info()))
        return
      }
      return json(res, 426, { error: 'upgrade_required', message: 'connect with a WebSocket' })
    }

    if (req.method === 'GET' && (path === '/health' || path === '/_liveness')) {
      return json(res, 200, { status: 'ok', connections: relay.connections.size })
    }

    if (req.method === 'GET' && path === '/_readiness') {
      const ready = relay.store !== null && !relay.store.closed
      return json(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not-ready' })
    }

    if (req.method === 'GET' && path === '/.well-known/nostr.json') {
      const name = url.searchParams.get('name')
      const names = {}
      if (name !== null) {
        const row = relay.store.db
          .prepare('SELECT pubkey FROM users WHERE nip05 = ? OR display_name = ?')
          .get(`${name}@${url.host}`, name)
        if (row !== undefined) names[name] = row.pubkey
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ names }))
      return
    }

    // Blossom BUD-01: media is content-addressed, so reads need no auth.
    if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/media/')) {
      if (mediaStore === null) return json(res, 501, { error: 'not_implemented', message: 'media storage is disabled' })

      const [sha256] = path.slice('/media/'.length).split('.')
      const record = relay.store.getMedia(sha256)
      const blob = record === null ? null : await mediaStore.get(sha256)
      if (blob === null) return json(res, 404, { error: 'not_found', message: 'blob not found' })

      res.writeHead(200, { 'Content-Type': record.mime })
      res.end(req.method === 'HEAD' ? undefined : blob)
      return
    }

    // Stubbed surfaces. They answer 501 rather than 404 so a client can tell
    // "this relay does not do that yet" from "wrong URL".
    if (path.startsWith('/git/')) {
      return json(res, 501, { error: 'not_implemented', message: 'git hosting is not implemented; NIP-34 events are supported' })
    }
    if (path.startsWith('/huddle/')) {
      return json(res, 501, { error: 'not_implemented', message: 'huddle audio is not implemented; lifecycle events are supported' })
    }

    // ---------------------------------------------------------- workflows --

    if (req.method === 'POST' && path.startsWith('/hooks/')) {
      const id = path.slice('/hooks/'.length)
      if (relay.workflowEngine === null) {
        return json(res, 501, { error: 'not_implemented', message: 'no workflow engine configured' })
      }
      const body = await readBody(req)
      const result = await relay.workflowEngine.onWebhook(id, url.searchParams.get('secret'), safeJson(body))
      return json(res, result.ok ? 202 : 403, result)
    }

    // ------------------------------------------------- authenticated area --

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method)
      ? await readBody(req, path === '/media/upload' ? MAX_BODY_BYTES : LIMITS.MAX_FRAME_BYTES)
      : null

    const auth = authenticate(relay, req, url, body)
    if (!auth.ok) return json(res, 401, { error: 'auth', message: auth.reason })

    const context = new AuthContext({ pubkey: auth.context.pubkey, scopes: allScopes(), method: 'nip98' })

    // The HTTP bridge reuses the WebSocket pipeline rather than reimplementing
    // it, so both paths enforce identical rules.
    const virtual = {
      id: 'http-' + context.pubkey.slice(0, 8),
      pubkey: context.pubkey,
      auth: context,
      authState: 'authenticated',
      closed: false,
      sent: [],
      send (frame) {
        this.sent.push(JSON.parse(frame))
        return true
      },
      close () {}
    }

    if (req.method === 'POST' && path === '/events') {
      const event = safeJson(body)
      if (event === null) return json(res, 400, { error: 'invalid', message: 'body must be a JSON event' })

      await relay._handleEvent(virtual, event)
      const ok = virtual.sent.find((frame) => frame[0] === 'OK')
      if (ok === undefined) return json(res, 500, { error: 'internal', message: 'no result from pipeline' })
      return json(res, ok[2] ? 200 : 400, { id: ok[1], accepted: ok[2], message: ok[3], event: ok[2] ? event : undefined })
    }

    if (req.method === 'POST' && (path === '/query' || path === '/count')) {
      const payload = safeJson(body)
      const filters = Array.isArray(payload) ? payload : [payload]
      const normalized = filters.map(normalizeFilter).filter(Boolean)
      if (normalized.length === 0) return json(res, 400, { error: 'invalid', message: 'no valid filters' })

      // Global queries only — see the note in Relay._handleReq.
      if (channelsFromFilters(normalized).length === 0) {
        const gate = checkPGatedAuthorization(normalized, context.pubkey)
        if (gate !== null) return json(res, 403, { error: 'restricted', message: gate })
      }

      const results = relay._queryAuthorized(virtual, normalized)
      if (path === '/count') return json(res, 200, { count: results.length })
      return json(res, 200, results.map((stored) => stored.event))
    }

    if (req.method === 'PUT' && path === '/media/upload') {
      if (mediaStore === null) return json(res, 501, { error: 'not_implemented', message: 'media storage is disabled' })

      const record = await mediaStore.put(body, {
        mime: req.headers['content-type'] ?? 'application/octet-stream',
        uploadedBy: context.pubkey
      })
      relay.store.putMedia({ ...record, uploadedBy: context.pubkey })
      return json(res, 201, {
        sha256: record.sha256,
        size: record.size,
        type: record.mime,
        url: `${base}/media/${record.sha256}${record.extension}`
      })
    }

    // ------------------------------------------------- convenience reads --
    //
    // Everything below is derivable from Nostr queries; these endpoints exist
    // so the CLI can stay one round trip per command.

    if (req.method === 'GET' && path === '/api/channels') {
      return json(res, 200, relay.store.listChannels({
        pubkey: context.pubkey,
        includeArchived: url.searchParams.get('archived') === 'true'
      }))
    }

    const channelMatch = /^\/api\/channels\/([^/]+)(\/members|\/canvas)?$/.exec(path)
    if (req.method === 'GET' && channelMatch !== null) {
      const [, id, sub] = channelMatch
      const channel = relay.store.getChannel(id)
      if (channel === null) return json(res, 404, { error: 'not_found', message: 'channel not found' })

      if (!relay.store.accessibleChannelIds(context.pubkey).has(id)) {
        return json(res, 403, { error: 'restricted', message: 'not a channel member' })
      }

      if (sub === '/members') return json(res, 200, relay.store.listMembers(id))
      if (sub === '/canvas') return json(res, 200, { channel_id: id, content: channel.canvas })
      return json(res, 200, channel)
    }

    if (req.method === 'GET' && path === '/api/users') {
      const pubkeys = url.searchParams.getAll('pubkey')
      if (pubkeys.length === 0) return json(res, 200, [relay.store.getUser(context.pubkey) ?? { pubkey: context.pubkey }])
      return json(res, 200, pubkeys.slice(0, 200).map((pubkey) => relay.store.getUser(pubkey) ?? { pubkey }))
    }

    if (req.method === 'GET' && path === '/api/presence') {
      const pubkeys = url.searchParams.getAll('pubkey')
      const targets = pubkeys.length > 0 ? pubkeys : [context.pubkey]
      return json(res, 200, targets.map((pubkey) => ({ pubkey, presence: relay.store.getPresence(pubkey) })))
    }

    if (req.method === 'GET' && path === '/api/feed') {
      const results = relay.store.queryMentions(context.pubkey, { limit: Number(url.searchParams.get('limit')) || undefined })
      return json(res, 200, results.map((stored) => stored.event))
    }

    if (req.method === 'GET' && path === '/api/thread') {
      const id = url.searchParams.get('event')
      if (id === null) return json(res, 400, { error: 'invalid', message: 'event parameter is required' })

      const thread = relay.store.getThread(id)
      const visible = (stored) => stored !== null && relay._canRead(virtual, stored.event, stored.channelId)
      return json(res, 200, {
        root: visible(thread.root) ? thread.root.event : null,
        replies: thread.replies.filter(visible).map((stored) => stored.event)
      })
    }

    if (req.method === 'GET' && path === '/api/workflow-runs') {
      if (relay.workflowEngine === null) {
        return json(res, 501, { error: 'not_implemented', message: 'no workflow engine configured' })
      }
      return json(res, 200, relay.workflowEngine.listRuns(
        url.searchParams.get('workflow'),
        Number(url.searchParams.get('limit')) || 50
      ))
    }

    if (req.method === 'GET' && path === '/api/audit') {
      return json(res, 200, {
        verification: relay.store.verifyAuditChain(),
        entries: relay.store.listAudit({ limit: Number(url.searchParams.get('limit')) || 100 })
      })
    }

    if (req.method === 'GET' && path === '/api/relay') {
      return json(res, 200, {
        ...relay.info(),
        swarm: relay.swarmKey ?? null,
        connections: relay.connections.size,
        subscriptions: relay.subscriptions.size
      })
    }

    return json(res, 404, { error: 'not_found', message: `no route for ${req.method} ${path}` })
  }
}

function safeJson (body) {
  if (body === null) return null
  try {
    return JSON.parse(b4a.toString(body))
  } catch {
    return null
  }
}

module.exports = { createRestRouter, readBody, json }
