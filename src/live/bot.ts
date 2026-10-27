// Trading Bot: ONE bot, driven by the connected wallet, working one market (order-book maker or AMM swaps).
// It runs inside Starsky (while the app is open and unlocked) and signs with the active wallet. Nothing is simulated.
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { Asset, akey, amtNum, amtTx, esc, fmt, hexName, isNative, pctHtml, short, usd } from './util.ts';
import { tryReq } from './chain.ts';
import { fromKey } from './util.ts';

const $ = (id: string) => document.getElementById(id);
const setHtml = (id: string, h: string) => {
  const e = $(id) as any;
  if (e && e.__h !== h) {
    e.innerHTML = h;
    e.__h = h;
  }
};
interface Cfg {
  market: string;
  mode: 'maker' | 'amm' | 'both';
  spread: number; // percent either side of the reference price
  every: number; // seconds between actions
  minPct: number; // order size, percent of what the bot may spend
  maxPct: number;
  bias: number; // -100 (sell base) … +100 (buy base)
  ttl: number; // offer lifetime, seconds
  maxOpen: number;
  slip: number; // amm slippage %
  minBase: number; // absolute order size limits in each token (0 = off)
  maxBase: number;
  minQuote: number;
  maxQuote: number;
  lo: number; // only trade while the price is inside [lo, hi] (0 = off)
  hi: number;
}
const DEF: Cfg = { market: '', mode: 'maker', spread: 0.6, every: 20, minPct: 2, maxPct: 8, bias: 0, ttl: 180, maxOpen: 6, slip: 1, minBase: 0, maxBase: 0, minQuote: 0, maxQuote: 0, lo: 0, hi: 0 };
export const BT: any = {
  cfg: { ...DEF } as Cfg,
  running: false,
  busy: false,
  timer: null,
  log: [] as string[],
  stats: { orders: 0, swaps: 0, failed: 0, cancelled: 0, started: 0, fails: 0 },
  start0: null as null | { v: number; q: string },
  wallet: '',
  mk: [] as M.Market[],
  info: null as any,
  offers: [] as any[],
  loaded: false,
};
const SK = () => 'starsky.bot.' + ctx.netKey();
function loadCfg() {
  try {
    BT.cfg = { ...DEF, ...JSON.parse(localStorage.getItem(SK()) || '{}') };
  } catch {
    BT.cfg = { ...DEF };
  }
}
const saveCfg = () => {
  try {
    localStorage.setItem(SK(), JSON.stringify(BT.cfg));
  } catch {}
};
const blog = (m: string) => {
  BT.log.unshift(new Date().toLocaleTimeString() + '  ' + m);
  BT.log.length = Math.min(BT.log.length, 80);
  paintLog();
};
const nm = (a: Asset) => (isNative(a) ? ctx.native() : hexName(a.c));
const mkt = (): M.Market | undefined => BT.mk.find((m: M.Market) => m.id === BT.cfg.market) || (BT.cfg.market === '__all__' ? BT.cur || BT.mk[0] : undefined);
const ALL = '__all__';
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const rnow = () => Math.floor(Date.now() / 1000) - 946684800;

