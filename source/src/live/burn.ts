// USD backing and LUMA burn statistics, read straight from the ledger (burn account, USD issuer, total supply).
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { esc, fmt, usd } from './util.ts';
import { req, tryReq } from './chain.ts';

const BURN_R = 'rrrrrrrrrrrrrrrrrrrrBZbvji';
const RE = 946684800e3;
let busy = false;
let busyAt = 0;
let burnedBal = 0;
let last = '';

export function shell() {
  return `<div class="card c12"><div class="row" style="align-items:center;gap:.6rem"><div class="k">USD backing and ${esc(ctx.native())} burn</div><span class="grow"></span><button class="sm" onclick="window.bn.load()">Refresh</button></div><div id="bn" style="margin-top:.5rem">${last || '<div class="mut">Reading the burn account…</div>'}</div></div>`;
}
async function pull(account: string, pages: number) {
  const out: any[] = [];
  let marker: any;
  for (let i = 0; i < pages; i++) {
    const r: any = await tryReq('account_tx', { account, ledger_index_min: -1, ledger_index_max: -1, limit: 200, ...(marker ? { marker } : {}) });
    if (!r) break;
    for (const t of r.transactions || []) {
      const tx = t.tx || t.tx_json || {};
      if (tx.hash === undefined && t.hash) tx.hash = t.hash;
      out.push(tx);
    }
    marker = r.marker;
    if (!marker) break;
  }
  return out;
}
export async function load() {
  const el = document.getElementById('bn');
  if (!el || !ctx.online()) return;
  if (busy && Date.now() - busyAt < 25000) return;
  busy = true;
  busyAt = Date.now();
  el.style.opacity = '.55';
  try {
    const [sn] = await Promise.all([M.snapshot().catch(() => null), M.poolRefs().catch(() => [])]);
    const issuer = M.MAIN_USD;
    const lumaUsd = sn && sn.usdPerNative != null ? sn.usdPerNative : null;
    let outstanding = 0;
    if (issuer) {
      const g: any = await tryReq('gateway_balances', { account: issuer, ledger_index: 'validated' });
      const ob = (g && g.obligations) || {};
      const k = Object.keys(ob).find(x => x === 'USD' || M.labelOf({ c: x, i: issuer }) === 'USD');
      outstanding = k ? Number(ob[k]) : 0;
    }
    const bi: any = await tryReq('account_info', { account: BURN_R, ledger_index: 'current' });
    const burned = bi && bi.account_data ? Number(bi.account_data.Balance) / 1e6 : 0;
    burnedBal = burned;
    const lg: any = await tryReq('ledger', { ledger_index: 'validated' });
    const supply = lg && lg.ledger ? Number(lg.ledger.total_coins) / 1e6 : null;
    const burns = (await pull(BURN_R, 8))
      .filter(t => t.TransactionType === 'Payment' && (t.Destination === BURN_R || t.Destination === ctx.show(BURN_R)) && typeof t.Amount === 'string')
      .map(t => ({ hash: t.hash || '', at: t.date != null ? t.date * 1000 + RE : 0, from: t.Account, luma: Number(t.Amount) / 1e6 }))
      .sort((a, b) => b.at - a.at);
    const flows = issuer
      ? (await pull(issuer, 8))
          .filter(t => t.TransactionType === 'Payment' && t.Amount && typeof t.Amount === 'object' && M.labelOf({ c: t.Amount.currency, i: issuer }) === 'USD')
          .map(t => ({ at: t.date != null ? t.date * 1000 + RE : 0, kind: t.Account === issuer ? 'minted' : 'retired', usd: Number(t.Amount.value) }))
      : [];
    const now = Date.now();
    const win = (ms: number) => burns.filter(b => b.at && now - b.at <= ms).reduce((s, b) => s + b.luma, 0);
    const total = Math.max(burned, burns.reduce((s, b) => s + b.luma, 0)); // the account balance is the true burned total
    const needed = lumaUsd ? outstanding / lumaUsd : null; // LUMA that equals the outstanding USD at today's market price
    const days: Record<string, { b: number; m: number; r: number; n: number }> = {};
    const dk = (t: number) => new Date(t).toISOString().slice(0, 10);
    for (const b of burns) if (b.at) ((days[dk(b.at)] = days[dk(b.at)] || { b: 0, m: 0, r: 0, n: 0 }).b += b.luma), days[dk(b.at)].n++;
    for (const f of flows) if (f.at) (days[dk(f.at)] = days[dk(f.at)] || { b: 0, m: 0, r: 0, n: 0 })[f.kind === 'minted' ? 'm' : 'r'] += f.usd;
    const series = Object.keys(days).sort().slice(-30);
    const mx = Math.max(1, ...series.map(k => days[k].b));
    const bars = series
      .map((k, i) => {
        const h = Math.round((days[k].b / mx) * 60);
        return `<g><title>${k}: ${fmt(days[k].b, 0)} burned (${days[k].n} tx), USD minted ${fmt(days[k].m, 0)}, retired ${fmt(days[k].r, 0)}</title><rect x="${i * 20 + 2}" y="${66 - h}" width="16" height="${h}" fill="#00ff8c" opacity=".85"/><text x="${i * 20 + 10}" y="78" font-size="6" text-anchor="middle" fill="#889">${k.slice(5)}</text></g>`;
      })
      .join('');
    const t = (k: string, v: string, s = "") => `<div class="tile kvt" style="flex:1;min-width:10rem"><div class="k">${k}</div><div class="big2">${v}</div><div class="mut" style="font-size:.72rem">${s}</div></div>`;
    const mint = flows.filter(f => f.kind === 'minted').reduce((s, f) => s + f.usd, 0);
    const ret = flows.filter(f => f.kind === 'retired').reduce((s, f) => s + f.usd, 0);
    last = `<div class="row" style="gap:.6rem;flex-wrap:wrap">
      ${t('Outstanding USD', outstanding > 0.000001 ? usd(outstanding) : 'Nothing outstanding', issuer ? 'main USD issuer ' + esc(ctx.show(issuer).slice(0, 10)) + '…' : 'no USD pool found')}
      ${t('Total burned', fmt(total, 2) + ' ' + esc(ctx.native()), burns.length + ' burn transactions · account holds ' + fmt(burned, 2))}
      ${t('Share of supply', supply ? fmt((total / supply) * 100, 4) + '%' : '–', supply ? 'of ' + fmt(supply, 0) : '')}
      ${t('Worth at market', lumaUsd != null ? usd(total * lumaUsd) : '–', lumaUsd != null ? usd(lumaUsd) + ' per ' + esc(ctx.native()) : '')}
      ${t('Needed for outstanding USD', needed != null ? fmt(needed, 2) + ' ' + esc(ctx.native()) : '–', 'outstanding ÷ market price')}
      ${t('Coverage', needed ? fmt((total / needed) * 100, 1) + '%' : needed === 0 ? 'full' : '–', needed && total > needed ? 'over-burned by ' + fmt(total - needed, 2) : needed ? 'still to burn ' + fmt(Math.max(0, needed - total), 2) : '')}
      ${t('Burned 1h / 24h / 7d', fmt(win(3600e3), 0) + ' / ' + fmt(win(86400e3), 0) + ' / ' + fmt(win(7 * 86400e3), 0), esc(ctx.native()))}
      ${t('USD minted / retired', usd(mint) + ' / ' + usd(ret), 'all time, from the issuer')}</div>
      <div class="mut" style="font-size:.74rem;margin-top:.5rem">Burned ${esc(ctx.native())} per day (last 30 days with activity)</div>
      <div style="overflow:auto"><svg width="${Math.max(300, series.length * 20)}" height="84">${bars || '<text x="8" y="36" fill="#889">No burns recorded yet.</text>'}</svg></div>
      <div style="overflow:auto;max-height:240px"><table class="dxt"><thead><tr><th>Time</th><th class="r">${esc(ctx.native())} burned</th><th>From</th><th>Transaction</th></tr></thead><tbody>${burns
        .slice(0, 20)
        .map(b => `<tr><td>${b.at ? new Date(b.at).toLocaleString() : '–'}</td><td class="r mono">${fmt(b.luma, 6)}</td><td class="mono">${esc(ctx.show(b.from).slice(0, 12))}…</td><td class="mono">${esc(b.hash.slice(0, 12))}…</td></tr>`)
        .join('') || '<tr><td colspan="4" class="mut">No burns yet.</td></tr>'}</tbody></table></div>
      <div class="mut" style="font-size:.72rem;margin-top:.3rem">Burned ${esc(ctx.native())} sits in the unspendable account ${esc(ctx.show(BURN_R))}. Only the 1,600 most recent transactions are read.</div>`;
    const e2 = document.getElementById('bn');
    if (e2) {
      e2.innerHTML = last;
      e2.style.opacity = '1';
    }
  } catch (e: any) {
    const e2 = document.getElementById('bn');
    if (e2) {
      e2.innerHTML = `<div class="mut">Could not read burn data: ${esc(e?.message || e)}</div>`;
      e2.style.opacity = '1';
    }
  } finally {
    busy = false;
  }
}

