#!/usr/bin/env bash
# Record demo with asciinema and convert to GIF/video

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CAST_FILE="${1:-demo.cast}"
GIF_FILE="${CAST_FILE%.cast}.gif"
MP4_FILE="${CAST_FILE%.cast}.mp4"

echo "📹 Recording asciinema demo..."
echo "Press Ctrl+D to stop recording"
echo ""

# Record the session
asciinema rec "$CAST_FILE" --command "bash --rcfile <(echo 'PS1=\"\$ \"; export TERM=xterm-256color')"

echo ""
echo "✅ Recording saved to $CAST_FILE"

# Convert to GIF if agg is available
if command -v agg &> /dev/null; then
    echo "🎨 Converting to GIF..."
    agg "$CAST_FILE" "$GIF_FILE" --theme monokai --font-size 14 --cols 120 --rows 35
    echo "✅ GIF saved to $GIF_FILE"
fi

# Convert to MP4 if asciinema-player or similar is available
if command -v asciinema2gif &> /dev/null; then
    echo "🎬 Converting to MP4..."
    asciinema2gif "$CAST_FILE" "$MP4_FILE"
    echo "✅ MP4 saved to $MP4_FILE"
fi

echo ""
echo "📤 Upload to GitHub:"
echo "  gh release upload v0.1.0 $CAST_FILE $GIF_FILE $MP4_FILE"