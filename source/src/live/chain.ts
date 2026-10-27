// Live chain access: cached RPC, server info, ledger headers and "ledger at time T" so every percentage is real history.
import { ctx } from './ctx.ts';

const cache = new Map<string, { t: number; v: any }>();
const inflight = new Map<string, Promise<any>>();
export function clearCache(prefix?: string) {
  for (const k of [...cache.keys()]) if (!prefix || k.startsWith(prefix)) cache.delete(k);
}
/** cache by key for ttl ms (Infinity = immutable); identical in-flight calls share one request */
export async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const k = ctx.netKey() + (ctx.xrpl() ? 'X' : '') + '|' + key;
  const hit = cache.get(k);
  if (hit && (ttl === Infinity || Date.now() - hit.t < ttl)) return hit.v as T;
  const fl = inflight.get(k);
  if (fl) return fl as Promise<T>;
  const p = fn()
    .then(v => {
      cache.set(k, { t: Date.now(), v });
      if (cache.size > 4000) for (const kk of [...cache.keys()].slice(0, 1000)) cache.delete(kk);
      return v;
    })
    .finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}
export const req = (command: string, params: any = {}, ttl = 0) =>
  ttl > 0 ? cached(command + JSON.stringify(params), ttl, () => ctx.req(command, params)) : ctx.req(command, params);
/** request that resolves to null instead of throwing (missing account, old ledger, ...) */
export const tryReq = async (command: string, params: any = {}, ttl = 0) => {
  try {
    return await req(command, params, ttl);
  } catch {
    return null;
  }
};
/** run async jobs with limited concurrency, keeping order */
export async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

export interface Info {
  seq: number;
  minSeq: number;
  state: string;
  peers: number;
  load: number;
  version: string;
  uptime: number;
  networkId: number | null;
  quorum: number | null;
  baseFee: number; // in native units
  reserveBase: number;
  reserveInc: number;
  age: number;
  closeSec: number | null; // seconds between the last ledgers, from the node
  validators: number | null;
}
export async function info(): Promise<Info> {
  return cached('info', 3000, async () => {
    const i = (await ctx.req('server_info')).info || {};
    const v = i.validated_ledger || {};
    const seq = v.seq || 0;
    let minSeq = 1;
    const cl = String(i.complete_ledgers || '');
    if (cl && cl !== 'empty') {
      const parts = cl.split(',').map(s => s.trim().split('-').map(Number));
      const last = parts[parts.length - 1];
      if (last && isFinite(last[0])) minSeq = last[0];
    }
    return {
      seq,
      minSeq: Math.max(1, Math.min(minSeq, seq || 1)),
      state: i.server_state || '',
      peers: i.peers ?? 0,
      load: i.load_factor ?? 1,
      version: i.build_version || '',
      uptime: i.uptime || 0,
      networkId: i.network_id ?? null,
      quorum: i.validation_quorum ?? null,
      baseFee: v.base_fee_xrp ?? 0,
      reserveBase: v.reserve_base_xrp ?? 0,
      reserveInc: v.reserve_inc_xrp ?? 0,
      age: v.age ?? 0,
      closeSec: i.last_close ? i.last_close.converge_time_s : null,
      validators: i.validation_quorum ?? null,
    };
  });
}

export interface Header {
  seq: number;
  hash: string;
  close: number; // ms epoch
  total: number; // native coins
  txCount: number;
}
export async function header(seq: number | 'validated'): Promise<Header | null> {
  const key = 'hdr' + seq;
  const ttl = seq === 'validated' ? 3000 : Infinity;
  try {
    return await cached(key, ttl, async () => {
      const l = (await ctx.req('ledger', { ledger_index: seq })).ledger;
      if (!l) throw new Error('none');
      return {
        seq: Number(l.ledger_index || l.seqNum),
        hash: l.ledger_hash || l.hash || '',
        close: ((l.close_time ?? 0) + 946684800) * 1000,
        total: Number(l.total_coins || 0) / 1e6,
        txCount: Array.isArray(l.transactions) ? l.transactions.length : 0,
      };
    });
  } catch {
    return null;
  }
}

/** seconds per ledger, measured from two real headers */
export async function secPerLedger(): Promise<number> {
  return cached('spl', 120000, async () => {
    const i = await info();
    const h1 = await header(i.seq);
    const s0 = Math.max(i.minSeq, i.seq - 300);
    const h0 = await header(s0);
    if (h1 && h0 && h1.seq > h0.seq && h1.close > h0.close) return Math.max(0.5, (h1.close - h0.close) / 1000 / (h1.seq - h0.seq));
    return 4;
  });
}

export interface Window {
  k: string;
  label: string;
  sec: number;
}
export const WINDOWS: Window[] = [
  { k: '5m', label: '5M', sec: 300 },
  { k: '1h', label: '1H', sec: 3600 },
  { k: '24h', label: '24H', sec: 86400 },
  { k: '7d', label: '7D', sec: 7 * 86400 },
  { k: 'all', label: 'ALL', sec: Infinity },
];
export interface At {
  seq: number;
  ageSec: number; // real age of that ledger
  clamped: boolean; // true if the node does not keep history that far back
}
/** the validated ledger closest to `sec` seconds ago (bucketed so snapshots are reused) */
export async function ledgerAgo(sec: number): Promise<At> {
  const i = await info();
  const per = await secPerLedger();
  const nowH = await header(i.seq);
  const nowMs = nowH ? nowH.close : Date.now();
  if (!isFinite(sec)) {
    const h = await header(i.minSeq);
    return { seq: i.minSeq, ageSec: h ? (nowMs - h.close) / 1000 : 0, clamped: false };
  }
  const raw = i.seq - sec / per;
  const bucket = Math.max(1, Math.round(Math.min(sec, 3600) / 10 / per));
  let seq = Math.round(raw / bucket) * bucket;
  let clamped = false;
  if (seq <= i.minSeq) {
    seq = i.minSeq;
    clamped = raw < i.minSeq - 1;
  }
  seq = Math.min(seq, i.seq);
  const h = await header(seq);
  return { seq, ageSec: h ? (nowMs - h.close) / 1000 : sec, clamped };
}
/** ledger sequences evenly spaced over the last `sec` seconds (or since the oldest ledger the node keeps) */
export async function ledgerSeries(sec: number, points: number): Promise<{ seq: number; ms: number }[]> {
  const i = await info();
  const per = await secPerLedger();
  const nowH = await header(i.seq);
  const nowMs = nowH ? nowH.close : Date.now();
  const first = isFinite(sec) ? Math.max(i.minSeq, Math.round(i.seq - sec / per)) : i.minSeq;
  const out: { seq: number; ms: number }[] = [];
  for (let k = 0; k < points; k++) {
    const seq = Math.round(first + ((i.seq - first) * k) / Math.max(1, points - 1));
    out.push({ seq, ms: nowMs - (i.seq - seq) * per * 1000 });
  }
  return out;
}
