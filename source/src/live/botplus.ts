// Trading bot toolkit: 50 pure, tested strategy, safety and reporting tools. Nothing here places an order;
// the bot page uses these to plan, simulate (paper mode and backtest) and to decide when a running bot must stop.
const r6 = (x: number) => +x.toFixed(6);
// ---- indicators (1-8) ----
export const sma = (v: number[], n: number) => v.length < n ? null : r6(v.slice(-n).reduce((a, b) => a + b, 0) / n);
export const ema = (v: number[], n: number) => { if (v.length < n) return null; const k = 2 / (n + 1); let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n; for (let i = n; i < v.length; i++) e = v[i] * k + e * (1 - k); return r6(e); };
export const rsi = (v: number[], n = 14) => { if (v.length <= n) return null; let g = 0, l = 0; for (let i = v.length - n; i < v.length; i++) { const d = v[i] - v[i - 1]; d >= 0 ? g += d : l -= d; } return l === 0 ? 100 : r6(100 - 100 / (1 + g / l)); };
export const bollinger = (v: number[], n = 20, k = 2) => { const m = sma(v, n); if (m == null) return null; const s = v.slice(-n), sd = Math.sqrt(s.reduce((a, x) => a + (x - m) ** 2, 0) / n); return { mid: m, up: r6(m + k * sd), low: r6(m - k * sd), sd: r6(sd) }; };
export const donchian = (h: number[], l: number[], n = 20) => h.length < n ? null : { high: Math.max(...h.slice(-n)), low: Math.min(...l.slice(-n)) };
export const macd = (v: number[]) => { const a = ema(v, 12), b = ema(v, 26); return a == null || b == null ? null : r6(a - b); };
export const zscore = (v: number[], n = 20) => { const b = bollinger(v, n); return b && b.sd > 0 ? r6((v[v.length - 1] - b.mid) / b.sd) : null; };
export const volatility = (v: number[], n = 20) => { const r = v.slice(-n - 1).map((x, i, a) => i ? Math.log(x / a[i - 1]) : 0).slice(1); if (r.length < 2) return null; const m = r.reduce((a, b) => a + b, 0) / r.length; return r6(Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1)) * 100); };
// ---- grid (9-14) ----
export function gridLevels(low: number, high: number, n: number, mode: 'arith' | 'geo' = 'arith') { if (!(high > low) || n < 2) return []; return Array.from({ length: n }, (_, i) => r6(mode === 'arith' ? low + (high - low) * i / (n - 1) : low * Math.pow(high / low, i / (n - 1)))); }
export const gridSpacingPct = (lv: number[]) => lv.length < 2 ? 0 : r6((lv[1] / lv[0] - 1) * 100);
/** a grid only makes money if a step beats the round-trip fee: refuse tiny steps */
export const gridWorthIt = (lv: number[], feePct: number) => { const s = gridSpacingPct(lv); return { ok: s > feePct * 2 * 1.5, step: s, min: r6(feePct * 3) }; };
export const gridProfitPerCycle = (lv: number[], perOrder: number, feePct: number) => r6(perOrder * (gridSpacingPct(lv) / 100 - 2 * feePct / 100));
export const gridPlan = (lv: number[], price: number) => ({ buys: lv.filter(x => x < price), sells: lv.filter(x => x > price) });
export const outOfRange = (price: number, lv: number[]) => !lv.length ? false : price < lv[0] || price > lv[lv.length - 1];
export const recenter = (lv: number[], price: number) => { if (lv.length < 2) return lv; const w = lv[lv.length - 1] - lv[0]; return gridLevels(r6(price - w / 2), r6(price + w / 2), lv.length); };
export const inventorySkew = (baseVal: number, quoteVal: number) => { const t = baseVal + quoteVal; return t ? r6(baseVal / t) : 0.5; };
// ---- DCA, TWAP, rebalance (15-20) ----
export const dcaSchedule = (total: number, buys: number, startMs: number, everyMs: number) => Array.from({ length: buys }, (_, i) => ({ at: startMs + i * everyMs, amount: r6(total / buys) }));
export const dcaAverage = (fills: Array<{ amount: number; price: number }>) => { const spent = fills.reduce((a, f) => a + f.amount, 0), got = fills.reduce((a, f) => a + f.amount / f.price, 0); return got ? { spent: r6(spent), got: r6(got), avg: r6(spent / got) } : { spent: 0, got: 0, avg: 0 }; };
export const smartDca = (base: number, price: number, avg: number, boostPct = 50) => avg > 0 && price < avg * 0.9 ? r6(base * (1 + boostPct / 100)) : avg > 0 && price > avg * 1.2 ? r6(base * 0.5) : base;
export const twap = (total: number, slices: number, jitterPct = 0, seed = 1) => { let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647; const w = Array.from({ length: slices }, () => 1 + (rnd() - 0.5) * 2 * jitterPct / 100), sw = w.reduce((a, b) => a + b, 0); return w.map(x => r6(total * x / sw)); };
export function rebalance(hold: Record<string, number>, target: Record<string, number>, bandPct = 5) { const tot = Object.values(hold).reduce((a, b) => a + b, 0), tw = Object.values(target).reduce((a, b) => a + b, 0); if (!tot || !tw) return []; return Object.keys(target).map(k => { const want = tot * target[k] / tw, have = hold[k] || 0, diff = want - have; return { asset: k, side: diff > 0 ? 'buy' : 'sell', value: r6(Math.abs(diff)), driftPct: r6(Math.abs(diff) / tot * 100) }; }).filter(x => x.driftPct >= bandPct).sort((a, b) => b.value - a.value); }
export const profitLock = (equity: number, startEquity: number, lockPct: number) => equity > startEquity * (1 + lockPct / 100) ? r6(equity - startEquity * (1 + lockPct / 100)) : 0;
// ---- signals (21-26) ----
export const smaCross = (v: number[], f = 10, s = 30): 'buy' | 'sell' | 'hold' => { const a = sma(v, f), b = sma(v, s), a0 = sma(v.slice(0, -1), f), b0 = sma(v.slice(0, -1), s); if ([a, b, a0, b0].some(x => x == null)) return 'hold'; return a0! <= b0! && a! > b! ? 'buy' : a0! >= b0! && a! < b! ? 'sell' : 'hold'; };
export const rsiSignal = (v: number[], lo = 30, hi = 70) => { const r = rsi(v); return r == null ? 'hold' : r < lo ? 'buy' : r > hi ? 'sell' : 'hold'; };
export const bandSignal = (v: number[]) => { const b = bollinger(v), p = v[v.length - 1]; return !b ? 'hold' : p < b.low ? 'buy' : p > b.up ? 'sell' : 'hold'; };
export const breakoutSignal = (h: number[], l: number[], p: number, n = 20) => { const d = donchian(h.slice(0, -1), l.slice(0, -1), n); return !d ? 'hold' : p > d.high ? 'buy' : p < d.low ? 'sell' : 'hold'; };
export const pairSignal = (spread: number[], z = 2) => { const x = zscore(spread); return x == null ? 'hold' : x > z ? 'sell-a-buy-b' : x < -z ? 'buy-a-sell-b' : 'hold'; };
export const bestMomentum = (series: Record<string, number[]>, n = 20) => Object.entries(series).map(([k, v]) => ({ asset: k, ret: v.length > n ? r6(v[v.length - 1] / v[v.length - 1 - n] - 1) : null })).filter(x => x.ret != null).sort((a, b) => b.ret! - a.ret!);
// ---- filters (27-32) ----
export const spreadOk = (bid: number, ask: number, maxPct: number) => bid > 0 && ask >= bid && (ask - bid) / ((ask + bid) / 2) * 100 <= maxPct;
export const volumeOk = (vol: number, min: number) => vol >= min;
export const inWindow = (hourUtc: number, startH: number, endH: number) => startH <= endH ? hourUtc >= startH && hourUtc < endH : hourUtc >= startH || hourUtc < endH;
export const cooldownOk = (lastMs: number | null, now: number, secs: number) => lastMs == null || now - lastMs >= secs * 1000;
export const staleQuote = (quoteMs: number, now: number, maxSecs = 30) => now - quoteMs > maxSecs * 1000;
export const minOrderOk = (valueN: number, minN: number, feeN: number) => valueN >= minN && feeN < valueN * 0.01;
// ---- risk and kill switch (33-40) ----
export interface Run { startEquity: number; equity: number; peak: number; fails: number; orders: number; lossToday: number; price: number | null; levels?: number[]; lastQuoteMs?: number }
export interface Limits { maxLossPct?: number; maxDrawdownPct?: number; maxFails?: number; maxOrders?: number; dailyLossPct?: number; stopIfOutOfRange?: boolean; maxQuoteAgeSecs?: number }
/** reasons the bot must stop now; empty means it may continue */
export function killReasons(r: Run, l: Limits, now = Date.now()): string[] {
  const w: string[] = [], pct = (a: number, b: number) => b > 0 ? (1 - a / b) * 100 : 0;
  if (l.maxLossPct != null && pct(r.equity, r.startEquity) >= l.maxLossPct) w.push(`Total loss reached ${l.maxLossPct}%.`);
  if (l.maxDrawdownPct != null && pct(r.equity, r.peak) >= l.maxDrawdownPct) w.push(`Fell ${l.maxDrawdownPct}% from its peak.`);
  if (l.maxFails != null && r.fails >= l.maxFails) w.push(`${r.fails} failed orders in a row.`);
  if (l.maxOrders != null && r.orders >= l.maxOrders) w.push(`Reached the limit of ${l.maxOrders} orders.`);
  if (l.dailyLossPct != null && r.startEquity > 0 && r.lossToday / r.startEquity * 100 >= l.dailyLossPct) w.push(`Daily loss limit of ${l.dailyLossPct}% reached.`);
  if (l.stopIfOutOfRange && r.price != null && r.levels && outOfRange(r.price, r.levels)) w.push('Price left the grid range.');
  if (l.maxQuoteAgeSecs != null && r.lastQuoteMs != null && staleQuote(r.lastQuoteMs, now, l.maxQuoteAgeSecs)) w.push('Prices are stale: the market data stopped updating.');
  return w;
}
export const drawdown = (curve: number[]) => { let pk = -Infinity, mx = 0; for (const e of curve) { pk = Math.max(pk, e); mx = Math.max(mx, pk > 0 ? (pk - e) / pk * 100 : 0); } return r6(mx); };
export const sharpe = (curve: number[]) => { const r = curve.slice(1).map((e, i) => e / curve[i] - 1); if (r.length < 2) return 0; const m = r.reduce((a, b) => a + b, 0) / r.length, sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1)); return sd ? r6(m / sd * Math.sqrt(r.length)) : 0; };
export const takeProfitStop = (entry: number, price: number, tpPct: number, slPct: number) => price >= entry * (1 + tpPct / 100) ? 'take-profit' : price <= entry * (1 - slPct / 100) ? 'stop-loss' : 'hold';
export const positionCap = (equity: number, price: number, maxPct: number) => r6(equity * maxPct / 100 / price);
export const failBackoff = (fails: number, baseSecs = 5, maxSecs = 300) => Math.min(maxSecs, baseSecs * Math.pow(2, Math.max(0, fails - 1)));
// ---- backtest and paper trading (41-46) ----
export type Sig = (closes: number[]) => 'buy' | 'sell' | 'hold';
/** simple long-only backtest: all-in on buy, all-out on sell, fee per trade in percent */
export function backtest(closes: number[], sig: Sig, start = 1000, feePct = 0.1, warm = 30) {
  let cash = start, qty = 0, trades = 0; const curve: number[] = [];
  for (let i = 0; i < closes.length; i++) { const p = closes[i], s = i >= warm ? sig(closes.slice(0, i + 1)) : 'hold'; if (s === 'buy' && cash > 0) { qty = cash * (1 - feePct / 100) / p; cash = 0; trades++; } else if (s === 'sell' && qty > 0) { cash = qty * p * (1 - feePct / 100); qty = 0; trades++; } curve.push(r6(cash + qty * p)); }
  const end = curve[curve.length - 1] ?? start, hold = closes.length ? start * closes[closes.length - 1] / closes[0] : start;
  return { end: r6(end), returnPct: r6((end / start - 1) * 100), buyHoldPct: r6((hold / start - 1) * 100), trades, maxDrawdownPct: drawdown(curve), sharpe: sharpe(curve), beatsHold: end > hold, curve };
}
export class Paper { cash: number; qty = 0; log: Array<{ side: string; price: number; qty: number }> = []; constructor(cash: number, public feePct = 0.1) { this.cash = cash; }
  buy(price: number, value: number) { value = Math.min(value, this.cash); if (value <= 0) return false; const q = value * (1 - this.feePct / 100) / price; this.cash -= value; this.qty += q; this.log.push({ side: 'buy', price, qty: r6(q) }); return true; }
  sell(price: number, q: number) { q = Math.min(q, this.qty); if (q <= 0) return false; this.cash += q * price * (1 - this.feePct / 100); this.qty -= q; this.log.push({ side: 'sell', price, qty: r6(q) }); return true; }
  value(price: number) { return r6(this.cash + this.qty * price); } }
