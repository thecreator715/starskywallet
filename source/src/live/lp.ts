// Liquidity: pool data, deposit and withdraw with live previews (AMM pools, XLS-30).
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { Asset, akey, amtTx, esc, fmt, isNative, short, usd, pctHtml } from './util.ts';
import { tryReq, info, clearCache } from './chain.ts';

const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;
interface Ctx {
  p: M.PoolRef;
  s: M.PoolState;
  mine: number;
  bal1: number;
  bal2: number;
  px1: number | null; // usd per unit
  px2: number | null;
}
let L: Ctx | null = null;
let mode: 'two' | 'one1' | 'one2' = 'two';
const nm = (a: Asset) => M.labelOf(a);

async function gather(account: string): Promise<Ctx> {
  const refs = await M.poolRefs();
  const p = refs.find(r => r.account === account);
  if (!p) throw new Error('That pool no longer exists.');
  const s = await M.poolState(p);
  if (!s) throw new Error('Could not read the pool.');
  const acc = ctx.account();
  let mine = 0,
    b1 = 0,
    b2 = 0;
  if (acc) {
    const [ai, al]: any[] = await Promise.all([tryReq('account_info', { account: acc, ledger_index: 'validated' }), tryReq('account_lines', { account: acc, ledger_index: 'validated', limit: 400 })]);
    const lines = (al && al.lines) || [];
    const inf = await info();
    const nativeFree = ai && ai.account_data ? Math.max(0, Number(ai.account_data.Balance) / 1e6 - inf.reserveBase - inf.reserveInc * (ai.account_data.OwnerCount || 0)) : 0;
    const bal = (a: Asset) => (isNative(a) ? nativeFree : Number((lines.find((l: any) => l.currency === a.c && l.account === a.i) || {}).balance || 0));
    b1 = bal(p.a);
    b2 = bal(p.b);
    const lpl = lines.find((l: any) => l.currency === p.lpCur && l.account === p.account);
    mine = lpl ? Number(lpl.balance) : 0;
  }
  const snap = await M.snapshot();
  return { p, s, mine, bal1: b1, bal2: b2, px1: M.usdPx(snap, akey(p.a)), px2: M.usdPx(snap, akey(p.b)) };
}
const money = (v: number | null) => (v == null ? '' : ' <small class="mut">≈ ' + usd(v) + '</small>');
function poolCard(c: Ctx): string {
  const { p, s } = c;
  const tvl = c.px1 != null && c.px2 != null ? s.ra * c.px1 + s.rb * c.px2 : null;
  const share = s.lp > 0 ? (c.mine / s.lp) * 100 : 0;
  const my1 = s.lp > 0 ? (c.mine / s.lp) * s.ra : 0,
    my2 = s.lp > 0 ? (c.mine / s.lp) * s.rb : 0;
  const kv = (k: string, v: string) => `<div class="dxkv"><span class="mut">${k}</span><span>${v}</span></div>`;
  return `<div class="lpcard">${kv('Reserves', `${fmt(s.ra)} ${esc(nm(p.a))}${money(c.px1 != null ? s.ra * c.px1 : null)}<br>${fmt(s.rb)} ${esc(nm(p.b))}${money(c.px2 != null ? s.rb * c.px2 : null)}`)}
    ${kv('Pool value', tvl != null ? usd(tvl) : '–')}${kv('Price', `1 ${esc(nm(p.a))} = ${fmt(s.ra > 0 ? s.rb / s.ra : null)} ${esc(nm(p.b))}`)}${kv('Trading fee', p.fee + '%')}${kv('LP tokens in circulation', fmt(s.lp))}
    ${kv('Your LP tokens', fmt(c.mine))}${kv('Your share of the pool', share.toFixed(share > 0 && share < 0.01 ? 4 : 2) + '%')}${kv('Your share is worth', `${fmt(my1)} ${esc(nm(p.a))} + ${fmt(my2)} ${esc(nm(p.b))}`)}</div>`;
}
export async function openDeposit(account: string) {
  ctx.modal('<h2>Deposit liquidity</h2><div class="mut">Reading the pool…</div>');
  try {
    L = await gather(account);
    mode = 'two';
    drawDeposit();
  } catch (e: any) {
    ctx.modal(`<h2>Deposit liquidity</h2><div class="crit">${esc(e.message)}</div><button class="grow" onclick="window.closeModal()">Close</button>`);
  }
}
function drawDeposit() {
  if (!L) return;
  const c = L,
    p = c.p;
  const seg = (k: string, l: string) => `<button class="${mode === k ? 'on' : ''}" onclick="window.lp.mode('${k}')">${l}</button>`;
  ctx.modal(`<h2>Deposit liquidity</h2><p class="mut" style="margin:.2rem 0 .6rem"><b>${esc(nm(p.a))} / ${esc(nm(p.b))}</b> pool</p>${poolCard(c)}
    <div class="seg" style="margin:.8rem 0">${seg('two', 'Both assets (no fee)')}${seg('one1', 'Only ' + esc(nm(p.a)))}${seg('one2', 'Only ' + esc(nm(p.b)))}</div>
    ${mode !== 'one2' ? `<div class="k">${esc(nm(p.a))} <span class="mut" style="float:right;text-transform:none">Balance ${fmt(c.bal1)} <a href="#" onclick="window.lp.max(1);return false">MAX</a></span></div><div class="row"><input id="lp_a1" class="grow" inputmode="decimal" placeholder="0.00" oninput="window.lp.edit(1)"></div>` : ''}
    ${mode !== 'one1' ? `<div class="k" style="margin-top:.5rem">${esc(nm(p.b))} <span class="mut" style="float:right;text-transform:none">Balance ${fmt(c.bal2)} <a href="#" onclick="window.lp.max(2);return false">MAX</a></span></div><div class="row"><input id="lp_a2" class="grow" inputmode="decimal" placeholder="0.00" oninput="window.lp.edit(2)"></div>` : ''}
    <div id="lp_prev" class="lpcard" style="margin-top:.8rem"></div><div id="lp_err" class="crit" style="min-height:1.2rem;font-size:.82rem"></div>
    <div class="row" style="margin-top:.6rem"><button class="grow" onclick="window.closeModal()">Cancel</button><button class="pri acc grow" id="lp_go" onclick="window.lp.deposit(this)">Deposit</button></div>`);
  prevDeposit();
}
function vals() {
  const a1 = parseFloat($('lp_a1')?.value || '') || 0,
    a2 = parseFloat($('lp_a2')?.value || '') || 0;
  return { a1, a2 };
}
function prevDeposit() {
  if (!L) return;
  const { s, p } = L,
    { a1, a2 } = vals();
  const f = p.fee / 100;
  let lpOut = 0;
  if (mode === 'two') lpOut = s.ra > 0 ? s.lp * (a1 / s.ra) : 0;
  else if (mode === 'one1') lpOut = s.lp * (Math.sqrt(1 + (a1 * (1 - f / 2)) / s.ra) - 1);
  else lpOut = s.lp * (Math.sqrt(1 + (a2 * (1 - f / 2)) / s.rb) - 1);
  const after = s.lp + lpOut > 0 ? ((L.mine + lpOut) / (s.lp + lpOut)) * 100 : 0;
  const e = document.getElementById('lp_prev');
  if (e) e.innerHTML = lpOut > 0 ? `<div class="dxkv"><span class="mut">You receive${mode === 'two' ? '' : ' (estimate)'}</span><span>${fmt(lpOut, 8)} LP tokens</span></div><div class="dxkv"><span class="mut">Your share after</span><span>${after.toFixed(after < 0.01 ? 4 : 2)}%</span></div>` : '<div class="mut">Enter an amount to preview.</div>';
}
export function edit(which: 1 | 2) {
  if (!L || mode !== 'two') return prevDeposit();
  const { s } = L;
  const x = $(which === 1 ? 'lp_a1' : 'lp_a2'),
    y = $(which === 1 ? 'lp_a2' : 'lp_a1');
  const v = parseFloat(x?.value || '') || 0;
  if (y) y.value = v > 0 && s.ra > 0 && s.rb > 0 ? String(+((which === 1 ? v * (s.rb / s.ra) : v * (s.ra / s.rb)).toPrecision(10))) : '';
  prevDeposit();
}
export function max(which: 1 | 2) {
  if (!L) return;
  const bal = which === 1 ? L.bal1 : L.bal2;
  const x = $(which === 1 ? 'lp_a1' : 'lp_a2');
  if (x) x.value = String(+(bal * (isNative(which === 1 ? L.p.a : L.p.b) ? 0.98 : 1)).toPrecision(12));
  edit(which);
}
export function setMode(m: 'two' | 'one1' | 'one2') {
  mode = m;
  drawDeposit();
}
export async function deposit(btn: HTMLButtonElement) {
  if (!L) return;
  const err = document.getElementById('lp_err');
  const say = (t: string) => err && (err.textContent = t);
  try {
    const acc = ctx.account();
    if (!acc) throw new Error('Select a wallet first.');
    const { p } = L,
      { a1, a2 } = vals();
    const tx: any = { TransactionType: 'AMMDeposit', Account: acc, Asset: issue(p.a), Asset2: issue(p.b) };
    if (mode === 'two') {
      if (!(a1 > 0 && a2 > 0)) throw new Error('Enter both amounts.');
      if (a1 > L.bal1 + 1e-9 || a2 > L.bal2 + 1e-9) throw new Error('You do not have enough of one of the assets.');
      tx.Amount = amtTx(p.a, a1);
      tx.Amount2 = amtTx(p.b, a2);
      tx.Flags = 0x00100000;
    } else {
      const a = mode === 'one1' ? p.a : p.b,
        v = mode === 'one1' ? a1 : a2;
      if (!(v > 0)) throw new Error('Enter an amount.');
      if (v > (mode === 'one1' ? L.bal1 : L.bal2) + 1e-9) throw new Error('You do not have enough of that asset.');
      tx.Amount = amtTx(a, v);
      tx.Flags = 0x00080000;
    }
    btn.disabled = true;
    say('Submitting…');
    const r = await ctx.submit(tx);
    if (r.ok) {
      ctx.closeModal();
      ctx.toast('✓ Liquidity deposited');
      clearCache();
      ctx.rerender();
    } else say('Rejected: ' + r.msg);
  } catch (e: any) {
    say(String(e?.message || e));
  }
  btn.disabled = false;
}
const issue = (a: Asset) => (isNative(a) ? { currency: 'XRP' } : { currency: a.c, issuer: a.i });

