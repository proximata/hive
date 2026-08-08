'use strict'

// Keyboard decoding for the TUI.
//
// `decode` is a pure function over bytes with no tty anywhere near it, which is
// what makes the whole keyboard surface testable from hand-built buffers. The
// Input class is only the plumbing: raw mode, chunk reassembly, events.

const EventEmitter = require('bare-events')
const process = require('bare-process')
const tty = require('bare-tty')
const constants = require('bare-tty/constants')

const EMPTY = Buffer.alloc(0)

// How long to wait before deciding a trailing ESC was the Escape key rather
// than the first byte of a sequence the terminal is still writing.
const ESCAPE_TIMEOUT = 40

// Final byte of a CSI sequence (\x1b[A) or of an SS3 one (\x1bOA, what a
// terminal in application cursor mode sends for the same keys).
const FINALS = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'backtab'
}

// The \x1b[<n>~ family. Terminals disagree on which number means home/end, so
// both spellings of each are mapped.
const TILDE = {
  1: 'home',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end'
}

function key (name, { ch = null, ctrl = false, shift = false, sequence = '' } = {}) {
  return { name, ch, ctrl, shift, sequence }
}

function toBuffer (chunk) {
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (Buffer.isBuffer(chunk)) return chunk
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
}

function utf8Size (byte) {
  if (byte < 0x80) return 1
  if (byte >= 0xf0) return 4
  if (byte >= 0xe0) return 3
  if (byte >= 0xc0) return 2
  return 1 // stray continuation byte — consume it alone rather than stalling
}

// xterm packs modifiers into a trailing parameter: 1 + shift|alt|ctrl bits.
function modifiers (param) {
  const bits = (parseInt(param, 10) || 1) - 1
  return { shift: (bits & 1) !== 0, ctrl: (bits & 4) !== 0 }
}

function decodeControl (byte) {
  switch (byte) {
    case 0x0d: return key('enter', { sequence: '\r' })
    case 0x0a: return key('enter', { sequence: '\n' })
    case 0x09: return key('tab', { sequence: '\t' })
    // 0x08 is ctrl-h on paper, but every terminal that still sends it means
    // Backspace, and reporting ctrl-h would delete nothing.
    case 0x08: return key('backspace', { sequence: '\b' })
    case 0x7f: return key('backspace', { sequence: '\x7f' })
    case 0x00: return key('space', { ch: ' ', ctrl: true, sequence: '\x00' })
  }

  if (byte < 0x20) {
    // 0x01-0x1a are ctrl-a..ctrl-z; 0x1c-0x1f are ctrl-\ ] ^ _.
    const ch = byte <= 0x1a ? String.fromCharCode(byte + 0x60) : String.fromCharCode(byte + 0x40)
    return key('char', { ch, ctrl: true, sequence: String.fromCharCode(byte) })
  }

  return null
}

function matchCsi (buf, start) {
  let i = start + 2
  while (i < buf.length && buf[i] >= 0x30 && buf[i] <= 0x3f) i++ // parameters
  while (i < buf.length && buf[i] >= 0x20 && buf[i] <= 0x2f) i++ // intermediates

  if (i >= buf.length) return null

  const final = buf[i]
  if (final < 0x40 || final > 0x7e) {
    // A control byte inside the sequence means the terminal never finished it.
    // Report the ESC and let the rest decode normally instead of eating keys.
    return { key: key('escape', { sequence: '\x1b' }), end: start + 1 }
  }

  const params = buf.toString('utf8', start + 2, i).split(';')
  const sequence = buf.toString('utf8', start, i + 1)
  const name = final === 0x7e
    ? TILDE[parseInt(params[0], 10)]
    : FINALS[String.fromCharCode(final)]

  // Function keys, mouse reports and anything else the UI has no binding for
  // are swallowed whole — half of an unknown sequence as literal text is worse.
  if (name === undefined) return { key: null, end: i + 1 }

  const mod = modifiers(params[1])
  return {
    key: key(name, { ctrl: mod.ctrl, shift: name === 'backtab' || mod.shift, sequence }),
    end: i + 1
  }
}

function matchSs3 (buf, start) {
  if (start + 2 >= buf.length) return null

  const name = FINALS[String.fromCharCode(buf[start + 2])]
  const sequence = buf.toString('utf8', start, start + 3)
  if (name === undefined) return { key: null, end: start + 3 }

  return { key: key(name, { sequence }), end: start + 3 }
}

