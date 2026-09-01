'use strict'

// Entry point for `npm test`. Each suite is a standalone brittle file, so an
// individual one can also be run directly: `bare test/core.js`.

require('./core')
require('./tui')
require('./store')
require('./relay')
require('./swarm')
require('./replication')
require('./cli')
require('./agent')
require('./workflow')
