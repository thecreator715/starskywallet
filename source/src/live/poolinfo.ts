// Liquidity pools page: every pool with prices both ways, % changes, dollar and LUMA values, your position, and a detail page per pool.
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { Asset, akey, esc, fmt, pctHtml, short, usd, ago } from './util.ts';
import { chartSvg } from './dexchart.ts';

const $ = (id: string) => (typeof document === 'undefined' ? null : document.getElementById(id));
const nm = (a: Asset) => M.labelOf(a);
const FAVK = 'starsky.favs';
const favs = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAVK) || '[]'));
  } catch {
    return new Set();
  }
};
const PL: any = { q: '', tok: '', favOnly: false, sel: '', inv: false, range: '1h', pools: [], mine: (_p: any) => ({ bal: 0, share: 0 }), rows: [], busy: false, last: '', cd: null, ck: '', cat: 0, trades: null, tat: 0 };
const WK = ['1h', '24h', '7d'];
const chg = (a: number | null, b: number | null) => (a == null || b == null || !(b > 0) ? null : (a / b - 1) * 100);
const dsg = (v: number | null, f: (n: number) => string) => (v == null ? '–' : (v >= 0 ? '+' : '−') + f(Math.abs(v)));
const dcol = (v: number | null) => (v == null ? '' : v >= 0 ? 'up' : 'dn');

