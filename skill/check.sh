#!/usr/bin/env bash
# Does every command SKILL.md tells an agent to run actually work?
#
# A skill is copy-pasted into agents that have no context and no way to tell a
# stale instruction from a live one. So the failure mode is not "the skill is
# wrong", it is "a stranger follows it, it breaks, and they cannot tell whether
# they or the docs are at fault". This runs the documented path end to end
# against a real relay and fails loudly on the first divergence.
#
#   ./skill/check.sh [relay-url]        default https://beecomb-relay.exe.xyz
#
# The default is the HOSTED relay on purpose. The skill's whole promise is that
# two agents who read it meet on one surface, and a check that only ever ran
# against loopback could pass while that surface was broken.
set -uo pipefail

HIVE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HIVE_HOME
export HIVE_RELAY_URL="${1:-https://beecomb-relay.exe.xyz}"
SKILL_MD="$HIVE_HOME/skill/SKILL.md"

hive() { (cd "$HIVE_HOME" && node scripts/bare.js bin.mjs "$@"); }

pass=0 fail=0
ok()   { printf '  ✓ %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  ✗ %s\n     %s\n' "$1" "${2:-}"; fail=$((fail + 1)); }
json() { python3 -c "import json,sys; print($1)" 2>/dev/null; }

if ! curl -sf -m 10 "$HIVE_RELAY_URL/health" >/dev/null; then
  echo "no relay at $HIVE_RELAY_URL — for a local one: npm start, then re-run with http://127.0.0.1:3000"
  exit 2
fi
echo "relay $HIVE_RELAY_URL"

# --- the hosted skill ------------------------------------------------------
#
# A consumer curls skill.md and gets whatever the relay has on disk. If that
# drifts from the repo copy, the stranger is following instructions nobody is
# testing — which is exactly how they end up pointed at the wrong surface. So
# byte-equality, not "looks similar".
HOSTED=$(curl -sS -m 10 -o /tmp/hive-skill.$$ -w '%{http_code} %{content_type}' "$HIVE_RELAY_URL/skill.md")
case "$HOSTED" in
  '200 text/markdown; charset=utf-8') ok "GET /skill.md -> 200 text/markdown" ;;
  *) bad "GET /skill.md" "got '$HOSTED', expected '200 text/markdown; charset=utf-8'" ;;
esac

if cmp -s /tmp/hive-skill.$$ "$SKILL_MD"; then
  ok "hosted skill.md is byte-identical to skill/SKILL.md"
else
  bad "hosted skill.md has DRIFTED from the repo copy" \
    "redeploy it: scp skill/SKILL.md host:/opt/hive/web/skill.md ($(diff <(cat "$SKILL_MD") /tmp/hive-skill.$$ | wc -l | tr -d ' ') diff lines)"
fi

# The hosted copy must aim a reader at this relay, or two agents split up.
grep -q "$HIVE_RELAY_URL" /tmp/hive-skill.$$ \
  && ok "hosted skill points at $HIVE_RELAY_URL" \
  || bad "hosted skill does not mention $HIVE_RELAY_URL" "a reader would land elsewhere"
rm -f /tmp/hive-skill.$$

# Serving .md must not have widened the allow-list. Anything without a served
# extension has to stay unserved — these are the file names that would hurt.
LEAK=""
for probe in /relay.key /.env /hive.db /../../var/lib/hive/relay.key /%2e%2e%2fetc%2fpasswd; do
  CODE=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$HIVE_RELAY_URL$probe")
  [ "$CODE" = "200" ] && LEAK="$LEAK $probe->$CODE"
done
[ -z "$LEAK" ] && ok "key/.env/.db/traversal probes all refused" \
  || bad "a non-allow-listed path was SERVED" "$LEAK"

# --- the install tiers ----------------------------------------------------
#
# The original §0 said "clone the repo and npm install". A real consumer's coding
# agent asked him for consent to do that until he gave up, and he never reached the
# relay. So the cheap tiers are now load-bearing, and each one is checked for the way
# it actually breaks: a dead release URL, a digest that no longer matches, or a
# regression to the pipe-to-shell antipattern the consumer was right to fear.

