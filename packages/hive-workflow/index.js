'use strict'

const { WorkflowEngine, MAX_CONCURRENT_RUNS, APPROVAL_TIMEOUT_S } = require('./lib/engine')
const definition = require('./lib/definition')
const expression = require('./lib/expression')

module.exports = {
  WorkflowEngine,
  MAX_CONCURRENT_RUNS,
  APPROVAL_TIMEOUT_S,
  ...definition,
  ...expression
}
