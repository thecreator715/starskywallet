// Lending: lend and borrow LUMA and USD against collateral.
// How it works: you act by sending an ordinary payment from your own wallet to the Lending Vault with a short instruction in its memo.
// The operator's control panel reads the vault, applies the rules once per payment, and pays money back out of the vault.
// It is a custodial pool run by the operator of the panel, not a smart contract: this page says so, shows the vault's address, and shows
// exactly what each action will do before you sign it. Everything on the page (rates, health, liquidation price, latency) comes from the operator's public feed.
import { ctx } from './ctx.ts';
import { esc, fmt, short, amtTx, amtNum, ago } from './util.ts';
import * as PM from './procmodal.ts';

type Asset = 'LUMA' | 'USD';
const A2: Asset[] = ['LUMA', 'USD'];
const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const hexOf = (s: string) => Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const N = (v: any, d = 2) => (v == null || !isFinite(+v) ? '–' : (+v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const USD = (v: any) => (v == null || !isFinite(+v) ? '–' : '$' + (+v).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 }));
const PCT = (v: any, d = 2) => (v == null || !isFinite(+v) ? '–' : (+v * 100).toFixed(d) + '%');
const MS = (v: any) => (v == null ? '–' : v < 1000 ? Math.round(v) + ' ms' : v < 60000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v / 60000) + ' min');
const GREEN = '#3ddc84', RED = '#ff5b5b', AMB = '#f5b84b', BLUE = '#5aa9ff';
const hfCol = (h: number) => (h == null ? '#9aa' : h < 1 ? RED : h < 1.15 ? '#ff8a3d' : h < 1.5 ? AMB : GREEN);
const chip = (t: string, c: string) => `<span style="display:inline-block;padding:.08rem .5rem;border-radius:99px;font-size:.78rem;background:${c}22;color:${c}">${esc(t)}</span>`;
const tile = (k: string, v: string, sub = '', col = '') => `<div class="tile" style="min-width:9.5rem;flex:1"><div class="mut" style="font-size:.8rem">${esc(k)}</div><div style="font-size:1.25rem;font-weight:800;margin:.1rem 0;${col ? 'color:' + col : ''}">${v}</div><div class="mut" style="font-size:.78rem">${sub}</div></div>`;
const bar = (p: number, col = BLUE) => `<div style="height:.45rem;background:rgba(255,255,255,.1);border-radius:9px;overflow:hidden;min-width:5rem"><div style="height:100%;width:${Math.max(0, Math.min(100, p * 100)).toFixed(1)}%;background:${col}"></div></div>`;

// ---------- state ----------
const F = { asset: 'USD' as Asset, amt: '', liqAmt: '' };
type V = 'markets' | 'mine' | 'liq' | 'analytics' | 'data';
let VIEW: V = 'markets';
let OP: { url: string; snap: any; err: string; at: number; rtt: number | null } = { url: '', snap: null, err: '', at: 0, rtt: null };
let ACC: any = null, LIQ: any = null, HIST: any = null, ACT: any[] = [];
let WAL: { LUMA: number; USD: number; usdLine: boolean; at: number } = { LUMA: 0, USD: 0, usdLine: false, at: 0 };
let busy = false, busyAt = 0, timer: any = 0;
const MINE: { n: number; last: number | null; best: number | null; samples: number[] } = { n: 0, last: null, best: null, samples: [] };   // how long my own actions took to be applied
const RTT: number[] = [];
const net = () => (ctx.netKey() === 'test' ? 'test' : 'main');
const OK = 'starsky.lend.op.';

// ---------- operator link ----------
function candidates(): string[] {
  const sc = (window as any).STARSKY_CONFIG || {}, t = net();
  const tun = String((sc[t] || sc.main || {}).url || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '').replace(/\/test$/, '');
  let saved = '', bridge = ''; try { saved = localStorage.getItem(OK + t) || ''; bridge = (JSON.parse(localStorage.getItem('starsky.bridge.' + t) || '{}') || {}).opUrl || ''; } catch { /* storage blocked */ }
  return [...new Set([saved, bridge, tun && /^https:/.test(tun) ? tun + '/panel/' + t : '', location.protocol.startsWith('http') ? location.origin : ''].filter(Boolean).map(u => u.replace(/\/$/, '')))];
}
async function get(path: string): Promise<any> {
  const bases = OP.url ? [OP.url, ...candidates().filter(u => u !== OP.url)] : candidates(); let lastErr = 'No control panel address is set.';
  for (const b of bases) {
    try {
      const t0 = performance.now(); const r = await fetch(b + path, { cache: 'no-store', headers: { 'ngrok-skip-browser-warning': '1' } }); const rtt = performance.now() - t0;
      if (!r.ok) { lastErr = 'The operator answered ' + r.status; continue; }
      const j = JSON.parse(await r.text()); if (!j || j.error) { lastErr = (j && j.error) || 'bad answer'; continue; }
      OP.url = b; OP.rtt = rtt; RTT.push(rtt); if (RTT.length > 40) RTT.shift(); return j;
    } catch (e: any) { lastErr = /JSON|Unexpected/.test(String(e?.message)) ? 'That address answered with a web page, not the lending feed.' : 'Cannot reach ' + b; }
  }
  throw new Error(lastErr);
}

// ---------- reading ----------
async function readWallet(acc: string) {
  try {
    const [ai, al] = await Promise.all([ctx.req('account_info', { account: acc, ledger_index: 'validated' }).catch(() => null), ctx.req('account_lines', { account: acc, ledger_index: 'validated', limit: 400 }).catch(() => null)]);
    const u = OP.snap && OP.snap.usd; let usd = 0, line = false;
    if (u && al) { const l = (al.lines || []).find((x: any) => x.account === u.issuer && x.currency === u.currency); if (l) { usd = Number(l.balance); line = true; } }
    WAL = { LUMA: ai && ai.account_data ? Math.max(0, Number(ai.account_data.Balance) / 1e6) : 0, USD: usd, usdLine: line, at: Date.now() };
  } catch { /* keep the last numbers */ }
}
export async function load(force = false) {
  if (!document.getElementById('ld_root')) return;
  if (busy && Date.now() - busyAt < 25000 && !force) return;
  busy = true; busyAt = Date.now();
  try {
    OP.snap = await get('/api/public/lending'); OP.err = ''; OP.at = Date.now();
    const acc = ctx.account();
    const jobs: Promise<any>[] = [get('/api/public/lending/liquidatable').then(j => (LIQ = j)).catch(() => null), get('/api/public/lending/history?hours=' + (VIEW === 'analytics' ? 168 : 24)).then(j => (HIST = j)).catch(() => null)];
    if (acc) { jobs.push(get('/api/public/lending/account?addr=' + encodeURIComponent(acc)).then(j => { ACC = j; ACT = j.activity || []; }).catch(() => null)); jobs.push(readWallet(acc)); }
    await Promise.all(jobs);
  } catch (e: any) { OP.err = String(e?.message || e); }
  finally { busy = false; paint(); }
}

