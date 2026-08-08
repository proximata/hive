#!/usr/bin/env node
'use strict'

// Launch the TUI demo under Bare.
//
// Same problem, same fix as scripts/bare.js: bare-runtime fans out into one
// package per platform and they all claim the `bare` bin name, so npm links
// none of them and `bare scripts/demo-tui.js` is "bare: not found" everywhere.
// Resolving the binary through the module graph works locally and in CI.
//
// This exists separately from `node scripts/bare.js scripts/demo-tui.js`
// because npm splices `--` arguments after the script path, and the demo's
// flags have to reach demo-tui.js rather than land on bare's own command line.

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

/**
 * The interpreter binary itself, not bare-runtime's `bin/bare` shim. The shim
 * spawns the binary with suppressSignals, which means it ignores SIGINT and
 * SIGTERM on purpose — a signal forwarded to it would stop there and never
 * reach the TUI, and the TUI is the only process that can hand the terminal
 * back. bare-runtime's main export resolves the real path for this platform.
 */
function resolveBare () {
  try {
    const binary = require('bare-runtime')('bare')
    // The platform packages ship the binary without the execute bit on some
    // npm versions; the shim chmods it for the same reason.
    try {
      fs.accessSync(binary, fs.constants.X_OK)
    } catch {
      fs.chmodSync(binary, 0o755)
    }
    return binary
  } catch {
    // No binary for this platform, or an older layout: the shim still runs,
    // it just cannot be signalled.
  }

  for (const specifier of ['bare-runtime/package', 'bare-runtime/package.json', 'bare-runtime']) {
    try {
      return path.join(path.dirname(require.resolve(specifier)), 'bin', 'bare')
    } catch {
      continue
    }
  }

  return null
}

const binary = resolveBare()
if (binary === null) {
  console.error('bare-runtime is not installed; run `npm install` first')
  process.exit(1)
}

const entry = path.join(__dirname, 'demo-tui.js')

// stdio inherit, not a pipe: the TUI needs the real terminal on both ends —
// fd 0 for raw-mode keys, fd 1 for its size and its escape sequences.
const child = spawn(binary, [entry, ...process.argv.slice(2)], { stdio: 'inherit' })

// A signal aimed at this wrapper — a CI job timeout, `timeout`, an IDE's stop
// button — has to reach the TUI, because the TUI is the only process that can
// hand the terminal back. Nothing is done here beyond forwarding: the child's
// own handlers restore the screen and then exit, and the 'exit' handler below
// carries its code out.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    try {
      child.kill(signal)
    } catch {
      process.exit(1)
    }
  })
}

child.on('error', (err) => {
  console.error(`could not start ${binary}: ${err.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal !== null) process.exit(1)
  process.exit(code ?? 1)
})
