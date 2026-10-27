// Leverage trading (1x to 100x), synthetic positions settled in LUMA against the genesis wallet.
//
// HOW IT WORKS (all on the ledger, nothing hidden):
//  - OPEN:  the trader pays the collateral (LUMA) to the genesis wallet with a memo `luma-margin` {op:'open', m, s, x, sl, tp}.
//           The entry price is the AMM-pool price of that asset (in LUMA) at the ledger that validated the payment, so anyone can verify it.
//  - EDIT / CLOSE: a 1-drop payment to genesis with a memo {op:'edit'|'close', id}.
//  - SETTLE: the genesis wallet pays the trader what is left (equity) with a memo {op:'settle', id, why, px, pnl, pay}.
//           why = close | sl | tp | liq | reject. A liquidation pays nothing: the collateral already sits in the genesis wallet.
//  - The genesis OPERATOR (this app, while the genesis wallet is unlocked in the vault and the operator switch is on) watches prices
//    and settles stop losses, take profits, liquidations and close requests. Without a running operator nothing settles automatically.
// RISK: prices come from AMM pools; thin pools can be pushed around. Leverage is limited by pool depth for that reason.
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { Asset, akey, esc, fmt, fromKey, hexName, isNative, pctHtml, short, usd, ago, rippleToMs } from './util.ts';
import { cached, pool as poolMap, tryReq, header } from './chain.ts';
import { detectGenesis } from './supply.ts';
import { chartSvg } from './dexchart.ts';

export const MEMO = 'luma-margin';
export const FEE_OPEN = 0.0005; // of notional, at open
export const FEE_CLOSE = 0.0005; // of notional, at close
export const FUND_H = 0.0001; // of notional, per hour
export const MMR = 0.005; // maintenance margin, of notional
export const MIN_COLLATERAL = 1; // LUMA
export const MAX_NOTIONAL_TVL = 0.03; // one position may be at most 3% of the asset's pool value
export const OI_CAP_GENESIS = 0.25; // all open notional together at most 25% of the genesis balance
const hex = (s: string) => Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const unhex = (h: string) => {
  try {
    return new TextDecoder().decode(new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16))));
  } catch {
    return '';
  }
};
export const maxLeverage = (tvlN: number) => (tvlN >= 1e6 ? 100 : tvlN >= 2e5 ? 50 : tvlN >= 5e4 ? 25 : tvlN >= 1e4 ? 10 : tvlN > 0 ? 5 : 1);

export interface Pos {
  id: string;
  trader: string;
  key: string; // asset key
  long: boolean;
  lev: number;
  coll: number;
  sl: number;
  tp: number;
  ms: number;
  seq: number;
  pe: number; // entry price, LUMA per 1 asset
  n: number; // notional, LUMA
  status: 'open' | 'closed';
  closeReq: boolean;
  why: string;
  px: number;
  pay: number;
  pnl: number;
  endMs: number;
  settleHash: string;
  bad: string; // reason an open was rejected
}
export interface Live {
  p: Pos;
  mark: number | null;
  pnl: number;
  equity: number;
  fees: number;
  funding: number;
  liq: number;
  ratio: number;
  roe: number;
}
/** liquidation price for given entry, leverage and side (fees at open included) */
export const liqPrice = (pe: number, lev: number, long: boolean) => (long ? Math.max(0, pe * (1 - 1 / lev + FEE_OPEN + MMR)) : pe * (1 + 1 / lev - FEE_OPEN - MMR));
export function evalPos(p: Pos, mark: number | null, now = Date.now()): Live {
  const m = mark ?? p.pe;
  const ratio0 = m / p.pe;
  const pnl = p.n * (p.long ? ratio0 - 1 : 1 - ratio0);
  const hrs = Math.max(0, (now - p.ms) / 3600e3);
  const funding = p.n * FUND_H * hrs;
  const fees = p.n * FEE_OPEN;
  const equity = p.coll + pnl - fees - funding;
  const mm = p.n * MMR;
  return { p, mark, pnl, equity, fees, funding, liq: liqPrice(p.pe, p.lev, p.long), ratio: equity > 0 ? Math.min(2, mm / equity) : 2, roe: p.coll ? pnl / p.coll : 0 };
}
export const payoutOn = (l: Live) => Math.max(0, l.equity - l.p.n * FEE_CLOSE);

