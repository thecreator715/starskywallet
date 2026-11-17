# Starsky round 6

All of this is in the wallet now (index.html rebuilt). Everything is tested; the limits are stated per section.

## Convert all to LUMA (Portfolio page)
Card under your tokens. Live quotes from the pools and order books, a total, per-token checkboxes, a price-impact limit (default 1%), optional removal of emptied token lines, one confirmation, then one swap per token in order. A failed swap is explained and the rest continue. Large totals need typing CONVERT. Pool shares and tokens with no route are greyed out with the reason. NFTs are never converted.

## NFT toolkit — 50 ideas (src/live/nftplus.ts, 30 tests)
Rarity rank, trait counts and filters, sweep the floor, floor/price series/change, similar items, saved searches, compare, leaderboard, suggested price, expiry, bundles, Dutch and English auctions, offers inbox with counters, collection offers, auto-lower with a hard minimum, batch CSV listing, proceeds breakdown, royalty rules and earnings, mint phases and countdown, lazy-mint plan, seeded reveal, trait generator, per-wallet mint caps, verification, airdrop dry run, portfolio value and cost basis, spam score, tags, wishlist alerts, transfer safety check, bulk-burn guard, metadata health, provenance, impersonation check, image fingerprint (average hash), flagged collections, plain-words transaction preview, wash-trading flags, share text, embed snippet, activity feed, NFT-gated perks, bridge status labels.
On screen: the **NFT tools** card on the NFTs and Marketplace pages (sale proceeds, suggested price, auto-lower, Dutch price, loan limit, batch check).
Honest limits: floor history, rarity over a whole collection and image fingerprints need the indexer, which does not cover NFTs yet, so they work only from NFTs and sales the wallet has seen. Auctions, auto-lower rules and scheduled listings cannot run while the wallet is closed; they need on-chain offers or the wallet open. Most of the engine is not yet wired into every NFT page; the NFT tools card is the first screen for it.

## NFT-backed loans (src/live/nftloan.ts, 7 tests)
Rules engine: loan to value (limit 50%), valuation = the lowest of floor, last sale and your estimate, simple interest, repayment amount, states (offered, funded, overdue, claimable), what each side can do, cushion and risk, plain-words terms. **Not live:** locking the NFT in a per-loan escrow wallet is not built, so nothing can be borrowed yet. The planner shows this.

## NFT bridge
Logic passes 62/62 end to end (both directions, burn mode, refusals). The header now says it is 3 steps (pick, confirm, accept the copy); the wizard is the main path and the tables are for advanced use.

## Leverage planner — 50 tools (src/live/levplus.ts, 20 tests)
Position size from risk, liquidation price and distance, collateral for a target distance, break-even with fees and funding, funding table, safe leverage, reward to risk, trailing stop, scale-in ladder, take-profit tiers, partial close, adding to a position, pyramid, hedge size, net exposure, portfolio heat, daily loss limit, cooldown, ATR stop, volatility leverage, Kelly (capped), expected value, what-if table, stress test, buffer status, top-up and cut-down fixes, funding warning, time to liquidation, bracket validation, stop-beyond-liquidation, break-even stop, trade statistics (win rate, profit factor, streaks, by tag and leverage, fee drag), age warning, stacking and concentration, pre-trade checklist, payout, slippage entry, pool-size cap, worst case, plain-words summary, presets.
On screen: the **Leverage planner** card on the Margin page. It plans only; it does not open or change positions.

## Trading bot toolkit — 50 tools (src/live/botplus.ts, 16 tests)
SMA, EMA, RSI, Bollinger, Donchian, MACD, z-score, volatility; grid levels (even or percent), spacing, fee check, profit per cycle, range check, re-center, inventory skew; DCA schedule, average cost, smart DCA; TWAP with jitter; rebalancer with a drift band; profit lock; trend, RSI, band, breakout and pair signals; best momentum; spread, volume, trading-hours, cooldown, stale-price and minimum-order filters; kill switch (max loss, drawdown, failed orders, order count, daily loss, price out of range, stale prices); drawdown, Sharpe, take-profit/stop, position cap, failure backoff; backtest, paper trading, run comparison, overfit warning, walk-forward; report, setup check, plain-words descriptions, strategy list.
On screen: the **Bot planner** card on the Trading Bot page (grid plan check and a backtest of a trend rule on prices you paste). The running bot itself is not yet changed to use the kill switch; that wiring is the next step.

## Tests
Unit: convert 8, nftplus 30, nftloan 7, levplus 20, botplus 16 (plus the earlier 17 and 29). Browser: tools-ui 8, more-ui 10, safety-ui 17.
