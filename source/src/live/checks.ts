// Checks: the ledger's own "write a cheque, the other person cashes it" feature (CheckCreate, CheckCash, CheckCancel).
// A check is NOT a payment and does not lock any money. It is a signed promise that sits on the ledger until the recipient cashes it
// (the money moves at that moment, from the writer's balance) or it is cancelled or expires. That is why every screen here checks
// both sides first: does the recipient exist, can they hold the asset, does the writer still have the money.
// Works on whichever network the active wallet uses (LUMA or XRPL) because ctx.req / ctx.submit already follow the active wallet.
import { ctx } from './ctx.ts';
import { esc, hexName, isNative, akey, fromKey, NATIVE, amtTx, amtNum, assetOf, fmt, short, ago, rippleToMs, type Asset } from './util.ts';
import * as xrpl from 'xrpl';
import { tryReq } from './chain.ts';
import * as PM from './procmodal.ts';
import * as Pr from './payroll.ts';
(window as any).pr = Pr.api;

const RIPPLE_EPOCH = 946684800;
const LSF_DISALLOW_INCOMING_CHECK = 0x08000000;
const EXP: [string, string, number][] = [['never', 'No expiry', 0], ['1h', '1 hour', 3600], ['1d', '1 day', 86400], ['7d', '7 days', 604800], ['30d', '30 days', 2592000], ['90d', '90 days', 7776000]];

interface Chk { index: string; Account: string; Destination: string; SendMax: any; Expiration?: number; DestinationTag?: number; Sequence?: number; InvoiceID?: string }
interface Opt { key: string; asset: Asset; sym: string; have: number }
let OPTS: Opt[] = [];
let OBJS: Chk[] = [];
let HIST: any[] = [];
let busy = false, busyAt = 0, optSig = '', loaded = false, VIEW: 'checks' | 'payroll' = 'checks';
const F = { to: '', amt: '', asset: 'native', exp: '7d', tag: '', memo: '' };

const nativeName = () => ctx.native();
const assetName = (a: Asset) => (isNative(a) ? nativeName() : hexName(a.c));
const hexOf = (s: string) => Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const fromHex = (h: string) => { try { return new TextDecoder().decode(Uint8Array.from((h.match(/../g) || []).map(x => parseInt(x, 16)))); } catch { return ''; } };
const nowRipple = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;
const expired = (c: Chk) => !!c.Expiration && c.Expiration <= nowRipple();
const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const amtText = (x: any) => { const a = assetOf(x); return `${fmt(amtNum(x), 6)} ${esc(assetName(a))}`; };
const when = (r?: number) => (r ? new Date(rippleToMs(r)).toLocaleString() : '');

