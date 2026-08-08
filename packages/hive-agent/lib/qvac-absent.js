'use strict'

// Stand-in for `@qvac/sdk` when it is not installed.
//
// The SDK is an optional peer dependency, so `require('@qvac/sdk')` normally
// throws MODULE_NOT_FOUND and the callers in qvac.js catch that. Bundling
// breaks the arrangement: bare-pack resolves the whole module graph ahead of
// time and fails the build outright on a specifier it cannot find, which is
// why `hive demo` could not ship in the standalone binary.
//
// The `#qvac-sdk` import in package.json therefore lists this file as a
// fallback after the real SDK. Resolution now always succeeds — against the
// SDK when it is installed, against this module when it is not — and throwing
// from the top level keeps the runtime behaviour identical to the missing
// module it replaces.

throw new Error('@qvac/sdk is not installed')
