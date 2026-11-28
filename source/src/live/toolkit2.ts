// Toolkit extras: contacts (pay by name), a daily send limit, and a plain-language weekly digest. All local to this browser.
import { ctx } from './ctx.ts';
import { esc, fmt, short } from './util.ts';
const rd = (k: string, d: any) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const wr = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } };
export interface Contact { name: string; addr: string; note?: string }
export interface Spent { t: number; amt: number }
const acc = () => ctx.account() || 'x', CK = () => 'starsky.contacts.' + acc(), LK = () => 'starsky.limit.' + acc(), SK = () => 'starsky.spent.' + acc();
const chip = (t: string, c: string) => `<span style="display:inline-block;padding:.08rem .5rem;border-radius:99px;font-size:.78rem;background:${c}22;color:${c}">${esc(t)}</span>`;

// ---- pure helpers (unit tested) ----
export const findContact = (list: Contact[], q: string): Contact | null => { const n = q.trim().toLowerCase(); if (!n) return null; return list.find(c => c.name.toLowerCase() === n) || list.find(c => c.addr === q.trim()) || null; };
export const validAddr = (a: string) => /^(r[1-9A-HJ-NP-Za-km-z]{24,34}|L[1-9A-HJ-NP-Za-km-z]{24,34})$/.test(a.trim());
export const spentIn = (list: Spent[], now: number, hours = 24) => list.filter(s => now - s.t < hours * 3600e3).reduce((a, s) => a + s.amt, 0);
export function limitCheck(limit: number, spent24: number, amt: number): string { if (!(limit > 0)) return ''; if (spent24 + amt > limit + 1e-9) return `Daily send limit reached: ${fmt(spent24)} already sent today, ${fmt(amt)} more would pass your ${fmt(limit)} limit. Raise it in Developer API → Toolkit → Safety to continue.`; return ''; }
export function digest(txs: any[], me: string, now: number, days = 7) {
  const from = now - days * 86400e3; let sent = 0, recv = 0, fees = 0, n = 0, other = 0; const peers = new Map<string, number>();
  for (const x of txs) { const t = x.tx_json || x.tx || x.tx_blob_json; if (!t) continue; const when = t.date != null ? (t.date + 946684800) * 1000 : x.close_time_iso ? Date.parse(x.close_time_iso) : 0; if (when && when < from) continue; n++;
    const m = x.meta || x.metaData, d = m?.delivered_amount ?? t.Amount, drops = typeof d === 'string' ? Number(d) / 1e6 : 0;
    if (t.TransactionType === 'Payment' && typeof d === 'string') { if (t.Account === me) { sent += drops; fees += Number(t.Fee || 0) / 1e6; peers.set(t.Destination, (peers.get(t.Destination) || 0) + drops); } else if (t.Destination === me) recv += drops; else other++; } else { if (t.Account === me) fees += Number(t.Fee || 0) / 1e6; other++; } }
  const top = [...peers.entries()].sort((a, b) => b[1] - a[1])[0] || null; return { n, sent, recv, fees, other, top };
}
export const recordSpend = (amt: number) => { if (!(amt > 0)) return; const l: Spent[] = rd(SK(), []).filter((s: Spent) => Date.now() - s.t < 7 * 86400e3); l.push({ t: Date.now(), amt }); wr(SK(), l); };
export function guard(tx: any): string { try { if (tx?.TransactionType !== 'Payment' || typeof tx.Amount !== 'string') return ''; const lim = Number(rd(LK(), 0)); return limitCheck(lim, spentIn(rd(SK(), []), Date.now()), Number(tx.Amount) / 1e6); } catch { return ''; } }
export const noteSent = (tx: any) => { if (tx?.TransactionType === 'Payment' && typeof tx.Amount === 'string') recordSpend(Number(tx.Amount) / 1e6); };

