// Starsky toolbox (round 5): 17 tools. Everything that decides something is a pure, exported function so it is tested without a browser.
// Local only: nothing here sends data anywhere. The card shows on Settings, a small strip on Portfolio, and two helpers on Send.
import { ctx } from './ctx.ts';
import { esc, hexName } from './util.ts';
import * as LA from '../lumaAddr.ts';
const okAddr = (a: string) => { try { LA.normalize(a); return true; } catch { return false; } };

const LS = (k: string, d: any) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const SV = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const num = (n: number, d = 2) => Number(n).toLocaleString('en', { maximumFractionDigits: d });

// 1. Send max ------------------------------------------------------------------------------------------------------
/** the most that can be sent in the native coin: balance minus reserve minus fee, never negative, rounded down to 6 places */
export function sendMax(balance: number, base: number, inc: number, owners: number, fee = 0.00001): number {
  return Math.floor(Math.max(0, balance - (base + inc * owners) - fee) * 1e6) / 1e6;
}
// 2. Fee ------------------------------------------------------------------------------------------------------------
/** what a normal transaction costs now, in the native coin, from server_info (load_factor scales the base fee) */
export function feeNow(info: any): { fee: number; busy: 'quiet' | 'normal' | 'busy'; factor: number } {
  const v = info?.validated_ledger || {}, base = Number(v.base_fee_xrp ?? 0.00001), f = Number(info?.load_factor ?? 1) || 1;
  return { fee: +(base * f).toFixed(8), factor: f, busy: f >= 8 ? 'busy' : f > 1.5 ? 'normal' : 'quiet' };
}
// 3. Notes on transactions ------------------------------------------------------------------------------------------
const NK = 'starsky.x.notes';
export const notes = (): Record<string, string> => LS(NK, {});
export function setNote(hash: string, text: string): string {
  hash = hash.trim().toUpperCase(); if (!/^[0-9A-F]{64}$/.test(hash)) return 'A transaction hash is 64 letters and digits.';
  const n = notes(); if (!text.trim()) delete n[hash]; else n[hash] = text.trim().slice(0, 200); SV(NK, n); return '';
}
export const findNotes = (q: string): Array<[string, string]> => Object.entries(notes()).filter(([h, t]) => !q || h.includes(q.toUpperCase()) || t.toLowerCase().includes(q.toLowerCase()));
// 4. Contacts import and export -------------------------------------------------------------------------------------
export function contactsToCsv(rows: Array<{ name: string; addr: string }>): string { return 'name,address\n' + rows.map(r => [r.name, r.addr].map(c => /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c).join(',')).join('\n'); }
export function csvToContacts(csv: string, valid: (a: string) => boolean): { ok: Array<{ name: string; addr: string }>; bad: string[] } {
  const ok: Array<{ name: string; addr: string }> = [], bad: string[] = [], seen = new Set<string>();
  for (const [i, line] of csv.split(/\r?\n/).entries()) {
    if (!line.trim() || (i === 0 && /^name\s*,/i.test(line))) continue;
    const m = /^(?:"((?:[^"]|"")*)"|([^,]*)),\s*(.+)$/.exec(line); if (!m) { bad.push(`line ${i + 1}: not name,address`); continue; }
    const name = (m[1] != null ? m[1].replace(/""/g, '"') : m[2]).trim(), addr = m[3].trim().replace(/^"|"$/g, '');
    if (!name) { bad.push(`line ${i + 1}: no name`); continue; } if (!valid(addr)) { bad.push(`line ${i + 1}: "${addr.slice(0, 12)}…" is not a valid address`); continue; } if (seen.has(addr)) { bad.push(`line ${i + 1}: duplicate address`); continue; }
    seen.add(addr); ok.push({ name: name.slice(0, 40), addr });
  } return { ok, bad };
}
// 5. Encrypted backup of your settings -------------------------------------------------------------------------------
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u)), unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function kdf(pass: string, salt: Uint8Array, iter: number) { const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']); return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as any, iterations: iter, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
export async function encryptBackup(obj: any, pass: string, iter = 250000): Promise<string> {
  if (pass.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), k = await kdf(pass, salt, iter);
  return JSON.stringify({ starsky: 'settings-backup', v: 1, iter, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(obj))))) });
}
export async function decryptBackup(file: string, pass: string): Promise<any> {
  let j: any; try { j = JSON.parse(file); } catch { throw new Error('That is not a Starsky backup file.'); } if (j?.starsky !== 'settings-backup') throw new Error('That is not a Starsky backup file.');
  try { const k = await kdf(pass, unb64(j.salt) as any, j.iter); return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(j.iv) as any }, k, unb64(j.ct) as any))); } catch { throw new Error('Wrong passphrase, or the file is damaged.'); }
}
/** only our own settings are ever backed up or restored: never the vault, never keys */
export const BACKUP_KEYS = (keys: string[]) => keys.filter(k => k.startsWith('starsky.x.') && !/vault|seed/i.test(k));
// 6. Allocation -----------------------------------------------------------------------------------------------------
export function allocation(items: Array<{ name: string; value: number }>): Array<{ name: string; value: number; pct: number }> {
  const t = items.reduce((s, i) => s + Math.max(0, i.value), 0); if (t <= 0) return [];
  return items.filter(i => i.value > 0).sort((a, b) => b.value - a.value).map(i => ({ ...i, pct: +(i.value / t * 100).toFixed(1) }));
}
// 7 + 8. Reserve you can get back, and dust -----------------------------------------------------------------------
export interface Line { currency: string; account: string; balance: string; limit: string; limit_peer?: string; no_ripple?: boolean }
/** trust lines holding nothing and where the other side has no limit for us: removing them frees the owner reserve */
export function reclaimable(lines: Line[]): Line[] { return lines.filter(l => Number(l.balance) === 0 && Number(l.limit_peer || 0) === 0); }
export function dust(lines: Line[], threshold = 0.001): Line[] { return lines.filter(l => { const b = Number(l.balance); return b > 0 && b < threshold; }); }
// 9. Recurring payment reminders (never pays by itself) -------------------------------------------------------------
export interface Reminder { id: string; label: string; to: string; amount: string; cur: string; every: 'week' | 'month'; day: number; last: number }
export function nextDue(r: Reminder, now = Date.now()): number {
  const d = new Date(now); d.setHours(9, 0, 0, 0);
  if (r.every === 'week') { const diff = (r.day - d.getDay() + 7) % 7; d.setDate(d.getDate() + diff); if (d.getTime() <= r.last) d.setDate(d.getDate() + 7); while (d.getTime() <= r.last) d.setDate(d.getDate() + 7); return d.getTime() < r.last ? d.getTime() + 7 * 864e5 : d.getTime(); }
  const mk = (y: number, m: number) => new Date(y, m, Math.min(r.day, new Date(y, m + 1, 0).getDate()), 9).getTime(); let t = mk(d.getFullYear(), d.getMonth()); if (t <= r.last) t = mk(d.getFullYear(), d.getMonth() + 1); return t;
}
export const isDue = (r: Reminder, now = Date.now()) => nextDue(r, r.last ? r.last : now - 40 * 864e5) <= now;
const RK = 'starsky.x.reminders';
export const reminders = (): Reminder[] => LS(RK, []);
// 10. Extra confirmation for large sends ------------------------------------------------------------------------------
/** returns the last 4 characters the person must type before a large payment goes out, or '' when none is needed */
export function confirmWord(amount: number, balance: number, threshold: number, dest: string): string { if (!(amount > 0)) return ''; const big = (threshold > 0 && amount >= threshold) || (balance > 0 && amount >= balance * 0.5); return big ? dest.slice(-4) : ''; }
// 11. Digest ------------------------------------------------------------------------------------------------------
export interface Tx { t: number; dir: 'in' | 'out'; amount: number; peer: string; cur: string }
export function digest(txs: Tx[], days: number, now = Date.now()) {
  const since = now - days * 864e5, r = txs.filter(x => x.t >= since && x.cur === 'native'); const sum = (d: 'in' | 'out') => r.filter(x => x.dir === d).reduce((s, x) => s + x.amount, 0);
  const by: Record<string, number> = {}; for (const x of r) by[x.peer] = (by[x.peer] || 0) + x.amount;
  return { received: sum('in'), sent: sum('out'), net: sum('in') - sum('out'), count: r.length, top: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 3) };
}
// 12. Yearly export ----------------------------------------------------------------------------------------------
export function yearRows(txs: Tx[], year: number): string[][] { return [['date', 'direction', 'amount', 'currency', 'counterparty'], ...txs.filter(x => new Date(x.t).getFullYear() === year).sort((a, b) => a.t - b.t).map(x => [new Date(x.t).toISOString().slice(0, 10), x.dir, String(x.amount), x.cur === 'native' ? ctx.native() : x.cur, x.peer])]; }
// 13. Wallet health score -----------------------------------------------------------------------------------------
export function healthScore(i: { backedUpDays: number | null; lockMin: number; hasPassword: boolean; unusedLines: number; funded: boolean; watchOnlyKeys?: boolean }): { score: number; todo: string[] } {
  const todo: string[] = []; let s = 100;
  if (i.backedUpDays == null) { s -= 30; todo.push('Back up your recovery phrase: you have never confirmed a backup.'); } else if (i.backedUpDays > 180) { s -= 10; todo.push('Your last backup is more than 6 months old. Confirm it still works.'); }
  if (!i.lockMin) { s -= 20; todo.push('Turn on auto-lock so the wallet closes itself when you walk away.'); } else if (i.lockMin > 30) { s -= 5; todo.push('Auto-lock is above 30 minutes. A shorter time is safer.'); }
  if (!i.hasPassword) { s -= 30; todo.push('Set a wallet password.'); }
  if (i.unusedLines > 0) { s -= Math.min(10, i.unusedLines * 2); todo.push(`${i.unusedLines} empty token line(s) lock reserve. Remove them in the tools below.`); }
  if (!i.funded) { s -= 5; todo.push('This wallet has no funds yet.'); }
  return { score: Math.max(0, s), todo };
}
// 14. Address checker --------------------------------------------------------------------------------------------
export function checkAddress(a: string, toClassic: (x: string) => string, showL: (x: string) => string, prefix: string): { ok: boolean; msg: string; classic?: string; display?: string } {
  a = a.trim(); if (!a) return { ok: false, msg: 'Paste an address.' };
  try { const c = toClassic(a), d = showL(c); const wrong = /^[LT]/.test(a) && !a.startsWith(prefix); return wrong ? { ok: false, msg: `This is a valid address, but for the other network (${prefix} is this one's prefix). Sending here would go nowhere useful.`, classic: c, display: d } : { ok: true, msg: 'Valid address.', classic: c, display: d }; }
  catch (e: any) { return { ok: false, msg: /Mainnet|Testnet/.test(String(e?.message)) ? String(e.message) : 'Not a valid address: a character is wrong or missing. Do not send to it.' }; }
}
// 15. Plain-language transaction explainer -------------------------------------------------------------------------
export function explainTx(tx: any, me: string, native: string): string {
  const t = tx?.TransactionType, amt = (a: any) => a == null ? '' : typeof a === 'string' ? `${num(Number(a) / 1e6, 6)} ${native}` : `${a.value} ${hexName(a.currency)}`;
  const who = (a: string) => a === me ? 'you' : a?.slice(0, 6) + '…' + a?.slice(-4);
  switch (t) {
    case 'Payment': return `${who(tx.Account)} paid ${amt(tx.Amount)} to ${who(tx.Destination)}${tx.DestinationTag != null ? ' (tag ' + tx.DestinationTag + ')' : ''}.`;
    case 'TrustSet': return `${who(tx.Account)} ${Number(tx.LimitAmount?.value) === 0 ? 'removed the trust line for' : 'allowed holding up to ' + tx.LimitAmount?.value + ' of'} ${hexName(tx.LimitAmount?.currency)} issued by ${who(tx.LimitAmount?.issuer)}.`;
    case 'OfferCreate': return `${who(tx.Account)} offered to give ${amt(tx.TakerGets)} and receive ${amt(tx.TakerPays)} on the exchange.`;
    case 'OfferCancel': return `${who(tx.Account)} cancelled exchange offer #${tx.OfferSequence}.`;
    case 'AccountSet': return `${who(tx.Account)} changed account settings.`;
    case 'NFTokenMint': return `${who(tx.Account)} minted an NFT.`;
    case 'AMMDeposit': case 'AMMWithdraw': return `${who(tx.Account)} ${t === 'AMMDeposit' ? 'added funds to' : 'took funds from'} a liquidity pool.`;
    default: return `${who(tx?.Account || '')} sent a ${t || 'unknown'} transaction.`;
  }
}
// 16. Balance history -------------------------------------------------------------------------------------------
const BK = 'starsky.x.balhist';
export function snapshot(total: number, now = Date.now()) { const h: Record<string, number> = LS(BK, {}), d = new Date(now).toISOString().slice(0, 10); h[d] = +total.toFixed(6); const keys = Object.keys(h).sort().slice(-120); const o: Record<string, number> = {}; keys.forEach(k => o[k] = h[k]); SV(BK, o); }
export const history = (): Array<[string, number]> => Object.entries(LS(BK, {}) as Record<string, number>).sort();
export function spark(v: number[], w = 220, h = 40): string { if (v.length < 2) return ''; const mn = Math.min(...v), mx = Math.max(...v), r = mx - mn || 1; return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-label="balance over time"><polyline fill="none" stroke="#00c46f" stroke-width="2" points="${v.map((x, i) => (i / (v.length - 1) * (w - 4) + 2).toFixed(1) + ',' + (h - 3 - (x - mn) / r * (h - 6)).toFixed(1)).join(' ')}"/></svg>`; }
// 17. Large-send threshold setting (used with 10) ----------------------------------------------------------------
export const bigThreshold = (): number => Number(LS('starsky.x.big', 0)) || 0;

// ---------- UI ----------
let styled = false; const $ = (id: string) => document.getElementById(id);
function css() { if (styled) return; styled = true; const s = document.createElement('style'); s.textContent = '#xmore h4{margin:.9rem 0 .3rem;font-size:.8rem;opacity:.8}#xmore .xr{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;margin:.25rem 0;font-size:.84rem}#xmore input,#xmore select{max-width:100%}.xbar{display:flex;height:.7rem;border-radius:.4rem;overflow:hidden;margin:.3rem 0}.xbar i{display:block;height:100%}'; document.head.appendChild(s); }
const COL = ['#00c46f', '#8fb0ff', '#d29922', '#f778ba', '#a371f7', '#39c5cf', '#ff7b72'];
async function load() {
  const me = ctx.account(); const o: any = { lines: [], info: null, acct: null, txs: [] as Tx[] }; if (!me) return o;
  try { o.info = (await ctx.req('server_info')).info; } catch {}
  try { o.acct = (await ctx.req('account_info', { account: me, ledger_index: 'validated' })).account_data; } catch {}
  try { o.lines = (await ctx.req('account_lines', { account: me, ledger_index: 'validated', limit: 200 })).lines || []; } catch {}
  try { const r = (await ctx.req('account_tx', { account: me, limit: 200, ledger_index_min: -1, ledger_index_max: -1 })).transactions || []; for (const x of r) { const t = x.tx_json || x.tx; if (!t || t.TransactionType !== 'Payment') continue; const ts = ((t.date ?? x.close_time_iso ? t.date : 0) || 0); const when = typeof t.date === 'number' ? (t.date + 946684800) * 1000 : Date.parse(x.close_time_iso || '') || 0; const out = t.Account === me, nat = typeof (t.DeliverMax ?? t.Amount) === 'string'; o.txs.push({ t: when || ts, dir: out ? 'out' : 'in', amount: nat ? Number(t.DeliverMax ?? t.Amount) / 1e6 : Number((t.DeliverMax ?? t.Amount)?.value), peer: out ? t.Destination : t.Account, cur: nat ? 'native' : hexName((t.DeliverMax ?? t.Amount).currency) }); } } catch {}
  return o;
}
export async function card() {
  const view = $('view'); if (!view) return; css(); let box = $('xmore'); if (!box) { box = document.createElement('div'); box.id = 'xmore'; box.className = 'card'; box.style.marginBottom = '.8rem'; view.insertBefore(box, view.children[1] || null); }
  const me = ctx.account(); if (!me) { box.innerHTML = '<div class="k">Wallet toolbox</div><div class="mut">Open a wallet to use these tools.</div>'; return; }
  const d = await load(), bal = d.acct ? Number(d.acct.Balance) / 1e6 : 0, v = d.info?.validated_ledger || {}, base = Number(v.reserve_base_xrp ?? 10), inc = Number(v.reserve_inc_xrp ?? 2), owners = d.acct?.OwnerCount || 0;
  if (d.acct) snapshot(bal);
  const fee = feeNow(d.info), dg7 = digest(d.txs, 7), dg30 = digest(d.txs, 30), rec = reclaimable(d.lines), dst = dust(d.lines), reg = LS('starsky.x.registry', null);
  const al = allocation([{ name: ctx.native(), value: bal }, ...d.lines.map((l: Line) => ({ name: hexName(l.currency), value: Number(l.balance) }))]);
  const hs = healthScore({ backedUpDays: (() => { const t = LS('starsky.x.prefs', {}).backedUp; return t ? Math.floor((Date.now() - t) / 864e5) : null; })(), lockMin: Number(LS('starsky.cfg', {}).lockMin ?? 15), hasPassword: !!localStorage.getItem('starsky.vault'), unusedLines: rec.length, funded: bal > 0 });
  const hist = history().map(x => x[1]), rem = reminders(), due = rem.filter(r => isDue(r)), yr = new Date().getFullYear();
  box.innerHTML = `<div class="k" style="margin:0">Wallet toolbox</div>
  <h4>Health score: ${hs.score}/100</h4>${hs.todo.map(t => `<div class="xr">• ${esc(t)}</div>`).join('') || '<div class="xr">Everything looks good.</div>'}
  <h4>Fee now</h4><div class="xr">A normal payment costs <b>${fee.fee} ${esc(ctx.native())}</b> (${fee.busy}${fee.busy === 'busy' ? ', load ×' + fee.factor : ''}). Most you can send: <b>${num(sendMax(bal, base, inc, owners), 6)}</b></div>
  <h4>Balance over time</h4><div class="xr">${spark(hist) || '<span class="mut">History builds up as you open the wallet on different days.</span>'}</div>
  <h4>Where your money is</h4>${al.length ? `<div class="xbar">${al.map((a, i) => `<i title="${esc(a.name)} ${a.pct}%" style="width:${a.pct}%;background:${COL[i % COL.length]}"></i>`).join('')}</div><div class="xr">${al.slice(0, 6).map((a, i) => `<span><span style="color:${COL[i % COL.length]}">●</span> ${esc(a.name)} ${a.pct}%</span>`).join('')}</div><div class="mut" style="font-size:.74rem">By token amount, not price.</div>` : '<div class="xr mut">Nothing held yet.</div>'}
  <h4>Last 7 and 30 days (${esc(ctx.native())} payments)</h4><div class="xr">7 days: in ${num(dg7.received, 4)} · out ${num(dg7.sent, 4)} · ${dg7.count} payments</div><div class="xr">30 days: in ${num(dg30.received, 4)} · out ${num(dg30.sent, 4)} · net ${dg30.net >= 0 ? '+' : ''}${num(dg30.net, 4)}</div>${dg30.top.length ? `<div class="xr mut">Most active: ${dg30.top.map(t => esc(t[0].slice(0, 8)) + '… (' + num(t[1], 2) + ')').join(', ')}</div>` : ''}
  <div class="xr"><button class="btn" onclick="window.xm.year(${yr})">Export ${yr} payments (CSV)</button></div>
  <h4>Reserve you can get back</h4>${rec.length ? rec.map(l => `<div class="xr">${esc(hexName(l.currency))} <span class="mut">${esc(l.account.slice(0, 8))}…</span> <button class="btn" onclick="window.xm.drop('${esc(l.currency)}','${esc(l.account)}')">Remove (frees ${inc} ${esc(ctx.native())})</button></div>`).join('') : '<div class="xr mut">No empty token lines.</div>'}
  ${dst.length ? `<div class="xr mut">Dust (tiny balances you may want to ignore): ${dst.map(l => esc(hexName(l.currency)) + ' ' + l.balance).join(', ')}</div>` : ''}
  <h4>Large-payment guard</h4><div class="xr">Ask me to retype the last 4 characters when a payment is at least <input id="xm_big" value="${bigThreshold() || ''}" placeholder="amount (0 = only if over half my balance)" style="width:11rem"> <button class="btn" onclick="window.xm.big()">Save</button></div>
  <h4>Reminders (they never pay by themselves)</h4>${rem.map(r => `<div class="xr">${esc(r.label)}: ${esc(r.amount)} ${esc(r.cur)} to ${esc(r.to.slice(0, 8))}… every ${r.every}${due.includes(r) ? ' <b style="color:#d29922">due now</b> <button class="btn" onclick="window.xm.pay(\'' + esc(r.id) + '\')">Open payment</button>' : ''} <button class="btn" onclick="window.xm.rdel('${esc(r.id)}')">Delete</button></div>`).join('') || '<div class="xr mut">None.</div>'}
  <div class="xr"><input id="xm_rl" placeholder="label" style="width:7rem"><input id="xm_rt" placeholder="pay to address" style="width:12rem"><input id="xm_ra" placeholder="amount" style="width:5rem"><select id="xm_re"><option value="month">monthly</option><option value="week">weekly</option></select><input id="xm_rd" type="number" min="1" max="31" value="1" style="width:3.5rem" title="day of month (1-31) or weekday (0=Sun)"><button class="btn" onclick="window.xm.radd()">Add</button></div>
  <h4>Notes on transactions</h4><div class="xr"><input id="xm_nh" placeholder="transaction hash" style="width:16rem"><input id="xm_nt" placeholder="note, for example rent June" style="width:12rem"><button class="btn" onclick="window.xm.note()">Save</button></div>${findNotes('').slice(0, 5).map(([h, t]) => `<div class="xr mut">${esc(h.slice(0, 10))}… ${esc(t)}</div>`).join('')}
  <h4>Explain a transaction</h4><div class="xr"><input id="xm_eh" placeholder="transaction hash" style="width:16rem"><button class="btn" onclick="window.xm.explain()">Explain</button></div><div id="xm_eo" class="xr"></div>
  <h4>Check an address</h4><div class="xr"><input id="xm_ca" placeholder="paste any address" style="width:16rem"><button class="btn" onclick="window.xm.check()">Check</button></div><div id="xm_co" class="xr"></div>
  <h4>Contacts and backup</h4><div class="xr"><button class="btn" onclick="window.xm.csvOut()">Export contacts (CSV)</button><label class="btn">Import contacts<input type="file" accept=".csv" style="display:none" onchange="window.xm.csvIn(this)"></label></div>
  <div class="xr"><input id="xm_bp" type="password" placeholder="passphrase for the backup" style="width:14rem"><button class="btn" onclick="window.xm.bak()">Save encrypted settings backup</button><label class="btn">Restore<input type="file" accept=".json" style="display:none" onchange="window.xm.rest(this)"></label></div><div class="mut" style="font-size:.74rem">The backup holds labels, notes, reminders and preferences. It never contains your recovery phrase or wallet keys.</div>`;
}
const dl = (name: string, text: string, type = 'text/plain') => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); };
const val = (id: string) => (($(id) as HTMLInputElement | null)?.value || '').trim();
(window as any).xm = {
  big: () => { SV('starsky.x.big', Number(val('xm_big')) || 0); ctx.toast('Saved'); },
  radd: () => { const r: Reminder = { id: Math.random().toString(36).slice(2, 9), label: val('xm_rl').slice(0, 30) || 'Payment', to: val('xm_rt'), amount: val('xm_ra'), cur: ctx.native(), every: val('xm_re') as any, day: Number(val('xm_rd')) || 1, last: 0 }; if (!okAddr(r.to)) return ctx.toast('Enter a valid address', true); if (!(Number(r.amount) > 0)) return ctx.toast('Enter an amount', true); const l = reminders(); l.push(r); SV(RK, l); card(); },
  rdel: (id: string) => { SV(RK, reminders().filter(r => r.id !== id)); card(); },
  pay: (id: string) => { const r = reminders().find(x => x.id === id); if (!r) return; SV(RK, reminders().map(x => x.id === id ? { ...x, last: Date.now() } : x)); location.hash = 'pay?' + new URLSearchParams({ to: r.to, amt: r.amount }).toString(); import('./safety.ts').then(m => { m.resetPay(); ctx.rerender(); }); },
  note: () => { const e = setNote(val('xm_nh'), val('xm_nt')); if (e) ctx.toast(e, true); else { ctx.toast('Saved'); card(); } },
  explain: async () => { const h = val('xm_eh'), o = $('xm_eo'); if (!o) return; o.textContent = 'Looking…'; try { const r = await ctx.req('tx', { transaction: h }); const t = r.tx_json || r; o.innerHTML = esc(explainTx(t, ctx.account() || '', ctx.native())) + (notes()[h.toUpperCase()] ? ' <span class="mut">Your note: ' + esc(notes()[h.toUpperCase()]) + '</span>' : '') + (r.validated === false ? ' <b>Not confirmed yet.</b>' : ''); } catch { o.textContent = 'Not found on this network.'; } },
  check: () => { const o = $('xm_co'); if (!o) return; const r = checkAddress(val('xm_ca'), LA.normalize, LA.toL, LA.active()); o.innerHTML = `<span style="color:${r.ok ? '#00c46f' : '#f85149'}">${esc(r.msg)}</span>${r.display ? ' <span class="mut">' + esc(r.display) + '</span>' : ''}`; },
  year: async (y: number) => { const d = await load(); const rows = yearRows(d.txs, y); dl(`starsky-${y}.csv`, rows.map(r => r.map(c => /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c).join(',')).join('\n'), 'text/csv'); },
  drop: async (cur: string, issuer: string) => { if (!confirm('Remove this empty token line and free its reserve?')) return; const r = await ctx.submit({ TransactionType: 'TrustSet', Account: ctx.account(), LimitAmount: { currency: cur, issuer, value: '0' }, Flags: 0x00020000 }); ctx.toast(r.ok ? 'Removed' : r.msg || 'Could not remove', !r.ok); card(); },
  csvOut: () => dl('starsky-contacts.csv', contactsToCsv((ctx.book?.() || []).map(b => ({ name: b.name, addr: b.addr }))), 'text/csv'),
  csvIn: (el: HTMLInputElement) => { const f = el.files?.[0]; if (!f) return; f.text().then(t => { const r = csvToContacts(t, okAddr); (window as any).xmImport?.(r.ok); ctx.toast(`${r.ok.length} contact(s) ready${r.bad.length ? ', ' + r.bad.length + ' skipped: ' + r.bad[0] : ''}`, !r.ok.length); (window as any).xmLast = r; }); },
  bak: async () => { try { const o: any = {}; for (const k of BACKUP_KEYS(Object.keys(localStorage))) o[k] = localStorage.getItem(k); dl('starsky-settings-backup.json', await encryptBackup(o, val('xm_bp')), 'application/json'); ctx.toast('Backup saved'); } catch (e: any) { ctx.toast(e.message, true); } },
  rest: (el: HTMLInputElement) => { const f = el.files?.[0]; if (!f) return; const p = prompt('Passphrase for this backup'); if (!p) return; f.text().then(async t => { try { const o = await decryptBackup(t, p); for (const k of BACKUP_KEYS(Object.keys(o))) localStorage.setItem(k, o[k]); ctx.toast('Restored'); location.reload(); } catch (e: any) { ctx.toast(e.message, true); } }); },
};
/** Send page helpers: a Max button and the large-payment retype guard */
export function sendHelpers() {
  const amt = $('s_amt') as HTMLInputElement | null; if (!amt || $('xm_max')) return;
  const b = document.createElement('button'); b.id = 'xm_max'; b.type = 'button'; b.className = 'btn'; b.textContent = 'Max'; b.title = 'Everything you can spend after the locked reserve and the fee'; amt.after(b);
  b.onclick = async () => { try { const me = ctx.account()!, a = (await ctx.req('account_info', { account: me, ledger_index: 'validated' })).account_data, v = (await ctx.req('server_info')).info.validated_ledger; amt.value = String(sendMax(Number(a.Balance) / 1e6, Number(v.reserve_base_xrp ?? 10), Number(v.reserve_inc_xrp ?? 2), a.OwnerCount || 0)); amt.dispatchEvent(new Event('input')); } catch { ctx.toast('Could not read your balance', true); } };
}
/** Called with every payment before signing. Returns '' to go on or a message to stop. */
export async function largeGuard(tx: any, ask: (m: string) => string | null = m => prompt(m)): Promise<string> {
  try {
    if (tx?.TransactionType !== 'Payment' || typeof tx.Amount !== 'string') return '';
    const a = (await ctx.req('account_info', { account: tx.Account || ctx.account(), ledger_index: 'validated' })).account_data, w = confirmWord(Number(tx.Amount) / 1e6, Number(a.Balance) / 1e6, bigThreshold(), tx.Destination);
    if (!w) return ''; const r = ask(`This is a large payment. To be sure it goes to the right place, type the last 4 characters of the recipient address (${tx.Destination.slice(0, 6)}…):`);
    return r != null && r.trim() === w ? '' : 'Cancelled: the characters did not match, nothing was sent.';
  } catch { return ''; }
}
export function onRender(tab: string) { if (tab === 'more') card().catch(() => {}); if (tab === 'send') sendHelpers(); }
