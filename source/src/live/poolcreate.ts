// AMM pool creation helper: advanced launch estimates (price, value, depth, impact table, fees, reserve) shared by the token creator and the Create pool dialog.
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { Asset, akey, esc, fmt, isNative, usd } from './util.ts';
import { info } from './chain.ts';

let SNAP: M.Snap | null = null, SNAPAT = 0, INF: any = null;
export async function loadPrices(): Promise<void> {
  if (Date.now() - SNAPAT < 30000) return;
  SNAPAT = Date.now();
  SNAP = await M.snapshot().catch(() => null);
  INF = await info().catch(() => null);
}
export const usdOf = (a: Asset): number | null => {
  if (!SNAP) return null;
  if (isNative(a)) return SNAP.usdPerNative ?? null;
  const p = M.usdPx(SNAP, akey(a));
  return p != null && SNAP.usdPerNative != null ? p * SNAP.usdPerNative : p ?? null;
};
export interface Est { tName: string; pName: string; T: number; P: number; fee: number; pUsd: number | null; supply?: number; tUsd?: number | null; balP?: number; native?: boolean; }
const row = (k: string, v: string, cls = '') => `<div class="dxkv"><span class="mut">${k}</span><b class="${cls}">${v}</b></div>`;
/** constant-product math: spend dP of the pair asset, get tokens */
const buy = (T: number, P: number, f: number, dP: number) => { const eff = dP * (1 - f / 100), out = T - (T * P) / (P + eff); return { out, avg: out > 0 ? dP / out : 0, impact: 1 - out / dP / (T / P), newPx: (P + dP) / (T - out) }; };
export function estimate(e: Est): string {
  const { T, P, fee } = e;
  if (!(T > 0) || !(P > 0)) return '<div class="mut" style="padding:.6rem">Enter both amounts to see the pool estimates.</div>';
  const px = P / T, pu = e.pUsd, tokUsd = pu != null ? px * pu : null, tvl = pu != null ? 2 * P * pu : null, lp = Math.sqrt(T * P);
  const warns: string[] = [];
  if (fee < 0 || fee > 1) warns.push('The trading fee must be between 0% and 1%.');
  if (tvl != null && tvl < 1000) warns.push('Very thin pool: small trades will move the price a lot. More liquidity means steadier prices.');
  if (e.supply && T > e.supply) warns.push('The pool needs more tokens than the total supply.');
  if (e.balP != null && P > e.balP) warns.push(`You need ${fmt(P)} ${e.pName} but hold ${fmt(e.balP)}.`);
  const reserve = INF ? INF.reserveInc : null;
  const sizes = [0.005, 0.01, 0.05, 0.1].map(s => ({ dP: P * s, ...buy(T, P, fee, P * s) }));
  const depth = (u: number) => (P * (Math.sqrt(1 + u) - 1)) / (1 - fee / 100);
  return `<div class="pcgrid"><div class="lpcard"><div class="k">Launch</div>
    ${row('Starting price', `${fmt(px, 8)} ${esc(e.pName)} per ${esc(e.tName)}${tokUsd != null ? ` <small class="mut">≈ ${usd(tokUsd)}</small>` : ''}`)}
    ${row('Reverse price', `${fmt(1 / px, 8)} ${esc(e.tName)} per ${esc(e.pName)}`)}
    ${e.supply ? row('Fully diluted value', tokUsd != null ? usd(tokUsd * e.supply) : fmt(px * e.supply) + ' ' + esc(e.pName)) : ''}
    ${e.supply ? row('Supply in the pool', ((T / e.supply) * 100).toFixed(2) + '%', '') : ''}
    ${row('Pool value (both sides)', tvl != null ? usd(tvl) : fmt(2 * P) + ' ' + esc(e.pName))}
    ${row('Pool tokens you receive', fmt(lp, 6), 'up')}${row('Your share of the pool', '100%', 'up')}
    ${row('Trading fee', fee + '%')}${row('Fees per $1,000 traded', pu != null ? usd((1000 * fee) / 100) : '–')}
    ${row('Pool creation cost', reserve != null ? `about ${fmt(reserve)} ${esc(ctx.native())} (network fee for a new pool)` : '–')}
    ${row('You deposit', `${fmt(T)} ${esc(e.tName)} + ${fmt(P)} ${esc(e.pName)}`)}</div>
    <div class="lpcard"><div class="k">Depth and price impact</div>
    <table class="dxt"><thead><tr><th>Buy with</th><th class="r">You get</th><th class="r">Avg price</th><th class="r">Impact</th></tr></thead><tbody>${sizes.map(z => `<tr><td>${fmt(z.dP, 4)} ${esc(e.pName)}${pu != null ? `<br><small class="mut">≈ ${usd(z.dP * pu)}</small>` : ''}</td><td class="r">${fmt(z.out, 4)}</td><td class="r">${fmt(z.avg, 6)}</td><td class="r ${z.impact > 0.05 ? 'dn' : ''}">${(z.impact * 100).toFixed(2)}%</td></tr>`).join('')}</tbody></table>
    ${row('To push the price up 2%', `${fmt(depth(0.02), 4)} ${esc(e.pName)}${pu != null ? ` <small class="mut">≈ ${usd(depth(0.02) * pu)}</small>` : ''}`)}
    ${row('To push the price up 10%', `${fmt(depth(0.1), 4)} ${esc(e.pName)}${pu != null ? ` <small class="mut">≈ ${usd(depth(0.1) * pu)}</small>` : ''}`)}
    <div class="mut" style="font-size:.74rem;margin-top:.4rem">Constant-product pool (x · y = k). The first deposit sets the price: the ratio you enter is the starting price, so enter amounts you are happy trading at.</div></div></div>
    ${warns.map(w => `<div class="pm-warn">⚠ ${esc(w)}</div>`).join('')}`;
}
