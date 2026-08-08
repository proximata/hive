'use strict'

// The scope set exists so a scoped-token path can be added later without
// touching every call site. A successful NIP-42 or NIP-98 authentication grants
// all of them today.

const SCOPES = [
  'MessagesRead',
  'MessagesWrite',
  'ChannelsRead',
  'ChannelsWrite',
  'AdminChannels',
  'UsersRead',
  'UsersWrite',
  'AdminUsers',
  'JobsRead',
  'JobsWrite',
  'SubscriptionsRead',
  'SubscriptionsWrite',
  'FilesRead',
  'FilesWrite'
]

function allScopes () {
  return [...SCOPES]
}

class AuthContext {
  constructor ({ pubkey, scopes = allScopes(), method }) {
    this.pubkey = pubkey
    this.scopes = scopes
    this.method = method
  }

  has (scope) {
    return this.scopes.includes(scope)
  }
}

module.exports = { SCOPES, allScopes, AuthContext }
