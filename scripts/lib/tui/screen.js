'use strict'

// The terminal surface the TUI paints on.
//
// Two things live here: the width arithmetic every widget needs (terminals
// count cells, JavaScript counts UTF-16 units, and ANSI escapes count for
// nothing), and a Screen that repaints only the rows that actually changed.
// A full repaint per tick would flicker on a real terminal and would make an
// asciinema recording of the demo enormous, since every frame would carry the
// whole screen instead of the handful of lines that moved.

const EventEmitter = require('bare-events')
const process = require('bare-process')
const tty = require('bare-tty')

const ESC = '\x1b'
const RESET = ESC + '[0m'
const HIDE_CURSOR = ESC + '[?25l'
const SHOW_CURSOR = ESC + '[?25h'
const ALT_ENTER = ESC + '[?1049h'
const ALT_LEAVE = ESC + '[?1049l'
const CLEAR = ESC + '[2J'
const HOME = ESC + '[H'

// CSI sequences, OSC strings (terminated by BEL or ST) and the short two-byte
// escapes, in one capture group so `split` hands back plain text and escapes
// in alternation.
const ANSI = /(\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_])/
const ANSI_GLOBAL = new RegExp(ANSI.source, 'g')

const ZWJ = 0x200d
const VS16 = '\ufe0f'

// Cell widths as a small table rather than a dependency. Only the ranges a
// chat UI actually meets: Hangul, CJK, fullwidth forms and the emoji planes.
const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff], [0x20000, 0x3fffd]
]

// Combining marks, joiners and variation selectors occupy no cell of their own.
const ZERO = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a],
  [0x064b, 0x065f], [0x200b, 0x200f], [0x2060, 0x2064], [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f], [0x1f3fb, 0x1f3ff]
]

function inRanges (cp, ranges) {
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false
    if (cp <= hi) return true
  }
  return false
}

function isZeroWidth (cp) {
  if (cp < 0x20 || cp === 0x7f) return true
  return inRanges(cp, ZERO)
}

function isWide (cp) {
  return inRanges(cp, WIDE)
}

// Split plain text into grapheme-ish clusters: a base character plus the
// zero-width followers that decorate it, plus whatever a ZWJ glues on. The
// terminal draws each cluster as one glyph, so both measuring and cutting have
// to work on clusters or a family emoji comes out six cells wide and a cut
// lands between a letter and its accent.
function clusters (plain) {
  const chars = Array.from(plain)
  const out = []

  for (let i = 0; i < chars.length; i++) {
    let cluster = chars[i]

    while (i + 1 < chars.length) {
      const cp = chars[i + 1].codePointAt(0)
      if (!isZeroWidth(cp)) break
      cluster += chars[++i]
      if (cp === ZWJ && i + 1 < chars.length) cluster += chars[++i]
    }

    out.push(cluster)
  }

  return out
}

function clusterWidth (cluster) {
  const base = cluster.codePointAt(0)
  if (isZeroWidth(base)) return 0
  if (isWide(base)) return 2
  // U+FE0F asks for emoji presentation, which terminals draw two cells wide
  // even when the base character is a narrow dingbat.
  return cluster.includes(VS16) ? 2 : 1
}

function stripAnsi (s) {
  return String(s).replace(ANSI_GLOBAL, '')
}

function displayWidth (s) {
  let width = 0
  for (const cluster of clusters(stripAnsi(s))) width += clusterWidth(cluster)
  return width
}

function truncate (s, width) {
  s = String(s)
  if (width <= 0) return ''
  if (displayWidth(s) <= width) return s

  const parts = s.split(ANSI)
  let out = ''
  let used = 0
  let styled = false
  let cut = false

  for (let i = 0; i < parts.length && !cut; i++) {
    // The capture group in ANSI puts escapes on the odd indices. They cost no
    // cells, so they are copied whole — never sliced in half.
    if (i % 2 === 1) {
      out += parts[i]
      styled = true
      continue
    }

    for (const cluster of clusters(parts[i])) {
      const w = clusterWidth(cluster)
      if (used + w > width) {
        cut = true
        break
      }
      out += cluster
      used += w
    }
  }

  // Cutting mid-line can drop the reset that closed a colour run, which would
  // bleed the colour across the rest of the frame.
  return styled ? out + RESET : out
}

