// XRPL DEX: same terminal as the LUMA DEX (chart, token card, spot ticket, tables) for the 50 XRPL tokens with the most volume, each against XRP.
// Prices come from the XRP Ledger order book (offers also cross the AMM pools automatically). No leverage here.
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { chartSvg } from './dexchart.ts';
import { esc, fmt, usd, hexName, short, amtNum, decN, tkLetters, pctHtml } from './util.ts';

interface Tok { cur: string; iss: string; name: string; usd: number | null; vol: number | null; holders: number | null; mcap: number | null; ch: { [k: string]: number | null } }
const API = 'https://api.xrpl.to/v1/tokens?sort=vol24hxrp&order=desc&limit=60';
const CK = 'starsky.xdx.top3', TTL = 10 * 60000;
const mk = (cur: string, iss: string, name: string): Tok => ({ cur, iss, name, usd: null, vol: null, holders: null, mcap: null, ch: {} });
const FALLBACK: Tok[] = [
  mk('524C555344000000000000000000000000000000', 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', 'RLUSD'),
  mk('USD', 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', 'USD (Bitstamp)'),
  mk('534F4C4F00000000000000000000000000000000', 'rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz', 'SOLO'),
  mk('434F524500000000000000000000000000000000', 'rcoreNywaoz2ZCQ8Lg2EbSLnGuRBmun6D', 'CORE'),
];
const RK = ['5m', '15m', '1h', '4h', '1d', '7d', '1M'];
const X: any = { toks: [] as Tok[], src: '', q: '', sel: null as Tok | null, side: 'buy', type: 'market', amt: '', price: '', range: '1d', scale: 'auto', style: 'candle', sma: true, ema: false, boll: false, tab: 'book', cd: null, cdKey: '', book: { asks: [], bids: [] }, xrp: null, bal: 0, hasLine: false, offers: [], busy: false, msg: '', bad: false, gen: 0 };
const CC = new Map<string, { at: number; list: M.Candle[]; note: string }>();
let timer: any = 0;
const $ = (id: string) => document.getElementById(id);
const setH = (id: string, h: string) => { const e: any = $(id); if (e && e.__h !== h) { e.innerHTML = h; e.__h = h; } };
const num = (v: any) => { const n = Number(v); return isFinite(n) ? n : null; };
const issue = (t: Tok) => ({ currency: t.cur, issuer: t.iss });
const isMain = () => ctx.netKey() !== 'test';
const rng = () => M.RANGES.find(r => r.k === X.range) || M.RANGES[4];
const ask = () => (X.book.asks[0] ? X.book.asks[0].px : null), bid = () => (X.book.bids[0] ? X.book.bids[0].px : null);
const mid = (): number | null => { const a = ask(), b = bid(); return a != null && b != null ? (a + b) / 2 : a ?? b; };
const xrpUsd = (): number | null => { const t: Tok | null = X.sel; return t && t.usd != null && mid() ? t.usd / (mid() as number) : null; };
const cf = (n: number | null | undefined, d = 2): string => (n == null || !isFinite(n) ? '–' : Math.abs(n) >= 1e12 ? (n / 1e12).toFixed(d) + 'T' : Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(d) + 'B' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(d) + 'M' : Math.abs(n) >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : fmt(n));
const first = (o: any, ...k: string[]) => { for (const x of k) { const v = num(o && o[x]); if (v != null) return v; } return null; };

async function loadTop(force = false) {
  let cached: any = null; try { cached = JSON.parse(localStorage.getItem(CK) || 'null'); } catch {}
  if (cached && !force && Date.now() - cached.at < TTL && cached.list && cached.list.length) { X.toks = cached.list; X.src = 'xrpl.to'; return; }
  try {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 9000);
    const r = await fetch(API, { signal: ac.signal }); clearTimeout(to);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j: any = await r.json();
    const arr: any[] = Array.isArray(j) ? j : j.tokens || j.data || j.results || [];
    const list: Tok[] = arr.map(t => ({ cur: String(t.currency || ''), iss: String(t.issuer || ''), name: String(t.name || t.user || '') || hexName(String(t.currency || '')), usd: first(t, 'usd'), vol: first(t, 'vol24hxrp'), holders: first(t, 'holders'), mcap: first(t, 'marketcap', 'mcap', 'marketCap'), ch: { '5m': first(t, 'pro5m'), '1h': first(t, 'pro1h'), '24h': first(t, 'pro24h'), '7d': first(t, 'pro7d') } }))
      .filter(t => t.cur && t.iss && t.cur !== 'XRP').slice(0, 50);
    if (!list.length) throw new Error('empty list');
    X.toks = list; X.src = 'xrpl.to';
    try { localStorage.setItem(CK, JSON.stringify({ at: Date.now(), list })); } catch {}
  } catch {
    if (cached && cached.list && cached.list.length) { X.toks = cached.list; X.src = 'saved copy'; }
    else { X.toks = FALLBACK; X.src = 'built-in list'; }
  }
}
const bookPx = (r: any, ask: boolean): number | null => {
  const o = r && r.offers && r.offers[0]; if (!o) return null;
  const p = ask ? amtNum(o.TakerPays) / amtNum(o.TakerGets) : amtNum(o.TakerGets) / amtNum(o.TakerPays);
  return isFinite(p) && p > 0 ? p : null;
};
async function loadBook() {
  const t: Tok | null = X.sel; if (!t) return; const g = X.gen;
  const [a, b] = await Promise.all([
    ctx.req('book_offers', { taker_gets: issue(t), taker_pays: { currency: 'XRP' }, limit: 20, ledger_index: 'validated' }).catch(() => null),
    ctx.req('book_offers', { taker_gets: { currency: 'XRP' }, taker_pays: issue(t), limit: 20, ledger_index: 'validated' }).catch(() => null),
  ]);
  if (g !== X.gen) return;
  X.book.asks = ((a && a.offers) || []).map((o: any) => ({ sz: amtNum(o.taker_gets_funded ?? o.TakerGets), px: amtNum(o.TakerPays) / amtNum(o.TakerGets) })).filter((o: any) => o.sz > 0 && isFinite(o.px) && o.px > 0);
  X.book.bids = ((b && b.offers) || []).map((o: any) => ({ sz: amtNum(o.taker_pays_funded ?? o.TakerPays), px: amtNum(o.TakerGets) / amtNum(o.TakerPays) })).filter((o: any) => o.sz > 0 && isFinite(o.px) && o.px > 0);
}
async function loadAcct() {
  const acc = ctx.account(), t: Tok | null = X.sel; if (!acc || !t) { X.xrp = null; X.bal = 0; X.hasLine = false; X.offers = []; return; }
  const g = X.gen;
  const [ai, al, ao] = await Promise.all([
    ctx.req('account_info', { account: acc, ledger_index: 'validated' }).catch(() => null),
    ctx.req('account_lines', { account: acc, peer: t.iss, ledger_index: 'validated' }).catch(() => null),
    ctx.req('account_offers', { account: acc, ledger_index: 'validated', limit: 100 }).catch(() => null),
  ]);
  if (g !== X.gen) return;
  X.xrp = ai && ai.account_data ? Number(ai.account_data.Balance) / 1e6 : null;
  const same = (c: string) => String(c).toUpperCase() === t.cur.toUpperCase();
  const l = ((al && al.lines) || []).find((z: any) => same(z.currency));
  X.hasLine = !!l; X.bal = l ? Number(l.balance) : 0;
  X.offers = ((ao && ao.offers) || []).filter((o: any) => [o.taker_gets, o.taker_pays].some((x: any) => x && typeof x === 'object' && x.issuer === t.iss && same(x.currency)));
}
// price history: the book's mid price at evenly spaced past ledgers (a ledger closes every ~3.8 s), joined into candles
async function loadCandles(force = false) {
  const t: Tok | null = X.sel; if (!t) return; const g = X.gen, r = rng(), key = t.cur + t.iss + r.k + ctx.netKey();
  const hit = CC.get(key);
  if (hit && !force && Date.now() - hit.at < 60000) { X.cd = hit; X.cdKey = key; renderChart(); renderHead(); renderTok(); return; }
  X.cd = null; X.cdKey = ''; renderChart();
  try {
    const lr: any = await ctx.req('ledger', { ledger_index: 'validated' });
    const seq = Number(lr && lr.ledger && lr.ledger.ledger_index); if (!seq) throw new Error('no ledger');
    const n = Math.min(r.candles, 40), per = 3.8, pts: (number | null)[] = new Array(n + 1).fill(null);
    const jobs = pts.map((_, k) => async () => {
      const s = Math.max(1, Math.round(seq - (r.sec / per) * ((n - k) / n)));
      const [a, b] = await Promise.all([
        ctx.req('book_offers', { taker_gets: issue(t), taker_pays: { currency: 'XRP' }, limit: 1, ledger_index: s }).catch(() => null),
        ctx.req('book_offers', { taker_gets: { currency: 'XRP' }, taker_pays: issue(t), limit: 1, ledger_index: s }).catch(() => null),
      ]);
      const pa = bookPx(a, true), pb = bookPx(b, false);
      pts[k] = pa != null && pb != null ? (pa + pb) / 2 : pa ?? pb;
    });
    let ix = 0; await Promise.all(new Array(8).fill(0).map(async () => { while (ix < jobs.length) { const j = jobs[ix++]; await j(); if (g !== X.gen) return; } }));
    if (g !== X.gen) return;
    const live = mid(); if (live != null) pts[n] = live;
    let lastv: number | null = null; for (let k = 0; k <= n; k++) { if (pts[k] == null) pts[k] = lastv; else lastv = pts[k]; }
    let nxt: number | null = null; for (let k = n; k >= 0; k--) { if (pts[k] == null) pts[k] = nxt; else nxt = pts[k]; }
    const have = pts.filter(v => v != null).length;
    const now = Date.now(), list: M.Candle[] = [];
    if (have >= 2) for (let k = 0; k < n; k++) { const o = pts[k] as number, c = pts[k + 1] as number; list.push({ t: now - r.sec * 1000 * ((n - k) / n), o, h: Math.max(o, c), l: Math.min(o, c), c, flow: 0 }); }
    const note = list.length ? 'Price history = order-book mid price at past ledgers.' : 'No order-book history for this token in this range.';
    const rec = { at: Date.now(), list, note }; CC.set(key, rec); X.cd = rec; X.cdKey = key;
  } catch (e: any) { X.cd = { at: Date.now(), list: [], note: 'Could not read price history: ' + String(e?.message || e) + ' Tap a range to retry.' }; }
  renderChart(); renderHead(); renderTok();
}

/* ---------- rendering (same layout and classes as the LUMA DEX) ---------- */
function renderHead() {
  const t: Tok | null = X.sel; if (!t) return setH('dx_head', `<span class="mut">Loading markets…</span>`);
  const cur = document.querySelector('#dx_head .dxsel'); if (cur && document.activeElement === cur) return;
  const p = mid(), cl = X.cd ? X.cd.list : [], d24 = t.ch['24h'] != null ? t.ch['24h'] : cl.length > 1 && X.range === '1d' ? (cl[cl.length - 1].c / cl[0].o - 1) * 100 : null;
  const opts = X.toks.map((x: Tok, i: number) => `<option value="${i}" ${x === t ? 'selected' : ''}>${esc(x.name)}/XRP</option>`).join('');
  setH('dx_head', `<select class="dxsel" onchange="window.xd.pick(Number(this.value))">${opts}</select>
    <div class="dxprice"><span class="mono">${p == null ? '–' : fmt(p)}</span> <small>XRP</small>${t.usd != null ? ` <small class="mut">≈ ${usd(t.usd)}</small>` : ''}</div>
    ${d24 != null ? `<div>${pctHtml(d24)}<small class="mut"> 24h</small></div>` : ''}
    <div style="flex:1"></div><span class="mut dxnote">${X.cd && X.cd.note ? esc(X.cd.note) : ''}</span>`);
}
function renderTools() {
  const seg = (arr: [string, string][], cur: string, fn: string) => `<div class="seg">${arr.map(([k, l]) => `<button class="${cur === k ? 'on' : ''}" onclick="window.xd.${fn}('${k}')">${l}</button>`).join('')}</div>`;
  setH('dx_tools', `${seg(RK.map(k => [k, k] as [string, string]), X.range, 'setRange')}<div style="flex:1"></div>
    ${seg([['pct', '%'], ['log', 'log'], ['auto', 'auto']], X.scale, 'setScale')}
    ${seg([['candle', 'Candles'], ['hollow', 'Hollow'], ['ohlc', 'Bars'], ['line', 'Line'], ['step', 'Step'], ['area', 'Area']], X.style, 'setStyle')}
    <div class="seg"><button class="${X.sma ? 'on' : ''}" onclick="window.xd.ind('sma')">MA</button><button class="${X.ema ? 'on' : ''}" onclick="window.xd.ind('ema')">EMA</button><button class="${X.boll ? 'on' : ''}" onclick="window.xd.ind('boll')">BB</button></div>`);
}
function renderChart() {
  const el = $('dx_chart'); if (!el) return;
  if (!X.cd) { el.innerHTML = '<div class="mut" style="padding:3rem 0;text-align:center">Reading price history from the ledger…</div>'; (el as any).__h = null; return; }
  if (X.cd.list.length < 2) { el.innerHTML = `<div class="mut" style="padding:3rem 0;text-align:center">${esc(X.cd.note)}</div>`; (el as any).__h = null; setH('dx_ohlc', '&nbsp;'); return; }
  const { svg } = chartSvg(X.cd.list, { scale: X.scale, sma: X.sma, style: X.style, ema: X.ema, boll: X.boll, rangeSec: rng().sec, lines: [], volUnit: 'XRP', h: Math.max(260, Math.min(760, Math.round((el.clientHeight / Math.max(1, el.clientWidth)) * 1000))) } as any, mid());
  if ((el as any).__h !== svg) { el.innerHTML = svg; (el as any).__h = svg; }
  const c = X.cd.list[X.cd.list.length - 1], ch = (c.c / c.o - 1) * 100;
  setH('dx_ohlc', `${esc(X.sel ? X.sel.name : '')}/XRP · ${esc(X.range)} · <span class="mut">${new Date(c.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span> &nbsp; O <b>${fmt(c.o)}</b> H <b>${fmt(c.h)}</b> L <b>${fmt(c.l)}</b> C <b>${fmt(c.c)}</b> ${pctHtml(ch)}`);
}
function renderTok() {
  const t: Tok | null = X.sel; if (!t) return setH('dx_tok', '');
  const rank = X.toks.indexOf(t) + 1, p = mid(), cl: M.Candle[] = X.cd ? X.cd.list : [];
  const chg = (k: string, l: string) => { const v = t.ch[k]; return `<div class="dxc2 ${v == null ? '' : v >= 0 ? 'up' : 'dn'}"><div class="k">${l}</div><div class="dxc2v">${v == null ? '<span class="mut">–</span>' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'}</div></div>`; };
  const tile = (k: string, v: string, sub = '') => `<div class="dxt2"><div class="k">${k}</div><div class="dxt2v">${v}</div><div class="dxt2s">${sub || '&nbsp;'}</div></div>`;
  const lo = cl.length ? Math.min(...cl.map(x => x.l)) : null, hi = cl.length ? Math.max(...cl.map(x => x.h)) : null;
  const pos = lo != null && hi != null && hi > lo && p != null ? Math.min(100, Math.max(0, ((p - lo) / (hi - lo)) * 100)) : 50;
  const ch24 = t.ch['24h'] != null ? t.ch['24h'] : null, up = ch24 == null ? true : ch24 >= 0;
  const spark = (() => { const pts = cl.slice(-60).map(x => x.c).filter(v => isFinite(v)); if (pts.length < 3) return ''; const mn = Math.min(...pts), mx = Math.max(...pts), W = 300, H = 46, sx = W / (pts.length - 1), sy = (v: number) => H - 3 - ((v - mn) / (mx - mn || 1)) * (H - 8); const line = pts.map((v, k) => (k ? 'L' : 'M') + (k * sx).toFixed(1) + ' ' + sy(v).toFixed(1)).join(' '); const col = pts[pts.length - 1] >= pts[0] ? '#34f5a4' : '#ff5c6c'; return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:46px;display:block;margin:.4rem 0"><path d="${line}" fill="none" stroke="${col}" stroke-width="1.6"/></svg>`; })();
  setH('dx_tok', `<div class="dxtokh"><div class="dxav2">${tkLetters(t.name)}</div><div style="min-width:0"><div class="row" style="gap:.4rem;align-items:center;flex-wrap:nowrap"><b style="font-size:1.2rem;white-space:nowrap">${esc(t.name)}</b>${rank ? `<span class="tag">#${rank}</span>` : ''}</div><div class="mut" style="font-size:.78rem">${esc(short(t.iss, 6, 5))}</div></div>
      <div style="margin-left:auto;text-align:right;min-width:0"><div class="mono dxpx"><small class="mut">XRP</small> ${p == null ? '–' : fmt(p)}</div><div class="dxsub"><span class="dxpill ${up ? 'up' : 'dn'}">${ch24 == null ? '–' : (up ? '▲ ' : '▼ ') + Math.abs(ch24).toFixed(2) + '%'}</span> <span class="mut">${t.usd != null ? '≈ ' + usd(t.usd) : ''}</span></div></div></div>
    ${spark}
    <div class="dxtiles">${tile('Market cap', t.mcap != null ? '$' + cf(t.mcap) : '–')}${tile('Volume 24h', t.vol != null ? cf(t.vol) + ' <small class="mut">XRP</small>' : '–', t.vol != null && xrpUsd() != null ? '$' + cf(t.vol * (xrpUsd() as number)) : '')}${tile('Order book', ask() != null ? fmt(ask()) : '–', bid() != null ? 'bid ' + fmt(bid()) : '')}${tile('Holders', t.holders != null ? fmt(t.holders) : '–')}</div>
    <div class="dxchgs">${chg('5m', '5M')}${chg('1h', '1H')}${chg('24h', '24H')}${chg('7d', '7D')}</div>
    <div class="dxrange"><span class="mono">${lo != null ? fmt(lo) : ''}</span><div class="dxrbar"><i style="left:${pos}%"></i></div><span class="mono">${hi != null ? fmt(hi) : ''}</span></div>
    <div class="mut" style="font-size:.72rem;text-align:center">${esc(X.range)} range</div>`);
}
function renderInfo() {
  const t: Tok | null = X.sel; if (!t) return setH('dx_info', '');
  const a = ask(), b = bid();
  setH('dx_info', `<div class="k">MARKET</div><div class="mut" style="font-size:.82rem;line-height:1.7">
    <div class="row" style="justify-content:space-between"><span>Issuer</span><span class="mono">${esc(short(t.iss, 8, 6))}</span></div>
    <div class="row" style="justify-content:space-between"><span>Best bid / ask</span><span class="mono">${b != null ? fmt(b) : '–'} / ${a != null ? fmt(a) : '–'}</span></div>
    <div class="row" style="justify-content:space-between"><span>Spread</span><span class="mono">${a != null && b != null ? ((a / b - 1) * 100).toFixed(2) + '%' : '–'}</span></div>
    <div class="row" style="justify-content:space-between"><span>Trading</span><span>Spot · XRPL order book + AMM</span></div></div>
    <div class="mut" style="font-size:.72rem;margin-top:.5rem">Top ${X.toks.length} XRPL tokens by 24h volume · ranking from <a href="https://xrpl.to" target="_blank" rel="noopener">xrpl.to</a> (${esc(X.src)})${isMain() ? '' : ' · You are on the XRPL Testnet, which has almost no trading. Switch the XRPL network to Mainnet to trade these.'}</div>`);
}
function renderTabs() {
  setH('dx_tabs', ([['book', 'Order book'], ['orders', 'Orders'], ['top', 'Top 50']] as [string, string][]).map(([k, l]) => `<button class="${X.tab === k ? 'on' : ''}" onclick="window.xd.tab('${k}')">${l}</button>`).join(''));
}
function renderTable() {
  renderTabs(); const t: Tok | null = X.sel; if (!t) return setH('dx_table', '');
  if (X.tab === 'book') {
    const rows = (arr: any[], cls: string) => arr.slice(0, 12).map(o => `<tr class="clk" onclick="window.xd.setPx(${o.px})"><td class="mono ${cls}">${fmt(o.px, 6)}</td><td class="r">${fmt(o.sz, 4)}</td><td class="r mut">${fmt(o.sz * o.px, 4)} XRP</td></tr>`).join('') || '<tr><td colspan="3" class="mut">empty</td></tr>';
    setH('dx_table', `<div class="row" style="gap:1rem;flex-wrap:wrap"><div style="flex:1;min-width:16rem"><div class="mut" style="font-size:.75rem">Sellers (asks) · XRP per ${esc(t.name)}</div><table class="dxt"><thead><tr><th>Price</th><th class="r">${esc(t.name)}</th><th class="r">Total</th></tr></thead><tbody>${rows(X.book.asks, 'dn')}</tbody></table></div>
      <div style="flex:1;min-width:16rem"><div class="mut" style="font-size:.75rem">Buyers (bids)</div><table class="dxt"><thead><tr><th>Price</th><th class="r">${esc(t.name)}</th><th class="r">Total</th></tr></thead><tbody>${rows(X.book.bids, 'up')}</tbody></table></div></div>`);
  } else if (X.tab === 'orders') {
    const rows = (X.offers as any[]).map(o => { const sellTok = typeof o.taker_gets === 'object'; const tok = sellTok ? o.taker_gets : o.taker_pays, xr = sellTok ? o.taker_pays : o.taker_gets; const n = Number(tok.value), x = Number(xr) / 1e6; return `<tr><td>${sellTok ? '<b class="dn">SELL</b>' : '<b class="up">BUY</b>'}</td><td class="r">${fmt(n, 4)} ${esc(t.name)}</td><td class="r mono">${fmt(x / n, 6)} XRP</td><td class="r"><button class="sm ghost" onclick="window.xd.cancel(${o.seq})">Cancel</button></td></tr>`; }).join('');
    setH('dx_table', ctx.account() ? `<table class="dxt"><thead><tr><th>Side</th><th class="r">Amount</th><th class="r">Price</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="mut" style="padding:1rem">No open orders for this token.</td></tr>'}</tbody></table>` : '<div class="mut" style="padding:1rem">No XRPL wallet selected.</div>');
  } else {
    const q = X.q.trim().toLowerCase();
    const rows = X.toks.map((x: Tok, i: number) => ({ x, i })).filter((r: any) => !q || r.x.name.toLowerCase().includes(q) || r.x.iss.toLowerCase().startsWith(q)).map((r: any) => `<tr class="clk" onclick="window.xd.pick(${r.i})"><td class="mut">${r.i + 1}</td><td><b>${esc(r.x.name)}</b> <span class="mut" style="font-size:.75rem">${esc(short(r.x.iss, 5, 4))}</span></td><td class="r">${r.x.usd != null ? usd(r.x.usd) : '–'}</td><td class="r">${r.x.vol != null ? cf(r.x.vol) + ' XRP' : '–'}</td><td class="r">${r.x.ch['24h'] != null ? pctHtml(r.x.ch['24h']) : '–'}</td></tr>`).join('');
    setH('dx_table', `<div class="dxfilters"><input placeholder="Search token or issuer…" value="${esc(X.q)}" oninput="window.xd.q(this.value)" style="width:16rem"></div><table class="dxt"><thead><tr><th>#</th><th>Token</th><th class="r">Price</th><th class="r">24h volume</th><th class="r">24h</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="mut" style="padding:1rem">No token matches.</td></tr>'}</tbody></table>`);
  }
}
// walk the book: what you get for spending `x` (buy: XRP in, tokens out) or selling `x` tokens (XRP out)
function walk(x: number) {
  const buy = X.side === 'buy', lv: any[] = buy ? X.book.asks : X.book.bids; let left = x, out = 0;
  for (const o of lv) { if (left <= 0) break; if (buy) { const spend = Math.min(left, o.sz * o.px); out += spend / o.px; left -= spend; } else { const sell = Math.min(left, o.sz); out += sell * o.px; left -= sell; } }
  return { out, filled: left <= 1e-12 };
}
function renderTrade() {
  const t: Tok | null = X.sel; if (!t) return setH('dx_trade', '');
  const ae: any = document.activeElement; if (ae && ['xd_amt', 'xd_px'].includes(ae.id)) { refreshBal(); return; }
  const buy = X.side === 'buy', acc = ctx.account(), pay = buy ? 'XRP' : t.name, get = buy ? t.name : 'XRP', need = buy && !!acc && !X.hasLine;
  const lbl = !acc ? 'Connect a wallet' : need ? `Enable ${t.name} first` : `${buy ? 'Buy' : 'Sell'} ${t.name}`;
  setH('dx_trade', `<div class="dxmode"><button class="on">Spot</button></div>
    <div class="dxbs"><button class="${buy ? 'on buy' : ''}" onclick="window.xd.side('buy')">BUY</button><button class="${!buy ? 'on sell' : ''}" onclick="window.xd.side('sell')">SELL</button>
      <div class="dxmt"><button class="${X.type === 'market' ? 'on' : ''}" onclick="window.xd.type('market')">MARKET</button><button class="${X.type === 'limit' ? 'on' : ''}" onclick="window.xd.type('limit')">LIMIT</button></div></div>
    ${X.type === 'limit' ? `<div class="dxbox"><div class="k">LIMIT PRICE (XRP per ${esc(t.name)})</div><div class="dxin"><input id="xd_px" inputmode="decimal" placeholder="${mid() != null ? fmt(mid(), 8) : '0.0'}" value="${esc(X.price)}" oninput="window.xd.onPx(this.value)"></div></div>` : ''}
    <div class="dxbox"><div class="k">YOU PAY <span class="mut" style="float:right;text-transform:none" id="xd_bal">Balance ${acc ? fmt(buy ? X.xrp : X.bal) : '–'} <a href="#" onclick="window.xd.max();return false">MAX</a></span></div>
      <div class="dxin"><span class="dxchip">${tkLetters(pay)}</span><b>${esc(pay)}</b><input id="xd_amt" inputmode="decimal" placeholder="0.00" value="${esc(X.amt)}" oninput="window.xd.onAmt(this.value)"></div></div>
    <div class="dxflip"><button onclick="window.xd.side('${buy ? 'sell' : 'buy'}')" title="Switch direction">⇅</button></div>
    <div class="dxbox"><div class="k">YOU RECEIVE</div><div class="dxin"><span class="dxchip">${tkLetters(get)}</span><b>${esc(get)}</b><span class="dxout mono" id="xd_out">0.00</span></div><div class="mut" id="xd_rate" style="font-size:.78rem;margin-top:.3rem">&nbsp;</div></div>
    <div class="dxgrid3"><div class="dxs"><div class="k">IMPACT</div><div id="xd_imp">–</div></div><div class="dxs"><div class="k">FEE</div><div>book</div></div><div class="dxs"><div class="k">SLIPPAGE</div><div>${X.type === 'market' ? '3%' : '–'}</div></div></div>
    <button class="pri ${buy ? 'acc' : ''} dxgo ${buy ? '' : 'sellgo'}" onclick="window.xd.go(this)" ${X.busy ? 'disabled' : ''}>${esc(lbl)}</button>
    <div class="mut" id="xd_msg" style="font-size:.78rem;margin-top:.4rem;color:${X.bad ? 'var(--crit)' : 'var(--ok)'}">${esc(X.msg)}</div>`);
  quote();
}
function refreshBal() { const e = $('xd_bal'); if (e) e.innerHTML = `Balance ${ctx.account() ? fmt(X.side === 'buy' ? X.xrp : X.bal) : '–'} <a href="#" onclick="window.xd.max();return false">MAX</a>`; }
function quote() {
  const t: Tok | null = X.sel, out = $('xd_out'); if (!t || !out) return;
  const x = num(X.amt), buy = X.side === 'buy';
  if (!x || x <= 0) { out.textContent = '0.00'; setH('xd_rate', '&nbsp;'); setH('xd_imp', '–'); return; }
  if (X.type === 'limit') { const p = num(X.price); const rec = p && p > 0 ? (buy ? x / p : x * p) : 0; out.textContent = rec > 0 ? fmt(rec, 8) : '0.00'; setH('xd_rate', p && p > 0 ? `Order rests on the book at ${fmt(p)} XRP per ${esc(t.name)}` : 'Enter a limit price'); setH('xd_imp', '–'); return; }
  const w = walk(x), best = buy ? ask() : bid();
  if (!w.out || best == null) { out.textContent = '0.00'; setH('xd_rate', '<span class="dn">No liquidity on the order book.</span>'); setH('xd_imp', '–'); return; }
  out.textContent = fmt(w.out, 8);
  const avg = buy ? x / w.out : w.out / x, imp = Math.abs(avg / best - 1) * 100;
  setH('xd_rate', `${buy ? 'avg ' + fmt(avg) + ' XRP per ' + esc(t.name) : 'avg ' + fmt(avg) + ' XRP per ' + esc(t.name)}${w.filled ? '' : ' · book too thin for this size'}`);
  setH('xd_imp', `<span class="${imp > 1 ? 'dn' : ''}">${imp.toFixed(2)}%</span>`);
}
function renderAll() { renderHead(); renderTools(); renderChart(); renderTok(); renderInfo(); renderTrade(); renderTable(); }

export function shell() {
  return `<div class="dx" id="xdx">
    <div class="dxmain">
      <div class="card dxchart">
        <div class="dxbar" id="dx_head"></div>
        <div class="dxbar dxtools" id="dx_tools"></div>
        <div class="dxohlc mono" id="dx_ohlc">&nbsp;</div>
        <div id="dx_chart" class="dxcw"><div class="mut" style="padding:3rem 0;text-align:center">Loading the top 50 XRPL tokens by volume…</div></div>
      </div>
      <div class="card dxbelow" style="margin-top:.8rem">
        <div class="dxtabs" id="dx_tabs"></div>
        <div id="dx_table" style="overflow:auto"></div>
      </div>
    </div>
    <div class="dxside">
      <div class="card" id="dx_tok"></div>
      <div class="card" id="dx_trade"></div>
      <div class="card" id="dx_info"></div>
    </div>
  </div>`;
}
async function refresh() {
  if (!$('xdx')) return;
  await Promise.all([loadBook(), loadAcct()]);
  renderHead(); renderTok(); renderInfo(); renderTable(); refreshBal(); quote();
  const ae = document.activeElement as HTMLElement | null;
  if (!(ae && ae.closest && ae.closest('#dx_trade'))) renderTrade();
}
export async function mount() {
  if (!$('xdx')) return; unmount();
  if (!X.toks.length) await loadTop();
  if (!X.sel && X.toks.length) { X.sel = X.toks[0]; X.gen++; }
  renderAll();
  await refresh();
  void loadCandles();
  timer = setInterval(() => { if (!document.hidden) void refresh(); }, 10000);
}
export function unmount() { if (timer) { clearInterval(timer); timer = 0; } }

export const xd = {
  q(v: string) { X.q = v; renderTable(); },
  async pick(i: number) { X.sel = X.toks[i]; X.gen++; X.book = { asks: [], bids: [] }; X.cd = null; X.amt = ''; X.price = ''; X.msg = ''; renderAll(); await refresh(); void loadCandles(); },
  setRange(k: string) { X.range = k; renderTools(); void loadCandles(); },
  setScale(k: string) { X.scale = k; renderTools(); renderChart(); },
  setStyle(k: string) { X.style = k; renderTools(); renderChart(); },
  ind(k: string) { X[k] = !X[k]; renderTools(); renderChart(); },
  tab(k: string) { X.tab = k; renderTable(); },
  side(s: string) { X.side = s; X.amt = ''; X.msg = ''; renderTrade(); },
  type(s: string) { X.type = s; renderTrade(); },
  onAmt(v: string) { X.amt = v; quote(); },
  onPx(v: string) { X.price = v; quote(); },
  max() { const b = X.side === 'buy' ? (X.xrp == null ? 0 : Math.max(0, X.xrp - 1.5)) : X.bal; X.amt = b > 0 ? decN(b) : ''; const e = $('xd_amt') as HTMLInputElement | null; if (e) e.value = X.amt; quote(); },
  setPx(p: number) { X.type = 'limit'; X.price = decN(p); renderTrade(); },
  async cancel(seq: number) {
    const r = await ctx.submit({ TransactionType: 'OfferCancel', Account: ctx.account(), OfferSequence: seq });
    ctx.toast(r.ok ? '✓ Order cancelled' : 'Could not cancel: ' + (r.msg || 'failed'), !r.ok); await refresh();
  },
  async go(btn: HTMLButtonElement) {
    const t: Tok | null = X.sel; if (!t) return; if (!ctx.account()) { ctx.toast('Select an XRPL wallet first.', true); return; }
    const buy = X.side === 'buy';
    if (buy && !X.hasLine) {
      btn.disabled = true;
      const r = await ctx.submit({ TransactionType: 'TrustSet', Account: ctx.account(), LimitAmount: { currency: t.cur, issuer: t.iss, value: '1000000000' } });
      if (r.ok) { ctx.toast('✓ ' + t.name + ' enabled for this wallet (reserves 0.2 XRP)'); await refresh(); renderTrade(); } else { ctx.toast('Rejected: ' + (r.msg || 'failed'), true); btn.disabled = false; }
      return;
    }
    const x = num(X.amt); if (!x || x <= 0) { ctx.toast('Enter an amount.', true); return; }
    let tokAmt: number, xrp: number, flags = 0;
    if (X.type === 'limit') { const p = num(X.price); if (!p || p <= 0) { ctx.toast('Enter a limit price.', true); return; } tokAmt = buy ? x / p : x; xrp = buy ? x : x * p; }
    else { const b = buy ? ask() : bid(); if (b == null) { ctx.toast('No liquidity on the order book.', true); return; } const px = buy ? b * 1.03 : b * 0.97; tokAmt = buy ? x / px : x; xrp = buy ? x : x * px; flags = 0x00020000; }
    const drops = Math.round(xrp * 1e6); if (drops < 1) { ctx.toast('That is below the smallest XRP amount.', true); return; }
    const tk = { currency: t.cur, issuer: t.iss, value: decN(tokAmt) };
    const tx: any = { TransactionType: 'OfferCreate', Account: ctx.account(), TakerPays: buy ? tk : String(drops), TakerGets: buy ? String(drops) : tk };
    if (flags) tx.Flags = flags;
    X.busy = true; btn.disabled = true;
    const r = await ctx.submit(tx); X.busy = false;
    if (r.ok) { X.msg = `${buy ? 'Buy' : 'Sell'} order sent.`; X.bad = false; X.amt = ''; ctx.toast(`✓ ${buy ? 'Buy' : 'Sell'} order sent`); await refresh(); renderTrade(); }
    else { X.msg = 'Order rejected: ' + (r.msg || 'failed'); X.bad = true; ctx.toast(X.msg, true); btn.disabled = false; renderTrade(); }
  },
};
(window as any).xd = xd;