export const compareRuns = (a: { returnPct: number; maxDrawdownPct: number }, b: { returnPct: number; maxDrawdownPct: number }) => ({ better: a.returnPct / (a.maxDrawdownPct || 1) >= b.returnPct / (b.maxDrawdownPct || 1) ? 'A' : 'B', dReturn: r6(a.returnPct - b.returnPct), dDrawdown: r6(a.maxDrawdownPct - b.maxDrawdownPct) });
export const overfitWarn = (trainPct: number, testPct: number) => trainPct > 0 && testPct < trainPct * 0.4 ? 'It did much worse on data it had not seen. It may be fitted to the past.' : '';
export function walkForward(closes: number[], sig: Sig, split = 0.7) { const k = Math.floor(closes.length * split), a = backtest(closes.slice(0, k), sig), b = backtest(closes.slice(k), sig, 1000, 0.1, 0); return { train: a.returnPct, test: b.returnPct, warn: overfitWarn(a.returnPct, b.returnPct) }; }
// ---- reporting and setup help (47-50) ----
export const botReport = (r: { start: number; equity: number; orders: number; fails: number; hours: number }) => ({ pnl: r6(r.equity - r.start), pct: r.start ? r6((r.equity / r.start - 1) * 100) : 0, perDay: r.hours ? r6((r.equity - r.start) / (r.hours / 24)) : 0, failRate: r.orders ? r6(r.fails / r.orders * 100) : 0 });
export function setupCheck(c: { amount: number; balance: number; levels?: number; low?: number; high?: number; feePct: number; price: number; hasStop: boolean }) { const p: string[] = [], w: string[] = []; if (!(c.amount > 0)) p.push('Set an amount above 0.'); if (c.amount > c.balance) p.push('You do not have that much.'); if (c.low != null && c.high != null) { if (!(c.high > c.low)) p.push('The top of the range must be above the bottom.'); else if (c.price < c.low || c.price > c.high) w.push('The price is already outside your range.'); else { const lv = gridLevels(c.low, c.high, c.levels || 10); if (!gridWorthIt(lv, c.feePct).ok) w.push(`Steps of ${gridSpacingPct(lv)}% are too small to beat the fees. Use fewer levels or a wider range.`); } } if (!c.hasStop) w.push('No stop condition is set. Add a maximum loss.'); if (c.amount > c.balance * 0.5) w.push('More than half your balance in one bot.'); return { ok: !p.length, problems: p, warnings: w }; }
export const botWords = (kind: string, o: any) => kind === 'grid' ? `Buys on dips and sells on rises between ${o.low} and ${o.high}, ${o.levels} levels, ${o.amount} total. It earns when price moves back and forth, and loses if price leaves the range and stays away.` : kind === 'dca' ? `Buys ${o.amount} in ${o.buys} equal parts, one every ${o.every}. It does not try to time the market.` : kind === 'rebalance' ? `Keeps your mix near the target and trades only when something drifts ${o.band}% or more.` : 'Follows its rules and stops at your limits.';
export const kinds = () => [{ id: 'grid', name: 'Grid', for: 'Sideways markets' }, { id: 'dca', name: 'Dollar-cost average', for: 'Building a position over time' }, { id: 'rebalance', name: 'Rebalancer', for: 'Holding a target mix' }, { id: 'sma', name: 'Trend follower', for: 'Strong trends' }, { id: 'band', name: 'Mean reversion', for: 'Range-bound markets' }, { id: 'breakout', name: 'Breakout', for: 'Volatility expansions' }];
