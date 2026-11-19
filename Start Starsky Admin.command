#!/usr/bin/env bash
# macOS: double-click on the NODE machine. Opens Starsky wired straight to the LUMA nodes and control panels on THIS computer
# (Mainnet 6006 / panel 8090, Testnet 6106 / panel 8091). If the LUMA kit is next to this folder and no node is running, it starts it first.
DIR="$(cd "$(dirname "$0")" && pwd)"; cd "$DIR" || exit 1
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin"
PORT=8096
command -v node >/dev/null || { echo "Node.js is needed (nodejs.org). Install it, then run this again."; read -r -p "Press Return." _; exit 1; }
up() { curl -s -m 2 -X POST http://127.0.0.1:$1 -d '{"method":"server_info"}' 2>/dev/null | grep -q server_state; }
if ! up 5006 && ! up 5106; then
  KIT=""; for c in "$DIR/../lumanet" "$DIR/../LUMA" "$HOME/lumanet"; do [ -f "$c/luma-auto.sh" ] && { KIT="$c"; break; }; done
  if [ -n "$KIT" ]; then echo "No LUMA node answers here. Starting Mainnet and Testnet from $KIT ..."; (cd "$KIT" && chmod +x luma-auto.sh start-luma.sh lumactl 2>/dev/null; bash ./luma-auto.sh main; bash ./luma-auto.sh test)
  else echo "No LUMA node answers on this computer and the LUMA kit was not found next to this folder. Starsky will open but stay Offline until the nodes run."; fi
fi
OLD=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null); [ -n "$OLD" ] && kill $OLD 2>/dev/null
STARSKY_PORT=$PORT node admin/serve-admin.js &
SV=$!; trap 'kill $SV 2>/dev/null' EXIT
sleep 1; URL="http://127.0.0.1:$PORT/"
open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || echo "Open $URL in your browser."
echo; echo "Starsky (admin) is running at $URL. Leave this window open; close it to stop."
wait $SV
