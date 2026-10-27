#!/usr/bin/env bash
# macOS: double-click this file. (First time: right-click > Open.)
cd "$(dirname "$0")" && bash ./start-starsky.sh "${1:-8095}"
echo; read -r -p "Press Return to close this window." _
