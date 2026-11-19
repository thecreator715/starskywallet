// Cross-asset send: you pay one asset, the recipient receives another (or you swap to yourself).
// The route finder reads every AMM pool, tries the direct pool and 2-3 hop routes through other assets, and can SPLIT one
// payment across several routes so the price impact is as low as the pools allow. Everything shown is calculated from the
// pools' real reserves; the transaction itself is an ordinary Payment (SendMax, Paths, partial payment with a minimum) that the
// ledger executes atomically: you either get at least the minimum shown, or nothing happens.
import { ctx } from './ctx.ts';
import { esc, hexName, isNative, amtTx, akey, fromKey, NATIVE, type Asset } from './util.ts';
import * as M from './market.ts';

export interface Pool { account: string; a: Asset; b: Asset; ra: number; rb: number; fee: number }   // fee in percent
export interface Hop { pool: string; from: Asset; to: Asset; inAmt: number; outAmt: number; fee: number; mid: number }
export interface RouteResult { hops: Hop[]; inAmt: number; outAmt: number }
export interface Plan {
  ok: boolean; reason: string; inAmt: number; outAmt: number; routes: RouteResult[];
  impact: number; feePct: number; rate: number; mid: number; split: boolean;
}
const same = (x: Asset, y: Asset) => akey(x) === akey(y);
const SLICES = 40, MAXHOPS = 3, MAXPATHS = 40;

/** pools usable for trading */
const live = (ps: Pool[]) => ps.filter(p => p.ra > 0 && p.rb > 0 && isFinite(p.ra) && isFinite(p.rb));

/** every loop-free path of 1..MAXHOPS pools from `from` to `to` */
export function findPaths(pools: Pool[], from: Asset, to: Asset): { pool: Pool; from: Asset; to: Asset }[][] {
  const ps = live(pools), out: { pool: Pool; from: Asset; to: Asset }[][] = [];
  const walk = (at: Asset, seen: Set<string>, acc: { pool: Pool; from: Asset; to: Asset }[]) => {
    if (out.length >= MAXPATHS || acc.length >= MAXHOPS) return;
    for (const p of ps) {
      if (acc.some(h => h.pool === p)) continue;
      const aIs = same(p.a, at), bIs = same(p.b, at); if (!aIs && !bIs) continue;
      const nxt = aIs ? p.b : p.a, step = { pool: p, from: at, to: nxt };
      if (same(nxt, to)) { out.push([...acc, step]); continue; }
      const k = akey(nxt); if (seen.has(k)) continue;
      seen.add(k); walk(nxt, seen, [...acc, step]); seen.delete(k);
    }
  };
  walk(from, new Set([akey(from)]), []);
  out.sort((x, y) => x.length - y.length);
  return out.slice(0, MAXPATHS);
}

const reserves = (p: Pool, from: Asset) => (same(p.a, from) ? { rin: p.ra, rout: p.rb } : { rin: p.rb, rout: p.ra });
/** constant-product output for x in, after the pool fee */
export function swapOut(rin: number, rout: number, feePct: number, x: number): number {
  if (!(x > 0) || !(rin > 0) || !(rout > 0)) return 0;
  const f = 1 - feePct / 100, e = x * f; return (rout * e) / (rin + e);
}
/** input needed to take `y` out (infinity when the pool cannot give that much) */
export function swapIn(rin: number, rout: number, feePct: number, y: number): number {
  if (!(y > 0)) return 0; if (y >= rout) return Infinity;
  const f = 1 - feePct / 100; return (rin * y) / ((rout - y) * f);
}

