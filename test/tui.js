'use strict'

const test = require('brittle')
const EventEmitter = require('bare-events')

const { Screen, stripAnsi, displayWidth, truncate, pad } = require('../scripts/lib/tui/screen')
const { Input, decode } = require('../scripts/lib/tui/input')
const {
  box, list, logPane, table, kv, sparkline, statusbar, tabstrip, style, setColor
} = require('../scripts/lib/tui/widgets')

const ESC = '\x1b'
const RESET = ESC + '[0m'

// A stream that only records. Everything the TUI writes is a string, so the
// whole Screen surface can be exercised with no fd and no terminal.
function recorder () {
  const out = new EventEmitter()
  out.chunks = []
  out.write = (chunk) => { out.chunks.push(String(chunk)) }
  out.text = () => out.chunks.join('')
  return out
}

function keys (bytes) {
  return decode(Buffer.from(bytes))
}

function only (bytes) {
  const decoded = keys(bytes)
  return decoded.length === 1 ? decoded[0] : decoded
}

// ------------------------------------------------------------------ decode --

test('decode maps the cursor and navigation families', (t) => {
  t.alike(only('\x1b[A'), { name: 'up', ch: null, ctrl: false, shift: false, sequence: '\x1b[A' })
  t.alike(only('\x1b[B'), { name: 'down', ch: null, ctrl: false, shift: false, sequence: '\x1b[B' })
  t.alike(only('\x1b[C'), { name: 'right', ch: null, ctrl: false, shift: false, sequence: '\x1b[C' })
  t.alike(only('\x1b[D'), { name: 'left', ch: null, ctrl: false, shift: false, sequence: '\x1b[D' })
  t.alike(only('\x1b[H'), { name: 'home', ch: null, ctrl: false, shift: false, sequence: '\x1b[H' })
  t.alike(only('\x1b[F'), { name: 'end', ch: null, ctrl: false, shift: false, sequence: '\x1b[F' })
  t.alike(only('\x1b[5~'), { name: 'pageup', ch: null, ctrl: false, shift: false, sequence: '\x1b[5~' })
  t.alike(only('\x1b[6~'), { name: 'pagedown', ch: null, ctrl: false, shift: false, sequence: '\x1b[6~' })
  t.alike(only('\x1b[3~'), { name: 'delete', ch: null, ctrl: false, shift: false, sequence: '\x1b[3~' })
})

test('decode accepts both spellings of home and end', (t) => {
  // Terminals disagree; the UI must not care which one arrives.
  t.is(only('\x1b[1~').name, 'home')
  t.is(only('\x1b[7~').name, 'home')
  t.is(only('\x1b[4~').name, 'end')
  t.is(only('\x1b[8~').name, 'end')
})

test('decode understands SS3, the application-cursor spelling', (t) => {
  t.alike(only('\x1bOA'), { name: 'up', ch: null, ctrl: false, shift: false, sequence: '\x1bOA' })
  t.is(only('\x1bOB').name, 'down')
  t.is(only('\x1bOC').name, 'right')
  t.is(only('\x1bOD').name, 'left')
})

test('decode maps the editing and whitespace keys', (t) => {
  t.alike(only('\r'), { name: 'enter', ch: null, ctrl: false, shift: false, sequence: '\r' })
  t.alike(only('\n'), { name: 'enter', ch: null, ctrl: false, shift: false, sequence: '\n' })
  t.alike(only('\t'), { name: 'tab', ch: null, ctrl: false, shift: false, sequence: '\t' })
  t.alike(only('\x1b[Z'), { name: 'backtab', ch: null, ctrl: false, shift: true, sequence: '\x1b[Z' })
  t.alike(only('\x7f'), { name: 'backspace', ch: null, ctrl: false, shift: false, sequence: '\x7f' })
  t.alike(only('\b'), { name: 'backspace', ch: null, ctrl: false, shift: false, sequence: '\b' })
  t.alike(only(' '), { name: 'space', ch: ' ', ctrl: false, shift: false, sequence: ' ' })
  t.alike(only('a'), { name: 'char', ch: 'a', ctrl: false, shift: false, sequence: 'a' })
})

