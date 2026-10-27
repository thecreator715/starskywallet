// LUMA Supply page: supply, genesis, pools, holders, growth and every asset, all read from the connected node.
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import * as TK from './tokens.ts';
import { NATIVE, akey, esc, fmt, hexName, isNative, pctHtml, short, usd } from './util.ts';
import { header, ledgerAgo, ledgerSeries, tryReq } from './chain.ts';

const $ = (id: string) => document.getElementById(id);
const setHtml = (id: string, h: string) => {
  const e = $(id) as any;
  if (e && e.__h !== h) {
    e.innerHTML = h;
    e.__h = h;
  }
};
const kv = (k: string, v: string, sub = '') => `<div class="tile kvt"><div class="k">${k}</div><div class="big2">${v}</div>${sub ? `<div class="mut" style="font-size:.78rem">${sub}</div>` : ''}</div>`;
export const SP: any = { range: '24h', timer: null, keepHtml: '', gen: 0 };
const INITIAL = 1e10;
/** the genesis wallet: the one saved under Tokens → Create, otherwise the biggest non-pool holder when it holds a large share of the supply */
export async function detectGenesis(total: number, h?: { top: M.HolderRow[] } | null): Promise<{ addr: string; bal: number | null; auto: boolean }> {
  let saved = '';
  try {
    saved = TK.genesisAddr() ? ctx.toClassic(TK.genesisAddr()) : '';
  } catch {}
  if (saved) return { addr: saved, bal: await balOf(saved), auto: false };
  const top = h && h.top.find(r => !r.tag || !/pool/i.test(r.tag));
  if (top && total > 0 && top.bal / total >= 0.1) return { addr: top.addr, bal: top.bal, auto: true };
  return { addr: '', bal: null, auto: false };
}