/** best way to turn exactly `x` of `from` into `to`: greedy slices over every path, reserves updated after each slice */
export function planSend(pools: Pool[], from: Asset, to: Asset, x: number): Plan {
  const none = (reason: string): Plan => ({ ok: false, reason, inAmt: x, outAmt: 0, routes: [], impact: 0, feePct: 0, rate: 0, mid: 0, split: false });
  if (!(x > 0)) return none('Enter an amount.');
  if (same(from, to)) return none('Both assets are the same.');
  const paths = findPaths(pools, from, to); if (!paths.length) return none('No pool route connects these two assets.');
  // work on copies so the caller's pools are untouched
  const copy = new Map<Pool, { ra: number; rb: number }>(); const R = (p: Pool) => { let c = copy.get(p); if (!c) { c = { ra: p.ra, rb: p.rb }; copy.set(p, c); } return c; };
  const hopOut = (h: { pool: Pool; from: Asset }, v: number) => { const c = R(h.pool), isA = same(h.pool.a, h.from); return swapOut(isA ? c.ra : c.rb, isA ? c.rb : c.ra, h.pool.fee, v); };
  const apply = (h: { pool: Pool; from: Asset }, v: number, o: number) => { const c = R(h.pool); if (same(h.pool.a, h.from)) { c.ra += v; c.rb -= o; } else { c.rb += v; c.ra -= o; } };
  const acc = paths.map(p => ({ path: p, inAmt: 0, outAmt: 0, hops: p.map(h => ({ pool: h.pool.account, from: h.from, to: h.to, inAmt: 0, outAmt: 0, fee: h.pool.fee, mid: 0 })) }));
  const step = x / SLICES;
  for (let s = 0; s < SLICES; s++) {
    let best = -1, bestOut = 0;
    for (let i = 0; i < paths.length; i++) { let v = step; for (const h of paths[i]) { v = hopOut(h, v); if (!(v > 0)) break; } if (v > bestOut) { bestOut = v; best = i; } }
    if (best < 0) break;
    let v = step; const a = acc[best]; a.inAmt += step;
    paths[best].forEach((h, k) => { const o = hopOut(h, v); apply(h, v, o); a.hops[k].inAmt += v; a.hops[k].outAmt += o; v = o; });
    a.outAmt += v;
  }
  const used = acc.filter(a => a.inAmt > 0 && a.outAmt > 0); if (!used.length) return none('The pools cannot fill this amount.');
  const outAmt = used.reduce((t, a) => t + a.outAmt, 0), inAmt = used.reduce((t, a) => t + a.inAmt, 0);
  // ideal = what the same input would give at the starting prices with fees but no price movement
  let ideal = 0, feeW = 0;
  for (const a of used) { let spot = 1, keep = 1; for (const h of a.path) { const r = reserves(h.pool, h.from); spot *= r.rout / r.rin; keep *= 1 - h.pool.fee / 100; } ideal += a.inAmt * spot * keep; feeW += a.inAmt * (1 - keep); a.hops.forEach((h, k) => { const r = reserves(a.path[k].pool, a.path[k].from); h.mid = r.rout / r.rin; }); }
  const midAll = used.reduce((t, a) => { let spot = 1; for (const h of a.path) { const r = reserves(h.pool, h.from); spot *= r.rout / r.rin; } return t + a.inAmt * spot; }, 0) / inAmt;
  return { ok: true, reason: '', inAmt, outAmt, routes: used.map(a => ({ hops: a.hops, inAmt: a.inAmt, outAmt: a.outAmt })), impact: Math.max(0, 1 - outAmt / ideal), feePct: (feeW / inAmt) * 100, rate: outAmt / inAmt, mid: midAll, split: used.length > 1 };
}

/** how much `from` must be paid so the recipient gets `y` of `to` */
export function planReceive(pools: Pool[], from: Asset, to: Asset, y: number): Plan {
  if (!(y > 0)) return { ok: false, reason: 'Enter an amount.', inAmt: 0, outAmt: y, routes: [], impact: 0, feePct: 0, rate: 0, mid: 0, split: false };
  let lo = 0, hi = y; let p = planSend(pools, from, to, hi), guard = 0;
  while ((!p.ok || p.outAmt < y) && guard++ < 40) { lo = hi; hi *= 2; p = planSend(pools, from, to, hi); if (!isFinite(hi)) break; }
  if (!p.ok || p.outAmt < y) return { ...p, ok: false, reason: 'The pools do not hold enough ' + 'of the receiving asset for that amount.', outAmt: y };
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2, q = planSend(pools, from, to, mid); if (q.ok && q.outAmt >= y) { hi = mid; p = q; } else lo = mid; if ((hi - lo) / hi < 1e-7) break; }
  return { ...p, outAmt: y, rate: y / p.inAmt };
}

export const floor6 = (n: number) => Math.floor(n * 1e6) / 1e6;
export const minReceived = (out: number, slipPct: number) => Math.max(1e-6, out * (1 - slipPct / 100));
export const maxPaid = (inAmt: number, slipPct: number) => inAmt * (1 + slipPct / 100);

