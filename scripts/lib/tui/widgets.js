'use strict'

// The drawing vocabulary of the TUI: boxes, lists, logs, tables.
//
// Every widget is a pure function of its arguments and returns a rectangle —
// exactly `height` strings of exactly `width` display columns — so a pane is
// assembled by slotting rectangles into a frame rather than by moving a cursor
// around. That is what lets the panes be unit-tested against fixed strings and
// what lets Screen diff one frame against the next.

const { displayWidth, truncate, pad } = require('./screen')

const ESC = '\x1b'

let colored = true

function paint (code) {
  return (s) => (colored ? ESC + '[' + code + 'm' + s + ESC + '[0m' : String(s))
}

const style = {
  bold: paint(1),
  dim: paint(2),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  magenta: paint(35),
  cyan: paint(36),
  inverse: paint(7)
}

// --demo renders into an asciinema cast and the tests compare exact strings;
// both want box-drawing and nothing else.
function setColor (enabled) {
  colored = enabled !== false
}

// The one place the rectangle invariant is enforced. Every widget ends here, so
// no widget has to be careful about its own arithmetic — a row that came out
// short is padded, one that came out long is cut without splitting an escape.
function frame (lines, width, height) {
  const out = []
  for (let i = 0; i < height; i++) out.push(pad(i < lines.length ? lines[i] : '', width))
  return out
}

// Split plain text at a display-width boundary. Only reached for words longer
// than the pane — hashes, npubs, URLs — which never carry styling of their own.
function cut (word, width) {
  const chars = Array.from(word)
  let head = ''
  let used = 0
  let i = 0

  for (; i < chars.length; i++) {
    const w = displayWidth(chars[i])
    if (used + w > width && head !== '') break
    head += chars[i]
    used += w
  }

  return [head, chars.slice(i).join('')]
}

function wrapText (text, width) {
  if (width <= 0) return ['']

  const lines = []
  let line = ''

  for (const word of String(text).split(' ')) {
    if (word === '') continue

    const candidate = line === '' ? word : line + ' ' + word
    if (displayWidth(candidate) <= width) {
      line = candidate
      continue
    }

    if (line !== '') lines.push(line)
    let rest = word
    while (displayWidth(rest) > width) {
      const [head, tail] = cut(rest, width)
      lines.push(head)
      rest = tail
    }
    line = rest
  }

  if (line !== '' || lines.length === 0) lines.push(line)
  return lines
}

// A horizontal rule with a label sunk into it: ╭─ Channels ────╮
function rule (left, right, label, align, width, chrome) {
  if (width <= 0) return ''
  if (width === 1) return chrome(left)

  const inner = width - 2
  const text = label === '' ? '' : truncate(' ' + label + ' ', inner - 2)
  if (text === '') return chrome(left + '─'.repeat(inner) + right)

  const rest = inner - displayWidth(text)
  const lead = align === 'right' ? rest - 1 : 1
  return chrome(left + '─'.repeat(lead)) + text + chrome('─'.repeat(rest - lead) + right)
}

function box ({ title = '', width, height, body = [], footer = '', active = false }) {
  if (height <= 0) return []

  const chrome = active ? (s) => style.cyan(style.bold(s)) : style.dim
  const lines = [rule('╭', '╮', title === '' ? '' : style.bold(title), 'left', width, chrome)]

  // One column of padding on each side, so text never touches the border.
  const inner = Math.max(0, width - 4)
  for (let i = 0; i < height - 2; i++) {
    lines.push(chrome('│') + ' ' + pad(i < body.length ? body[i] : '', inner) + ' ' + chrome('│'))
  }

  // The footer rides in the bottom border rather than eating a body row —
  // panes are short and every row of content counts.
  if (height > 1) lines.push(rule('╰', '╯', footer === '' ? '' : style.dim(footer), 'right', width, chrome))

  return frame(lines, width, height)
}