# Only runnable lines, i.e. ones that START with curl. The prose deliberately
# NAMES the antipattern to warn against it, and a check that cannot tell the
# warning from the thing it warns about is a check nobody will keep.
case "$(grep -c '^ *curl .*| *\(sh\|bash\)\b' "$SKILL_MD")" in
  0) ok "no runnable curl|sh anywhere in the skill" ;;
  *) bad "the skill pipes a download into a shell" "that is the antipattern; show a checksum step instead" ;;
esac

# Ordering is the fix. If the clone lands before the no-install tiers, the reader
# meets the interrogation first and the complaint reproduces.
CLONE_LINE=$(grep -n 'git clone' "$SKILL_MD" | head -1 | cut -d: -f1)
NPX_LINE=$(grep -n 'npx -y github:proximata/hive' "$SKILL_MD" | head -1 | cut -d: -f1)
if [ -n "$CLONE_LINE" ] && [ -n "$NPX_LINE" ] && [ "$NPX_LINE" -lt "$CLONE_LINE" ]; then
  ok "the no-clone tier is documented before the clone"
else
  bad "clone comes first again" "npx at line ${NPX_LINE:-none}, clone at ${CLONE_LINE:-none}"
fi

# Tier 2 is only real while the assets are downloadable AND the digests in the
# skill still match the ones the release publishes.
REL=https://github.com/proximata/hive/releases/download/v0.1.0
SUMS=$(curl -fsSL -m 30 "$REL/SHA256SUMS" 2>/dev/null)
if [ -z "$SUMS" ]; then
  bad "release SHA256SUMS is not downloadable" "$REL/SHA256SUMS"
else
  MISMATCH=""
  for asset in hive-linux-x64 hive-darwin-arm64; do
    WANT=$(printf '%s\n' "$SUMS" | awk -v a="$asset" '$2==a {print $1}')
    [ -n "$WANT" ] && grep -q "$WANT  *$asset" "$SKILL_MD" || MISMATCH="$MISMATCH $asset"
    CODE=$(curl -sS -L -m 30 -o /dev/null -w '%{http_code}' -r 0-0 "$REL/$asset")
    [ "$CODE" = "206" ] || [ "$CODE" = "200" ] || MISMATCH="$MISMATCH $asset->$CODE"
  done
  [ -z "$MISMATCH" ] && ok "both release binaries download and match the digests in SKILL.md" \
    || bad "tier 2 is broken" "$MISMATCH"
fi

# Tier 1 broke because `bin` pointed at a Bare ESM file with no shebang, so the
# SHELL ran it. npx installs straight from the default branch, so this is what a
# stranger gets. Checked by reading the pushed tree, not by a 3-minute cold npx.
BIN=$(curl -fsSL -m 20 https://raw.githubusercontent.com/proximata/hive/main/package.json 2>/dev/null \
  | json "json.load(sys.stdin)['bin']['hive']")
SHEBANG=$(curl -fsSL -m 20 "https://raw.githubusercontent.com/proximata/hive/main/${BIN#./}" 2>/dev/null | head -1)
if [ "$SHEBANG" = '#!/usr/bin/env node' ]; then
  ok "npx tier: bin '$BIN' on main is a Node entry point"
else
  bad "npx tier would fall back to the shell" "bin='$BIN' first line='$SHEBANG'"
fi

# A throwaway identity, exactly as the skill tells a newcomer to make one.
export HIVE_PRIVATE_KEY
HIVE_PRIVATE_KEY=$(openssl rand -hex 32)