/** the Payment that carries a plan: path steps are the assets between the first and last hop of each multi-hop route */
export function buildPayment(o: { account: string; dest: string; from: Asset; to: Asset; mode: 'send' | 'receive'; plan: Plan; slip: number; tag?: string; memos?: any[] }): any {
  const { plan: pl, slip } = o;
  const pathOf = (r: RouteResult) => r.hops.slice(0, -1).map(h => (isNative(h.to) ? { currency: 'XRP' } : { currency: h.to.c, issuer: h.to.i }));
  const paths = pl.routes.filter(r => r.hops.length > 1).map(pathOf);
  const tx: any = { TransactionType: 'Payment', Account: o.account, Destination: o.dest };
  if (o.mode === 'send') {
    tx.SendMax = amtTx(o.from, floor6(pl.inAmt));
    tx.Amount = amtTx(o.to, floor6(pl.outAmt * (1 + slip / 100)));
    tx.DeliverMin = amtTx(o.to, floor6(minReceived(pl.outAmt, slip)));
    tx.Flags = 0x00020000;   // tfPartialPayment: delivers what the pools give for the payment, never less than DeliverMin
  } else {
    tx.Amount = amtTx(o.to, floor6(pl.outAmt));
    tx.SendMax = amtTx(o.from, Math.ceil(maxPaid(pl.inAmt, slip) * 1e6) / 1e6);
  }
  if (paths.length) tx.Paths = paths;
  if (o.tag) tx.DestinationTag = Number(o.tag);
  if (o.memos) tx.Memos = o.memos;
  return tx;
}

// ---------------------------------------------------------------- the live part (reads pools, draws the estimate, sends)
const XS: any = { assets: [] as Asset[], pools: [] as Pool[], at: 0, plan: null as Plan | null, busy: 0 };
const nm = (a: Asset) => (isNative(a) ? ctx.native() : M.labelOf(a));
const num = (n: number, d = 6) => Number(n).toLocaleString('en', { maximumFractionDigits: n >= 1000 ? 2 : n >= 1 ? 4 : d });
const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;

async function loadPools(force = false): Promise<Pool[]> {
  if (!force && Date.now() - XS.at < 4000 && XS.pools.length) return XS.pools;
  const refs = await M.poolRefs(), st = await Promise.all(refs.map(r => M.poolState(r)));
  XS.pools = st.filter(Boolean).map((s: any) => ({ account: s.account, a: s.a, b: s.b, ra: s.ra, rb: s.rb, fee: s.fee }));
  const seen = new Map<string, Asset>(); seen.set('native', NATIVE); for (const p of XS.pools) { seen.set(akey(p.a), p.a); seen.set(akey(p.b), p.b); }
  XS.assets = [...seen.values()]; XS.at = Date.now(); return XS.pools;
}

export function optionsHtml(sel = ''): string {
  return `<option value="">Same asset (normal payment)</option>` + XS.assets.map((a: Asset) => `<option value="${esc(akey(a))}" ${akey(a) === sel ? 'selected' : ''}>${esc(nm(a))}</option>`).join('');
}

const routeText = (r: RouteResult) => r.hops.map(h => `${esc(nm(h.from))}`).concat(esc(nm(r.hops[r.hops.length - 1].to))).join(' → ');