/* ----------------------------- chain reading ----------------------------- */
interface Ev {
  hash: string;
  from: string;
  to: string;
  seq: number;
  ms: number;
  amt: number;
  d: any;
  pe?: number; // entry price once resolved (kept for good)
}
// small key/value store: the browser's localStorage, or a JSON file when the operator runs in Node
export interface KV {
  get(k: string): string | null;
  set(k: string, v: string): void;
}
let kv: KV = {
  get: k => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
export const setKV = (x: KV) => {
  kv = x;
};
const EVK = (a: string) => 'starsky.margin.ev.' + ctx.netKey() + '.' + a;
interface Store {
  last: number;
  evs: Ev[];
}
const loadStore = (a: string): Store => {
  try {
    const j = JSON.parse(kv.get(EVK(a)) || 'null');
    if (j && Array.isArray(j.evs)) return j;
  } catch {}
  try {
    const j = JSON.parse(kv.get(EVK(a) + '.bak') || 'null');
    if (j && Array.isArray(j.evs)) return j;
  } catch {}
  return { last: 0, evs: [] };
};
const saveStore = (a: string, st: Store) => {
  const j = JSON.stringify(st);
  kv.set(EVK(a), j);
  kv.set(EVK(a) + '.bak', j); // second copy: a damaged primary entry never loses positions
};
const stores = new Map<string, Store>();
/** Every margin memo that touches `account`, kept on disk and topped up incrementally, so old positions never fall off the node's recent-history window. */
async function events(account: string, maxPages = 250): Promise<Ev[]> {
  const st = stores.get(account) || loadStore(account);
  stores.set(account, st);
  const si: any = await tryReq('server_info', {}, 4000);
  const now = si && si.info && si.info.validated_ledger ? Number(si.info.validated_ledger.seq) : 0;
  const min = st.last > 6 ? st.last - 6 : -1;
  const got: Ev[] = [];
  let marker: any;
  let done = true;
  for (let i = 0; i < maxPages; i++) {
    const r: any = await tryReq('account_tx', { account, limit: 200, ledger_index_min: min, ledger_index_max: -1, ...(marker ? { marker } : {}) }, 8000);
    if (!r) {
      if (i === 0) {
        MG.stale = true;
        if (st.evs.length || st.last) return st.evs; // node did not answer: keep showing what we saved
        throw new Error('node API did not answer (account_tx)');
      }
      done = false;
      break;
    }
    MG.stale = false;
    for (const t of r.transactions || []) {
      const x = t.tx_json || t.tx || {};
      if (x.TransactionType !== 'Payment') continue;
      const meta = t.meta || t.metaData || {};
      if ((meta.TransactionResult || 'tesSUCCESS') !== 'tesSUCCESS') continue;
      for (const mm of x.Memos || []) {
        if (unhex(mm.Memo?.MemoType || '') !== MEMO) continue;
        try {
          const d = JSON.parse(unhex(mm.Memo?.MemoData || ''));
          const da = meta.delivered_amount ?? x.Amount;
          const ms = x.date != null ? rippleToMs(x.date) : t.close_time_iso ? Date.parse(t.close_time_iso) : t.date != null ? rippleToMs(t.date) : Date.now();
          got.push({ hash: t.hash || x.hash, from: x.Account, to: x.Destination, seq: Number(x.ledger_index || t.ledger_index || 0), ms, amt: typeof da === 'string' ? Number(da) / 1e6 : 0, d });
        } catch {}
      }
    }
    marker = r.marker;
    if (!marker) break;
    if (i === maxPages - 1) done = false;
  }
  const have = new Map(st.evs.map(e => [e.hash, e]));
  for (const e of got) if (!have.has(e.hash)) have.set(e.hash, e);
  st.evs = [...have.values()].sort((a, b) => a.seq - b.seq || a.ms - b.ms);
  if (done && now) st.last = now;
  saveStore(account, st);
  return st.evs;
}
const persistEvs = (account: string) => {
  const st = stores.get(account);
  if (st) saveStore(account, st);
};
const priceCache = new Map<string, number | null>();
async function priceAt(key: string, seq: number): Promise<number | null> {
  const k = key + '@' + seq;
  if (priceCache.has(k)) return priceCache.get(k)!;
  let p: number | null = null;
  try {
    const sn = await M.snapshot(seq);
    p = sn.px.get(key) ?? null;
  } catch {}
  if (p != null) priceCache.set(k, p);
  return p;
}
/** entry price: the pool price at the ledger of the open payment; if the node no longer has that ledger, the price written in the memo, as long as it is close to today's price */
async function entryPrice(e: Ev, key: string): Promise<number | null> {
  if (e.pe && e.pe > 0) return e.pe;
  const led = await priceAt(key, e.seq);
  const memo = Number(e.d.pe) || 0;
  let pe: number | null = null;
  if (led != null && led > 0) pe = memo > 0 && Math.abs(memo / led - 1) < 0.005 ? memo : led;
  else if (memo > 0) {
    const now = markOf(key);
    if (now != null && Math.abs(memo / now - 1) < 0.25) pe = memo;
  }
  if (pe != null) e.pe = pe;
  return pe;
}
export async function derive(evs: Ev[], genesis: string): Promise<Pos[]> {
  const pos = new Map<string, Pos>();
  let dirty = false;
  for (const e of evs) {
    const d = e.d;
    if (d.op === 'open' && e.to === genesis) {
      const key = String(d.m || '');
      const lev = Number(d.x);
      const had = !!e.pe;
      const pe = await entryPrice(e, key);
      if (!had && e.pe) dirty = true;
      let bad = '';
      if (!(lev >= 1 && lev <= 100)) bad = 'leverage must be 1 to 100';
      else if (!(e.amt >= MIN_COLLATERAL)) bad = `collateral below the minimum of ${MIN_COLLATERAL} LUMA`;
      else if (pe == null && Date.now() - e.ms > 6 * 3600e3) bad = 'no price for this asset';
      pos.set(e.hash, { id: e.hash, trader: e.from, key, long: d.s === 'L', lev: lev >= 1 ? lev : 1, coll: e.amt, sl: Number(d.sl) || 0, tp: Number(d.tp) || 0, ms: e.ms, seq: e.seq, pe: pe || 0, n: e.amt * (lev >= 1 ? lev : 1), status: 'open', closeReq: false, why: '', px: 0, pay: 0, pnl: 0, endMs: 0, settleHash: '', bad });
    } else if (d.op === 'edit' && e.to === genesis) {
      const p = pos.get(d.id);
      if (p && p.trader === e.from && p.status === 'open') {
        if (d.sl !== undefined) p.sl = Number(d.sl) || 0;
        if (d.tp !== undefined) p.tp = Number(d.tp) || 0;
      }
    } else if (d.op === 'close' && e.to === genesis) {
      const p = pos.get(d.id);
      if (p && p.trader === e.from && p.status === 'open') p.closeReq = true;
    } else if (d.op === 'settle' && e.from === genesis) {
      const p = pos.get(d.id);
      if (p && p.status === 'open' && p.trader === e.to) {
        p.status = 'closed';
        p.why = String(d.why || 'close');
        p.px = Number(d.px) || 0;
        p.pay = Number(d.pay) || e.amt;
        p.pnl = Number(d.pnl) || 0;
        p.endMs = e.ms;
        p.settleHash = e.hash;
      }
    }
  }
  if (dirty) for (const k of stores.keys()) persistEvs(k);
  return [...pos.values()];
}
export const G: any = { addr: '', at: 0, total: 0 };
export const setGenesis = (a: string) => {
  G.addr = a;
  G.at = Date.now() + 365 * 86400e3;
};
export async function genesis(): Promise<string> {
  if (G.addr && Date.now() - G.at < 60000) return G.addr;
  const h = await header('validated');
  const sn = await M.snapshot().catch(() => null);
  const hold = await M.holders({ c: 'native', i: '' } as Asset, h ? h.total : 0, new Set(sn ? sn.pools.map(p => p.account) : [])).catch(() => null);
  const g = await detectGenesis(h ? h.total : 0, hold);
  G.addr = g.addr;
  G.at = Date.now();
  return G.addr;
}
export const MG: any = { stale: false, mine: [] as Pos[], all: [] as Pos[], px: null as M.Snap | null, at: 0, loading: false, alerts: [] as string[], tvl: new Map<string, number>(), op: false, opTimer: null, opLog: [] as string[], opBusy: false, gbal: 0, lastSettle: 0, warned: new Map<string, number>(), err: '' };
const nat = () => ctx.native();
const nm = (k: string) => (k === 'native' ? nat() : hexName(fromKey(k).c));
export const markOf = (key: string): number | null => (MG.px ? MG.px.px.get(key) ?? null : null);
function tvlOfAsset(sn: M.Snap, key: string): number {
  let t = 0;
  for (const p of sn.pools) {
    const ka = akey(p.a),
      kb = akey(p.b);
    if (ka !== key && kb !== key) continue;
    const pa = sn.px.get(ka),
      pb = sn.px.get(kb);
    t += (pa != null ? p.ra * pa : pb != null ? p.rb * pb : 0) * 2;
  }
  return t;
}
export async function refresh(force = false) {
  if (MG.loading || (!force && Date.now() - MG.at < 4000)) return;
  MG.loading = true;
  try {
    const g = await genesis();
    const acc = ctx.account();
    MG.px = await M.snapshot();
    MG.tvl = new Map();
    for (const k of MG.px.px.keys()) if (k !== 'native') MG.tvl.set(k, tvlOfAsset(MG.px, k));
    if (g) {
      const r: any = await tryReq('account_info', { account: g, ledger_index: 'validated' }, 5000);
      MG.gbal = r && r.account_data ? Number(r.account_data.Balance) / 1e6 : 0;
    }
    if (acc && g) {
      // an empty list with a saved history, or half an hour since the last full read, triggers a full re-read from the chain
      const sv = stores.get(acc);
      if (sv && sv.last && (Date.now() - lastFull > 1800e3 || (!sv.evs.length && Date.now() - lastFull > 60e3))) {
        lastFull = Date.now();
        sv.last = 0;
      }
      MG.mine = await derive(await events(acc), g);
    }
    else MG.mine = [];
    MG.err = g ? '' : 'The genesis wallet was not found on this network, so leverage is not available.';
    MG.at = Date.now();
    alerts();
  } catch (e: any) {
    MG.err = 'Node API error: ' + String(e?.message || e) + '. Showing the last saved data.';
  }
  MG.loading = false;
  paintAll();
}
/** Forget the saved copy and read every leverage memo for this wallet again from the chain (memos hold the position id, terms and SL/TP, so nothing is lost). */
export async function recall(): Promise<void> {
  const acc = ctx.account();
  if (!acc) return;
  stores.delete(acc);
  const st: Store = { last: 0, evs: [] };
  stores.set(acc, st);
  saveStore(acc, st);
  ctx.toast('Recalling leverage positions from the chain…', false);
  await refresh(true);
  const n = (MG.mine as Pos[]).length;
  ctx.toast(n ? `Recalled ${n} position(s) from the chain.` : 'No leverage memos found for this wallet on this network.', !n);
}
let lastFull = Date.now();
export const liveList = (ps: Pos[]) => ps.map(p => evalPos(p, markOf(p.key)));
/* ----------------------------- alerts ----------------------------- */
function alerts() {
  const out: string[] = [];
  for (const l of liveList(MG.mine.filter((p: Pos) => p.status === 'open' && !p.bad))) {
    const lbl = `${l.p.long ? 'Long' : 'Short'} ${l.p.lev}x ${nm(l.p.key)}`;
    const lvl = l.ratio >= 0.8 ? 2 : l.ratio >= 0.6 ? 1 : 0;
    if (lvl) out.push(`${lvl === 2 ? 'DANGER' : 'Warning'}: ${lbl} is at ${(l.ratio * 100).toFixed(0)}% of its liquidation margin (liquidation at ${fmt(l.liq)} LUMA, now ${fmt(l.mark ?? 0)}).`);
    const last = MG.warned.get(l.p.id) || 0;
    if (lvl > last) {
      MG.warned.set(l.p.id, lvl);
      ctx.toast(`${lvl === 2 ? '⚠ Liquidation danger' : 'Margin warning'}: ${lbl}`, true);
      try {
        if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') new Notification('Starsky margin alert', { body: `${lbl} is close to liquidation.` });
      } catch {}
    }
    if (l.p.closeReq) out.push(`${lbl}: close requested, waiting for the operator to settle.`);
  }
  for (const p of MG.mine) {
    if (p.status === 'closed' && p.why === 'liq' && Date.now() - p.endMs < 3600e3 && !MG.warned.has('liq' + p.id)) {
      MG.warned.set('liq' + p.id, 9);
      ctx.toast(`Liquidated: ${p.long ? 'Long' : 'Short'} ${p.lev}x ${nm(p.key)}`, true);
    }
  }
  if (MG.stale) out.push('The node did not answer the last history request. Showing the last saved data; nothing is lost.');
  const waiting = MG.mine.filter((p: Pos) => p.status === 'open' && !p.bad && (p.closeReq || liveList([p])[0].ratio >= 1));
  if (waiting.length && !MG.op) out.push('No operator is running, so close requests and liquidations are waiting. Open the Leverage page and press Start operator (needs the genesis wallet in this vault), or run the standalone operator (see README).');
  MG.alerts = out;
}
export const mgRecall = recall;
export function askNotify() {
  try {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } catch {}
}
/* ----------------------------- trading ----------------------------- */
const memo = (d: any) => ({ Memos: [{ Memo: { MemoType: hex(MEMO), MemoData: hex(JSON.stringify(d)), MemoFormat: hex('application/json') } }] });
export interface Ticket {
  key: string;
  long: boolean;
  lev: number;
  coll: number;
  sl: number;
  tp: number;
}
export function check(t: Ticket): string {
  const mark = markOf(t.key);
  if (mark == null || !(mark > 0)) return 'No price for this asset: it needs a pool priced in ' + nat() + '.';
  if (!(t.coll >= MIN_COLLATERAL)) return `Collateral must be at least ${MIN_COLLATERAL} ${nat()}.`;
  const tvl = MG.tvl.get(t.key) || 0;
  const ml = maxLeverage(tvl);
  if (!(t.lev >= 1 && t.lev <= ml)) return `This market allows up to ${ml}x (pool value ${fmt(tvl)} ${nat()}).`;
  if (t.coll * t.lev > tvl * MAX_NOTIONAL_TVL) return `Position too large for the pool: at most ${fmt(tvl * MAX_NOTIONAL_TVL)} ${nat()} notional.`;
  if (t.sl && (t.long ? t.sl >= mark : t.sl <= mark)) return `Stop loss must be ${t.long ? 'below' : 'above'} the current price ${fmt(mark)}.`;
  if (t.tp && (t.long ? t.tp <= mark : t.tp >= mark)) return `Take profit must be ${t.long ? 'above' : 'below'} the current price ${fmt(mark)}.`;
  if (t.sl && (t.long ? t.sl <= liqPrice(mark, t.lev, true) : t.sl >= liqPrice(mark, t.lev, false))) return 'Stop loss is beyond the liquidation price, so it could never trigger.';
  if (G.total && t.coll * t.lev > MG.gbal * OI_CAP_GENESIS) return 'Position larger than the genesis wallet can cover.';
  return '';
}
export async function open(t: Ticket): Promise<{ ok: boolean; msg: string }> {
  const err = check(t);
  if (err) return { ok: false, msg: err };
  const g = await genesis();
  if (!g) return { ok: false, msg: 'The genesis wallet was not found.' };
  askNotify();
  const r = await ctx.submit({ TransactionType: 'Payment', Account: ctx.account(), Destination: g, Amount: String(Math.round(t.coll * 1e6)), ...memo({ v: 1, op: 'open', pe: markOf(t.key), m: t.key, s: t.long ? 'L' : 'S', x: t.lev, sl: t.sl || 0, tp: t.tp || 0 }) });
  if (!r.ok) return { ok: false, msg: r.msg || 'rejected' };
  MG.at = 0;
  setTimeout(() => refresh(true), 800);
  return { ok: true, msg: 'Position opened at the current pool price (tx ' + short(String(r.hash || ''), 6, 4) + ').' };
}
async function opMemo(d: any, ok: string) {
  const g = await genesis();
  const r = await ctx.submit({ TransactionType: 'Payment', Account: ctx.account(), Destination: g, Amount: '1', ...memo({ v: 1, ...d }) });
  if (!r.ok) return ctx.toast('Rejected: ' + (r.msg || 'failed'), true);
  ctx.toast('✓ ' + ok);
  MG.at = 0;
  refresh(true);
}
/* ----------------------------- operator (genesis) ----------------------------- */
const OPK = () => 'starsky.margin.operator.' + ctx.netKey();
export const operatorSeed = async (): Promise<{ seed: string; address: string } | null> => {
  const g = await genesis();
  if (!g) return null;
  const w = ctx.wallets().find(x => x.type === 'luma' && x.seed && ctx.toClassic(x.address) === g);
  return w ? { seed: w.seed, address: g } : null;
};
const olog = (m: string) => {
  if (typeof document === 'undefined') console.log(new Date().toISOString() + '  ' + m);
  MG.opLog.unshift(new Date().toLocaleTimeString() + '  ' + m);
  MG.opLog.length = Math.min(MG.opLog.length, 60);
};
async function operatorTick() {
  if (MG.opBusy || !MG.op) return;
  MG.opBusy = true;
  try {
    const op = await operatorSeed();
    if (!op) throw new Error('the genesis wallet is not in this vault');
    const sn = await M.snapshot();
    MG.px = sn;
    const evs = await events(op.address);
    const all = await derive(evs, op.address);
    MG.all = all;
    const bal0: any = await tryReq('account_info', { account: op.address, ledger_index: 'validated' }, 3000);
    MG.gbal = bal0 && bal0.account_data ? Number(bal0.account_data.Balance) / 1e6 : MG.gbal;
    const openN = all.filter(p => p.status === 'open' && !p.bad).reduce((s, p) => s + p.n, 0);
    for (const p of all) {
      if (p.status !== 'open') continue;
      let why = '',
        pay = 0,
        px = markOf(p.key) ?? p.pe,
        pnl = 0;
      if (!p.bad && !(p.pe > 0)) continue; // entry price not known yet
      if (p.bad) {
        why = 'reject';
        pay = p.coll;
        px = p.pe;
      } else {
        const l = evalPos(p, markOf(p.key));
        pnl = l.pnl;
        const tvl = MG.tvl.get(p.key) ?? tvlOfAsset(sn, p.key);
        if (p.lev > maxLeverage(tvl) || p.n > tvl * MAX_NOTIONAL_TVL * 1.0001 || openN > MG.gbal * OI_CAP_GENESIS * 1.0001) {
          if (Date.now() - p.ms < 120000) {
            why = 'reject';
            pay = p.coll;
            px = p.pe;
            pnl = 0;
          }
        }
        if (!why) {
          if (l.equity <= p.n * MMR) why = 'liq';
          else if (p.closeReq) why = 'close';
          else if (p.sl && (p.long ? px <= p.sl : px >= p.sl)) why = 'sl';
          else if (p.tp && (p.long ? px >= p.tp : px <= p.tp)) why = 'tp';
          if (why === 'liq') pay = 0;
          else if (why) pay = payoutOn(l);
        }
      }
      if (!why) continue;
      // never settle twice: look at the chain again right before paying
      const again = await derive(await events(op.address), op.address);
      if (again.find(x => x.id === p.id)?.status !== 'open') continue;
      if (pay > MG.gbal - 1) {
        olog(`cannot pay ${fmt(pay)} to ${short(ctx.show(p.trader), 6, 4)}: genesis balance too low`);
        continue;
      }
      const r = await ctx.submitAs(op.seed, { TransactionType: 'Payment', Account: op.address, Destination: p.trader, Amount: String(Math.max(1, Math.round(pay * 1e6))), ...memo({ v: 1, op: 'settle', id: p.id, why, px, pnl: +pnl.toFixed(6), pay: +pay.toFixed(6) }) });
      olog(`${why.toUpperCase()} ${p.long ? 'long' : 'short'} ${p.lev}x ${nm(p.key)} for ${short(ctx.show(p.trader), 6, 4)} at ${fmt(px)}: paid ${fmt(pay)} ${nat()}${r.ok ? '' : ' FAILED ' + r.msg}`);
      MG.lastSettle = Date.now();
    }
  } catch (e: any) {
    olog('⚠ ' + String(e?.message || e));
  }
  MG.opBusy = false;
  paintAll();
}
export function setOperator(on: boolean) {
  MG.op = on;
  kv.set(OPK(), on ? '1' : '0');
  MG.userOff = !on;
  clearInterval(MG.opTimer);
  if (on) {
    MG.opTimer = setInterval(operatorTick, 6000);
    olog('operator started');
    operatorTick();
  } else olog('operator stopped');
  paintAll();
}
export async function autoOperator() {
  try {
    if (MG.op || MG.userOff) return;
    if ((kv.get(OPK()) ?? '0') === '1' && (await operatorSeed())) setOperator(true);
  } catch {}
}
/* ----------------------------- UI helpers ----------------------------- */
const $ = (id: string) => (typeof document === 'undefined' ? null : document.getElementById(id));
const setHtml = (id: string, h: string) => {
  const e = $(id) as any;
  if (e && e.__h !== h) {
    e.innerHTML = h;
    e.__h = h;
  }
};
const dur = (ms: number) => {
  const m = Math.floor(ms / 60000);
  return m < 60 ? m + ' min' : m < 2880 ? (m / 60).toFixed(1) + ' h' : (m / 1440).toFixed(1) + ' d';
};
const px = (v: number | null | undefined) => (v == null || !isFinite(v) || v === 0 ? '–' : fmt(v, v < 1 ? 6 : 4));
const pnlTxt = (v: number) => `<span class="${v >= 0 ? 'up' : 'dn'}">${v >= 0 ? '+' : ''}${fmt(v, 4)}</span>`;
const WHY: Record<string, string> = { close: 'Closed', sl: 'Stop loss', tp: 'Take profit', liq: 'Liquidated', reject: 'Rejected (refunded)' };
const bar = (r: number) => `<div class="mgbar" title="${(r * 100).toFixed(0)}% of the way to liquidation"><i style="width:${Math.min(100, r * 100)}%;background:${r >= 0.8 ? '#ff453a' : r >= 0.6 ? '#ffb020' : '#00e07e'}"></i></div>`;
export function openRows(list: Live[], actions = true) {
  return `<table class="dxt"><thead><tr><th>Market</th><th>Side</th><th class="r">Size (${nat()})</th><th class="r">Entry</th><th class="r">Mark</th><th class="r">Liq. price</th><th class="r">SL / TP</th><th class="r">PnL</th><th class="r">ROE</th><th>Margin</th>${actions ? '<th></th>' : ''}</tr></thead><tbody>${
    list
      .map(
        l => `<tr><td><b>${esc(nm(l.p.key))}</b><br><small class="mut">${ago(Date.now() - l.p.ms)}</small></td><td><span class="chip ${l.p.long ? '' : 'bad'}">${l.p.long ? 'LONG' : 'SHORT'} ${l.p.lev}x</span></td><td class="r">${fmt(l.p.n)}<br><small class="mut">margin ${fmt(l.p.coll)}</small></td><td class="r mono">${px(l.p.pe)}</td><td class="r mono">${px(l.mark)}</td><td class="r mono dn">${px(l.liq)}</td><td class="r mono">${l.p.sl ? px(l.p.sl) : '–'} / ${l.p.tp ? px(l.p.tp) : '–'}</td><td class="r">${pnlTxt(l.pnl)}<br><small class="mut">equity ${fmt(l.equity, 3)}</small></td><td class="r">${pctHtml(l.roe * 100)}</td><td style="min-width:6rem">${bar(l.ratio)}<small class="mut">${l.p.closeReq ? 'closing…' : (l.ratio * 100).toFixed(0) + '% of liq.'}</small></td>${actions ? `<td class="r"><button class="sm" onclick="window.mg.edit('${l.p.id}')">SL/TP</button> <button class="sm dng" ${l.p.closeReq ? 'disabled' : ''} onclick="window.mg.close('${l.p.id}',this)">Close</button></td>` : ''}</tr>`
      )
      .join('') || `<tr><td colspan="${actions ? 11 : 10}" class="mut" style="padding:1rem">No open leveraged positions.</td></tr>`
  }</tbody></table>`;
}
export function histRows(list: Pos[]) {
  return `<table class="dxt"><thead><tr><th>Market</th><th>Side</th><th class="r">Size</th><th class="r">Entry</th><th class="r">Exit</th><th>Result</th><th class="r">PnL</th><th class="r">Paid out</th><th class="r">Held</th><th class="r">Closed</th></tr></thead><tbody>${
    list
      .map(p => `<tr><td><b>${esc(nm(p.key))}</b></td><td><span class="chip ${p.long ? '' : 'bad'}">${p.long ? 'LONG' : 'SHORT'} ${p.lev}x</span></td><td class="r">${fmt(p.n)}</td><td class="r mono">${px(p.pe)}</td><td class="r mono">${px(p.px)}</td><td><span class="chip ${p.why === 'liq' ? 'bad' : p.why === 'tp' ? '' : 'b'}">${esc(WHY[p.why] || p.why)}</span></td><td class="r">${p.why === 'reject' ? '–' : pnlTxt(p.pay - p.coll)}</td><td class="r">${fmt(p.pay, 4)}</td><td class="r mut">${dur(p.endMs - p.ms)}</td><td class="r mut">${ago(Date.now() - p.endMs)}</td></tr>`)
      .join('') || '<tr><td colspan="10" class="mut" style="padding:1rem">No closed positions yet.</td></tr>'
  }</tbody></table>`;
}
const stats = (live: Live[], closed: Pos[]) => {
  const eq = live.reduce((s, l) => s + l.equity, 0);
  const upnl = live.reduce((s, l) => s + l.pnl, 0);
  const used = live.reduce((s, l) => s + l.p.coll, 0);
  const real = closed.filter(p => p.why !== 'reject').reduce((s, p) => s + (p.pay - p.coll), 0);
  const liqs = closed.filter(p => p.why === 'liq').length;
  const usdv = (v: number) => (MG.px && MG.px.usdPerNative != null ? `<br><small class="mut">${usd(v * MG.px.usdPerNative)}</small>` : '');
  return [
    ['Open positions', fmt(live.length, 0), ''],
    ['Margin in use', fmt(used, 2) + ' ' + nat(), usdv(used)],
    ['Equity', fmt(eq, 2) + ' ' + nat(), usdv(eq)],
    ['Unrealized PnL', `<span class="${upnl >= 0 ? 'up' : 'dn'}">${upnl >= 0 ? '+' : ''}${fmt(upnl, 4)}</span> ${nat()}`, usdv(upnl)],
    ['Realized PnL', `<span class="${real >= 0 ? 'up' : 'dn'}">${real >= 0 ? '+' : ''}${fmt(real, 4)}</span> ${nat()}`, `${closed.filter(p => p.why !== 'reject').length} closed · ${liqs} liquidated`],
  ]
    .map(([k, v, s]) => `<div class="tile kvt"><div class="k">${k}</div><div class="big2">${v}</div><div class="mut" style="font-size:.78rem">${s}</div></div>`)
    .join('');
};
const alertBox = () => (MG.alerts.length ? `<div class="card" style="border-color:rgba(255,176,32,.5);margin-bottom:1rem"><div class="k" style="color:#ffb020">Alerts</div>${MG.alerts.map((a: string) => `<div style="margin:.2rem 0">${esc(a)}</div>`).join('')}</div>` : '');
/* ----- portfolio card ----- */
export function portfolioShell() {
  return `<div class="card" style="margin-top:1rem" id="mg_pcard"><div class="row" style="justify-content:space-between"><div class="k" style="margin:0">Leverage positions</div><button class="sm" onclick="window.goTab('margin')">Open leverage page</button></div><div id="mg_pf"></div></div>`;
}
/* ----- full page ----- */
export function pageShell() {
  return `<div id="mgp" class="nwpage">
    <div id="mg_alerts"></div>
    <div class="row" style="margin-bottom:.6rem;align-items:center;gap:.6rem"><button class="sm" onclick="window.mg.recall()">Recall positions from chain</button><span class="mut" style="font-size:.76rem">Every position is stored on the ledger as a memo with its ID. This re-reads them all, so nothing is ever lost.</span></div>
    <div class="pgrid nwk" id="mg_stats" style="margin-bottom:1rem"></div>
    <div class="card"><div class="k">Open positions</div><div id="mg_open" class="nwscroll" style="max-height:24rem"></div></div>
    <div class="card" style="margin-top:1rem"><div class="row" style="align-items:center;gap:.6rem;flex-wrap:wrap"><div class="k" style="margin:0">Chart</div><select id="mg_cpair" onchange="window.mg.chartPair(this.value)"></select><div class="seg" id="mg_crange"></div><span class="mut" style="font-size:.74rem">Entry, liquidation, stop loss and take profit lines of your positions are drawn on the chart.</span></div><div id="mg_chart" style="margin-top:.5rem;min-height:260px"></div></div>
    <div class="nwh">Position history</div><div class="card nwscroll" id="mg_hist" style="max-height:26rem"></div>
    <div class="nwg3" style="margin-top:1rem;grid-template-columns:repeat(2,minmax(0,1fr))">
      <div class="card"><div class="k">Markets and limits</div><div id="mg_mk" class="nwscroll"></div></div>
      <div class="card"><div class="k">Operator (genesis wallet)</div><div id="mg_op"></div></div></div>
    <div class="card" style="margin-top:1rem"><div class="k">How the math works</div><div id="mg_math" class="mut" style="font-size:.86rem;line-height:1.6"></div></div></div>`;
}
const mathHtml = () => `<b>Size</b> = margin × leverage. <b>PnL</b> (long) = size × (price ÷ entry − 1); (short) = size × (1 − price ÷ entry). Prices are LUMA per 1 asset, from the AMM pool.<br>
<b>Equity</b> = margin + PnL − open fee (${(FEE_OPEN * 100).toFixed(2)}% of size) − funding (${(FUND_H * 100).toFixed(2)}% of size per hour). <b>Close fee</b> ${(FEE_CLOSE * 100).toFixed(2)}% of size.<br>
<b>Liquidation</b> when equity ≤ ${(MMR * 100).toFixed(1)}% of size. Long liquidation price = entry × (1 − 1/leverage + ${(FEE_OPEN * 100).toFixed(2)}% + ${(MMR * 100).toFixed(1)}%); short = entry × (1 + 1/leverage − ${(FEE_OPEN * 100).toFixed(2)}% − ${(MMR * 100).toFixed(1)}%). A liquidated position pays nothing; the margin stays in the genesis wallet.<br>
<b>You can never lose more than your margin.</b> Stop loss and take profit close the position at the first price the operator sees beyond your level, so a fast move can fill worse than your level.<br>
<b>Max leverage</b> depends on the asset's pool value (in ${nat()}): ≥1M → 100x, ≥200k → 50x, ≥50k → 25x, ≥10k → 10x, below → 5x. One position may be at most ${(MAX_NOTIONAL_TVL * 100).toFixed(0)}% of the pool value, and all open positions together at most ${(OI_CAP_GENESIS * 100).toFixed(0)}% of the genesis balance.`;
function paintAll() {
  const live = liveList(MG.mine.filter((p: Pos) => p.status === 'open' && !p.bad));
  const closed: Pos[] = MG.mine.filter((p: Pos) => p.status === 'closed').sort((a: Pos, b: Pos) => b.endMs - a.endMs);
  if ($('mgp')) {
    setHtml('mg_alerts', alertBox() + (MG.err ? `<div class="card crit">${esc(MG.err)}</div>` : ''));
    setHtml('mg_stats', stats(live, closed));
    setHtml('mg_open', openRows(live));
    setHtml('mg_hist', histRows(closed));
    const rows = [...MG.tvl.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    setHtml('mg_mk', `<table class="dxt"><thead><tr><th>Asset</th><th class="r">Price (${nat()})</th><th class="r">Pool value</th><th class="r">Max leverage</th><th class="r">Max size</th></tr></thead><tbody>${rows.map(([k, v]) => `<tr><td><b>${esc(nm(k))}</b></td><td class="r mono">${px(markOf(k))}</td><td class="r">${fmt(v, 0)}</td><td class="r">${maxLeverage(v)}x</td><td class="r">${fmt(v * MAX_NOTIONAL_TVL, 0)}</td></tr>`).join('') || '<tr><td colspan="5" class="mut">No priced assets.</td></tr>'}</tbody></table>`);
    setHtml('mg_math', mathHtml());
    paintOp();
    drawChart();
  }
  if ($('mg_pf')) {
    setHtml('mg_pf', `<div class="pgrid nwk" style="margin:.6rem 0">${stats(live, closed)}</div>${alertBox()}<div class="nwscroll" style="max-height:18rem">${openRows(live, true)}</div>`);
  }
  if (onChange) onChange();
  if ($('dx_pos')) {
    setHtml('dx_pos', `<div class="pgrid nwk" style="margin:.3rem 0 .6rem">${stats(live, closed)}</div>${alertBox()}${openRows(live)}<div class="k" style="margin:.8rem 0 .3rem">History</div>${histRows(closed.slice(0, 40))}`);
  }
}
async function paintOp() {
  const op = await operatorSeed();
  const all: Pos[] = MG.all;
  const open = all.filter(p => p.status === 'open' && !p.bad);
  const longN = open.filter(p => p.long).reduce((s, p) => s + p.n, 0);
  const shortN = open.filter(p => !p.long).reduce((s, p) => s + p.n, 0);
  const upn = open.reduce((s, p) => s + evalPos(p, markOf(p.key)).pnl, 0);
  const body = op
    ? `<div class="row" style="gap:.6rem;align-items:center;flex-wrap:wrap"><button id="mg_opbtn" class="${MG.op ? 'bad' : 'pri acc'}" onclick="window.mg.operator()">${MG.op ? 'Stop operator' : 'Start operator'}</button><span class="chip ${MG.op ? '' : 'bad'}">${MG.op ? (MG.opBusy ? 'WORKING' : 'RUNNING') : 'STOPPED'}</span><small class="mut">Settles stop losses, take profits, liquidations and closes for everyone, paying from the genesis wallet. Keep Starsky open.</small></div>
      <div class="pgrid nwk" style="margin:.7rem 0"><div class="tile kvt"><div class="k">Genesis balance</div><div class="big2">${fmt(MG.gbal, 2)}</div></div><div class="tile kvt"><div class="k">Open size</div><div class="big2">${fmt(longN + shortN, 0)}</div><small class="mut">${open.length} positions</small></div><div class="tile kvt"><div class="k">Long / short</div><div class="big2">${fmt(longN, 0)} / ${fmt(shortN, 0)}</div><small class="mut">net ${fmt(longN - shortN, 0)}</small></div><div class="tile kvt"><div class="k">Traders' unrealized PnL</div><div class="big2">${pnlTxt(upn)}</div><small class="mut">genesis side: ${pnlTxt(-upn)}</small></div></div>
      <div class="mono nwscroll" style="font-size:.76rem;max-height:12rem">${MG.opLog.map((l: string) => `<div>${esc(l)}</div>`).join('') || '<span class="mut">No settlements yet.</span>'}</div>`
    : `<div class="mut">The operator needs the genesis wallet (${MG.gbal ? esc(short(ctx.show(G.addr), 8, 6)) : 'not found'}) in this vault. Import its seed under Wallets and the operator controls appear here. Without a running operator, stop loss, take profit, liquidation and close requests wait.</div>
      <div class="mut" style="margin-top:.5rem">Last settlement seen on the ledger: ${MG.mine.filter((p: Pos) => p.status === 'closed').length ? ago(Date.now() - Math.max(...MG.mine.filter((p: Pos) => p.status === 'closed').map((p: Pos) => p.endMs))) : 'none yet'}.</div>`;
  setHtml('mg_op', body);
}
const CH: any = { key: '', range: '1h', at: 0, busy: false, cd: null, ck: '' };
async function drawChart() {
  const el = $('mg_chart') as HTMLElement | null;
  if (!el || CH.busy) return;
  const sel = $('mg_cpair') as HTMLSelectElement | null;
  const keys = [...MG.tvl.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  if (!keys.length) return;
  const open = (MG.mine as Pos[]).find(p => p.status === 'open' && !p.bad);
  if (!CH.key || !keys.includes(CH.key)) CH.key = open && keys.includes(open.key) ? open.key : keys[0];
  if (sel && sel.options.length !== keys.length) sel.innerHTML = keys.map(k => `<option value="${esc(k)}">${esc(nm(k))}/${esc(nat())}</option>`).join('');
  if (sel) sel.value = CH.key;
  const rg = $('mg_crange');
  if (rg) rg.innerHTML = M.RANGES.map(r => `<button class="${CH.range === r.k ? 'on' : ''}" onclick="window.mg.chartRange('${r.k}')">${r.label}</button>`).join('');
  const range = M.RANGES.find(r => r.k === CH.range) || M.RANGES[2];
  const ck = CH.key + '|' + range.k;
  if (CH.ck !== ck || Date.now() - CH.at > 20000) {
    CH.busy = true;
    try {
      const pools = await M.poolRefs();
      const mk = M.marketsFrom(pools).find(m => akey(m.base) === CH.key && isNative(m.quote));
      CH.cd = mk ? await M.candles(mk, range) : null;
      CH.ck = ck;
      CH.at = Date.now();
    } catch {
      CH.cd = null;
    }
    CH.busy = false;
  }
  if (!CH.cd || !CH.cd.list.length) return void (el.innerHTML = '<div class="mut" style="padding:1rem">No chart data for this pair yet.</div>');
  const lines = chartLines(CH.key, false).filter(l => !l.drag || true);
  el.innerHTML = chartSvg(CH.cd.list, { scale: 'log', sma: true, style: 'candle', ema: false, boll: false, rangeSec: range.sec, lines, h: 420 } as any, markOf(CH.key)).svg;
}
export function pageMount() {
  refresh(true);
  setTimeout(drawChart, 300);
  paintAll();
}
/* ----- DEX ticket ----- */
export const TK: any = { long: true, lev: 10, coll: '', sl: '', tp: '', key: '', msg: '', bad: true };
export function ticketHtml(key: string, asLong: boolean, label: string) {
  TK.key = key;
  TK.long = asLong;
  const tvl = MG.tvl.get(key) || 0;
  const ml = maxLeverage(tvl);
  if (TK.lev > ml) TK.lev = ml;
  const mark = markOf(key);
  const coll = parseFloat(TK.coll) || 0;
  const N = coll * TK.lev;
  const lq = mark ? liqPrice(mark, TK.lev, asLong) : 0;
  const sl = parseFloat(TK.sl) || 0,
    tp = parseFloat(TK.tp) || 0;
  const slLoss = mark && sl ? Math.min(coll, N * Math.abs(1 - sl / mark) + N * (FEE_OPEN + FEE_CLOSE)) : null;
  const tpGain = mark && tp ? N * Math.abs(tp / mark - 1) - N * (FEE_OPEN + FEE_CLOSE) : null;
  const err = coll > 0 ? check({ key, long: asLong, lev: TK.lev, coll, sl, tp }) : '';
  const quick = [1, 2, 5, 10, 25, 50, 100].filter(x => x <= ml);
  return `<div class="mgt">
    <div class="mut" style="font-size:.78rem">Leveraged ${asLong ? 'long' : 'short'} on <b>${esc(label)}</b>, priced in ${nat()}: ${mark ? fmt(mark, 6) : '–'} ${nat()} per unit.</div>
    <div class="dxbox"><div class="k">LEVERAGE <b id="mg_lv" style="float:right;font-size:1rem">${TK.lev}x</b></div><input type="range" min="1" max="${ml}" step="1" value="${TK.lev}" oninput="window.mg.lev(this.value)" style="width:100%"><div class="row" style="gap:.25rem;flex-wrap:wrap;margin-top:.3rem">${quick.map(x => `<button class="sm ${TK.lev === x ? 'pri' : 'ghost'}" onclick="window.mg.lev(${x},true)">${x}x</button>`).join('')}</div><small class="mut">Up to ${ml}x for this asset (pool value ${fmt(tvl, 0)} ${nat()}).</small></div>
    <div class="dxbox"><div class="k">MARGIN (${nat()}) <span style="float:right;text-transform:none"><a href="#" onclick="window.mg.pct(25);return false">25%</a> · <a href="#" onclick="window.mg.pct(50);return false">50%</a> · <a href="#" onclick="window.mg.pct(100);return false">MAX</a></span></div><div class="dxin"><input id="mg_coll" inputmode="decimal" placeholder="min ${MIN_COLLATERAL}" value="${esc(TK.coll)}" oninput="window.mg.coll(this.value)"></div></div>
    <div class="btgrid"><label class="btf"><span>Stop loss (${nat()}/unit)</span><input id="mg_sl" inputmode="decimal" value="${esc(TK.sl)}" placeholder="optional" oninput="window.mg.sl(this.value)"></label><label class="btf"><span>Take profit</span><input id="mg_tp" inputmode="decimal" value="${esc(TK.tp)}" placeholder="optional" oninput="window.mg.tp(this.value)"></label></div>
    <div class="row" style="gap:.25rem;margin:.3rem 0">${[2, 5, 10].map(p => `<button class="sm ghost" onclick="window.mg.slp(${p})">SL −${p}%</button>`).join('')}${[5, 10, 25].map(p => `<button class="sm ghost" onclick="window.mg.tpp(${p})">TP +${p}%</button>`).join('')}</div>
    <div class="kvt2" id="mg_calc">
      <div><span>Size</span><b>${fmt(N, 2)} ${nat()}</b></div><div><span>Entry (now)</span><b>${mark ? fmt(mark, 6) : '–'}</b></div>
      <div><span>Liquidation price</span><b class="dn">${lq ? fmt(lq, 6) : '–'}</b></div><div><span>Distance to liquidation</span><b>${mark && lq ? (Math.abs(1 - lq / mark) * 100).toFixed(2) + '%' : '–'}</b></div>
      <div><span>Fees (open + close)</span><b>${fmt(N * (FEE_OPEN + FEE_CLOSE), 4)}</b></div><div><span>Funding per hour</span><b>${fmt(N * FUND_H, 5)}</b></div>
      <div><span>Max loss</span><b class="dn">${fmt(coll, 4)}</b></div><div><span>${slLoss != null ? 'Loss at stop' : 'Stop loss'}</span><b>${slLoss != null ? fmt(slLoss, 4) : '–'}</b></div>
      <div><span>${tpGain != null ? 'Gain at target' : 'Take profit'}</span><b class="up">${tpGain != null ? fmt(tpGain, 4) : '–'}</b></div><div><span>Reward : risk</span><b>${slLoss && tpGain ? (tpGain / slLoss).toFixed(2) : '–'}</b></div></div>
    <button class="pri ${asLong ? 'acc' : 'sellgo'} dxgo" onclick="window.mg.go(this)" ${!ctx.online() || !ctx.account() ? 'disabled' : ''}>${asLong ? 'Open long' : 'Open short'} ${TK.lev}x</button>
    <div class="mut" id="mg_msg" style="font-size:.78rem;margin-top:.4rem;color:${TK.bad ? 'var(--crit)' : 'var(--ok)'}">${esc(TK.msg || err)}</div>
    <div class="mut" style="font-size:.72rem;margin-top:.4rem">Margin is sent to the genesis wallet. The operator settles stop loss, take profit, liquidation and closes. You cannot lose more than your margin.</div></div>`;
}
export const mgApi: any = {
  chartPair(k: string) { CH.key = k; CH.ck = ''; drawChart(); },
  chartRange(r: string) { CH.range = r; CH.ck = ''; drawChart(); },
  recall() { return recall(); },
  rerender: () => {},
  lev(v: any, redraw = false) {
    TK.lev = Math.max(1, Math.round(+v));
    TK.msg = '';
    const e = $('mg_lv');
    if (e) e.textContent = TK.lev + 'x';
    mgApi.rerender(redraw);
  },
  coll(v: string) { TK.coll = v; TK.msg = ''; mgApi.rerender(false); },
  sl(v: string) { TK.sl = v; TK.msg = ''; mgApi.rerender(false); },
  tp(v: string) { TK.tp = v; TK.msg = ''; mgApi.rerender(false); },
  slp(p: number) { const m = markOf(TK.key); if (m) TK.sl = String(+(m * (TK.long ? 1 - p / 100 : 1 + p / 100)).toPrecision(6)); mgApi.rerender(true); },
  tpp(p: number) { const m = markOf(TK.key); if (m) TK.tp = String(+(m * (TK.long ? 1 + p / 100 : 1 - p / 100)).toPrecision(6)); mgApi.rerender(true); },
  async pct(p: number) {
    const r: any = await tryReq('account_info', { account: ctx.account(), ledger_index: 'validated' }, 2000);
    if (!r || !r.account_data) return;
    const free = Math.max(0, Number(r.account_data.Balance) / 1e6 - 1 - 0.02 * Number(r.account_data.OwnerCount || 0));
    TK.coll = String(Math.floor(free * p) / 100 === 0 ? 0 : +((free * p) / 100).toFixed(4));
    mgApi.rerender(true);
  },
  async go(btn: HTMLButtonElement) {
    btn.disabled = true;
    const r = await open({ key: TK.key, long: TK.long, lev: TK.lev, coll: parseFloat(TK.coll) || 0, sl: parseFloat(TK.sl) || 0, tp: parseFloat(TK.tp) || 0 });
    TK.bad = !r.ok;
    TK.msg = r.msg;
    if (r.ok) { TK.coll = ''; TK.sl = ''; TK.tp = ''; ctx.toast('✓ Position opened'); }
    btn.disabled = false;
    mgApi.rerender(true);
  },
  close(id: string, btn: HTMLButtonElement) {
    if (!confirm('Close this position at the current price? The operator settles it and pays out what is left.')) return;
    btn.disabled = true;
    opMemo({ op: 'close', id }, 'Close requested');
  },
  edit(id: string) {
    const p: Pos | undefined = MG.mine.find((x: Pos) => x.id === id);
    if (!p) return;
    ctx.modal(`<h2>Stop loss / take profit</h2><p class="mut">${esc(nm(p.key))} ${p.long ? 'long' : 'short'} ${p.lev}x, entry ${px(p.pe)}, liquidation ${px(liqPrice(p.pe, p.lev, p.long))}. Leave empty to remove. Sends a 1-drop update to the genesis wallet.</p>
      <div class="btgrid"><label class="btf"><span>Stop loss</span><input id="me_sl" value="${p.sl || ''}"></label><label class="btf"><span>Take profit</span><input id="me_tp" value="${p.tp || ''}"></label></div>
      <div class="row" style="margin-top:1rem"><button class="grow" onclick="window.closeModal()">Cancel</button><button class="pri acc grow" onclick="window.mg.saveEdit('${id}')">Save</button></div>`);
  },
  saveEdit(id: string) {
    const p: Pos | undefined = MG.mine.find((x: Pos) => x.id === id);
    if (!p) return;
    const sl = parseFloat(($('me_sl') as HTMLInputElement).value) || 0,
      tp = parseFloat(($('me_tp') as HTMLInputElement).value) || 0;
    const m = markOf(p.key) ?? p.pe;
    if (sl && (p.long ? sl >= m : sl <= m)) return ctx.toast('Stop loss is on the wrong side of the price.', true);
    if (tp && (p.long ? tp <= m : tp >= m)) return ctx.toast('Take profit is on the wrong side of the price.', true);
    ctx.closeModal();
    opMemo({ op: 'edit', id, sl, tp }, 'Updated');
  },
  operator() { setOperator(!MG.op); },
};
export const paintNow = () => paintAll();
let onChange: (() => void) | null = null;
export const setOnChange = (f: () => void) => {
  onChange = f;
};
export interface CL {
  id: string;
  price: number;
  color: string;
  label: string;
  drag?: boolean;
  dash?: string;
}
/** lines for the DEX chart: the draft in the ticket plus every open position on this asset */
export function chartLines(key: string, ticketOn: boolean): CL[] {
  const out: CL[] = [];
  for (const p of MG.mine as Pos[]) {
    if (p.status !== 'open' || p.bad || p.key !== key || !(p.pe > 0)) continue;
    const t = `${p.long ? 'LONG' : 'SHORT'} ${p.lev}x`;
    out.push({ id: 'e:' + p.id, price: p.pe, color: '#9a92b8', label: 'ENTRY ' + t, dash: '2 4' });
    out.push({ id: 'l:' + p.id, price: liqPrice(p.pe, p.lev, p.long), color: '#ff453a', label: 'LIQ ' + t });
    const liqp = liqPrice(p.pe, p.lev, p.long);
    // no stop yet: a suggested one halfway between entry and liquidation, drag it to set it (you confirm before anything is sent)
    out.push({ id: 'p:' + p.id + ':sl', price: p.sl || p.pe + (liqp - p.pe) * 0.5, color: '#ffb020', label: p.sl ? 'SL ' + t : 'SL ' + t + ' (suggested, drag to set)', drag: true, dash: p.sl ? undefined : '6 4' });
    out.push({ id: 'p:' + p.id + ':tp', price: p.tp || p.pe + (p.pe - liqp) * 0.5, color: '#00e07e', label: p.tp ? 'TP ' + t : 'TP ' + t + ' (suggested, drag to set)', drag: true, dash: p.tp ? undefined : '6 4' });
  }
  const mark = markOf(key);
  const coll = parseFloat(TK.coll) || 0;
  if (ticketOn && mark && coll > 0 && TK.key === key) {
    out.push({ id: 'd:ent', price: mark, color: '#c9c2e6', label: 'NEW ' + (TK.long ? 'LONG' : 'SHORT') + ' ' + TK.lev + 'x', dash: '2 4' });
    out.push({ id: 'd:liq', price: liqPrice(mark, TK.lev, TK.long), color: '#ff453a', label: 'LIQ (drag = leverage)', drag: true });
    const sl = parseFloat(TK.sl) || 0,
      tp = parseFloat(TK.tp) || 0;
    if (sl) out.push({ id: 'd:sl', price: sl, color: '#ffb020', label: 'STOP LOSS', drag: true });
    if (tp) out.push({ id: 'd:tp', price: tp, color: '#00e07e', label: 'TAKE PROFIT', drag: true });
  }
  return out;
}
/** a line was dropped at `price` */
export function dragEnd(id: string, price: number): void {
  const pr = +price.toPrecision(6);
  if (id.startsWith('d:')) {
    const mark = markOf(TK.key);
    if (id === 'd:sl') TK.sl = String(pr);
    else if (id === 'd:tp') TK.tp = String(pr);
    else if (id === 'd:liq' && mark) {
      const f = FEE_OPEN + MMR;
      const inv = TK.long ? 1 + f - pr / mark : pr / mark - 1 + f;
      const ml = maxLeverage(MG.tvl.get(TK.key) || 0);
      TK.lev = Math.max(1, Math.min(ml, Math.round(inv > 0 ? 1 / inv : ml)));
    }
    TK.msg = '';
    mgApi.rerender(true);
    return;
  }
  const [, pid, field] = id.split(':');
  const p: Pos | undefined = MG.mine.find((x: Pos) => x.id === pid);
  if (!p) return;
  const m = markOf(p.key) ?? p.pe;
  if (field === 'sl' && (p.long ? pr >= m : pr <= m)) return void ctx.toast('Stop loss must stay on the losing side of the price.', true);
  if (field === 'tp' && (p.long ? pr <= m : pr >= m)) return void ctx.toast('Take profit must stay on the winning side of the price.', true);
  if (field === 'sl' && (p.long ? pr <= liqPrice(p.pe, p.lev, true) : pr >= liqPrice(p.pe, p.lev, false))) return void ctx.toast('That stop loss is beyond the liquidation price.', true);
  const liq = liqPrice(p.pe, p.lev, p.long),
    sgn = p.long ? 1 : -1,
    pct = sgn * (pr / p.pe - 1) * 100,
    atPnl = p.n * sgn * (pr / p.pe - 1),
    dm = Math.abs(pr / m - 1) * 100,
    dl = Math.abs(pr / liq - 1) * 100;
  const warn = [];
  if (field === 'sl' && dm < 0.5) warn.push('This stop is within 0.5% of the current price and may trigger right away.');
  if (field === 'sl' && dl < 1.5) warn.push('This stop is very close to the liquidation price; a fast move could liquidate before it fills.');
  if (field === 'sl' && atPnl < -p.coll * 0.9) warn.push('At this level you would lose most of your margin.');
  const rr = p.sl && field === 'tp' ? Math.abs(atPnl) / Math.max(1e-9, Math.abs(p.n * sgn * (p.sl / p.pe - 1))) : p.tp && field === 'sl' ? Math.abs(p.n * sgn * (p.tp / p.pe - 1)) / Math.max(1e-9, Math.abs(atPnl)) : 0;
  const msg = `Move the ${field === 'sl' ? 'STOP LOSS' : 'TAKE PROFIT'} of this ${p.long ? 'long' : 'short'} ${p.lev}x ${nm(p.key)} to ${fmt(pr, 6)}?\n\nNow ${fmt(m, 6)} (${dm.toFixed(2)}% away) · entry ${fmt(p.pe, 6)} · liquidation ${fmt(liq, 6)}\nIf it fills: ${atPnl >= 0 ? 'profit' : 'loss'} about ${fmt(Math.abs(atPnl), 2)} ${nat()} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% of price, ${(atPnl / p.coll * 100).toFixed(0)}% of your margin)${rr ? `\nReward to risk: ${rr.toFixed(2)} : 1` : ''}${warn.length ? '\n\nWarning:\n- ' + warn.join('\n- ') : ''}\n\nThis sends a 1-drop update (the smallest amount possible) with the position ID to the genesis wallet.`;
  if (!confirm(msg)) return void (onChange && onChange());
  opMemo({ op: 'edit', id: pid, [field]: pr }, 'Updated');
}
export async function startMonitor() {
  autoOperator();
  refresh(false);
}
let mon: any = null;
export function monitor() {
  if (mon) return;
  mon = setInterval(() => {
    if (ctx.online()) autoOperator();
    if (ctx.online() && ctx.account()) refresh(false);
  }, 10000);
  startMonitor();
}
void cached;
void poolMap;
void isNative;
