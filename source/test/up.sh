#!/usr/bin/env bash
# starts simulated LUMA mainnet (rpc 5006/ws 6006) + testnet (5106/6106), seeds both
cd "$(dirname "$0")"; mkdir -p .run; rm -f .run/*
MOCK_PORTS=5006 MOCK_NETWORK_ID=4242 node mock-rippled.js > .run/m1.log 2>&1 & echo $! >> .run/pids
MOCK_PORTS=5106 MOCK_NETWORK_ID=4243 GENESIS_PASSPHRASE=test-genesis-testnet node mock-rippled.js > .run/m2.log 2>&1 & echo $! >> .run/pids
sleep 1.5
node ws-proxy.js 6006 5006 > .run/w1.log 2>&1 & echo $! >> .run/pids
node ws-proxy.js 6106 5106 > .run/w2.log 2>&1 & echo $! >> .run/pids
node seed.js 5006 .run/seed-main.json && GENESIS_PASSPHRASE=test-genesis-testnet node seed.js 5106 .run/seed-test.json
echo up
