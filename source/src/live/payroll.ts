// Payroll book for the Checks page: a named payee list with live balances, several pay items per person (salary, bonus, expenses) each with its own
// amount and schedule, optional auto-pay, and proper bookkeeping: every check written is recorded, then reconciled against the ledger
// (open / cashed / cancelled / expired) with time-to-cash, totals per person and per month, and a CSV export.
// The book lives in this browser (per wallet and network). Auto-pay writes checks only while Starsky is open and unlocked: the key never leaves the device.
import * as xrpl from 'xrpl';
import { ctx } from './ctx.ts';
import { esc, hexName, isNative, akey, fromKey, NATIVE, amtTx, fmt, short, rippleToMs, dur, type Asset } from './util.ts';
import { tryReq } from './chain.ts';
import * as PM from './procmodal.ts';

const RIPPLE_EPOCH = 946684800, DAY = 864e5;
const LSF_DISALLOW_INCOMING_CHECK = 0x08000000;
export type Every = 'once' | 'weekly' | 'biweekly' | 'monthly' | 'days';
export interface Item { id: string; label: string; amount: number; asset: string; every: Every; days?: number; next: number; auto: boolean }
export interface Payee { id: string; name: string; addr: string; role: string; tag: string; paused: boolean; expDays: number; items: Item[] }
export type Status = 'open' | 'cashed' | 'cancelled' | 'expired' | 'failed';
export interface Entry { id: string; at: number; payee: string; name: string; addr: string; label: string; amount: number; asset: string; sym: string; hash: string; checkId: string; status: Status; auto: boolean; cashedAt?: number; delivered?: number; expiresAt?: number }
interface Book { v: 1; payees: Payee[]; runs: Entry[]; auto: { on: boolean; maxPerDay: number }; }
interface Opt { key: string; sym: string; asset: Asset; have: number }

let BOOK: Book = { v: 1, payees: [], runs: [], auto: { on: false, maxPerDay: 10 } };
let BAL: Record<string, { at: number; v: number | null }> = {};
let OPTS: Opt[] = [];
let curKey = '', timer: any = 0, running = false, view: 'all' | string = 'all';
const uid = () => Math.random().toString(36).slice(2, 10);
const keyOf = () => `starsky.payroll.${ctx.netKey()}.${ctx.xrpl() ? 'x' : 'l'}.${ctx.account() || ''}`;
const nativeName = () => ctx.native();
const symOf = (k: string) => { if (k === 'native') return nativeName(); const a = fromKey(k); return hexName(a.c); };
const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const hexOf = (s: string) => Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const nowRipple = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;
const dstr = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const when = (ms: number) => new Date(ms).toLocaleString();

function loadBook() {
  const k = keyOf(); if (k === curKey) return; curKey = k; BAL = {};
  try { const r = JSON.parse(localStorage.getItem(k) || 'null'); BOOK = r && r.v === 1 ? { ...{ auto: { on: false, maxPerDay: 10 } }, ...r } : { v: 1, payees: [], runs: [], auto: { on: false, maxPerDay: 10 } }; } catch { BOOK = { v: 1, payees: [], runs: [], auto: { on: false, maxPerDay: 10 } }; }
}
const save = () => { try { localStorage.setItem(curKey, JSON.stringify(BOOK)); } catch { /* storage full or blocked: the book stays in memory */ } };

/** next due date after `from`, never in the past (a missed run is paid once, not many times) */
export function advance(it: Pick<Item, 'every' | 'days' | 'next'>, now = Date.now()): number {
  if (it.every === 'once') return 0;
  const step = (t: number) => { if (it.every === 'weekly') return t + 7 * DAY; if (it.every === 'biweekly') return t + 14 * DAY; if (it.every === 'days') return t + Math.max(1, it.days || 30) * DAY; const d = new Date(t); d.setMonth(d.getMonth() + 1); return d.getTime(); };
  let n = it.next || now, guard = 0; do { n = step(n); } while (n <= now && ++guard < 800); return n;
}
const everyText = (it: Item) => it.every === 'once' ? 'one time' : it.every === 'days' ? `every ${it.days || 30} days` : it.every;