let pct = 50;
export async function openWithdraw(account: string) {
  ctx.modal('<h2>Withdraw liquidity</h2><div class="mut">Reading the pool…</div>');
  try {
    L = await gather(account);
    pct = 50;
    drawWithdraw();
  } catch (e: any) {
    ctx.modal(`<h2>Withdraw liquidity</h2><div class="crit">${esc(e.message)}</div><button class="grow" onclick="window.closeModal()">Close</button>`);
  }
}
function drawWithdraw() {
  if (!L) return;
  const c = L,
    p = c.p;
  ctx.modal(`<h2>Withdraw liquidity</h2><p class="mut" style="margin:.2rem 0 .6rem"><b>${esc(nm(p.a))} / ${esc(nm(p.b))}</b> pool</p>${poolCard(c)}
    ${c.mine > 0 ? `<div class="k" style="margin-top:.8rem">Amount to withdraw: <b id="lp_pct">${pct}%</b></div><input type="range" min="1" max="100" value="${pct}" oninput="window.lp.pct(this.value)" style="width:100%">
    <div class="row" style="gap:.3rem">${[25, 50, 75, 100].map(v => `<button class="sm" onclick="window.lp.pct(${v},true)">${v}%</button>`).join('')}</div>
    <div id="lp_prev" class="lpcard" style="margin-top:.8rem"></div>` : '<div class="mut" style="margin:.8rem 0">You have no LP tokens in this pool.</div>'}
    <div id="lp_err" class="crit" style="min-height:1.2rem;font-size:.82rem"></div>
    <div class="row" style="margin-top:.6rem"><button class="grow" onclick="window.closeModal()">Cancel</button>${c.mine > 0 ? '<button class="pri acc grow" onclick="window.lp.withdraw(this)">Withdraw</button>' : ''}</div>`);
  prevWithdraw();
}
function prevWithdraw() {
  if (!L) return;
  const { s, p } = L;
  const t = (L.mine * pct) / 100;
  const e = document.getElementById('lp_prev');
  const a1 = s.lp > 0 ? (t / s.lp) * s.ra : 0,
    a2 = s.lp > 0 ? (t / s.lp) * s.rb : 0;
  if (e) e.innerHTML = `<div class="dxkv"><span class="mut">LP tokens burned</span><span>${fmt(t, 8)}</span></div><div class="dxkv"><span class="mut">You receive</span><span>${fmt(a1)} ${esc(nm(p.a))}${money(L.px1 != null ? a1 * L.px1 : null)}<br>${fmt(a2)} ${esc(nm(p.b))}${money(L.px2 != null ? a2 * L.px2 : null)}</span></div><div class="dxkv"><span class="mut">Your share after</span><span>${(s.lp - t > 0 ? ((L.mine - t) / (s.lp - t)) * 100 : 0).toFixed(2)}%</span></div>`;
}
export function setPct(v: number | string, redraw = false) {
  pct = Math.max(1, Math.min(100, +v));
  if (redraw) return drawWithdraw();
  const e = document.getElementById('lp_pct');
  if (e) e.textContent = pct + '%';
  prevWithdraw();
}
export async function withdraw(btn: HTMLButtonElement) {
  if (!L) return;
  const err = document.getElementById('lp_err');
  const say = (t: string) => err && (err.textContent = t);
  try {
    const { p } = L;
    const tx: any = { TransactionType: 'AMMWithdraw', Account: ctx.account(), Asset: issue(p.a), Asset2: issue(p.b) };
    if (pct >= 100) tx.Flags = 0x00020000;
    else {
      tx.LPTokenIn = { currency: p.lpCur, issuer: p.account, value: String(+((L.mine * pct) / 100).toPrecision(15)) };
      tx.Flags = 0x00010000;
    }
    btn.disabled = true;
    say('Submitting…');
    const r = await ctx.submit(tx);
    if (r.ok) {
      ctx.closeModal();
      ctx.toast('✓ Liquidity withdrawn');
      clearCache();
      ctx.rerender();
    } else say('Rejected: ' + r.msg);
  } catch (e: any) {
    say(String(e?.message || e));
  }
  btn.disabled = false;
}
export const lpApi: any = { deposit, withdraw, mode: setMode, edit, max, pct: setPct };
export const open = { deposit: openDeposit, withdraw: openWithdraw };
lpApi.openDeposit = openDeposit;
lpApi.openWithdraw = openWithdraw;