function pad (s, width, align = 'left') {
  const text = truncate(s, width)
  const gap = width - displayWidth(text)
  if (gap <= 0) return text
  if (align === 'right') return ' '.repeat(gap) + text
  if (align === 'center') {
    const left = Math.floor(gap / 2)
    return ' '.repeat(left) + text + ' '.repeat(gap - left)
  }
  return text + ' '.repeat(gap)
}

class Screen extends EventEmitter {
  constructor ({ out = null, interactive = true, columns = null, rows = null } = {}) {
    super()

    const isTerminal = tty.isTTY(1)

    if (out === null) {
      // A bare-tty WriteStream is what carries .columns/.rows and SIGWINCH;
      // process.stdout is only a pipe and knows neither.
      this._out = interactive && isTerminal ? new tty.WriteStream(1) : process.stdout
      this._interactive = interactive && isTerminal
    } else {
      // An injected stream is trusted to want escape sequences: that is how
      // --demo and the tests capture frames without a terminal.
      this._out = out
      this._interactive = interactive
    }

    this._columns = columns
    this._rows = rows
    this._frame = []
    this._started = false
    this._stopped = false

    this._onResize = () => {
      // Geometry changed, so every cached row is suspect — drop the frame and
      // let the next render repaint in full.
      this._frame = []
      this.emit('resize', { columns: this.columns, rows: this.rows })
    }
  }

  get columns () {
    if (this._columns !== null) return this._columns
    const value = this._out === null ? 0 : this._out.columns
    return typeof value === 'number' && value > 0 ? value : 80
  }

  get rows () {
    if (this._rows !== null) return this._rows
    const value = this._out === null ? 0 : this._out.rows
    return typeof value === 'number' && value > 0 ? value : 24
  }

  get interactive () {
    return this._interactive
  }

  start () {
    if (this._started) return this
    this._started = true
    this._stopped = false
    this._frame = []

    if (this._interactive) {
      this._write(ALT_ENTER + HIDE_CURSOR + CLEAR + HOME)
      if (typeof this._out.on === 'function') this._out.on('resize', this._onResize)
    }

    return this
  }

  render (lines) {
    if (!this._started) this.start()

    const width = this.columns
    const height = this.rows
    const next = []
    for (let i = 0; i < lines.length && i < height; i++) next.push(truncate(String(lines[i]), width))

    if (!this._interactive) {
      this._write(next.join('\n') + '\n\n')
      this._frame = next
      return this
    }

    let out = ''
    const scanned = Math.max(next.length, this._frame.length)
    for (let row = 0; row < scanned; row++) {
      const line = row < next.length ? next[row] : ''
      if (line === this._frame[row]) continue
      // Absolute move plus erase-line: a row that got shorter must not leave
      // the tail of the previous frame behind it.
      out += ESC + '[' + (row + 1) + ';1H' + ESC + '[2K' + line
    }

    // One write per frame keeps the asciinema cast to one event per tick.
    if (out !== '') this._write(out + RESET)
    this._frame = next
    return this
  }

  stop () {
    if (this._stopped) return
    this._stopped = true
    this._started = false
    this._frame = []

    if (!this._interactive) return

    if (typeof this._out.off === 'function') {
      try {
        this._out.off('resize', this._onResize)
      } catch {
        // Nothing left to detach from.
      }
    }

    // Unconditional, because stop() also runs from a signal handler after a
    // half-finished start(): re-showing a visible cursor and leaving an alt
    // buffer we never entered are both harmless, a stuck terminal is not.
    this._write(RESET + SHOW_CURSOR + ALT_LEAVE)
  }

  _write (chunk) {
    try {
      this._out.write(chunk)
    } catch {
      // Teardown must never throw: stdout may already be gone by the time the
      // restore sequences are written.
    }
  }
}

module.exports = { Screen, stripAnsi, displayWidth, truncate, pad }