export function shell() {
  const sel = EXP.map(e => `<option value="${e[0]}" ${F.exp === e[0] ? 'selected' : ''}>${e[1]}</option>`).join('');
  return `<div class="ckpg" style="width:100%"><div class="row" style="gap:.5rem;margin-bottom:.7rem"><button id="ckv_checks" class="sm ${VIEW === 'checks' ? 'pri' : ''}" onclick="window.ck.view('checks')">Checks</button><button id="ckv_payroll" class="sm ${VIEW === 'payroll' ? 'pri' : ''}" onclick="window.ck.view('payroll')">Payroll</button></div>
  <div id="ck_checks" class="grid" style="width:100%;${VIEW === 'checks' ? '' : 'display:none'}">
  <div class="card c12"><div class="row" style="align-items:center;gap:.6rem"><div class="k">Checks</div><span class="grow"></span><button class="sm" onclick="window.ck.load(true)">Refresh</button></div>
    <div class="mut" style="margin-top:.4rem;font-size:.88rem;line-height:1.5">A check is a signed promise to pay. <b>No money moves and none is held</b> when you write one: the person you wrote it to cashes it, and the money leaves your balance at that moment, only if you still have it. Anyone can cancel a check they wrote, and a check can carry an expiry. An open check uses a small reserve on the writer's account until it is cashed, cancelled or expired.</div>
    <div id="ck_net" class="mut" style="margin-top:.4rem;font-size:.8rem"></div></div>
  <div class="card c6"><div class="k">Write a check</div>
    <div class="fgrid" style="margin-top:.6rem">
      <input id="ck_to" placeholder="Pay to (wallet address)" value="${esc(F.to)}" oninput="window.ck.f('to',this.value)" autocomplete="off" spellcheck="false">
      <div class="row" style="gap:.4rem"><input id="ck_amt" class="grow" placeholder="Amount (the most they can cash)" inputmode="decimal" value="${esc(F.amt)}" oninput="window.ck.f('amt',this.value)"><select id="ck_asset" onchange="window.ck.f('asset',this.value)"></select></div>
      <select id="ck_exp" onchange="window.ck.f('exp',this.value)">${sel}</select>
      <input id="ck_tag" placeholder="Destination tag (optional, numbers only)" inputmode="numeric" value="${esc(F.tag)}" oninput="window.ck.f('tag',this.value)">
      <input id="ck_memo" placeholder="Note to the recipient (optional, public on the ledger)" maxlength="120" value="${esc(F.memo)}" oninput="window.ck.f('memo',this.value)">
    </div>
    <div id="ck_pre" class="mut" style="margin-top:.5rem;font-size:.84rem;min-height:1.2rem"></div>
    <div class="row" style="margin-top:.6rem;gap:.5rem"><button class="pri grow" onclick="window.ck.write()">Review and write check</button></div></div>
  <div class="card c6"><div class="k">Checks waiting for you</div><div id="ck_in" style="margin-top:.5rem"><div class="mut">Loading…</div></div></div>
  <div class="card c12"><div class="k">Checks you wrote</div><div id="ck_out" style="margin-top:.5rem"><div class="mut">Loading…</div></div></div>
  <div class="card c12"><div class="k">Check history</div><div id="ck_hist" style="margin-top:.5rem"><div class="mut">Loading…</div></div></div>
  </div>
  <div id="pr_wrap" style="${VIEW === 'payroll' ? '' : 'display:none'}">${Pr.shell()}</div></div>`;
}

// ---------- reading the ledger ----------
async function readOpts(acc: string) {
  const [ai, al] = await Promise.all([tryReq('account_info', { account: acc, ledger_index: 'validated' }), tryReq('account_lines', { account: acc, ledger_index: 'validated', limit: 400 })]);
  const out: Opt[] = [];
  const bal = ai && ai.account_data ? Number(ai.account_data.Balance) / 1e6 : 0;
  out.push({ key: 'native', asset: NATIVE, sym: nativeName(), have: bal });
  for (const l of (al && al.lines) || []) { const a: Asset = { c: l.currency, i: l.account }; out.push({ key: akey(a), asset: a, sym: hexName(l.currency), have: Number(l.balance) }); }
  const seen: Record<string, number> = {}; for (const o of out) seen[o.sym] = (seen[o.sym] || 0) + 1;
  for (const o of out) if (seen[o.sym] > 1 && o.key !== 'native') o.sym += ' (' + short(o.asset.i, 4, 3) + ')';
  OPTS = out;
}
async function readObjects(acc: string) {
  const r: any = await tryReq('account_objects', { account: acc, type: 'check', ledger_index: 'validated', limit: 400 });
  OBJS = ((r && r.account_objects) || []).filter((o: any) => o.LedgerEntryType === 'Check' || o.SendMax);
}
async function readHistory(acc: string) {
  const out: any[] = []; let marker: any;
  for (let i = 0; i < 6; i++) {
    const r: any = await tryReq('account_tx', { account: acc, ledger_index_min: -1, ledger_index_max: -1, limit: 200, ...(marker ? { marker } : {}) });
    if (!r) break;
    for (const t of r.transactions || []) {
      const tx = t.tx || t.tx_json || {}; if (!tx.hash && t.hash) tx.hash = t.hash;
      if (!/^Check(Create|Cash|Cancel)$/.test(tx.TransactionType || '')) continue;
      const meta = t.meta || {}; out.push({ tx, res: meta.TransactionResult || '', delivered: meta.delivered_amount, validated: t.validated !== false });
    }
    marker = r.marker; if (!marker || out.length >= 300) break;
  }
  HIST = out.slice(0, 300);
}

