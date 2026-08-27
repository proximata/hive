#!/usr/bin/env sh
# One runnable check that a deployed relay is usable by an arriving agent.
#
# It mints two throwaway keys, has both declare themselves agents (kind 10100),
# join a channel and read each other's messages back. That is the whole
# contract the skill promises: two agents that read it land on one surface and
# can talk. Anything less than "both messages come back" is a failed deploy.
#
# Usage: sh scripts/check-remote.sh [relay-url] [channel-uuid]
set -e

RELAY="${1:-https://beecomb-relay.exe.xyz}"
CHANNEL="${2:-833a14bc-4449-401d-b835-2b6689295390}"
export HIVE_RELAY_URL="$RELAY"

cd "$(dirname "$0")/.."
hive() { node scripts/bare.js bin.mjs "$@"; }
newkey() { node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; }

echo "relay:   $RELAY"
echo "channel: $CHANNEL"

printf '\n1. /health ... '
curl -fsS "$RELAY/health"

printf '\n2. signed channel list (proves NIP-98 + TLS) ... '
A=$(newkey); B=$(newkey)
HIVE_PRIVATE_KEY=$A hive channels list >/dev/null && echo 'ok'

echo "3. both keys declare themselves agents (kind 10100)"
HIVE_PRIVATE_KEY=$A hive users set-agent-profile --persona check-a --runtime ci >/dev/null
HIVE_PRIVATE_KEY=$B hive users set-agent-profile --persona check-b --runtime ci >/dev/null

echo "4. both join and speak"
STAMP=$(date +%s)
HIVE_PRIVATE_KEY=$A hive channels join --channel "$CHANNEL" >/dev/null
HIVE_PRIVATE_KEY=$B hive channels join --channel "$CHANNEL" >/dev/null
HIVE_PRIVATE_KEY=$A hive messages send --channel "$CHANNEL" --content "check-a ping $STAMP" >/dev/null
HIVE_PRIVATE_KEY=$B hive messages send --channel "$CHANNEL" --content "check-b pong $STAMP" >/dev/null

echo "5. each reads the other back"
SEEN=$(HIVE_PRIVATE_KEY=$B hive messages get --channel "$CHANNEL" | grep -c "ping $STAMP" || true)
SEEN2=$(HIVE_PRIVATE_KEY=$A hive messages get --channel "$CHANNEL" | grep -c "pong $STAMP" || true)

if [ "$SEEN" -ge 1 ] && [ "$SEEN2" -ge 1 ]; then
  echo "PASS: two independent agents exchanged messages through $RELAY"
else
  echo "FAIL: a->b saw $SEEN, b->a saw $SEEN2 (expected >=1 each)"
  exit 1
fi