// ---------- maths for the previews (the same rules the operator applies) ----------
const P = () => (OP.snap && OP.snap.params) || { ltvMax: .6, liqThreshold: .75, liqBonus: .08, closeFactor: .5, minBorrowUsd: 5, minSupplyUsd: 1, minCollateralUsd: 1 };
const px = (a: Asset) => (a === 'USD' ? 1 : (OP.snap && OP.snap.price && OP.snap.price.LUMA) || 0);
const pos = () => (ACC && ACC.position) || null;
const per = (a: Asset) => { const p = pos(); return (p && p.per.find((x: any) => x.asset === a)) || { supplied: 0, collateral: 0, debt: 0 }; };
const mkt = (a: Asset) => OP.snap && OP.snap.stats && OP.snap.stats.markets && OP.snap.stats.markets[a];
function hfAfter(dCol: number, dDebt: number, a: Asset): number | null {   // health factor if collateral/debt of asset a change by these amounts (USD-valued)
  const p = pos(); const colUsd = (p ? p.collateralUsd : 0) + dCol * px(a), debtUsd = (p ? p.debtUsd : 0) + dDebt * px(a);
  return debtUsd > 0 ? (colUsd * P().liqThreshold) / debtUsd : null;
}
const hfTxt = (h: number | null) => (h == null ? chip('no debt', '#9aa') : chip(N(h, 2), hfCol(h)));