export function shell() {
  return `<div id="pr_root" class="grid" style="width:100%">
  <div class="card c12"><div class="row" style="align-items:center;gap:.6rem;flex-wrap:wrap"><div class="k">Payroll</div><span class="grow"></span>
    <button class="sm" onclick="window.pr.edit('')">Add payee</button><button class="sm" onclick="window.pr.payDue()">Pay everything due</button><button class="sm" onclick="window.pr.csv()">Export CSV</button><button class="sm" onclick="window.pr.refresh()">Refresh</button></div>
    <div class="mut" style="font-size:.86rem;margin-top:.4rem;line-height:1.5">Keep a book of the people and companies you pay. Each person can have several pay items (salary, bonus, expenses), each with its own amount and schedule. Paying writes a real check on the ledger. The ledger below follows every check until it is cashed, cancelled or expires.</div>
    <div id="pr_auto" style="margin-top:.5rem"></div></div>
  <div id="pr_sum" class="c12"></div>
  <div class="card c12"><div class="k">Payee book</div><div id="pr_book" style="margin-top:.5rem"><div class="mut">Loading…</div></div></div>
  <div class="card c12"><div class="row" style="align-items:center;gap:.6rem"><div class="k">Payroll ledger</div><span class="grow"></span><select id="pr_f" onchange="window.pr.filter(this.value)"></select></div><div id="pr_led" style="margin-top:.5rem"></div></div>
  <div class="card c12"><div class="k">By month</div><div id="pr_mon" style="margin-top:.5rem"></div></div></div>`;
}

export function setOpts(o: Opt[]) { OPTS = o; }

// ---------- balances ----------
async function balanceOf(addr: string, assetKey: string): Promise<number | null> {
  const ck = addr + '|' + assetKey, hit = BAL[ck]; if (hit && Date.now() - hit.at < 30000) return hit.v;
  let v: number | null = null;
  if (assetKey === 'native') { const r: any = await tryReq('account_info', { account: addr, ledger_index: 'validated' }); v = r && r.account_data ? Number(r.account_data.Balance) / 1e6 : null; }
  else { const a = fromKey(assetKey), r: any = await tryReq('account_lines', { account: addr, peer: a.i, ledger_index: 'validated' }); const l = ((r && r.lines) || []).find((x: any) => x.currency === a.c); v = r ? (l ? Number(l.balance) : 0) : null; }
  BAL[ck] = { at: Date.now(), v }; return v;
}

// ---------- reconcile the ledger with what is on the chain ----------
export function reconcile(openIds: Set<string>, openExp: Record<string, number>, hist: any[]) {
  loadBook(); let changed = false;
  const cash = new Map<string, { at: number; amt: number | null }>(), canc = new Map<string, number>();
  for (const h of hist) { const t = h.tx; if (h.res !== 'tesSUCCESS' || !t.CheckID) continue; const at = t.date != null ? rippleToMs(t.date) : Date.now(); if (t.TransactionType === 'CheckCash') { const d = h.delivered; cash.set(t.CheckID, { at, amt: d == null ? null : typeof d === 'string' ? Number(d) / 1e6 : Number(d.value) }); } else if (t.TransactionType === 'CheckCancel') canc.set(t.CheckID, at); }
  for (const e of BOOK.runs) {
    if (e.status !== 'open' || !e.checkId) continue;
    const c = cash.get(e.checkId), x = canc.get(e.checkId);
    if (c) { e.status = 'cashed'; e.cashedAt = c.at; if (c.amt != null) e.delivered = c.amt; changed = true; }
    else if (x) { e.status = 'cancelled'; changed = true; }
    else if (!openIds.has(e.checkId)) { e.status = 'expired'; changed = true; }
    else if (openExp[e.checkId] && openExp[e.checkId] <= nowRipple()) { e.status = 'expired'; changed = true; }
  }
  if (changed) save();
}

