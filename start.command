#!/bin/bash
# Double-click this file to launch BookApp.
# It starts a local web server in this folder, then opens your browser.

cd "$(dirname "$0")"

# Pick a free port (5173 by default; bump if taken)
PORT=5173
while lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

echo ""
echo "📖  BookApp — starting on http://localhost:$PORT"
echo ""
echo "Leave this window open while you write."
echo "Close it (or press Ctrl+C) when you're done."
echo ""

# Open browser after a short delay so the server is ready
( sleep 1 && open "http://localhost:$PORT" ) &

# Serve. python3 ships with macOS.
python3 -m http.server $PORT
