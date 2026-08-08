#!/usr/bin/env bash
# Record demo with asciinema and convert to GIF/video

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --tui records the TUI demo instead of an interactive shell session. It is
# unattended: the scene script drives the terminal, so there is nothing to type
# and nothing to stop with Ctrl+D.
if [ "${1:-}" = "--tui" ]; then
    shift
    CAST_FILE="${1:-docs/demo-tui.cast}"
    GIF_FILE="${CAST_FILE%.cast}.gif"
    COLS=120
    ROWS=35

    mkdir -p "$(dirname "$CAST_FILE")"

    echo "Recording the TUI demo to $CAST_FILE"
    asciinema rec "$CAST_FILE" --overwrite --cols "$COLS" --rows "$ROWS" \
        --command "npm run demo:tui -- --record"

    if command -v agg &> /dev/null; then
        echo "Rendering $GIF_FILE"
        agg "$CAST_FILE" "$GIF_FILE" --theme monokai --font-size 14 --cols "$COLS" --rows "$ROWS"
    else
        # Deliberately not falling back to scripts/cast-to-svg.js: it prints one
        # output chunk verbatim, and a chunk of a TUI cast is a cursor move and
        # three changed rows, not a frame.
        echo "agg is not installed, skipping the GIF"
    fi

    echo "Wrote $CAST_FILE"
    exit 0
fi

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