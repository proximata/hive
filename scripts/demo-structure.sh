#!/usr/bin/env bash
# Demo script for Hive - shows key features without running the binary

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "🐝 Hive Demo - Pears-stack analog of Block/Buzz"
echo "==============================================="
echo ""

echo "📁 Project Structure:"
echo "===================="
tree -L 2 -I 'node_modules' .

echo ""
echo "📋 SPEC.md Overview:"
echo "==================="
head -100 SPEC.md

echo ""
echo "🧪 Running Tests:"
echo "================="
npm test 2>&1 | tail -30

echo ""
echo "🔑 Key Packages:"
echo "================"
for pkg in packages/*/package.json; do
  name=$(jq -r '.name' "$pkg")
  desc=$(jq -r '.description' "$pkg")
  echo "  📦 $name - $desc"
done

echo ""
echo "🔧 Build Script:"
echo "================"
cat scripts/make.js

echo ""
echo "✅ Demo complete!"
echo "   Repository: https://github.com/qwadratic/hive"
echo "   SPEC.md: https://github.com/qwadratic/hive/blob/main/SPEC.md"