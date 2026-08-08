'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const b4a = require('b4a')

const { sha256, toHex } = require('hive-core')

// Blossom-style content-addressed blob storage on the local filesystem. Buzz
// puts these in S3; a self-hosted peer-to-peer relay has no reason to require
// an object store, and content addressing means the name is the integrity
// check.

const MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'video/mp4': '.mp4'
}

class MediaStore {
  constructor (dir) {
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true })
  }

  #path (hash) {
    // Two-level fan-out keeps directory listings usable at scale.
    return path.join(this.dir, hash.slice(0, 2), hash.slice(2, 4), hash)
  }

  async put (data, { mime = 'application/octet-stream' } = {}) {
    const buffer = b4a.isBuffer(data) ? data : b4a.from(data)
    const hash = toHex(sha256(buffer))
    const target = this.#path(hash)

    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    // Content-addressed, so an existing file with this name is byte-identical
    // and rewriting it would be pure I/O.
    try {
      await fs.promises.access(target)
    } catch {
      await fs.promises.writeFile(target, buffer)
    }

    return {
      sha256: hash,
      size: buffer.byteLength,
      mime,
      extension: MIME_EXTENSIONS[mime] ?? ''
    }
  }

  async get (hash) {
    try {
      return await fs.promises.readFile(this.#path(hash))
    } catch {
      return null
    }
  }

  async has (hash) {
    try {
      await fs.promises.access(this.#path(hash))
      return true
    } catch {
      return false
    }
  }
}

module.exports = { MediaStore, MIME_EXTENSIONS }
