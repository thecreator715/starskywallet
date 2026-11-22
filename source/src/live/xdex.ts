// XRPL DEX: the 50 tokens with the most trading volume on the XRP Ledger, each traded against XRP on the ledger's own order book
// (offers also cross the AMM pools automatically). Used while the XRPL wallet tab is active. Everything is read from, and sent to, the XRPL node.
import { ctx } from './ctx.ts';
import { esc, fmt, usd, hexName, short, amtNum, decN, tkLetters } from './util.ts';

interface Tok { cur: string; iss: string; name: string; usd: number | null; vol: number | null; holders: number | null }
const API = 'https://api.xrpl.to/v1/tokens?sort=vol24hxrp&order=desc&limit=60';
const CK = 'starsky.xdx.top2', TTL = 10 * 60000;
// last resort when the ranking service cannot be reached and nothing is cached: the best-known XRPL issuers
const FALLBACK: Tok[] = [
  { cur: '524C555344000000000000000000000000000000', iss: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', name: 'RLUSD', usd: null, vol: null, holders: null },
  { cur: 'USD', iss: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', name: 'USD (Bitstamp)', usd: null, vol: null, holders: null },
  { cur: '534F4C4F00000000000000000000000000000000', iss: 'rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz', name: 'SOLO', usd: null, vol: null, holders: null },
  { cur: '434F524500000000000000000000000000000000', iss: 'rcoreNywaoz2ZCQ8Lg2EbSLnGuRBmun6D', name: 'CORE', usd: null, vol: null, holders: null },
];
const X: any = { toks: [] as Tok[], src: '', at: 0, q: '', sel: null as Tok | null, side: 'buy', inst: true, book: { asks: [], bids: [] }, xrp: null, bal: null, hasLine: false, offers: [], busy: false, err: '', gen: 0 };
let timer: any = 0;
const $ = (id: string) => document.getElementById(id);
const setH = (id: string, h: string) => { const e: any = $(id); if (e && e.__h !== h) { e.innerHTML = h; e.__h = h; } };
const num = (v: any) => { const n = Number(v); return isFinite(n) ? n : null; };
const issue = (t: Tok) => ({ currency: t.cur, issuer: t.iss });
const isMain = () => ctx.netKey() !== 'test';

async function loadTop(force = false) {
  let cached: any = null; try { cached = JSON.parse(localStorage.getItem(CK) || 'null'); } catch {}
  if (cached && !force && Date.now() - cached.at < TTL && cached.list && cached.list.length) { X.toks = cached.list; X.src = 'xrpl.to'; X.at = cached.at; return; }
  try {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 9000);
    const r = await fetch(API, { signal: ac.signal }); clearTimeout(to);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j: any = await r.json();
    const arr: any[] = Array.isArray(j) ? j : j.tokens || j.data || j.results || [];
    const list: Tok[] = arr.map(t => ({ cur: String(t.currency || ''), iss: String(t.issuer || ''), name: String(t.name || t.user || '') || hexName(String(t.currency || '')), usd: num(t.usd), vol: num(t.vol24hxrp), holders: num(t.holders) }))
      .filter(t => t.cur && t.iss && t.cur !== 'XRP').slice(0, 50);
    if (!list.length) throw new Error('empty list');
    X.toks = list; X.src = 'xrpl.to'; X.at = Date.now();
    try { localStorage.setItem(CK, JSON.stringify({ at: X.at, list })); } catch {}
  } catch {
    if (cached && cached.list && cached.list.length) { X.toks = cached.list; X.src = 'saved copy'; X.at = cached.at; }
    else { X.toks = FALLBACK; X.src = 'built-in list (ranking service unreachable)'; X.at = Date.now(); }
  }
}

async function loadBook() {
  const t: Tok | null = X.sel; if (!t) return; const g = X.gen;
  const [a, b] = await Promise.all([
    ctx.req('book_offers', { taker_gets: issue(t), taker_pays: { currency: 'XRP' }, limit: 14, ledger_index: 'validated' }).catch(() => null),
    ctx.req('book_offers', { taker_gets: { currency: 'XRP' }, taker_pays: issue(t), limit: 14, ledger_index: 'validated' }).catch(() => null),
  ]);
  if (g !== X.gen) return;
  // asks: sellers give tokens, want XRP. bids: buyers give XRP, want tokens. price = XRP per token
  X.book.asks = ((a && a.offers) || []).map((o: any) => { const sz = amtNum(o.taker_gets_funded ?? o.TakerGets), px = amtNum(o.TakerPays) / amtNum(o.TakerGets); return { px, sz }; }).filter((o: any) => o.sz > 0 && isFinite(o.px)).sort((x: any, y: any) => x.px - y.px);
  X.book.bids = ((b && b.offers) || []).map((o: any) => { const sz = amtNum(o.taker_pays_funded ?? o.TakerPays), px = amtNum(o.TakerGets) / amtNum(o.TakerPays); return { px, sz }; }).filter((o: any) => o.sz > 0 && isFinite(o.px)).sort((x: any, y: any) => y.px - x.px);
}
async function loadAcct() {
  const acc = ctx.account(), t: Tok | null = X.sel; if (!acc || !t) { X.xrp = null; X.bal = null; X.hasLine = false; X.offers = []; return; }
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

const row = (t: Tok, i: number) => `<tr class="clk ${X.sel && X.sel.cur === t.cur && X.sel.iss === t.iss ? 'xd_on' : ''}" onclick="window.xd.pick(${i})"><td class="mut">${i + 1}</td><td><span class="xd_av">${esc(tkLetters(t.name))}</span><b>${esc(t.name)}</b><div class="mut" style="font-size:.72rem">${esc(short(t.iss, 6, 4))}</div></td><td class="r">${t.usd != null ? usd(t.usd) : '–'}</td><td class="r">${t.vol != null ? fmt(t.vol, 0) + ' XRP' : '–'}</td></tr>`;
function renderList() {
  const q = X.q.trim().toLowerCase();
  const rows = X.toks.map((t: Tok, i: number) => ({ t, i })).filter((x: any) => !q || x.t.name.toLowerCase().includes(q) || x.t.iss.toLowerCase().startsWith(q) || x.t.cur.toLowerCase().includes(q)).map((x: any) => row(x.t, x.i)).join('');
  setH('xd_list', `<table class="dxt"><thead><tr><th>#</th><th>Token</th><th class="r">Price</th><th class="r">24h volume</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="mut" style="padding:1rem">No token matches.</td></tr>'}</tbody></table>`);
  setH('xd_src', `Top ${X.toks.length} XRPL tokens by 24h trading volume · ranking from <a href="https://xrpl.to" target="_blank" rel="noopener">xrpl.to</a> (${esc(X.src)}) · trades go straight to the XRP Ledger order book`);
}
const bestAsk = () => (X.book.asks[0] ? X.book.asks[0].px : null), bestBid = () => (X.book.bids[0] ? X.book.bids[0].px : null);
function renderBook() {
  const t: Tok | null = X.sel; if (!t) { setH('xd_book', ''); return; }
  const a = bestAsk(), b = bestBid(), mid = a != null && b != null ? (a + b) / 2 : a ?? b;
  const side = (arr: any[], cls: string) => arr.slice(0, 8).map((o: any) => `<tr class="clk" onclick="window.xd.setPx(${o.px})"><td class="mono ${cls}">${fmt(o.px, 6)}</td><td class="r">${fmt(o.sz, 4)}</td></tr>`).join('') || '<tr><td colspan="2" class="mut">empty</td></tr>';
  setH('xd_book', `<div class="row" style="gap:1rem;flex-wrap:wrap;align-items:baseline"><div class="k" style="font-size:1.1rem">${esc(t.name)} / XRP</div><div class="mono" style="font-size:1.2rem">${mid != null ? fmt(mid, 6) + ' XRP' : 'no offers yet'}</div>${t.usd != null ? `<div class="mut">${usd(t.usd)}</div>` : ''}</div>
    <div class="xd_bk"><div><div class="mut" style="font-size:.75rem">Sellers (asks) · XRP per ${esc(t.name)}</div><table class="dxt"><tbody>${side(X.book.asks, 'crit')}</tbody></table></div><div><div class="mut" style="font-size:.75rem">Buyers (bids)</div><table class="dxt"><tbody>${side(X.book.bids, 'ok')}</tbody></table></div></div>`);
}
function renderTkt() {
  const t: Tok | null = X.sel; if (!t) { setH('xd_tkt', '<div class="mut" style="padding:1rem">Pick a token from the list to trade it against XRP.</div>'); return; }
  const acc = ctx.account();
  if (!acc) { setH('xd_tkt', '<div class="mut" style="padding:1rem">No XRPL wallet selected. Wallets → XRPL → add or import one.</div>'); return; }
  const buy = X.side === 'buy', ask = bestAsk(), bid = bestBid(), px0 = buy ? ask : bid;
  const need = buy && !X.hasLine;
  setH('xd_tkt', `<div class="row" style="gap:.4rem"><button class="sm grow ${buy ? 'pri acc' : ''}" onclick="window.xd.side('buy')">Buy ${esc(t.name)}</button><button class="sm grow ${!buy ? 'pri acc' : ''}" onclick="window.xd.side('sell')">Sell ${esc(t.name)}</button></div>
    <div class="mut" style="font-size:.8rem;margin:.5rem 0">Balance: ${X.xrp == null ? 'wallet not activated (needs 1 XRP reserve)' : fmt(X.xrp, 4) + ' XRP'} · ${fmt(X.bal || 0, 4)} ${esc(t.name)}</div>
    ${need ? `<div class="card" style="margin:.4rem 0"><div style="margin-bottom:.4rem">To hold ${esc(t.name)} this wallet needs a trust line (reserves 0.2 XRP, returned if removed).</div><button class="pri acc" onclick="window.xd.trust(this)">Add trust line</button></div>` : ''}
    <label class="mut" style="font-size:.8rem">Amount (${esc(t.name)})<input id="xd_amt" class="grow" inputmode="decimal" placeholder="0.0" oninput="window.xd.est()"></label>
    <label class="mut" style="font-size:.8rem;display:block;margin-top:.4rem">Price (XRP per ${esc(t.name)})<input id="xd_px" class="grow" inputmode="decimal" value="${px0 != null ? decN(px0) : ''}" placeholder="0.0" oninput="window.xd.est()"></label>
    <label style="display:flex;gap:.5rem;align-items:center;margin:.5rem 0;font-size:.85rem"><input type="checkbox" id="xd_inst" ${X.inst ? 'checked' : ''} onchange="window.xd.inst(this.checked)"> Fill now at the best available price (otherwise it rests on the order book)</label>
    <div id="xd_est" class="mut" style="min-height:1.3rem;font-size:.85rem"></div>
    <button class="pri acc grow" ${X.busy || need ? 'disabled' : ''} onclick="window.xd.go(this)">${buy ? 'Buy' : 'Sell'} ${esc(t.name)}</button>`);
  est();
}
function renderOrders() {
  const t: Tok | null = X.sel; if (!t || !ctx.account()) { setH('xd_orders', ''); return; }
  const rows = (X.offers as any[]).map(o => { const sellTok = typeof o.taker_gets === 'object'; const tok = sellTok ? o.taker_gets : o.taker_pays, xr = sellTok ? o.taker_pays : o.taker_gets; const n = Number(tok.value), x = Number(xr) / 1e6; return `<tr><td>${sellTok ? 'Sell' : 'Buy'}</td><td class="r">${fmt(n, 4)}</td><td class="r">${fmt(x / n, 6)}</td><td class="r"><button class="sm ghost" onclick="window.xd.cancel(${o.seq})">Cancel</button></td></tr>`; }).join('');
  setH('xd_orders', rows ? `<div class="k" style="margin-top:1rem">Your open ${esc(t.name)} orders</div><table class="dxt"><thead><tr><th>Side</th><th class="r">Amount</th><th class="r">Price</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '');
}
function est() {
  const t: Tok | null = X.sel; if (!t) return;
  const a = num(($('xd_amt') as HTMLInputElement | null)?.value), p = num(($('xd_px') as HTMLInputElement | null)?.value);
  setH('xd_est', a && p && a > 0 && p > 0 ? `${X.side === 'buy' ? 'You pay about' : 'You receive about'} ${fmt(a * p, 6)} XRP${X.inst ? ' (fills at the best prices at or better than your price; the rest is cancelled)' : ''}` : '');
}
function renderAll() { renderList(); renderBook(); renderTkt(); renderOrders(); }

export function shell() {
  return `<div id="xdx" class="card xd">
    <div class="k">XRPL DEX</div>
    <div id="xd_note" class="mut" style="font-size:.85rem;margin:.2rem 0 .6rem">${isMain() ? '' : 'You are on the XRPL Testnet, which has almost no real trading. The token ranking below is for XRPL Mainnet: switch the XRPL network to Mainnet in Settings to trade for real.'}</div>
    <div class="xd_grid">
      <div class="xd_l"><input id="xd_q" class="grow" placeholder="Search token or issuer" oninput="window.xd.q(this.value)"><div id="xd_list" class="xd_scroll"><div class="mut" style="padding:1rem">Loading the top 50 XRPL tokens by volume…</div></div><div id="xd_src" class="mut" style="font-size:.72rem;margin-top:.4rem"></div></div>
      <div class="xd_r"><div id="xd_book"></div><div id="xd_tkt" style="margin-top:.8rem"></div><div id="xd_orders"></div></div>
    </div></div>`;
}
async function refresh() {
  if (!$('xdx')) return;
  await Promise.all([loadBook(), loadAcct()]);
  renderBook(); renderOrders();
  const ae = document.activeElement as HTMLElement | null;
  if (!(ae && ae.closest && ae.closest('#xd_tkt'))) renderTkt();   // never rebuild the ticket under someone who is typing
}
export async function mount() {
  if (!$('xdx')) return; unmount();
  if (!X.toks.length) await loadTop(); renderAll();
  if (!X.sel && X.toks.length) { X.sel = X.toks[0]; X.gen++; }
  await refresh(); renderAll();
  timer = setInterval(() => { if (document.hidden) return; void refresh(); }, 12000);
}
export function unmount() { if (timer) { clearInterval(timer); timer = 0; } }

export const xd = {
  q(v: string) { X.q = v; renderList(); },
  async pick(i: number) { X.sel = X.toks[i]; X.gen++; X.book = { asks: [], bids: [] }; renderAll(); await refresh(); renderTkt(); const e = $('xd_book'); if (e && window.innerWidth < 900) e.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  side(s: string) { X.side = s; renderTkt(); },
  inst(v: boolean) { X.inst = v; est(); },
  setPx(p: number) { const e = $('xd_px') as HTMLInputElement | null; if (e) { e.value = decN(p); est(); } },
  est,
  async trust(btn: HTMLButtonElement) {
    const t: Tok | null = X.sel; if (!t) return; btn.disabled = true;
    const r = await ctx.submit({ TransactionType: 'TrustSet', Account: ctx.account(), LimitAmount: { currency: t.cur, issuer: t.iss, value: '1000000000' } });
    if (r.ok) { ctx.toast('✓ Trust line added'); await refresh(); renderTkt(); } else { ctx.toast('Rejected: ' + (r.msg || 'failed'), true); btn.disabled = false; }
  },
  async go(btn: HTMLButtonElement) {
    const t: Tok | null = X.sel; if (!t) return;
    const a = num(($('xd_amt') as HTMLInputElement | null)?.value), p = num(($('xd_px') as HTMLInputElement | null)?.value), buy = X.side === 'buy';
    if (!a || a <= 0 || !p || p <= 0) { ctx.toast('Enter an amount and a price.', true); return; }
    // fill-now orders get a 3% margin so they cross the book; resting orders use the exact price
    const px = X.inst ? (buy ? p * 1.03 : p * 0.97) : p, drops = Math.round(a * px * 1e6);
    if (drops < 1) { ctx.toast('That is below the smallest XRP amount.', true); return; }
    const tokAmt = { currency: t.cur, issuer: t.iss, value: decN(a) };
    const tx: any = { TransactionType: 'OfferCreate', Account: ctx.account(), TakerPays: buy ? tokAmt : String(drops), TakerGets: buy ? String(drops) : tokAmt };
    if (X.inst) tx.Flags = 0x00020000;   // tfImmediateOrCancel
    X.busy = true; btn.disabled = true;
    const r = await ctx.submit(tx); X.busy = false;
    if (r.ok) { ctx.toast(`✓ ${buy ? 'Buy' : 'Sell'} order sent`); await refresh(); renderTkt(); } else { ctx.toast('Order rejected: ' + (r.msg || 'failed'), true); btn.disabled = false; }
  },
  async cancel(seq: number) {
    const r = await ctx.submit({ TransactionType: 'OfferCancel', Account: ctx.account(), OfferSequence: seq });
    ctx.toast(r.ok ? '✓ Order cancelled' : 'Could not cancel: ' + (r.msg || 'failed'), !r.ok); await refresh();
  },
};
(window as any).xd = xd;
