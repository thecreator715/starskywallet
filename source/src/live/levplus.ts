// Leverage toolkit: 50 pure, tested risk and planning tools for the margin platform. Nothing here opens or closes a position.
// Constants mirror margin.ts (fees, funding, maintenance margin); levplus.test checks the liquidation maths against the same formula.
export const FEE_OPEN = 0.0005, FEE_CLOSE = 0.0005, FUND_H = 0.0001, MMR = 0.005;
export interface P { pe: number; lev: number; coll: number; long: boolean; n?: number }
const r6 = (x: number) => +x.toFixed(6), notional = (p: P) => p.n ?? p.coll * p.lev;
// 1. position size from the risk you accept: loss at the stop = riskAmt
export function sizeFromRisk(equity: number, riskPct: number, entry: number, stop: number, lev: number) { const dist = Math.abs(entry - stop) / entry; if (!(dist > 0) || !(riskPct > 0)) return { notional: 0, coll: 0, why: 'Needs a stop away from entry and a risk above 0.' }; const risk = equity * riskPct / 100, n = risk / (dist + FEE_OPEN + FEE_CLOSE); return { notional: r6(n), coll: r6(n / lev), risk: r6(risk), why: '' }; }
// 2/3. liquidation price and its distance
export const liq = (p: P) => p.long ? Math.max(0, p.pe * (1 - 1 / p.lev + FEE_OPEN + MMR)) : p.pe * (1 + 1 / p.lev - FEE_OPEN - MMR);
export const liqDistancePct = (p: P) => r6(Math.abs(p.pe - liq(p)) / p.pe * 100);
// 4. collateral needed so the liquidation sits at least d% away
export const collForLiqDistance = (n: number, d: number) => r6(n * (d / 100 + FEE_OPEN + MMR));
// 5. break-even price including both fees and funding over hours
export const breakEven = (p: P, hours: number) => { const c = FEE_OPEN + FEE_CLOSE + FUND_H * hours; return r6(p.long ? p.pe * (1 + c) : p.pe * (1 - c)); };
// 6. funding projection
export const fundingCost = (n: number, hours: number) => r6(n * FUND_H * hours);
export const fundingTable = (n: number) => ({ day: fundingCost(n, 24), week: fundingCost(n, 168), month: fundingCost(n, 720) });
// 7. highest leverage that keeps the liquidation at least d% away
export const maxSafeLev = (d: number) => Math.max(1, Math.floor(1 / (d / 100 + FEE_OPEN + MMR)));
// 8. reward to risk
export const rr = (entry: number, stop: number, target: number) => { const risk = Math.abs(entry - stop), rew = Math.abs(target - entry); return risk > 0 ? r6(rew / risk) : 0; };
// 9. trailing stop
export const trail = (long: boolean, best: number, pct: number, current: number | null = null) => { const s = long ? best * (1 - pct / 100) : best * (1 + pct / 100); return r6(current == null ? s : long ? Math.max(current, s) : Math.min(current, s)); };
// 10. scale-in ladder: n entries between two prices, equal size; returns the average entry
export function ladder(from: number, to: number, n: number, total: number) { const px = Array.from({ length: n }, (_, i) => r6(n === 1 ? from : from + (to - from) * i / (n - 1))); const each = r6(total / n); return { prices: px, each, avg: r6(px.reduce((a, c) => a + c, 0) / n) }; }
// 11. scale-out tiers
export const takeProfits = (entry: number, long: boolean, tiers: Array<{ pct: number; share: number }>) => tiers.map(t => ({ price: r6(long ? entry * (1 + t.pct / 100) : entry * (1 - t.pct / 100)), share: t.share }));
// 12. partial close
export function partialClose(p: P, mark: number, frac: number) { const n = notional(p) * frac, pnl = n * (p.long ? mark / p.pe - 1 : 1 - mark / p.pe); return { closedNotional: r6(n), realized: r6(pnl - n * FEE_CLOSE), keepNotional: r6(notional(p) - n), keepColl: r6(p.coll * (1 - frac)) }; }
// 13. add to a position: new average entry
export const addTo = (p: P, addN: number, px: number) => { const n0 = notional(p), n = n0 + addN; return { avg: r6((p.pe * n0 + px * addN) / n), notional: r6(n) }; };
// 14. pyramid: each add smaller than the last
export const pyramid = (first: number, n: number, shrink = 0.6) => Array.from({ length: n }, (_, i) => r6(first * Math.pow(shrink, i)));
// 15. hedge: size of the opposite position that cancels the price exposure
export const hedgeSize = (p: P, pct = 100) => r6(notional(p) * pct / 100);
// 16. net exposure across positions
export const netExposure = (ps: P[]) => { const l = ps.filter(p => p.long).reduce((a, p) => a + notional(p), 0), s = ps.filter(p => !p.long).reduce((a, p) => a + notional(p), 0); return { long: r6(l), short: r6(s), net: r6(l - s), gross: r6(l + s) }; };
// 17. portfolio heat: total loss if every stop is hit, as % of equity
export const heat = (ps: Array<P & { sl: number }>, equity: number) => { const loss = ps.reduce((a, p) => a + (p.sl > 0 ? notional(p) * Math.abs(p.pe - p.sl) / p.pe : p.coll), 0); return { loss: r6(loss), pct: equity > 0 ? r6(loss / equity * 100) : 100 }; };
// 18/19. daily loss limit and cooldown after a loss
export const dailyLimit = (startEquity: number, now: number, limitPct: number) => ({ stop: r6(startEquity * (1 - limitPct / 100)), hit: now <= startEquity * (1 - limitPct / 100) });
export const cooldown = (lastLossMs: number | null, now: number, mins: number) => lastLossMs == null ? { ok: true, left: 0 } : { ok: now - lastLossMs >= mins * 6e4, left: Math.max(0, Math.ceil((lastLossMs + mins * 6e4 - now) / 6e4)) };
// 20. stop at a multiple of volatility (ATR)
export const atrStop = (entry: number, long: boolean, atr: number, mult = 2) => r6(long ? entry - atr * mult : entry + atr * mult);
export function atr(h: number[], l: number[], c: number[], n = 14) { const tr: number[] = []; for (let i = 1; i < c.length; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); const s = tr.slice(-n); return s.length ? r6(s.reduce((a, b) => a + b, 0) / s.length) : 0; }
// 21. leverage that fits the volatility: expected daily move should stay below a quarter of the liquidation distance
export const volLev = (dailyVolPct: number, d = 4) => Math.max(1, Math.min(maxSafeLev(d * dailyVolPct), Math.floor(100 / (dailyVolPct * 4 || 1))));
// 22/23. Kelly (capped) and expected value
export const kelly = (winRate: number, rrr: number, cap = 0.25) => { const k = winRate - (1 - winRate) / rrr; return r6(Math.max(0, Math.min(cap, k))); };
export const expectedValue = (winRate: number, avgWin: number, avgLoss: number) => r6(winRate * avgWin - (1 - winRate) * avgLoss);
// 24. what-if: profit or loss at a price grid
export const whatIf = (p: P, prices: number[]) => prices.map(x => { const pnl = notional(p) * (p.long ? x / p.pe - 1 : 1 - x / p.pe) - notional(p) * FEE_OPEN; return { price: x, pnl: r6(pnl), equity: r6(p.coll + pnl), liquidated: p.long ? x <= liq(p) : x >= liq(p) }; });
// 25/26. buffer alert and margin status labels
export const bufferStatus = (distPct: number) => distPct <= 2 ? 'danger' : distPct <= 5 ? 'warning' : distPct <= 10 ? 'watch' : 'safe';
export const statusText = (s: string) => ({ danger: 'Very close to liquidation. Add collateral or reduce now.', warning: 'Getting close. Consider adding collateral.', watch: 'Keep an eye on it.', safe: 'Comfortable distance.' } as any)[s];
// 27/28. fixes: collateral to add, or notional to cut, to restore a buffer
export const topUp = (p: P, mark: number, targetDist: number) => { const n = notional(p), need = collForLiqDistance(n, targetDist); return r6(Math.max(0, need - p.coll)); };
export const cutTo = (p: P, targetDist: number) => { const n = p.coll / (targetDist / 100 + FEE_OPEN + MMR); return { notional: r6(Math.min(notional(p), n)), cut: r6(Math.max(0, notional(p) - n)) }; };
// 29. funding drag against profit
export const fundingWarn = (pnl: number, n: number, hours: number) => { const f = fundingCost(n, hours); return { cost: f, eatsProfit: pnl > 0 && f > pnl * 0.5, msg: pnl > 0 && f > pnl * 0.5 ? 'Funding has eaten more than half of your profit.' : '' }; };
// 30. rough time to liquidation at a typical hourly move (random-walk, sqrt of time)
export const hoursToLiq = (distPct: number, hourlyVolPct: number) => hourlyVolPct > 0 ? r6(Math.pow(distPct / hourlyVolPct, 2)) : Infinity;
// 31. stress test
export const stress = (p: P, shocks = [-10, -20, -30]) => shocks.map(s => { const x = p.pe * (1 + s / 100), w = whatIf(p, [x])[0]; return { shock: s, price: r6(x), equity: w.equity, liquidated: w.liquidated }; });
// 32. bracket validation
export function bracket(long: boolean, entry: number, sl: number, tp: number): string[] { const e: string[] = []; if (sl > 0 && (long ? sl >= entry : sl <= entry)) e.push('The stop must be ' + (long ? 'below' : 'above') + ' your entry.'); if (tp > 0 && (long ? tp <= entry : tp >= entry)) e.push('The take profit must be ' + (long ? 'above' : 'below') + ' your entry.'); return e; }
export const stopBeyondLiq = (p: P, sl: number) => sl > 0 && (p.long ? sl <= liq(p) : sl >= liq(p));
// 33. move the stop to break-even
export const breakEvenStop = (p: P, mark: number, trigPct: number) => (p.long ? mark >= p.pe * (1 + trigPct / 100) : mark <= p.pe * (1 - trigPct / 100)) ? breakEven(p, 0) : null;
// 34-40. trade statistics from closed trades [{pnl, risk}]
export interface Tr { pnl: number; risk?: number; lev?: number; fee?: number; tag?: string; hours?: number }
export const rMultiples = (t: Tr[]) => t.filter(x => x.risk).map(x => r6(x.pnl / x.risk!));
export function stats(t: Tr[]) { const w = t.filter(x => x.pnl > 0), l = t.filter(x => x.pnl < 0), gp = w.reduce((a, x) => a + x.pnl, 0), gl = Math.abs(l.reduce((a, x) => a + x.pnl, 0)); let run = 0, mx = 0; for (const x of t) { run = x.pnl < 0 ? run + 1 : 0; mx = Math.max(mx, run); } return { n: t.length, winRate: t.length ? r6(w.length / t.length) : 0, profitFactor: gl ? r6(gp / gl) : gp > 0 ? Infinity : 0, expectancy: t.length ? r6(t.reduce((a, x) => a + x.pnl, 0) / t.length) : 0, maxLossStreak: mx, avgWin: w.length ? r6(gp / w.length) : 0, avgLoss: l.length ? r6(gl / l.length) : 0, feeDrag: r6(t.reduce((a, x) => a + (x.fee || 0), 0)) }; }
export const byTag = (t: Tr[]) => { const m: Record<string, { n: number; pnl: number }> = {}; for (const x of t) { const k = x.tag || 'untagged'; (m[k] ||= { n: 0, pnl: 0 }).n++; m[k].pnl = r6(m[k].pnl + x.pnl); } return m; };
export const byLeverage = (t: Tr[]) => { const m: Record<string, { n: number; pnl: number }> = {}; for (const x of t) { const k = !x.lev ? '?' : x.lev <= 3 ? '1-3x' : x.lev <= 10 ? '4-10x' : '11x+'; (m[k] ||= { n: 0, pnl: 0 }).n++; m[k].pnl = r6(m[k].pnl + x.pnl); } return m; };
// 41. position age warning
export const ageWarn = (hours: number, n: number) => hours >= 72 ? `Open ${Math.floor(hours / 24)} days: funding so far about ${fundingCost(n, hours)}.` : '';
// 42/43. same-asset stacking and concentration
export const stacked = (ps: Array<{ key: string; long: boolean }>) => { const m: Record<string, number> = {}; for (const p of ps) m[p.key + (p.long ? ':L' : ':S')] = (m[p.key + (p.long ? ':L' : ':S')] || 0) + 1; return Object.entries(m).filter(([, c]) => c > 1).map(([k, c]) => `${k.split(':')[0]} ${k.endsWith('L') ? 'long' : 'short'} ×${c}`); };
export const concentrated = (ps: Array<{ key: string; n: number }>, equity: number, maxPct = 100) => { const m: Record<string, number> = {}; for (const p of ps) m[p.key] = (m[p.key] || 0) + p.n; return Object.entries(m).filter(([, n]) => n / equity * 100 > maxPct).map(([k, n]) => ({ key: k, pct: r6(n / equity * 100) })); };
// 44. pre-trade checklist
export function checklist(o: { p: P; sl: number; tp: number; equity: number; balance: number; poolTvl: number; minColl?: number }): Array<{ ok: boolean; text: string }> {
  const n = notional(o.p), d = liqDistancePct(o.p), c: Array<{ ok: boolean; text: string }> = [];
  c.push({ ok: o.p.coll <= o.balance, text: 'You have the collateral.' }); c.push({ ok: o.p.coll >= (o.minColl ?? 1), text: 'Collateral meets the minimum.' }); c.push({ ok: o.sl > 0, text: 'A stop loss is set.' }); c.push({ ok: !stopBeyondLiq(o.p, o.sl), text: 'The stop comes before the liquidation price.' }); c.push({ ok: bracket(o.p.long, o.p.pe, o.sl, o.tp).length === 0, text: 'Stop and target are on the correct sides.' }); c.push({ ok: d >= 5, text: `Liquidation is ${d}% away (5% or more is comfortable).` }); c.push({ ok: o.poolTvl <= 0 || n <= o.poolTvl * 0.03, text: 'Size is within 3% of the pool value.' }); c.push({ ok: o.equity <= 0 || o.p.coll / o.equity <= 0.25, text: 'No more than a quarter of your equity in one position.' }); return c;
}
// 45. what you get back at a price after the close fee
export const payout = (p: P, mark: number, hours = 0) => r6(Math.max(0, p.coll + notional(p) * (p.long ? mark / p.pe - 1 : 1 - mark / p.pe) - notional(p) * (FEE_OPEN + FEE_CLOSE) - fundingCost(notional(p), hours)));
// 46. slippage-adjusted entry
export const slipEntry = (px: number, long: boolean, slipPct: number) => r6(long ? px * (1 + slipPct / 100) : px * (1 - slipPct / 100));
// 47. size cap from pool value
export const capByPool = (poolTvl: number, pct = 0.03) => r6(poolTvl * pct);
// 48. worst case: isolated margin, the most you can lose is the collateral
export const worstCase = (p: P) => ({ loss: r6(p.coll), pctOfCollateral: 100 });
// 49. plain-words ticket summary
export const words = (p: P, sl: number, tp: number, name = 'the asset', native = 'LUMA') => `${p.long ? 'Long' : 'Short'} ${name} at ${p.lev}x with ${p.coll} ${native} (${r6(notional(p))} ${native} exposure). You are liquidated at ${r6(liq(p))}, ${liqDistancePct(p)}% from entry. ${sl > 0 ? 'Stop at ' + sl + '.' : 'No stop set.'} ${tp > 0 ? 'Target ' + tp + '.' : ''} The most you can lose is the ${p.coll} ${native} you put in.`.trim();
// 50. presets
export const presets = (dailyVolPct: number) => ({ safe: Math.max(1, Math.min(3, volLev(dailyVolPct))), normal: Math.max(2, Math.min(5, volLev(dailyVolPct, 6))), aggressive: Math.max(3, Math.min(10, volLev(dailyVolPct, 3))) });
