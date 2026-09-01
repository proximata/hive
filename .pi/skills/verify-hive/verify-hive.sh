#!/usr/bin/env bash
# Launch / doctor / cleanup for a throwaway local Hive relay.
#
# One file, three subcommands, no state outside $HIVE_VERIFY_RUN. Everything it
# does is also doable by hand; it exists because "is this instance worth
# driving?" has to be ONE command for a cold agent, and because tearing a Hive
# relay down correctly needs a descendant walk that nobody types from memory
# (node shim -> bare -> bare worker; the grandchild is what holds the port).
#
#   export HIVE_VERIFY_RUN="${TMPDIR:-/tmp}/verify-hive/$(date +%Y%m%d-%H%M%S)"
#   .pi/skills/verify-hive/verify-hive.sh launch a 3737
#   .pi/skills/verify-hive/verify-hive.sh doctor a
#   .pi/skills/verify-hive/verify-hive.sh cleanup
#
# Run it from the repo root. It never touches a relay it did not start: launch
# refuses a port that is already listening, and cleanup kills recorded PIDs,
# never a process name.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

if [ -z "${HIVE_VERIFY_RUN:-}" ]; then
  echo "HIVE_VERIFY_RUN is not set." >&2
  echo "  starting a NEW run:" >&2
  echo '    export HIVE_VERIFY_RUN="${TMPDIR:-/tmp}/verify-hive/$(date +%Y%m%d-%H%M%S)"' >&2
  # A new timestamp for an EXISTING run orphans its relay: doctor says nothing
  # was launched here, launch REFUSEs the port, cleanup never finds the pid.
  echo "  re-attaching to the run already in progress (doctor/cleanup ALWAYS want this):" >&2
  echo '    export HIVE_VERIFY_RUN=$(ls -dt "${TMPDIR:-/tmp}"/verify-hive/*/ | head -1)' >&2
  latest="$(ls -dt "${TMPDIR:-/tmp}"/verify-hive/*/ 2>/dev/null | head -1)"
  [ -n "$latest" ] && echo "  most recent run on this machine: $latest" >&2
  exit 2
fi
RUN="$HIVE_VERIFY_RUN"

listener_on() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }

# Every descendant of $1, deepest first. The listening socket belongs to a
# grandchild, so killing the recorded PID alone leaves the port held.
descendants() {
  local p c
  p="$1"
  for c in $(pgrep -P "$p" 2>/dev/null); do
    descendants "$c"
    echo "$c"
  done
}

cmd_launch() {
  local label="${1:-a}" port="${2:-3737}"
  local dir="$RUN/relay-$label"

  local squatter
  squatter="$(listener_on "$port")"
  if [ -n "$squatter" ]; then
    echo "REFUSE: port $port is already listening (pid $squatter). Pick another port or clean that up yourself." >&2
    echo "        A Hive relay whose port is taken prints NOTHING and hangs, so this check is the only warning you get." >&2
    exit 2
  fi

  mkdir -p "$dir" "$RUN/evidence"

  # One throwaway key per run, shared by every relay in it. 0600, under
  # $HIVE_VERIFY_RUN, which is outside the repo. Never write a key into the
  # checkout: hive-cli reads HIVE_PRIVATE_KEY from the environment only, so
  # there is no reason for one to exist on a tracked path.
  if [ ! -f "$RUN/key.env" ]; then
    umask 077
    printf 'export HIVE_PRIVATE_KEY=%s\n' \
      "$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" > "$RUN/key.env"
  fi

  ( cd "$REPO" && node scripts/bare.js bin.mjs relay \
      --port "$port" --host 127.0.0.1 \
      --storage "$dir/storage" \
      --no-updates --no-swarm > "$dir/relay.log" 2>&1 & echo $! > "$dir/relay.pid" )

  # Poll /health, never sleep-and-hope. A relay that is up answers within a
  # couple of seconds; one whose port was stolen between the check above and
  # here never answers at all.
  local i url
  url="http://127.0.0.1:$port"
  for i in $(seq 1 60); do
    curl -sf -m 2 "$url/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
  if ! curl -sf -m 2 "$url/health" >/dev/null 2>&1; then
    echo "FAIL: no /health from $url after 30s. Log:" >&2
    cat "$dir/relay.log" >&2
    exit 1
  fi

  # The relay's own identity keypair lives in the storage dir, so a fresh
  # storage dir means a pubkey no other relay can have. That is the handle
  # doctor uses to tell "my relay" from "a relay".
  curl -sS "$url/info" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["pubkey"])' > "$dir/relay.pubkey"

  # The process tree is node shim -> bare -> bare worker, and the WORKER holds
  # the socket. Kill the shim on its own and the worker is reparented to init,
  # still listening, invisible to any descendant walk — that is how a leftover
  # relay ends up squatting a port after a demo. So record the listener now,
  # while the port is provably ours, and kill it by that recorded pid later.
  listener_on "$port" > "$dir/listener.pid"

  printf 'export HIVE_RELAY_URL=%s\n' "$url" > "$dir/env.sh"

  echo "relay-$label up"
  echo "  url      $url"
  echo "  pid      $(cat "$dir/relay.pid") (launcher), $(cat "$dir/listener.pid") (listener)"
  echo "  pubkey   $(cat "$dir/relay.pubkey")"
  echo "  storage  $dir/storage"
  echo "  log      $dir/relay.log"
  echo "  env      source $dir/env.sh && source $RUN/key.env"
}