test('decode reports ctrl-c as a ctrl-modified char, not a signal', (t) => {
  // The TUI installs its own quit path, so ctrl-c has to survive decoding
  // as an ordinary key rather than being swallowed here.
  t.alike(only('\x03'), { name: 'char', ch: 'c', ctrl: true, shift: false, sequence: '\x03' })
  t.alike(only('\x01'), { name: 'char', ch: 'a', ctrl: true, shift: false, sequence: '\x01' })
  t.alike(only('\x1a'), { name: 'char', ch: 'z', ctrl: true, shift: false, sequence: '\x1a' })
  t.alike(only('\x00'), { name: 'space', ch: ' ', ctrl: true, shift: false, sequence: '\x00' })
})

test('decode reads xterm modifier parameters', (t) => {
  t.alike(only('\x1b[1;2A'), { name: 'up', ch: null, ctrl: false, shift: true, sequence: '\x1b[1;2A' })
  t.alike(only('\x1b[1;5C'), { name: 'right', ch: null, ctrl: true, shift: false, sequence: '\x1b[1;5C' })
  t.alike(only('\x1b[1;6D'), { name: 'left', ch: null, ctrl: true, shift: true, sequence: '\x1b[1;6D' })
})

test('decode handles several keys in one chunk', (t) => {
  t.alike(
    keys('ab\x1b[A\r\x1b[6~ c').map((k) => k.name),
    ['char', 'char', 'up', 'enter', 'pagedown', 'space', 'char']
  )
  t.alike(keys('ab\x1b[A\r\x1b[6~ c').map((k) => k.ch), ['a', 'b', null, null, null, ' ', 'c'])
})

test('decode swallows sequences the UI has no binding for', (t) => {
  // Half of an unrecognised sequence leaking through as literal text would
  // type '[15~' into a message box.
  t.alike(keys('\x1b[15~a').map((k) => k.name), ['char'])
  t.alike(keys('\x1b[<0;10;5Ma').map((k) => k.name), ['char'], 'a mouse report vanishes whole')
})

test('decode resolves a lone trailing escape', (t) => {
  t.alike(only('\x1b'), { name: 'escape', ch: null, ctrl: false, shift: false, sequence: '\x1b' })
  t.alike(keys('a\x1b').map((k) => k.name), ['char', 'escape'])
  t.alike(keys('\x1b\x1b').map((k) => k.name), ['escape', 'escape'])

  // decode() is total, so a CSI the terminal never finished cannot be held
  // back: the ESC is reported and the orphaned bytes decode as themselves.
  // Input is the layer that waits for the rest — see the split-chunk test.
  t.alike(keys('\x1b[').map((k) => k.name), ['escape', 'char'])
  t.alike(keys('\x1b[').map((k) => k.ch), [null, '['])
})

test('decode is total on multi-byte UTF-8', (t) => {
  t.alike(only('世'), { name: 'char', ch: '世', ctrl: false, shift: false, sequence: '世' })
  t.alike(only('🐝'), { name: 'char', ch: '🐝', ctrl: false, shift: false, sequence: '🐝' })
  t.alike(keys('é世').map((k) => k.ch), ['é', '世'])
})

test('decode accepts a string as well as a buffer', (t) => {
  t.alike(decode('\x1b[A'), decode(Buffer.from('\x1b[A')))
})

// ------------------------------------------------------------------- Input --

test('Input reassembles a CSI sequence split across two chunks', (t) => {
  const stream = new EventEmitter()
  const input = new Input({ input: stream, interactive: false })
  const seen = []
  input.on('key', (key) => seen.push(key))
  input.start()

  stream.emit('data', Buffer.from('\x1b['))
  t.alike(seen, [], 'an unfinished sequence emits nothing yet')

  stream.emit('data', Buffer.from('A'))
  t.alike(seen, [{ name: 'up', ch: null, ctrl: false, shift: false, sequence: '\x1b[A' }])

  // The split must not eat the keys that follow it in the same chunk.
  stream.emit('data', Buffer.from('\x1b'))
  stream.emit('data', Buffer.from('[Bx'))
  t.alike(seen.slice(1).map((k) => k.name), ['down', 'char'])

  input.stop()
})

