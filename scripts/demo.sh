#!/usr/bin/env bash
# Demo script for Hive - shows key features

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "🐝 Hive Demo - Pears-stack analog of Block/Buzz"
echo "==============================================="
echo ""

echo "1️⃣  Starting relay in background..."
bare . &
RELAY_PID=$!
sleep 3

echo "2️⃣  Creating a channel..."
hive channel create --name "general" --description "General discussion"

echo ""
echo "3️⃣  Publishing a message..."
hive event publish --kind 1 --content "Hello from Hive on the Pears stack!"

echo ""
echo "4️⃣  Subscribing to events..."
timeout 5 hive relay subscribe --kinds 1 --limit 10 || true

echo ""
echo "5️⃣  Starting an agent with QVAC..."
cat > /tmp/demo-agent.yaml <<EOF
name: "demo-agent"
persona:
  name: "Demo Agent"
  about: "A demo agent for Hive"
  runtime: "qvac"
  model: "llama-3.2-1b"
  provider: "local"
EOF
hive agent start --persona /tmp/demo-agent.yaml &
AGENT_PID=$!
sleep 2

echo ""
echo "6️⃣  Testing Hyperswarm connectivity..."
echo "Relay public key: $(hive relay pubkey)"

echo ""
echo "7️⃣  Running workflow..."
cat > /tmp/demo-workflow.yaml <<EOF
name: "welcome-workflow"
trigger: "message_posted"
filter: "content.includes('hello')"
actions:
  - type: "send_message"
    channel: "general"
    content: "👋 Welcome to Hive! This workflow was triggered automatically."
EOF
hive workflow apply /tmp/demo-workflow.yaml

echo ""
echo "🧪 Running tests..."
npm test 2>&1 | tail -20

echo ""
echo "🛑 Stopping demo..."
kill $RELAY_PID 2>/dev/null || true
kill $AGENT_PID 2>/dev/null || true

echo ""
echo "✅ Demo complete!"
echo "   Repository: https://github.com/qwadratic/hive"
echo "   SPEC.md: https://github.com/qwadratic/hive/blob/main/SPEC.md"