function draw(pl: Plan | null, from: Asset, to: Asset, mode: string, slip: number, note = '') {
  const el = document.getElementById('s_est'); if (!el) return;
  if (!pl) { el.innerHTML = note ? `<div class="mut" style="font-size:.84rem">${note}</div>` : ''; return; }
  if (!pl.ok) { el.innerHTML = `<div class="warn" style="margin:.4rem 0">${esc(pl.reason)}</div>`; return; }
  const imp = pl.impact * 100, bad = imp > 5, warn = imp > 1;
  const minGet = minReceived(pl.outAmt, slip), maxPay = maxPaid(pl.inAmt, slip);
  el.innerHTML = `<div class="card" style="margin:.5rem 0;padding:.7rem .9rem;border-color:${bad ? '#ff5a5a66' : '#00ff8c44'}">
    <table style="width:100%;font-size:.86rem">
      <tr><td class="mut">You pay</td><td class="r"><b>${num(pl.inAmt)} ${esc(nm(from))}</b>${mode === 'receive' ? ` <small class="mut">(up to ${num(maxPay)})</small>` : ''}</td></tr>
      <tr><td class="mut">Recipient receives</td><td class="r"><b>${num(pl.outAmt)} ${esc(nm(to))}</b>${mode === 'send' ? ` <small class="mut">(at least ${num(minGet)})</small>` : ''}</td></tr>
      <tr><td class="mut">Rate</td><td class="r">1 ${esc(nm(from))} = ${num(pl.rate, 8)} ${esc(nm(to))} <small class="mut">(pool price ${num(pl.mid, 8)})</small></td></tr>
      <tr><td class="mut">Price impact</td><td class="r" style="color:${bad ? '#ff5a5a' : warn ? '#ffb020' : '#00ff8c'}">${imp.toFixed(imp < 0.01 ? 4 : 2)}%</td></tr>
      <tr><td class="mut">Pool fees</td><td class="r">${pl.feePct.toFixed(3)}%</td></tr>
      <tr><td class="mut">${pl.split ? 'Split across routes' : 'Route'}</td><td class="r" style="font-size:.8rem">${pl.routes.map(r => `${pl.split ? Math.round((r.inAmt / pl.inAmt) * 100) + '% · ' : ''}${routeText(r)}`).join('<br>')}</td></tr>
    </table>
    ${bad ? `<div class="warn" style="margin-top:.4rem">Large price impact: the pools are thin for this size. Send less, or in several smaller payments.</div>` : ''}
    <div class="mut" style="font-size:.74rem;margin-top:.4rem">Estimate from the live pool balances${slip ? ` with ${slip}% allowed slippage` : ''}. The ledger fills it all at once or not at all, and never pays you less than the minimum.</div></div>`;
}

/** recompute the estimate from the Send form */
export async function estimate(): Promise<Plan | null> {
  const my = ++XS.busy, fromK = $('s_asset')?.value || '', toK = $('s_recv')?.value || '', mode = $('s_mode')?.value || 'send', slip = Math.max(0, parseFloat($('s_slip')?.value || '1') || 0), amt = parseFloat($('s_amt')?.value || '');
  const box = document.getElementById('s_estbox'); if (box) box.style.display = toK ? '' : 'none';
  XS.plan = null; if (!toK) { draw(null, NATIVE, NATIVE, mode, slip); return null; }
  if (!(amt > 0)) { draw(null, NATIVE, NATIVE, mode, slip, 'Enter an amount to see the estimate.'); return null; }
  try {
    const pools = await loadPools(); if (my !== XS.busy) return null;
    const from = fromKey(fromK), to = fromKey(toK), pl = mode === 'receive' ? planReceive(pools, from, to, amt) : planSend(pools, from, to, amt);
    XS.plan = pl; XS.ctx = { from, to, mode, slip, amt }; draw(pl, from, to, mode, slip); return pl;
  } catch (e: any) { draw(null, NATIVE, NATIVE, mode, slip, 'Could not read the pools: ' + esc(e.message || e)); return null; }
}

export function afterRender() {
  const sel = $('s_recv'); if (!sel) return;
  const hook = () => { void estimate(); };
  ['s_asset', 's_recv', 's_mode', 's_slip', 's_amt'].forEach(id => { const e = $(id); if (e && !(e as any)._xs) { (e as any)._xs = 1; e.addEventListener(id === 's_amt' || id === 's_slip' ? 'input' : 'change', hook); } });
  void loadPools().then(() => { const cur = sel.value; sel.innerHTML = optionsHtml(cur); void estimate(); }).catch(() => {});
}

/** is the receiving address able to hold the asset? */
async function recipientCanHold(dest: string, a: Asset): Promise<string> {
  if (isNative(a)) return '';
  try { const r: any = await ctx.req('account_lines', { account: dest, peer: a.i, limit: 400 }); if ((r.lines || []).some((l: any) => l.currency === a.c)) return ''; return `The recipient has no trust line for ${nm(a)}, so the ledger would refuse this payment. Ask them to add the ${nm(a)} trust line first.`; }
  catch { return ''; }
}

