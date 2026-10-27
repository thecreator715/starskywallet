// Header strip: LUMA price, 24h change, 24h volume and the connected wallet's balance.
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { akey, fmt, isNative, usd } from './util.ts';
import { tryReq } from './chain.ts';

let html = '';
let timer: any = null;
let busy = false;
const put = () => {
  const e = document.getElementById('tstat') as any;
  if (e && e.__h !== html) {
    e.innerHTML = html;
    e.__h = html;
  }
};
export const topStatsHtml = () => html;
async function calc() {
  if (busy || !ctx.online()) return;
  busy = true;
  try {
    const n = ctx.native();
    const [sn, ws] = await Promise.all([M.snapshot(), M.windowSnaps()]);
    const px = sn.usdPerNative;
    const w24 = ws.find(w => w.w.k === '24h');
    const then = w24 ? w24.snap.usdPerNative : null;
    const chg = px != null && then ? (px / then - 1) * 100 : null;
    // 24h volume of the biggest pools (quote side, in dollars when a dollar token exists)
    let vol = 0;
    const top = sn.pools.slice().sort((a, b) => b.ra * (sn.px.get(akey(a.a)) ?? 0) - a.ra * (sn.px.get(akey(b.a)) ?? 0)).slice(0, 8);
    for (const p of top) {
      const m = M.marketsFrom([p])[0];
      const tr = (await M.trades(m, 150).catch(() => [])) as M.Trade[];
      const qpx = isNative(m.quote) ? 1 : sn.px.get(akey(m.quote)) ?? 0;
      for (const x of tr) if ((x.kind === 'buy' || x.kind === 'sell') && Date.now() - x.ms < 86400e3) vol += x.quote * qpx;
    }
    const acc = ctx.account();
    let bal: number | null = null;
    if (acc) {
      const r: any = await tryReq('account_info', { account: acc, ledger_index: 'validated' }, 8000);
      bal = r && r.account_data ? Number(r.account_data.Balance) / 1e6 : 0;
    }
    const cls = chg == null ? 'mut' : chg >= 0 ? 'up' : 'dn';
    const money = (v: number) => (px != null ? usd(v * px) : fmt(v) + ' ' + n);
    html = [
      `<span class="ts"><small>${n}</small><b>${px != null ? usd(px) : '–'}</b></span>`,
      `<span class="ts"><small>24H</small><b class="${cls}">${chg == null ? '–' : (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%'}</b></span>`,
      `<span class="ts"><small>VOL 24H</small><b>${vol > 0 ? money(vol) : '–'}</b></span>`,
      `<span class="ts"><small>YOUR BALANCE</small><b>${bal != null ? fmt(bal, 2) + ' ' + n : '–'}</b></span>`,
    ].join('');
    put();
  } catch {}
  busy = false;
}
export function startTopStats() {
  put();
  if (timer) return;
  calc();
  timer = setInterval(calc, 30000);
}
export const refreshTopStats = () => {
  put();
  calc();
};