function matchEscape (buf, start) {
  if (start + 1 >= buf.length) return null

  if (buf[start + 1] === 0x5b) return matchCsi(buf, start) // '['
  if (buf[start + 1] === 0x4f) return matchSs3(buf, start) // 'O'

  // ESC ESC, alt-<char>, anything else: report a bare Escape and let the next
  // byte decode on its own. The UI has no meta bindings to lose.
  return { key: key('escape', { sequence: '\x1b' }), end: start + 1 }
}

// Walk a chunk. With flush false an unfinished sequence at the tail is handed
// back as `rest` for the caller to prepend to the next chunk; with flush true
// it is resolved on the spot, which is what makes decode() total.
function scan (buf, flush) {
  const keys = []
  let i = 0

  while (i < buf.length) {
    const byte = buf[i]

    if (byte === 0x1b) {
      const match = matchEscape(buf, i)
      if (match === null) {
        if (!flush) return { keys, rest: buf.subarray(i) }
        keys.push(key('escape', { sequence: '\x1b' }))
        i++
        continue
      }
      if (match.key !== null) keys.push(match.key)
      i = match.end
      continue
    }

    const control = decodeControl(byte)
    if (control !== null) {
      keys.push(control)
      i++
      continue
    }

    const size = utf8Size(byte)
    if (i + size > buf.length) {
      if (!flush) return { keys, rest: buf.subarray(i) }
      break // a character torn in half by the end of input; drop it
    }

    const ch = buf.toString('utf8', i, i + size)
    keys.push(ch === ' ' ? key('space', { ch: ' ', sequence: ' ' }) : key('char', { ch, sequence: ch }))
    i += size
  }

  return { keys, rest: EMPTY }
}

function decode (buf) {
  return scan(toBuffer(buf), true).keys
}

class Input extends EventEmitter {
  constructor ({ input = null, interactive = true } = {}) {
    super()

    this.interactive = interactive
    this.stream = input ?? defaultInput(interactive)
    this.started = false

    this._leftover = EMPTY
    this._timer = null
    this._raw = false
    this._ondata = (chunk) => this._push(chunk)
  }

  start () {
    if (this.started) return
    this.started = true
    if (this.stream === null) return

    if (this.interactive && typeof this.stream.setMode === 'function') {
      this.stream.setMode(constants.mode.RAW)
      this._raw = true
    }

    this.stream.on('data', this._ondata)
  }

  stop () {
    if (!this.started) return
    this.started = false

    this._disarm()
    this._leftover = EMPTY
    if (this.stream === null) return

    this.stream.removeListener('data', this._ondata)

    // This is the line that keeps a terminal usable after Ctrl-C, so it runs
    // from signal handlers and must never throw — the fd may already be gone.
    if (this._raw) {
      this._raw = false
      try {
        this.stream.setMode(constants.mode.NORMAL)
      } catch {
        // nothing left to restore
      }
    }
  }

  _push (chunk) {
    this._disarm()

    const bytes = toBuffer(chunk)
    const buf = this._leftover.byteLength === 0 ? bytes : Buffer.concat([this._leftover, bytes])

    const { keys, rest } = scan(buf, false)
    this._leftover = rest

    for (const k of keys) this.emit('key', k)

    // A trailing ESC is genuinely ambiguous: alone it is the Escape key, but it
    // also opens every arrow key. Give the rest of the sequence a few
    // milliseconds to arrive, then give up and report Escape.
    if (rest.byteLength > 0) this._arm()
  }

  _arm () {
    this._timer = setTimeout(() => {
      this._timer = null
      const pending = this._leftover
      this._leftover = EMPTY
      for (const k of scan(pending, true).keys) this.emit('key', k)
    }, ESCAPE_TIMEOUT)

    if (typeof this._timer.unref === 'function') this._timer.unref()
  }

  _disarm () {
    if (this._timer === null) return
    clearTimeout(this._timer)
    this._timer = null
  }
}

function defaultInput (interactive) {
  // Non-interactive runs (--demo, tests) are driven by their script, so there
  // is nothing to read and stdin is left alone.
  if (!interactive) return null

  try {
    if (tty.isTTY(0)) return new tty.ReadStream(0)
  } catch {
    // no tty binding for fd 0
  }

  return process.stdin ?? null
}

module.exports = { Input, decode }