test('Input.stop is idempotent and detaches the reader', (t) => {
  const stream = new EventEmitter()
  const input = new Input({ input: stream, interactive: false })
  const seen = []
  input.on('key', (key) => seen.push(key))

  input.start()
  input.start()
  stream.emit('data', Buffer.from('a'))
  t.is(seen.length, 1, 'a repeated start does not double-subscribe')

  input.stop()
  input.stop()
  stream.emit('data', Buffer.from('b'))
  t.is(seen.length, 1, 'nothing arrives after stop')
})

test('Input leaves stdin alone when it is not interactive', (t) => {
  const input = new Input({ interactive: false })
  t.is(input.stream, null)
  input.start()
  input.stop()
  t.pass('start/stop on a null stream is inert')
})

// ------------------------------------------------------------ width helpers --

test('stripAnsi removes CSI, OSC and two-byte escapes', (t) => {
  t.is(stripAnsi('\x1b[31mred\x1b[0m'), 'red')
  t.is(stripAnsi('\x1b[1m\x1b[36mboth\x1b[0m\x1b[0m'), 'both')
  t.is(stripAnsi('\x1b]0;title\x07after'), 'after', 'OSC terminated by BEL')
  t.is(stripAnsi('\x1b]0;title\x1b\\after'), 'after', 'OSC terminated by ST')
  t.is(stripAnsi('plain'), 'plain')
  t.is(stripAnsi('\x1b[?25lx'), 'x')
})

test('displayWidth counts cells, not UTF-16 units', (t) => {
  t.is(displayWidth(''), 0)
  t.is(displayWidth('hello'), 5)
  t.is(displayWidth('\x1b[31mhello\x1b[0m'), 5, 'escapes cost nothing')
  t.is(displayWidth('世'), 2, 'CJK is double width')
  t.is(displayWidth('世界'), 4)
  t.is(displayWidth('🐝'), 2, 'emoji is double width despite being a surrogate pair')
  t.is('🐝'.length, 2, 'and JavaScript would have said 2 for the wrong reason')
  t.is(displayWidth('a🐝世b'), 6)
  t.is(displayWidth('é'), 1, 'a combining accent adds no cell')
  t.is(displayWidth('❤️'), 2, 'VS16 asks for emoji presentation')
  t.is(displayWidth('👍🏻'), 2, 'a skin-tone modifier rides along')
})