export function supplyShell() {
  return `<div id="sp" class="nwpage">
    <div class="row" style="gap:.6rem;margin-bottom:.8rem;align-items:center"><span class="mut" style="font-size:.78rem;text-transform:uppercase;letter-spacing:.08em">Chart range</span>
      <div class="seg">${['1h', '24h', '7d', 'all'].map(x => `<button class="${SP.range === x ? 'on' : ''}" onclick="window.sp.range('${x}')">${x}</button>`).join('')}</div></div>
    <div class="pgrid nwk" id="sp_tiles"><div class="mut" style="padding:1rem">Reading the supply…</div></div>
    <div class="nwh">Who holds the supply</div><div class="card" id="sp_comp"></div>
    <div class="nwh">Growth</div><div class="nwg3" id="sp_growth"></div>
    <div class="nwh">${ctx.native()} in each pool</div><div class="card nwscroll" id="sp_pools"></div>
    <div class="nwg3" style="margin-top:1rem;grid-template-columns:repeat(2,minmax(0,1fr))">
      <div class="card"><div class="k">Top ${ctx.native()} holders</div><div id="sp_hold" class="nwscroll"></div></div>
      <div class="card"><div class="k">Your wallets</div><div id="sp_wal" class="nwscroll"></div></div></div>
    <div class="nwh">Every asset</div><div class="card nwscroll" id="sp_assets" style="max-height:none"></div></div>`;
}
export function supplyMount() {
  clearInterval(SP.timer);
  SP.timer = setInterval(() => ($('sp') ? supplyLoad() : clearInterval(SP.timer)), 30000);
  if (SP.keepHtml && $('sp')) ($('sp') as HTMLElement).innerHTML = SP.keepHtml;
  supplyLoad();
}
export function supplyUnmount() {
  clearInterval(SP.timer);
}
function line(label: string, pts: { ms: number; v: number }[], fm: (v: number) => string, col = '#00ff8c') {
  if (pts.length < 2) return `<div class="tile kvt"><div class="k">${label}</div><div class="mut">Not enough history on this node yet.</div></div>`;
  const v = pts.map(p => p.v),
    lo = Math.min(...v),
    hi = Math.max(...v),
    sp = hi - lo || Math.abs(hi) || 1,
    W = 420,
    H = 110,
    t0 = pts[0].ms,
    t1 = pts[pts.length - 1].ms;
  const d = pts.map((p, i) => (i ? 'L' : 'M') + (((p.ms - t0) / (t1 - t0 || 1)) * W).toFixed(1) + ' ' + (H - 4 - ((p.v - lo) / sp) * (H - 12)).toFixed(1)).join(' ');
  return `<div class="tile kvt"><div class="k">${label}</div><div class="big2" style="font-size:1.2rem">${fm(v[v.length - 1])} ${v[0] ? pctHtml((v[v.length - 1] / v[0] - 1) * 100) : ''}</div><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none"><path d="${d} L${W} ${H} L0 ${H} Z" fill="${col}" opacity=".09"/><path d="${d}" fill="none" stroke="${col}" stroke-width="2"/></svg><div class="mut" style="display:flex;justify-content:space-between;font-size:.74rem"><span>low ${fm(lo)}</span><span>high ${fm(hi)}</span></div></div>`;
}
const pp = (v: number | null) => (v == null || !isFinite(v) ? '–' : (v < 0.01 && v > 0 ? '<0.01' : v.toFixed(2)) + '%');
async function balOf(a: string): Promise<number | null> {
  const r: any = await tryReq('account_info', { account: a, ledger_index: 'validated' }, 10000);
  return r && r.account_data ? Number(r.account_data.Balance) / 1e6 : null;
}
export async function supplyLoad() {
  const g = ++SP.gen;
  const live = () => g === SP.gen && !!$('sp');
  if (!ctx.online()) return setHtml('sp_tiles', '<div class="mut" style="padding:1rem">Not connected to a node.</div>');
  try {
    const nowH = await header('validated');
    const total = nowH ? nowH.total : 0;
    const t = await M.tokenTable();
    if (!live()) return;
    const sn = t.now;
    const px = sn.usdPerNative;
    const n = ctx.native();
    const poolAccts = new Set(sn.pools.map(p => p.account));
    const h = await M.holders(NATIVE, total, poolAccts).catch(() => null);
    const g0 = await detectGenesis(total, h);
    const gAddr = g0.addr;
    const gBal = g0.bal;
    const inPools = sn.pools.reduce((s, p) => s + (isNative(p.a) ? p.ra : isNative(p.b) ? p.rb : 0), 0);
    const circ = Math.max(0, total - (gBal || 0));
    const rest = Math.max(0, circ - inPools);
    const burned = INITIAL - total;
    const w24 = t.ws.find(w => w.w.k === '24h');
    const px24 = w24 ? w24.snap.usdPerNative : null;
    const chg = px != null && px24 ? (px / px24 - 1) * 100 : null;
    const day = await ledgerAgo(86400).catch(() => null);
    const dh = day ? await header(day.seq) : null;
    const burn24 = nowH && dh && dh.seq < nowH.seq ? dh.total - nowH.total : null;
    const tvlUsd = sn.pools.reduce((tt, p) => { const pa = sn.px.get(akey(p.a)); const pb = sn.px.get(akey(p.b)); return tt + (pa != null ? p.ra * pa : pb != null ? p.rb * pb : 0) * 2; }, 0) * (px ?? 1);
    setHtml(
      'sp_tiles',
      [
        kv(`${n} price`, px != null ? usd(px) : '–', chg != null ? `24h ${pctHtml(chg)}` : ''),
        kv('Total supply', fmt(total, 2), `${n} · started at ${fmt(INITIAL, 0)}`),
        kv('Circulating supply', fmt(circ, 2), gAddr ? `total minus the genesis wallet (${pp((circ / total) * 100)})` : 'genesis wallet not found: all supply counted'),
        kv('Market cap', px != null ? usd(total * px) : '–', 'total supply × price'),
        kv('Circulating market cap', px != null ? usd(circ * px) : '–', 'circulating × price'),
        kv('Genesis wallet', gBal != null ? fmt(gBal, 2) : '–', gAddr ? `${pp(((gBal || 0) / total) * 100)} of supply · ${esc(short(ctx.show(gAddr), 7, 5))}${g0.auto ? ' (found automatically)' : ''}` : 'not found on this network'),
        kv('In AMM pools', fmt(inPools, 2), `${pp((inPools / total) * 100)} of supply · ${sn.pools.length} pools`),
        kv('Other wallets', fmt(rest, 2), `${pp((rest / total) * 100)} of supply${h ? ' · ' + fmt(h.count, 0) + ' holders' : ''}`),
        kv('Burned in fees', fmt(burned, 4), burn24 != null ? `${fmt(burn24, 6)} in the last ~24h` : 'since genesis'),
        kv('Total pool value', sn.pools.length ? (px != null ? usd(tvlUsd) : '–') : '–', `${sn.pools.length} pools · ledger #${fmt(nowH?.seq ?? 0, 0)}`),
      ].join('')
    );
    const parts = [
      { l: 'Genesis', v: gBal || 0, c: '#00ff8c' },
      { l: 'AMM pools', v: inPools, c: '#9b5cff' },
      { l: 'Other wallets', v: rest, c: '#ffb020' },
    ];
    setHtml(
      'sp_comp',
      `<div style="display:flex;height:1.4rem;border-radius:.5rem;overflow:hidden">${parts.map(p => `<div title="${p.l}" style="width:${total ? (p.v / total) * 100 : 0}%;background:${p.c}"></div>`).join('')}</div>
      <table class="dxt" style="margin-top:.6rem"><thead><tr><th></th><th class="r">${n}</th><th class="r">% of supply</th><th class="r">Value</th></tr></thead><tbody>${parts.map(p => `<tr><td><span style="display:inline-block;width:.7rem;height:.7rem;border-radius:50%;background:${p.c};margin-right:.4rem"></span>${p.l}</td><td class="r">${fmt(p.v, 2)}</td><td class="r">${pp(total ? (p.v / total) * 100 : null)}</td><td class="r">${px != null ? usd(p.v * px) : '–'}</td></tr>`).join('')}</tbody></table>`
    );
    const sec = SP.range === '1h' ? 3600 : SP.range === '7d' ? 7 * 86400 : SP.range === 'all' ? Infinity : 86400;
    const ser = await ledgerSeries(sec, 24);
    const hs = (await Promise.all(ser.map(s => header(s.seq)))).filter(Boolean) as any[];
    const gr = await M.growth(sec, 24);
    if (!live()) return;
    const hasUsd = gr.some(p => p.usd);
    setHtml(
      'sp_growth',
      line('Total supply', hs.map(h => ({ ms: h.close, v: h.total })), v => fmt(v, 4)) +
        line(`${n} price`, gr.filter(p => p.price != null).map(p => ({ ms: p.ms, v: p.price as number })), v => (hasUsd ? usd(v) : fmt(v)), '#9b5cff') +
        line('Total pool value', gr.filter(p => p.tvl != null).map(p => ({ ms: p.ms, v: p.tvl as number })), v => (hasUsd ? usd(v) : fmt(v) + ' ' + n), '#ffb020')
    );
    const lp = sn.pools.filter(p => isNative(p.a) || isNative(p.b)).map(p => ({ p, l: isNative(p.a) ? p.ra : p.rb, o: isNative(p.a) ? p.b : p.a }));
    lp.sort((a, b) => b.l - a.l);
    setHtml(
      'sp_pools',
      lp.length
        ? `<table class="dxt"><thead><tr><th>Pool</th><th class="r">${n} in pool</th><th class="r">% of supply</th><th class="r">Value</th><th class="r">Fee</th></tr></thead><tbody>${lp.map(x => `<tr><td><b>${esc(n)}/${esc(hexName(x.o.c))}</b></td><td class="r">${fmt(x.l, 2)}</td><td class="r">${pp((x.l / total) * 100)}</td><td class="r">${px != null ? usd(x.l * px * 2) : '–'}</td><td class="r">${x.p.fee}%</td></tr>`).join('')}</tbody></table>`
        : '<div class="mut" style="padding:.8rem">No pool holds the native coin yet.</div>'
    );
    if (!live()) return;
    setHtml(
      'sp_hold',
      h && h.top.length
        ? `<table class="dxt"><thead><tr><th>#</th><th>Account</th><th class="r">${n}</th><th class="r">%</th></tr></thead><tbody>${h.top.slice(0, 15).map((r, i) => `<tr><td class="mut">${i + 1}</td><td><a href="#" class="who mono" onclick="window.inspectAccount('${esc(r.addr)}');return false">${esc(short(ctx.show(r.addr), 7, 6))}</a> ${r.addr === gAddr ? '<span class="chip">GENESIS</span>' : r.tag ? `<span class="chip">${esc(r.tag)}</span>` : ''}${ctx.wallets().some(w => w.address === r.addr) ? ' <span class="chip b">YOU</span>' : ''}</td><td class="r">${fmt(r.bal, 2)}</td><td class="r">${pp(r.share != null ? r.share * (r.share <= 1 ? 100 : 1) : null)}</td></tr>`).join('')}</tbody></table>${h.truncated ? '<div class="mut" style="font-size:.76rem;margin-top:.4rem">List is capped by the node.</div>' : ''}`
        : '<div class="mut" style="padding:.8rem">Holder list not available from this node.</div>'
    );
    const ws = ctx.wallets().filter(w => w.type === 'luma');
    const wb = await Promise.all(ws.map(w => balOf(w.address)));
    setHtml(
      'sp_wal',
      ws.length
        ? `<table class="dxt"><thead><tr><th>Wallet</th><th class="r">${n}</th><th class="r">% supply</th><th class="r">Value</th></tr></thead><tbody>${ws.map((w, i) => `<tr><td>${esc(w.label)}</td><td class="r">${wb[i] != null ? fmt(wb[i], 4) : '0 <small class="mut">not activated</small>'}</td><td class="r">${wb[i] != null ? pp(((wb[i] as number) / total) * 100) : '0.00%'}</td><td class="r">${wb[i] != null && px != null ? usd((wb[i] as number) * px) : px != null ? '$0' : '–'}</td></tr>`).join('')}</tbody></table>`
        : '<div class="mut" style="padding:.8rem">No LUMA wallets yet.</div>'
    );
    const pc = (v: number | null | undefined) => (v == null ? '<span class="mut">–</span>' : pctHtml(v));
    setHtml(
      'sp_assets',
      `<table class="dxt"><thead><tr><th>Asset</th><th class="r">Price</th><th class="r">1H</th><th class="r">24H</th><th class="r">7D</th><th class="r">Supply</th><th class="r">Market cap</th><th class="r">Pool value</th><th class="r">Pools</th></tr></thead><tbody>${t.rows
        .map(r => `<tr><td><b>${esc(r.name)}</b></td><td class="r">${r.usdPx != null ? usd(r.usdPx) : r.nativePx != null ? fmt(r.nativePx) + ' ' + n : '–'}</td><td class="r">${pc(r.chg['1h'])}</td><td class="r">${pc(r.chg['24h'])}</td><td class="r">${pc(r.chg['7d'])}</td><td class="r">${r.supply != null ? fmt(r.supply, 2) : '–'}</td><td class="r">${r.mcapUsd != null ? usd(r.mcapUsd) : r.mcapNative != null ? fmt(r.mcapNative, 2) + ' ' + n : '–'}</td><td class="r">${r.tvlUsd != null ? usd(r.tvlUsd) : fmt(r.tvlNative, 2) + ' ' + n}</td><td class="r">${r.pools}</td></tr>`)
        .join('')}</tbody></table>`
    );
    const e = $('sp') as HTMLElement;
    if (e) SP.keepHtml = e.innerHTML;
  } catch (e: any) {
    if (live()) setHtml('sp_tiles', `<div class="mut" style="padding:1rem">Could not read the supply: ${esc(e?.message || e)}</div>`);
  }
}
export const spApi = {
  range(r: string) {
    SP.range = r;
    document.querySelectorAll('#sp .seg button').forEach(b => b.classList.toggle('on', b.textContent === r));
    supplyLoad();
  },
};
void akey;
