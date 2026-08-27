// Contrast self-check for public/tokens.css.
//
//   node packages/hive-web/test-tokens.mjs
//
// Reads the colours back out of the CSS rather than restating them, so the file
// and the check cannot drift. Deliberately standalone: the repo's `npm test`
// suite is CJS running under bare, and this is a node-only string exercise with
// no reason to be in the relay's regression gate.
//
// Lives outside public/ so the relay never serves it.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CSS = new URL('./public/tokens.css', import.meta.url)
const AA = 4.5 // WCAG 2.2 SC 1.4.3, normal-size text
const NON_TEXT = 3 // SC 1.4.11 / 2.4.11, borders and focus indicators

// WCAG 2.x relative luminance and contrast ratio.
function luminance (hex) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast (a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Only :root declarations, and only the ones whose value is a bare hex.
const source = readFileSync(CSS, 'utf8')
const root = source.slice(source.indexOf(':root'), source.indexOf('\nbody'))
const colors = new Map(
  [...root.matchAll(/^\s*(--[a-z-]+):\s*(#[0-9a-f]{6})\s*;/gim)]
    .map(([, name, hex]) => [name, hex.toLowerCase()])
)

assert.ok(colors.has('--bg'), 'tokens.css must define --bg')
const bg = colors.get('--bg')
colors.delete('--bg')
assert.ok(colors.size >= 7, `expected the 7 foreground tokens, found ${colors.size}`)

// Every foreground token is used as body text somewhere -- --muted is dim log
// text as well as the panel rule, --fail is a refusal line as well as the ✗
// glyph -- so they are all held to the body-text threshold, not the 3:1 one.
const rows = []
let failed = 0

for (const [name, hex] of colors) {
  const ratio = contrast(hex, bg)
  const ok = ratio >= AA
  if (!ok) failed++
  rows.push([ok ? 'ok  ' : 'FAIL', name, hex, ratio.toFixed(2), `>= ${AA}`])
}

// SGR 7 inverse: the status bar and ::selection swap fg and bg.
const inverse = contrast(bg, colors.get('--fg'))
rows.push([inverse >= AA ? 'ok  ' : 'FAIL', 'inverse (--bg on --fg)', bg, inverse.toFixed(2), `>= ${AA}`])
if (inverse < AA) failed++

// The focus ring is a non-text indicator, held to 3:1.
const ring = contrast(colors.get('--accent'), bg)
rows.push([ring >= NON_TEXT ? 'ok  ' : 'FAIL', 'focus ring (--accent)', colors.get('--accent'), ring.toFixed(2), `>= ${NON_TEXT}`])
if (ring < NON_TEXT) failed++

const w = Math.max(...rows.map((r) => r[1].length))
for (const [status, name, hex, ratio, need] of rows) {
  console.log(`${status} ${name.padEnd(w)}  ${hex}  ${ratio.padStart(6)}:1  ${need}`)
}

// The monokai red the TUI actually renders. Asserted so nobody "restores" it
// without noticing why it was changed.
assert.ok(
  contrast('#f92672', bg) < AA,
  '#f92672 now passes AA -- the --fail lift can be reverted'
)
assert.notEqual(colors.get('--fail'), '#f92672', '--fail must stay lifted off monokai red')

assert.equal(failed, 0, `${failed} token pair(s) below threshold`)
console.log(`\n${rows.length} pair(s) checked, all pass. bg ${bg}`)