export async function load(force = false) {
  const acc = ctx.account(); const net = $('ck_net');
  if (!document.getElementById('ck_in')) return;
  if (!ctx.online() || !acc) { if (net) net.textContent = 'Connect and unlock a wallet to use checks.'; return; }
  if (busy && Date.now() - busyAt < 25000 && !force) return;
  busy = true; busyAt = Date.now();
  try {
    if (net) net.innerHTML = `Using <b>${esc(ctx.xrpl() ? 'XRPL' : nativeName())}</b> with wallet <span class="mono">${esc(short(ctx.show(acc), 8, 6))}</span>`;
    await Promise.all([readOpts(acc), readObjects(acc), readHistory(acc)]);
    loaded = true; paintSelect(); paintLists(acc); void preview();
    Pr.setOpts(OPTS.map(o => ({ key: o.key, sym: o.sym, asset: o.asset, have: o.have })));
    Pr.reconcile(new Set(OBJS.filter(c => c.Account === acc).map(c => c.index)), Object.fromEntries(OBJS.filter(c => c.Expiration).map(c => [c.index, c.Expiration as number])), HIST); Pr.mount();
  } catch (e: any) {
    const el = document.getElementById('ck_in'); if (el) el.innerHTML = `<div class="mut">Could not read checks: ${esc(e?.message || e)}</div>`;
  } finally { busy = false; }
}
function paintSelect() {
  const s = document.getElementById('ck_asset') as HTMLSelectElement | null; if (!s) return;
  const sig = OPTS.map(o => o.key + o.have).join(',');
  if (sig === optSig && s.options.length) return; optSig = sig;
  const cur = F.asset; s.innerHTML = OPTS.map(o => `<option value="${esc(o.key)}">${esc(o.sym)} (you hold ${fmt(o.have)})</option>`).join('');
  s.value = OPTS.some(o => o.key === cur) ? cur : 'native'; F.asset = s.value;
}

