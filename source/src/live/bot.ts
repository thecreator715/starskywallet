// Trading Bot v2: one engine run by the connected wallet. It works while Starsky stays open and unlocked and signs with the active wallet.
// Everything it does is a real transaction: AMM deposits and withdrawals, order-book offers, AMM swaps and triangular arbitrage. Nothing is simulated.
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import * as BP from './botplus.ts';
import { Asset, NATIVE, akey, amtNum, amtTx, esc, fmt, fromKey, hexName, isNative, short, usd } from './util.ts';
import { tryReq, clearCache } from './chain.ts';

const $ = (id: string) => document.getElementById(id);
const setHtml = (id: string, h: string) => { const e = $(id) as any; if (e && e.__h !== h) { e.innerHTML = h; e.__h = h; } };
type Strat = 'maker' | 'arb' | 'rotate' | 'hybrid';
interface Cfg {
  strat: Strat; dir: 'neutral' | 'bull' | 'bear'; buyPct: number; every: number; customOn: boolean;
  slip: number; swaps: number; compound: boolean; reinvest: number; tpOn: boolean; tpAmt: number; reserve: number;
  act: { dep: boolean; wd: boolean; swap: boolean };
  method: 'base' | 'pct' | 'target'; buySz: number; sellSz: number; baseAmt: number; targetAmt: number; over: Record<string, { buy: number; sell: number }>;
  pair: string; mode: 'cycle' | 'dedicated'; ded: string; off: string[]; baseOn: string[]; tri: string[]; arbMin: number;
  spread: number; ttl: number; maxOpen: number; stopLoss: number; stopDraw: number; stopOrders: number; autoTrust: boolean;
}
const DEF: Cfg = {
  strat: 'maker', dir: 'neutral', buyPct: 50, every: 5, customOn: false, slip: 0.5, swaps: 1, compound: true, reinvest: 50, tpOn: false, tpAmt: 50, reserve: 20,
  act: { dep: true, wd: true, swap: true }, method: 'pct', buySz: 25, sellSz: 25, baseAmt: 10, targetAmt: 10, over: {},
  pair: 'all', mode: 'cycle', ded: '', off: [], baseOn: ['native'], tri: ['native'], arbMin: 0.5, spread: 0.6, ttl: 180, maxOpen: 6, stopLoss: 0, stopDraw: 0, stopOrders: 0, autoTrust: true,
};
interface Entry { id: number; ts: number; kind: 'trade' | 'lp' | 'arb' | 'note' | 'warn'; tag: string; msg: string; route?: string; size?: string; st: 'pending' | 'ok' | 'fail' | 'info'; hash?: string }
const zero = () => ({ arb: 0, vol: 0, tx: 0, gas: 0, deps: 0, wds: 0, swaps: 0, orders: 0, arbs: 0, cancelled: 0, fails: 0 });
export const BT: any = {
  cfg: { ...DEF } as Cfg, running: false, busy: false, timer: null, tab: 'logs', logf: 'all', done: false,
  log: [] as Entry[], seq: 0, ticks: 0, rr: 0, nextAt: 0, startedAt: 0, loaded: false, acct: '',
  sess: zero(), life: zero(), cost: {} as Record<string, number>, start0: null as null | number, peak: 0, lp0: 0, tpHit: false, uncomp: 0, rec: { buys: 0, sells: 0 },
  W: null as any, SN: null as any, view: null as any, offers: [] as any[], feeN: 0.00001, bestArb: null as any, pools: 0, expanded: false,
};
const SK = () => 'starsky.bot2.cfg.' + ctx.netKey();
const AK = () => `starsky.bot2.acct.${ctx.netKey()}.${ctx.account() || ''}`;
function loadCfg() {
  try { const j = JSON.parse(localStorage.getItem(SK()) || '{}'); BT.cfg = { ...DEF, ...j, act: { ...DEF.act, ...(j.act || {}) } }; } catch { BT.cfg = { ...DEF }; }
}
const saveCfg = () => { try { localStorage.setItem(SK(), JSON.stringify(BT.cfg)); } catch {} };
function loadAcct() {
  const a = ctx.account() || '';
  if (BT.acct === a) return;
  BT.acct = a;
  try { const j = JSON.parse(localStorage.getItem(AK()) || '{}'); BT.life = { ...zero(), ...(j.life || {}) }; BT.cost = j.cost || {}; } catch { BT.life = zero(); BT.cost = {}; }
}
const saveAcct = () => { try { localStorage.setItem(AK(), JSON.stringify({ life: BT.life, cost: BT.cost })); } catch {} };
const nm = (a: Asset) => (isNative(a) ? ctx.native() : M.labelOf(a));
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const rnow = () => Math.floor(Date.now() / 1000) - 946684800;
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const issue = (a: Asset) => (isNative(a) ? { currency: 'XRP' } : { currency: a.c, issuer: a.i });
const bump = (k: keyof ReturnType<typeof zero>, n = 1) => { BT.sess[k] += n; BT.life[k] += n; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* ---------- log ---------- */
function note(kind: Entry['kind'], tag: string, msg: string, st: Entry['st'] = 'info', route?: string, size?: string): Entry {
  const e: Entry = { id: ++BT.seq, ts: Date.now(), kind, tag, msg, st, route, size };
  BT.log.unshift(e); BT.log.length = Math.min(BT.log.length, 200);
  paintLog();
  return e;
}
/** submit a transaction, show it as PENDING in the log, then settle the entry */
async function send(tx: any, kind: Entry['kind'], tag: string, msg: string, route?: string, size?: string) {
  const e = note(kind, tag, msg, 'pending', route, size);
  let r: { ok: boolean; msg?: string; hash?: string };
  try { r = await ctx.submit(tx); } catch (x: any) { r = { ok: false, msg: String(x?.message || x) }; }
  e.st = r.ok ? 'ok' : 'fail'; e.hash = r.hash;
  if (r.ok) { bump('tx'); bump('gas', BT.feeN); } else { e.msg += ' — ' + (r.msg || 'rejected'); bump('fails'); }
  paintLog();
  return r;
}

/* ---------- chain reads ---------- */
async function feeNative() {
  try { const s: any = await tryReq('server_info', {}, 60000); const v = s?.info?.validated_ledger; if (v && v.base_fee_xrp != null) BT.feeN = Number(v.base_fee_xrp); } catch {}
}
async function wallet() {
  const acc = ctx.account(); if (!acc) return null;
  const [ai, al, ao, sv]: any[] = await Promise.all([
    tryReq('account_info', { account: acc, ledger_index: 'validated' }), tryReq('account_lines', { account: acc, ledger_index: 'validated', limit: 400 }),
    tryReq('account_offers', { account: acc, ledger_index: 'validated', limit: 100 }), tryReq('server_info', {}, 15000),
  ]);
  if (!ai || !ai.account_data) return null;
  const v = sv && sv.info && sv.info.validated_ledger;
  if (v && v.base_fee_xrp != null) BT.feeN = Number(v.base_fee_xrp);
  const owner = Number(ai.account_data.OwnerCount || 0);
  const reserve = v ? (v.reserve_base_xrp ?? 1) + owner * (v.reserve_inc_xrp ?? 0.2) : 2 + owner * 0.2;
  const native = Number(ai.account_data.Balance) / 1e6;
  const lines = new Map<string, number>();
  for (const l of (al && al.lines) || []) lines.set(`${l.currency}|${l.account}`, Number(l.balance));
  return {
    native, reserve, lines, offers: ((ao && ao.offers) || []) as any[],
    has: (a: Asset) => isNative(a) || lines.has(akey(a)),
    bal: (a: Asset) => (isNative(a) ? native : lines.get(akey(a)) || 0),
    avail: (a: Asset) => (isNative(a) ? Math.max(0, native - reserve - 0.5) : Math.max(0, lines.get(akey(a)) || 0)),
    sellable: (a: Asset) => (isNative(a) ? Math.max(0, native - reserve - 0.5) : Math.max(0, (lines.get(akey(a)) || 0) * (1 - BT.cfg.reserve / 100))),
  };
}
async function balOf(a: Asset): Promise<number> {
  const acc = ctx.account() as string;
  if (isNative(a)) { const r: any = await tryReq('account_info', { account: acc, ledger_index: 'current' }); return r && r.account_data ? Number(r.account_data.Balance) / 1e6 : 0; }
  const r: any = await tryReq('account_lines', { account: acc, peer: a.i, ledger_index: 'current', limit: 50 });
  const l = ((r && r.lines) || []).find((x: any) => x.currency === a.c);
  return l ? Number(l.balance) : 0;
}
let snapAt = 0;
async function snap(force = false) {
  if (!force && BT.SN && Date.now() - snapAt < 8000) return BT.SN;
  BT.SN = await M.snapshot(); snapAt = Date.now(); return BT.SN;
}
const pxN = (a: Asset): number | null => (isNative(a) ? 1 : BT.SN && BT.SN.px.has(akey(a)) ? (BT.SN.px.get(akey(a)) as number) : null);
const toN = (a: Asset, n: number) => { const p = pxN(a); return p == null ? 0 : n * p; };
const toUsd = (n: number) => (BT.SN && BT.SN.usdPerNative != null ? n * BT.SN.usdPerNative : null);
const money = (n: number) => { const u = toUsd(n); return u != null ? (u < 0 ? '-' : '') + usd(Math.abs(u)) : fmt(n, 4) + ' ' + ctx.native(); };
const sg = (n: number) => (n >= 0 ? '+' : '') + n;

/* ---------- universe of pools the bot may use ---------- */
interface Venue { p: M.PoolState; T: Asset; B: Asset; m: M.Market }
function venues(sn: any): Venue[] {
  const c: Cfg = BT.cfg, bases = c.baseOn.length ? c.baseOn : ['native'], out: Venue[] = [];
  for (const p of sn.pools as M.PoolState[]) {
    if (M.isOldUsd(p.a) || M.isOldUsd(p.b) || !(p.ra > 0 && p.rb > 0)) continue;
    const ka = akey(p.a), kb = akey(p.b), ab = bases.includes(ka), bb = bases.includes(kb);
    if (!ab && !bb) continue;
    let B: Asset, T: Asset;
    if (ab && bb) { B = isNative(p.a) ? p.a : isNative(p.b) ? p.b : p.a; T = B === p.a ? p.b : p.a; } else { B = ab ? p.a : p.b; T = ab ? p.b : p.a; }
    if (c.off.includes(akey(T))) continue;
    if (c.pair !== 'all' && p.account !== c.pair) continue;
    if (c.mode === 'dedicated' && c.ded && akey(T) !== c.ded) continue;
    out.push({ p, T, B, m: { id: M.marketId(T, B), base: T, quote: B, label: nm(T) + '/' + nm(B), pool: p } });
  }
  return out;
}
const priceTinB = (v: Venue) => M.poolPrice(v.p, v.T) as number; // B per 1 T
function pick(vs: Venue[]): Venue | null { if (!vs.length) return null; return vs[BT.rr++ % vs.length]; }

/* ---------- sizing ---------- */
function sizeBuy(v: Venue, W: any): number {
  const c: Cfg = BT.cfg, avail = W.avail(v.B), sym = nm(v.T), ov = c.over[sym], pB = pxN(v.B) || 1;
  let x: number;
  if (ov && ov.buy > 0) x = ov.buy / pB;
  else if (c.method === 'base') x = c.baseAmt / pB;
  else if (c.method === 'target') x = c.targetAmt * priceTinB(v);
  else x = avail * (c.buySz / 100) * rnd(0.85, 1);
  return Math.min(x, avail);
}
function sizeSell(v: Venue, W: any): number {
  const c: Cfg = BT.cfg, avail = W.sellable(v.T), sym = nm(v.T), ov = c.over[sym], pT = pxN(v.T) || 0;
  let x: number;
  if (ov && ov.sell > 0) x = ov.sell;
  else if (c.method === 'base') x = pT > 0 ? c.baseAmt / pT : 0;
  else if (c.method === 'target') x = c.targetAmt;
  else x = avail * (c.sellSz / 100) * rnd(0.85, 1);
  return Math.min(x, avail);
}
const minNotional = () => Math.max(0.01, BT.feeN * 20);

/* ---------- actions ---------- */
async function ensureTrust(a: Asset): Promise<boolean> {
  if (isNative(a)) return true;
  const r = await send({ TransactionType: 'TrustSet', Account: ctx.account(), LimitAmount: { currency: a.c, issuer: a.i, value: '1000000000000' } }, 'note', 'TRUST LINE', `Opening a trust line for ${nm(a)} so the bot can trade it`, nm(a));
  return r.ok;
}
async function doSwap(v: Venue, buy: boolean, W: any): Promise<boolean> {
  const c: Cfg = BT.cfg, acc = ctx.account() as string;
  let x = buy ? sizeBuy(v, W) : sizeSell(v, W);
  const pay = buy ? v.B : v.T, get = buy ? v.T : v.B;
  { const rin = akey(v.p.a) === akey(pay) ? v.p.ra : v.p.rb, cap = rin * (Math.max(c.slip - v.p.fee, c.slip * 0.3) / 100) * 0.8; if (x > cap) { x = cap; } }   // shrink the trade to fit your slippage limit instead of skipping it
  if (!(x > 0) || toN(pay, x) < minNotional()) return false;
  if (buy && !W.has(v.T)) { if (!c.autoTrust) { note('warn', 'SWAP SKIPPED', `Set a trust line for ${nm(v.T)} first (or turn on automatic trust lines).`); return false; } if (!(await ensureTrust(v.T))) return false; }
  const q = await M.quote(v.m, buy ? 'buy' : 'sell', x);
  if (!q) { note('warn', 'SWAP UNFULFILLED', 'No liquidity on this route.', 'info', v.m.label); return false; }
  if (q.impact * 100 > c.slip) { note('warn', 'SWAP UNFULFILLED', `Price impact ${(q.impact * 100).toFixed(2)}% is above your ${c.slip}% limit.`, 'info', v.m.label, `${fmt(x)} ${nm(pay)}`); return false; }
  const r = await send({ TransactionType: 'OfferCreate', Account: acc, TakerGets: amtTx(pay, x), TakerPays: amtTx(get, q.out * (1 - c.slip / 100)), Flags: 0x00080000 | 0x00020000 }, 'trade', 'MATCHING SWAP', `${fmt(x)} ${nm(pay)} → ~${fmt(q.out)} ${nm(get)} via ${q.src}`, v.m.label, `${fmt(x)} ${nm(pay)}`);
  if (r.ok) { bump('swaps'); bump('vol', toN(pay, x)); BT.rec[buy ? 'buys' : 'sells']++; BT.uncomp = BT.uncomp; }
  return r.ok;
}
async function doMaker(v: Venue, W: any) {
  const c: Cfg = BT.cfg, acc = ctx.account() as string, px = priceTinB(v);
  if (!(px > 0)) return;
  const mine = W.offers.slice().sort((a: any, b: any) => a.seq - b.seq);
  while (mine.length >= c.maxOpen - 1) { const o = mine.shift(); const r = await ctx.submit({ TransactionType: 'OfferCancel', Account: acc, OfferSequence: o.seq }); if (r.ok) bump('cancelled'); else break; }
  const wb = clamp(c.buyPct / 50, 0.2, 2), ws = clamp((100 - c.buyPct) / 50, 0.2, 2);
  const off = rnd(0.5, 1) * (c.spread / 100);
  const xb = Math.min(sizeBuy(v, W) * wb, W.avail(v.B)), xs = Math.min(sizeSell(v, W) * ws, W.sellable(v.T));
  const exp = rnow() + c.ttl;
  if (xb > 0 && toN(v.B, xb) >= minNotional() && W.has(v.T)) {
    const p = px * (1 - off), rec = xb / p;
    const r = await send({ TransactionType: 'OfferCreate', Account: acc, TakerGets: amtTx(v.B, xb), TakerPays: amtTx(v.T, rec), Expiration: exp }, 'trade', 'LIMIT BID', `Bid ${fmt(rec)} ${nm(v.T)} @ ${fmt(p, 6)} ${nm(v.B)}`, v.m.label, `${fmt(xb)} ${nm(v.B)}`);
    if (r.ok) bump('orders');
  }
  if (xs > 0 && toN(v.T, xs) >= minNotional()) {
    const p = px * (1 + off);
    const r = await send({ TransactionType: 'OfferCreate', Account: acc, TakerGets: amtTx(v.T, xs), TakerPays: amtTx(v.B, xs * p), Expiration: exp }, 'trade', 'LIMIT ASK', `Ask ${fmt(xs)} ${nm(v.T)} @ ${fmt(p, 6)} ${nm(v.B)}`, v.m.label, `${fmt(xs)} ${nm(v.T)}`);
    if (r.ok) bump('orders');
  }
}
async function doDeposit(v: Venue, W: any) {
  const c: Cfg = BT.cfg, acc = ctx.account() as string, p = v.p;
  let x = sizeBuy(v, W);
  if (c.compound && BT.uncomp > 0) { const add = (BT.uncomp * (c.reinvest / 100)) / (pxN(v.B) || 1); x += add; BT.uncomp = Math.max(0, BT.uncomp - add * (pxN(v.B) || 1)); }
  x = Math.min(x, W.avail(v.B), (akey(p.a) === akey(v.B) ? p.ra : p.rb) * 0.1);
  if (!(x > 0) || toN(v.B, x) < minNotional()) { note('note', 'AMM DEPOSIT NOTICE', 'Not enough free ' + nm(v.B) + ' to deposit. Fund the wallet or lower your reserve.', 'info', v.m.label); return; }
  const tx: any = { TransactionType: 'AMMDeposit', Account: acc, Asset: issue(p.a), Asset2: issue(p.b), Amount: amtTx(v.B, x), Flags: 0x00080000 };
  const r = await send(tx, 'lp', 'AMM DEPTH PROVISIONING', `Depositing ${fmt(x, 6)} ${nm(v.B)} into ${v.m.label} AMM`, v.m.label, `${fmt(x, 6)} ${nm(v.B)}`);
  if (r.ok) { bump('deps'); bump('vol', toN(v.B, x)); BT.cost[p.account] = (BT.cost[p.account] || 0) + toN(v.B, x); saveAcct(); }
  else if (/UNFUNDED|AMM/.test(r.msg || '')) note('lp', 'AMM DEPOSIT NOTICE', `Deposit rejected (${r.msg}). Monitoring next block.`, 'info', v.m.label);
}
/** every LP position the bot opened, valued in native coin */
function positions(W: any, sn: any) {
  const out: any[] = [];
  for (const p of sn.pools as M.PoolState[]) {
    const bal = W.lines.get(`${p.lpCur}|${p.account}`) || 0;
    if (!(bal > 0) || !(p.lp > 0)) continue;
    const share = bal / p.lp, val = share * (toN(p.a, p.ra) + toN(p.b, p.rb));
    out.push({ p, bal, val, cost: BT.cost[p.account] || 0 });
  }
  return out;
}
async function withdrawAll(W: any, why: string) {
  const acc = ctx.account() as string, sn = BT.SN, bases = BT.cfg.baseOn;
  for (const po of positions(W, sn).filter(z => z.cost > 0)) {
    const p = po.p as M.PoolState, want = isNative(p.a) ? p.a : isNative(p.b) ? p.b : bases.includes(akey(p.a)) ? p.a : bases.includes(akey(p.b)) ? p.b : null;
    const tx: any = { TransactionType: 'AMMWithdraw', Account: acc, Asset: issue(p.a), Asset2: issue(p.b), LPTokenIn: { currency: p.lpCur, issuer: p.account, value: String(+po.bal.toPrecision(15)) } };
    if (want) { tx.Amount = amtTx(want, isNative(want) ? 0.000001 : 0.000001); tx.Flags = 0x00200000; } else tx.Flags = 0x00010000;
    const r = await send(tx, 'lp', 'AMM WITHDRAWAL', `${why}: withdrawing my ${nm(p.a)}/${nm(p.b)} liquidity${want ? ' as ' + nm(want) : ''}`, `${nm(p.a)}/${nm(p.b)}`, `~${fmt(po.val, 4)} ${ctx.native()}`);
    if (r.ok) { bump('wds'); BT.cost[p.account] = 0; saveAcct(); }
  }
}

/* ---------- triangular arbitrage ---------- */
interface Edge { pool: M.PoolState; from: Asset; to: Asset; rin: number; rout: number; fee: number }
const outOf = (e: Edge, x: number) => { const f = x * (1 - e.fee / 100); return (e.rout * f) / (e.rin + f); };
function arbScan(sn: any, W: any) {
  const c: Cfg = BT.cfg, adj = new Map<string, Edge[]>(), allowed = (a: Asset) => isNative(a) || !c.off.includes(akey(a));
  for (const p of sn.pools as M.PoolState[]) {
    if (M.isOldUsd(p.a) || M.isOldUsd(p.b) || !(p.ra > 0 && p.rb > 0) || !allowed(p.a) || !allowed(p.b)) continue;
    for (const [f, t, ri, ro] of [[p.a, p.b, p.ra, p.rb], [p.b, p.a, p.rb, p.ra]] as [Asset, Asset, number, number][]) { const k = akey(f); if (!adj.has(k)) adj.set(k, []); (adj.get(k) as Edge[]).push({ pool: p, from: f, to: t, rin: ri, rout: ro, fee: p.fee }); }
  }
  let loops = 0, best: any = null;
  for (const bk of c.tri) {
    const B = fromKey(bk), avail = W.avail(B), pB = pxN(B) || 0;
    if (!(avail > 0) || !pB) continue;
    for (const e1 of adj.get(bk) || []) for (const e2 of adj.get(akey(e1.to)) || []) {
      if (e2.pool === e1.pool || akey(e2.to) === bk) continue;
      for (const e3 of adj.get(akey(e2.to)) || []) {
        if (akey(e3.to) !== bk || e3.pool === e1.pool || e3.pool === e2.pool) continue;
        loops++;
        const cap = Math.min(avail * (c.buySz / 100), e1.rin * 0.02);
        for (const f of [1, 0.5, 0.25, 0.1]) {
          const x = cap * f; if (!(x > 0) || toN(B, x) < minNotional() * 5) continue;
          const o = outOf(e3, outOf(e2, outOf(e1, x))), pct = (o / x - 1) * 100, gain = o - x;
          if (!best || pct > best.pct) best = { pct, x, gain, gainN: toN(B, gain), B, legs: [e1, e2, e3] };
        }
      }
    }
  }
  BT.loops = loops; BT.bestArb = best ? { pct: best.pct, route: best.legs.map((e: Edge) => nm(e.from)).join('→') + '→' + nm(best.B) } : null;
  return best;
}
async function doArb(op: any, W: any): Promise<boolean> {
  const c: Cfg = BT.cfg, acc = ctx.account() as string, B: Asset = op.B, route = op.legs.map((e: Edge) => nm(e.from)).join(' → ') + ' → ' + nm(B);
  const feesN = 3 * BT.feeN;
  if (op.gainN < feesN * 3) { return false; }
  const b0 = await balOf(B);
  let have = op.x, held: Asset = B, ok = true;
  const hist: Edge[] = [];
  for (let i = 0; i < 3; i++) {
    const e: Edge = op.legs[i], get = e.to, before = await balOf(get);
    const out = outOf(e, have);
    for (const t of [get]) if (!isNative(t) && !W.has(t) && !(await ensureTrust(t))) { ok = false; break; }
    if (!ok) break;
    const r = await send({ TransactionType: 'OfferCreate', Account: acc, TakerGets: amtTx(e.from, have), TakerPays: amtTx(get, out * (1 - c.slip / 100)), Flags: 0x00080000 | 0x00020000 }, 'arb', `ARB LEG ${i + 1}/3`, `${fmt(have, 6)} ${nm(e.from)} → ~${fmt(out, 6)} ${nm(get)}`, route, `${fmt(have, 6)} ${nm(e.from)}`);
    if (!r.ok) { ok = false; break; }
    hist.push(e); bump('vol', toN(e.from, have));
    await sleep(600);
    const after = await balOf(get), got = after - before;
    if (!(got > 0)) { ok = false; break; }
    have = got * (isNative(get) ? 0.999 : 0.9995); held = get;
  }
  if (!ok && hist.length && akey(held) !== akey(B)) {
    note('warn', 'ARB RECOVERY', `A leg failed while holding ${nm(held)}. Swapping back to ${nm(B)}.`, 'info', route);
    const e: Edge = hist[hist.length - 1], back: Edge = { pool: e.pool, from: e.to, to: e.from, rin: e.rout, rout: e.rin, fee: e.fee };
    const amt = Math.min(have, await balOf(held));
    if (amt > 0) await send({ TransactionType: 'OfferCreate', Account: acc, TakerGets: amtTx(back.from, amt), TakerPays: amtTx(back.to, outOf(back, amt) * (1 - Math.max(c.slip, 2) / 100)), Flags: 0x00080000 | 0x00020000 }, 'arb', 'ARB RECOVERY', `Unwinding ${fmt(amt, 6)} ${nm(back.from)} → ${nm(back.to)}`, route);
  }
  const b1 = await balOf(B), real = (b1 - b0) + (isNative(B) ? feesN : 0);
  if (ok) { const n = toN(B, real); bump('arb', n); bump('arbs'); BT.uncomp += Math.max(0, n); note('arb', 'ARB COMPLETE', `Loop ${route} returned ${sg(+fmt(real, 6).replace(/,/g, ''))} ${nm(B)} (${sg(+((real / op.x) * 100).toFixed(3))}%)`, real > 0 ? 'ok' : 'fail', route, `${fmt(op.x, 6)} ${nm(B)}`); }
  saveAcct();
  return ok;
}

/* ---------- view and safety ---------- */
function computeView(W: any, sn: any) {
  let eq = W.native;
  for (const [k, v] of W.lines) { const a = fromKey(k); const p = pxN(a); if (p != null && v > 0) eq += v * p; }
  const pos = positions(W, sn);
  const lpVal = pos.reduce((t, z) => t + z.val, 0), lpYield = pos.filter(z => z.cost > 0).reduce((t, z) => t + (z.val - z.cost), 0);
  BT.view = { eq, lpVal, lpYield, pos };
  return BT.view;
}
async function tick(force = false) {
  if (BT.busy || (!BT.running && !force)) return;
  BT.busy = true; BT.nextAt = Date.now() + BT.cfg.every * 1000; BT.ticks++;
  const c: Cfg = BT.cfg;
  try {
    const acc = ctx.account(); if (!acc) throw new Error('no wallet selected');
    clearCache(`${ctx.netKey()}|pst`);
    const sn = await snap(true);
    let W = await wallet(); if (!W) throw new Error('the wallet is not funded on this network');
    BT.W = W; BT.offers = W.offers;
    const view = computeView(W, sn);
    if (BT.start0 == null) { BT.start0 = view.eq; BT.lp0 = view.lpYield; }
    BT.peak = Math.max(BT.peak, view.eq);
    if (BT.running && (c.stopLoss > 0 || c.stopDraw > 0 || c.stopOrders > 0)) {
      const why = BP.killReasons({ startEquity: BT.start0 as number, equity: view.eq, peak: BT.peak, fails: BT.sess.fails, orders: BT.sess.orders + BT.sess.swaps + BT.sess.arbs, lossToday: 0, price: null }, { maxLossPct: c.stopLoss || undefined, maxDrawdownPct: c.stopDraw || undefined, maxOrders: c.stopOrders || undefined });
      if (why.length) { stop('Safety stop: ' + why.join(' ')); return; }
    }
    const vs = venues(sn); BT.pools = vs.length;
    // take profit: pull the liquidity back to the base coin once the LP yield reaches the target
    const sessLp = view.lpYield - BT.lp0;
    if (c.tpOn && c.act.wd && !BT.tpHit) {
      const tgtN = BT.SN.usdPerNative ? c.tpAmt / BT.SN.usdPerNative : c.tpAmt;
      if (sessLp >= tgtN && sessLp > 0) { BT.tpHit = true; note('lp', 'TAKE PROFIT', `LP yield ${money(sessLp)} reached your ${BT.SN.usdPerNative ? '$' + c.tpAmt : c.tpAmt + ' ' + ctx.native()} target.`, 'ok'); await withdrawAll(W, 'Take profit'); W = (await wallet()) || W; }
    }
    if (!vs.length && c.strat !== 'arb') { note('warn', 'NO ROUTES', 'No pools match your base pools and token selection.'); return; }
    const canSwap = c.act.swap, doLp = c.act.dep && !BT.tpHit;
    const doOne = async (buyP: number) => {
      const v = pick(vs); if (!v) return;
      let buy = Math.random() < buyP / 100;
      if (buy && W.avail(v.B) <= 0) buy = false; else if (!buy && W.sellable(v.T) <= 0) buy = true;
      await doSwap(v, buy, W);
    };
    if (c.strat === 'arb' || c.strat === 'hybrid') {
      if (canSwap) {
        const op = arbScan(sn, W);
        if (op && op.pct >= c.arbMin) { note('arb', 'ARB FOUND', `+${op.pct.toFixed(3)}% on ${BT.bestArb.route}`, 'info', BT.bestArb.route); await doArb(op, W); }
        else if (c.strat === 'arb') note('note', 'ARB SCAN', `Scanned ${BT.loops || 0} loops. Best ${op ? (op.pct >= 0 ? '+' : '') + op.pct.toFixed(3) + '%' : 'none'}, below your ${c.arbMin}% minimum.`);
      } else note('warn', 'ARB OFF', 'Arbitrage needs "Matching swaps" turned on in Safety.');
    }
    if (c.strat === 'maker') {
      if (doLp && BT.ticks % 3 === 1) { const v = pick(vs); if (v) await doDeposit(v, W); }
      const v = pick(vs); if (v) await doMaker(v, W);
    } else if (c.strat === 'rotate') {
      if (!canSwap) note('warn', 'SWAPS OFF', 'Turn on "Matching swaps" in Safety.');
      else for (let i = 0; i < c.swaps; i++) { await doOne(c.buyPct); if (i < c.swaps - 1) await sleep(500); }
    } else if (c.strat === 'hybrid') {
      if (canSwap) for (let i = 0; i < c.swaps; i++) await doOne(c.buyPct);
      if (doLp && BT.ticks % 4 === 0) { const v = pick(vs); if (v) await doDeposit(v, W); }
      if (BT.ticks % 2 === 0) { const v = pick(vs); if (v) await doMaker(v, W); }
    }
    BT.sess.fails = BT.sess.fails; BT.failRun = 0;
  } catch (e: any) {
    BT.failRun = (BT.failRun || 0) + 1;
    note('warn', 'ENGINE', String(e?.message || e));
    if (BT.failRun >= 5) stop('Stopped after 5 failures in a row');
  } finally { BT.busy = false; paint(); }
}
function stop(why = 'Stopped') {
  BT.running = false; clearInterval(BT.timer); BT.timer = null; saveAcct();
  note('note', 'ENGINE', why); paint();
}
const startTimer = () => { clearInterval(BT.timer); BT.timer = setInterval(() => tick(), BT.cfg.every * 1000); BT.nextAt = Date.now() + BT.cfg.every * 1000; };
async function refresh() {
  if (!ctx.online() || !ctx.account()) return;
  try {
    loadAcct();
    const sn = await snap(); const W = await wallet();
    if (W) { BT.W = W; BT.offers = W.offers; computeView(W, sn); BT.pools = venues(sn).length; }
  } catch {}
  paint(); paintPane();
}

/* ======================= UI ======================= */
const STRATS: Record<Strat, [string, string]> = {
  maker: ['Automated Liquidity Maker', 'Places adaptive dual limit orders (a bid and an ask) around the pool price and adds liquidity to the pools to harvest matching commissions and LP fees.'],
  arb: ['Triangular Arbitrage', 'Scans every three-pool loop (for example LUMA → A → B → LUMA) and trades it only when the net profit after pool fees beats your minimum spread.'],
  rotate: ['Rotational Swap Trader', 'Rotates through the allowed tokens and makes AMM swaps that follow your buy/sell bias, sized by your sizing rules.'],
  hybrid: ['Hybrid: Maker + Arb + LP', 'Runs everything: arbitrage first, then swaps, limit orders and liquidity deposits, all within your safety rules.'],
};
function tokens(): Asset[] {
  const sn = BT.SN, m = new Map<string, Asset>();
  if (sn) for (const p of sn.pools as M.PoolState[]) for (const a of [p.a, p.b]) if (!M.isOldUsd(a)) m.set(akey(a), a);
  return [...m.values()].sort((a, b) => nm(a).localeCompare(nm(b)));
}
function hubs(): { a: Asset; sub: string }[] {
  const sn = BT.SN, cnt = new Map<string, number>();
  if (sn) for (const p of sn.pools as M.PoolState[]) for (const a of [p.a, p.b]) if (!M.isOldUsd(a)) cnt.set(akey(a), (cnt.get(akey(a)) || 0) + 1);
  const out: { a: Asset; sub: string }[] = [{ a: NATIVE, sub: 'NATIVE' }];
  const usdK = sn && sn.usdKey;
  for (const [k, n] of [...cnt.entries()].sort((x, y) => y[1] - x[1])) { if (k === 'native') continue; if (k === usdK || hexName(fromKey(k).c).toUpperCase() === ctx.usdName().toUpperCase()) out.push({ a: fromKey(k), sub: 'STABLE' }); else if (n >= 2) out.push({ a: fromKey(k), sub: 'HUB' }); }
  return out.slice(0, 8);
}
const tog = (label: string, on: boolean, act: string, sub = '') => `<button class="btchip ${on ? 'on' : ''}" onclick="${act}"><i></i>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</button>`;
const seg = (opts: [string, string][], cur: string, fn: string) => `<div class="btseg">${opts.map(([k, l]) => `<button class="${k === cur ? 'on' : ''}" onclick="window.bt.${fn}('${k}')">${esc(l)}</button>`).join('')}</div>`;
const numIn = (id: string, v: number, step: string, suffix = '') => `<span class="btnum"><input id="${id}" type="number" step="${step}" value="${v}" onchange="window.bt.set('${id}',this.value)">${suffix ? `<em>${suffix}</em>` : ''}</span>`;
const slider = (id: string, v: number, mn: number, mx: number, st: number) => `<input class="btrange" type="range" min="${mn}" max="${mx}" step="${st}" value="${v}" oninput="window.bt.set('${id}',this.value,1)" onchange="window.bt.set('${id}',this.value)">`;
const bar = (pct: number) => `<div class="btres"><i style="width:${pct}%"></i></div>`;
const when = (ts: number) => new Date(ts).toLocaleTimeString();
function tokenChips(): string {
  const c: Cfg = BT.cfg, ts = tokens().filter(a => !isNative(a));
  if (!ts.length) return '<div class="mut">Loading tokens…</div>';
  return `<div class="btchips">${ts.map(a => tog(nm(a), !c.off.includes(akey(a)), `window.bt.tok('${esc(akey(a))}')`)).join('')}</div>`;
}
function paneHtml(tab: string): string {
  const c: Cfg = BT.cfg;
  if (tab === 'logs') return `<div class="row btlh"><div class="k" style="margin:0">&gt;_ Engine log stream</div><label class="mut" style="font-size:.78rem"><input type="checkbox" ${BT.done ? 'checked' : ''} onchange="window.bt.done(this.checked)"> Completed trades only</label><div class="btseg sm">${[['all', 'All'], ['trade', 'Trades'], ['lp', 'LP'], ['arb', 'Arb']].map(([k, l]) => `<button class="${BT.logf === k ? 'on' : ''}" onclick="window.bt.logf('${k}')">${l}</button>`).join('')}<button class="clr" onclick="window.bt.clear()">Clear</button></div></div><div id="bt_log" class="btlog"></div>`;
  if (tab === 'orders') return `<div class="row btlh"><div class="k" style="margin:0">Open orders</div><button class="sm ghost" onclick="window.bt.cancelAll(this)">Cancel all</button></div><div id="bt_offers" class="nwscroll"></div>
    <div class="btsub">Order-book maker settings</div><div class="btfields">
    <label><span>Spread ± %</span>${numIn('bt_spread', c.spread, '0.1', '%')}<small class="mut">distance of bid and ask from the pool price</small></label>
    <label><span>Order life</span>${numIn('bt_ttl', c.ttl, '10', 's')}<small class="mut">offers expire on their own</small></label>
    <label><span>Max open orders</span>${numIn('bt_open', c.maxOpen, '1')}<small class="mut">the oldest are cancelled first</small></label></div>
    <div class="btsub">Recent actions</div><div id="bt_recent" class="btlog" style="max-height:14rem"></div>`;
  if (tab === 'sizing') {
    const m = c.method;
    return `<div class="row btlh"><div class="k" style="margin:0">Trade sizing method</div>${seg([['base', 'By base (' + ctx.native() + ')'], ['pct', 'By % (buy / sell)'], ['target', 'By target (token)']], m, 'method')}</div>
    ${m === 'pct' ? `<div class="btpair"><div class="btbox"><div class="row btlh"><div><b>Buy size</b><div class="mut sm">% of the available base coin per buy</div></div>${numIn('bt_buysz', c.buySz, '1', '%')}</div>${slider('bt_buysz', c.buySz, 1, 100, 1)}<div class="btpre">${[5, 10, 25, 50, 75, 100].map(n => `<button class="${c.buySz === n ? 'on' : ''}" onclick="window.bt.set('bt_buysz',${n})">${n === 100 ? '100% Full' : n + '%'}</button>`).join('')}</div></div>
      <div class="btbox sell"><div class="row btlh"><div><b>Sell size</b><div class="mut sm">% of the unlocked tokens per sell</div></div>${numIn('bt_sellsz', c.sellSz, '1', '%')}</div>${slider('bt_sellsz', c.sellSz, 1, 100, 1)}<div class="btpre">${[5, 10, 25, 50, 75, 100].map(n => `<button class="${c.sellSz === n ? 'on' : ''}" onclick="window.bt.set('bt_sellsz',${n})">${n === 100 ? '100% Full' : n + '%'}</button>`).join('')}</div></div></div>` : ''}
    ${m === 'base' ? `<div class="btbox"><div class="row btlh"><div><b>Fixed amount per trade</b><div class="mut sm">Worth this many ${esc(ctx.native())} each time</div></div>${numIn('bt_baseamt', c.baseAmt, 'any', ctx.native())}</div></div>` : ''}
    ${m === 'target' ? `<div class="btbox"><div class="row btlh"><div><b>Token amount per trade</b><div class="mut sm">Buy or sell this many tokens each time</div></div>${numIn('bt_targetamt', c.targetAmt, 'any', 'tokens')}</div></div>` : ''}
    ${reserveCard()}
    <div class="btbox"><div class="row btlh"><div><b>Custom token sizing overrides</b><div class="mut sm">Explicit amounts for specific tokens. They beat the method above.</div></div><button class="sm ghost" onclick="window.bt.expand()">${BT.expanded ? 'Hide ▲' : 'Configure overrides ▼'}</button></div>${BT.expanded ? `<div class="btov">${tokens().filter(a => !isNative(a)).map(a => { const o = c.over[nm(a)] || { buy: 0, sell: 0 }; return `<div class="btovr"><b>${esc(nm(a))}</b><label>Buy (${esc(ctx.native())} worth)<input type="number" step="any" value="${o.buy || ''}" placeholder="auto" onchange="window.bt.ov('${esc(nm(a))}','buy',this.value)"></label><label>Sell (tokens)<input type="number" step="any" value="${o.sell || ''}" placeholder="auto" onchange="window.bt.ov('${esc(nm(a))}','sell',this.value)"></label></div>`; }).join('')}</div>` : ''}</div>
    <div class="btpair"><div class="btbox"><div class="btsub" style="margin:0 0 .5rem">Loop execution interval</div>${seg([['5', '5s'], ['10', '10s'], ['30', '30s'], ['60', '60s']], String(c.every), 'speed')}</div><div class="btbox"><div class="btsub" style="margin:0 0 .5rem">Max slippage protection</div>${seg([['0.1', '0.1%'], ['0.5', '0.5%'], ['1', '1%'], ['2.5', '2.5%']], String(c.slip), 'slipq')}</div></div>
    ${tpCard()}`;
  }
  if (tab === 'pathways') return `<div class="row btlh"><div class="k" style="margin:0">Path targets &amp; token selectors</div>${seg([['cycle', 'Cycle all'], ['dedicated', 'Dedicated asset']], c.mode, 'mode')}</div>
    <div class="btbox"><div class="btsub" style="margin:0 0 .6rem">Allowable trading target assets ${c.mode === 'dedicated' ? '<small class="mut">(pick the one asset to trade)</small>' : ''}</div>${c.mode === 'dedicated' ? `<div class="btchips">${tokens().filter(a => !isNative(a)).map(a => tog(nm(a), c.ded === akey(a), `window.bt.ded('${esc(akey(a))}')`)).join('')}</div>` : tokenChips()}</div>
    <div class="btpair"><div class="btbox"><div class="btsub" style="margin:0 0 .6rem">Triangular base routing assets</div><div class="btchips">${hubs().map(h => tog(nm(h.a), c.tri.includes(akey(h.a)), `window.bt.tri('${esc(akey(h.a))}')`)).join('')}</div><div class="mut sm" style="margin-top:.5rem">Loops start and end in these. The bot must hold some of them.</div></div>
    <div class="btbox"><div class="btsub" style="margin:0 0 .6rem">Arb profit spread threshold</div><div class="row" style="gap:.8rem">${slider('bt_arbmin', c.arbMin, 0.05, 5, 0.05)}<b class="mono">${c.arbMin}%</b></div><div class="mut sm" style="margin-top:.4rem">Net of pool fees. Last scan: ${BT.bestArb ? (BT.bestArb.pct >= 0 ? '+' : '') + BT.bestArb.pct.toFixed(3) + '% on ' + esc(BT.bestArb.route) : 'none yet'}.</div></div></div>`;
  if (tab === 'safety') return `<div class="row btlh"><div class="k" style="margin:0">🛡 Safety protections &amp; compound rules</div></div>
    <div class="btpair"><div class="btbox"><div class="btsub" style="margin:0 0 .6rem">Trading safeguards</div>
      <div class="btfld"><span>Max protect slippage</span><b class="mono">${c.slip}%</b></div>${slider('bt_slip', c.slip, 0.1, 5, 0.1)}
      <div class="btfld"><span>Swaps per tick (sent one after another)</span><b class="mono">${c.swaps <= 1 ? 'Off' : c.swaps}</b></div>${slider('bt_swaps', c.swaps, 1, 5, 1)}
      <label class="btfld"><span>✦ Auto compound profits</span><input type="checkbox" ${c.compound ? 'checked' : ''} onchange="window.bt.flag('compound',this.checked)"></label>
      <div class="btfld"><span>Reinvest LP allocation</span><b class="mono">${c.reinvest}%</b></div>${slider('bt_reinvest', c.reinvest, 0, 100, 5)}
      <label class="btfld"><span>Open trust lines automatically</span><input type="checkbox" ${c.autoTrust ? 'checked' : ''} onchange="window.bt.flag('autoTrust',this.checked)"></label></div>
    <div class="btbox"><label class="btfld"><span class="k" style="margin:0">◔ Take-profit trigger</span><input type="checkbox" ${c.tpOn ? 'checked' : ''} onchange="window.bt.flag('tpOn',this.checked)"></label>${c.tpOn ? `<div class="btfld"><span>Pull liquidity back when LP yield reaches</span>${numIn('bt_tpamt', c.tpAmt, 'any', BT.SN && BT.SN.usdPerNative ? '$' : ctx.native())}</div>` : '<div class="mut sm">Off. Turn it on to bank the LP yield automatically.</div>'}
      <div class="btsub">Stops</div>
      <div class="btfld"><span>Stop if total loss reaches</span>${numIn('bt_stoploss', c.stopLoss, 'any', '%')}</div><div class="btfld"><span>Stop if it falls from its best</span>${numIn('bt_stopdraw', c.stopDraw, 'any', '%')}</div><div class="btfld"><span>Stop after this many actions</span>${numIn('bt_stoporders', c.stopOrders, '1')}</div><div class="mut sm">0 means off.</div></div></div>
    ${reserveCard()}
    <div class="btbox"><div class="btsub" style="margin:0 0 .6rem">Allowable automated actions</div><div class="btchips three">${[['dep', 'AMM deposits'], ['wd', 'AMM withdrawals'], ['swap', 'Matching swaps']].map(([k, l]) => `<label class="btchk"><input type="checkbox" ${(c.act as any)[k] ? 'checked' : ''} onchange="window.bt.act('${k}',this.checked)"> ${l}</label>`).join('')}</div></div>`;
  return '';
}
function reserveCard() {
  const c: Cfg = BT.cfg;
  return `<div class="btbox res"><div class="row btlh"><div class="row" style="gap:.7rem"><span class="btlock">🔒</span><div><b>Token reserve lock % (do not sell)</b> <span class="chip">${c.reserve}% protected</span><div class="mut sm">The bot is strictly forbidden from selling or depositing this share of each token you hold. Only the rest is traded.</div></div></div>${numIn('bt_reserve', c.reserve, '1', '%')}</div>
    <div class="btresbar"><div style="width:${c.reserve}%"></div></div><div class="row" style="justify-content:space-between;font-size:.72rem"><span style="color:#f5a623">${c.reserve}% locked and protected (never sold)</span><span style="color:var(--ok)">${100 - c.reserve}% liquid and tradable</span></div>
    <div class="btpre" style="margin-top:.6rem"><span class="mut sm">Quick lock presets</span>${[[0, '0% (no lock)'], [10, '10% soft'], [25, '25% balanced'], [50, '50% half lock'], [75, '75% heavy HODL'], [90, '90% safe vault']].map(([n, l]) => `<button class="${c.reserve === n ? 'on' : ''}" onclick="window.bt.set('bt_reserve',${n})">${l}</button>`).join('')}</div></div>`;
}
function tpCard() {
  const c: Cfg = BT.cfg, v = BT.view, sess = v ? v.lpYield - BT.lp0 : 0, status = !c.tpOn ? 'Disabled' : BT.tpHit ? 'Triggered' : 'Armed';
  return `<div class="btbox"><div class="row btlh"><div><b>✦ Automatic take profit (LP yield harvesting)</b><div class="mut sm">Safeguard returns by moving LP liquidity back to ${esc(ctx.native())} when the target is reached.</div></div><span class="chip ${c.tpOn ? '' : 'bad'}">${status.toUpperCase()}</span></div>
    <div class="btstat"><span>● Status: <b>${c.tpOn ? (BT.tpHit ? 'Harvested' : 'Standing by') : 'Standby'}</b></span><span>Session yield: <b>${money(sess)}</b> / ${BT.SN && BT.SN.usdPerNative ? '$' + c.tpAmt : c.tpAmt + ' ' + esc(ctx.native())} threshold</span></div></div>`;
}
function suiteHtml(): string {
  const c: Cfg = BT.cfg, sn = BT.SN, pools: M.PoolState[] = sn ? sn.pools : [];
  const all = tokens().filter(a => !isNative(a));
  const act = all.filter(a => !c.off.includes(akey(a))).length;
  return `<div class="row btlh"><div><div class="k" style="margin:0">⚙ Bot configuration suite</div><div class="mut sm" style="margin-top:.25rem">Where the bot trades: pools, base coins and tokens.</div></div><button class="sm ghost" onclick="window.bt.reset()">↺ Reset defaults</button></div>
  <div class="btbox"><div class="row btlh"><b>⇄ AMM target pair</b><span class="chip">${pools.length} pools</span></div><select class="btsel" onchange="window.bt.pair(this.value)"><option value="all" ${c.pair === 'all' ? 'selected' : ''}>All tokens (rotational mode)</option>${pools.filter(p => !M.isOldUsd(p.a) && !M.isOldUsd(p.b)).map(p => `<option value="${esc(p.account)}" ${c.pair === p.account ? 'selected' : ''}>${esc(nm(p.a))} / ${esc(nm(p.b))}</option>`).join('')}</select></div>
  <div class="btbox"><div class="row btlh"><b>▤ AMM base pool liquidity</b><span class="chip">Multi-select active</span></div><div class="mut sm" style="margin-bottom:.6rem">The coins the bot spends and deposits. Rotational scans spread trades across the pools they sit in.</div><div class="btchips three bigc">${hubs().map(h => tog(nm(h.a), c.baseOn.includes(akey(h.a)), `window.bt.base('${esc(akey(h.a))}')`, h.sub)).join('')}</div></div>
  <div class="btbox"><div class="row btlh"><b>◎ Active rotational tokens</b><span><span class="chip">${act} of ${all.length} active</span> <a href="#" class="mut sm" onclick="window.bt.allTok(${act === all.length ? 0 : 1});return false">${act === all.length ? 'Minimal' : 'All'}</a></span></div><div class="mut sm" style="margin-bottom:.6rem">Select or deselect tokens to narrow the bot's scan radius.</div>${tokenChips()}</div>`;
}
function logHtml(list: Entry[]): string {
  const f = BT.logf, rows = list.filter(e => (f === 'all' || e.kind === f) && (!BT.done || e.st === 'ok'));
  if (!rows.length) return '<div class="mut" style="padding:.8rem">Nothing yet. Press Start bot or Execute once.</div>';
  return rows.slice(0, 80).map(e => `<div class="btl ${e.st}"><div class="row" style="justify-content:space-between"><span class="mut sm">${when(e.ts)}</span><span class="bttag">${esc(e.tag)}</span></div><div class="btmsg">${esc(e.msg)}</div>${e.route || e.hash || e.st === 'pending' ? `<div class="row btmeta"><span>${e.route ? 'Route: <b>' + esc(e.route) + '</b>' : ''}${e.size ? ' • Size: <b>' + esc(e.size) + '</b>' : ''}</span><span>${e.st === 'pending' ? 'Tx: PENDING' : e.st === 'ok' ? 'Tx: OK ' + esc(short(e.hash || '', 6, 4)) : e.st === 'fail' ? 'Tx: FAILED' : ''}</span></div>` : ''}</div>`).join('');
}
function paintLog() {
  setHtml('bt_log', logHtml(BT.log));
  setHtml('bt_recent', logHtml(BT.log.filter((e: Entry) => e.kind === 'trade' || e.kind === 'arb' || e.kind === 'lp').slice(0, 12)));
}
function paintPane() { const e = $('bt_pane') as any; if (!e) return; if (document.activeElement && e.contains(document.activeElement) && (document.activeElement as any).type === 'number') return; e.innerHTML = paneHtml(BT.tab); e.__h = null; paintLog(); paintOffers(); const s = $('bt_suite') as any; if (s && !(document.activeElement && s.contains(document.activeElement))) s.innerHTML = suiteHtml(); }
function paintOffers() {
  const offs: any[] = BT.offers || [];
  setHtml('bt_offers', offs.length ? `<table class="dxt"><thead><tr><th>#</th><th>Selling</th><th>For</th><th class="r">Price</th><th></th></tr></thead><tbody>${offs.map(o => { const g = amtNum(o.taker_gets), p = amtNum(o.taker_pays); const cg = typeof o.taker_gets === 'string' ? ctx.native() : hexName(o.taker_gets.currency), cp = typeof o.taker_pays === 'string' ? ctx.native() : hexName(o.taker_pays.currency); return `<tr><td>${o.seq}</td><td>${fmt(g)} ${esc(cg)}</td><td>${fmt(p)} ${esc(cp)}</td><td class="r mono">${g > 0 ? fmt(p / g, 6) : '–'}</td><td class="r"><button class="sm ghost" onclick="window.bt.cancel(${o.seq},this)">Cancel</button></td></tr>`; }).join('')}</tbody></table>` : '<div class="mut" style="padding:.6rem">No open orders.</div>');
}
function paint() {
  const c: Cfg = BT.cfg, run = BT.running, s = BT.sess, L = BT.life, v = BT.view;
  setHtml('bt_status', `<span class="chip ${run ? '' : 'bad'}">${run ? (BT.busy ? 'WORKING' : 'ACTIVE') : 'STOPPED'}</span>`);
  const go = $('bt_go'); if (go) { go.textContent = run ? '■ Stop bot' : '▶ Start bot'; go.className = run ? 'bad' : 'pri acc'; }
  const lpY = v ? v.lpYield : 0, sessLp = v ? lpY - BT.lp0 : 0, gas = L.gas, net = L.arb + lpY - gas, sNet = s.arb + sessLp - s.gas;
  const T = (k: string, big: string, sub: string, cls = '') => `<div class="tile kvt"><div class="k">${k}</div><div class="big2 ${cls}">${big}</div><div class="mut" style="font-size:.78rem">${sub}</div></div>`;
  const stance = c.buyPct === 50 ? 'NEUTRAL' : c.buyPct > 50 ? 'BULLISH' : 'BEARISH';
  setHtml('bt_tiles', [
    T('Bot engine status', run ? 'ACTIVE ENGINE' : 'STOPPED', run ? `Running every ${c.every}s in the background` : 'Press Start bot'),
    T('Volume traded', money(s.vol), `${fmt(s.swaps + s.arbs * 3, 0)} swaps routed`),
    T('Captured arbitrage yield', (s.arb >= 0 ? '+' : '') + money(s.arb), `${s.arbs} loops completed`),
    T('AMM cycles executed', `${s.deps} Cycles`, `${BT.pools} AMM pools monitored`),
    T('Gas fees burned', fmt(s.gas, 6) + ' ' + ctx.native(), toUsd(s.gas) != null ? '~ ' + usd(toUsd(s.gas)) : ''),
    T('Trading stance and bias', stance + ' ' + (BT.cfg.strat === 'maker' ? 'MM' : BT.cfg.strat === 'arb' ? 'ARB' : BT.cfg.strat === 'rotate' ? 'SWAP' : 'ALL'), `${c.buyPct}% buy / ${100 - c.buyPct}% sell`),
  ].join(''));
  setHtml('bt_totals', [
    T('Total net profits', `<span style="color:var(--ok)">${money(net)}</span>`, `<span class="row" style="justify-content:space-between"><span>LP yield: ${money(lpY)}</span><span>Arb: ${money(L.arb)}</span></span>`),
    T('Session profits', `<span style="color:var(--ok)">${money(sNet)}</span>`, `<span class="row" style="justify-content:space-between"><span>S-LP: ${money(sessLp)}</span><span>S-Arb: ${money(s.arb)}</span></span>`),
    T('Volume processed', money(L.vol), `Session vol: ${money(s.vol)}`),
    T('TX execution count', fmt(L.tx, 0) + ' Trades', `Session: ${s.tx} matches`),
    T('Gas burned', `<span style="color:#f5a623">${fmt(L.gas, 5)} ${esc(ctx.native())}</span>`, `Session: ${fmt(s.gas, 5)} ${esc(ctx.native())}`),
  ].join(''));
  const hd = $('bt_wallet'); if (hd) hd.innerHTML = `Active account: <b>${esc(ctx.wallets().find(w => w.address === ctx.account())?.label || short(ctx.account() || '', 6, 4))}</b> <span class="chip">${esc(ctx.netKey() === 'main' ? 'MAINNET' : 'TESTNET')} ACTIVE</span><div class="mut sm mono">${esc(short(ctx.show(ctx.account() || ''), 10, 8))} • ${v && BT.W ? fmt(BT.W.native, 2) + ' ' + esc(ctx.native()) : ''}</div>`;
  paintOffers();
}
export function botShell() {
  if (!BT.loaded) { loadCfg(); BT.loaded = true; }
  const c: Cfg = BT.cfg;
  return `<div id="bt" class="nwpage bt2">
    <div class="btcard"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:1rem;align-items:flex-start"><div style="min-width:15rem;flex:1"><div class="k" style="margin:0">Autonomous trading &amp; LP filling bot <span id="bt_status"></span></div><div class="mut" style="font-size:.84rem;margin-top:.4rem">Deploys liquidity depth, harvests spreads on the order book, scans three-pool arbitrage loops and applies your take-profit rules. Every action is a real transaction signed by your wallet while Starsky stays open and unlocked.</div></div>
      <div class="row" style="gap:.6rem;flex-wrap:wrap;align-items:center"><div class="btnext"><span class="mut sm">Next execution</span><b id="bt_next" class="mono">–</b></div><button class="ghost" onclick="window.bt.once(this)">⟳ Execute once</button><button id="bt_go" class="pri acc" onclick="window.bt.toggle()">▶ Start bot</button></div></div>
      <div id="bt_wallet" class="btwal"></div><div id="bt_msg" class="mut sm" style="margin-top:.4rem"></div></div>
    <div class="btgrid6" id="bt_tiles"></div><div class="btgrid5" id="bt_totals"></div>
    <div class="btmain"><div class="btleft">
      <div class="bttabs">${[['logs', 'Logs'], ['orders', 'Orders'], ['sizing', 'Sizing'], ['pathways', 'Pathways'], ['safety', 'Safety']].map(([k, l]) => `<button class="${BT.tab === k ? 'on' : ''}" onclick="window.bt.tab('${k}')">${l}</button>`).join('')}</div>
      <div class="btbox"><div class="k" style="margin:0 0 .6rem">▣ Primary core strategy</div><select class="btsel" onchange="window.bt.strat(this.value)">${(Object.keys(STRATS) as Strat[]).map(k => `<option value="${k}" ${c.strat === k ? 'selected' : ''}>${esc(STRATS[k][0])}</option>`).join('')}</select><div id="bt_sdesc" class="mut sm" style="margin-top:.5rem">${esc(STRATS[c.strat][1])}</div>
        <div class="btsub">Trading directional bias</div>${seg([['neutral', 'Neutral'], ['bull', 'Bullish'], ['bear', 'Bearish']], c.dir, 'dir')}</div>
      <div class="btbox"><div class="row btlh"><div class="k" style="margin:0">↗ Trading direction bias</div><span id="bt_leanchip" class="chip"></span></div>
        <div class="btpair tight"><label class="btbuy"><span>● Buy side (long) <b id="bt_bpct"></b></span><span class="btnum"><input id="bt_buy" type="number" min="0" max="100" value="${c.buyPct}" onchange="window.bt.buy(this.value)"><em>%</em></span></label><label class="btsell"><span>● Sell side (short) <b id="bt_spct"></b></span><span class="btnum"><input id="bt_sell" type="number" min="0" max="100" value="${100 - c.buyPct}" onchange="window.bt.buy(100-this.value)"><em>%</em></span></label></div>
        <input id="bt_lean" class="btlean" type="range" min="0" max="100" step="1" value="${c.buyPct}" oninput="window.bt.buy(this.value,1)"><div class="row btleanl"><span style="color:#ff5a5a">100% SELL</span><span>67% SELL / 33% BUY</span><span>50/50 BALANCED</span><span>33% SELL / 67% BUY</span><span style="color:var(--ok)">100% BUY</span></div>
        <div class="btpre">${[[0, '100% Sell'], [33, '33% Buy'], [50, '50/50'], [67, '67% Buy'], [100, '100% Buy']].map(([n, l]) => `<button onclick="window.bt.buy(${n})">${l}</button>`).join('')}</div></div>
      <div class="btbox"><div class="row btlh"><div class="k" style="margin:0">◷ Execution speed</div><b id="bt_spd" class="mono" style="color:var(--ok)"></b></div><div id="bt_speed"></div>
        <label class="btfld" style="margin-top:.7rem"><span class="mut sm">CUSTOM EXECUTION INTERVAL</span><input type="checkbox" ${c.customOn ? 'checked' : ''} onchange="window.bt.flag('customOn',this.checked)"></label><div id="bt_cust"></div></div>
    </div><div class="btright"><div id="bt_pane" class="btbox bigp"></div></div></div>
    <div id="bt_suite" class="btcard" style="margin-top:1rem"></div>
    <div class="mut sm" style="margin:.8rem 0">Lifetime totals are saved in this browser for each wallet. LP yield is the value of the liquidity this bot added minus what it put in, so it moves with pool prices.</div></div>`;
}
function paintLeft() {
  const c: Cfg = BT.cfg;
  const lc = $('bt_leanchip'); if (lc) lc.innerHTML = `<span style="color:#ff5a5a">● ${100 - c.buyPct}% Sell</span> / <span style="color:var(--ok)">● ${c.buyPct}% Buy</span>`;
  const bp = $('bt_bpct'); if (bp) bp.textContent = c.buyPct + '%'; const sp = $('bt_spct'); if (sp) sp.textContent = 100 - c.buyPct + '%';
  const bi = $('bt_buy') as HTMLInputElement | null, si = $('bt_sell') as HTMLInputElement | null, li = $('bt_lean') as HTMLInputElement | null;
  if (bi && document.activeElement !== bi) bi.value = String(c.buyPct); if (si && document.activeElement !== si) si.value = String(100 - c.buyPct); if (li && document.activeElement !== li) li.value = String(c.buyPct);
  const sd = $('bt_spd'); if (sd) sd.textContent = c.every.toFixed(1) + 's';
  setHtml('bt_speed', `<div class="btseg wide">${[1, 3, 5, 10].map(n => `<button class="${c.every === n ? 'on' : ''}" onclick="window.bt.speed('${n}')">${n}s</button>`).join('')}</div>`);
  setHtml('bt_cust', c.customOn ? `<div class="row" style="gap:.6rem;align-items:center"><span class="mut sm">Every</span>${numIn('bt_every', c.every, '1', 's')}<span class="mut sm">minimum 2 seconds</span></div>` : '');
  const ds = $('bt_sdesc'); if (ds) ds.textContent = STRATS[c.strat][1];
}
export async function botMount() {
  if (!BT.loaded) { loadCfg(); BT.loaded = true; }
  loadAcct(); paintLeft(); paintPane(); paint();
  clearInterval(BT.cd);
  BT.cd = setInterval(() => { const e = $('bt_next'); if (!e) { clearInterval(BT.cd); return; } e.textContent = BT.running ? Math.max(0, (BT.nextAt - Date.now()) / 1000).toFixed(1) + 's' : '–'; }, 200);
  await refresh(); paintPane(); paintLeft();
}
const NUM: Record<string, [keyof Cfg, number, number, boolean?]> = {
  bt_spread: ['spread', 0.05, 20], bt_ttl: ['ttl', 30, 3600, true], bt_open: ['maxOpen', 1, 20, true], bt_buysz: ['buySz', 1, 100], bt_sellsz: ['sellSz', 1, 100], bt_baseamt: ['baseAmt', 0.0001, 1e9], bt_targetamt: ['targetAmt', 0.0001, 1e12],
  bt_reserve: ['reserve', 0, 95], bt_slip: ['slip', 0.1, 5], bt_swaps: ['swaps', 1, 5, true], bt_reinvest: ['reinvest', 0, 100], bt_tpamt: ['tpAmt', 0.0001, 1e12], bt_arbmin: ['arbMin', 0.05, 5], bt_every: ['every', 2, 3600, true],
  bt_stoploss: ['stopLoss', 0, 100], bt_stopdraw: ['stopDraw', 0, 100], bt_stoporders: ['stopOrders', 0, 1e9, true],
};
const toggleIn = (arr: string[], k: string) => (arr.includes(k) ? arr.filter(x => x !== k) : [...arr, k]);
export const btApi = {
  set(id: string, v: string | number, live?: number) {
    const d = NUM[id]; if (!d) return; const n = parseFloat(String(v)); if (!(n === n)) return;
    (BT.cfg as any)[d[0]] = clamp(d[3] ? Math.round(n) : n, d[1], d[2]); saveCfg();
    if (id === 'bt_every' && BT.running) startTimer();
    if (id === 'bt_slip') { /* keep the quick buttons in step */ }
    if (!live) { paintPane(); paintLeft(); paint(); } else { const b = document.querySelector(`#bt_pane input[type=number]#${id}`) as HTMLInputElement | null; if (b) b.value = String(n); }
  },
  tab(k: string) { BT.tab = k; document.querySelectorAll('.bttabs button').forEach(b => b.classList.toggle('on', (b as HTMLElement).textContent?.toLowerCase() === k)); paintPane(); },
  strat(v: string) { BT.cfg.strat = v as Strat; saveCfg(); paintLeft(); paint(); },
  dir(k: string) { BT.cfg.dir = k as any; BT.cfg.buyPct = k === 'bull' ? 80 : k === 'bear' ? 20 : 50; saveCfg(); botRepaint(); },
  buy(v: string | number, live?: number) { BT.cfg.buyPct = clamp(Math.round(+v), 0, 100); BT.cfg.dir = BT.cfg.buyPct > 55 ? 'bull' : BT.cfg.buyPct < 45 ? 'bear' : 'neutral'; saveCfg(); if (live) paintLeft(); else botRepaint(); },
  speed(v: string) { BT.cfg.every = clamp(+v, 2, 3600); BT.cfg.customOn = false; saveCfg(); if (BT.running) startTimer(); botRepaint(); },
  slipq(v: string) { BT.cfg.slip = +v; saveCfg(); botRepaint(); },
  method(m: string) { BT.cfg.method = m as any; saveCfg(); paintPane(); },
  mode(m: string) { BT.cfg.mode = m as any; if (m === 'dedicated' && !BT.cfg.ded) { const t = tokens().find(a => !isNative(a)); if (t) BT.cfg.ded = akey(t); } saveCfg(); paintPane(); },
  ded(k: string) { BT.cfg.ded = k; saveCfg(); paintPane(); },
  tok(k: string) { BT.cfg.off = toggleIn(BT.cfg.off, k); saveCfg(); paintPane(); },
  allTok(on: number) { BT.cfg.off = on ? [] : tokens().filter(a => !isNative(a)).map(a => akey(a)); saveCfg(); paintPane(); },
  base(k: string) { const n = toggleIn(BT.cfg.baseOn, k); BT.cfg.baseOn = n.length ? n : BT.cfg.baseOn; saveCfg(); paintPane(); },
  tri(k: string) { const n = toggleIn(BT.cfg.tri, k); BT.cfg.tri = n.length ? n : BT.cfg.tri; saveCfg(); paintPane(); },
  pair(v: string) { BT.cfg.pair = v; saveCfg(); paintPane(); },
  flag(k: string, on: boolean) { (BT.cfg as any)[k] = on; if (k === 'tpOn') BT.tpHit = false; saveCfg(); botRepaint(); },
  act(k: string, on: boolean) { (BT.cfg.act as any)[k] = on; saveCfg(); },
  ov(sym: string, side: 'buy' | 'sell', v: string) { const o = BT.cfg.over[sym] || { buy: 0, sell: 0 }; o[side] = Math.max(0, +v || 0); if (!o.buy && !o.sell) delete BT.cfg.over[sym]; else BT.cfg.over[sym] = o; saveCfg(); },
  expand() { BT.expanded = !BT.expanded; paintPane(); },
  logf(k: string) { BT.logf = k; paintPane(); },
  done(on: boolean) { BT.done = on; paintLog(); },
  clear() { BT.log = []; paintLog(); },
  reset() { const keep = BT.cfg.over; BT.cfg = { ...DEF, act: { ...DEF.act }, over: keep }; saveCfg(); if (BT.running) startTimer(); botRepaint(); },
  async toggle() {
    if (BT.running) return stop('Stopped by you');
    const msg = $('bt_msg'), say = (t: string) => msg && (msg.textContent = t);
    say('');
    if (!ctx.account()) return say('Select a wallet first.');
    const w = ctx.wallets().find(x => x.address === ctx.account());
    if (!w || w.type !== 'luma') return say('The bot works with a LUMA wallet. Switch to LUMA mode.');
    loadAcct(); await feeNative();
    const sn = await snap(true), W = await wallet();
    if (!W) return say('The wallet is not funded on this network.');
    if (!venues(sn).length && BT.cfg.strat !== 'arb') return say('No pools match your base pools and token choices. Check the configuration suite.');
    BT.running = true; BT.sess = zero(); BT.tpHit = false; BT.uncomp = 0; BT.ticks = 0; BT.startedAt = Date.now(); BT.failRun = 0;
    BT.W = W; const v = computeView(W, sn); BT.start0 = v.eq; BT.peak = v.eq; BT.lp0 = v.lpYield;
    note('note', 'ENGINE', `Started: ${STRATS[BT.cfg.strat as Strat][0]} on ${BT.pools} pools with ${w.label}, every ${BT.cfg.every}s.`);
    startTimer(); tick(); paint();
  },
  async once(btn: HTMLButtonElement) {
    const msg = $('bt_msg'); if (!ctx.account()) return void (msg && (msg.textContent = 'Select a wallet first.'));
    const w = ctx.wallets().find(x => x.address === ctx.account()); if (!w || w.type !== 'luma') return void (msg && (msg.textContent = 'The bot works with a LUMA wallet. Switch to LUMA mode.'));
    btn.disabled = true; loadAcct(); await feeNative();
    if (BT.start0 == null) BT.sess = zero();
    await tick(true); btn.disabled = false;
  },
  async cancelAll(btn: HTMLButtonElement) {
    const acc = ctx.account(); if (!acc) return; btn.disabled = true; let n = 0;
    for (const o of BT.offers || []) { const r = await ctx.submit({ TransactionType: 'OfferCancel', Account: acc, OfferSequence: o.seq }); if (r.ok) n++; }
    bump('cancelled', n); note('note', 'ORDERS', `Cancelled ${n} orders.`, 'ok'); btn.disabled = false; refresh();
  },
  async cancel(seq: number, btn: HTMLButtonElement) { const acc = ctx.account(); if (!acc) return; btn.disabled = true; const r = await ctx.submit({ TransactionType: 'OfferCancel', Account: acc, OfferSequence: seq }); if (r.ok) bump('cancelled'); refresh(); },
};
function botRepaint() { paintLeft(); paintPane(); paint(); }
export const botRunning = () => BT.running;
void M;
