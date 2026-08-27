// Raw signed NIP-01 query against a relay, for verification.
// Usage: node scripts/bare.js scripts/query-remote.js <relay-url> <hex-sk> '<filters-json>'
const { RelayClient } = require('hive-cli/lib/client')
const client = new RelayClient({ url: Bare.argv[2], secretKey: Bare.argv[3] })
client.query(JSON.parse(Bare.argv[4]))
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => { console.error('ERR', e.message); Bare.exit(1) })