cmd_doctor() {
  local label="${1:-a}"
  local dir="$RUN/relay-$label"
  local rc=0

  if [ ! -f "$dir/relay.pid" ]; then
    echo "✗ no relay-$label in $RUN — nothing was launched here"
    return 1
  fi

  local pid url want got
  pid="$(cat "$dir/relay.pid")"
  url="$(sed -n 's/^export HIVE_RELAY_URL=//p' "$dir/env.sh")"
  want="$(cat "$dir/relay.pubkey" 2>/dev/null)"

  if kill -0 "$pid" 2>/dev/null; then echo "✓ launcher pid $pid alive"
  else echo "✗ launcher pid $pid is gone (its worker may still be squatting the port)"; rc=1; fi

  local listener now
  listener="$(cat "$dir/listener.pid" 2>/dev/null)"
  now="$(listener_on "$(sed -n 's/.*:\([0-9]*\)$/\1/p' "$dir/env.sh")")"
  if [ "$listener" = "$now" ] && [ -n "$now" ]; then echo "✓ listener pid $now is the one this run started"
  elif [ -z "$now" ]; then echo "✗ nothing is listening on that port (this run started pid $listener)"; rc=1
  else echo "✗ listener pid is $now, this run started $listener"; rc=1; fi

  local health
  health="$(curl -sS -m 5 "$url/health" 2>/dev/null)"
  case "$health" in
    *'"status":"ready"'*) echo "✓ $url/health ready — $health" ;;
    '') echo "✗ nothing answering at $url — no relay here"; return 1 ;;
    *) echo "✗ $url/health not ready — $health"; rc=1 ;;
  esac

  got="$(curl -sS -m 5 "$url/info" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["pubkey"])' 2>/dev/null)"
  if [ -z "$got" ]; then
    echo "✗ $url answers but serves no NIP-11 /info — that is not a Hive relay"; rc=1
  elif [ "$got" = "$want" ]; then
    echo "✓ identity matches the relay this run started ($got)"
  else
    echo "✗ STALE OR FOREIGN RELAY on this port: got $got, this run started $want"
    echo "  Do not drive it and do not kill it. Relaunch on a different port."
    rc=1
  fi

  [ $rc -eq 0 ] && echo "doctor: relay-$label is worth driving" || echo "doctor: relay-$label is NOT worth driving"
  return $rc
}

cmd_cleanup() {
  local dir pid port kid left
  for dir in "$RUN"/relay-*; do
    [ -d "$dir" ] || continue
    [ -f "$dir/relay.pid" ] || continue
    pid="$(cat "$dir/relay.pid")"
    port="$(sed -n 's/.*:\([0-9]*\)$/\1/p' "$dir/env.sh")"

    # Only kill the recorded listener if it is STILL the pid we recorded and it
    # still answers with our relay's identity. Anything else on that port is
    # somebody else's process and gets reported, not killed.
    local listener now
    listener="$(cat "$dir/listener.pid" 2>/dev/null)"
    now="$(listener_on "$port")"
    if [ -n "$listener" ] && [ "$listener" != "$now" ] && [ -n "$now" ]; then
      echo "! port $port is held by pid $now, not the $listener this run started — leaving it alone"
      listener=""
    fi

    # Deepest first, then the recorded listener, which may already have been
    # orphaned onto init and so appears in no descendant walk.
    for kid in $(descendants "$pid") "$pid" $listener; do
      kill "$kid" 2>/dev/null
    done
    sleep 1
    for kid in $(descendants "$pid") "$pid" $listener; do
      kill -9 "$kid" 2>/dev/null
    done

    left="$(listener_on "$port")"
    if [ -n "$left" ]; then
      echo "✗ port $port still held by pid $left after killing the tree rooted at $pid"
      echo "  Inspect it before killing anything: lsof -nP -iTCP:$port -sTCP:LISTEN"
    else
      echo "✓ $(basename "$dir") stopped, port $port free"
    fi
    rm -rf "$dir/storage"
  done
  echo "evidence kept at $RUN/evidence"
}

case "${1:-}" in
  launch)  shift; cmd_launch "$@" ;;
  doctor)  shift; cmd_doctor "$@" ;;
  cleanup) shift; cmd_cleanup "$@" ;;
  *) echo "usage: verify-hive.sh {launch [label] [port] | doctor [label] | cleanup}" >&2; exit 2 ;;
esac
