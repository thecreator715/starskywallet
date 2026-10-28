// DEX terminal: every AMM pair and order-book market, with chart, trades, holders, order book and a real buy/sell box.
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { Asset, NATIVE, akey, amtNum, amtTx, esc, fmt, hexName, isNative, issueOf, pctHtml, short, usd, ago, fromKey } from './util.ts';
import { cached, info, req, tryReq } from './chain.ts';
import { chartSvg } from './dexchart.ts';
import * as Mg from './margin.ts';
import { iconOf as TKicon, registry as TKreg } from './tokens.ts';

type Side = 'buy' | 'sell';
export const DX: any = {
  mid: '',
  inv: false,
  lineInv: false,
  range: '1d',
  side: 'buy' as Side,
  type: 'market' as 'market' | 'limit',
  amt: '',
  price: '',
  slip: 1,
  post: false,
  scale: 'auto',
  sma: true,
  style: 'candle',
  ema: false,
  boll: false,
  tab: 'trades',
  mode: 'spot',
  dragging: false,
  geom: null as any,
  osub: 'open',
  bgrp: 0,
  bview: 'both',
  hist: null as any,
  fKind: 'all',
  fMin: 0,
  fAcct: '',
  gen: 0,
  markets: [] as M.Market[],
  refs: [] as M.PoolRef[],
  cd: null,
  tr: null,
  tok: null,
  hold: null,
  bookd: null,
  orders: null,
  bal: null as null | { lines: any[]; native: number },
  pc: null as any,
  quote: null as null | M.Quote,
  timer: null as any,
  last: 0,
  err: '',
  msg: '' as string,
  loadedMid: '',
  msgBad: true,
  loading: false,
};
const $ = (id: string) => document.getElementById(id);
const setHtml = (id: string, h: string) => {
  const e = $(id) as any;
  if (e && e.__h !== h) {
    const top = e.scrollTop,
      left = e.scrollLeft;
    e.innerHTML = h;
    e.__h = h;
    if (top || left) {
      e.scrollTop = top;
      e.scrollLeft = left;
    }
  }
};
const mkt = (): M.Market | null => {
  const m = DX.markets.find((x: M.Market) => x.id === DX.mid);
  if (!m) return null;
  return DX.inv ? { id: M.marketId(m.quote, m.base), base: m.quote, quote: m.base, label: m.quote ? M.labelOf(m.quote) + '/' + M.labelOf(m.base) : m.label, pool: m.pool } : m;
};
const nm = (a: Asset) => M.labelOf(a);
const RANGE = () => M.RANGES.find(r => r.k === DX.range) || M.RANGES[2];

/* ---------- balances ---------- */
async function loadBal() {
  const acc = ctx.account();
  if (!acc || !ctx.online()) return (DX.bal = null);
  const [ai, al, inf] = await Promise.all([tryReq('account_info', { account: acc, ledger_index: 'validated' }, 3000), tryReq('account_lines', { account: acc, ledger_index: 'validated', limit: 400 }, 3000), info()]);
  if (!ai || !ai.account_data) return (DX.bal = { lines: [], native: 0 });
  const bal = Number(ai.account_data.Balance) / 1e6;
  const res = inf.reserveBase + inf.reserveInc * (ai.account_data.OwnerCount || 0);
  DX.bal = { lines: (al && al.lines) || [], native: Math.max(0, bal - res) };
}
const balOf = (a: Asset): number => {
  if (!DX.bal) return 0;
  if (isNative(a)) return DX.bal.native;
  const l = DX.bal.lines.find((x: any) => x.currency === a.c && x.account === a.i);
  return l ? Number(l.balance) : 0;
};
const hasLine = (a: Asset) => isNative(a) || (DX.bal && DX.bal.lines.some((x: any) => x.currency === a.c && x.account === a.i));

