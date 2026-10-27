#!/usr/bin/env bash
# Starts Starsky (wallet, DEX, network scan) and opens it in your browser. Usage: ./start-starsky.sh [port]
cd "$(dirname "$0")"
PORT="${1:-8095}"
command -v node >/dev/null || { echo "Node.js is needed (https://nodejs.org). Install it, then run this again."; exit 1; }
# rebuild whenever the source is newer than the last build, so an update is never hidden by an old build
NEED=0
[ -f dist/index.html ] || NEED=1
[ -n "$(find src index.html package.json vite.config.ts -newer dist/index.html -print -quit 2>/dev/null)" ] && NEED=1
if [ "$NEED" = 1 ]; then
  echo "Building the latest Starsky…"; { [ -d node_modules ] || npm install; } && npm run build || exit 1
fi
# stop an older Starsky still running on this port
if command -v lsof >/dev/null; then OLD=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null); [ -n "$OLD" ] && { echo "Stopping the old Starsky on port $PORT…"; kill $OLD 2>/dev/null; sleep 1; }; fi
URL="http://127.0.0.1:$PORT"
( sleep 1; (open "$URL" || xdg-open "$URL" || true) >/dev/null 2>&1 ) &
echo "Starsky: $URL   (Ctrl+C to stop). It connects to your LUMA node at ws://127.0.0.1:6006 (Mainnet) / 6106 (Testnet)."
exec node serve.mjs "$PORT"