// ---------- lists ----------
function row(c: Chk, mine: boolean) {
  const exp = expired(c), other = mine ? c.Destination : c.Account;
  const meta = [c.DestinationTag != null ? `tag ${c.DestinationTag}` : '', c.Expiration ? (exp ? `<span class="dn">expired ${esc(when(c.Expiration))}</span>` : `expires ${esc(when(c.Expiration))}`) : 'no expiry', c.InvoiceID ? 'invoice ' + esc(short(c.InvoiceID, 6, 4)) : ''].filter(Boolean).join(' · ');
  const btns = mine
    ? `<button class="sm" onclick="window.ck.cancel('${esc(c.index)}')">${exp ? 'Remove expired check' : 'Cancel check'}</button>`
    : exp ? `<button class="sm" onclick="window.ck.cancel('${esc(c.index)}')">Remove expired check</button>`
      : `<button class="sm pri" onclick="window.ck.cash('${esc(c.index)}',0)">Cash check</button><button class="sm" onclick="window.ck.cash('${esc(c.index)}',1)">Cash up to…</button><button class="sm" onclick="window.ck.cancel('${esc(c.index)}')">Reject</button>`;
  return `<div class="ckrow" style="padding:.6rem 0;border-top:1px solid rgba(255,255,255,.07)"><div class="row" style="align-items:center;gap:.6rem;flex-wrap:wrap"><b>${amtText(c.SendMax)}</b><span class="mut">${mine ? 'to' : 'from'}</span><span class="mono" title="${esc(ctx.show(other))}">${esc(short(ctx.show(other), 8, 6))}</span><span class="grow"></span>${btns}</div><div class="mut" style="font-size:.78rem;margin-top:.15rem">${meta} · id <span class="mono">${esc(short(c.index, 6, 4))}</span></div></div>`;
}
function paintLists(acc: string) {
  const mineL = OBJS.filter(c => c.Account === acc).sort((a, b) => (b.Sequence || 0) - (a.Sequence || 0));
  const inL = OBJS.filter(c => c.Destination === acc && c.Account !== acc);
  const set = (id: string, html: string) => { const e = document.getElementById(id); if (e) e.innerHTML = html; };
  set('ck_in', inL.length ? inL.map(c => row(c, false)).join('') : '<div class="mut">Nothing waiting. When someone writes you a check it shows up here to cash.</div>');
  set('ck_out', mineL.length ? mineL.map(c => row(c, true)).join('') : '<div class="mut">You have no open checks. Checks you write stay here until cashed, cancelled or expired.</div>');
  const label: Record<string, string> = { CheckCreate: 'Wrote a check', CheckCash: 'Cashed a check', CheckCancel: 'Cancelled a check' };
  set('ck_hist', HIST.length ? `<div style="overflow:auto"><table style="width:100%;font-size:.84rem"><tr class="mut" style="text-align:left"><th>When</th><th>What</th><th>Amount</th><th>With</th><th>Result</th></tr>${HIST.slice(0, 60).map(h => {
    const t = h.tx, ok = h.res === 'tesSUCCESS', amt = t.TransactionType === 'CheckCreate' ? amtText(t.SendMax) : t.TransactionType === 'CheckCash' ? (h.delivered ? amtText(h.delivered) : t.Amount ? amtText(t.Amount) : t.DeliverMin ? 'at least ' + amtText(t.DeliverMin) : '') : '';
    const w = t.TransactionType === 'CheckCreate' ? (t.Account === acc ? 'to ' + short(ctx.show(t.Destination), 7, 5) : 'from ' + short(ctx.show(t.Account), 7, 5)) : 'check ' + short(t.CheckID || '', 6, 4);
    return `<tr style="border-top:1px solid rgba(255,255,255,.06)"><td>${t.date != null ? esc(ago(Date.now() - rippleToMs(t.date))) : ''}</td><td>${esc(label[t.TransactionType])}</td><td>${amt}</td><td class="mono">${esc(w)}</td><td class="${ok ? 'up' : 'dn'}">${ok ? 'done' : esc(h.res || 'pending')}</td></tr>`;
  }).join('')}</table></div>` : '<div class="mut">No check activity yet.</div>');
}

// ---------- writing a check ----------
function readForm() {
  const raw = (F.to || '').trim(); let to = ''; try { to = raw ? ctx.toClassic(raw) : ''; } catch { to = ''; } if (to && !xrpl.isValidClassicAddress(to)) to = '';
  const o = OPTS.find(x => x.key === F.asset) || OPTS[0]; const amt = Number(F.amt);
  return { raw, to, o, amt, tag: F.tag.trim() === '' ? null : Number(F.tag) };
}
let pvSeq = 0;
/** problems that would stop the recipient cashing the check, found before anything is signed */
async function problems(to: string, o: Opt, amt: number, acc: string): Promise<{ stop: string[]; warn: string[] }> {
  const stop: string[] = [], warn: string[] = [];
  if (!to) { stop.push('Enter a valid wallet address to pay.'); return { stop, warn }; }
  if (to === acc) stop.push('You cannot write a check to yourself.');
  const ai: any = await tryReq('account_info', { account: to, ledger_index: 'validated' });
  if (!ai || !ai.account_data) warn.push('That address does not exist on this network yet. They can only cash the check after it is activated with the minimum balance.');
  else {
    if ((Number(ai.account_data.Flags || 0) & LSF_DISALLOW_INCOMING_CHECK) !== 0) stop.push('That account has switched off incoming checks.');
    if ((Number(ai.account_data.Flags || 0) & 0x00020000) !== 0 && !F.tag.trim()) warn.push('That account requires a destination tag. Add one or the check cannot be cashed.');
    if (!isNative(o.asset) && o.asset.i !== to) {
      const l: any = await tryReq('account_lines', { account: to, peer: o.asset.i, ledger_index: 'validated' });
      const line = ((l && l.lines) || []).find((x: any) => x.currency === o.asset.c);
      if (!line) warn.push(`They have no trust line for ${o.sym}. They must add one before they can cash it (the cash step offers to add it for them).`);
    }
  }
  if (o && amt > o.have + 1e-9) warn.push(`You hold ${fmt(o.have)} ${o.sym}. A check only pays if you still have the money when it is cashed.`);
  return { stop, warn };
}
async function preview() {
  const box = document.getElementById('ck_pre'); if (!box) return; const my = ++pvSeq; const acc = ctx.account(); const f = readForm();
  if (!acc || !f.raw || !f.o) { box.innerHTML = ''; return; }
  const p = await problems(f.to, f.o, f.amt > 0 ? f.amt : 0, acc); if (my !== pvSeq) return;
  box.innerHTML = [...p.stop.map(x => `<div class="dn">✕ ${esc(x)}</div>`), ...p.warn.map(x => `<div style="color:#fbbf24">⚠ ${esc(x)}</div>`)].join('') || '<div class="up">✓ This address can receive a check.</div>';
}
let pvT: any = 0;
export function setField(k: string, v: string) { (F as any)[k] = v; clearTimeout(pvT); pvT = setTimeout(() => void preview(), 450); }

