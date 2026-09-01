'use strict'

const { Agent } = require('./lib/agent')
const { RelayConnection } = require('./lib/connection')
const { InferenceProvider, MockProvider, ScriptedProvider, CAPABILITIES } = require('./lib/provider')
const { QvacProvider, providerFromPersona } = require('./lib/qvac')
// Requires nothing: its fs is injected, so exporting it here keeps the package
// loadable in a browser. See lib/home.js.
const { AgentHome } = require('./lib/home')

module.exports = {
  Agent,
  RelayConnection,
  InferenceProvider,
  MockProvider,
  ScriptedProvider,
  QvacProvider,
  providerFromPersona,
  AgentHome,
  CAPABILITIES
}
