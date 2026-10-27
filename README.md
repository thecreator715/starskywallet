# Starsky: LUMA and XRPL wallet, DEX and network scan

Standalone app. It talks straight to a LUMA node (Mainnet 4242 default `ws://127.0.0.1:6006`, Testnet 4243 `ws://127.0.0.1:6106`) or to XRPL. Change the node address in the banner or Settings.

Run: `npm install && npm run dev` (or `npm run build` and serve `dist/`).

## Pages (all read from the connected node)
- **Portfolio / Wallets / Send / Receive / History / NFTs**: your wallets, encrypted in this browser with your password.
- **Markets & Tokens**: every pool with 5M/1H/24H/7D/ALL price change, all tokens (price, change, supply, market cap, your balance), add/remove trust lines, portfolio value change.
- **DEX**: terminal for every AMM pair and order book. Candles with timeframes and moving averages, token card (market cap, volume, liquidity, holders, 5M/1H/24H/7D), Buy/Sell with Market and Limit, trades/pools/holders/order book/my orders.
- **Liquidity Pools**: create, deposit, withdraw on real pools.
- **Bridge**: settings from the operator's panel, send LUMA to XRPL or XRPL to LUMA with the bridge memo, vault balances on both ledgers, your transfers.
- **Network**: ledger, close time, throughput, supply, fees burned, recent ledgers and transactions, search.

## What is and is not real
Nothing is simulated: no generated ledgers, prices, pools or demo wallets. Percent changes come from historical ledger queries, so they are limited by how far back your node keeps history (the page says so). Candles are built from pool prices at points in time, not from every trade, so there are no trade-level wicks. Swaps go through direct pools or the book (no multi-hop routing yet). Tested against a local simulated node, not a live production network.

## Launch (like the control panel)
- macOS: double-click `Start Starsky.command`
- Linux / WSL: `./start-starsky.sh`
- Windows: double-click `Start Starsky.bat`
- Anywhere: `npm start`

It serves the built app at http://127.0.0.1:8095 and opens your browser. Pass another port as the first argument.

## Network, LUMA Supply, Trading Bot
- **Network**: full-width live explorer (ledger stats, tx table with filters, top accounts, result codes).
- **LUMA Supply**: supply, genesis share, LUMA in pools, holders, growth charts, every asset.
- **Trading Bot**: one bot, run by the active LUMA wallet while Starsky is open. Market maker or AMM swaps; real transactions.
- Reserves are read from the node (mainnet: 0.1 LUMA + 0.02 per object). Nothing is sent automatically to new wallets; activate them from the Wallets page.
- Launchers rebuild automatically when the source changed and replace an older Starsky still running on the port.

## Hosting (GitHub Pages)
Pushing to `main` builds and publishes the site (see `.github/workflows/pages.yml`). In the repo: Settings → Pages → Source: **GitHub Actions**; custom domain `starsky-luma.org` (the `public/CNAME` file sets it).
The LUMA node addresses visitors connect to are in the `STARSKY_CONFIG` block in `index.html`.