// ---------- paying ----------
async function problem(p: Payee, it: Item): Promise<string> {
  const acc = ctx.account(); if (!acc) return 'Unlock a wallet first.';
  if (!xrpl.isValidClassicAddress(p.addr)) return 'The address is not valid.'; if (p.addr === acc) return 'You cannot pay your own wallet.';
  if (!(it.amount > 0)) return 'The amount must be above zero.';
  const ai: any = await tryReq('account_info', { account: p.addr, ledger_index: 'validated' });
  if (ai && ai.account_data && (Number(ai.account_data.Flags || 0) & LSF_DISALLOW_INCOMING_CHECK) !== 0) return 'That account has switched off incoming checks.';
  return '';
}
async function findCheckId(hash: string): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const r: any = await tryReq('tx', { transaction: hash });
    if (r && (r.validated !== false)) {
      const meta = r.meta || r.metaData;
      for (const n of (meta && meta.AffectedNodes) || []) { const c = n.CreatedNode; if (c && c.LedgerEntryType === 'Check') return c.LedgerIndex; }
      const acc = r.Account || (r.tx_json && r.tx_json.Account), seq = r.Sequence != null ? r.Sequence : r.tx_json && r.tx_json.Sequence;
      if (acc && seq != null) { const o: any = await tryReq('account_objects', { account: acc, type: 'check', ledger_index: 'validated', limit: 400 }); const f = ((o && o.account_objects) || []).find((x: any) => x.Account === acc && Number(x.Sequence) === Number(seq)); if (f) return f.index; }
      if (meta) return '';
    }
    await new Promise(res => setTimeout(res, 1200));
  }
  return '';
}
async function pay(p: Payee, it: Item, auto: boolean): Promise<boolean> {
  const acc = ctx.account()!; const bad = await problem(p, it); if (bad) { ctx.toast(`${p.name}: ${bad}`, true); return false; }
  const a = it.asset === 'native' ? NATIVE : fromKey(it.asset); let SendMax: any; try { SendMax = amtTx(a, it.amount); } catch (e: any) { ctx.toast(e.message, true); return false; }
  const tx: any = { TransactionType: 'CheckCreate', Account: acc, Destination: p.addr, SendMax, Memos: [{ Memo: { MemoType: hexOf('text/plain'), MemoData: hexOf(`Payroll: ${it.label || 'Payment'} for ${p.name}`) } }] };
  const exp = Math.max(1, p.expDays || 14) * 86400; tx.Expiration = nowRipple() + exp; if (p.tag.trim() && /^\d+$/.test(p.tag.trim())) tx.DestinationTag = Number(p.tag.trim());
  let r: { ok: boolean; msg?: string; hash?: string }; try { r = await ctx.submit(tx); } catch (e: any) { r = { ok: false, msg: String(e?.message || e) }; }
  if (!r.ok) { ctx.toast(`${p.name}: ${r.msg || 'the network refused the check'}`, true); return false; }
  const checkId = r.hash ? await findCheckId(r.hash) : '';
  BOOK.runs.unshift({ id: uid(), at: Date.now(), payee: p.id, name: p.name, addr: p.addr, label: it.label || 'Payment', amount: it.amount, asset: it.asset, sym: symOf(it.asset), hash: r.hash || '', checkId, status: 'open', auto, expiresAt: Date.now() + exp * 1000 });
  it.next = advance(it); if (it.every === 'once') { it.auto = false; it.next = 0; } save(); return true;
}
const dueItems = (now = Date.now()) => BOOK.payees.filter(p => !p.paused).flatMap(p => p.items.filter(i => i.every !== 'once' || i.next > 0).filter(i => i.next > 0 && i.next <= now).map(i => ({ p, i })));