// ---- UI ----
let MSG = '', DG = '';
export function contactsHtml(): string {
  const c: Contact[] = rd(CK(), []);
  return `<div class="card c12"><div class="k">Contacts (pay by name)</div><div class="mut" style="font-size:.82rem;margin:.2rem 0 .5rem">Save people once. In Bulk pay you can type a name instead of an address, and Starsky warns you the first time you pay someone who is not saved.</div><div class="row" style="gap:.5rem;flex-wrap:wrap"><input id="ct_n" placeholder="Name" size="14"><input id="ct_a" placeholder="Wallet address" size="30"><input id="ct_note" placeholder="Note (optional)" size="18"><button class="pri" onclick="window.tkt.addContact()">Save contact</button></div>${MSG ? `<div class="mut" style="margin-top:.4rem">${esc(MSG)}</div>` : ''}
  ${c.length ? `<table style="width:100%;margin-top:.6rem">${c.map((x, i) => `<tr><td><b>${esc(x.name)}</b></td><td class="mono">${esc(short(x.addr, 10, 8))}</td><td class="mut">${esc(x.note || '')}</td><td style="text-align:right"><button class="sm" onclick="window.tkt.copyText('${esc(x.addr)}')">Copy</button> <button class="sm" onclick="window.tkt.rmContact(${i})">Remove</button></td></tr>`).join('')}</table><div class="row" style="gap:.5rem;margin-top:.5rem"><button class="sm" onclick="window.tkt.exportContacts()">Export</button></div>` : '<div class="mut" style="margin-top:.6rem">No contacts yet.</div>'}</div>`;
}
export function safetyHtml(): string {
  const lim = Number(rd(LK(), 0)), sp = spentIn(rd(SK(), []), Date.now());
  return `<div class="card c12"><div class="k">Daily send limit</div><div class="mut" style="font-size:.82rem;margin:.2rem 0 .5rem">A cap on how much ${esc(ctx.native())} this wallet can send in 24 hours from Starsky. It protects you if someone gets into this browser. It does not limit other wallets or apps. Leave empty or 0 to turn it off.</div><div class="row" style="gap:.5rem;flex-wrap:wrap;align-items:center"><input id="ls_lim" inputmode="decimal" placeholder="limit in ${esc(ctx.native())}" value="${lim || ''}" size="14"><button class="pri" onclick="window.tkt.setLimit()">Save limit</button>${lim ? chip(`${fmt(sp)} of ${fmt(lim)} used in 24 h`, sp > lim * 0.8 ? '#f5b84b' : '#3ddc84') : chip('off', '#9aa0aa')}</div>${MSG ? `<div class="mut" style="margin-top:.4rem">${esc(MSG)}</div>` : ''}</div>`;
}
export function digestHtml(): string { return `<div class="card c12"><div class="k">Weekly digest</div><div class="mut" style="font-size:.82rem;margin:.2rem 0 .5rem">A plain summary of what this wallet did in the last 7 days.</div><button class="pri" onclick="window.tkt.runDigest()">Write my digest</button><div style="margin-top:.6rem;line-height:1.55">${DG || '<span class="mut">Press the button.</span>'}</div></div>`; }
export const tabs: [string, string][] = [['contacts', 'Contacts'], ['safety', 'Spending limit'], ['digest', 'Weekly digest']];
export const html = (v: string) => (v === 'contacts' ? contactsHtml() : v === 'safety' ? safetyHtml() : digestHtml());
export function makeApi(repaint: () => void) {
  const IDS = ['ct_n', 'ct_a', 'ct_note', 'ls_lim'];
  const say = (m: string, keep = true) => { const v = IDS.map(i => (document.getElementById(i) as HTMLInputElement | null)?.value ?? ''); MSG = m; repaint(); if (keep) IDS.forEach((i, k) => { const e = document.getElementById(i) as HTMLInputElement | null; if (e && v[k]) e.value = v[k]; }); };
  return {
    addContact() { const g = (id: string) => ((document.getElementById(id) as HTMLInputElement | null)?.value || '').trim(); const name = g('ct_n'), addr = g('ct_a'), note = g('ct_note'); if (!name) return say('Give the contact a name.'); if (!validAddr(addr)) return say('That does not look like a wallet address.'); const l: Contact[] = rd(CK(), []); if (l.some(x => x.name.toLowerCase() === name.toLowerCase())) return say('A contact with that name already exists.'); l.push({ name, addr, note }); wr(CK(), l); say(`Saved ${name}.`, false); },
    rmContact(i: number) { const l: Contact[] = rd(CK(), []); l.splice(i, 1); wr(CK(), l); say('Removed.'); },
    exportContacts() { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(rd(CK(), []), null, 2)], { type: 'application/json' })); a.download = 'starsky-contacts.json'; a.click(); },
    copyText(t: string) { void navigator.clipboard?.writeText(t); ctx.toast('Copied'); },
    setLimit() { const v = Number((document.getElementById('ls_lim') as HTMLInputElement | null)?.value || 0); if (!(v >= 0) || !isFinite(v)) return say('Enter a number.'); wr(LK(), v); say(v ? `Limit set to ${fmt(v)} ${ctx.native()} per 24 hours.` : 'Limit turned off.'); },
    async runDigest() { DG = '<span class="mut">Reading your history…</span>'; repaint(); try { const r: any = await ctx.req('account_tx', { account: acc(), limit: 200, ledger_index_min: -1, ledger_index_max: -1 }); const d = digest(r.transactions || [], acc(), Date.now()); DG = d.n ? `In the last 7 days this wallet made <b>${d.n}</b> transaction${d.n === 1 ? '' : 's'}. You sent <b>${fmt(d.sent)} ${esc(ctx.native())}</b> and received <b>${fmt(d.recv)} ${esc(ctx.native())}</b>. Network fees came to ${fmt(d.fees, 6)}. ${d.top ? `Your biggest recipient was <span class="mono">${esc(short(d.top[0], 8, 6))}</span> (${fmt(d.top[1])}).` : ''} ${d.other ? `${d.other} other action${d.other === 1 ? '' : 's'} (trades, trust lines, settings).` : ''}` : 'No activity in the last 7 days.'; } catch (e: any) { DG = 'Could not read history: ' + esc(String(e?.message || e)); } repaint(); },
  };
}
