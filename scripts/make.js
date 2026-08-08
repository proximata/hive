'use strict'

// Build a standalone binary for the host platform. `bare-build` compiles
// bin.mjs and its dependencies into a single executable with no peer
// dependencies — users need neither Node, nor Bare, nor the Pear CLI.
//
// Cross-building is not supported for native addons, so each platform's binary
// is produced on a matching host (that is what the make:* scripts are for in
// CI).

const os = require('bare-os')
const { spawn } = require('bare-subprocess')

const target = `${os.platform()}-${os.arch()}`
const script = `make:${target}`

const supported = [
  'linux-x64', 'linux-arm64',
  'darwin-x64', 'darwin-arm64',
  'win32-x64', 'win32-arm64'
]

if (!supported.includes(target)) {
  console.error(`no build target for ${target}; supported: ${supported.join(', ')}`)
  Bare.exit(1)
}

console.log(`building ${target} → out/${target}`)

const child = spawn('npm', ['run', script], { stdio: 'inherit', shell: os.platform() === 'win32' })
child.on('exit', (code) => Bare.exit(code ?? 0))