export async function payNow(pid: string, iid: string) {
  const p = BOOK.payees.find(x => x.id === pid), it = p && p.items.find(x => x.id === iid); if (!p || !it) return;
  const ok = await PM.review({ title: 'Pay with a check', tone: 'tip', hero: `<div style="font-size:1.4rem;font-weight:800">${fmt(it.amount, 6)} ${esc(symOf(it.asset))}</div><div class="mut">${esc(p.name)} · ${esc(it.label || 'Payment')}</div>`, rows: [{ k: 'To', v: `<span class="mono">${esc(short(ctx.show(p.addr), 8, 6))}</span>` }, { k: 'Check expires in', v: `${p.expDays || 14} days` }, { k: 'Money moves', v: 'When they cash it' }], confirm: 'Write check' });
  if (!ok) return; if (await pay(p, it, false)) { ctx.toast(`Check written for ${p.name}`); await refresh(); }
}
export async function payDue() {
  const due = dueItems(); if (!due.length) return ctx.toast('Nothing is due right now.');
  const ok = await PM.review({ title: 'Pay everything due', tone: 'tip', hero: `<div style="font-size:1.2rem;font-weight:800">${due.length} check${due.length > 1 ? 's' : ''} to write</div>`, rows: due.slice(0, 12).map(d => ({ k: `${esc(d.p.name)} · ${esc(d.i.label)}`, v: `${fmt(d.i.amount, 6)} ${esc(symOf(d.i.asset))}` })), confirm: 'Write all checks' });
  if (!ok) return; let n = 0; for (const d of due) if (await pay(d.p, d.i, false)) n++; ctx.toast(`${n} of ${due.length} checks written`, n < due.length); await refresh();
}
async function autoTick() {
  loadBook(); if (running || !BOOK.auto.on || !ctx.account() || !ctx.online()) return; running = true;
  try { const today = BOOK.runs.filter(r => r.auto && Date.now() - r.at < DAY).length; let left = Math.max(0, (BOOK.auto.maxPerDay || 10) - today);
    for (const d of dueItems()) { if (left <= 0) break; if (!d.i.auto) continue; if (await pay(d.p, d.i, true)) { left--; ctx.toast(`Auto-pay: check written for ${d.p.name} (${fmt(d.i.amount, 6)} ${symOf(d.i.asset)})`); } else d.i.auto = false, save(); }
  } finally { running = false; paint(); }
}
export function setAuto(on: boolean) {
  if (on && !window.confirm('Auto-pay writes checks without asking each time, whenever a pay item marked Auto is due and Starsky is open and unlocked. Each check is capped by the amount you set and the per-day limit. Turn it on?')) { paint(); return; }
  BOOK.auto.on = on; save(); paint(); if (on) void autoTick();
}
export function setMax(v: string) { const n = Math.floor(Number(v)); BOOK.auto.maxPerDay = n > 0 && n <= 200 ? n : 10; save(); }

