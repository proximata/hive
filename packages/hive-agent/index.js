'use strict'

const { Agent } = require('./lib/agent')
const { RelayConnection } = require('./lib/connection')
const { InferenceProvider, MockProvider, CAPABILITIES } = require('./lib/provider')
const { QvacProvider, providerFromPersona: qvacProviderFromPersona } = require('./lib/qvac')
const { CodingAgentProvider, providerFromPersona: codingAgentProviderFromPersona } = require('./lib/coding-agent')

// Combined provider factory that tries each in order
function providerFromPersona (persona, opts = {}) {
  return codingAgentProviderFromPersona(persona, opts) ??
    qvacProviderFromPersona(persona, opts) ??
    null
}

module.exports = {
  Agent,
  RelayConnection,
  InferenceProvider,
  MockProvider,
  QvacProvider,
  CodingAgentProvider,
  providerFromPersona,
  CAPABILITIES
}