/** Review & Send for a cross-asset payment; returns true when it took over */
export async function reviewCross(): Promise<boolean> {
  const toK = $('s_recv')?.value || ''; if (!toK) return false;
  const fromK = $('s_asset')?.value || '', mode = ($('s_mode')?.value || 'send') as 'send' | 'receive', slip = Math.max(0, parseFloat($('s_slip')?.value || '1') || 0);
  let dest = ($('s_dest')?.value || '').trim(); const me = ctx.account() || '';
  try {
    dest = dest ? ctx.toClassic(dest) : me;   // empty recipient = swap inside your own wallet
    const pl = await estimate(); if (!pl || !pl.ok) { ctx.toast(pl ? pl.reason : 'Enter an amount first', true); return true; }
    const from = fromKey(fromK), to = fromKey(toK), tag = ($('s_tag')?.value || '').trim(), memo = ($('s_memo')?.value || '').trim();
    const bad = await recipientCanHold(dest, to); if (bad) { ctx.toast(bad, true); return true; }
    const tx = buildPayment({ account: me, dest, from, to, mode, plan: pl, slip, tag: tag || undefined });
    const self = dest === me, imp = pl.impact * 100;
    XS.pending = tx;
    ctx.modal(`<h2>${self ? 'Confirm swap' : 'Confirm payment'}</h2>
      <table style="margin:.8rem 0">
        <tr><td class="mut">You pay</td><td class="r"><b>${num(pl.inAmt)} ${esc(nm(from))}</b></td></tr>
        <tr><td class="mut">${self ? 'You receive' : 'Recipient receives'}</td><td class="r"><b>${num(pl.outAmt)} ${esc(nm(to))}</b></td></tr>
        <tr><td class="mut">Guaranteed at least</td><td class="r">${mode === 'send' ? num(minReceived(pl.outAmt, slip)) + ' ' + esc(nm(to)) : num(pl.outAmt) + ' ' + esc(nm(to)) + ' (exact)'}</td></tr>
        ${mode === 'receive' ? `<tr><td class="mut">You pay at most</td><td class="r">${num(maxPaid(pl.inAmt, slip))} ${esc(nm(from))}</td></tr>` : ''}
        <tr><td class="mut">Price impact · fees</td><td class="r">${imp.toFixed(2)}% · ${pl.feePct.toFixed(3)}%</td></tr>
        <tr><td class="mut">${pl.split ? 'Routes (split)' : 'Route'}</td><td class="r" style="font-size:.8rem">${pl.routes.map(r => `${pl.split ? Math.round((r.inAmt / pl.inAmt) * 100) + '% · ' : ''}${routeText(r)}`).join('<br>')}</td></tr>
        ${self ? '' : `<tr><td class="mut">Recipient</td><td class="r mono" style="font-size:.78rem;word-break:break-all">${esc(ctx.show(dest))}</td></tr>`}
      </table>
      ${imp > 5 ? `<div class="warn" style="margin-bottom:.6rem">The price impact is ${imp.toFixed(1)}%. You will get a much worse rate than the pool price.</div>` : ''}
      <div class="row"><button class="grow" onclick="window.closeModal()">Cancel</button><button class="pri acc grow" id="xscf" onclick="window.xsSend()">${self ? 'Swap now' : 'Send now'}</button></div>`);
  } catch (e: any) { ctx.toast(e.message || String(e), true); }
  return true;
}

(window as any).xsSend = async () => {
  const b = document.getElementById('xscf') as HTMLButtonElement | null; if (b) { b.disabled = true; b.textContent = 'Sending…'; }
  const r = await ctx.submit(XS.pending);
  if (r.ok) { ctx.toast('Done: the payment was validated on the ledger.'); ctx.closeModal(); (window as any).goTab('activity'); }
  else { ctx.toast(r.msg || 'The ledger refused the payment', true); if (b) { b.disabled = false; b.textContent = 'Try again'; } }
};

/** HTML for the extra Send controls */
export function controlsHtml(): string {
  return `<div class="row"><select id="s_recv" class="grow" title="What the recipient receives">${optionsHtml()}</select></div>
  <div id="s_estbox" style="display:none">
    <div class="row"><select id="s_mode" class="grow"><option value="send">The amount above is what I send</option><option value="receive">The amount above is what they receive</option></select>
      <input id="s_slip" value="1" inputmode="decimal" style="width:6.5rem" title="Allowed slippage in percent"><small class="mut" style="align-self:center">% slippage</small></div>
    <div id="s_est"></div>
    <div class="mut" style="font-size:.76rem">Leave the recipient empty to swap inside your own wallet.</div>
  </div>`;
}
export { hexName };