async function runTx(title: string, steps: string[], tx: any, done: (hash?: string) => string, after?: () => void) {
  const pg = PM.progress(title, steps, 'tip'); pg.set(0, 'run');
  let r: { ok: boolean; msg?: string; hash?: string };
  try { r = await ctx.submit(tx); } catch (e: any) { r = { ok: false, msg: String(e?.message || e) }; }
  if (!r.ok) { pg.fail(friendly(r.msg)); return false; }
  pg.set(0, 'ok'); if (steps[1]) pg.set(1, 'ok');
  pg.done(done(r.hash)); if (after) after(); setTimeout(() => void load(true), 1500); return true;
}
function friendly(m?: string) {
  const s = String(m || 'The network refused the transaction.');
  if (/temDISABLED/.test(s)) return 'This network has not turned on Checks yet, so checks cannot be used here.';
  if (/tecNO_PERMISSION/.test(s)) return 'Only the person the check is written to can cash it.';
  if (/tecPATH_PARTIAL|tecUNFUNDED/.test(s)) return 'The writer does not have enough money for the full amount right now. Cash a smaller amount with "Cash up to…".';
  if (/tecNO_LINE|tecNO_AUTH|tecFROZEN/.test(s)) return 'You cannot hold this asset yet (no trust line, not authorised or frozen).';
  if (/tecEXPIRED/.test(s)) return 'This check has expired. You can remove it from the list.';
  if (/tecNO_ENTRY/.test(s)) return 'This check no longer exists (it was already cashed or cancelled).';
  if (/tecDST_TAG_NEEDED|DST_TAG/.test(s)) return 'The recipient needs a destination tag on this check.';
  if (/tecNO_DST|tecNO_DST_INSUF_XRP/.test(s)) return 'The recipient account is not activated on this network yet.';
  if (/tecINSUFFICIENT_RESERVE|tecINSUF_RESERVE/.test(s)) return 'Not enough spare balance to cover the reserve for an open check.';
  return s;
}

