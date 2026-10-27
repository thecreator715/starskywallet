// Pools, prices, tokens, candles and trades, all read from the ledger (no samples, no simulation).
import { ctx } from './ctx.ts';
import { Asset, NATIVE, akey, assetOf, amtNum, fromKey, hexName, isNative, issueOf, rippleToMs } from './util.ts';
import { cached, header, info, ledgerAgo, ledgerSeries, pool, req, secPerLedger, tryReq, WINDOWS, Window } from './chain.ts';

export interface PoolRef {
  account: string;
  a: Asset;
  b: Asset;
  fee: number; // percent
  lpCur: string;
}
export interface PoolState extends PoolRef {
  ra: number;
  rb: number;
  lp: number;
}
const sameAsset = (x: Asset, y: Asset) => akey(x) === akey(y);

/** every AMM pool on the ledger */
/** every token that exists on the ledger (found from the trust lines), with or without a pool: MAGIC, MINT and anything created later */
export async function discoverTokens(): Promise<Asset[]> {
  return cached('discover', 60000, async () => {
    const seen = new Map<string, Asset>();
    let marker: any;
    for (let p = 0; p < 30; p++) {
      const r: any = await tryReq('ledger_data', { type: 'state', ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) });
      if (!r) break;
      for (const o of r.state || []) {
        if (o.LedgerEntryType !== 'RippleState') continue;
        const lo = o.LowLimit || {}, hi = o.HighLimit || {}, cur = (o.Balance || {}).currency;
        if (!cur || !lo.issuer || !hi.issuer) continue;
        const bal = Number((o.Balance || {}).value || 0);
        const loZero = Number(lo.value) === 0, hiZero = Number(hi.value) === 0;
        const iss = bal > 0 ? hi.issuer : bal < 0 ? lo.issuer : loZero && !hiZero ? lo.issuer : hiZero && !loZero ? hi.issuer : '';
        if (!iss || /^03/.test(cur)) continue; // 03… are AMM liquidity tokens
        const a = { c: cur, i: iss };
        seen.set(akey(a), a);
      }
      marker = r.marker;
      if (!marker) break;
    }
    return [...seen.values()];
  });
}
export async function poolRefs(): Promise<PoolRef[]> {
  return cached('poolrefs', 30000, async () => {
    const out: PoolRef[] = [];
    let marker: any;
    for (let page = 0; page < 20; page++) {
      const r: any = await req('ledger_data', { type: 'amm', ledger_index: 'validated', limit: 200, ...(marker ? { marker } : {}) });
      for (const o of r.state || []) {
        out.push({ account: o.Account, a: assetOf(o.Asset), b: assetOf(o.Asset2), fee: (o.TradingFee || 0) / 1000, lpCur: (o.LPTokenBalance || {}).currency || '' });
      }
      marker = r.marker;
      if (!marker) break;
    }
    ALL_POOLS = out.slice();
    pickMainUsd(out);
    return out.filter(q => !isOldUsd(q.a) && !isOldUsd(q.b));   // pools on an OLD USD are not shown in Starsky
  });
}
/** reserves of a pool now (seq undefined) or at a past validated ledger */
export async function poolState(ref: PoolRef, seq?: number): Promise<PoolState | null> {
  const key = `pst${ref.account}|${seq ?? 'now'}`;
  try {
    return await cached(key, seq ? Infinity : 4000, async () => {
      const li = seq ? { ledger_index: seq } : { ledger_index: 'validated' };
      try {
        const r: any = await req('amm_info', { asset: issueOf(ref.a), asset2: issueOf(ref.b), ...(seq ? { ledger_index: seq } : {}) });
        const m = r.amm;
        if (m) return { ...ref, ra: amtNum(m.amount), rb: amtNum(m.amount2), lp: Number((m.lp_token || {}).value || 0), fee: (m.trading_fee ?? ref.fee * 1000) / 1000 } as PoolState;
      } catch {}
      // fallback: read the pool account's own balances
      const [ai, al]: any[] = await Promise.all([tryReq('account_info', { account: ref.account, ...li }), tryReq('account_lines', { account: ref.account, ...li, limit: 400 })]);
      if (!ai || !ai.account_data) throw new Error('none');
      const bal = (a: Asset) => {
        if (isNative(a)) return Number(ai.account_data.Balance) / 1e6;
        const l = ((al && al.lines) || []).find((x: any) => x.currency === a.c && x.account === a.i);
        return l ? Math.abs(Number(l.balance)) : 0;
      };
      return { ...ref, ra: bal(ref.a), rb: bal(ref.b), lp: 0 } as PoolState;
    });
  } catch {
    return null;
  }
}
/** first validated ledger in which a pool exists (binary search, cached forever) */
export async function firstSeen(ref: PoolRef): Promise<number> {
  return cached('first' + ref.account, Infinity, async () => {
    const i = await info();
    let lo = i.minSeq,
      hi = i.seq;
    if (await poolState(ref, lo)) return lo;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (await poolState(ref, mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  });
}
export interface Snap {
  seq: number;
  pools: PoolState[];
  px: Map<string, number>; // native per 1 unit of the asset
  usdPerNative: number | null;
  usdKey: string | null;
  root: string; // the asset every price is quoted in (the native coin when it has a pool, else the dollar token)
}
/** price of every asset in native units, walking through the deepest pools first */
export function pickRoot(pools: PoolState[]): string {
  const live = pools.filter(p => p.ra > 0 && p.rb > 0);
  if (live.some(p => isNative(p.a) || isNative(p.b))) return 'native';
  const want = ctx.usdName().toUpperCase();
  let best = '',
    liq = -1;
  for (const p of live)
    for (const [a, r] of [[p.a, p.ra] as const, [p.b, p.rb] as const]) {
      const isUsd = !isNative(a) && hexName(a.c).toUpperCase() === want;
      const score = (isUsd ? 1e18 : 0) + (isUsd && MAIN_USD && a.i === MAIN_USD ? 1e19 : 0) + r;
      if (score > liq) {
        liq = score;
        best = akey(a);
      }
    }
  return best || 'native';
}
export function priceGraph(pools: PoolState[], root = pickRoot(pools)): Map<string, number> {
  const px = new Map<string, number>([[root, 1]]);
  for (;;) {
    let best: { k: string; p: number; liq: number } | null = null;
    for (const p of pools) {
      if (!(p.ra > 0 && p.rb > 0)) continue;
      const ka = akey(p.a),
        kb = akey(p.b);
      const pa = px.get(ka),
        pb = px.get(kb);
      if (pa != null && pb == null) {
        const liq = p.ra * pa;
        if (!best || liq > best.liq) best = { k: kb, p: (p.ra / p.rb) * pa, liq };
      } else if (pb != null && pa == null) {
        const liq = p.rb * pb;
        if (!best || liq > best.liq) best = { k: ka, p: (p.rb / p.ra) * pb, liq };
      }
    }
    if (!best) break;
    px.set(best.k, best.p);
  }
  return px;
}
export function usdKeyOf(px: Map<string, number>, pools: PoolState[]): string | null {
  const want = ctx.usdName().toUpperCase();
  let best: string | null = null,
    liq = -1;
  for (const k of px.keys()) {
    if (k === 'native') continue;
    const a = fromKey(k);
    if (hexName(a.c).toUpperCase() !== want) continue;
    let l = MAIN_USD && a.i === MAIN_USD ? 1e18 : 0;
    for (const p of pools) if (akey(p.a) === k || akey(p.b) === k) l += (akey(p.a) === k ? p.ra : p.rb) * (px.get(k) || 0);
    if (l > liq) {
      liq = l;
      best = k;
    }
  }
  return best;
}
function mkSnap(seq: number, pools: PoolState[]): Snap {
  const root = pickRoot(pools);
  const px = priceGraph(pools, root);
  const uk = usdKeyOf(px, pools) || (root !== 'native' && hexName(fromKey(root).c).toUpperCase() === ctx.usdName().toUpperCase() ? root : null);
  return { seq, pools, px, root, usdKey: uk, usdPerNative: uk && px.get(uk) ? 1 / (px.get(uk) as number) : null };
}
/** state of every pool now, or at a past ledger */
export async function snapshot(seq?: number): Promise<Snap> {
  const refs = await poolRefs();
  const i = await info();
  const states = (await pool(refs, 8, r => poolState(r, seq))).filter(Boolean) as PoolState[];
  return mkSnap(seq || i.seq, states);
}
export const usdPx = (s: Snap, k: string) => (s.usdPerNative == null ? null : s.px.has(k) ? (s.px.get(k) as number) * s.usdPerNative : null);

export interface WinSnap {
  w: Window;
  seq: number;
  ageSec: number;
  clamped: boolean;
  snap: Snap;
}
/** snapshots at 5m / 1h / 24h / 7d / oldest ledger ago */
export async function windowSnaps(): Promise<WinSnap[]> {
  return cached('winsnaps', 20000, async () => {
    const out: WinSnap[] = [];
    for (const w of WINDOWS) {
      const at = await ledgerAgo(w.sec);
      out.push({ w, seq: at.seq, ageSec: at.ageSec, clamped: at.clamped, snap: await snapshot(at.seq) });
    }
    return out;
  });
}
const chg = (now: number | null, then: number | null) => (now == null || then == null || !(then > 0) ? null : (now / then - 1) * 100);
/** price of `base` in `quote` units (quote per base) */
export function ratio(s: Snap, base: Asset, quote: Asset): number | null {
  const pb = s.px.get(akey(base)),
    pq = s.px.get(akey(quote));
  return pb != null && pq != null && pq > 0 ? pb / pq : null;
}
export interface TokenRow {
  key: string;
  a: Asset;
  name: string;
  issuer: string;
  nativePx: number | null;
  usdPx: number | null;
  chg: Record<string, number | null>; // by window key, in USD terms (native terms if no dollar token)
  partial: Record<string, boolean>; // true when the window is longer than the token's life: change is since its first pool
  listedSeq: number | null;
  supply: number | null;
  tvlNative: number;
  tvlUsd: number | null;
  mcapUsd: number | null;
  mcapNative: number | null;
  pools: number;
}
export async function supplyOf(a: Asset): Promise<number | null> {
  if (isNative(a)) {
    const h = await header('validated');
    return h ? h.total : null;
  }
  const g: any = await tryReq('gateway_balances', { account: a.i, ledger_index: 'validated' }, 30000);
  if (!g || g.error) return null;
  const ob = g.obligations || {};
  const k = Object.keys(ob).find(x => x === a.c || hexName(x) === hexName(a.c));
  return k ? Number(ob[k]) : 0;
}
/** every asset on the network that has a pool, plus any extra assets (the wallet's lines, watch list) */
export async function tokenTable(extra: Asset[] = []): Promise<{ rows: TokenRow[]; now: Snap; ws: WinSnap[] }> {
  const ws = await windowSnaps();
  const now = await snapshot();
  const keys = new Set<string>(['native']);
  for (const p of now.pools) {
    keys.add(akey(p.a));
    keys.add(akey(p.b));
  }
  for (const a of extra) keys.add(akey(a));
  for (const a of await discoverTokens().catch(() => [] as Asset[])) keys.add(akey(a)); // every token on the ledger, pooled or not
  const useUsd = now.usdPerNative != null;
  const mode = (s: Snap, k: string) => (useUsd ? (s.usdPerNative != null ? usdPx(s, k) : null) : (s.px.get(k) ?? null));
  const rows = await pool([...keys], 6, async k => {
    const a = fromKey(k);
    const np = now.px.get(k) ?? null,
      up = usdPx(now, k);
    const nowV = mode(now, k);
    const ch: Record<string, number | null> = {},
      part: Record<string, boolean> = {};
    const mine = now.pools.filter(p => akey(p.a) === k || akey(p.b) === k);
    const firsts = k === 'native' || !mine.length ? [] : await Promise.all(mine.map(p => firstSeen(p)));
    const listed = k === 'native' ? await Promise.all(now.pools.map(p => firstSeen(p))).then(a => (a.length ? Math.min(...a) : null)) : firsts.length ? Math.min(...firsts) : null;
    let listedSnap: Snap | null = null;
    for (const w of ws) {
      const had = w.snap.px.has(k) && (mode(w.snap, k) != null);
      if (w.w.k !== 'all' && had) ch[w.w.k] = chg(nowV, mode(w.snap, k));
      else if (listed != null && (w.w.k === 'all' || w.seq < listed)) {
        listedSnap = listedSnap || (await snapshot(listed));
        ch[w.w.k] = listedSnap.px.has(k) ? chg(nowV, mode(listedSnap, k)) : null;
        part[w.w.k] = w.w.k !== 'all';
      } else ch[w.w.k] = null;
    }
    let tvl = 0,
      n = 0;
    for (const p of now.pools) {
      const pa = now.px.get(akey(p.a)),
        pb = now.px.get(akey(p.b));
      if (akey(p.a) === k || akey(p.b) === k) {
        n++;
        if (pa != null && pb != null) tvl += akey(p.a) === k ? p.ra * pa : p.rb * pb;
      }
    }
    const sup = await supplyOf(a);
    return {
      key: k,
      a,
      name: labelOf(a),
      issuer: a.i,
      nativePx: np,
      usdPx: up,
      chg: ch,
      partial: part,
      listedSeq: listed,
      supply: sup,
      tvlNative: tvl,
      tvlUsd: now.usdPerNative != null ? tvl * now.usdPerNative : null,
      mcapUsd: sup != null && up != null ? sup * up : null,
      mcapNative: sup != null && np != null ? sup * np : null,
      pools: n,
    } as TokenRow;
  });
  rows.sort((x, y) => (y.mcapUsd ?? y.mcapNative ?? -1) - (x.mcapUsd ?? x.mcapNative ?? -1));
  return { rows, now, ws };
}

/* ---------- markets (pairs) ---------- */
export interface Market {
  id: string; // base/quote keys
  base: Asset;
  quote: Asset;
  label: string;
  pool: PoolRef | null; // direct pool if any
}
export const marketId = (b: Asset, q: Asset) => akey(b) + '/' + akey(q);
export let MAIN_USD = '';
let ALL_POOLS: PoolRef[] = [];
/** the pool an LP-token trust line belongs to (LP tokens are issued by the pool account) */
export const lpPoolOf = (a: { c: string; i: string }) => ALL_POOLS.find(p => p.account === a.i && p.lpCur === a.c) || null;
/** the main USD is the issuer that most pools use; any other issuer of a USD-coded token is an OLD duplicate */
export const isOldUsd = (a: Asset) => !isNative(a) && hexName(a.c).toUpperCase() === 'USD' && !!MAIN_USD && a.i !== MAIN_USD;
export const labelOf = (a: Asset) => (isNative(a) ? ctx.native() : isOldUsd(a) ? 'USD (old)' : hexName(a.c));
function pickMainUsd(pools: PoolRef[]) {
  const n = new Map<string, number>();
  for (const p of pools) for (const a of [p.a, p.b]) if (!isNative(a) && hexName(a.c).toUpperCase() === 'USD') n.set(a.i, (n.get(a.i) || 0) + 1);
  let best = '', c = 0;
  for (const [i, k] of n) if (k > c || (k === c && i < best)) (best = i), (c = k);
  MAIN_USD = best;
}
export function marketsFrom(pools: PoolRef[], extra: Market[] = []): Market[] {
  const out = new Map<string, Market>();
  const rank = (a: Asset) => (isNative(a) ? 0 : isOldUsd(a) ? 2 : hexName(a.c).toUpperCase() === ctx.usdName().toUpperCase() ? 1 : 2);
  for (const p of pools) {
    // quote is the "more basic" side: LUMA, then dollar token, then anything
    let b = p.a,
      q = p.b;
    if (rank(p.a) < rank(p.b) || (rank(p.a) === rank(p.b) && akey(p.a) < akey(p.b))) [b, q] = [q, b];
    out.set(marketId(b, q), { id: marketId(b, q), base: b, quote: q, label: labelOf(b) + '/' + labelOf(q), pool: p });
  }
  for (const m of extra) if (!out.has(m.id)) out.set(m.id, m);
  return [...out.values()].sort((x, y) => x.label.localeCompare(y.label));
}
/** direct pool of a market, either orientation */
export const directPool = (pools: PoolRef[], b: Asset, q: Asset) => pools.find(p => (sameAsset(p.a, b) && sameAsset(p.b, q)) || (sameAsset(p.a, q) && sameAsset(p.b, b))) || null;
/** spot price of base in quote from one pool state */
export const poolPrice = (p: PoolState, base: Asset) => (sameAsset(p.a, base) ? (p.ra > 0 ? p.rb / p.ra : null) : p.rb > 0 ? p.ra / p.rb : null);

export interface RangeDef {
  k: string;
  label: string;
  sec: number;
  candles: number;
}
export const RANGES: RangeDef[] = [
  { k: '5m', label: '5m', sec: 300, candles: 30 },
  { k: '15m', label: '15m', sec: 900, candles: 45 },
  { k: '30m', label: '30m', sec: 1800, candles: 60 },
  { k: '1h', label: '1h', sec: 3600, candles: 60 },
  { k: '4h', label: '4h', sec: 4 * 3600, candles: 48 },
  { k: '1d', label: '1d', sec: 86400, candles: 48 },
  { k: '7d', label: '7d', sec: 7 * 86400, candles: 56 },
  { k: '1M', label: '1M', sec: 30 * 86400, candles: 60 },
  { k: '3M', label: '3M', sec: 90 * 86400, candles: 60 },
  { k: '1y', label: '1y', sec: 365 * 86400, candles: 60 },
  { k: 'all', label: 'all', sec: Infinity, candles: 60 },
];
export interface Candle {
  t: number; // ms start
  o: number;
  h: number;
  l: number;
  c: number;
  vol?: number; // real traded volume in quote units (sum of the swaps in this candle)
  buyVol?: number;
  sellVol?: number;
  n?: number; // number of swaps
  flow: number; // quote-side pool flow in the candle (|change of the pool's quote reserve|)
}
/** price of base in quote at a past ledger */
async function priceAtSeq(m: Market, seq: number, dp: PoolRef | null): Promise<{ p: number | null; qres: number | null }> {
  if (dp) {
    const s = await poolState(dp, seq);
    if (!s) return { p: null, qres: null };
    return { p: poolPrice(s, m.base), qres: sameAsset(s.a, m.quote) ? s.ra : s.rb };
  }
  const s = await snapshot(seq);
  return { p: ratio(s, m.base, m.quote), qres: null };
}
/**
 * Candles built from the pool's real price at past ledgers (three readings per candle: open, middle, close).
 * Wicks therefore show where the price was at those moments, not every trade.
 */
export async function candles(m: Market, range: RangeDef): Promise<{ list: Candle[]; first: number; clamped: boolean; note: string }> {
  const i = await info();
  const per = await secPerLedger();
  const nowH = await header(i.seq);
  const nowMs = nowH ? nowH.close : Date.now();
  const first = isFinite(range.sec) ? Math.max(i.minSeq, Math.round(i.seq - range.sec / per)) : i.minSeq;
  const clamped = isFinite(range.sec) && i.seq - range.sec / per < i.minSeq - 1;
  const n = range.candles;
  const stepSeq = Math.max(1, Math.round((i.seq - first) / (n * 2)));
  const seqs: number[] = [];
  for (let k = 0; k <= n * 2; k++) {
    let s = Math.round(first + ((i.seq - first) * k) / (n * 2));
    s = k === n * 2 ? i.seq : Math.max(first, Math.round(s / stepSeq) * stepSeq);
    seqs.push(Math.min(s, i.seq));
  }
  const refs = await poolRefs();
  const dp = directPool(refs, m.base, m.quote);
  const pts = await pool(seqs, 8, s => priceAtSeq(m, s, dp));
  const list: Candle[] = [];
  let lastP: number | null = null;
  for (let c = 0; c < n; c++) {
    const trio = [pts[c * 2], pts[c * 2 + 1], pts[c * 2 + 2]];
    const ps = trio.map(x => x.p).filter(x => x != null && x > 0) as number[];
    if (!ps.length) continue;
    const o = trio[0].p ?? lastP ?? ps[0],
      cl = trio[2].p ?? ps[ps.length - 1];
    const q0 = trio[0].qres,
      q2 = trio[2].qres;
    list.push({
      t: nowMs - (i.seq - seqs[c * 2]) * per * 1000,
      o: o as number,
      h: Math.max(...ps, o as number),
      l: Math.min(...ps, o as number),
      c: cl,
      flow: q0 != null && q2 != null ? Math.abs(q2 - q0) : 0,
    });
    lastP = cl;
  }
  return {
    list,
    first,
    clamped,
    note: clamped ? 'This node keeps history only back to ledger ' + i.minSeq + '.' : '',
  };
}

/* ---------- trades (from the pool account's own transaction metadata) ---------- */
export interface Trade {
  hash: string;
  ms: number;
  ledger: number;
  kind: 'buy' | 'sell' | 'add' | 'remove';
  who: string;
  base: number; // base amount moved
  quote: number; // quote amount moved
  price: number | null; // quote per base
  type: string;
}
function poolDelta(meta: any, p: PoolRef, a: Asset): number {
  let d = 0;
  for (const n of meta?.AffectedNodes || []) {
    const x = n.ModifiedNode || n.CreatedNode || n.DeletedNode;
    if (!x) continue;
    const fin = x.FinalFields || x.NewFields || {};
    const prev = x.PreviousFields || (n.CreatedNode ? { Balance: isNative(a) ? '0' : { value: '0' } } : {});
    if (isNative(a) && x.LedgerEntryType === 'AccountRoot' && fin.Account === p.account && prev.Balance != null) d += (Number(fin.Balance) - Number(prev.Balance)) / 1e6;
    if (!isNative(a) && x.LedgerEntryType === 'RippleState' && (fin.Balance || {}).currency === a.c) {
      const lo = (fin.LowLimit || {}).issuer,
        hi = (fin.HighLimit || {}).issuer;
      if ((lo === p.account && hi === a.i) || (hi === p.account && lo === a.i)) {
        const pb = (prev.Balance || {}).value;
        if (pb == null) continue;
        const dv = Number(fin.Balance.value) - Number(pb);
        d += lo === p.account ? dv : -dv;
      }
    }
  }
  return d;
}
function parseTrades(r: any, dp: PoolRef, m: Market): Trade[] {
  const out: Trade[] = [];
  for (const e of (r && r.transactions) || []) {
    const t = e.tx || e.tx_json || {},
      meta = e.meta || e.metaData || {};
    if (meta.TransactionResult && meta.TransactionResult !== 'tesSUCCESS') continue;
    const dBase = poolDelta(meta, dp, m.base),
      dQuote = poolDelta(meta, dp, m.quote);
    if (!dBase && !dQuote) continue;
    const type = t.TransactionType || '';
    const liq = /^AMM/.test(type);
    const ms = t.date != null ? rippleToMs(t.date) : e.date != null ? rippleToMs(e.date) : 0;
    let kind: Trade['kind'];
    if (liq) kind = dBase + dQuote >= 0 && (dBase >= 0 && dQuote >= 0) ? 'add' : dBase <= 0 && dQuote <= 0 ? 'remove' : dBase + dQuote >= 0 ? 'add' : 'remove';
    else kind = dBase < 0 ? 'buy' : 'sell';
    out.push({
      hash: t.hash || e.hash || '',
      ms,
      ledger: Number(e.ledger_index || t.ledger_index || t.inLedger || 0),
      kind,
      who: t.Account || '',
      base: Math.abs(dBase),
      quote: Math.abs(dQuote),
      price: dBase && dQuote ? Math.abs(dQuote / dBase) : null,
      type,
    });
  }
  return out;
}
export async function trades(m: Market, limit = 120): Promise<Trade[]> {
  const refs = await poolRefs();
  const dp = directPool(refs, m.base, m.quote);
  if (!dp) return [];
  const r: any = await tryReq('account_tx', { account: dp.account, limit, ledger_index_min: -1, ledger_index_max: -1 }, 5000);
  return parseTrades(r, dp, m);
}
const VOLC = new Map<string, { at: number; t: Trade[] }>();
/** every swap in the pool since `sinceMs` (pages back through the pool's history, up to ~4000 transactions) */
export async function tradesSince(m: Market, sinceMs: number): Promise<Trade[]> {
  const refs = await poolRefs();
  const dp = directPool(refs, m.base, m.quote);
  if (!dp) return [];
  const key = dp.account + ':' + Math.round(sinceMs / 60000);
  const hit = VOLC.get(key);
  if (hit && Date.now() - hit.at < 45000) return hit.t;
  const out: Trade[] = [];
  let marker: any = undefined;
  for (let pg = 0; pg < 10; pg++) {
    const r: any = await tryReq('account_tx', { account: dp.account, limit: 400, ledger_index_min: -1, ledger_index_max: -1, ...(marker ? { marker } : {}) }, 8000);
    if (!r) break;
    const part = parseTrades(r, dp, m);
    out.push(...part);
    marker = r.marker;
    const oldest = part.length ? Math.min(...part.map(x => x.ms || Infinity)) : Infinity;
    if (!marker || (isFinite(oldest) && oldest < sinceMs)) break;
  }
  VOLC.set(key, { at: Date.now(), t: out });
  return out;
}
/** put the real traded volume (quote units, buys vs sells) into each candle */
export function applyVolume(list: Candle[], trs: Trade[]) {
  if (list.length < 2) return;
  const step = list[1].t - list[0].t;
  for (const c of list) {
    c.vol = 0;
    c.buyVol = 0;
    c.sellVol = 0;
    c.n = 0;
  }
  for (const t of trs) {
    if ((t.kind !== 'buy' && t.kind !== 'sell') || !t.ms) continue;
    let i = Math.floor((t.ms - list[0].t) / step);
    if (i < 0 || i >= list.length) continue;
    const c = list[i];
    c.vol! += t.quote;
    c.n! += 1;
    if (t.kind === 'buy') c.buyVol! += t.quote;
    else c.sellVol! += t.quote;
  }
}

/* ---------- holders ---------- */
export interface HolderRow {
  addr: string;
  bal: number;
  share: number | null;
  tag: string;
}
export async function holders(a: Asset, supply: number | null, poolAccts: Set<string>): Promise<{ count: number; top: HolderRow[]; truncated: boolean }> {
  return cached('holders' + akey(a), 60000, async () => {
    const rows: { addr: string; bal: number }[] = [];
    let truncated = false;
    if (isNative(a)) {
      let marker: any;
      for (let page = 0; page < 30; page++) {
        const r: any = await req('ledger_data', { type: 'account', ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) });
        for (const o of r.state || []) if (o.LedgerEntryType === 'AccountRoot' && Number(o.Balance) > 0) rows.push({ addr: o.Account, bal: Number(o.Balance) / 1e6 });
        marker = r.marker;
        if (!marker) break;
        if (page === 29) truncated = true;
      }
    } else {
      let marker: any;
      for (let page = 0; page < 12; page++) {
        const r: any = await req('account_lines', { account: a.i, limit: 400, ledger_index: 'validated', ...(marker ? { marker } : {}) });
        for (const l of r.lines || []) if (l.currency === a.c && Number(l.balance) < 0) rows.push({ addr: l.account, bal: -Number(l.balance) });
        marker = r.marker;
        if (!marker) break;
        if (page === 11) truncated = true;
      }
    }
    rows.sort((x, y) => y.bal - x.bal);
    const tot = supply ?? rows.reduce((s, x) => s + x.bal, 0);
    return {
      count: rows.length,
      truncated,
      top: rows.slice(0, 25).map(x => ({ addr: x.addr, bal: x.bal, share: tot > 0 ? (x.bal / tot) * 100 : null, tag: poolAccts.has(x.addr) ? 'AMM pool' : '' })),
    };
  });
}

/* ---------- order book and quotes ---------- */
export interface BookLvl {
  price: number; // quote per base
  base: number;
  quote: number;
  owner?: string;
}
export async function book(m: Market, depth = 14): Promise<{ asks: BookLvl[]; bids: BookLvl[] }> {
  const get = async (gets: Asset, pays: Asset) => {
    const r: any = await tryReq('book_offers', { taker_gets: issueOf(gets), taker_pays: issueOf(pays), limit: 60 }, 3000);
    return (r && r.offers) || [];
  };
  const [ao, bo] = await Promise.all([get(m.base, m.quote), get(m.quote, m.base)]);
  const asks: BookLvl[] = [],
    bids: BookLvl[] = [];
  for (const o of ao) {
    const base = amtNum(o.taker_gets_funded || o.TakerGets),
      quote = amtNum(o.taker_pays_funded || o.TakerPays);
    if (base > 0 && quote > 0) asks.push({ price: quote / base, base, quote, owner: o.Account });
  }
  for (const o of bo) {
    const quote = amtNum(o.taker_gets_funded || o.TakerGets),
      base = amtNum(o.taker_pays_funded || o.TakerPays);
    if (base > 0 && quote > 0) bids.push({ price: quote / base, base, quote, owner: o.Account });
  }
  asks.sort((x, y) => x.price - y.price);
  bids.sort((x, y) => y.price - x.price);
  return { asks: asks.slice(0, depth), bids: bids.slice(0, depth) };
}
export interface Quote {
  out: number;
  rate: number; // received per 1 paid
  impact: number; // fraction
  feePct: number;
  src: string;
}
export async function quote(m: Market, side: 'buy' | 'sell', x: number): Promise<Quote | null> {
  if (!(x > 0)) return null;
  const refs = await poolRefs();
  const dp = directPool(refs, m.base, m.quote);
  let best: Quote | null = null;
  if (dp) {
    const s = await poolState(dp);
    if (s) {
      const pay = side === 'buy' ? m.quote : m.base;
      const payIsA = sameAsset(s.a, pay);
      const rin = payIsA ? s.ra : s.rb,
        rout = payIsA ? s.rb : s.ra;
      if (rin > 0 && rout > 0) {
        const f = 1 - s.fee / 100,
          eff = x * f,
          out = (rout * eff) / (rin + eff);
        if (out > 0) best = { out, rate: out / x, impact: Math.max(0, 1 - out / x / (rout / rin)), feePct: s.fee, src: 'AMM pool' };
      }
    }
  }
  const bk = await book(m, 60);
  let left = x,
    out = 0;
  if (side === 'buy') {
    for (const o of bk.asks) {
      const costFull = o.quote;
      if (left >= costFull) {
        out += o.base;
        left -= costFull;
      } else {
        out += o.base * (left / costFull);
        left = 0;
        break;
      }
    }
  } else {
    for (const o of bk.bids) {
      if (left >= o.base) {
        out += o.quote;
        left -= o.base;
      } else {
        out += o.quote * (left / o.base);
        left = 0;
        break;
      }
    }
  }
  if (out > 0 && left <= x * 1e-6 && (!best || out > best.out)) best = { out, rate: out / x, impact: 0, feePct: 0, src: 'Order book' };
  return best;
}

/** price and total pool value at evenly spaced past ledgers (for the growth charts) */
export async function growth(sec: number, points: number): Promise<{ ms: number; seq: number; price: number | null; tvl: number | null; usd: boolean }[]> {
  const ser = await ledgerSeries(sec, points);
  const out: { ms: number; seq: number; price: number | null; tvl: number | null; usd: boolean }[] = [];
  for (const s of ser) {
    const sn = await snapshot(s.seq);
    const tvl = sn.pools.reduce((t, p) => { const pa = sn.px.get(akey(p.a)); const pb = sn.px.get(akey(p.b)); return t + (pa != null ? p.ra * pa : pb != null ? p.rb * pb : 0) * 2; }, 0);
    out.push({ ms: s.ms, seq: s.seq, price: sn.usdPerNative != null ? sn.usdPerNative : null, tvl: sn.pools.length ? (sn.usdPerNative != null ? tvl * sn.usdPerNative : tvl) : null, usd: sn.usdPerNative != null });
  }
  return out;
}