// ---------- doing things ----------
const KIND: Record<string, { title: string; verb: string; money: 'in' | 'out'; blurb: string }> = {
  supply: { title: 'Supply', verb: 'Supply', money: 'in', blurb: 'You lend this to borrowers and earn interest. You can withdraw whatever is not currently lent out.' },
  withdraw: { title: 'Withdraw', verb: 'Withdraw', money: 'out', blurb: 'You take back supplied funds plus the interest earned.' },
  collateral: { title: 'Lock collateral', verb: 'Lock collateral', money: 'in', blurb: 'Collateral backs your loans. It earns no interest and can be liquidated if your loan gets unhealthy.' },
  withdrawcol: { title: 'Take back collateral', verb: 'Take back collateral', money: 'out', blurb: 'Unlocks collateral you do not need. Not allowed if it would push your loan past the borrow limit.' },
  borrow: { title: 'Borrow', verb: 'Borrow', money: 'out', blurb: 'You receive the money now and owe it back with interest. Your collateral is at risk if your health factor falls under 1.' },
  repay: { title: 'Repay', verb: 'Repay', money: 'in', blurb: 'Pays down your debt. If you send more than you owe, the extra is returned.' },
  claim: { title: 'Claim hold rewards', verb: 'Claim', money: 'out', blurb: 'Your hold interest, paid out of the rewards pool. What you do not claim keeps accruing.' },
};
function ready(): string {
  const s = OP.snap; if (!s) return 'Not connected to the lending operator yet.'; if (!s.set) return 'The operator has not set up lending yet.'; if (s.mode !== 'on') return 'Lending is switched off by the operator right now.';
  if (!ctx.account()) return 'Unlock a wallet first.'; return '';
}
function problems(kind: string, asset: Asset, amt: number): { err?: string; warns: string[]; rows: { k: string; v: string; cls?: string }[] } {
  const k = KIND[kind], p = P(), s = OP.snap, warns: string[] = [], rows: { k: string; v: string; cls?: string }[] = []; const nm = asset === 'LUMA' ? ctx.native() : 'USD';
  if (!(amt > 0)) return { err: 'Enter an amount.', warns, rows };
  const usdv = amt * px(asset);
  if (!px('LUMA')) return { err: 'No LUMA price is available, so risk checks cannot run.', warns, rows };
  if (s.halted && ['borrow', 'withdrawcol'].includes(kind)) return { err: 'Borrowing and collateral withdrawals are paused while the operator checks the price.', warns, rows };
  if (s.price.stale && ['borrow', 'withdrawcol'].includes(kind)) return { err: 'The LUMA price is out of date, so this is blocked until it refreshes.', warns, rows };
  if (kind === 'supply' && usdv < p.minSupplyUsd) return { err: `The smallest deposit is ${USD(p.minSupplyUsd)}.`, warns, rows };
  if (kind === 'collateral' && usdv < p.minCollateralUsd) return { err: `The smallest collateral is ${USD(p.minCollateralUsd)}.`, warns, rows };
  if (kind === 'borrow' && usdv < p.minBorrowUsd) return { err: `The smallest loan is ${USD(p.minBorrowUsd)}.`, warns, rows };
  if (k.money === 'in') {
    const have = asset === 'LUMA' ? Math.max(0, WAL.LUMA - 1.5) : WAL.USD;   // keep a little LUMA for the account reserve and fees
    if (amt > have + 1e-9) return { err: `You only have ${N(have, 6)} ${nm} free in this wallet${asset === 'LUMA' ? ' (a small amount stays for fees and the account reserve)' : ''}.`, warns, rows };
    if (asset === 'USD' && !WAL.usdLine) return { err: 'This wallet has no USD trust line, so it holds no USD.', warns, rows };
    if (kind === 'repay') { const owed = per(asset).debt; if (owed <= 0) return { err: `You have no ${nm} debt.`, warns, rows }; if (amt > owed * 1.0001) warns.push(`You owe ${N(owed, 6)} ${nm}. The extra ${N(amt - owed, 6)} will be returned.`); }
    if (kind === 'collateral' && per(asset === 'LUMA' ? 'USD' : 'LUMA').collateral <= 0 && per(asset).debt > 0) warns.push('You have debt in this asset. Locking the same asset does not let you borrow it.');
  } else {
    const m = mkt(asset);
    if (WAL.LUMA < 0.05) return { err: `You need a little ${ctx.native()} in this wallet to send the request (a fee of about 0.00001).`, warns, rows };
    if (kind === 'withdraw') { const have = per(asset).supplied; if (amt > have + 1e-9) return { err: `You have ${N(have, 6)} ${nm} supplied.`, warns, rows }; if (m && amt > m.cash + 1e-9) return { err: `Only ${N(m.cash, 6)} ${nm} is free to withdraw right now. The rest is lent out.`, warns, rows }; }
    if (kind === 'withdrawcol') {
      const have = per(asset).collateral; if (amt > have + 1e-9) return { err: `You have ${N(have, 6)} ${nm} locked.`, warns, rows };
      const h = hfAfter(-amt, 0, asset), pp = pos(); if (pp && pp.debtUsd > 0 && (pp.collateralUsd - usdv) * p.ltvMax < pp.debtUsd - 1e-9) return { err: `That would leave your loan above the ${PCT(p.ltvMax, 0)} borrow limit.`, warns, rows };
      if (h != null && h < 1.25) warns.push('Your health factor would be low. A small price move could get you liquidated.');
    }
    if (kind === 'borrow') {
      const pp = pos(); if (!pp || pp.collateralUsd <= 0) return { err: 'Lock collateral first. You borrow against it.', warns, rows };
      const other = A2.filter(x => x !== asset)[0]; if (per(asset).collateral > 0 && per(other).collateral <= 0) return { err: `You cannot borrow ${nm} against ${nm}. Lock the other asset as collateral.`, warns, rows };
      if (m && amt > m.cash + 1e-9) return { err: `Only ${N(m.cash, 6)} ${nm} is available to borrow right now.`, warns, rows };
      const room = Math.max(0, pp.maxBorrowUsd - pp.debtUsd); if (usdv > room + 1e-9) return { err: `That is over your borrow limit. You can borrow at most ${USD(room)} more (${PCT(p.ltvMax, 0)} of your collateral).`, warns, rows };
      const h = hfAfter(0, amt, asset); if (h != null && h < 1.25) warns.push(`Health factor ${N(h, 2)} is close to the liquidation line (1.00). A ${PCT(1 - 1 / h, 0)} price move against you would liquidate the loan.`);
    }
    if (asset === 'USD' && !WAL.usdLine) warns.push('This wallet has no USD trust line. You will be asked to add one first.');
  }
  // before/after rows
  const pp = pos(), dC = kind === 'collateral' ? amt : kind === 'withdrawcol' ? -amt : 0, dD = kind === 'borrow' ? amt : kind === 'repay' ? -Math.min(amt, per(asset).debt) : 0;
  if (['collateral', 'withdrawcol', 'borrow', 'repay'].includes(kind)) { const before = pp && pp.debtUsd > 0 ? pp.healthFactor : null, after = hfAfter(dC, dD, asset); rows.push({ k: 'Health factor now', v: hfTxt(before) }, { k: 'Health factor after', v: hfTxt(after) }); }
  if (kind === 'supply' && mkt(asset)) rows.push({ k: 'You will earn', v: `${PCT(mkt(asset).supplyApy)} a year (changes with demand)` });
  if (kind === 'borrow' && mkt(asset)) rows.push({ k: 'You will pay', v: `${PCT(mkt(asset).borrowApy)} a year (changes with demand)`, cls: 'warn' });
  return { warns, rows };
}
function trackApplied(hash: string, t0: number, finish: (ms: number | null) => void) {
  let n = 0; const iv = setInterval(async () => {
    n++; try { const acc = ctx.account(); if (!acc) throw 0; const j = await get('/api/public/lending/account?addr=' + encodeURIComponent(acc)); ACC = j; ACT = j.activity || [];
      if (ACT.some(e => e.hash === hash)) { clearInterval(iv); const ms = Date.now() - t0; MINE.n++; MINE.last = ms; MINE.best = MINE.best == null ? ms : Math.min(MINE.best, ms); MINE.samples.push(ms); if (MINE.samples.length > 30) MINE.samples.shift(); finish(ms); paint(); return; } } catch { /* retry */ }
    if (n > 30) { clearInterval(iv); finish(null); }
  }, 2500);
}
async function ensureUsdLine(acc: string): Promise<boolean> {
  const u = OP.snap.usd; if (WAL.usdLine || !u) return true;
  const r = await ctx.submit({ TransactionType: 'TrustSet', Account: acc, LimitAmount: { currency: u.currency, issuer: u.issuer, value: '1000000000' } });
  if (!r.ok) { ctx.toast(r.msg || 'Could not add the USD trust line', true); return false; } WAL.usdLine = true; return true;
}
async function send(kind: string, asset: Asset, amt: number, extra: any = {}): Promise<{ ok: boolean; hash?: string; msg?: string }> {
  const acc = ctx.account()!, s = OP.snap, k = KIND[kind] || { money: 'in' };
  const memo = JSON.stringify(k.money === 'in' || kind === 'liquidate' ? { a: kind, asset, ...extra } : { a: kind, asset, amount: amt });
  let Amount: any;
  if (k.money === 'in' || kind === 'liquidate') Amount = asset === 'LUMA' ? String(Math.round(amt * 1e6)) : amtTx({ c: s.usd.currency, i: s.usd.issuer }, amt);
  else Amount = '1';   // a request: one drop of LUMA carries the instruction, the amount is in the memo
  return ctx.submit({ TransactionType: 'Payment', Account: acc, Destination: s.vaultClassic, Amount, Memos: [{ Memo: { MemoType: hexOf(s.memoType || 'luma-lend'), MemoData: hexOf(memo) } }] });
}
export async function act(kind: string) {
  const bad = ready(); if (bad) return ctx.toast(bad, true);
  const asset = F.asset, amt = Number(F.amt), k = KIND[kind], nm = asset === 'LUMA' ? ctx.native() : 'USD', acc = ctx.account()!;
  await readWallet(acc);
  const pr = problems(kind, asset, amt); if (pr.err) return ctx.toast(pr.err, true);
  const ok = await PM.review({ title: k.title, tone: kind === 'borrow' ? 'lev' : kind === 'withdraw' || kind === 'withdrawcol' ? 'sell' : 'buy', hero: `<div style="font-size:1.4rem;font-weight:800">${fmt(amt, 6)} ${esc(nm)}</div><div class="mut">${esc(k.blurb)}</div>`, rows: [{ k: 'Goes to', v: `<span class="mono">${esc(short(OP.snap.vault || '', 8, 6))}</span>` }, { k: 'Who holds it', v: 'The lending vault, run by the operator of this network' }, ...pr.rows, { k: 'Network fee', v: '~0.00001 ' + esc(ctx.native()) }], warns: pr.warns, confirm: k.verb });
  if (!ok) return;
  const steps = (asset === 'USD' && k.money === 'out' && !WAL.usdLine ? ['Add the USD trust line'] : []).concat(['Send your request', 'The lending service applies it', k.money === 'out' ? 'Funds arrive in your wallet' : 'Position updated']);
  const pg = PM.progress(k.title, steps, kind === 'borrow' ? 'lev' : 'buy'); let i = 0;
  try {
    if (steps[0] === 'Add the USD trust line') { pg.set(i, 'run'); if (!(await ensureUsdLine(acc))) return pg.fail('The USD trust line could not be added.'); pg.set(i++, 'ok'); }
    pg.set(i, 'run'); const t0 = Date.now(); const r = await send(kind, asset, amt); if (!r.ok || !r.hash) return pg.fail(r.msg || 'The network refused the request.'); pg.set(i++, 'ok'); pg.set(i, 'run');
    trackApplied(r.hash, t0, ms => {
      if (ms == null) return pg.fail('The request is on the ledger but the lending service has not applied it yet. Check Activity below in a minute. If the service is off, it will be applied when it is switched on.');
      pg.set(i++, 'ok'); pg.set(i, 'run', k.money === 'out' ? 'Waiting for the payout to arrive' : ''); const w0 = Date.now();
      const poll = setInterval(async () => { await load(true); const p = (ACC && ACC.payouts) || []; const done = k.money === 'in' || p.some((x: any) => x.status === 'sent' && Date.now() - x.at < 180000); if (done || Date.now() - w0 > 60000) { clearInterval(poll); const rej = ACT.find(e => e.hash === r.hash && e.type === 'reject'); if (rej) pg.fail(rej.msg.replace(/^[^:]*: /, '') + (k.money === 'in' ? ' Your payment is being returned.' : '')); else pg.done(`${esc(k.verb)} done in ${MS(ms)}.`); F.amt = ''; paint(); } }, 2500);
    });
  } catch (e: any) { pg.fail(String(e?.message || e)); }
}
export async function claim(a: string) {
  const bad = ready(); if (bad) return ctx.toast(bad, true); const acc = ctx.account()!, p: any = pos(), e = p && p.earnings && p.earnings.per.find((x: any) => x.asset === a); if (!e || !(e.accrued >= 0.000001)) return ctx.toast('Nothing to claim yet.', true);
  if (e.poolLeft < e.accrued) return ctx.toast(`The rewards pool holds ${N(e.poolLeft, 4)} ${a === 'LUMA' ? ctx.native() : a}, less than your ${N(e.accrued, 4)}. Your earnings keep growing and can be claimed after the operator tops it up.`, true);
  await readWallet(acc); const nmA = a === 'LUMA' ? ctx.native() : 'USD';
  const ok = await PM.review({ title: 'Claim hold rewards', tone: 'buy', hero: `<div style="font-size:1.4rem;font-weight:800">≈ ${N(e.accrued, 6)} ${esc(nmA)}</div><div class="mut">${esc(KIND.claim.blurb)}</div>`, rows: [{ k: 'Asset', v: esc(nmA) }, { k: 'Paid from', v: 'The lending rewards pool' }, { k: 'Network fee', v: '~0.00001 ' + esc(ctx.native()) + ' (plus 1 drop to carry the request)' }], confirm: 'Claim' });
  if (!ok) return; const asset = a as any as Asset;
  if (a === 'USD' && !(await ensureUsdLine(acc))) return; const r = await send('claim', asset, 0); if (!r.ok) return ctx.toast(r.msg || 'The network refused the request', true);
  ctx.toast('Claim sent. It arrives in a few seconds.'); setTimeout(() => void load(true), 6000); setTimeout(() => void load(true), 15000);
}
export async function liquidate(target: string, debtAsset: Asset, col: Asset) {
  const bad = ready(); if (bad) return ctx.toast(bad, true); const acc = ctx.account()!; await readWallet(acc);
  const v = (LIQ && LIQ.list.find((x: any) => x.classic === target)); if (!v) return ctx.toast('That position is no longer liquidatable.', true);
  const d = v.per.find((x: any) => x.asset === debtAsset), c = v.per.find((x: any) => x.asset === col); if (!d || d.debt <= 0 || !c || c.collateral <= 0) return ctx.toast('Pick a debt and a collateral the borrower actually has.', true);
  const have = debtAsset === 'LUMA' ? Math.max(0, WAL.LUMA - 1.5) : WAL.USD; const amt = Math.min(d.debt * P().closeFactor, have); if (amt * px(debtAsset) < 1) return ctx.toast(`You need ${debtAsset === 'LUMA' ? ctx.native() : 'USD'} in this wallet to repay part of their debt.`, true);
  const reward = (amt * px(debtAsset) * (1 + P().liqBonus)) / px(col);
  const ok = await PM.review({ title: 'Liquidate a loan', tone: 'lev', hero: `<div style="font-size:1.2rem;font-weight:800">Repay ${fmt(amt, 6)} ${debtAsset === 'LUMA' ? esc(ctx.native()) : 'USD'}</div><div class="mut">for about ${fmt(reward, 6)} ${col === 'LUMA' ? esc(ctx.native()) : 'USD'} of their collateral</div>`, rows: [{ k: 'Borrower', v: `<span class="mono">${esc(short(v.addr, 8, 6))}</span>` }, { k: 'Their health factor', v: hfTxt(v.healthFactor) }, { k: 'Your bonus', v: `${PCT(P().liqBonus, 0)} on top of what you repay`, cls: 'ok' }, { k: 'Most you can repay', v: `${PCT(P().closeFactor, 0)} of that debt per step` }], warns: ['If the price recovers before your request is applied, it is refused and your payment is returned.'], confirm: 'Liquidate' });
  if (!ok) return; const pg = PM.progress('Liquidate', ['Send repayment', 'The lending service applies it', 'Collateral reaches your wallet'], 'lev');
  pg.set(0, 'run'); const r = await send('liquidate', debtAsset, amt, { target, col }); if (!r.ok || !r.hash) return pg.fail(r.msg || 'The network refused it.'); pg.set(0, 'ok'); pg.set(1, 'run'); const t0 = Date.now();
  trackApplied(r.hash, t0, ms => { if (ms == null) return pg.fail('Not applied yet. Check Activity in a minute.'); const rej = ACT.find(e => e.hash === r.hash && e.type === 'reject'); if (rej) return pg.fail(rej.msg.replace(/^[^:]*: /, '') + ' Your payment is being returned.'); pg.done(`Liquidation applied in ${MS(ms)}. Your reward is on its way.`); void load(true); });
}
export const set = (k: 'asset' | 'amt' | 'liqAmt', v: string) => { (F as any)[k] = v; if (k === 'asset') paint(); else preview(); };
export function view(v: V) { VIEW = v; paint(); if (v === 'analytics') void load(true); }
export function setOp() { const cur = OP.url || candidates()[0] || ''; const u = prompt('Control panel address (for example http://127.0.0.1:8090)', cur); if (u == null) return; try { localStorage.setItem(OK + net(), u.trim().replace(/\/$/, '')); } catch { /* ignore */ } OP.url = u.trim().replace(/\/$/, ''); void load(true); }
function max(kind: string) {
  const a = F.asset; let v = 0;
  if (kind === 'supply' || kind === 'collateral') v = a === 'LUMA' ? Math.max(0, WAL.LUMA - 1.5) : WAL.USD; else if (kind === 'repay') v = Math.min(per(a).debt, a === 'LUMA' ? Math.max(0, WAL.LUMA - 1.5) : WAL.USD); else if (kind === 'withdraw') v = Math.min(per(a).supplied, (mkt(a) || { cash: 0 }).cash); else if (kind === 'withdrawcol') { const p = pos(); const free = p ? Math.max(0, (p.collateralUsd - (p.debtUsd > 0 ? p.debtUsd / P().ltvMax : 0)) / px(a)) : 0; v = Math.min(per(a).collateral, free * 0.999); } else if (kind === 'borrow') { const p = pos(); const room = p ? Math.max(0, p.maxBorrowUsd - p.debtUsd) / px(a) : 0; v = Math.min(room * 0.98, (mkt(a) || { cash: 0 }).cash); }
  F.amt = String(Math.floor(v * 1e6) / 1e6); const e = $('ld_amt'); if (e) e.value = F.amt; preview();
}