// ---------- editing ----------
const EV: [Every, string][] = [['once', 'One time'], ['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Monthly'], ['days', 'Every N days']];
export function edit(pid: string) {
  const p = BOOK.payees.find(x => x.id === pid) || { id: '', name: '', addr: '', role: '', tag: '', paused: false, expDays: 14, items: [] as Item[] };
  const opts = OPTS.length ? OPTS : [{ key: 'native', sym: nativeName(), asset: NATIVE, have: 0 }];
  const rows = Array.from({ length: 4 }, (_, i) => p.items[i] || { id: '', label: i === 0 ? 'Salary' : '', amount: 0, asset: 'native', every: 'monthly' as Every, days: 30, next: Date.now() + 30 * DAY, auto: false });
  ctx.modal(`<div class="pm" style="--pm:#a78bfa;min-width:min(720px,92vw)"><div class="pm-h"><span class="pm-dot"></span>${pid ? 'Edit payee' : 'Add payee'}</div>
  <div class="fgrid"><input id="pe_name" placeholder="Name (person or company)" value="${esc(p.name)}"><input id="pe_addr" placeholder="Wallet address" value="${esc(p.addr ? ctx.show(p.addr) : '')}" autocomplete="off" spellcheck="false"><input id="pe_role" placeholder="Role or note (optional)" value="${esc(p.role)}"><input id="pe_tag" placeholder="Destination tag (optional)" value="${esc(p.tag)}" inputmode="numeric"><input id="pe_exp" placeholder="Days before each check expires" value="${p.expDays || 14}" inputmode="numeric"></div>
  <div class="k" style="margin-top:.7rem">Pay items (leave the amount empty to skip a row)</div>
  ${rows.map((r, i) => `<div class="row" style="gap:.35rem;flex-wrap:wrap;margin-top:.35rem;align-items:center"><input id="pi_l${i}" style="width:7.5rem" placeholder="Label" value="${esc(r.label)}"><input id="pi_a${i}" style="width:6.5rem" placeholder="Amount" inputmode="decimal" value="${r.amount || ''}"><select id="pi_s${i}">${opts.map(o => `<option value="${esc(o.key)}" ${o.key === r.asset ? 'selected' : ''}>${esc(o.sym)}</option>`).join('')}</select><select id="pi_e${i}">${EV.map(e => `<option value="${e[0]}" ${e[0] === r.every ? 'selected' : ''}>${e[1]}</option>`).join('')}</select><input id="pi_d${i}" style="width:4rem" placeholder="N days" value="${r.days || ''}" inputmode="numeric"><input id="pi_n${i}" type="date" value="${r.next ? dstr(r.next) : ''}"><label class="mut" style="font-size:.82rem"><input id="pi_u${i}" type="checkbox" ${r.auto ? 'checked' : ''}> Auto</label></div>`).join('')}
  <label class="mut" style="display:block;margin-top:.6rem;font-size:.86rem"><input id="pe_pause" type="checkbox" ${p.paused ? 'checked' : ''}> Pause this payee (no auto-pay, not in "Pay everything due")</label>
  <div class="pm-btns" style="margin-top:.8rem"><button class="grow" onclick="window.closeModal()">Cancel</button><button class="pri grow" onclick="window.pr.save('${esc(pid)}')">Save payee</button></div></div>`);
}
export function saveP(pid: string) {
  const name = ($('pe_name')!.value || '').trim(); let raw = ($('pe_addr')!.value || '').trim(); let addr = ''; try { addr = ctx.toClassic(raw); } catch { addr = raw; }
  if (!name) return ctx.toast('Enter a name', true); if (!xrpl.isValidClassicAddress(addr)) return ctx.toast('That is not a valid wallet address', true);
  const dup = BOOK.payees.find(x => x.addr === addr && x.id !== pid); if (dup) return ctx.toast(`${dup.name} already uses that address`, true);
  const tag = ($('pe_tag')!.value || '').trim(); if (tag && !/^\d{1,10}$/.test(tag)) return ctx.toast('Destination tag must be a number', true);
  const prev = BOOK.payees.find(x => x.id === pid), items: Item[] = [];
  for (let i = 0; i < 4; i++) {
    const amt = Number($('pi_a' + i)!.value); if (!(amt > 0)) continue; const every = $('pi_e' + i)!.value as Every, n = $('pi_n' + i)!.value, days = Math.max(1, Math.floor(Number($('pi_d' + i)!.value) || 30));
    const old = prev && prev.items[i]; items.push({ id: old ? old.id : uid(), label: ($('pi_l' + i)!.value || '').trim() || 'Payment', amount: amt, asset: $('pi_s' + i)!.value, every, days, next: n ? new Date(n + 'T09:00:00').getTime() : Date.now(), auto: $('pi_u' + i)!.checked });
  }
  const o: Payee = { id: pid || uid(), name, addr, role: ($('pe_role')!.value || '').trim(), tag, paused: $('pe_pause')!.checked, expDays: Math.max(1, Math.min(365, Math.floor(Number($('pe_exp')!.value) || 14))), items };
  if (prev) Object.assign(prev, o); else BOOK.payees.push(o); save(); ctx.closeModal(); paint(); void balances();
}
export function remove(pid: string) { const p = BOOK.payees.find(x => x.id === pid); if (!p || !window.confirm(`Remove ${p.name} from the payee book? Their payment history stays in the ledger.`)) return; BOOK.payees = BOOK.payees.filter(x => x.id !== pid); save(); paint(); }
export function filter(v: string) { view = v; paint(); }

