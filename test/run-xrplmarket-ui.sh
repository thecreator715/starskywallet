#!/usr/bin/env bash
# Starsky NFT bridge in a browser against the real panel + simulated chains (throwaway copy under /tmp/nbui).
set -u
S="$(cd "$(dirname "$0")/.." && pwd)"; L=/home/claude/lumanet; T=/tmp/nbui; rm -rf $T; mkdir -p $T; cp -r "$L/panel" "$L/test" "$L/scripts" "$L/profiles.json" $T/ ; mkdir -p $T/network; mkdir -p $T/lumanet; ln -s $T/panel $T/lumanet/panel
( cd $T && npm install xrpl@5.3.0 --no-audit --no-fund --silent >/dev/null 2>&1 )
echo '[{"name":"val1","role":"validator","public":"n9TestVal1","seed":"ssTestVal1","main":true},{"name":"api1","role":"api"}]' > $T/network/nodes.json; printf 'LUMA_GENESIS_PASSPHRASE=test-genesis-secret-xyz\n' > $T/.env
cd $T
node test/mock-kubo.js 5399 >/dev/null 2>&1 & K2=$!; node test/mock-kubo.js 5001 8081 >/dev/null 2>&1 & K=$!
LUMA_FUND_EACH=100 GENESIS_PASSPHRASE=test-genesis-secret-xyz node test/mock-rippled.js >/dev/null 2>&1 & M1=$!
MOCK_PORTS=5300 MOCK_NETWORK_ID=1 GENESIS_PASSPHRASE=xrpl-genesis-pass node test/mock-rippled.js >/dev/null 2>&1 & M2=$!
sleep 1; node "$S/test/ws-proxy.js" 6005 5005 >/dev/null 2>&1 & W1=$!; node "$S/test/ws-proxy.js" 6300 5300 >/dev/null 2>&1 & W2=$!
( cd "$S" && node serve.mjs 4173 >/dev/null 2>&1 ) & SV=$!
LUMA_IPFS_API=http://127.0.0.1:5399 LUMA_NFTB_ALLOW_PRIVATE=1 LUMA_FUND_EACH=100 PANEL_PORT=18094 node panel/server.js >/dev/null 2>&1 & P=$!
sleep 2.5
( cd "$S/test" && NODE_PATH="/opt/npm-tools/node_modules:$T/node_modules:$S/node_modules:$S/test/node_modules" node xrplmarket-ui.cjs 18094 "$(cat $T/network/panel-token)" 5300 5005 ws://127.0.0.1:6300 ws://127.0.0.1:6005 ); RC=$?
kill $K $K2 $M1 $M2 $W1 $W2 $SV $P 2>/dev/null; exit $RC