let tkLast = '';
let tkBusy = false;
let tkAt = 0;
export function pageShell() {
  return `<div class="grid burnpg" style="width:100%"><div class="c12">${shell()}</div><div class="card c12"><div class="row" style="align-items:center;gap:.6rem"><div class="k">Backing and burns for every token</div><span class="grow"></span><button class="sm" onclick="window.bn.tokens()">Refresh</button></div><div id="bntk" style="margin-top:.5rem">${tkLast || '<div class="mut">Reading tokens…</div>'}</div><div class="mut" style="font-size:.72rem;margin-top:.4rem">Read-only view of the ledger. Burning and redeeming happen in the control panel.</div></div></div>`;
}
export async function tokens() {
  const el = document.getElementById('bntk');
  if (!el || !ctx.online()) return;
  if (tkBusy && Date.now() - tkAt < 25000) return;
  tkBusy = true;
  tkAt = Date.now();
  el.style.opacity = '.55';
  try {
    const { rows, now } = await M.tokenTable();
    const perUsd = now.usdPerNative != null && now.usdPerNative > 0 ? 1 / now.usdPerNative : null; // native per 1 USD at market
    const list = rows.filter(r => r.key !== 'native' && r.issuer && r.name !== 'USD (old)' && !/^LP/i.test(r.name));
    const back: Record<string, number> = {};
    const seen = new Set<string>();
    for (const r of list) {
      if (seen.has(r.issuer)) continue;
      seen.add(r.issuer);
      for (const t of await pull(r.issuer, 4)) {
        if (t.TransactionType !== 'Payment' || t.Destination !== r.issuer || !t.Amount || typeof t.Amount !== 'object') continue;
        const k = r.issuer + '|' + M.labelOf({ c: t.Amount.currency, i: r.issuer });
        back[k] = (back[k] || 0) + Number(t.Amount.value);
      }
    }
    let tv = 0;
    let cum = 0;
    const bi: any = await tryReq('account_info', { account: BURN_R, ledger_index: 'current' });
    const bal = bi && bi.account_data ? Number(bi.account_data.Balance) / 1e6 : burnedBal;
    const body = list
      .map(r => {
        const val = r.supply != null && r.usdPx != null ? r.supply * r.usdPx : null;
        if (val != null && r.name !== 'USD') tv += val;
        const need = val != null && perUsd != null ? val * perUsd : null;
        const ret = back[r.issuer + '|' + r.name] || 0;
        cum += need || 0;
        const ok = need == null ? null : bal >= cum;
        return `<tr><td><b>${esc(r.name)}</b>${r.name === 'USD' ? ' <span class="mut">(backing token)</span>' : ''}</td><td class="r mono">${r.usdPx != null ? usd(r.usdPx) : '–'}</td><td class="r mono">${r.supply != null ? fmt(r.supply, 4) : '–'}</td><td class="r mono">${val != null ? usd(val) : '–'}</td><td class="r mono">${need != null ? fmt(need, 2) : '–'}</td><td class="r mono">${ret ? fmt(ret, 4) : '0'}</td><td class="r mono">${ret && r.usdPx != null ? usd(ret * r.usdPx) : '–'}</td><td style="color:${ok ? '#00ff8c' : '#ff5a5a'}"><b>${ok == null ? '–' : ok ? 'Fully backed' : 'Short ' + fmt(cum - bal, 2)}</b></td></tr>`;
      })
      .join('');
    tkLast = `<div style="overflow:auto"><table class="dxt"><thead><tr><th>Token</th><th class="r">Price</th><th class="r">Supply</th><th class="r">Value</th><th class="r">${esc(ctx.native())} to back it at market</th><th class="r">Returned to issuer</th><th class="r">Value returned</th><th>Backing</th></tr></thead><tbody>${body || '<tr><td colspan="8" class="mut">No tokens found.</td></tr>'}</tbody></table></div><div class="mut" style="font-size:.74rem;margin-top:.4rem">Total value of non-USD tokens: ${usd(tv)}. Burn account holds ${fmt(bal, 2)} ${esc(ctx.native())}; each row is checked against the running total needed. Tokens sent back to their issuer no longer exist; the most recent 800 issuer transactions are read.</div>`;
    const e2 = document.getElementById('bntk');
    if (e2) {
      e2.innerHTML = tkLast;
      e2.style.opacity = '1';
    }
  } catch (e: any) {
    const e2 = document.getElementById('bntk');
    if (e2) {
      e2.innerHTML = `<div class="mut">Could not read token data: ${esc(e?.message || e)}</div>`;
      e2.style.opacity = '1';
    }
  } finally {
    tkBusy = false;
  }
}
export function pageMount() {
  load();
  tokens();
}
export const api = { load, tokens };