// ---------- drawing ----------
function line(series: { name: string; color: string; data: [number, number | null][] }[], fmtY: (v: number) => string, zero = false): string {
  const W = 560, H = 140, pad = 34; const all = series.flatMap(s => s.data.map(p => p[1]).filter((v): v is number => v != null && isFinite(v)));
  if (all.length < 2) return '<div class="mut" style="padding:.5rem 0">Collecting data. The operator adds a point every few minutes.</div>';
  let lo = Math.min(...all), hi = Math.max(...all); if (zero) lo = Math.min(0, lo); if (hi === lo) { hi += 1; lo -= 1; } const ts = series.flatMap(s => s.data.map(p => p[0])), t0 = Math.min(...ts), t1 = Math.max(...ts);
  const x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad - 6), y = (v: number) => H - 16 - ((v - lo) / (hi - lo)) * (H - 30);
  const paths = series.map(s => { const d = s.data.filter(p => p[1] != null && isFinite(p[1] as number)); return d.length ? `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" points="${d.map(p => x(p[0]).toFixed(1) + ',' + y(p[1] as number).toFixed(1)).join(' ')}"/>` : ''; }).join('');
  const tm = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px"><text x="2" y="12" font-size="10" fill="currentColor" opacity=".6">${fmtY(hi)}</text><text x="2" y="${H - 18}" font-size="10" fill="currentColor" opacity=".6">${fmtY(lo)}</text><line x1="${pad}" x2="${W}" y1="${H - 16}" y2="${H - 16}" stroke="currentColor" opacity=".2"/>${paths}<text x="${pad}" y="${H - 3}" font-size="10" fill="currentColor" opacity=".6">${tm(t0)}</text><text x="${W - 6}" y="${H - 3}" font-size="10" text-anchor="end" fill="currentColor" opacity=".6">${tm(t1)}</text></svg>${series.length > 1 ? `<div class="mut" style="font-size:.78rem">${series.map(s => `<span style="color:${s.color}">●</span> ${esc(s.name)}`).join(' &nbsp; ')}</div>` : ''}`;
}
const nm = (a: string) => (a === 'LUMA' ? ctx.native() : a);
function bannerHtml(): string {
  const s = OP.snap, out: string[] = [];
  if (!s && OP.err) return `<div class="card c12" style="border:1px solid ${AMB}"><b>Cannot reach the lending operator.</b><div class="mut" style="margin-top:.3rem">${esc(OP.err)}</div><button class="sm" style="margin-top:.5rem" onclick="window.ld.setOp()">Set the control panel address</button></div>`;
  if (!s) return '<div class="card c12 mut">Connecting to the lending operator…</div>';
  if (!s.set) out.push('<b>Lending is not set up yet.</b> The operator needs to create the vault in the control panel.'); else if (s.mode !== 'on') out.push('<b>Lending is switched off.</b> Requests you send now wait until the operator switches it on.');
  if (s.halted) out.push('<b>Paused.</b> ' + esc(s.halted));
  if (s.price && (s.price.stale || s.price.LUMA == null)) out.push('<b>The LUMA price is out of date.</b> Borrowing, taking back collateral and liquidations are blocked until it refreshes.');
  if (s.health && s.mode === 'on' && !s.health.running) out.push('<b>The lending service has not run lately.</b> Requests may take longer to apply.');
  return out.length ? `<div class="card c12" style="border:1px solid ${AMB}">${out.map(o => `<div style="margin:.15rem 0">${o}</div>`).join('')}</div>` : '';
}
function marketsHtml(): string {
  const s = OP.snap; if (!s || !s.stats) return ''; const st = s.stats, p = s.params;
  const tot = st.markets.LUMA.suppliedUsd + st.markets.USD.suppliedUsd;
  const kp = `<div class="row" style="gap:.6rem;flex-wrap:wrap;width:100%">${tile('Supplied', USD(tot), 'across both markets')}${tile('Borrowed', USD(st.borrowedUsd), 'use of the pool ' + PCT(tot > 0 ? st.borrowedUsd / tot : 0, 1))}${tile('Collateral locked', USD(st.collateralUsd), '')}${tile('LUMA price', s.price.LUMA != null ? '$' + N(s.price.LUMA, 4) : '–', 'updated ' + (s.price.ageMs != null ? MS(s.price.ageMs) + ' ago' : 'never'), s.price.stale ? RED : '')}${tile('Borrowers', N(s.users, 0), 'positions open')}</div>`;
  const rows = A2.map(a => { const m = st.markets[a]; return `<tr><td><b>${esc(nm(a))}</b></td><td>${N(m.supplied, 2)}<div class="mut" style="font-size:.76rem">${USD(m.suppliedUsd)}</div></td><td>${N(m.borrowed, 2)}<div class="mut" style="font-size:.76rem">${USD(m.borrowedUsd)}</div></td><td style="min-width:7rem">${PCT(m.utilisation, 1)}${bar(m.utilisation, m.utilisation > p.rate.kink ? RED : BLUE)}</td><td style="color:${GREEN}">${PCT(m.supplyApy)}</td><td style="color:${AMB}">${PCT(m.borrowApy)}</td><td>${N(m.cash, 2)}</td></tr>`; }).join('');
  return `<div class="card c12">${kp}</div><div class="card c12"><div class="k">Markets</div><div style="overflow:auto"><table style="width:100%;font-size:.88rem"><tr class="mut" style="text-align:left"><th>Asset</th><th>Supplied</th><th>Borrowed</th><th>In use</th><th>Supply APY</th><th>Borrow APY</th><th>Free to take</th></tr>${rows}</table></div>
  <div class="mut" style="font-size:.84rem;line-height:1.5;margin-top:.6rem">Borrow up to <b>${PCT(p.ltvMax, 0)}</b> of your collateral's value. A loan is liquidated when the debt passes <b>${PCT(p.liqThreshold, 0)}</b> of the collateral. A liquidator repays up to ${PCT(p.closeFactor, 0)} of it and earns a <b>${PCT(p.liqBonus, 0)}</b> bonus. Rates rise as more of the pool is borrowed, and rise steeply above ${PCT(p.rate.kink, 0)} use so the pool refills. Per market caps: supply ${USD(p.supplyCapUsd)}, borrow ${USD(p.borrowCapUsd)}.</div>
  <div class="mut" style="font-size:.84rem;line-height:1.5;margin-top:.5rem;border-top:1px solid rgba(255,255,255,.1);padding-top:.5rem"><b>Who holds the money:</b> the vault <span class="mono">${esc(short(s.vault || '', 8, 6))}</span> is a wallet controlled by the operator of this network. It is a pool, not a smart contract: if the operator fails or acts badly, funds can be lost. Start with small amounts.</div></div>`;
}
function actionsHtml(): string {
  const bad = ready(); const p = pos();
  const w = ctx.account() ? `<div class="mut" style="font-size:.84rem">In this wallet: <b>${N(WAL.LUMA, 4)} ${esc(ctx.native())}</b> · <b>${WAL.usdLine ? N(WAL.USD, 4) + ' USD' : 'no USD trust line'}</b></div>` : '';
  const row = (a: Asset) => { const e = per(a); const m = mkt(a); return `<tr><td><b>${esc(nm(a))}</b></td><td>${N(e.supplied, 4)}</td><td>${N(e.collateral, 4)}</td><td style="color:${e.debt > 0 ? AMB : 'inherit'}">${N(e.debt, 4)}</td><td>${m ? PCT(m.supplyApy) : '–'} / ${m ? PCT(m.borrowApy) : '–'}</td></tr>`; };
  const summary = p ? `<div class="row" style="gap:.6rem;flex-wrap:wrap;width:100%;margin-top:.6rem">${tile('Health factor', p.debtUsd > 0 ? hfTxt(p.healthFactor) : '–', p.debtUsd > 0 ? 'under 1.00 means liquidation' : 'no loan open')}${tile('Collateral', USD(p.collateralUsd), 'borrow up to ' + USD(p.maxBorrowUsd))}${tile('Debt', USD(p.debtUsd), p.debtUsd > 0 ? 'loan to value ' + PCT(p.ltv, 1) : '')}${tile('Can still borrow', USD(Math.max(0, p.maxBorrowUsd - p.debtUsd)), '')}${tile('Liquidation price', p.liquidation && p.debtUsd > 0 ? `${esc(ctx.native())} ${p.liquidation.when === 'below' ? 'under' : 'over'} $${N(p.liquidation.price, 4)}` : '–', p.debtUsd > 0 && px('LUMA') ? 'now $' + N(px('LUMA'), 4) : '')}</div>` : '<div class="mut" style="margin-top:.5rem">No position yet. Supply to earn interest, or lock collateral to borrow.</div>';
  const E = p && (p as any).earnings, ER = (OP.snap as any).rewards;
  const earn = E ? `<div class="card c12" style="margin-top:.6rem"><div class="row" style="align-items:center;gap:.6rem;flex-wrap:wrap"><div class="k">Hold earnings</div>${chip(PCT(E.apr, 1) + ' a year on what you keep supplied', GREEN)}<span class="grow"></span><span class="mut" style="font-size:.8rem">${ER ? 'Rewards pool: ' + E.per.map((x: any) => N(x.poolLeft, 2) + ' ' + esc(x.asset === 'LUMA' ? ctx.native() : 'USD')).join(' · ') : ''}</span></div>
  <div class="row" style="gap:.6rem;flex-wrap:wrap;width:100%;margin-top:.5rem">${tile('Ready to claim', USD(E.accruedUsd), E.per.map((x: any) => N(x.accrued, 6) + ' ' + esc(x.asset === 'LUMA' ? ctx.native() : 'USD')).join(' · '))}${tile('Claimed so far', USD(E.claimedUsd), E.per.map((x: any) => N(x.claimed, 6) + ' ' + esc(x.asset === 'LUMA' ? ctx.native() : 'USD')).join(' · '))}${tile('Total earned', USD(E.accruedUsd + E.claimedUsd), 'claimed plus waiting')}</div>
  <div class="row" style="gap:.4rem;margin-top:.5rem;flex-wrap:wrap">${E.per.map((x: any) => `<button class="${x.accrued >= 0.000001 ? 'pri ' : ''}sm" ${x.accrued >= 0.000001 ? '' : 'disabled'} onclick="window.ld.claim('${x.asset}')">Claim ${esc(x.asset === 'LUMA' ? ctx.native() : 'USD')}</button>`).join('')}</div><div class="mut" style="font-size:.78rem;margin-top:.4rem">Earnings build every second on your supplied balance, on top of the normal interest. ${ER && ER.autoPayHours ? `They are also paid to you automatically every ${ER.autoPayHours} h${ER.nextAuto ? ' (next ' + new Date(ER.nextAuto).toLocaleString() + ')' : ''}, no claim needed. ` : ''}You can claim early any time. Claims are paid from a rewards pool the operator funds; if it is low, your earnings wait for the next top-up.</div></div>` : '';
  const btn = (k: string, c = '') => `<button class="sm ${c}" onclick="window.ld.act('${k}')">${KIND[k].verb}</button>`;
  return `<div class="card c12"><div class="row" style="align-items:center;gap:.6rem"><div class="k">My position</div><span class="grow"></span><button class="sm" onclick="window.ld.load(true)">Refresh</button></div>${w}${summary}${earn}
  <div style="overflow:auto;margin-top:.6rem"><table style="width:100%;font-size:.88rem"><tr class="mut" style="text-align:left"><th>Asset</th><th>Supplied</th><th>Collateral</th><th>Debt</th><th>Supply / borrow APY</th></tr>${A2.map(row).join('')}</table></div></div>
  <div class="card c12"><div class="k">Lend or borrow</div>${bad ? `<div class="mut" style="margin-top:.4rem;color:${AMB}">${esc(bad)}</div>` : ''}
  <div class="row" style="gap:.5rem;margin-top:.6rem;flex-wrap:wrap"><select id="ld_asset" onchange="window.ld.set('asset',this.value)">${A2.map(a => `<option value="${a}" ${F.asset === a ? 'selected' : ''}>${esc(nm(a))}</option>`).join('')}</select><input id="ld_amt" class="grow" style="min-width:9rem" placeholder="Amount" inputmode="decimal" value="${esc(F.amt)}" oninput="window.ld.set('amt',this.value)"><div class="row" style="gap:.25rem;flex-wrap:wrap">${['supply', 'withdraw', 'collateral', 'withdrawcol', 'borrow', 'repay'].map(k => `<button class="sm" style="opacity:.8" title="Fill the most you can ${KIND[k].verb.toLowerCase()}" onclick="window.ld.max('${k}')">max ${KIND[k].verb.toLowerCase()}</button>`).join('')}</div></div>
  <div id="ld_pre" class="mut" style="margin-top:.5rem;font-size:.84rem;min-height:1.3rem"></div>
  <div class="row" style="gap:.4rem;margin-top:.5rem;flex-wrap:wrap">${btn('supply', 'pri')}${btn('withdraw')}${btn('collateral', 'pri')}${btn('withdrawcol')}${btn('borrow', 'pri')}${btn('repay')}</div>
  <div class="mut" style="font-size:.8rem;margin-top:.5rem;line-height:1.45">Each button sends one payment from this wallet to the lending vault. You see exactly what it does and approve it first. Borrow, withdraw and take-back requests send one drop of ${esc(ctx.native())} as the request, and the money comes back to you from the vault.</div></div>
  ${activityHtml()}`;
}
function preview() { const e = $('ld_pre'); if (!e) return; const amt = Number(F.amt); if (!(amt > 0)) { e.innerHTML = ''; return; } const out: string[] = [];
  for (const k of ['supply', 'withdraw', 'collateral', 'withdrawcol', 'borrow', 'repay']) { const r = problems(k, F.asset, amt); out.push(r.err ? `<span style="opacity:.6">${KIND[k].verb}: ${esc(r.err)}</span>` : `<span style="color:${GREEN}">${KIND[k].verb}: OK</span>`); }
  e.innerHTML = out.join('<br>'); }
