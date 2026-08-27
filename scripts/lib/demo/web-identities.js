'use strict'

// The cast and the rooms of the web demo, in one place.
//
// Two scripts drive the same relay — `demo-web-seed.js` furnishes the workspace
// and `demo-delegation.js` runs real agents inside it — and they have to agree
// on every pubkey and every channel id or the delegation lands in a room the
// recorder is not filming. Derivation, not configuration: both sides compute
// the same values from the same fixed strings.
//
// Keys are throwaway by construction. A secret is sha256("hive-web-demo/<name>")
// and is regenerated on every run, so nothing here is a key anyone can lose,
// and every handle is invented — no real person, customer or mailbox appears.

const core = require('hive-core')

const CH = {
  // #design is created first and therefore sorts first (listChannels is
  // ORDER BY created_at ASC), which is what leaves the page booted somewhere
  // other than #engineering — so the recorder's click is a real navigation.
  design: 'design',
  engineering: 'engineering',
  incidents: 'incidents',
  releases: 'releases',
  product: 'product',
  ops: 'ops'
}

const HUMAN_NAMES = [
  'alice', 'bob', 'cass', 'dov', 'ember', 'fen', 'gwen', 'hark', 'iris',
  'jonah', 'kit', 'lune', 'mira', 'nev', 'orin', 'pilar', 'quinn', 'rae'
]
const AGENT_NAMES = ['honey', 'scout', 'forge', 'tally', 'sable', 'wren']

// Who owns which agent. Ownership is the point of the delegation demo — an
// agent that belongs to nobody is a bot — so the pairing is declared rather
// than derived, and it is what `demo-web-seed.js` writes into each kind-10100
// profile's `owner` field.
const AGENT_OWNERS = {
  honey: 'alice',
  scout: 'bob',
  forge: 'cass',
  tally: 'dov',
  sable: 'ember',
  wren: 'fen'
}

// SPEC.md:250 and :471 say a channel id is a UUID, and hive-cli enforces it
// (`--channel must be a UUID`). This used to mint `<8hex>-room`, which the relay
// stored happily because it never validates the shape - so every seeded channel
// was unaddressable from the CLI. Same hash, still deterministic, now the shape
// the spec asks for.
const channelId = (name) => {
  const h = core.toHex(core.sha256(Buffer.from('hive-web-demo/ch/' + name)))
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

function identity (name) {
  const secretKey = core.sha256(Buffer.from(`hive-web-demo/${name}`, 'utf8'))
  return { name, secretKey, pubkey: core.getPublicKey(secretKey) }
}

module.exports = { CH, HUMAN_NAMES, AGENT_NAMES, AGENT_OWNERS, channelId, identity }