export async function write() {
  const acc = ctx.account(); if (!acc) return ctx.toast('Unlock a wallet first', true);
  const f = readForm();
  if (!f.raw) return ctx.toast('Enter who to pay', true); if (!f.to) return ctx.toast('That is not a valid wallet address', true);
  if (!(f.amt > 0)) return ctx.toast('Enter an amount greater than zero', true);
  if (f.tag != null && !(Number.isInteger(f.tag) && f.tag >= 0 && f.tag <= 4294967295)) return ctx.toast('Destination tag must be a whole number', true);
  let SendMax: any; try { SendMax = amtTx(f.o.asset, f.amt); } catch (e: any) { return ctx.toast(e.message, true); }
  const p = await problems(f.to, f.o, f.amt, acc); if (p.stop.length) return ctx.toast(p.stop[0], true);
  const expS = (EXP.find(e => e[0] === F.exp) || EXP[0])[2];
  const tx: any = { TransactionType: 'CheckCreate', Account: acc, Destination: f.to, SendMax };
  if (expS) tx.Expiration = nowRipple() + expS; if (f.tag != null) tx.DestinationTag = f.tag;
  if (F.memo.trim()) tx.Memos = [{ Memo: { MemoType: hexOf('text/plain'), MemoData: hexOf(F.memo.trim()) } }];
  const ok = await PM.review({
    title: 'Write a check', tone: 'tip', hero: `<div style="font-size:1.5rem;font-weight:800">${fmt(f.amt, 6)} ${esc(f.o.sym)}</div><div class="mut">to ${esc(ctx.show(f.to))}</div>`,
    rows: [{ k: 'Money moves now?', v: 'No, only when cashed' }, { k: 'They can cash up to', v: `${fmt(f.amt, 6)} ${esc(f.o.sym)}` }, { k: 'Expires', v: expS ? esc(new Date(Date.now() + expS * 1000).toLocaleString()) : 'Never' }, ...(f.tag != null ? [{ k: 'Destination tag', v: String(f.tag) }] : []), ...(F.memo.trim() ? [{ k: 'Note', v: esc(F.memo.trim()) }] : [])],
    warns: p.warn, confirm: 'Write check', note: 'Writing a check costs the normal network fee and holds a small reserve on your account until it is cashed, cancelled or expired.',
  });
  if (!ok) return;
  await runTx('Writing check', ['Signing and sending', 'Waiting for the ledger'], tx, () => `Check written to <b>${esc(short(ctx.show(f.to), 8, 6))}</b>. They can now cash up to ${fmt(f.amt, 6)} ${esc(f.o.sym)}.`, () => { F.amt = ''; F.memo = ''; F.tag = ''; const a = $('ck_amt'), m = $('ck_memo'), t = $('ck_tag'); if (a) a.value = ''; if (m) m.value = ''; if (t) t.value = ''; });
}

