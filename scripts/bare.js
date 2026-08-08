#!/usr/bin/env node
'use strict'

// Launch the Bare runtime without depending on `bare` being on PATH.
//
// bare-runtime fans out into one package per platform/arch, and every one of
// them declares the same `bare` bin name. npm refuses to link a bin claimed by
// several packages, so none of them win and `bare` is never installed into
// node_modules/.bin. Scripts that just say `bare foo.js` therefore die with
// "bare: not found" — which is exactly what CI did for every run, silently,
// because the failure was piped into `tail`.
//
// Resolving the binary through the module graph works the same way locally, in
// CI, and inside a workspace, with no global install.

const path = require('path')
const { spawn } = require('child_process')

// bare-runtime gates deep imports through its `exports` map, which exposes
// "./package" rather than "./package.json", so try both rather than assuming
// either shape survives a version bump.
function resolveBare () {
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

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' })

child.on('error', (err) => {
  console.error(`could not start ${binary}: ${err.message}`)
  process.exit(1)
})

// Propagate the child's fate exactly, so a failing test run fails the script.
child.on('exit', (code, signal) => {
  if (signal !== null) process.exit(1)
  process.exit(code ?? 1)
})