function activityHtml(): string {
  const ev = ACT.slice(0, 40), pays = (ACC && ACC.payouts) || [];
  return `<div class="card c12"><div class="k">My activity</div><div style="overflow:auto;max-height:22rem;margin-top:.5rem"><table style="width:100%;font-size:.84rem"><tr class="mut" style="text-align:left"><th>When</th><th>What</th></tr>${ev.map(e => `<tr><td style="white-space:nowrap">${esc(ago(Date.now() - e.t))}</td><td>${e.type === 'reject' ? chip('refused', RED) + ' ' : e.type === 'liquidation' ? chip('liquidation', AMB) + ' ' : ''}${esc(String(e.msg).replace(/^[^:]*: /, ''))}</td></tr>`).join('') || '<tr><td colspan="2" class="mut">Nothing yet.</td></tr>'}</table></div>
  ${pays.length ? `<div class="mut" style="font-size:.82rem;margin-top:.5rem">Payouts to you: ${pays.slice(0, 6).map((x: any) => `${N(x.amount, 4)} ${esc(nm(x.asset))} ${chip(x.status, x.status === 'sent' ? GREEN : x.status === 'stuck' ? RED : AMB)}`).join(' · ')}</div>` : ''}</div>`;
}
function liqHtml(): string {
  const l = LIQ; if (!l) return '<div class="card c12 mut">Loading…</div>'; const p = P();
  const rows = l.list.map((v: any) => { const debts = v.per.filter((x: any) => x.debt > 0), cols = v.per.filter((x: any) => x.collateral > 0);
    return `<tr><td class="mono">${esc(short(v.addr, 8, 6))}</td><td>${debts.map((x: any) => N(x.debt, 2) + ' ' + esc(nm(x.asset))).join('<br>')}</td><td>${cols.map((x: any) => N(x.collateral, 2) + ' ' + esc(nm(x.asset))).join('<br>')}</td><td>${hfTxt(v.healthFactor)}</td><td>${debts.map((d: any) => cols.filter((c: any) => c.asset !== d.asset).map((c: any) => `<button class="sm pri" onclick="window.ld.liq('${esc(v.classic)}','${d.asset}','${c.asset}')">Repay ${esc(nm(d.asset))} → take ${esc(nm(c.asset))}</button>`).join(' ')).join(' ')}</td></tr>`; }).join('');
  const risk = (l.atRisk || []).map((v: any) => `<tr><td class="mono">${esc(short(v.addr, 8, 6))}</td><td>${hfTxt(v.healthFactor)}</td><td>${v.liquidation ? esc(ctx.native()) + ' ' + (v.liquidation.when === 'below' ? 'under' : 'over') + ' $' + N(v.liquidation.price, 4) : '–'}</td><td>${USD(v.debtUsd)}</td></tr>`).join('');
  return `<div class="card c12"><div class="k">Loans that can be liquidated now</div><div class="mut" style="font-size:.86rem;margin:.3rem 0">Liquidating means repaying part of someone's debt and receiving their collateral at a ${PCT(p.liqBonus, 0)} discount. You can repay up to ${PCT(p.closeFactor, 0)} of a debt per step. You need the debt asset in your wallet.</div><div style="overflow:auto"><table style="width:100%;font-size:.86rem"><tr class="mut" style="text-align:left"><th>Borrower</th><th>Debt</th><th>Collateral</th><th>Health</th><th></th></tr>${rows || '<tr><td colspan="5" class="mut">None right now. Every loan is healthy.</td></tr>'}</table></div></div>
  <div class="card c12"><div class="k">Getting close</div><div style="overflow:auto"><table style="width:100%;font-size:.86rem"><tr class="mut" style="text-align:left"><th>Borrower</th><th>Health</th><th>Liquidated if LUMA goes</th><th>Debt</th></tr>${risk || '<tr><td colspan="4" class="mut">Nothing close to the line.</td></tr>'}</table></div></div>`;
}
function analyticsHtml(): string {
  const h = HIST; if (!h || !h.snaps) return '<div class="card c12 mut">Loading…</div>'; const S: any[] = h.snaps;
  const ser = (f: (s: any) => number | null, name: string, color: string) => ({ name, color, data: S.map(s => [s.t, f(s)] as [number, number | null]) });
  const last = S.length ? S[S.length - 1] : null, b = last && last.buckets, tot = b ? (Object.values(b) as number[]).reduce((x, y) => x + y, 0) : 0;
  const dist = b ? [['safe', 'Safe (1.5 and up)', GREEN], ['watch', 'Watch (1.15 to 1.5)', AMB], ['danger', 'Danger (1.0 to 1.15)', '#ff8a3d'], ['liquidatable', 'Liquidatable (under 1.0)', RED], ['noDebt', 'No debt', '#9aa']].map(r => `<div class="row" style="gap:.5rem;align-items:center;margin:.2rem 0"><span style="width:11rem;font-size:.84rem">${r[1]}</span><div style="flex:1">${bar(tot ? b[r[0]] / tot : 0, r[2])}</div><span style="width:2rem;text-align:right">${b[r[0]]}</span></div>`).join('') : '<div class="mut">Collecting data.</div>';
  const t = OP.snap.totals;
  return `<div class="card c6"><div class="k">Supplied, borrowed and collateral (USD)</div>${line([ser(s => s.tvl, 'Total value', BLUE), ser(s => s.borrowed, 'Borrowed', AMB), ser(s => s.collateral, 'Collateral', GREEN)], v => '$' + N(v, 0), true)}</div>
  <div class="card c6"><div class="k">${esc(ctx.native())} price</div>${line([{ name: 'price', color: BLUE, data: (h.price || []) as [number, number][] }], v => '$' + N(v, 4))}</div>
  <div class="card c6"><div class="k">Use of each market</div>${line(A2.map((a, i) => ser(s => (s.m[a] ? s.m[a].util * 100 : null), nm(a), i ? GREEN : BLUE)), v => N(v, 0) + '%', true)}</div>
  <div class="card c6"><div class="k">Rates (APR)</div>${line([ser(s => (s.m.LUMA ? s.m.LUMA.borrowApr * 100 : null), nm('LUMA') + ' borrow', AMB), ser(s => (s.m.USD ? s.m.USD.borrowApr * 100 : null), 'USD borrow', '#ff8a3d'), ser(s => (s.m.LUMA ? s.m.LUMA.supplyApr * 100 : null), nm('LUMA') + ' supply', GREEN), ser(s => (s.m.USD ? s.m.USD.supplyApr * 100 : null), 'USD supply', BLUE)], v => N(v, 1) + '%', true)}</div>
  <div class="card c6"><div class="k">How healthy are the loans</div>${dist}</div>
  <div class="card c6"><div class="k">Totals since the pool started</div><table style="width:100%;font-size:.86rem">${[['Requests processed', N(t.deposits, 0)], ['Payouts sent', N(t.payouts, 0)], ['Requests refused', N(t.rejected, 0)], ['Liquidations', N(t.liquidations, 0)], ['Repaid by liquidators', USD(t.liqUsd)], ['Open positions', N(OP.snap.users, 0)], ['Bad debt', USD(OP.snap.stats.badDebtUsd)], ['Protocol reserves', USD(OP.snap.stats.reservesUsd)]].map(r => `<tr><td class="mut">${r[0]}</td><td style="text-align:right">${r[1]}</td></tr>`).join('')}</table></div>`;
}
function dataHtml(): string {
  const s = OP.snap; if (!s) return ''; const L = s.latency || {}, h = s.health || {}, med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const row = (k: string, name: string, note: string) => `<tr title="${esc(note)}"><td>${esc(name)}<div class="mut" style="font-size:.74rem">${esc(note)}</div></td><td>${MS(L[k] && L[k].last)}</td><td>${MS(L[k] && L[k].p50)}</td><td>${MS(L[k] && L[k].p95)}</td><td>${MS(L[k] && L[k].max)}</td></tr>`;
  return `<div class="card c12"><div class="k">Service health and latency</div><div class="row" style="gap:.6rem;flex-wrap:wrap;width:100%;margin-top:.5rem">${tile('Service', h.running ? chip('running', GREEN) : chip(s.mode === 'on' ? 'stalled' : 'off', s.mode === 'on' ? RED : '#9aa'), 'last pass ' + (h.lastTick ? ago(Date.now() - h.lastTick) : 'never'))}${tile('Ledger age', MS(h.ledgerAge), 'newest closed ledger')}${tile('Payouts waiting', N(h.queue, 0), 'sent one at a time')}${tile('Price age', MS(s.price && s.price.ageMs), 'LUMA price used for risk')}${tile('Round trip to the operator', MS(OP.rtt), 'median ' + MS(med(RTT)))}</div>
  <div style="overflow:auto;margin-top:.7rem"><table style="width:100%;font-size:.86rem"><tr class="mut" style="text-align:left"><th>Measure (last hour, operator side)</th><th>Latest</th><th>Median</th><th>95th percentile</th><th>Worst</th></tr>${row('lag', 'Request to applied', 'from your payment closing in a ledger until the vault applies it')}${row('tick', 'Service pass', 'one full read, accrue and pay cycle')}${row('rpc', 'Node call round trip', 'each request from the service to the LUMA node')}${row('pay', 'Payout queued to sent', 'from the decision to pay until the payment validated')}${row('price', 'Price age', 'how old the price was on each pass')}</table></div>
  <div class="mut" style="font-size:.84rem;margin-top:.6rem">Your own requests this session: ${MINE.n ? `${MINE.n} applied, last ${MS(MINE.last)}, fastest ${MS(MINE.best)}, median ${MS(med(MINE.samples))}` : 'none yet. Send one and its time to be applied shows here.'}</div>
  <div class="mut" style="font-size:.8rem;margin-top:.3rem">Operator feed: ${esc(OP.url || 'not set')} · refreshed ${OP.at ? ago(Date.now() - OP.at) : 'never'} · <a href="#" onclick="window.ld.setOp();return false">change address</a></div></div>
  <div class="card c12"><div class="k">Rules in force</div><table style="width:100%;font-size:.86rem">${[['Borrow limit', PCT(s.params.ltvMax, 0) + ' of collateral value'], ['Liquidation threshold', PCT(s.params.liqThreshold, 0)], ['Liquidator bonus', PCT(s.params.liqBonus, 0)], ['Share of a debt repaid per liquidation', 'up to ' + PCT(s.params.closeFactor, 0)], ['Share of interest kept as reserve', PCT(s.params.reserveFactor, 0)], ['Smallest deposit / collateral / loan', `${USD(s.params.minSupplyUsd)} / ${USD(s.params.minCollateralUsd)} / ${USD(s.params.minBorrowUsd)}`], ['Interest curve', `${PCT(s.params.rate.base)} base, +${PCT(s.params.rate.slope1)} up to ${PCT(s.params.rate.kink, 0)} use, then +${PCT(s.params.rate.slope2, 0)}`], ['Vault', esc(s.vault || 'not created')], ['Instruction memo type', esc(s.memoType)]].map(r => `<tr><td class="mut">${r[0]}</td><td style="text-align:right">${r[1]}</td></tr>`).join('')}</table></div>`;
}
const TABS: [V, string][] = [['markets', 'Markets'], ['mine', 'My position'], ['liq', 'Liquidations'], ['analytics', 'Analytics'], ['data', 'Latency & data']];
export function shell() {
  return `<div id="ld_root" style="width:100%"><div class="row" style="gap:.4rem;margin-bottom:.7rem;flex-wrap:wrap" id="ld_tabs"></div><div id="ld_body" class="grid" style="width:100%"><div class="card c12 mut">Loading…</div></div></div>`;
}
function paint() {
  const root = document.getElementById('ld_root'); if (!root) return; const tabs = document.getElementById('ld_tabs'), body = document.getElementById('ld_body'); if (!tabs || !body) return;
  tabs.innerHTML = TABS.map(([k, l]) => `<button class="sm ${VIEW === k ? 'pri' : ''}" onclick="window.ld.view('${k}')">${l}</button>`).join('') + '<span class="grow"></span><button class="sm" onclick="window.ld.load(true)">Refresh</button>';
  const a = document.activeElement as HTMLElement | null; const typing = a && a.id === 'ld_amt'; const sel = typing ? (a as HTMLInputElement).selectionStart : null;
  const inner = bannerHtml() + (VIEW === 'markets' ? marketsHtml() : VIEW === 'mine' ? actionsHtml() : VIEW === 'liq' ? liqHtml() : VIEW === 'analytics' ? (OP.snap ? analyticsHtml() : '') : dataHtml());
  if (body.dataset.sig !== String(inner.length) + inner.slice(0, 80) || !typing) { const keep = body.scrollTop; body.innerHTML = inner; body.scrollTop = keep; }
  if (typing) { const e = $('ld_amt'); if (e) { e.focus(); if (sel != null) e.setSelectionRange(sel, sel); } }
  preview();
}
export function mount() { clearInterval(timer); void load(true); timer = setInterval(() => { if (!document.getElementById('ld_root')) { clearInterval(timer); return; } if (document.hidden) return; const a = document.activeElement as HTMLElement | null; if (a && a.id === 'ld_amt') return; void load(); }, 8000); }
export const api = { load, act, claim, liq: liquidate, view, set, max, setOp };