// ---------- cashing and cancelling ----------
export async function cash(id: string, partial: number) {
  const acc = ctx.account(); const c = OBJS.find(x => x.index === id); if (!acc || !c) return ctx.toast('Check not found. Refresh and try again.', true);
  if (c.Destination !== acc) return ctx.toast('Only the person a check is written to can cash it.', true);
  if (expired(c)) return ctx.toast('This check has expired. Remove it from the list.', true);
  const a = assetOf(c.SendMax), max = amtNum(c.SendMax), sym = assetName(a); let amt = max;
  if (partial) {
    const v = window.prompt(`Cash at least how much ${sym}? You will receive as much as the writer can pay, up to ${fmt(max, 6)}, but never less than this.`, String(max)); if (v == null) return;
    const n = Number(v); if (!(n > 0) || n > max) return ctx.toast(`Enter an amount between 0 and ${fmt(max, 6)}`, true); amt = n;
  }
  const warns: string[] = []; let needLine = false;
  if (!isNative(a) && a.i !== acc) {
    const l: any = await tryReq('account_lines', { account: acc, peer: a.i, ledger_index: 'validated' });
    needLine = !((l && l.lines) || []).some((x: any) => x.currency === a.c);
    if (needLine) warns.push(`You have no trust line for ${sym}. One will be added first (it uses a small reserve).`);
  }
  const wr: any = await tryReq('account_lines', { account: c.Account, ledger_index: 'validated', limit: 400 });
  let writerHas: number | null = null;
  if (isNative(a)) { const wi: any = await tryReq('account_info', { account: c.Account, ledger_index: 'validated' }); if (wi && wi.account_data) writerHas = Number(wi.account_data.Balance) / 1e6; }
  else if (wr) { const ln = (wr.lines || []).find((x: any) => x.currency === a.c && x.account === a.i); writerHas = ln ? Number(ln.balance) : (c.Account === a.i ? Infinity : 0); }
  if (writerHas != null && writerHas < amt - 1e-9) warns.push(`The writer currently holds about ${fmt(writerHas)} ${sym}, less than ${fmt(amt, 6)}. ${partial ? 'You will get what they can pay if it is at least your minimum.' : 'Cashing the full amount would fail. Use "Cash up to…".'}`);
  const ok = await PM.review({
    title: partial ? 'Cash a check (at least)' : 'Cash a check', tone: 'buy', hero: `<div style="font-size:1.5rem;font-weight:800">${partial ? 'At least ' : ''}${fmt(amt, 6)} ${esc(sym)}</div><div class="mut">from ${esc(ctx.show(c.Account))}</div>`,
    rows: [{ k: 'Check is for up to', v: `${fmt(max, 6)} ${esc(sym)}` }, { k: partial ? 'You receive' : 'You receive exactly', v: partial ? `${fmt(amt, 6)} up to ${fmt(max, 6)} ${esc(sym)}` : `${fmt(amt, 6)} ${esc(sym)}` }], warns, confirm: needLine ? 'Add trust line and cash' : 'Cash check',
  });
  if (!ok) return;
  const steps = needLine ? ['Adding trust line', 'Cashing the check'] : ['Signing and sending', 'Waiting for the ledger'];
  const pg = PM.progress('Cashing check', steps, 'buy'); pg.set(0, 'run');
  const send = async (tx: any) => { try { return await ctx.submit(tx); } catch (e: any) { return { ok: false, msg: String(e?.message || e) }; } };
  if (needLine) { const r = await send({ TransactionType: 'TrustSet', Account: acc, LimitAmount: { currency: a.c, issuer: a.i, value: String(Math.max(max * 1000, 1e9)) } }); if (!r.ok) return pg.fail(friendly(r.msg)); pg.set(0, 'ok'); pg.set(1, 'run'); }
  else pg.set(0, 'run');
  const tx: any = { TransactionType: 'CheckCash', Account: acc, CheckID: c.index }; if (partial) tx.DeliverMin = amtTx(a, amt); else tx.Amount = amtTx(a, amt);
  const r = await send(tx); if (!r.ok) return pg.fail(friendly(r.msg));
  pg.done(`Check cashed. The ${esc(sym)} is in your wallet.`); setTimeout(() => void load(true), 1500);
}
export async function cancel(id: string) {
  const acc = ctx.account(); const c = OBJS.find(x => x.index === id); if (!acc || !c) return ctx.toast('Check not found. Refresh and try again.', true);
  const mine = c.Account === acc, exp = expired(c);
  const ok = await PM.review({ title: mine ? 'Cancel your check' : exp ? 'Remove expired check' : 'Reject a check', tone: 'sell', hero: `<div style="font-size:1.4rem;font-weight:800">${amtText(c.SendMax)}</div><div class="mut">${mine ? 'to ' + esc(ctx.show(c.Destination)) : 'from ' + esc(ctx.show(c.Account))}</div>`, rows: [{ k: 'Effect', v: 'The check is deleted. Nobody can cash it.' }, { k: 'Money moved', v: 'None' }], confirm: mine ? 'Cancel check' : 'Remove check' });
  if (!ok) return;
  await runTx('Cancelling check', ['Signing and sending', 'Waiting for the ledger'], { TransactionType: 'CheckCancel', Account: acc, CheckID: c.index }, () => 'The check is cancelled and the reserve is released.');
}

export function view(v: 'checks' | 'payroll') { VIEW = v; const a = document.getElementById('ck_checks'), b = document.getElementById('pr_wrap'); if (a) a.style.display = v === 'checks' ? '' : 'none'; if (b) b.style.display = v === 'payroll' ? '' : 'none'; for (const k of ['checks', 'payroll']) { const e = document.getElementById('ckv_' + k); if (e) e.classList.toggle('pri', k === v); } if (v === 'payroll') Pr.mount(); }
export function mount() { if (!loaded) { /* first open */ } void load(true); }
export const api = { load, write, cash, cancel, f: setField, view };
