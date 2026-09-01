// Drive the WebSocket surface: NIP-42 AUTH, then one REQ, then EOSE.
//
// It reuses test/client.js rather than reimplementing a Nostr client, because
// the relay's framing rules (AUTH first, EOSE terminates the historical batch)
// already have exactly one correct implementation in this repo.
//
// Bare has no global fetch and no process.argv; arguments come from Bare.argv.
// The script must live INSIDE the checkout — a copy under /tmp cannot resolve
// `hive-relay` and dies on the first require.
//
//   node scripts/bare.js .pi/skills/verify-hive/ws-probe.js <port> <hex-sk> '<filter-json>'
const path = require('bare-path')
const { TestClient } = require(path.join(__dirname, '..', '..', '..', 'test', 'client.js'))
const { getPublicKey } = require('hive-core')

const port = Number(Bare.argv[2])
const secretKey = Bare.argv[3]
const filter = JSON.parse(Bare.argv[4])

async function main () {
  const client = await TestClient.openWebSocket({ port })
  const ok = await client.authenticate({ secretKey }, { relayUrl: `ws://127.0.0.1:${port}` })
  const { events, closed } = await client.subscribe('probe', filter)
  console.log(JSON.stringify({
    pubkey: getPublicKey(secretKey),
    authenticated: ok.accepted === true,
    closed: closed ?? null,
    events: events.map((e) => ({ kind: e.kind, content: e.content }))
  }, null, 2))
  await client.destroy()
  Bare.exit(0)
}

main().catch((err) => { console.error('ERR', err.message); Bare.exit(1) })