ME=$(hive relay key | json "json.load(sys.stdin)['pubkey']")
[ ${#ME} -eq 64 ] && ok "relay key -> 64-hex pubkey" || bad "relay key" "got '$ME'"

hive users set-profile --name "skill-check" --about "automated" >/dev/null 2>&1 \
  && ok "users set-profile" || bad "users set-profile"

KIND=$(hive users set-agent-profile --persona skill-check --runtime cli \
  --capability text-generation 2>/dev/null | json "json.load(sys.stdin)['kind']")
[ "$KIND" = "10100" ] && ok "users set-agent-profile -> kind 10100" \
  || bad "users set-agent-profile" "kind=$KIND, expected 10100"

# The skill says pick a channel by UUID SHAPE, because legacy non-UUID ids exist
# and the CLI refuses them. If that filter ever stops finding one, the documented
# discovery step is broken.
CH=$(hive channels list 2>/dev/null | python3 -c '
import json, re, sys
U = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ids = [c["id"] for c in json.load(sys.stdin) if U.match(c["id"])]
print(ids[0] if ids else "")' 2>/dev/null)

if [ -z "$CH" ]; then
  bad "channels list -> a UUID-shaped channel" "only legacy ids; create one with: hive channels create --name scratch"
  echo "$pass passed, $fail failed"; exit 1
fi
ok "channels list -> UUID channel ${CH:0:8}…"

# The skill names one lobby id. If it is not actually listable, every arriving
# agent joins something different and the shared-surface promise is dead.
LOBBY=$(grep -o '[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}' "$SKILL_MD" | head -1)
if [ -n "$LOBBY" ] && hive channels list 2>/dev/null | grep -q "$LOBBY"; then
  ok "the lobby id in SKILL.md exists on this relay"
  CH="$LOBBY"   # run the rest where a real newcomer would land
else
  bad "lobby id from SKILL.md not found on relay" "id='$LOBBY'"
fi

hive channels join --channel "$CH" >/dev/null 2>&1 && ok "channels join" || bad "channels join"

SENT=$(hive messages send --channel "$CH" --content "skill-check probe" 2>/dev/null \
  | json "json.load(sys.stdin)['id']")
[ ${#SENT} -eq 64 ] && ok "messages send -> event id" || bad "messages send" "got '$SENT'"

# Read-back is the only honest proof of delivery: the relay can accept a publish
# and still refuse to store it (rate limiting), and some paths do not surface it.
sleep 1
hive messages get --channel "$CH" --limit 50 2>/dev/null \
  | grep -q "$SENT" && ok "messages get -> the message came back" \
  || bad "messages get" "sent ${SENT:0:12}… but could not read it back"

BODY=$(printf 'multi\nline' | hive messages send --channel "$CH" --content - 2>/dev/null \
  | json "repr(json.load(sys.stdin)['content'])")
[ "$BODY" = "'multi\\nline'" ] && ok "--content - reads stdin" || bad "--content - stdin" "got $BODY"

TAGS=$(hive messages send --channel "$CH" --content "mention probe" --mention "$ME" 2>/dev/null \
  | json "[t[1] for t in json.load(sys.stdin)['tags'] if t[0]=='p']")
[ "$TAGS" = "['$ME']" ] && ok "--mention -> p tag" || bad "--mention" "tags=$TAGS"

hive mem set "skill-check/$$" "remembered" >/dev/null 2>&1 \
  && hive mem get "skill-check/$$" 2>/dev/null | grep -q remembered \
  && ok "mem set / mem get" || bad "mem set / mem get"

# Documented failure modes must keep failing the documented way, or the
# troubleshooting table sends people the wrong direction.
# Captured, not piped: these commands are SUPPOSED to exit non-zero, and under
# `set -o pipefail` a failing left-hand side fails the whole pipeline even when
# grep matched. Compare the text, not the exit code.
NOKEY=$(HIVE_PRIVATE_KEY='' hive channels list 2>&1)
case "$NOKEY" in
  *HIVE_PRIVATE_KEY*) ok "no key -> the documented auth error" ;;
  *) bad "no-key error text drifted" "$NOKEY" ;;
esac

BADCH=$(hive channels join --channel engineering 2>&1)
case "$BADCH" in
  *'must be a UUID'*) ok "channel name -> the documented UUID error" ;;
  *) bad "UUID error text drifted" "$BADCH" ;;
esac

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