// ---------- painting ----------
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
function totals(runs: Entry[]) {
  const by = (st: Status) => runs.filter(r => r.status === st), cashed = by('cashed'), lat = cashed.filter(r => r.cashedAt).map(r => (r.cashedAt! - r.at) / 1000);
  const money = (rs: Entry[]) => { const m: Record<string, number> = {}; for (const r of rs) m[r.sym] = (m[r.sym] || 0) + (r.status === 'cashed' && r.delivered != null ? r.delivered : r.amount); return Object.entries(m).map(([s, v]) => `${fmt(v, 4)} ${esc(s)}`).join(' · ') || '0'; };
  return { written: money(runs.filter(r => r.status !== 'failed')), cashed: money(cashed), open: money(by('open')), cancelled: by('cancelled').length + by('expired').length, avg: lat.length ? dur(sum(lat) / lat.length) : '–', fast: lat.length ? dur(Math.min(...lat)) : '–', slow: lat.length ? dur(Math.max(...lat)) : '–', n: runs.length, nc: cashed.length };
}
function paint() {
  loadBook(); if (!document.getElementById('pr_root')) return;
  const set = (id: string, h: string) => { const e = document.getElementById(id); if (e) e.innerHTML = h; };
  set('pr_auto', `<div class="row" style="gap:.6rem;align-items:center;flex-wrap:wrap"><label><input type="checkbox" ${BOOK.auto.on ? 'checked' : ''} onchange="window.pr.auto(this.checked)"> <b>Auto-pay</b></label><span class="mut" style="font-size:.84rem">Writes checks for items marked Auto when they are due, while Starsky is open and unlocked. Up to</span><input style="width:3.4rem" value="${BOOK.auto.maxPerDay}" onchange="window.pr.max(this.value)" inputmode="numeric"><span class="mut" style="font-size:.84rem">auto checks a day. ${BOOK.auto.on ? '<b class="up">On</b>' : 'Off'}</span></div>`);
  const T = totals(BOOK.runs), due = dueItems().length;
  const tile = (k: string, v: string, s = '') => `<div class="card" style="flex:1;min-width:11rem"><div class="mut" style="font-size:.78rem">${k}</div><div style="font-size:1.15rem;font-weight:800;margin-top:.15rem">${v}</div><div class="mut" style="font-size:.76rem">${s}</div></div>`;
  set('pr_sum', `<div class="row" style="gap:.6rem;flex-wrap:wrap">${tile('Written', T.written, T.n + ' checks')}${tile('Cashed', T.cashed, T.nc + ' checks')}${tile('Outstanding', T.open, 'not cashed yet')}${tile('Cancelled or expired', String(T.cancelled), 'never paid out')}${tile('Time to cash', T.avg, 'fastest ' + T.fast + ' · slowest ' + T.slow)}${tile('Due now', String(due), due ? 'press Pay everything due' : 'nothing due')}</div>`);
  if (!BOOK.payees.length) set('pr_book', '<div class="mut">No payees yet. Press <b>Add payee</b>, then give each person one or more pay items with their amount and schedule.</div>');
  else set('pr_book', `<div style="overflow:auto"><table style="width:100%;font-size:.86rem"><tr class="mut" style="text-align:left"><th>Name</th><th>Wallet</th><th>Their balance</th><th>Pay items</th><th>Paid</th><th>Outstanding</th><th></th></tr>${BOOK.payees.map(p => {
    const rs = BOOK.runs.filter(r => r.payee === p.id), paid = totals(rs.filter(r => r.status === 'cashed')).cashed, out = totals(rs.filter(r => r.status === 'open')).open, a0 = p.items[0] && p.items[0].asset || 'native', b = BAL[p.addr + '|' + a0];
    return `<tr style="border-top:1px solid rgba(255,255,255,.07);vertical-align:top${p.paused ? ';opacity:.55' : ''}"><td><b>${esc(p.name)}</b>${p.paused ? ' <span class="mut">(paused)</span>' : ''}<div class="mut" style="font-size:.76rem">${esc(p.role)}</div></td><td class="mono" title="${esc(ctx.show(p.addr))}">${esc(short(ctx.show(p.addr), 7, 5))}</td><td>${b ? (b.v == null ? '<span class="mut">not on network</span>' : fmt(b.v, 4) + ' ' + esc(symOf(a0))) : '…'}</td>
      <td>${p.items.length ? p.items.map(i => `<div style="margin-bottom:.25rem"><b>${esc(i.label)}</b> ${fmt(i.amount, 6)} ${esc(symOf(i.asset))} <span class="mut">${esc(everyText(i))}${i.next ? ' · next ' + esc(dstr(i.next)) : ''}</span>${i.auto ? ' <span class="up">auto</span>' : ''} <button class="sm" onclick="window.pr.pay('${esc(p.id)}','${esc(i.id)}')">Pay now</button></div>`).join('') : '<span class="mut">no pay items</span>'}</td><td>${paid}</td><td>${out}</td><td><button class="sm" onclick="window.pr.edit('${esc(p.id)}')">Edit</button> <button class="sm" onclick="window.pr.del('${esc(p.id)}')">Remove</button></td></tr>`;
  }).join('')}</table></div>`);
  const f = $('pr_f') as any; if (f) { const names = [...new Map(BOOK.runs.map(r => [r.payee, r.name])).entries()]; f.innerHTML = `<option value="all">All payees</option>` + names.map(([id, n]) => `<option value="${esc(id)}" ${view === id ? 'selected' : ''}>${esc(n)}</option>`).join(''); }
  const L = BOOK.runs.filter(r => view === 'all' || r.payee === view); const stc: Record<string, string> = { open: '#fbbf24', cashed: '#4ade80', cancelled: '#9ca3af', expired: '#f87171', failed: '#f87171' };
  set('pr_led', L.length ? `<div style="overflow:auto;max-height:26rem"><table style="width:100%;font-size:.84rem"><tr class="mut" style="text-align:left"><th>Written</th><th>Payee</th><th>Item</th><th>Amount</th><th>Status</th><th>Cashed</th><th>Time to cash</th><th>Check</th></tr>${L.map(r => `<tr style="border-top:1px solid rgba(255,255,255,.06)"><td>${esc(when(r.at))}${r.auto ? ' <span class="mut">auto</span>' : ''}</td><td>${esc(r.name)}</td><td>${esc(r.label)}</td><td>${fmt(r.status === 'cashed' && r.delivered != null ? r.delivered : r.amount, 6)} ${esc(r.sym)}</td><td style="color:${stc[r.status]}">${r.status}</td><td>${r.cashedAt ? esc(when(r.cashedAt)) : ''}</td><td>${r.cashedAt ? esc(dur((r.cashedAt - r.at) / 1000)) : r.status === 'open' && r.expiresAt ? 'expires ' + esc(when(r.expiresAt)) : ''}</td><td class="mono">${esc(short(r.checkId || r.hash, 6, 4))}</td></tr>`).join('')}</table></div>` : '<div class="mut">No checks written from the payroll yet.</div>');
  const mon: Record<string, { n: number; m: Record<string, number>; c: Record<string, number> }> = {};
  for (const r of BOOK.runs) { const k = dstr(r.at).slice(0, 7), o = mon[k] = mon[k] || { n: 0, m: {}, c: {} }; o.n++; o.m[r.sym] = (o.m[r.sym] || 0) + r.amount; if (r.status === 'cashed') o.c[r.sym] = (o.c[r.sym] || 0) + (r.delivered ?? r.amount); }
  const ms = Object.keys(mon).sort().reverse(), fm = (o: Record<string, number>) => Object.entries(o).map(([s, v]) => `${fmt(v, 4)} ${esc(s)}`).join(' · ') || '0';
  set('pr_mon', ms.length ? `<table style="width:100%;font-size:.86rem"><tr class="mut" style="text-align:left"><th>Month</th><th>Checks</th><th>Written</th><th>Cashed</th></tr>${ms.map(k => `<tr style="border-top:1px solid rgba(255,255,255,.06)"><td>${k}</td><td>${mon[k].n}</td><td>${fm(mon[k].m)}</td><td>${fm(mon[k].c)}</td></tr>`).join('')}</table>` : '<div class="mut">Nothing yet.</div>');
}
async function balances() { loadBook(); await Promise.all(BOOK.payees.map(p => balanceOf(p.addr, (p.items[0] && p.items[0].asset) || 'native'))); paint(); }
export async function refresh() { loadBook(); paint(); await balances(); }
export function mount() { loadBook(); paint(); void balances(); if (!timer) timer = setInterval(() => { void autoTick(); }, 30000); }
export function csv() {
  const head = ['Written', 'Payee', 'Wallet', 'Item', 'Amount', 'Asset', 'Status', 'Cashed at', 'Delivered', 'Seconds to cash', 'Check ID', 'Transaction', 'Auto'];
  const q = (x: any) => '"' + String(x ?? '').replace(/"/g, '""') + '"';
  const rows = BOOK.runs.map(r => [new Date(r.at).toISOString(), r.name, ctx.show(r.addr), r.label, r.amount, r.sym, r.status, r.cashedAt ? new Date(r.cashedAt).toISOString() : '', r.delivered ?? '', r.cashedAt ? Math.round((r.cashedAt - r.at) / 1000) : '', r.checkId, r.hash, r.auto ? 'yes' : 'no']);
  const blob = new Blob([[head, ...rows].map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' }), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'payroll-' + dstr(Date.now()) + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export const api = { edit, save: saveP, del: remove, pay: payNow, payDue, auto: setAuto, max: setMax, filter, csv, refresh };
export const dueCount = () => dueItems().length;