/* ---------- loading ---------- */
export function shell() {
  return `<div class="dx" id="dx">
    <div class="dxmain">
      <div class="card dxchart">
        <div class="dxbar" id="dx_head"></div>
        <div class="dxbar dxtools" id="dx_tools"></div>
        <div class="dxohlc mono" id="dx_ohlc">&nbsp;</div>
        <div id="dx_chart" class="dxcw"><div class="mut" style="padding:3rem 0;text-align:center">Reading the ledger…</div></div>
      </div>
      <div class="dxsplit" id="dx_split" title="Drag to resize the chart and the tables. Double-click to reset."></div>
      <div class="card dxbelow">
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
const SPK = 'starsky.dx.split';
const splitRatio = () => {
  try {
    const v = Number(localStorage.getItem(SPK));
    return v >= 25 && v <= 80 ? v : 56;
  } catch {
    return 56;
  }
};
function applySplit() {
  const m = document.querySelector('.dxmain') as HTMLElement | null;
  if (!m) return;
  if (window.innerWidth < 1100) return void (m.style.gridTemplateRows = '');
  const r = splitRatio();
  m.style.gridTemplateRows = `minmax(0,${r}fr) 10px minmax(0,${100 - r}fr)`;
}
function bindSplit() {
  const h = $('dx_split') as any;
  if (!h || h.__b) return;
  h.__b = 1;
  h.onpointerdown = (ev: PointerEvent) => {
    ev.preventDefault();
    const m = document.querySelector('.dxmain') as HTMLElement;
    const move = (e: PointerEvent) => {
      const r = m.getBoundingClientRect();
      const v = Math.round(Math.min(80, Math.max(25, ((e.clientY - r.top) / r.height) * 100)));
      try {
        localStorage.setItem(SPK, String(v));
      } catch {}
      applySplit();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (DX.cd) renderChart(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  h.ondblclick = () => {
    try {
      localStorage.removeItem(SPK);
    } catch {}
    applySplit();
    if (DX.cd) renderChart(true);
  };
}
export function fit() {
  const e = $('dx');
  if (!e) return;
  applySplit();
  bindSplit();
  if (window.innerWidth < 1100) return void (e.style.height = '');
  e.style.height = Math.max(560, window.innerHeight - e.getBoundingClientRect().top - 18) + 'px';
  if (DX.cd) renderChart(true);
}
let fitBound = false;
export function mount() {
  clearInterval(DX.timer);
  if (!fitBound) {
    fitBound = true;
    window.addEventListener('resize', () => {
      clearTimeout((fit as any).t);
      (fit as any).t = setTimeout(fit, 120);
    });
  }
  setTimeout(fit, 0);
  DX.timer = setInterval(() => {
    if (!document.getElementById('dx')) return clearInterval(DX.timer);
    if (ctx.online() && !document.hidden) tick();
  }, 8000);
  renderAll();
  load();
}
export function unmount() {
  clearInterval(DX.timer);
}
const stale = (g: number) => g !== DX.gen || !document.getElementById('dx');

export async function load(keepSelection = true) {
  const g = ++DX.gen;
  if (!ctx.online()) {
    DX.err = 'Not connected to a node yet.';
    renderAll();
    return;
  }
  DX.err = '';
  DX.loading = true;
  try {
    TKreg().catch(() => []);
    const refs = await M.poolRefs();
    DX.refs = refs;
    DX.markets = M.marketsFrom(refs);
    if (stale(g)) return;
    if (!DX.markets.length) {
      DX.err = 'No pools or markets exist on this network yet. Create a pool on the Liquidity Pools page to start trading.';
      renderAll();
      return;
    }
    if (DX.wantKey) {
      const id = api.findFor(DX.wantKey);
      DX.wantKey = '';
      if (id) {
        DX.mid = id;
        DX.inv = false;
      }
    }
    if (!keepSelection || !DX.markets.find((m: M.Market) => m.id === DX.mid)) {
      const native = DX.markets.filter((m: M.Market) => isNative(m.quote));
      DX.mid = (native[0] || DX.markets[0]).id;
      DX.inv = false;
    }
    if (DX.loadedMid !== DX.mid + (DX.inv ? '~' : '')) DX.cd = DX.tr = DX.tok = DX.hold = DX.bookd = DX.pc = null;
    DX.loadedMid = DX.mid + (DX.inv ? '~' : '');
    renderAll();
    const m = mkt() as M.Market;
    const jobs: Promise<any>[] = [
      loadBal().then(() => !stale(g) && (renderTrade(), renderTok())),
      M.candles(m, RANGE()).then(c => {
        if (stale(g)) return;
        DX.cd = c;
        renderChart();
        if (c.list.length > 1)
          M.tradesSince(m, c.list[0].t).then(tt => {
            if (stale(g) || DX.cd !== c) return;
            M.applyVolume(c.list, tt);
            renderChart();
          });
        renderHead();
        renderTok();
      }),
      M.trades(m, 200).then(t => {
        if (stale(g)) return;
        DX.tr = t;
        renderTable();
        renderInfo();
        renderTok();
      }),
      M.tokenTable([m.base, m.quote]).then(async t => {
        if (stale(g)) return;
        DX.tok = t;
        DX.pc = await pairChanges(m, t);
        if (stale(g)) return;
        renderHead();
        renderTok();
        renderInfo();
        const row = t.rows.find(r => r.key === akey(m.base));
        const pools = new Set<string>(DX.refs.map((p: M.PoolRef) => p.account));
        M.holders(m.base, row ? row.supply : null, pools).then(h => {
          if (stale(g)) return;
          DX.hold = h;
          renderTok();
          if (DX.tab === 'holders') renderTable();
        });
      }),
      M.book(m, 40).then(b => {
        if (stale(g)) return;
        DX.bookd = b;
        if (DX.tab === 'book') renderTable();
        renderInfo();
      }),
      loadOrders().then(() => !stale(g) && DX.tab === 'orders' && renderTable()),
    ];
    await Promise.allSettled(jobs);
    DX.last = Date.now();
    quoteNow();
  } catch (e: any) {
    DX.err = String(e?.message || e);
    renderAll();
  }
  DX.loading = false;
}
async function loadOrders() {
  const acc = ctx.account();
  if (!acc) return (DX.orders = []);
  const r: any = await tryReq('account_offers', { account: acc, limit: 100 }, 3000);
  DX.orders = (r && r.offers) || [];
  loadHist().then(() => DX.tab === 'orders' && renderTable());
}
async function pairChanges(m: M.Market, t: { now: M.Snap; ws: M.WinSnap[] }) {
  const dp = M.directPool(DX.refs, m.base, m.quote);
  const nowP = dp ? (await M.poolState(dp)) : null;
  const now = nowP ? M.poolPrice(nowP, m.base) : M.ratio(t.now, m.base, m.quote);
  const out: Record<string, { v: number | null; partial: boolean }> = {};
  for (const w of t.ws) {
    let then: number | null = null,
      partial = false;
    if (dp) {
      let s = w.w.k === 'all' ? null : await M.poolState(dp, w.seq);
      if (!s) {
        s = await M.poolState(dp, await M.firstSeen(dp));
        partial = w.w.k !== 'all';
      }
      then = s ? M.poolPrice(s, m.base) : null;
    } else then = M.ratio(w.snap, m.base, m.quote);
    out[w.w.k] = { v: now != null && then != null && then > 0 ? (now / then - 1) * 100 : null, partial };
  }
  return { now, ch: out };
}

export async function tick() {
  const m = mkt();
  if (!m || DX.loading) return;
  const g = DX.gen;
  try {
    await loadBal();
    const dp = M.directPool(DX.refs, m.base, m.quote);
    if (dp) {
      const s = await M.poolState(dp);
      if (s && DX.pc) DX.pc.now = M.poolPrice(s, m.base);
    }
    if (Date.now() - DX.last > 12000) {
      DX.last = Date.now();
      const [t, b] = await Promise.all([M.trades(m, 200), M.book(m)]);
      if (stale(g)) return;
      DX.tr = t;
      DX.bookd = b;
      await loadOrders();
      if (DX.tab === 'trades' || DX.tab === 'book' || DX.tab === 'orders') renderTable();
      renderInfo();
    }
    renderHead();
    renderChart(true);
    renderTrade(true);
    renderTok();
    quoteNow();
  } catch {}
}

/* ---------- rendering ---------- */
function renderAll() {
  renderHead();
  renderTools();
  renderChart();
  renderTabs();
  renderTable();
  renderTok();
  renderTrade();
  renderInfo();
}
const livePrice = (): number | null => (DX.pc && DX.pc.now != null ? DX.pc.now : DX.cd && DX.cd.list.length ? DX.cd.list[DX.cd.list.length - 1].c : null);
const usdOfQuote = (): number | null => {
  const m = mkt();
  if (!m || !DX.tok) return null;
  return M.usdPx(DX.tok.now, akey(m.quote));
};
function renderHead() {
  const m = mkt();
  if (!DX.markets.length || !m) {
    setHtml('dx_head', `<span class="mut">${esc(DX.err || 'Loading markets…')}</span>`);
    return;
  }
  const opts = DX.markets.map((x: M.Market) => `<option value="${esc(x.id)}" ${x.id === DX.mid ? 'selected' : ''}>${esc(x.label)}${x.pool ? '' : ' (book)'}</option>`).join('');
  const p = livePrice();
  const d24 = DX.pc ? DX.pc.ch['24h'] : null;
  const qusd = usdOfQuote();
  setHtml(
    'dx_head',
    `<select class="dxsel" onchange="window.dx.pick(this.value)">${opts}</select>
     <button class="sm ghost" title="Flip base and quote" onclick="window.dx.flip()">⇄</button>
     <div class="dxprice"><span class="mono">${p == null ? '–' : fmt(p)}</span> <small>${esc(nm(m.quote))}</small>${qusd != null && p != null ? ` <small class="mut">≈ ${usd(p * qusd)}</small>` : ''}</div>
     ${d24 ? `<div>${pctHtml(d24.v)}${d24.partial ? '<small class="mut" title="Longer than this market has existed: change since it listed"> *</small>' : ''}<small class="mut"> 24h</small></div>` : ''}
     <div style="flex:1"></div>
     <span class="mut dxnote">${DX.cd && DX.cd.note ? esc(DX.cd.note) : ''}</span>`
  );
}
function renderTools() {
  setHtml(
    'dx_tools',
    `<div class="seg">${M.RANGES.map(r => `<button class="${DX.range === r.k ? 'on' : ''}" onclick="window.dx.setRange('${r.k}')">${r.label}</button>`).join('')}</div>
     <div style="flex:1"></div>
     <div class="seg">${(['pct', 'log', 'auto'] as const).map(k => `<button class="${DX.scale === k ? 'on' : ''}" onclick="window.dx.setScale('${k}')">${k === 'pct' ? '%' : k}</button>`).join('')}</div>
     <div class="seg">${([['candle', 'Candles'], ['hollow', 'Hollow'], ['ohlc', 'Bars'], ['line', 'Line'], ['step', 'Step'], ['area', 'Area']] as const).map(([k, l]) => `<button class="${DX.style === k ? 'on' : ''}" onclick="window.dx.setStyle('${k}')">${l}</button>`).join('')}</div>
     <div class="seg"><button class="${DX.sma ? 'on' : ''}" onclick="window.dx.toggleSma()" title="Moving averages 7 and 25">MA</button><button class="${DX.ema ? 'on' : ''}" onclick="window.dx.toggleInd('ema')" title="Exponential average (20)">EMA</button><button class="${DX.boll ? 'on' : ''}" onclick="window.dx.toggleInd('boll')" title="Bollinger bands (20, 2)">BB</button></div>`
  );
}
function renderChart(soft = false) {
  const el = $('dx_chart');
  if (!el) return;
  if (!DX.cd) {
    if (!soft) {
      el.innerHTML = '<div class="mut" style="padding:3rem 0;text-align:center">Reading price history from the ledger…</div>';
      (el as any).__h = null;
    }
    return;
  }
  if (DX.dragging) return;
  const m0 = mkt();
  // the leverage lines are kept in LUMA per asset; when the chart is flipped (asset as the quote) they are drawn at 1/price, which puts stop loss and liquidation on the other side automatically
  DX.lineInv = !!(m0 && !isNative(m0.quote) && isNative(m0.base));
  const lines = m0 && isNative(m0.quote) && !isNative(m0.base) ? Mg.chartLines(akey(m0.base), DX.mode === 'margin') : DX.lineInv ? Mg.chartLines(akey(m0!.quote), DX.mode === 'margin').filter((l: any) => l.price > 0).map((l: any) => ({ ...l, price: 1 / l.price })) : [];
  const { svg, geom } = chartSvg(DX.cd.list, { scale: DX.scale, sma: DX.sma, style: DX.style, ema: DX.ema, boll: DX.boll, rangeSec: RANGE().sec, lines, volUnit: m0 ? nm(m0.quote) : '', h: Math.max(260, Math.min(760, Math.round((el.clientHeight / Math.max(1, el.clientWidth)) * 1000))) }, livePrice());
  DX.geom = geom;
  if ((el as any).__h !== svg) {
    el.innerHTML = svg;
    (el as any).__h = svg;
    bindCross();
    bindDrag();
  }
  const l = DX.cd.list[DX.cd.list.length - 1];
  if (l) setOhlc(DX.cd.list.length - 1);
}
function setOhlc(i: number) {
  const c = DX.cd && DX.cd.list[i];
  const m = mkt();
  const e = $('dx_ohlc');
  if (!c || !m || !e) return;
  const ch = (c.c / c.o - 1) * 100;
  e.innerHTML = `${esc(m.label)} · ${esc(DX.range)} · <span class="mut">${new Date(c.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span> &nbsp; O <b>${fmt(c.o)}</b> H <b>${fmt(c.h)}</b> L <b>${fmt(c.l)}</b> C <b>${fmt(c.c)}</b> ${pctHtml(ch)} ${c.flow ? `&nbsp; pool flow <b>${fmt(c.flow)}</b>` : ''}`;
}
function bindDrag() {
  const svg = $('dx_svg') as any;
  if (!svg) return;
  svg.querySelectorAll('.dxhit').forEach((h: any) => {
    h.onpointerdown = (ev: PointerEvent) => {
      ev.preventDefault();
      const id = h.getAttribute('data-id');
      const g = h.parentNode as any;
      const y0 = Number(g.getAttribute('data-y'));
      const geo = DX.geom;
      if (!geo || geo.lo == null) return;
      DX.dragging = true;
      let price = 0;
      const toPrice = (cy: number) => {
        const r = svg.getBoundingClientRect();
        const y = Math.min(geo.PT + geo.plotH, Math.max(geo.PT, ((cy - r.top) / r.height) * geo.h));
        const t = 1 - (y - geo.PT) / geo.plotH;
        return { y, p: geo.log ? Math.exp(Math.log(geo.lo) + t * (Math.log(geo.hi) - Math.log(geo.lo))) : geo.lo + t * (geo.hi - geo.lo) };
      };
      const move = (e: PointerEvent) => {
        const q = toPrice(e.clientY);
        price = q.p;
        g.setAttribute('transform', `translate(0 ${q.y - y0})`);
        const tx = g.querySelector('.dxlt');
        if (tx) tx.textContent = fmt(q.p);
      };
      const up = (e: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        DX.dragging = false;
        const q = toPrice(e.clientY);
        if (Math.abs(q.y - y0) < 2) return void renderChart(true);
        (($('dx_chart') as any) || {}).__h = null;
        Mg.dragEnd(id, DX.lineInv && q.p > 0 ? 1 / q.p : q.p);
        renderChart(true);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
  });
}
function bindCross() {
  const svg = $('dx_svg') as any;
  const xh = $('dx_xh');
  if (!svg || !DX.cd) return;
  svg.onmousemove = (ev: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * 1000;
    const n = DX.cd.list.length;
    const i = Math.min(n - 1, Math.max(0, Math.floor(((x - 6) / (1000 - 6 - 74)) * n)));
    if (xh) {
      xh.setAttribute('x1', String(6 + ((1000 - 80) / n) * (i + 0.5)));
      xh.setAttribute('x2', String(6 + ((1000 - 80) / n) * (i + 0.5)));
      (xh as any).style.display = '';
    }
    setOhlc(i);
  };
  svg.onmouseleave = () => {
    if (xh) (xh as any).style.display = 'none';
    setOhlc(DX.cd.list.length - 1);
  };
}
function renderTabs() {
  const T: [string, string][] = [
    ['trades', 'Trades'],
    ['pools', 'Pools'],
    ['holders', 'Holders'],
    ['book', 'Order book'],
    ['orders', 'Orders'],
    ['positions', 'Leverage'],
  ];
  setHtml('dx_tabs', T.map(([k, l]) => `<button class="${DX.tab === k ? 'on' : ''}" onclick="window.dx.setTab('${k}')">${l}</button>`).join(''));
}
const kindTag = (k: string) => (k === 'buy' ? '<b class="up">BUY</b>' : k === 'sell' ? '<b class="dn">SELL</b>' : k === 'add' ? '<b style="color:var(--b1)">ADD LIQ</b>' : '<b style="color:var(--warn)">REMOVE LIQ</b>');
function renderTable() {
  renderTabs();
  const m = mkt();
  if (!m) return setHtml('dx_table', '');
  if (DX.tab === 'trades') {
    if (!DX.tr) return setHtml('dx_table', '<div class="mut" style="padding:1.2rem">Reading the pool’s transactions…</div>');
    const q = DX.fAcct.trim().toLowerCase();
    const qu = usdOfQuote();
    const rows = DX.tr.filter((t: M.Trade) => {
      if (DX.fKind === 'trades' && (t.kind === 'add' || t.kind === 'remove')) return false;
      if (DX.fKind === 'liq' && t.kind !== 'add' && t.kind !== 'remove') return false;
      if (DX.fMin > 0 && t.quote < DX.fMin) return false;
      if (q && !(t.who.toLowerCase().includes(q) || ctx.show(t.who).toLowerCase().includes(q))) return false;
      return true;
    });
    DX.rows = rows.slice(0, 80);
    const mx = Math.max(0, ...DX.rows.map((t: M.Trade) => t.quote));
    const chips = (k: string, l: string) => `<button class="chip ${DX.fKind === k ? 'on' : ''}" onclick="window.dx.fk('${k}')">${l}</button>`;
    const mins = [0, 10, 100, 1000].map(v => `<button class="chip ${DX.fMin === v ? 'on' : ''}" onclick="window.dx.fm(${v})">${v ? fmt(v) + '+' : 'Any'}</button>`).join('');
    setHtml(
      'dx_table',
      `<div class="dxfilters">${chips('all', 'All')}${chips('trades', 'Trades')}${chips('liq', 'Liquidity')}<span class="mut" style="margin-left:.8rem">MIN ${esc(nm(m.quote))}</span>${mins}<input placeholder="Account…" value="${esc(DX.fAcct)}" oninput="window.dx.fa(this.value)" style="width:9rem;margin-left:auto;padding:.25rem .6rem"></div>
       <table class="dxt"><thead><tr><th>Time</th><th>Type</th><th class="r">USD</th><th class="r">Amount</th><th class="r">Value</th><th class="r">Price (${esc(nm(m.quote))})</th><th>Trader</th></tr></thead><tbody>
       ${
         rows
           .slice(0, 80)
           .map(
             (t: M.Trade, i: number) => `<tr class="trw ${t.kind}" style="--gi:${(0.12 + 0.3 * Math.min(1, t.quote / (mx || 1))).toFixed(2)}" onclick="window.dx.hist(${i})" title="Click for the full details"><td class="mut">${t.ms ? ago(Date.now() - t.ms) : '–'}</td><td>${kindTag(t.kind)}</td><td class="r">${qu != null ? usd(t.quote * qu) : '–'}</td><td class="r">${fmt(t.base)} <small class="mut">${esc(nm(m.base))}</small></td><td class="r"><small class="mut">${esc(nm(m.quote))}</small> ${fmt(t.quote)}</td><td class="r mono">${t.price != null ? fmt(t.price) : '–'}</td><td><a class="who" href="#" onclick="window.dx.who('${esc(t.who)}');return false">${esc(short(ctx.show(t.who), 6, 5))}</a> <a class="mut" href="#" title="${esc(t.hash)}" onclick="window.dx.tx('${esc(t.hash)}');return false">tx</a></td></tr>`
           )
           .join('') || '<tr><td colspan="7" class="mut" style="padding:1rem">No matching activity in this pool yet.</td></tr>'
       }
       </tbody></table>${!M.directPool(DX.refs, m.base, m.quote) ? '<div class="mut" style="padding:.6rem">This market has no pool: only the order book trades here.</div>' : ''}`
    );
  } else if (DX.tab === 'pools') {
    const used = DX.refs.filter((p: M.PoolRef) => [akey(m.base), akey(m.quote)].some(k => akey(p.a) === k || akey(p.b) === k));
    const snap = DX.tok ? DX.tok.now : null;
    setHtml(
      'dx_table',
      `<table class="dxt"><thead><tr><th>Pool</th><th class="r">Reserves</th><th class="r">TVL</th><th class="r">Price</th><th class="r">Fee</th><th></th></tr></thead><tbody>${used
        .map((p: M.PoolRef) => {
          const s = snap && snap.pools.find((x: M.PoolState) => x.account === p.account);
          const tvl = s && snap.px.has(akey(p.a)) ? s.ra * snap.px.get(akey(p.a)) * 2 : null;
          const tu = tvl != null && snap.usdPerNative != null ? tvl * snap.usdPerNative : null;
          return `<tr><td><b>${esc(nm(p.a))}/${esc(nm(p.b))}</b></td><td class="r">${s ? fmt(s.ra) + ' ' + esc(nm(p.a)) + '<br>' + fmt(s.rb) + ' ' + esc(nm(p.b)) : '…'}</td><td class="r">${tu != null ? usd(tu) : tvl != null ? fmt(tvl) + ' ' + esc(ctx.native()) : '–'}</td><td class="r mono">${s ? fmt(M.poolPrice(s, m.base)) : '–'}</td><td class="r">${p.fee}%</td><td class="r"><button class="sm" onclick="window.dx.pickPool('${esc(akey(p.a))}','${esc(akey(p.b))}')">Trade</button> <button class="sm pri" onclick="window.lp.openDeposit('${esc(p.account)}')">Deposit</button> <button class="sm" onclick="window.lp.openWithdraw('${esc(p.account)}')">Withdraw</button></td></tr>`;
        })
        .join('')}</tbody></table>`
    );
  } else if (DX.tab === 'holders') {
    const h = DX.hold;
    if (!h) return setHtml('dx_table', '<div class="mut" style="padding:1.2rem">Counting holders on the ledger…</div>');
    setHtml(
      'dx_table',
      `<div class="mut" style="padding:.4rem .2rem">${h.count} holders of ${esc(nm(m.base))}${h.truncated ? ' (first pages only)' : ''}</div><table class="dxt"><thead><tr><th>#</th><th>Account</th><th class="r">Balance</th><th class="r">Share</th></tr></thead><tbody>${h.top
        .map((x: M.HolderRow, i: number) => `<tr><td class="mut">${i + 1}</td><td><a class="who" href="#" onclick="window.dx.who('${esc(x.addr)}');return false">${esc(short(ctx.show(x.addr), 8, 6))}</a> ${x.tag ? `<span class="tag">${x.tag}</span>` : ''}</td><td class="r">${fmt(x.bal)}</td><td class="r">${x.share != null ? x.share.toFixed(2) + '%' : '–'}</td></tr>`)
        .join('')}</tbody></table>`
    );
  } else if (DX.tab === 'book') {
    renderBook(m);
  } else if (DX.tab === 'positions') {
    setHtml('dx_table', '<div id="dx_pos" style="padding:.4rem .2rem"></div>');
    Mg.refresh(false);
    Mg.paintNow();
  } else {
    renderOrders(m);
  }
}
const GRP = [0, 0.1, 0.5, 1, 5]; // price buckets, % of price (0 = every level)
function renderBook(m: M.Market) {
  const b = DX.bookd;
  if (!b) return setHtml('dx_table', '<div class="mut" style="padding:1.2rem">Reading the order book…</div>');
  const q = nm(m.quote),
    bn = nm(m.base);
  const mid0 = b.asks[0] && b.bids[0] ? (b.asks[0].price + b.bids[0].price) / 2 : livePrice();
  const g = GRP[DX.bgrp] || 0;
  const grp = (rows: M.BookLvl[], up: boolean) => {
    if (!g || !mid0) return rows.map(r => ({ price: r.price, base: r.base, quote: r.quote, n: 1 }));
    const step = mid0 * (g / 100);
    const mp = new Map<number, { price: number; base: number; quote: number; n: number }>();
    for (const r of rows) {
      const k = (up ? Math.ceil : Math.floor)(r.price / step - 1e-9) * step;
      const e = mp.get(k) || { price: k, base: 0, quote: 0, n: 0 };
      e.base += r.base;
      e.quote += r.quote;
      e.n++;
      mp.set(k, e);
    }
    return [...mp.values()].sort((x, y) => (up ? x.price - y.price : y.price - x.price));
  };
  const asks = grp(b.asks, true),
    bids = grp(b.bids, false);
  const cum = (rows: any[]) => {
    let c = 0;
    return rows.map(r => ({ ...r, cum: (c += r.base) }));
  };
  const A = cum(asks),
    B = cum(bids);
  const mx = Math.max(1e-18, A.length ? A[A.length - 1].cum : 0, B.length ? B[B.length - 1].cum : 0);
  const row = (r: any, cls: string, col: string) => `<tr class="clk" onclick="window.dx.bookPx(${r.price})"><td class="mono ${cls}">${fmt(r.price)}</td><td class="r">${fmt(r.base)}</td><td class="r">${fmt(r.quote)}</td><td class="r mut">${fmt(r.cum)}</td><td class="bkbar"><i style="width:${Math.min(100, (r.cum / mx) * 100)}%;background:${col}"></i></td></tr>`;
  const head = `<thead><tr><th>Price (${esc(q)})</th><th class="r">${esc(bn)}</th><th class="r">${esc(q)}</th><th class="r">Total ${esc(bn)}</th><th style="width:22%">Depth</th></tr></thead>`;
  const lp = livePrice();
  const spread = b.asks[0] && b.bids[0] ? b.asks[0].price - b.bids[0].price : null;
  const sp = spread != null && mid0 ? (spread / mid0) * 100 : null;
  const showA = DX.bview !== 'bids',
    showB = DX.bview !== 'asks';
  const bidV = B.length ? B[B.length - 1].cum : 0,
    askV = A.length ? A[A.length - 1].cum : 0;
  const imb = bidV + askV ? (bidV / (bidV + askV)) * 100 : 50;
  setHtml(
    'dx_table',
    `<div class="row bktools" style="gap:.4rem;flex-wrap:wrap;align-items:center;margin:.2rem 0 .5rem"><span class="mut">View</span>${[['both', 'Buy + sell'], ['bids', 'Buy only'], ['asks', 'Sell only']].map(([k, l]) => `<button class="sm ${DX.bview === k ? 'pri' : 'ghost'}" onclick="window.dx.bview('${k}')">${l}</button>`).join('')}<span class="mut" style="margin-left:.8rem">Scale</span>${GRP.map((x, i) => `<button class="sm ${DX.bgrp === i ? 'pri' : 'ghost'}" onclick="window.dx.bgrp(${i})">${x ? x + '%' : 'Exact'}</button>`).join('')}<span class="mut" style="margin-left:auto;font-size:.78rem">${b.bids.length} bids · ${b.asks.length} asks · click a row to use its price</span></div>
    <div class="dxratio" title="Share of resting buy volume"><span class="up">${imb.toFixed(0)}% bids</span><div class="dxrb"><i style="width:${imb}%"></i></div><span class="dn">${(100 - imb).toFixed(0)}% asks</span></div>
    <table class="dxt bk">${head}<tbody>${showA ? A.slice().reverse().map(r => row(r, 'dn', 'rgba(255,69,58,.22)')).join('') || '<tr><td colspan="5" class="mut">No sell orders.</td></tr>' : ''}
      <tr class="bkmid"><td colspan="5"><b class="mono" style="font-size:1.05rem">${lp != null ? fmt(lp) : mid0 ? fmt(mid0) : '–'}</b> <span class="mut">${esc(q)} · market${m.pool ? ' (AMM pool)' : ''}</span>${sp != null ? ` <span class="mut" style="margin-left:1rem">spread ${fmt(spread)} (${sp.toFixed(2)}%)</span>` : ''}</td></tr>
      ${showB ? B.map(r => row(r, 'up', 'rgba(0,224,126,.22)')).join('') || '<tr><td colspan="5" class="mut">No buy orders.</td></tr>' : ''}</tbody></table>`
  );
}
const nameOfA = (x: any) => (typeof x === 'string' ? ctx.native() : hexName(x.currency));
const pairOf = (gets: any, pays: any) => `${nameOfA(gets)}/${nameOfA(pays)}`;
function renderOrders(m: M.Market) {
  const acc = ctx.account();
  if (!acc) return setHtml('dx_table', '<div class="mut" style="padding:1.2rem">Select a wallet to see your orders.</div>');
  const o = DX.orders;
  if (!o) return setHtml('dx_table', '<div class="mut" style="padding:1.2rem">Loading…</div>');
  const sub = DX.osub;
  const tabs = `<div class="row" style="gap:.4rem;margin:.2rem 0 .6rem">${[['open', 'Open orders'], ['closed', 'Closed orders'], ['hist', 'Order history']].map(([k, l]) => `<button class="sm ${sub === k ? 'pri' : 'ghost'}" onclick="window.dx.osub('${k}')">${l}</button>`).join('')}</div>`;
  const H = DX.hist as { rows: any[]; open: Set<number> } | null;
  const t = (x: any) => (x.ms ? ago(Date.now() - x.ms) : '–');
  let body = '';
  if (sub === 'open') {
    body = `<table class="dxt"><thead><tr><th>Seq</th><th>Side</th><th>Selling</th><th>For at least</th><th class="r">Price</th><th>Expires</th><th></th></tr></thead><tbody>${
      o.map((x: any) => {
        const g = amtNum(x.taker_gets),
          p = amtNum(x.taker_pays);
        const sell = nameOfA(x.taker_gets) === nm(m.base);
        const price = sell ? p / g : g / p;
        return `<tr><td class="mut">${x.seq}</td><td>${sell ? '<b class="dn">SELL</b>' : '<b class="up">BUY</b>'}</td><td>${fmt(g)} ${esc(nameOfA(x.taker_gets))}</td><td>${fmt(p)} ${esc(nameOfA(x.taker_pays))}</td><td class="r mono">${isFinite(price) ? fmt(price) : '–'}</td><td class="mut">${x.expiration ? new Date((x.expiration + 946684800) * 1000).toLocaleString() : 'never'}</td><td class="r"><button class="sm dng" onclick="window.dx.cancel(${x.seq})">Cancel</button></td></tr>`;
      }).join('') || '<tr><td colspan="7" class="mut" style="padding:1rem">No open orders.</td></tr>'
    }</tbody></table>`;
  } else if (!H) body = '<div class="mut" style="padding:1rem">Reading your transaction history…</div>';
  else {
    const creates = H.rows.filter(r => r.type === 'OfferCreate' && !r.local);
    const fate = (r: any) => (H.open.has(r.seq) ? 'open' : r.cancelled ? 'Cancelled' : r.rested ? 'Filled / expired' : r.partial ? 'Filled (IOC)' : 'Filled');
    if (sub === 'closed') {
      const rows = creates.filter(r => !H.open.has(r.seq));
      body = `<table class="dxt"><thead><tr><th>Placed</th><th>Pair</th><th>Gave</th><th>Wanted</th><th>Outcome</th><th>Tx</th></tr></thead><tbody>${rows.map(r => `<tr><td class="mut">${t(r)}</td><td>${esc(pairOf(r.gets, r.pays))}</td><td>${fmt(amtNum(r.gets))} ${esc(nameOfA(r.gets))}</td><td>${fmt(amtNum(r.pays))} ${esc(nameOfA(r.pays))}</td><td><span class="chip ${r.cancelled ? 'bad' : ''}">${fate(r)}</span></td><td class="mono mut">${esc(short(r.hash, 6, 4))}</td></tr>`).join('') || '<tr><td colspan="6" class="mut" style="padding:1rem">No closed orders in your recent history.</td></tr>'}</tbody></table>`;
    } else {
      body = `<table class="dxt"><thead><tr><th>Time</th><th>Action</th><th>Pair</th><th>Amounts</th><th>Result</th><th>Tx</th></tr></thead><tbody>${H.rows.map(r => `<tr><td class="mut">${t(r)}</td><td>${r.type === 'OfferCancel' ? 'Cancel #' + r.cancelSeq : 'Order #' + r.seq}</td><td>${r.gets ? esc(pairOf(r.gets, r.pays)) : '–'}</td><td>${r.gets ? fmt(amtNum(r.gets)) + ' ' + esc(nameOfA(r.gets)) + ' → ' + fmt(amtNum(r.pays)) + ' ' + esc(nameOfA(r.pays)) : '–'}</td><td><span class="chip ${r.res === 'tesSUCCESS' ? '' : 'bad'}">${esc(r.res)}</span></td><td class="mono mut">${esc(short(r.hash, 6, 4))}</td></tr>`).join('') || '<tr><td colspan="6" class="mut" style="padding:1rem">No order transactions yet.</td></tr>'}</tbody></table>`;
    }
  }
  setHtml('dx_table', tabs + body);
}
const OLK = () => 'starsky.orders.' + ctx.netKey() + '.' + ctx.account();
const localOrders = (): any[] => {
  try {
    return JSON.parse(localStorage.getItem(OLK()) || '[]');
  } catch {
    return [];
  }
};
function logOrder(row: any) {
  try {
    const a = localOrders();
    a.unshift(row);
    localStorage.setItem(OLK(), JSON.stringify(a.slice(0, 300)));
  } catch {}
}
async function loadHist() {
  const acc = ctx.account();
  if (!acc) return (DX.hist = null);
  const r: any = await tryReq('account_tx', { account: acc, limit: 200, ledger_index_min: -1, ledger_index_max: -1 }, 5000);
  const rows: any[] = [];
  const cancelled = new Set<number>();
  for (const t of (r && r.transactions) || []) {
    const x = t.tx_json || t.tx || {};
    const meta = t.meta || t.metaData || {};
    if (x.TransactionType === 'OfferCancel') {
      if (x.Account === acc) cancelled.add(Number(x.OfferSequence));
      rows.push({ type: 'OfferCancel', cancelSeq: x.OfferSequence, res: meta.TransactionResult || '', hash: t.hash || x.hash, ms: x.date != null ? (x.date + 946684800) * 1000 : 0 });
    } else if (x.TransactionType === 'OfferCreate' && x.Account === acc) {
      const rested = (meta.AffectedNodes || []).some((n: any) => n.CreatedNode && n.CreatedNode.LedgerEntryType === 'Offer');
      if (x.OfferSequence) cancelled.add(Number(x.OfferSequence));
      rows.push({ type: 'OfferCreate', seq: x.Sequence ?? x.TicketSequence, gets: x.TakerGets, pays: x.TakerPays, res: meta.TransactionResult || '', hash: t.hash || x.hash, ms: x.date != null ? (x.date + 946684800) * 1000 : 0, rested, partial: (x.Flags & 0x00020000) !== 0 });
    }
  }
  for (const r2 of rows) if (r2.type === 'OfferCreate' && cancelled.has(r2.seq)) r2.cancelled = true;
  const known = new Set(rows.map(q => q.hash));
  for (const l of localOrders()) if (!known.has(l.hash)) rows.push({ ...l, local: true });
  rows.sort((p1, p2) => (p2.ms || 0) - (p1.ms || 0));
  DX.hist = { rows: rows.filter(q => q.res), open: new Set<number>((DX.orders || []).map((x: any) => Number(x.seq))) };
}
function renderTok() {
  const m = mkt();
  if (!m) return setHtml('dx_tok', '');
  const t = DX.tok,
    row = t && t.rows.find((r: M.TokenRow) => r.key === akey(m.base));
  const rank = t ? t.rows.findIndex((r: M.TokenRow) => r.key === akey(m.base)) + 1 : 0;
  const p = livePrice(),
    qu = usdOfQuote();
  const vol = DX.tr ? DX.tr.filter((x: M.Trade) => (x.kind === 'buy' || x.kind === 'sell') && Date.now() - x.ms < 86400e3).reduce((s: number, x: M.Trade) => s + x.quote, 0) : null;
  const tvlQ = DX.tok && m.pool ? poolTvlInQuote(m) : null;
  const c = DX.pc ? DX.pc.ch : {};
  const box = (k: string, w: string) => `<div class="dxs"><div class="k">${k}</div><div>${w}</div></div>`;
  const ch = (k: string, l: string) => `<div class="dxs"><div class="k">${l}</div><div>${c[k] ? pctHtml(c[k].v) + (c[k].partial ? '<small class="mut" title="Since listing"> *</small>' : '') : '<span class="mut">…</span>'}</div></div>`;
  const cl = DX.cd ? DX.cd.list : [];
  const lo = cl.length ? Math.min(...cl.map((x: M.Candle) => x.l)) : null,
    hi = cl.length ? Math.max(...cl.map((x: M.Candle) => x.h)) : null;
  const pos = lo != null && hi != null && hi > lo && p != null ? Math.min(100, Math.max(0, ((p - lo) / (hi - lo)) * 100)) : 50;
  const issuer = isNative(m.base) ? 'Native coin' : short(ctx.show(m.base.i), 6, 5);
  setHtml(
    'dx_tok',
    `<div class="dxtokh"><div class="dxav">${TKicon(akey(m.base)) ? `<img class="coinimg" src="${TKicon(akey(m.base))}" alt="">` : esc(nm(m.base).slice(0, 2).toUpperCase())}</div><div><b style="font-size:1.15rem">${esc(nm(m.base))}</b> ${rank ? `<span class="tag">#${rank}</span>` : ''}<div class="mut" style="font-size:.78rem">${esc(issuer)}</div></div>
      <div style="margin-left:auto;text-align:right"><div class="mono" style="font-size:1.5rem;font-weight:700"><small class="mut" style="font-size:.8rem">${esc(nm(m.quote))}</small> ${p == null ? '–' : fmt(p)}</div><div class="mut" style="font-size:.8rem">${qu != null && p != null ? '≈ ' + usd(p * qu) : ''}</div></div></div>
     <div class="dxgrid4">${box('MCAP', row && row.mcapUsd != null ? usd(row.mcapUsd) : row && row.mcapNative != null ? fmt(row.mcapNative) + ' ' + esc(ctx.native()) : '–')}${box('VOL 24H', vol != null ? fmt(vol) + ' <small class="mut">' + esc(nm(m.quote)) + '</small>' : '…')}${box('TVL', tvlQ != null ? fmt(tvlQ) + ' <small class="mut">' + esc(nm(m.quote)) + '</small>' : '–')}${box('HOLDERS', DX.hold ? fmt(DX.hold.count, 0) : '…')}</div>
     <div class="dxgrid4">${ch('5m', '5M')}${ch('1h', '1H')}${ch('24h', '24H')}${ch('7d', '7D')}</div>
     <div class="dxrange"><span class="mono">${lo != null ? fmt(lo) : ''}</span><div class="dxrbar"><i style="left:${pos}%"></i></div><span class="mono">${hi != null ? fmt(hi) : ''}</span></div>
     <div class="mut" style="font-size:.72rem;text-align:center">${esc(RANGE().label)} range${c['all'] ? ' · all-time ' + (c['all'].v == null ? '–' : (c['all'].v >= 0 ? '+' : '') + c['all'].v.toFixed(1) + '%') : ''}</div>`
  );
}
function poolTvlInQuote(m: M.Market): number | null {
  const s = DX.tok.now.pools.find((x: M.PoolState) => x.account === (m.pool as any).account);
  if (!s) return null;
  return 2 * (akey(s.a) === akey(m.quote) ? s.ra : s.rb);
}
function renderInfo() {
  const m = mkt();
  if (!m) return setHtml('dx_info', '');
  const t = DX.tok,
    row = t && t.rows.find((r: M.TokenRow) => r.key === akey(m.base));
  const day = DX.tr ? DX.tr.filter((x: M.Trade) => Date.now() - x.ms < 86400e3) : [];
  const buys = day.filter((x: M.Trade) => x.kind === 'buy'),
    sells = day.filter((x: M.Trade) => x.kind === 'sell'),
    adds = day.filter((x: M.Trade) => x.kind === 'add'),
    rems = day.filter((x: M.Trade) => x.kind === 'remove');
  const sum = (a: M.Trade[]) => a.reduce((s, x) => s + x.quote, 0);
  const bs = sum(buys),
    ss = sum(sells),
    tot = bs + ss;
  const who = new Set(day.filter((x: M.Trade) => x.kind === 'buy' || x.kind === 'sell').map((x: M.Trade) => x.who));
  const kv = (k: string, v: string) => `<div class="dxkv"><span class="mut">${k}</span><span>${v}</span></div>`;
  const q = nm(m.quote);
  const fdv = row && row.supply != null && livePrice() != null ? row.supply * (livePrice() as number) : null;
  const b = DX.bookd;
  setHtml(
    'dx_info',
    `<div class="dxsec">MARKET</div>${kv('Supply', row && row.supply != null ? fmt(row.supply) : '…')}${kv('FDV (' + esc(q) + ')', fdv != null ? fmt(fdv) : '–')}${kv('Pool fee', m.pool ? (m.pool as any).fee + '%' : '–')}${kv('Best bid / ask', b ? `${b.bids[0] ? fmt(b.bids[0].price) : '–'} / ${b.asks[0] ? fmt(b.asks[0].price) : '–'}` : '…')}
     <div class="dxsec">24H TRADING</div>
     <div class="dxratio"><span class="up">${tot ? Math.round((bs / tot) * 100) : 0}%</span><div class="dxrb"><i style="width:${tot ? (bs / tot) * 100 : 50}%"></i></div><span class="dn">${tot ? Math.round((ss / tot) * 100) : 0}%</span></div>
     ${kv('Buys', `<small class="mut">${buys.length} txns</small> ${fmt(bs)} ${esc(q)}`)}${kv('Sells', `<small class="mut">${sells.length} txns</small> ${fmt(ss)} ${esc(q)}`)}${kv('Trades', String(buys.length + sells.length))}${kv('Unique traders', String(who.size))}
     <div class="dxsec">LIQUIDITY</div>${kv('Deposits', `<small class="mut">${adds.length} txns</small> ${fmt(sum(adds))} ${esc(q)}`)}${kv('Withdrawals', `<small class="mut">${rems.length} txns</small> ${fmt(sum(rems))} ${esc(q)}`)}
     <div class="mut" style="font-size:.72rem;margin-top:.5rem">Read from the pool account’s own ledger history${DX.tr && DX.tr.length >= 200 ? ' (latest 200 entries)' : ''}.</div>`
  );
}
const modeBar = () => `<div class="dxmode"><button class="${DX.mode === 'spot' ? 'on' : ''}" onclick="window.dx.setMode('spot')">Spot</button><button class="${DX.mode === 'margin' ? 'on' : ''}" onclick="window.dx.setMode('margin')">Leverage 1–100x</button></div>`;
function renderTrade(soft = false) {
  const m = mkt();
  if (!m) return setHtml('dx_trade', '');
  if (soft && document.activeElement && ['dx_amt', 'dx_px'].includes((document.activeElement as any).id)) {
    refreshBal();
    return;
  }
  const buy = DX.side === 'buy';
  if (DX.mode === 'margin') {
    const nb = isNative(m.base);
    const key = nb ? akey(m.quote) : akey(m.base);
    const asLong = nb ? !buy : buy;
    const lbl2 = nb ? nm(m.quote) : nm(m.base);
    return setHtml(
      'dx_trade',
      modeBar() + `<div class="dxbs"><button class="${buy ? 'on buy' : ''}" onclick="window.dx.setSide('buy')">${nb ? 'SHORT' : 'LONG'}</button><button class="${!buy ? 'on sell' : ''}" onclick="window.dx.setSide('sell')">${nb ? 'LONG' : 'SHORT'}</button></div>` + Mg.ticketHtml(key, asLong, lbl2)
    );
  }
  const pay = buy ? m.quote : m.base,
    get = buy ? m.base : m.quote;
  const acc = ctx.account();
  const bal = balOf(pay);
  const need = !isNative(get) && DX.bal && !hasLine(get);
  const lbl = !ctx.online() ? 'Connecting…' : !acc ? 'Connect a wallet' : need ? `Enable ${nm(get)} first` : `${buy ? 'Buy' : 'Sell'} ${nm(m.base)}`;
  setHtml(
    'dx_trade',
    modeBar() + `<div class="dxbs"><button class="${buy ? 'on buy' : ''}" onclick="window.dx.setSide('buy')">BUY</button><button class="${!buy ? 'on sell' : ''}" onclick="window.dx.setSide('sell')">SELL</button>
      <div class="dxmt"><button class="${DX.type === 'market' ? 'on' : ''}" onclick="window.dx.setType('market')">MARKET</button><button class="${DX.type === 'limit' ? 'on' : ''}" onclick="window.dx.setType('limit')">LIMIT</button></div></div>
     ${DX.type === 'limit' ? `<div class="dxbox"><div class="k">LIMIT PRICE (${esc(nm(m.quote))} per ${esc(nm(m.base))})</div><div class="dxin"><input id="dx_px" inputmode="decimal" placeholder="${livePrice() != null ? fmt(livePrice(), 8) : '0.0'}" value="${esc(DX.price)}" oninput="window.dx.onPx(this.value)"><button class="sm ghost" onclick="window.dx.usePrice()">Market</button></div></div>` : ''}
     <div class="dxbox"><div class="k">YOU PAY <span class="mut" style="float:right;text-transform:none" id="dx_bal">Balance ${acc ? fmt(bal) : '–'} <a href="#" onclick="window.dx.max();return false">MAX</a></span></div>
      <div class="dxin"><span class="dxchip">${esc(nm(pay).slice(0, 2).toUpperCase())}</span><b>${esc(nm(pay))}</b><input id="dx_amt" inputmode="decimal" placeholder="0.00" value="${esc(DX.amt)}" oninput="window.dx.onAmt(this.value)"></div></div>
     <div class="dxflip"><button onclick="window.dx.setSide('${buy ? 'sell' : 'buy'}')" title="Switch direction">⇅</button></div>
     <div class="dxbox"><div class="k">YOU RECEIVE</div><div class="dxin"><span class="dxchip">${esc(nm(get).slice(0, 2).toUpperCase())}</span><b>${esc(nm(get))}</b><span class="dxout mono" id="dx_out">0.00</span></div><div class="mut" id="dx_rate" style="font-size:.78rem;margin-top:.3rem">&nbsp;</div></div>
     <div class="dxgrid3"><div class="dxs"><div class="k">IMPACT</div><div id="dx_imp">–</div></div><div class="dxs"><div class="k">FEE</div><div id="dx_fee">${m.pool ? (m.pool as any).fee + '%' : '–'}</div></div><div class="dxs"><div class="k">SLIPPAGE</div><div><a href="#" onclick="window.dx.slip();return false" title="Click to change">${DX.slip}%</a></div></div></div>
     ${DX.type === 'limit' ? `<label class="mut" style="font-size:.78rem;display:block;margin:.4rem 0"><input type="checkbox" ${DX.post ? 'checked' : ''} onchange="window.dx.setPost(this.checked)"> Post only (never take liquidity)</label>` : ''}
     <button class="pri ${buy ? 'acc' : ''} dxgo ${buy ? '' : 'sellgo'}" id="dx_go" onclick="window.dx.go(this)" ${!ctx.online() ? 'disabled' : ''}>${esc(lbl)}</button>
     <div class="mut" id="dx_msg" style="font-size:.78rem;margin-top:.4rem;color:${DX.msgBad ? 'var(--crit)' : 'var(--ok)'}">${esc(DX.msg)}</div>`
  );
  quoteNow();
}
function refreshBal() {
  const m = mkt();
  if (!m) return;
  const pay = DX.side === 'buy' ? m.quote : m.base;
  const e = $('dx_bal');
  if (e) e.innerHTML = `Balance ${ctx.account() ? fmt(balOf(pay)) : '–'} <a href="#" onclick="window.dx.max();return false">MAX</a>`;
}
let qTimer: any = null;
export function quoteNow() {
  clearTimeout(qTimer);
  qTimer = setTimeout(async () => {
    const m = mkt();
    const out = $('dx_out');
    if (!m || !out) return;
    const buy = DX.side === 'buy';
    const x = parseFloat(DX.amt);
    const get = buy ? m.base : m.quote;
    const msg = $('dx_msg');
    if (!(x > 0)) {
      out.textContent = '0.00';
      setHtml('dx_rate', '&nbsp;');
      setHtml('dx_imp', '–');
      DX.quote = null;
      return;
    }
    if (DX.type === 'limit') {
      const p = parseFloat(DX.price);
      const rec = p > 0 ? (buy ? x / p : x * p) : 0;
      out.textContent = rec > 0 ? fmt(rec, 8) : '0.00';
      setHtml('dx_rate', p > 0 ? `Order rests on the book at ${fmt(p)} ${esc(nm(m.quote))} per ${esc(nm(m.base))}` : 'Enter a limit price');
      setHtml('dx_imp', '–');
      return;
    }
    const q = await M.quote(m, DX.side, x);
    DX.quote = q;
    if (!q) {
      out.textContent = '0.00';
      setHtml('dx_rate', '<span class="dn">No liquidity for this size.</span>');
      setHtml('dx_imp', '–');
      return;
    }
    out.textContent = fmt(q.out, 8);
    setHtml('dx_rate', `1 ${esc(nm(buy ? m.quote : m.base))} ≈ ${fmt(q.rate)} ${esc(nm(get))} · via ${esc(q.src)} · min ${fmt(q.out * (1 - DX.slip / 100))}`);
    setHtml('dx_imp', `<span class="${q.impact > 0.05 ? 'dn' : ''}">${(q.impact * 100).toFixed(2)}%</span>`);
    setHtml('dx_fee', q.src === 'AMM pool' ? q.feePct + '%' : 'book');
  }, 200);
}

/* ---------- actions ---------- */
async function enableLine(a: Asset, btn: HTMLButtonElement) {
  const acc = ctx.account();
  btn.disabled = true;
  const r = await ctx.submit({ TransactionType: 'TrustSet', Account: acc, LimitAmount: { currency: a.c, issuer: a.i, value: '1000000000000' } });
  btn.disabled = false;
  if (r.ok) ctx.toast('✓ ' + nm(a) + ' enabled for this wallet');
  else ctx.toast('Could not enable ' + nm(a) + ': ' + r.msg, true);
  await loadBal();
  renderTrade();
}
Mg.mgApi.rerender = (redraw: boolean) => {
  if (DX.mode !== 'margin') return;
  const m = mkt();
  if (redraw || !m) return renderTrade();
  const nb = isNative(m.base);
  const tmp = document.createElement('div');
  tmp.innerHTML = Mg.ticketHtml(nb ? akey(m.quote) : akey(m.base), nb ? DX.side !== 'buy' : DX.side === 'buy', nb ? nm(m.quote) : nm(m.base));
  for (const id of ['mg_calc', 'mg_msg']) {
    const a = $(id),
      b = tmp.querySelector('#' + id);
    if (a && b) a.innerHTML = b.innerHTML;
  }
  const t = $('dx_trade') as any;
  if (t) t.__h = null;
  renderChart(true);
};
Mg.setOnChange(() => {
  if ($('dx_chart') && !DX.dragging) renderChart(true);
});
export const api: any = {
  setMode(k: string) {
    DX.mode = k;
    if (k === 'margin') {
      Mg.refresh(true);
      Mg.monitor();
    }
    renderTrade();
    renderChart(true);
  },
  osub(k: string) {
    DX.osub = k;
    renderTable();
  },
  bview(k: string) {
    DX.bview = k;
    renderTable();
  },
  bgrp(i: number) {
    DX.bgrp = i;
    renderTable();
  },
  bookPx(p: number) {
    DX.mode = 'spot';
    DX.type = 'limit';
    DX.price = String(+p.toPrecision(8));
    renderTrade();
  },
  want(k: string) {
    DX.wantKey = k;
  },
  findFor(k: string) {
    const m = DX.markets.find((x: M.Market) => akey(x.base) === k && isNative(x.quote)) || DX.markets.find((x: M.Market) => akey(x.base) === k) || DX.markets.find((x: M.Market) => akey(x.quote) === k);
    return m ? m.id : '';
  },
  pick(id: string) {
    DX.mid = id;
    DX.inv = false;
    DX.amt = '';
    DX.price = '';
    load();
  },
  pickPool(ka: string, kb: string) {
    const a = fromKey(ka),
      b = fromKey(kb);
    const m = DX.markets.find((x: M.Market) => (akey(x.base) === ka && akey(x.quote) === kb) || (akey(x.base) === kb && akey(x.quote) === ka));
    if (m) {
      DX.mid = m.id;
      DX.inv = false;
      load();
      window.scrollTo(0, 0);
    }
  },
  flip() {
    DX.inv = !DX.inv;
    DX.amt = '';
    DX.price = '';
    load();
  },
  setRange(k: string) {
    DX.range = k;
    DX.cd = null;
    renderTools();
    renderChart();
    const m = mkt();
    const g = DX.gen;
    if (m)
      M.candles(m, RANGE()).then(c => {
        if (stale(g) || DX.range !== k) return;
        DX.cd = c;
        renderChart();
        renderHead();
        renderTok();
      });
  },
  setScale(k: string) {
    DX.scale = k;
    renderTools();
    renderChart();
  },
  setStyle(k: string) {
    DX.style = k;
    renderTools();
    renderChart();
  },
  toggleInd(k: string) {
    DX[k] = !DX[k];
    renderTools();
    renderChart();
  },
  toggleSma() {
    DX.sma = !DX.sma;
    renderTools();
    renderChart();
  },
  setTab(k: string) {
    DX.tab = k;
    renderTable();
  },
  fk(k: string) {
    DX.fKind = k;
    renderTable();
  },
  fm(v: number) {
    DX.fMin = v;
    renderTable();
  },
  fa(v: string) {
    DX.fAcct = v;
    renderTable();
    const e = document.querySelector('.dxfilters input') as HTMLInputElement | null;
    if (e) {
      e.focus();
      e.setSelectionRange(v.length, v.length);
    }
  },
  setSide(s: Side) {
    DX.side = s;
    DX.amt = '';
    renderTrade();
  },
  setType(t: 'market' | 'limit') {
    DX.type = t;
    if (t === 'limit' && !DX.price && livePrice() != null) DX.price = String(+(livePrice() as number).toPrecision(8));
    renderTrade();
  },
  setPost(v: boolean) {
    DX.post = v;
  },
  onAmt(v: string) {
    DX.amt = v;
    DX.msg = '';
    const mm = $('dx_msg');
    if (mm) mm.textContent = '';
    quoteNow();
  },
  onPx(v: string) {
    DX.price = v;
    quoteNow();
  },
  usePrice() {
    if (livePrice() != null) DX.price = String(+(livePrice() as number).toPrecision(8));
    renderTrade();
  },
  max() {
    const m = mkt();
    if (!m) return;
    const pay = DX.side === 'buy' ? m.quote : m.base;
    DX.amt = String(Math.max(0, +(balOf(pay) * (isNative(pay) ? 0.98 : 1)).toPrecision(12)));
    const e = $('dx_amt') as HTMLInputElement | null;
    if (e) e.value = DX.amt;
    quoteNow();
  },
  slip() {
    const o = [0.5, 1, 3, 5];
    DX.slip = o[(o.indexOf(DX.slip) + 1) % o.length];
    renderTrade();
  },
  who(a: string) {
    if (a) (window as any).inspectAccount?.(a);
  },
  tx(h: string) {
    if (h) (window as any).inspectTx?.(h);
  },
  hist(i: number) {
    const m = mkt(),
      t: M.Trade | undefined = (DX.rows || [])[i];
    if (!m || !t) return;
    const qu = usdOfQuote(),
      cur = DX.tok && (DX as any).lastPrice != null ? (DX as any).lastPrice : null;
    const row = (k: string, v: string) => `<div class="hd_r"><span class="mut">${k}</span><b>${v}</b></div>`;
    const isTr = t.kind === 'buy' || t.kind === 'sell';
    let ov = document.getElementById('dx_hist');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'dx_hist';
      document.body.appendChild(ov);
    }
    const prev = i > 0 ? i - 1 : -1,
      next = i + 1 < (DX.rows || []).length ? i + 1 : -1;
    ov.className = 'hd_ov ' + t.kind;
    ov.onclick = e => {
      if (e.target === ov) ov!.remove();
    };
    ov.innerHTML = `<div class="hd_pg"><div class="hd_top"><button class="b" onclick="document.getElementById('dx_hist').remove()">← Back to trades</button><span style="flex:1"></span><button class="b" ${prev < 0 ? 'disabled' : ''} onclick="window.dx.hist(${prev})">‹ Newer</button><button class="b" ${next < 0 ? 'disabled' : ''} onclick="window.dx.hist(${next})">Older ›</button></div>
      <div class="hd_head">${kindTag(t.kind)} <span style="font-size:1.4rem;font-weight:700">${fmt(t.base)} ${esc(nm(m.base))}</span><span class="mut"> for </span><span style="font-size:1.4rem;font-weight:700">${fmt(t.quote)} ${esc(nm(m.quote))}</span>${qu != null ? `<div class="mut">≈ ${usd(t.quote * qu)}</div>` : ''}</div>
      <div class="hd_grid">${row('Market', esc(nm(m.base) + ' / ' + nm(m.quote)))}${row('When', t.ms ? new Date(t.ms).toLocaleString() + ' · ' + ago(Date.now() - t.ms) : '–')}${row('Ledger', t.ledger ? '#' + t.ledger : '–')}${row('Price', t.price != null ? fmt(t.price) + ' ' + esc(nm(m.quote)) + ' per ' + esc(nm(m.base)) : '–')}${t.price != null && t.price > 0 ? row('Reverse price', fmt(1 / t.price) + ' ' + esc(nm(m.base)) + ' per ' + esc(nm(m.quote))) : ''}${cur != null && t.price ? row('Now vs this trade', `<span class="${cur >= t.price ? 'up' : 'dn'}">${(((cur - t.price) / t.price) * 100).toFixed(2)}%</span>`) : ''}${row('Type', isTr ? (t.kind === 'buy' ? 'Buy of ' + esc(nm(m.base)) : 'Sell of ' + esc(nm(m.base))) : t.kind === 'add' ? 'Liquidity added' : 'Liquidity removed')}${row('Trader', `<a class="who" href="#" onclick="window.dx.who('${esc(t.who)}');return false">${esc(ctx.show(t.who))}</a>`)}${row('Transaction', `<span class="mono" style="word-break:break-all;font-size:.78rem">${esc(t.hash)}</span>`)}</div>
      <div class="row" style="gap:.5rem;margin-top:.8rem"><button class="b pri" onclick="window.dx.tx('${esc(t.hash)}')">Open full transaction</button><button class="b" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(t.hash)}')">Copy hash</button></div></div>`;
  },
  async cancel(seq: number) {
    const r = await ctx.submit({ TransactionType: 'OfferCancel', Account: ctx.account(), OfferSequence: seq });
    ctx.toast(r.ok ? '✓ Order cancelled' : 'Could not cancel: ' + r.msg, !r.ok);
    await loadOrders();
    renderTable();
  },
  async go(btn: HTMLButtonElement) {
    const m = mkt();
    const msg = $('dx_msg');
    const say = (t: string, bad = true) => {
      DX.msg = t;
      DX.msgBad = bad;
      if (msg) {
        msg.textContent = t;
        (msg as any).style.color = bad ? 'var(--crit)' : 'var(--ok)';
      }
    };
    if (!m) return;
    const acc = ctx.account();
    if (!acc) return say('Select or create a wallet first.');
    const buy = DX.side === 'buy';
    const pay = buy ? m.quote : m.base,
      get = buy ? m.base : m.quote;
    if (!isNative(get) && DX.bal && !hasLine(get)) return enableLine(get, btn);
    const x = parseFloat(DX.amt);
    if (!(x > 0)) return say('Enter an amount.');
    if (x > balOf(pay) + 1e-9) return say(`You only have ${fmt(balOf(pay))} ${nm(pay)} available.`);
    btn.disabled = true;
    try {
      let tx: any;
      if (DX.type === 'market') {
        const q = await M.quote(m, DX.side, x);
        if (!q) throw new Error('No liquidity for this size.');
        const min = q.out * (1 - DX.slip / 100);
        tx = { TransactionType: 'OfferCreate', Account: acc, TakerGets: amtTx(pay, x), TakerPays: amtTx(get, min), Flags: 0x00080000 | 0x00020000 };
      } else {
        const p = parseFloat(DX.price);
        if (!(p > 0)) throw new Error('Enter a limit price.');
        const rec = buy ? x / p : x * p;
        tx = { TransactionType: 'OfferCreate', Account: acc, TakerGets: amtTx(pay, x), TakerPays: amtTx(get, rec), Flags: DX.post ? 0x00010000 : 0 };
      }
      const r = await ctx.submit(tx);
      if (r.ok) {
        logOrder({ type: 'OfferCreate', hash: r.hash, ms: Date.now(), gets: tx.TakerGets, pays: tx.TakerPays, res: 'tesSUCCESS' });
        say(`Done. Transaction ${short(r.hash || '', 8, 6)} validated.`, false);
        ctx.toast('✓ ' + (DX.type === 'market' ? 'Swap complete' : 'Order placed'));
        DX.amt = '';
        DX.last = 0;
        await Promise.all([loadBal(), loadOrders()]);
        renderTrade();
        tick();
      } else say('Rejected by the network: ' + r.msg);
    } catch (e: any) {
      say(String(e?.message || e));
    }
    btn.disabled = false;
  },
};
