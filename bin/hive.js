#!/usr/bin/env node
'use strict'

// The published `hive` bin.
//
// `bin.mjs` is a Bare script, not a Node one: its very first line imports
// `bare-os`. Pointing package.json's `bin` straight at it means npm links a
// file the shell then tries to execute itself — which is exactly what
// `npx github:proximata/hive` did, printing "import: command not found" for
// every line of the file. So the linked bin has to be Node-executable and boot
// Bare itself.
//
// The `bare` binary is deliberately not looked up on PATH; see scripts/bare.js
// for why that never works. This shim reuses that resolution rather than
// repeating it.

const path = require('path')
const { runBare } = require('../scripts/bare.js')

runBare([path.join(__dirname, '..', 'bin.mjs'), ...process.argv.slice(2)])