export function shell() {
  return `<div id="pl_body">${PL.last || '<div class="mut" style="padding:1rem">Reading pools…</div>'}</div>`;
}
interface Row {
  p: any;
  idx: number;
  ka: string;
  kb: string;
  ua: number | null; // USD price of side A
  ub: number | null;
  na: number | null; // LUMA price of side A
  nb: number | null;
  valN: number | null; // pool value in LUMA
  valU: number | null;
  fwd: number; // B per A
  rev: number; // A per B
  ch: Record<string, { fwd: number | null; rev: number | null; a: number | null; b: number | null; tvl: number | null; valN0: number | null }>;
  bal: number;
  share: number;
  lp: number;
}
async function compute() {
  const sn = await M.snapshot();
  const ws = await M.windowSnaps().catch(() => [] as M.WinSnap[]);
  const refs = await M.poolRefs().catch(() => [] as M.PoolRef[]);
  const un = sn.usdPerNative;
  const rows: Row[] = [];
  for (let idx = 0; idx < PL.pools.length; idx++) {
    const p = PL.pools[idx];
    const ka = akey(p.a1), kb = akey(p.a2);
    const na = ka === 'native' ? 1 : sn.px.get(ka) ?? null, nb = kb === 'native' ? 1 : sn.px.get(kb) ?? null;
    const valN = na != null && nb != null ? p.r1 * na + p.r2 * nb : na != null ? p.r1 * na * 2 : nb != null ? p.r2 * nb * 2 : null;
    const ref = refs.find(r => r.account === p.m.account);
    const m = PL.mine(p);
    const ch: Row['ch'] = {};
    for (const k of WK) {
      const w = ws.find(z => z.w.k === k);
      if (!w) continue;
      const s0 = w.snap, a0 = ka === 'native' ? 1 : s0.px.get(ka) ?? null, b0 = kb === 'native' ? 1 : s0.px.get(kb) ?? null;
      const st0 = ref ? await M.poolState(ref, w.seq).catch(() => null) : null;
      let f0: number | null = null, v0: number | null = null;
      if (st0) {
        const same = akey(st0.a) === ka;
        const r1 = same ? st0.ra : st0.rb, r2 = same ? st0.rb : st0.ra;
        f0 = r1 > 0 ? r2 / r1 : null;
        v0 = a0 != null && b0 != null ? r1 * a0 + r2 * b0 : null;
      } else if (a0 != null && b0 != null) f0 = a0 / b0;
      const fwd = p.price > 0 ? p.price : null;
      ch[k] = { fwd: chg(fwd, f0), rev: fwd && f0 ? chg(1 / fwd, 1 / f0) : null, a: chg(na, a0), b: chg(nb, b0), tvl: chg(valN, v0), valN0: v0 };
      // USD-terms price changes for each side
      if (un != null && s0.usdPerNative != null) {
        ch[k].a = chg(na != null ? na * un : null, a0 != null ? a0 * s0.usdPerNative : null);
        ch[k].b = chg(nb != null ? nb * un : null, b0 != null ? b0 * s0.usdPerNative : null);
      }
    }
    rows.push({ p, idx, ka, kb, ua: na != null && un != null ? na * un : null, ub: nb != null && un != null ? nb * un : null, na, nb, valN, valU: valN != null && un != null ? valN * un : null, fwd: p.price, rev: p.price > 0 ? 1 / p.price : 0, ch, bal: m.bal, share: m.share, lp: Number(p.m.lp_token?.value || 0) });
  }
  return { rows, un };
}
const dual = (u: number | null, n: number | null, nat: string) => (u != null ? `${usd(u)}<div class="mut" style="font-size:.7rem">${n != null ? fmt(n, 2) + ' ' + esc(nat) : ''}</div>` : n != null ? fmt(n, 2) + ' ' + esc(nat) : '–');
function listHtml(allRows: Row[], un: number | null) {
  const nat = ctx.native();
  const F = favs();
  const q = PL.q.trim().toLowerCase();
  const toks = [...new Set(allRows.flatMap(r => [nm(r.p.a1), nm(r.p.a2)]))].sort();
  const rows = allRows
    .filter(r => (!PL.tok || nm(r.p.a1) === PL.tok || nm(r.p.a2) === PL.tok) && (!PL.favOnly || F.has('p:' + r.p.m.account)) && (!q || (nm(r.p.a1) + ' ' + nm(r.p.a2) + ' ' + r.p.m.account + ' ' + ctx.show(r.p.m.account)).toLowerCase().includes(q)))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(F.has('p:' + b.r.p.m.account)) - Number(F.has('p:' + a.r.p.m.account)) || a.i - b.i)
    .map(z => z.r);
  const ctl = `<div class="row" style="gap:.45rem;flex-wrap:wrap;align-items:center;margin-bottom:.6rem"><input id="pl_q" placeholder="Search a token or pool address" value="${esc(PL.q)}" style="width:min(20rem,100%)" oninput="window.pl.search(this.value)"><button class="sm ${PL.favOnly ? 'pri' : ''}" onclick="window.pl.favOnly()">★ Favorites</button><button class="sm ${PL.tok ? '' : 'pri'}" onclick="window.pl.token('')">All tokens</button>${toks.map(t => `<button class="sm ${PL.tok === t ? 'pri acc' : ''}" onclick="window.pl.token('${esc(t)}')">${esc(t)}</button>`).join('')}</div>`;
  const tot = rows.reduce((s, r) => s + (r.valN ?? 0), 0);
  const mineN = rows.reduce((s, r) => s + (r.valN != null ? r.valN * r.share : 0), 0);
  const tile = (k: string, v: string, s = '') => `<div class="tile kvt" style="flex:1;min-width:11rem"><div class="k">${k}</div><div class="big2">${v}</div><div class="mut" style="font-size:.72rem">${s}</div></div>`;
  const tvl24 = rows.reduce((s, r) => s + (r.ch['24h'] && r.ch['24h'].valN0 != null ? r.ch['24h'].valN0! : r.valN ?? 0), 0);
  const body = rows
    .map(r => {
      const c = r.ch['24h'] || ({} as any);
      const side = (amt: number, a: Asset, u: number | null, pc: number | null) => `${fmt(amt, 4)} <small class="mut">${esc(nm(a))}</small><div class="mut" style="font-size:.7rem">${u != null ? usd(amt * u) : ''} ${pctHtml(pc)}</div>`;
      const pos = r.share > 0 && r.valN != null ? { v: r.valN * r.share, d: c.valN0 != null ? (r.valN - c.valN0) * r.share : null } : null;
      return `<tr style="cursor:pointer" onclick="window.pl.open('${esc(r.p.m.account)}')" title="Click for all pool details">
        <td><span style="cursor:pointer;color:${F.has('p:' + r.p.m.account) ? '#ffd24a' : '#667'};margin-right:.4rem" onclick="event.stopPropagation();window.pl.fav('${esc(r.p.m.account)}')">${F.has('p:' + r.p.m.account) ? '★' : '☆'}</span><b>${esc(nm(r.p.a1))} / ${esc(nm(r.p.a2))}</b>${M.isOldUsd(r.p.a1) || M.isOldUsd(r.p.a2) ? ' <span style="color:#ff5a5a;font-size:.7rem;border:1px solid #ff5a5a;border-radius:6px;padding:0 .3rem">OLD USD</span>' : ''}<div class="mut mono" style="font-size:.68rem">${esc(short(ctx.show(r.p.m.account), 8, 5))}</div></td>
        <td class="r">${side(r.p.r1, r.p.a1, r.ua, c.a)}</td><td class="r">${side(r.p.r2, r.p.a2, r.ub, c.b)}</td>
        <td class="r mono">${fmt(r.fwd, 6)}<div class="mut" style="font-size:.7rem">${esc(nm(r.p.a2))} per ${esc(nm(r.p.a1))}</div>${pctHtml(c.fwd)}</td>
        <td class="r mono">${fmt(r.rev, 6)}<div class="mut" style="font-size:.7rem">${esc(nm(r.p.a1))} per ${esc(nm(r.p.a2))}</div>${pctHtml(c.rev)}</td>
        <td class="r">${dual(r.valU, r.valN, nat)}${pctHtml(c.tvl)}</td>
        <td class="r">${r.p.fee}%</td>
        <td class="r">${r.share > 0 ? (r.share * 100).toFixed(r.share < 0.0001 ? 6 : r.share < 0.01 ? 4 : 2) + '%' : '0.00%'}${pos ? `<div class="mut" style="font-size:.7rem">${un != null ? usd(pos.v * un) : fmt(pos.v, 2) + ' ' + esc(nat)}</div><div class="${dcol(pos.d)}" style="font-size:.7rem">24h ${pos.d == null ? '–' : un != null ? dsg(pos.d * un, n => usd(n)) : dsg(pos.d, n => fmt(n, 2))}</div>` : ''}</td>
        <td class="r" onclick="event.stopPropagation()"><div class="row" style="justify-content:flex-end;gap:.3rem"><button class="sm pri" onclick="window.openDepositModal(${r.idx})">Deposit</button><button class="sm" onclick="window.openWithdrawModal(${r.idx})">Withdraw</button><button class="sm pri acc" onclick="window.pl.trade(${r.idx})">Trade</button></div></td></tr>`;
    })
    .join('');
  return `${ctl}<div class="row" style="gap:.6rem;flex-wrap:wrap;margin-bottom:.7rem">
    ${tile('Total value in pools', un != null ? usd(tot * un) : fmt(tot, 2) + ' ' + esc(nat), fmt(tot, 2) + ' ' + esc(nat) + (tvl24 > 0 ? ' · 24h ' + pctTxt(chg(tot, tvl24)) : ''))}
    ${tile('Pools', rows.length === allRows.length ? String(rows.length) : rows.length + ' of ' + allRows.length, PL.tok ? 'with ' + esc(PL.tok) : 'on the ' + esc(nat) + ' network')}
    ${tile('Your pool value', un != null ? usd(mineN * un) : fmt(mineN, 2) + ' ' + esc(nat), fmt(mineN, 2) + ' ' + esc(nat))}</div>
  <div class="tile c12"><div style="overflow-x:auto"><table class="dxt"><thead><tr><th>Pool</th><th class="r">Reserve 1</th><th class="r">Reserve 2</th><th class="r">Price</th><th class="r">Reverse price</th><th class="r">Value (24h)</th><th class="r">Fee</th><th class="r">Your share</th><th class="r">Actions</th></tr></thead><tbody>${body || '<tr><td colspan="9" class="mut" style="padding:1rem">No pools match.</td></tr>'}</tbody></table></div><div class="mut" style="font-size:.74rem;margin-top:.4rem">Percentages are changes over the last 24 hours. Click a pool for everything about it.</div></div>`;
}
const pctTxt = (v: number | null) => (v == null ? '–' : `<span class="${v >= 0 ? 'up' : 'dn'}">${v >= 0 ? '▲' : '▼'} ${Math.abs(v).toFixed(2)}%</span>`);
function detailHtml(r: Row, un: number | null) {
  const nat = ctx.native(), A = nm(r.p.a1), B = nm(r.p.a2), a = r.p.a1, b = r.p.a2;
  const inv = PL.inv;
  const tile = (k: string, v: string, s = '') => `<div class="tile kvt" style="flex:1;min-width:12rem"><div class="k">${k}</div><div class="big2">${v}</div><div class="mut" style="font-size:.72rem">${s}</div></div>`;
  const wr = WK.map(k => {
    const c = r.ch[k];
    return c ? `<tr><td><b>${k.toUpperCase()}</b></td><td class="r">${pctHtml(c.fwd)}</td><td class="r">${pctHtml(c.rev)}</td><td class="r">${pctHtml(c.a)}</td><td class="r">${pctHtml(c.b)}</td><td class="r">${pctHtml(c.tvl)}</td><td class="r">${c.valN0 != null && r.valN != null ? (un != null ? dsg((r.valN - c.valN0) * un, n => usd(n)) : dsg(r.valN - c.valN0, n => fmt(n, 2))) : '–'}</td></tr>` : '';
  }).join('');
  const c24 = r.ch['24h'] || ({} as any);
  const pos = r.share > 0 && r.valN != null ? { v: r.valN * r.share, d: c24.valN0 != null ? (r.valN - c24.valN0) * r.share : null } : null;
  const px = (u: number | null) => (u != null ? usd(u) : '–');
  return `<div class="row" style="align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.7rem"><button class="sm" onclick="window.pl.back()">← All pools</button><h2 style="margin:0">${esc(A)} / ${esc(B)}</h2><span class="mut">fee ${r.p.fee}% · pool <span class="mono">${esc(short(ctx.show(r.p.m.account), 10, 6))}</span> <a href="#" onclick="window.copyText('${esc(ctx.show(r.p.m.account))}');return false">copy</a></span><span class="grow"></span><button class="sm pri" onclick="window.openDepositModal(${r.idx})">Deposit</button><button class="sm" onclick="window.openWithdrawModal(${r.idx})">Withdraw</button><button class="sm pri acc" onclick="window.pl.trade(${r.idx})">Trade</button></div>
  <div class="row" style="gap:.6rem;flex-wrap:wrap">
    ${tile('Pool value', un != null ? usd(r.valU) : fmt(r.valN, 2) + ' ' + esc(nat), (r.valN != null ? fmt(r.valN, 2) + ' ' + esc(nat) : '') + ' · 24h ' + pctTxt(c24.tvl))}
    ${tile(esc(B) + ' per ' + esc(A), fmt(r.fwd, 8), px(r.ua) + ' per ' + esc(A) + ' · ' + (r.na != null ? fmt(r.na, 6) + ' ' + esc(nat) : '') + '<br>24h ' + pctTxt(c24.fwd))}
    ${tile('Reverse: ' + esc(A) + ' per ' + esc(B), fmt(r.rev, 8), px(r.ub) + ' per ' + esc(B) + ' · ' + (r.nb != null ? fmt(r.nb, 6) + ' ' + esc(nat) : '') + '<br>24h ' + pctTxt(c24.rev))}
    ${tile(esc(A) + ' reserve', fmt(r.p.r1, 4), (r.ua != null ? usd(r.p.r1 * r.ua) : '') + ' · 24h price ' + pctTxt(c24.a))}
    ${tile(esc(B) + ' reserve', fmt(r.p.r2, 4), (r.ub != null ? usd(r.p.r2 * r.ub) : '') + ' · 24h price ' + pctTxt(c24.b))}
    ${tile('LP supply', fmt(r.lp, 2), 'total LP tokens issued')}
    ${tile('Your position', pos ? (un != null ? usd(pos.v * un) : fmt(pos.v, 2) + ' ' + esc(nat)) : 'None', pos ? `${(r.share * 100).toFixed(r.share < 0.0001 ? 6 : 4)}% · ${fmt(r.bal, 4)} LP<br>${fmt(r.p.r1 * r.share, 4)} ${esc(A)} + ${fmt(r.p.r2 * r.share, 4)} ${esc(B)}<br><span class="${dcol(pos.d)}">24h ${pos.d == null ? '–' : un != null ? dsg(pos.d * un, n => usd(n)) + ' / ' + dsg(pos.d, n => fmt(n, 2) + ' ' + nat) : dsg(pos.d, n => fmt(n, 2) + ' ' + nat)}</span>` : 'You hold no LP tokens of this pool')}
  </div>
  <div class="tile c12" style="margin-top:.7rem"><div class="k">Changes</div><div style="overflow-x:auto"><table class="dxt"><thead><tr><th>Window</th><th class="r">${esc(B)} per ${esc(A)}</th><th class="r">${esc(A)} per ${esc(B)}</th><th class="r">${esc(A)} price</th><th class="r">${esc(B)} price</th><th class="r">Pool value</th><th class="r">Value change</th></tr></thead><tbody>${wr}</tbody></table></div><div class="mut" style="font-size:.72rem;margin-top:.3rem">Token price changes are in dollars when a dollar token exists, otherwise in ${esc(nat)}. Your 24h profit or loss is your share of the pool value change at today's LP balance.</div></div>
  <div class="tile c12" style="margin-top:.7rem"><div class="row" style="align-items:center;gap:.6rem;flex-wrap:wrap"><div class="k" style="margin:0">Chart · ${inv ? esc(B) + '/' + esc(A) : esc(A) + '/' + esc(B)}</div><button class="sm" onclick="window.pl.flip()">⇄ Reverse</button><div class="seg">${M.RANGES.map(x => `<button class="${PL.range === x.k ? 'on' : ''}" onclick="window.pl.range('${x.k}')">${x.label}</button>`).join('')}</div></div><div id="pl_chart" style="margin-top:.5rem;min-height:240px"></div></div>
  <div class="tile c12" style="margin-top:.7rem"><div class="k">Recent activity in this pool</div><div id="pl_tr" style="overflow:auto;max-height:22rem"></div></div>`;
}
function market(r: Row, inv: boolean): M.Market {
  const m: M.Market = { id: M.marketId(r.p.a1, r.p.a2), base: r.p.a1, quote: r.p.a2, label: nm(r.p.a1) + '/' + nm(r.p.a2), pool: r.p.m && PL.refs ? PL.refs.find((x: any) => x.account === r.p.m.account) : null } as any;
  return inv ? ({ id: M.marketId(m.quote, m.base), base: m.quote, quote: m.base, label: nm(m.quote) + '/' + nm(m.base), pool: m.pool } as any) : m;
}
async function paintExtras(r: Row) {
  const el = $('pl_chart');
  if (!el) return;
  PL.refs = await M.poolRefs().catch(() => []);
  const mk = market(r, PL.inv);
  const range = M.RANGES.find(x => x.k === PL.range) || M.RANGES[2];
  const ck = akey(mk.base) + akey(mk.quote) + range.k;
  if (PL.ck !== ck || Date.now() - PL.cat > 20000) {
    try {
      PL.cd = await M.candles(mk, range);
    } catch {
      PL.cd = null;
    }
    PL.ck = ck;
    PL.cat = Date.now();
  }
  const el2 = $('pl_chart');
  if (!el2) return;
  el2.innerHTML = PL.cd && PL.cd.list.length ? chartSvg(PL.cd.list, { scale: 'log', sma: true, style: 'candle', rangeSec: range.sec, h: 400 } as any, null).svg : '<div class="mut" style="padding:1rem">No chart data yet.</div>';
  if (!PL.trades || Date.now() - PL.tat > 30000) {
    try {
      PL.trades = await M.trades(market(r, false), 40);
    } catch {
      PL.trades = [];
    }
    PL.tat = Date.now();
  }
  const t = $('pl_tr');
  if (t)
    t.innerHTML = `<table class="dxt"><thead><tr><th>Time</th><th>Type</th><th class="r">${esc(nm(r.p.a1))}</th><th class="r">${esc(nm(r.p.a2))}</th><th class="r">Price</th><th>Wallet</th></tr></thead><tbody>${
      (PL.trades || []).map((x: M.Trade) => `<tr><td>${ago(Date.now() - x.ms)}</td><td><span class="chip ${x.kind === 'sell' || x.kind === 'remove' ? 'bad' : ''}">${x.kind.toUpperCase()}</span></td><td class="r mono">${fmt(x.base, 4)}</td><td class="r mono">${fmt(x.quote, 4)}</td><td class="r mono">${x.price != null ? fmt(x.price, 6) : '–'}</td><td class="mono">${esc(short(ctx.show(x.who), 6, 4))}</td></tr>`).join('') || '<tr><td colspan="6" class="mut">No recent activity found.</td></tr>'
    }</tbody></table>`;
}
async function paint() {
  const el = $('pl_body');
  if (!el || !PL.data) return;
  const { rows, un } = PL.data;
  const sel = rows.find((x: Row) => x.p.m.account === PL.sel);
  const html = sel ? detailHtml(sel, un) : listHtml(rows, un);
  if (PL.last !== html || !sel) {
    el.innerHTML = html;
    PL.last = html;
  }
  if (sel) paintExtras(sel);
}
export async function mount(pools: any[], mine: (p: any) => { bal: number; share: number }) {
  PL.pools = pools;
  PL.mine = mine;
  if (PL.data) paint();
  if (PL.busy || !ctx.online() || !$('pl_body')) return;
  PL.busy = true;
  try {
    PL.data = await compute();
    paint();
  } catch (e: any) {
    const el = $('pl_body');
    if (el && !PL.data) el.innerHTML = `<div class="mut" style="padding:1rem">Could not read pool data: ${esc(e?.message || e)}</div>`;
  }
  PL.busy = false;
}
const repaintKeep = () => {
  PL.last = '';
  paint();
  const i = $('pl_q') as HTMLInputElement | null;
  if (i && PL.focusQ) {
    i.focus();
    i.setSelectionRange(i.value.length, i.value.length);
  }
};
export const plApi = {
  search(v: string) {
    PL.q = v;
    PL.focusQ = true;
    repaintKeep();
  },
  token(t: string) {
    PL.tok = t;
    PL.focusQ = false;
    repaintKeep();
  },
  favOnly() {
    PL.favOnly = !PL.favOnly;
    PL.focusQ = false;
    repaintKeep();
  },
  fav(a: string) {
    const F = favs();
    const k = 'p:' + a;
    F.has(k) ? F.delete(k) : F.add(k);
    try {
      localStorage.setItem(FAVK, JSON.stringify([...F]));
    } catch {}
    PL.focusQ = false;
    repaintKeep();
  },
  open(a: string) {
    PL.sel = a;
    PL.inv = false;
    PL.ck = '';
    PL.trades = null;
    paint();
    window.scrollTo?.(0, 0);
  },
  back() {
    PL.sel = '';
    PL.last = '';
    paint();
  },
  flip() {
    PL.inv = !PL.inv;
    PL.last = '';
    paint();
  },
  range(k: string) {
    PL.range = k;
    PL.last = '';
    paint();
  },
  trade(idx: number) {
    const p = PL.pools[idx];
    if (!p) return;
    const k = (x: Asset) => (x.c === 'native' ? 'native' : x.c + '|' + x.i);
    const w = window as any;
    w.goTab('dex');
    setTimeout(() => w.dx.pickPool(k(p.a1), k(p.a2)), 300);
  },
};
