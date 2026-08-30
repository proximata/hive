'use strict'

const ReadyResource = require('ready-resource')
const FramedStream = require('framed-stream')

/**
 * The host half of the hello-pear-bare shape.
 *
 * It spawns the Bare worker that owns the peer-to-peer code and the updater,
 * wraps the IPC pipe in length-prefixed framing, and turns the worker's
 * messages into events `bin.mjs` can print. Keeping the peer-to-peer work off
 * this thread is what lets the CLI stay responsive while the swarm does its
 * thing.
 */
class App extends ReadyResource {
  constructor (opts = {}) {
    super()

    this.dir = opts.dir
    this.app = opts.app ?? null
    this.updates = opts.updates !== false
    this.version = opts.version ?? '0.0.0-0'
    this.upgrade = opts.upgrade ?? ''
    this.name = opts.name ?? 'hive'
    this.host = opts.host ?? '127.0.0.1'
    this.port = opts.port ?? 3000
    this.publicUrl = opts.publicUrl ?? null
    this.webDir = opts.webDir ?? null
    this.swarm = opts.swarm !== false
    // undefined, not [], means "hyperdht's public bootstrap nodes" — see
    // resolveBootstrap in packages/hive-relay/lib/bind.js.
    this.bootstrap = opts.bootstrap ?? undefined

    this.url = null
    this.link = null
    this.pubkey = null
    this.IPC = null
    this.pipe = null
  }

  _open () {
    const PearRuntime = require('pear-runtime')

    this.IPC = PearRuntime.run(require.resolve('./workers/main.js'), [
      String(this.updates),
      this.version,
      this.upgrade,
      this.name,
      this.dir,
      this.app ?? '',
      String(this.port),
      String(this.swarm),
      // Appended, never inserted: the worker destructures Bare.argv
      // positionally, so a new argument in the middle would silently shift
      // every later one.
      this.host,
      this.publicUrl ?? '',
      this.webDir ?? '',
      this.bootstrap === undefined ? '' : this.bootstrap.join(',')
    ])

    this.pipe = new FramedStream(this.IPC)
    this.pipe.on('data', (data) => this._onmessage(data))
    this.pipe.on('error', (err) => this.emit('error', err))
  }

  _onmessage (data) {
    let message
    try {
      message = JSON.parse(data.toString())
    } catch {
      return
    }

    switch (message.type) {
      case 'listening':
        this.url = message.url
        this.emit('listening', message)
        break

      case 'swarm':
        this.link = message.link
        this.emit('swarm', message)
        break

      case 'ready':
        this.pubkey = message.pubkey
        this.emit('ready-relay', message)
        break

      case 'updating':
      case 'updated':
      case 'update-applied':
      case 'updater-ready':
      case 'updater-disabled':
        this.emit(message.type, message)
        break

      case 'error':
        this.emit('worker-error', message)
        break

      default:
        this.emit('message', message)
    }
  }

  async _close () {
    try {
      this.pipe?.write(JSON.stringify({ type: 'close' }))
    } catch {
      // The worker may already be gone.
    }
    // Give the worker a moment to close its store cleanly before the process
    // tears the pipe down under it.
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      this.IPC?.destroy()
    } catch {}
  }

  async exit (code = 0) {
    await this.close()
    if (typeof Bare !== 'undefined') Bare.exit(code)
    else process.exit(code)
  }
}

module.exports = App
