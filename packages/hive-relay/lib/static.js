'use strict'

const fs = require('bare-fs')
const path = require('bare-path')

// Read-only static files for the web client.
//
// Lives in its own module rather than in rest.js because rest.js already binds
// `path` to the request pathname, and a file server that shadows the path
// module is exactly the kind of thing that produces a traversal bug.

// An extension not in this map is not served at all. Allow-listing the type
// rather than guessing it means nothing on disk — a key, a .db, a .env — can be
// handed out just because it happened to sit in the served directory.
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  // The agent skill is published as skill.md so a consumer with no checkout can
  // curl it. Text only, and still an allow-list: adding one type does not widen
  // anything else, and a .env / .db / .key in the same directory stays refused.
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
}

/**
 * Map a URL path onto a file inside `root`, or null if it must not be served.
 *
 * This is a trust boundary: the pathname is attacker-controlled. `../`,
 * `%2e%2e%2f`, an absolute path and an embedded NUL all have to be refused
 * before the string reaches the filesystem.
 *
 * The order matters. Decode first, because `%2e%2e%2f` is `../` and a check
 * against the raw string would miss it. Then normalize, which collapses `..`
 * lexically — that is what makes the prefix test decisive, since it is applied
 * to the resolved path and never to the input.
 *
 * `root` must already be absolute (createStaticServer resolves it once).
 */
function resolveStatic (root, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null // malformed percent-encoding — not a path we are willing to guess at
  }

  // A NUL truncates the name in some syscalls, so `/app.js\0.png` could pass an
  // extension check and open something else.
  if (decoded.includes('\0')) return null

  const target = path.normalize(path.join(root, decoded))
  if (target !== root && !target.startsWith(root + path.sep)) return null
  if (!Object.hasOwn(STATIC_TYPES, path.extname(target))) return null

  return target
}

/**
 * A `(req, res, pathname) -> Promise<boolean>` handler. False means "not mine",
 * so the caller falls through to its own 404 rather than this module inventing
 * one.
 *
 * `dir` is the web client. `vendor` is an optional second root, mounted at
 * /vendor/, for ES modules that live in node_modules — a browser has no
 * CommonJS, so @noble is served from where npm installed it instead of being
 * copied into the repo where it would drift. One guard, two roots.
 */
function createStaticServer ({ dir, vendor = null }) {
  const root = path.resolve(dir)
  const vendorRoot = vendor === null ? null : path.resolve(vendor)

  return async function serveStatic (req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false

    // `/api/` is never a file, so a stray file on disk can never shadow an
    // endpoint no matter what ends up in the served directory.
    if (pathname.startsWith('/api/')) return false

    const [base, rest] = pathname.startsWith('/vendor/')
      ? [vendorRoot, pathname.slice('/vendor'.length)]
      : [root, pathname === '/' ? '/index.html' : pathname]

    if (base === null) return false

    const file = resolveStatic(base, rest)
    if (file === null) return false

    let data
    try {
      data = await fs.promises.readFile(file)
    } catch {
      return false // missing, or a directory: the caller's 404 is the honest answer
    }

    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(file)],
      // A relay is edited while it runs. Revalidating costs one conditional
      // request the server does not implement yet, which is still cheaper than
      // a stale app.js that nobody can explain.
      'Cache-Control': 'no-cache'
    })
    res.end(req.method === 'HEAD' ? undefined : data)
    return true
  }
}

/**
 * The @noble package root, so the browser can `import` the same curve
 * implementation the relay verifies with. Null when it cannot be resolved, in
 * which case /vendor/ simply is not mounted.
 *
 * `dir` is the web client directory. A `vendor/` inside it wins, because in a
 * standalone binary require.resolve answers with a path *inside the bundle*
 * (`bare:/app.bundle/node_modules/...`) which readFile cannot open — the mount
 * would exist and every file under it would 404. A deployed tree therefore
 * ships its own copy of @noble beside the page; a dev run has neither and falls
 * through to node_modules.
 */
function nobleDir (dir = null) {
  if (dir !== null) {
    const vendored = path.join(path.resolve(dir), 'vendor')
    if (fs.existsSync(path.join(vendored, 'curves'))) return vendored
  }

  try {
    // …/node_modules/@noble/curves/secp256k1.js -> …/node_modules/@noble
    const resolved = path.dirname(path.dirname(require.resolve('@noble/curves/secp256k1.js')))
    // Only a real directory; inside a bundle this path is not one.
    return fs.existsSync(resolved) ? resolved : null
  } catch {
    return null
  }
}

module.exports = { createStaticServer, resolveStatic, nobleDir, STATIC_TYPES }