test('truncate never cuts an escape in half', (t) => {
  const styled = '\x1b[31mred\x1b[0m'
  const cut = truncate(styled, 2)

  t.is(stripAnsi(cut), 're')
  t.is(displayWidth(cut), 2)
  t.ok(cut.startsWith('\x1b[31m'), 'the opening escape is copied whole')
  t.ok(cut.endsWith(RESET), 'a cut run is closed so the colour cannot bleed')
  t.absent(/\x1b\[?[0-9;]*$/.test(stripAnsi(cut)), 'no escape fragment survives as text')

  // Escapes are copied whole up to the cut, so the opener of a run whose text
  // got dropped is still emitted. It paints nothing and the trailing reset
  // closes it, which is the point: correctness here is "never bleeds", not
  // "shortest possible string".
  t.is(truncate('\x1b[1ma\x1b[0m\x1b[2mb\x1b[0m', 1), '\x1b[1ma\x1b[0m\x1b[2m' + RESET)
  t.is(displayWidth(truncate('\x1b[1ma\x1b[0m\x1b[2mb\x1b[0m', 1)), 1)
})

test('truncate is a no-op when the text already fits', (t) => {
  t.is(truncate('abc', 3), 'abc')
  t.is(truncate('abc', 10), 'abc')
  t.is(truncate('\x1b[31mred\x1b[0m', 3), '\x1b[31mred\x1b[0m', 'no extra reset appended')
  t.is(truncate('abcdef', 3), 'abc')
  t.is(truncate('anything', 0), '')
  t.is(truncate('anything', -5), '')
})

test('truncate refuses to split a wide cluster', (t) => {
  // Half a CJK glyph is not a thing a terminal can draw, so the cell is
  // dropped rather than half-filled; padding is pad()'s job.
  t.is(truncate('世世世', 3), '世')
  t.is(displayWidth(truncate('世世世', 3)), 2)
  t.is(truncate('世世世', 4), '世世')
  t.is(truncate('a世', 2), 'a')
})

test('pad produces an exact display width', (t) => {
  t.is(pad('ab', 5), 'ab   ')
  t.is(pad('ab', 5, 'right'), '   ab')
  t.is(pad('ab', 5, 'center'), ' ab  ', 'an odd gap leans left')
  t.is(pad('abc', 6, 'center'), ' abc  ')
  t.is(pad('世', 5), '世   ', 'a wide char consumes two of the five cells')
  t.is(pad('世世世', 5), '世世 ', 'the cell a split glyph vacated is filled with a space')
  t.is(pad('', 3), '   ')
  t.is(pad('toolong', 4), 'tool')

  for (const width of [1, 7, 40]) {
    for (const s of ['', 'a', 'hello world', '世界', '🐝 bee', '\x1b[32mgreen\x1b[0m']) {
      for (const align of ['left', 'right', 'center']) {
        t.is(displayWidth(pad(s, width, align)), width, `pad(${JSON.stringify(s)}, ${width}, ${align})`)
      }
    }
  }
})

// ----------------------------------------------------------------- widgets --

const WIDTHS = [40, 80, 200]
const HEIGHTS = [3, 10, 40]

// Deliberately awkward: wide glyphs, an emoji, an unbreakable hash-like word
// and labels far longer than the narrowest pane.
const ITEMS = [
  { label: 'general', badge: '3' },
  { label: '世界 — a channel name long enough to overflow the narrow pane', badge: '' },
  { label: 'bees 🐝', badge: '12', dim: true },
  { label: 'archive', badge: null, dim: true }
]

const ENTRIES = [
  { text: 'relay listening', color: null },
  { text: 'alice sent a message '.repeat(9), color: 'green' },
  { text: 'f'.repeat(220), color: 'red' },
  { text: '世界世界世界 🐝🐝 done', color: 'cyan' },
  { text: '', color: 'nosuchcolor' }
]

const COLUMNS = [
  { label: 'name' },
  { label: 'role', width: 10 },
  { label: 'events', width: 6, align: 'right' }
]

const ROWS = [
  ['alice', 'admin', '3'],
  ['世界', 'member', '12'],
  ['bob 🐝', 'member', '0'],
  ['a-very-long-member-name-that-will-not-fit', 'moderator', '99999999']
]

// The rectangle invariant, asserted as one comparison per case so a failure
// names the row that broke it.
function rectangle (t, lines, width, height, label) {
  t.is(lines.length, height, `${label}: line count`)
  t.alike(lines.map(displayWidth), new Array(height).fill(width), `${label}: every row is ${width} columns`)
}

test('every rectangular widget fills its rectangle exactly', (t) => {
  for (const colored of [true, false]) {
    setColor(colored)
    const c = colored ? 'colour' : 'plain'

    for (const width of WIDTHS) {
      for (const height of HEIGHTS) {
        const at = `${c} ${width}x${height}`

        rectangle(t, box({ title: '世界 Channels', width, height, body: ['hi', '🐝 buzz'], footer: 'q quit', active: true }), width, height, `box ${at}`)
        rectangle(t, box({ width, height }), width, height, `box bare ${at}`)
        rectangle(t, box({ title: 'x'.repeat(300), width, height, body: [], footer: 'y'.repeat(300) }), width, height, `box overlong chrome ${at}`)

        rectangle(t, list({ items: ITEMS, selected: 3, width, height }), width, height, `list ${at}`)
        rectangle(t, list({ items: [], selected: 0, width, height }), width, height, `list empty ${at}`)
        rectangle(t, list({ items: ITEMS, selected: 0, width, height, scroll: 99 }), width, height, `list clamped scroll ${at}`)

        rectangle(t, logPane({ entries: ENTRIES, width, height }), width, height, `logPane ${at}`)
        rectangle(t, logPane({ entries: [], width, height }), width, height, `logPane empty ${at}`)

        rectangle(t, table({ columns: COLUMNS, rows: ROWS, width, height }), width, height, `table ${at}`)
        rectangle(t, table({ columns: COLUMNS, rows: [], width, height }), width, height, `table headers only ${at}`)
        rectangle(t, table({ columns: [{ label: 'a' }, { label: 'b' }], rows: ROWS, width, height }), width, height, `table all flexible ${at}`)
      }
    }
  }
  setColor(true)
})

test('the single-line widgets are exactly one row of the requested width', (t) => {
  const pairs = [['relay', 'ws://127.0.0.1:8080'], ['世界', '🐝'], ['nothing', null], ['undef', undefined]]

  for (const colored of [true, false]) {
    setColor(colored)
    const c = colored ? 'colour' : 'plain'

    for (const width of WIDTHS) {
      const rendered = kv({ pairs, width })
      t.is(rendered.length, pairs.length, `kv ${c} ${width}: one line per pair`)
      t.alike(rendered.map(displayWidth), new Array(pairs.length).fill(width), `kv ${c} ${width}: exact width`)

      t.is(displayWidth(sparkline([1, 5, 2, 9, 0, 3], width)), width, `sparkline ${c} ${width}`)
      t.is(displayWidth(sparkline([], width)), width, `sparkline empty ${c} ${width}`)
      t.is(displayWidth(sparkline([4, 4, 4], width)), width, `sparkline flat ${c} ${width}`)
      t.is(displayWidth(sparkline(new Array(500).fill(1), width)), width, `sparkline overlong ${c} ${width}`)
      t.is(displayWidth(sparkline([1, NaN, Infinity, 2], width)), width, `sparkline non-finite ${c} ${width}`)

      t.is(displayWidth(statusbar({ left: 'user 世界', right: 'q quit 🐝', width })), width, `statusbar ${c} ${width}`)
      t.is(displayWidth(statusbar({ width })), width, `statusbar empty ${c} ${width}`)
      t.is(displayWidth(statusbar({ left: 'l'.repeat(300), right: 'r'.repeat(300), width })), width, `statusbar overflowing ${c} ${width}`)

      const tabs = [{ key: '1', label: 'User' }, { key: '2', label: 'Admin' }]
      t.is(displayWidth(tabstrip({ tabs, active: '1', width })), width, `tabstrip ${c} ${width}`)
      t.is(displayWidth(tabstrip({ tabs: [], active: '1', width })), width, `tabstrip empty ${c} ${width}`)
    }
  }
  setColor(true)
})

test('widget output is pinned character for character with colour off', (t) => {
  setColor(false)

  t.alike(box({ title: 'Channels', width: 20, height: 4, body: ['hi'], footer: 'q' }), [
    '╭─ Channels ───────╮',
    '│ hi               │',
    '│                  │',
    '╰────────────── q ─╯'
  ])

  t.alike(list({ items: [{ label: 'general', badge: '3' }, { label: 'random' }], selected: 0, width: 16, height: 3 }), [
    '> general      3',
    '  random        ',
    '                '
  ], 'the badge is flushed right and the label takes the slack')

  // A log shorter than its pane fills from the top, the way a terminal does;
  // tail-anchoring is what happens on overflow, pinned in its own test.
  t.alike(logPane({ entries: [{ text: 'one' }, { text: 'two' }], width: 6, height: 3 }), [
    'one   ',
    'two   ',
    '      '
  ])

  t.alike(table({ columns: [{ label: 'name' }, { label: 'n', width: 3, align: 'right' }], rows: [['alice', '7']], width: 12, height: 3 }), [
    'name       n',
    'alice      7',
    '            '
  ])

  t.alike(kv({ pairs: [['url', 'ws://x'], ['k', 'v']], width: 12 }), [
    'url ws://x  ',
    'k   v       '
  ])

  t.is(sparkline([0, 1, 2, 3, 4, 5, 6, 7], 8), '▁▂▃▄▅▆▇█', 'the full ramp maps onto all eight bars')
  t.is(sparkline([2, 1], 6), '    █▁', 'right-anchored so the newest sample is rightmost')
  t.is(statusbar({ left: 'L', right: 'R', width: 10 }), ' L      R ')
  t.is(tabstrip({ tabs: [{ key: '1', label: 'User' }, { key: '2', label: 'Admin' }], active: '1', width: 22 }), ' [1] User  [2] Admin  ')

  setColor(true)
})

test('logPane keeps the newest line when the log overflows', (t) => {
  setColor(false)
  const entries = []
  for (let i = 0; i < 50; i++) entries.push({ text: 'line ' + i })

  const rendered = logPane({ entries, width: 10, height: 3 })
  t.alike(rendered, ['line 47   ', 'line 48   ', 'line 49   '])
  setColor(true)
})

test('list scrolls to keep the selection on screen', (t) => {
  setColor(false)
  const items = []
  for (let i = 0; i < 20; i++) items.push({ label: 'item' + i })

  t.alike(list({ items, selected: 0, width: 8, height: 3 }).map(stripAnsi), ['> item0 ', '  item1 ', '  item2 '])
  t.alike(list({ items, selected: 5, width: 8, height: 3 }), ['  item3 ', '  item4 ', '> item5 '], 'scrolls down to reveal the selection')
  t.alike(list({ items, selected: 19, width: 8, height: 3 }), ['  item17', '  item18', '> item19'])
  t.alike(
    list({ items, selected: 1, width: 8, height: 3, scroll: 10 }),
    ['> item1 ', '  item2 ', '  item3 '],
    'the selection overrides the caller\'s scroll hint'
  )
  setColor(true)
})

test('setColor(false) strips every escape from every widget', (t) => {
  setColor(false)

  const rendered = [].concat(
    box({ title: 'T', width: 40, height: 5, body: ['b'], footer: 'f', active: true }),
    box({ title: 'T', width: 40, height: 5, body: ['b'], footer: 'f', active: false }),
    list({ items: ITEMS, selected: 1, width: 40, height: 6 }),
    logPane({ entries: ENTRIES, width: 40, height: 6 }),
    table({ columns: COLUMNS, rows: ROWS, width: 40, height: 6 }),
    kv({ pairs: [['a', 'b']], width: 40 }),
    [
      sparkline([1, 2, 3], 40),
      statusbar({ left: 'l', right: 'r', width: 40 }),
      tabstrip({ tabs: [{ key: '1', label: 'U' }, { key: '2', label: 'A' }], active: '2', width: 40 })
    ]
  )

  for (const line of rendered) t.absent(line.includes(ESC), `no escape in ${JSON.stringify(line)}`)
  for (const name of Object.keys(style)) t.is(style[name]('x'), 'x', `style.${name} is identity`)

  setColor(true)
})

test('style emits the SGR codes the cast depends on', (t) => {
  setColor(true)

  t.is(style.bold('x'), '\x1b[1mx\x1b[0m')
  t.is(style.dim('x'), '\x1b[2mx\x1b[0m')
  t.is(style.red('x'), '\x1b[31mx\x1b[0m')
  t.is(style.green('x'), '\x1b[32mx\x1b[0m')
  t.is(style.yellow('x'), '\x1b[33mx\x1b[0m')
  t.is(style.magenta('x'), '\x1b[35mx\x1b[0m')
  t.is(style.cyan('x'), '\x1b[36mx\x1b[0m')
  t.is(style.inverse('x'), '\x1b[7mx\x1b[0m')

  // Styling must stay invisible to the arithmetic every widget runs on it.
  t.is(displayWidth(style.bold(style.cyan('abc'))), 3)
})

// ------------------------------------------------------------------ Screen --

test('a non-interactive Screen writes plain frames', (t) => {
  const out = recorder()
  const screen = new Screen({ out, interactive: false, columns: 80, rows: 24 })

  t.is(screen.columns, 80)
  t.is(screen.rows, 24)
  t.is(screen.interactive, false)

  screen.start()
  t.alike(out.chunks, [], 'no alt buffer, no cursor games')

  screen.render(['hello', 'world'])
  t.alike(out.chunks, ['hello\nworld\n\n'], 'one frame, blank line between frames')

  screen.render(['second'])
  t.alike(out.chunks, ['hello\nworld\n\n', 'second\n\n'], 'frames are appended, never diffed')

  t.absent(out.text().includes(ESC), 'nothing escaped leaked into the transcript')
})

test('a non-interactive Screen clips frames to its geometry', (t) => {
  const out = recorder()
  const screen = new Screen({ out, interactive: false, columns: 10, rows: 3 })

  const lines = []
  for (let i = 0; i < 9; i++) lines.push('row' + i + '-' + 'x'.repeat(40))
  screen.render(lines)

  const frame = out.chunks[0].split('\n')
  t.is(frame.length, 5, 'three rows plus the two trailing newlines')
  t.alike(frame.slice(0, 3), ['row0-xxxxx', 'row1-xxxxx', 'row2-xxxxx'])
  t.alike(frame.slice(3), ['', ''])
})

test('Screen.stop is idempotent', (t) => {
  const out = recorder()
  const screen = new Screen({ out, interactive: false, columns: 80, rows: 24 })

  screen.start()
  screen.render(['x'])
  const written = out.chunks.length

  screen.stop()
  screen.stop()
  screen.stop()
  t.is(out.chunks.length, written, 'a non-interactive stop restores nothing and repeats harmlessly')
})

test('Screen falls back to 80x24 when geometry is undetectable', (t) => {
  const screen = new Screen({ out: recorder(), interactive: false })
  t.is(screen.columns, 80)
  t.is(screen.rows, 24)
})

test('an interactive Screen enters and leaves the alternate buffer', (t) => {
  const out = recorder()
  const screen = new Screen({ out, interactive: true, columns: 10, rows: 4 })

  screen.start()
  t.is(out.chunks[0], '\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H', 'alt buffer, hide cursor, clear, home')

  screen.stop()
  t.is(out.chunks[out.chunks.length - 1], '\x1b[0m\x1b[?25h\x1b[?1049l', 'reset, show cursor, leave alt buffer')

  screen.stop()
  t.is(out.chunks.length, 2, 'the restore sequence is written once')
})

test('an interactive Screen rewrites only the rows that changed', (t) => {
  const out = recorder()
  const screen = new Screen({ out, interactive: true, columns: 10, rows: 4 })

  screen.start()
  out.chunks.length = 0

  screen.render(['aaa', 'bbb'])
  t.is(out.chunks.length, 1, 'one write per frame')
  t.is(out.chunks[0], '\x1b[1;1H\x1b[2Kaaa\x1b[2;1H\x1b[2Kbbb' + RESET)

  out.chunks.length = 0
  screen.render(['aaa', 'ccc'])
  t.is(out.chunks[0], '\x1b[2;1H\x1b[2Kccc' + RESET, 'row 1 was identical and cost nothing')

  out.chunks.length = 0
  screen.render(['aaa', 'ccc'])
  t.alike(out.chunks, [], 'an unchanged frame writes nothing at all')

  out.chunks.length = 0
  screen.render(['aaa'])
  t.is(out.chunks[0], '\x1b[2;1H\x1b[2K' + RESET, 'a vanished row is erased, not left behind')

  screen.stop()
})

test('an interactive Screen repaints in full after a resize', (t) => {
  const out = recorder()
  const screen = new Screen({ out, interactive: true, columns: 10, rows: 4 })

  const seen = []
  screen.on('resize', (size) => seen.push(size))

  screen.start()
  screen.render(['aaa'])
  out.chunks.length = 0

  out.emit('resize')
  t.alike(seen, [{ columns: 10, rows: 4 }], 'the resize is forwarded with the new geometry')

  screen.render(['aaa'])
  t.is(out.chunks[0], '\x1b[1;1H\x1b[2Kaaa' + RESET, 'the cached frame was dropped, so the row is redrawn')

  screen.stop()
  out.emit('resize')
  t.is(seen.length, 1, 'stop detaches the resize listener')
})

test('Screen survives a stream that throws on write', (t) => {
  // stop() runs from a signal handler, by which point stdout may be gone.
  const out = new EventEmitter()
  out.write = () => { throw new Error('EPIPE') }

  const screen = new Screen({ out, interactive: true, columns: 10, rows: 4 })
  screen.start()
  screen.render(['x'])
  screen.stop()
  t.pass('start, render and stop all swallowed the write failure')
})