async function balances(m: M.Market) {
  const acc = ctx.account();
  if (!acc) return null;
  const [ai, al, ao, sv]: any[] = await Promise.all([
    tryReq('account_info', { account: acc, ledger_index: 'validated' }),
    tryReq('account_lines', { account: acc, ledger_index: 'validated', limit: 400 }),
    tryReq('account_offers', { account: acc, ledger_index: 'validated', limit: 100 }),
    tryReq('server_info', {}, 15000),
  ]);
  if (!ai || !ai.account_data) return null;
  const v = sv && sv.info && sv.info.validated_ledger;
  const owner = Number(ai.account_data.OwnerCount || 0);
  const reserve = v ? (v.reserve_base_xrp ?? 1) + owner * (v.reserve_inc_xrp ?? 0.2) : 2 + owner * 0.2;
  const native = Number(ai.account_data.Balance) / 1e6;
  const bal = (a: Asset) => {
    if (isNative(a)) return Math.max(0, native - reserve - 0.5);
    const l = ((al && al.lines) || []).find((x: any) => x.currency === a.c && x.account === a.i);
    return l ? Number(l.balance) : 0;
  };
  const has = (a: Asset) => isNative(a) || ((al && al.lines) || []).some((x: any) => x.currency === a.c && x.account === a.i);
  return { base: bal(m.base), quote: bal(m.quote), hasB: has(m.base), hasQ: has(m.quote), native, reserve, offers: ((ao && ao.offers) || []) as any[] };
}
async function refPrice(m: M.Market): Promise<number | null> {
  const refs = await M.poolRefs();
  const dp = M.directPool(refs, m.base, m.quote);
  if (dp) {
    const s = await M.poolState(dp);
    const p = s ? M.poolPrice(s, m.base) : null;
    if (p) return p;
  }
  const b = await M.book(m, 3).catch(() => null);
  if (b && b.asks[0] && b.bids[0]) return (b.asks[0].price + b.bids[0].price) / 2;
  return null;
}
async function tick() {
  if (BT.busy || !BT.running) return;
  BT.busy = true;
  const c: Cfg = BT.cfg;
  try {
    if (c.market === ALL && BT.mk.length) BT.cur = BT.mk[Math.floor(Math.random() * BT.mk.length)];
    const m = mkt();
    if (!m) throw new Error('market not found');
    const mode: 'maker' | 'amm' = c.mode === 'both' ? (Math.random() < 0.5 ? 'amm' : 'maker') : c.mode;
    const acc = ctx.account();
    if (!acc) throw new Error('no wallet selected');
    const b = await balances(m);
    if (!b) throw new Error('the wallet is not funded on this network');
    BT.info = b;
    BT.offers = b.offers;
    const px = await refPrice(m);
    if (!px) throw new Error('no price yet for this market');
    if ((c.lo > 0 && px < c.lo) || (c.hi > 0 && px > c.hi)) {
      blog(`${m.label} at ${fmt(px)} is outside your range ${c.lo || 0} to ${c.hi || '∞'}: waiting`);
      return;
    }
    // tidy: keep at most maxOpen offers
    const mine = b.offers.slice().sort((x: any, y: any) => x.seq - y.seq);
    while (mine.length >= c.maxOpen) {
      const o = mine.shift();
      const r = await ctx.submit({ TransactionType: 'OfferCancel', Account: acc, OfferSequence: o.seq });
      if (r.ok) BT.stats.cancelled++;
      else break;
    }
    let buy = Math.random() < 0.5 + c.bias / 200; // buy the base asset?
    const spend = (x: boolean) => (x ? b.quote : b.base);
    if (spend(buy) <= 0 && spend(!buy) > 0) buy = !buy;
    const avail = spend(buy);
    if (!(avail > 0)) throw new Error('nothing to spend: fund the wallet with ' + nm(m.base) + ' or ' + nm(m.quote));
    const pay = buy ? m.quote : m.base,
      get = buy ? m.base : m.quote;
    if (!(isNative(get) || (buy ? b.hasB : b.hasQ))) throw new Error(`set a trust line for ${nm(get)} first`);
    let x = avail * (rnd(c.minPct, c.maxPct) / 100);
    const lo = buy ? c.minQuote : c.minBase, hi = buy ? c.maxQuote : c.maxBase; // limits are in the token being spent
    if (hi > 0) x = Math.min(x, hi);
    if (lo > 0) x = Math.max(x, lo);
    x = Math.min(x, avail);
    if (lo > 0 && x < lo) throw new Error(`only ${fmt(avail)} ${nm(pay)} available, below your minimum of ${fmt(lo)}`);
    if (mode === 'amm') {
      const q = await M.quote(m, buy ? 'buy' : 'sell', x);
      if (!q) throw new Error('no liquidity');
      const r = await ctx.submit({ TransactionType: 'OfferCreate', Account: acc, TakerGets: amtTx(pay, x), TakerPays: amtTx(get, q.out * (1 - c.slip / 100)), Flags: 0x00080000 | 0x00020000 });
      if (!r.ok) throw new Error(r.msg || 'rejected');
      BT.stats.swaps++;
      BT.stats.fails = 0;
      blog(`swapped ${fmt(x)} ${nm(pay)} → ~${fmt(q.out)} ${nm(get)} via ${q.src}`);
    } else {
      const off = rnd(0.2, 1) * (c.spread / 100);
      const p = px * (buy ? 1 - off : 1 + off); // quote per base
      const rec = buy ? x / p : x * p;
      const r = await ctx.submit({ TransactionType: 'OfferCreate', Account: acc, TakerGets: amtTx(pay, x), TakerPays: amtTx(get, rec), Expiration: rnow() + c.ttl });
      if (!r.ok) throw new Error(r.msg || 'rejected');
      BT.stats.orders++;
      BT.stats.fails = 0;
      blog(`${buy ? 'bid' : 'ask'} ${fmt(buy ? rec : x)} ${nm(m.base)} @ ${fmt(p)} ${nm(m.quote)}`);
    }
  } catch (e: any) {
    BT.stats.failed++;
    BT.stats.fails++;
    blog('⚠ ' + String(e?.message || e));
    if (BT.stats.fails >= 5) {
      stop('stopped after 5 failures in a row');
    }
  } finally {
    BT.busy = false;
    paint();
  }
}
async function valueNow(): Promise<number | null> {
  const m = mkt();
  if (!m || !BT.info) return null;
  const px = await refPrice(m);
  return px ? BT.info.base * px + BT.info.quote : null;
}
function stop(why = 'stopped') {
  BT.running = false;
  clearInterval(BT.timer);
  blog(why);
  paint();
}
async function loadMarkets() {
  BT.mk = M.marketsFrom(await M.poolRefs());
  if (!BT.cfg.market || (BT.cfg.market !== ALL && !mkt())) BT.cfg.market = (BT.mk.find((x: M.Market) => x.label === `${ctx.native()}/${ctx.usdName()}` || x.label.startsWith(ctx.native())) || BT.mk[0] || { id: '' }).id;
}
function paintLog() {
  setHtml('bt_log', BT.log.map((l: string) => `<div>${esc(l)}</div>`).join('') || '<div class="mut">Nothing yet. Press Start.</div>');
}
async function paint() {
  const m = mkt();
  const s = BT.stats;
  const run = BT.running;
  setHtml('bt_status', `<span class="chip ${run ? '' : 'bad'}">${run ? (BT.busy ? 'WORKING' : 'RUNNING') : 'STOPPED'}</span>`);
  const btn = $('bt_go');
  if (btn) {
    btn.textContent = run ? 'Stop bot' : 'Start bot';
    btn.className = run ? 'bad' : 'pri acc';
  }
  if (m && ctx.account() && ctx.online()) {
    try {
      const b = (await balances(m)) || null;
      if (b) {
        BT.info = b;
        BT.offers = b.offers;
      }
    } catch {}
  }
  const b = BT.info;
  let pnl = '–';
  const v = await valueNow().catch(() => null);
  if (v != null && BT.start0 && BT.start0.q) pnl = (v - BT.start0.v >= 0 ? '+' : '') + fmt(v - BT.start0.v) + ' ' + BT.start0.q;
  setHtml(
    'bt_tiles',
    [
      ['Bot wallet', esc(ctx.wallets().find(w => w.address === ctx.account())?.label || short(ctx.account() || '', 6, 4)), esc(short(ctx.show(ctx.account() || ''), 8, 6))],
      [`${m ? nm(m.base) : ''} available`, b ? fmt(b.base) : '–', 'after reserves'],
      [`${m ? nm(m.quote) : ''} available`, b ? fmt(b.quote) : '–', 'after reserves'],
      ['Actions', fmt(s.orders + s.swaps, 0), `${s.orders} orders · ${s.swaps} swaps · ${s.cancelled} cancelled`],
      ['Failures', fmt(s.failed, 0), 'total this session'],
      ['Value change', pnl, v != null ? 'portfolio value ' + fmt(v) + ' ' + nm(m!.quote) : 'since start'],
      ['Uptime', s.started && run ? Math.floor((Date.now() - s.started) / 60000) + ' min' : '–', run ? `every ${BT.cfg.every}s` : ''],
    ]
      .map(([k, vv, sub]) => `<div class="tile kvt"><div class="k">${k}</div><div class="big2">${vv}</div><div class="mut" style="font-size:.78rem">${sub}</div></div>`)
      .join('')
  );
  const offs: any[] = BT.offers || [];
  setHtml(
    'bt_offers',
    offs.length
      ? `<table class="dxt"><thead><tr><th>#</th><th>Selling</th><th>For</th><th class="r">Price</th></tr></thead><tbody>${offs.map(o => { const g = amtNum(o.taker_gets), p = amtNum(o.taker_pays); const cg = typeof o.taker_gets === 'string' ? ctx.native() : hexName(o.taker_gets.currency); const cp = typeof o.taker_pays === 'string' ? ctx.native() : hexName(o.taker_pays.currency); return `<tr><td class="mut">${o.seq}</td><td>${fmt(g)} ${esc(cg)}</td><td>${fmt(p)} ${esc(cp)}</td><td class="r mono">${g ? fmt(p / g) : '–'}</td></tr>`; }).join('')}</tbody></table>`
      : '<div class="mut" style="padding:.6rem">No open offers.</div>'
  );
  paintLog();
  paintPrices();
}
function paintLean() {
  const c: Cfg = BT.cfg, m = mkt() || BT.mk[0];
  const t = $('bt_leant');
  if (!t) return;
  const buy = Math.round(50 + c.bias / 2);
  const base = c.market === ALL ? 'each market\u2019s base token' : m ? nm(m.base) : '';
  const q = c.market === ALL ? 'its pair token' : m ? nm(m.quote) : '';
  t.innerHTML = `<b>${c.bias === 0 ? 'Neutral' : c.bias > 0 ? 'Leaning to buy' : 'Leaning to sell'}</b>: buys ${esc(base)} ${buy}% of the time (paying ${esc(q)}), sells ${esc(base)} ${100 - buy}% (receiving ${esc(q)}). Changes apply on the next action, no restart.`;
}
let prAt = 0;
async function paintPrices() {
  if (!$('bt_prices') || Date.now() - prAt < 15000) return;
  prAt = Date.now();
  try {
    const sn = await M.snapshot();
    const ws = await M.windowSnaps();
    const un = sn.usdPerNative;
    const w1 = ws.find(z => z.w.k === '1h'), w24 = ws.find(z => z.w.k === '24h');
    const px = (s: M.Snap, k: string) => (k === 'native' ? 1 : s.px.get(k) ?? null);
    const usdp = (s: M.Snap, k: string) => (px(s, k) != null && s.usdPerNative != null ? px(s, k)! * s.usdPerNative : px(s, k));
    const ch = (w: M.WinSnap | undefined, k: string) => {
      const a = usdp(sn, k), b = w ? usdp(w.snap, k) : null;
      return a == null || b == null || !(b > 0) ? null : (a / b - 1) * 100;
    };
    const keys = ['native', ...[...sn.px.keys()].filter(k => k !== 'native')];
    const rows = keys
      .map(k => ({ k, a: fromKey(k) as Asset }))
      .filter(r => !M.isOldUsd(r.a))
      .map(r => `<tr><td><b>${esc(M.labelOf(r.a))}</b></td><td class="r mono">${usdp(sn, r.k) != null ? (un != null ? usd(usdp(sn, r.k)) : fmt(usdp(sn, r.k), 6)) : '–'}</td><td class="r mono">${px(sn, r.k) != null ? fmt(px(sn, r.k), 6) + ' ' + esc(ctx.native()) : '–'}</td><td class="r">${pctHtml(ch(w1, r.k))}</td><td class="r">${pctHtml(ch(w24, r.k))}</td></tr>`)
      .join('');
    setHtml('bt_prices', `<table class="dxt"><thead><tr><th>Token</th><th class="r">Price</th><th class="r">In ${esc(ctx.native())}</th><th class="r">1h</th><th class="r">24h</th></tr></thead><tbody>${rows}</tbody></table>`);
  } catch {}
}
export function botShell() {
  if (!BT.loaded) {
    loadCfg();
    BT.loaded = true;
  }
  const c: Cfg = BT.cfg;
  const num = (id: string, label: string, v: number, step: string, hint = '') => `<label class="btf"><span>${label}</span><input id="${id}" type="number" step="${step}" value="${v}" onchange="window.bt.set('${id}',this.value)">${hint ? `<small class="mut">${hint}</small>` : ''}</label>`;
  return `<div id="bt" class="nwpage">
    <div class="card" style="margin-bottom:1rem"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:.6rem">
      <div><div class="k" style="margin:0">Trading bot <span id="bt_status"></span></div><div class="mut" style="font-size:.82rem;margin-top:.3rem">One bot, run by your connected wallet. It makes real trades on the selected market. It works while Starsky stays open and unlocked.</div></div>
      <button id="bt_go" class="pri acc" onclick="window.bt.toggle()">Start bot</button></div></div>
    <div class="pgrid nwk" id="bt_tiles"></div>
    <div class="card" style="margin-top:1rem"><div class="k">Buy / sell lean</div><div class="row" style="align-items:center;gap:.7rem"><span class="mut">sell</span><input type="range" min="-100" max="100" step="5" value="${c.bias}" oninput="window.bt.lean(this.value)" style="flex:1"><span class="mut">buy</span></div><div id="bt_leant" style="font-size:.84rem;margin-top:.3rem"></div></div>
    <div class="card" style="margin-top:1rem"><div class="k">Token prices</div><div id="bt_prices" class="nwscroll" style="max-height:18rem"><div class="mut">Reading prices…</div></div></div>
    <div class="nwg3" style="margin-top:1rem;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr)">
      <div class="card"><div class="k">Settings</div>
        <div class="btgrid">
          <label class="btf" style="grid-column:1/-1"><span>Market</span><select id="bt_market" onchange="window.bt.set('bt_market',this.value)"><option value="__all__" ${c.market === '__all__' ? 'selected' : ''}>ALL markets (rotates through every pool)</option>${BT.mk.map((m: M.Market) => `<option value="${esc(m.id)}" ${m.id === c.market ? 'selected' : ''}>${esc(m.label)}</option>`).join('') || '<option>Loading…</option>'}</select></label>
          <label class="btf" style="grid-column:1/-1"><span>Strategy</span><select id="bt_mode" onchange="window.bt.set('bt_mode',this.value)"><option value="maker" ${c.mode === 'maker' ? 'selected' : ''}>Order-book market maker (posts bids and asks around the pool price)</option><option value="both" ${c.mode === 'both' ? 'selected' : ''}>Both: order book and AMM swaps together</option><option value="amm" ${c.mode === 'amm' ? 'selected' : ''}>AMM swaps (small swaps through the pool and book)</option></select></label>
          ${num('bt_spread', 'Spread ±%', c.spread, '0.1', 'distance of offers from the price')}
          ${num('bt_every', 'Every (seconds)', c.every, '1', 'minimum 5')}
          ${num('bt_min', 'Min size %', c.minPct, '0.5', 'of what the wallet can spend')}
          ${num('bt_max', 'Max size %', c.maxPct, '0.5', 'at most 50')}
          ${num('bt_bias', 'Bias', c.bias, '5', '-100 sell … +100 buy')}
          ${num('bt_ttl', 'Offer life (s)', c.ttl, '10', 'offers expire on their own')}
          ${num('bt_open', 'Max open offers', c.maxOpen, '1', 'oldest are cancelled')}
          ${num('bt_slip', 'Swap slippage %', c.slip, '0.1', 'AMM mode')}
          ${num('bt_minb', 'Min amount, base token', c.minBase, 'any', 'per order, 0 = off')}
          ${num('bt_maxb', 'Max amount, base token', c.maxBase, 'any', 'per order, 0 = off')}
          ${num('bt_minq', 'Min amount, quote token', c.minQuote, 'any', 'per order, 0 = off')}
          ${num('bt_maxq', 'Max amount, quote token', c.maxQuote, 'any', 'per order, 0 = off')}
          ${num('bt_lo', 'Trade only above price', c.lo, 'any', 'range low, 0 = off')}
          ${num('bt_hi', 'Trade only below price', c.hi, 'any', 'range high, 0 = off')}
        </div>
        <div id="bt_msg" class="mut" style="font-size:.8rem;margin-top:.5rem"></div></div>
      <div class="card"><div class="k">Open offers <button class="sm ghost" style="float:right" onclick="window.bt.cancelAll(this)">Cancel all</button></div><div id="bt_offers" class="nwscroll"></div></div>
    </div>
    <div class="card" style="margin-top:1rem"><div class="k">Activity log</div><div id="bt_log" class="mono nwscroll" style="font-size:.78rem;max-height:16rem"></div></div></div>`;
}
export async function botMount() {
  if (!BT.loaded) {
    loadCfg();
    BT.loaded = true;
  }
  if (ctx.online() && !BT.mk.length) {
    try {
      await loadMarkets();
      const e = $('bt');
      if (e) {
        const sel = $('bt_market') as HTMLSelectElement | null;
        if (sel) sel.innerHTML = `<option value="__all__" ${BT.cfg.market === '__all__' ? 'selected' : ''}>ALL markets (rotates through every pool)</option>` + BT.mk.map((m: M.Market) => `<option value="${esc(m.id)}" ${m.id === BT.cfg.market ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
      }
    } catch {}
  }
  paint();
  paintLean();
  paintPrices();
}
export const btApi = {
  set(id: string, v: string) {
    const c: Cfg = BT.cfg;
    const n = parseFloat(v);
    const msg = $('bt_msg');
    const bad = (t: string) => {
      if (msg) msg.textContent = t;
    };
    if (msg) msg.textContent = '';
    if (id === 'bt_market') {
      c.market = v;
      BT.cur = null;
      paintLean();
    } else if (id === 'bt_mode') c.mode = v as any;
    else if (!(n === n)) return bad('Enter a number.');
    else if (id === 'bt_spread') c.spread = Math.max(0.05, Math.min(20, n));
    else if (id === 'bt_every') c.every = Math.max(5, Math.min(3600, Math.round(n)));
    else if (id === 'bt_min') c.minPct = Math.max(0.1, Math.min(50, n));
    else if (id === 'bt_max') c.maxPct = Math.max(0.1, Math.min(50, n));
    else if (id === 'bt_bias') c.bias = Math.max(-100, Math.min(100, n));
    else if (id === 'bt_ttl') c.ttl = Math.max(30, Math.min(3600, Math.round(n)));
    else if (id === 'bt_open') c.maxOpen = Math.max(1, Math.min(20, Math.round(n)));
    else if (id === 'bt_slip') c.slip = Math.max(0.1, Math.min(20, n));
    else if (id === 'bt_minb') c.minBase = Math.max(0, n);
    else if (id === 'bt_maxb') c.maxBase = Math.max(0, n);
    else if (id === 'bt_minq') c.minQuote = Math.max(0, n);
    else if (id === 'bt_maxq') c.maxQuote = Math.max(0, n);
    else if (id === 'bt_lo') c.lo = Math.max(0, n);
    else if (id === 'bt_hi') c.hi = Math.max(0, n);
    if (c.minPct > c.maxPct) c.maxPct = c.minPct;
    if (c.minBase && c.maxBase && c.minBase > c.maxBase) c.maxBase = c.minBase;
    if (c.minQuote && c.maxQuote && c.minQuote > c.maxQuote) c.maxQuote = c.minQuote;
    saveCfg();
    if (BT.running) {
      clearInterval(BT.timer);
      BT.timer = setInterval(tick, c.every * 1000);
    }
  },
  lean(v: string) {
    BT.cfg.bias = Math.max(-100, Math.min(100, Math.round(+v)));
    saveCfg();
    const n = $('bt_bias') as HTMLInputElement | null;
    if (n) n.value = String(BT.cfg.bias);
    paintLean();
  },
  async toggle() {
    if (BT.running) return stop('stopped by you');
    const m = mkt();
    const msg = $('bt_msg');
    if (!m) return void (msg && (msg.textContent = 'Pick a market first.'));
    if (!ctx.account()) return void (msg && (msg.textContent = 'Select a wallet first.'));
    const w = ctx.wallets().find(x => x.address === ctx.account());
    if (!w || w.type !== 'luma') return void (msg && (msg.textContent = 'The bot works with a LUMA wallet. Switch to LUMA mode.'));
    BT.running = true;
    BT.stats = { orders: 0, swaps: 0, failed: 0, cancelled: 0, started: Date.now(), fails: 0 };
    const b = await balances(m).catch(() => null);
    if (b) BT.info = b;
    const v = await valueNow().catch(() => null);
    BT.start0 = v != null ? { v, q: nm(m.quote) } : null;
    BT.wallet = ctx.account();
    clearInterval(BT.timer);
    BT.timer = setInterval(tick, BT.cfg.every * 1000);
    blog(`started on ${BT.cfg.market === ALL ? 'all markets' : m.label} (${BT.cfg.mode === 'amm' ? 'AMM swaps' : BT.cfg.mode === 'both' ? 'order book and AMM' : 'order book'}) with ${w.label}`);
    tick();
    paint();
  },
  async cancelAll(btn: HTMLButtonElement) {
    const acc = ctx.account();
    if (!acc) return;
    btn.disabled = true;
    let n = 0;
    for (const o of BT.offers || []) {
      const r = await ctx.submit({ TransactionType: 'OfferCancel', Account: acc, OfferSequence: o.seq });
      if (r.ok) n++;
    }
    BT.stats.cancelled += n;
    blog(`cancelled ${n} offers`);
    btn.disabled = false;
    paint();
  },
};
export const botRunning = () => BT.running;
void akey;
void usd;