function list ({ items, selected = 0, width, height, scroll = 0 }) {
  // The caller's scroll offset is a hint; the selection always wins, otherwise
  // arrowing past the edge would silently select something off-screen.
  let top = scroll
  if (selected < top) top = selected
  if (selected >= top + height) top = selected - height + 1
  top = Math.max(0, Math.min(top, Math.max(0, items.length - height)))

  const lines = []
  for (let i = top; i < items.length && lines.length < height; i++) {
    const item = items[i]
    const badge = item.badge === undefined || item.badge === null ? '' : String(item.badge)
    const badgeWidth = badge === '' ? 0 : displayWidth(badge) + 1
    const labelWidth = Math.max(0, width - 2 - badgeWidth)

    let label = pad(item.label, labelWidth)
    if (i === selected) label = style.bold(label)
    else if (item.dim) label = style.dim(label)

    lines.push(
      (i === selected ? style.cyan('>') : ' ') + ' ' +
      label + (badge === '' ? '' : ' ' + style.dim(badge))
    )
  }

  return frame(lines, width, height)
}

function logPane ({ entries, width, height }) {
  const lines = []

  for (const entry of entries) {
    const colorize = entry.color && style[entry.color] ? style[entry.color] : (s) => s
    for (const piece of wrapText(entry.text, width)) lines.push(colorize(piece))
  }

  // Tail-anchored: when the log overflows, the oldest wrapped rows go, never
  // the newest — the interesting line is always the one that just arrived.
  return frame(lines.slice(Math.max(0, lines.length - height)), width, height)
}

// Fixed widths are honoured first; whatever is left over is split between the
// columns that asked for null, leftmost first so the total lands exactly.
function columnWidths (columns, width) {
  let remaining = width - Math.max(0, columns.length - 1)
  const flexible = []

  const widths = columns.map((column, i) => {
    if (column.width === null || column.width === undefined) {
      flexible.push(i)
      return 0
    }
    const w = Math.max(0, Math.min(column.width, Math.max(0, remaining)))
    remaining -= w
    return w
  })

  if (flexible.length > 0) {
    const share = Math.max(0, Math.floor(remaining / flexible.length))
    let extra = Math.max(0, remaining - share * flexible.length)
    for (const i of flexible) {
      widths[i] = share + (extra > 0 ? 1 : 0)
      if (extra > 0) extra--
    }
  }

  return widths
}

function table ({ columns, rows, width, height }) {
  const widths = columnWidths(columns, width)
  const render = (cells, decorate) => columns
    .map((column, i) => decorate(pad(cells[i] === undefined ? '' : String(cells[i]), widths[i], column.align || 'left')))
    .join(' ')

  const lines = [render(columns.map((c) => c.label), style.bold)]

  for (const row of rows) {
    if (lines.length >= height) break
    const cells = Array.isArray(row) ? row : columns.map((c) => row[c.key ?? c.label])
    lines.push(render(cells, (s) => s))
  }

  return frame(lines, width, height)
}

function kv ({ pairs, width }) {
  const keyWidth = Math.min(
    pairs.reduce((max, [key]) => Math.max(max, displayWidth(key)), 0),
    Math.max(0, Math.floor(width / 2))
  )

  const lines = pairs.map(([key, value]) =>
    style.dim(pad(key, keyWidth)) + ' ' + pad(value === null || value === undefined ? '' : String(value), Math.max(0, width - keyWidth - 1))
  )

  return frame(lines, width, pairs.length)
}

const BARS = '▁▂▃▄▅▆▇█'

function sparkline (values, width) {
  const numbers = values
    .slice(Math.max(0, values.length - width))
    .map((v) => (Number.isFinite(v) ? v : 0))

  if (numbers.length === 0) return pad('', width)

  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  const span = max - min

  const bars = numbers
    .map((v) => (span === 0 ? (max === 0 ? BARS[0] : BARS[3]) : BARS[Math.round(((v - min) / span) * (BARS.length - 1))]))
    .join('')

  // Right-anchored, so the newest sample sits under the cursor's eye.
  return pad(bars, width, 'right')
}

function statusbar ({ left = '', right = '', width }) {
  const head = ' ' + left
  const tail = right + ' '
  const gap = Math.max(0, width - displayWidth(head) - displayWidth(tail))
  return style.inverse(pad(head + ' '.repeat(gap) + tail, width))
}

function tabstrip ({ tabs, active, width }) {
  const strip = tabs
    .map((tab) => {
      const label = '[' + tab.key + '] ' + tab.label
      return tab.key === active ? style.bold(style.cyan(label)) : style.dim(label)
    })
    .join('  ')

  return pad(' ' + strip + ' ', width)
}

module.exports = { box, list, logPane, table, kv, sparkline, statusbar, tabstrip, style, setColor }
