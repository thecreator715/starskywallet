// Toolkit: bulk pay and split a bill, wallet cleanup and health, watchlist with price alerts, and a journal with CSV export.
// Everything signs in this browser; alerts run while Starsky is open.
import { ctx } from './ctx.ts';
import { esc, fmt, short, fromKey, NATIVE, isNative, amtTx, type Asset } from './util.ts';
import * as M from './market.ts';
import * as PM from './procmodal.ts';

const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const net = () => (ctx.netKey() === 'test' ? 'test' : 'main');
const rd = (k: string, d: any) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const wr = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } };
const GREEN = '#3ddc84', RED = '#ff5b5b', AMB = '#f5b84b';
const chip = (t: string, c: string) => `<span style="display:inline-block;padding:.08rem .5rem;border-radius:99px;font-size:.78rem;background:${c}22;color:${c}">${esc(t)}</span>`;
const tile = (k: string, v: string, sub = '') => `<div class="tile" style="min-width:9rem;flex:1"><div class="mut" style="font-size:.8rem">${esc(k)}</div><div style="font-size:1.2rem;font-weight:800;margin:.1rem 0">${v}</div><div class="mut" style="font-size:.78rem">${sub}</div></div>`;
type VW = 'bulk' | 'clean' | 'watch' | 'journal';
let VIEW = 'bulk' as VW;
const TABS: [VW, string][] = [['bulk', 'Bulk pay & split bill'], ['clean', 'Cleanup & health'], ['watch', 'Watchlist & alerts'], ['journal', 'Journal']];

// ---------- pure helpers (tested) ----------
export function parsePay(txt: string): { rows: { addr: string; amt?: number }[]; bad: string[] } {
  const rows: { addr: string; amt?: number }[] = [], bad: string[] = [], seen = new Set<string>();
  for (const ln of txt.split(/\n+/)) { const p = ln.trim().split(/[\s,;\t]+/).filter(Boolean); if (!p.length) continue; const a = p[0]; if (!/^(r|X|L|T|M)[1-9A-HJ-NP-Za-km-z]{20,}$/.test(a)) { bad.push(a); continue; } if (seen.has(a)) { bad.push(a + ' (repeated)'); continue; } seen.add(a); const n = p[1] != null ? Number(p[1]) : undefined; if (p[1] != null && !(n! > 0)) { bad.push(a + ' (bad amount)'); continue; } rows.push({ addr: a, amt: n }); }
  return { rows, bad };
}
export function splitBill(total: number, n: number, dp = 6): number[] { if (!(total > 0) || n < 1) return []; const f = 10 ** dp, base = Math.floor(total * f / n) / f, out = Array(n).fill(base); let rem = Math.round((total - base * n) * f); for (let i = 0; rem > 0; i = (i + 1) % n, rem--) out[i] = +(out[i] + 1 / f).toFixed(dp); return out; }
export function healthScore(o: { reserveShare: number; unusedLines: number; offers: number; lines: number }): { score: number; notes: string[] } {
  let s = 100; const notes: string[] = [];
  if (o.reserveShare > 0.5) { s -= 25; notes.push('Most of your LUMA is locked as reserve.'); } else if (o.reserveShare > 0.25) { s -= 10; notes.push('A good part of your LUMA is locked as reserve.'); }
  if (o.unusedLines > 0) { s -= Math.min(30, o.unusedLines * 5); notes.push(`${o.unusedLines} trust line${o.unusedLines === 1 ? '' : 's'} hold nothing and lock reserve.`); }
  if (o.offers > 10) { s -= 15; notes.push(`${o.offers} open offers use reserve.`); } else if (o.offers > 3) { s -= 5; notes.push(`${o.offers} open offers.`); }
  if (o.lines > 40) { s -= 10; notes.push('Many trust lines: remove the ones you do not use.'); }
  return { score: Math.max(0, s), notes };
}
export function alertHit(a: { dir: 'above' | 'below'; price: number }, px: number | null): boolean { return px != null && (a.dir === 'above' ? px >= a.price : px <= a.price); }
export function csvRow(cells: (string | number)[]): string { return cells.map(c => { const s = String(c ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(','); }

// ---------- state ----------
let MSG = '', LINES: any[] = [], OFFERS = 0, RES = { base: 1, inc: 0.2 }, NB = 0, ROWS: any[] = [], WSNAP: M.Snap | null = null, JR: any[] = [], tmr: any = 0, busy = false;
const WK = () => `starsky.toolkit.watch.${net()}`, AK = () => `starsky.toolkit.alerts.${net()}`;
async function readWallet() {
  const acc = ctx.account(); if (!acc) return;
  const [ai, al, ao, si] = await Promise.all([ctx.req('account_info', { account: acc, ledger_index: 'validated' }).catch(() => null), ctx.req('account_lines', { account: acc, ledger_index: 'validated', limit: 400 }).catch(() => null), ctx.req('account_offers', { account: acc, ledger_index: 'validated', limit: 400 }).catch(() => null), ctx.req('server_info', {}).catch(() => null)]);
  LINES = al?.lines || []; OFFERS = (ao?.offers || []).length; const v = si?.info?.validated_ledger || {}; RES = { base: Number(v.reserve_base_xrp ?? 1), inc: Number(v.reserve_inc_xrp ?? 0.2) };
  NB = ai?.account_data ? Number(ai.account_data.Balance) / 1e6 : 0;
}
const balOf = (a: Asset) => isNative(a) ? Math.max(0, NB - RES.base - RES.inc * (LINES.length + OFFERS)) : Number((LINES.find((l: any) => l.currency === a.c && l.account === a.i) || {}).balance || 0);

// ---------- bulk pay ----------
async function bulkPreview() {
  const txt = $('tk_list')?.value || '', tk = $('tk_tok')?.value || 'native', mode = $('tk_mode')?.value || 'listed', tot = Number($('tk_tot')?.value || 0);
  const { rows, bad } = parsePay(txt); await readWallet(); const a: Asset = tk === 'native' ? NATIVE : { c: tk.split('|')[0], i: tk.split('|')[1] };
  let amts: number[] = []; if (mode === 'equal') amts = splitBill(tot, rows.length); else amts = rows.map(r => r.amt || 0);
  const bal = balOf(a), sum = amts.reduce((x, y) => x + y, 0), errs = [...bad.map(b => 'Skipped: ' + b)];
  if (!rows.length) errs.push('Add at least one wallet address, one per line.'); if (amts.some(x => !(x > 0))) errs.push('Every wallet needs an amount (or choose "split a total").'); if (sum > bal + 1e-9) errs.push(`You need ${fmt(sum)} ${M.labelOf(a)} but have ${fmt(bal)} available.`);
  ROWS = rows.map((r, i) => ({ addr: r.addr, amt: amts[i], a })); MSG = errs.length ? errs.map(e => `<div style="color:${AMB}">${esc(e)}</div>`).join('') : `<div style="color:${GREEN}">${rows.length} payments, ${fmt(sum)} ${esc(M.labelOf(a))} in total. Press Review and send.</div>`; paint();
}
async function bulkSend() {
  await bulkPreview(); if (!ROWS.length || /needs|need at least|Add at least/.test(MSG)) return ctx.toast('Fix the list first.', true);
  const a: Asset = ROWS[0].a, sum = ROWS.reduce((x, r) => x + r.amt, 0);
  const ok = await PM.review({ title: 'Send to ' + ROWS.length + ' wallets', tone: 'buy', hero: `<div style="font-size:1.4rem;font-weight:800">${fmt(sum)} ${esc(M.labelOf(a))}</div><div class="mut">Each wallet gets its own payment. A wallet that cannot receive it is skipped and nothing is lost.</div>`, rows: [{ k: 'Wallets', v: String(ROWS.length) }, { k: 'Network fee', v: '~0.00001 ' + esc(ctx.native()) + ' each' }], confirm: 'Send all' });
  if (!ok) return; const acc = ctx.account()!, prog = PM.progress('Sending', ROWS.map(r => short(r.addr))); let good = 0; const out: any[] = [];
  for (let i = 0; i < ROWS.length; i++) { const r = ROWS[i]; prog.set(i, 'run'); try { const x = await ctx.submit({ TransactionType: 'Payment', Account: acc, Destination: ctx.toClassic(r.addr), Amount: amtTx(r.a, r.amt) }); if (x.ok) { good++; prog.set(i, 'ok', fmt(r.amt)); } else prog.set(i, 'bad', (x.msg || '').slice(0, 60)); out.push({ ...r, ok: !!x.ok, hash: x.hash, msg: x.msg }); } catch (e: any) { prog.set(i, 'bad', String(e?.message || e).slice(0, 60)); out.push({ ...r, ok: false, msg: String(e?.message || e) }); } }
  prog.done(`${good} of ${ROWS.length} sent`); MSG = `<div style="color:${good === ROWS.length ? GREEN : AMB}">${good} of ${ROWS.length} sent.</div>${out.filter(o => !o.ok).map(o => `<div class="mut">${esc(short(o.addr))}: ${esc(o.msg || 'failed')}</div>`).join('')}`; await readWallet(); paint();
}
function bulkHtml(): string {
  const toks = [['native', ctx.native()], ...LINES.filter((l: any) => Number(l.balance) > 0).map((l: any) => [l.currency + '|' + l.account, M.labelOf({ c: l.currency, i: l.account })])];
  return `<div class="card c12"><div class="k">Pay many wallets, or split a bill</div><div class="mut" style="font-size:.82rem;margin:.2rem 0 .5rem">One line per wallet: <i>address, amount</i>. Or choose "split a total equally" and list only addresses.</div>
  <textarea id="tk_list" rows="7" style="width:100%" placeholder="rExample..., 5&#10;rAnother..., 2.5"></textarea>
  <div class="row" style="gap:.5rem;margin-top:.5rem;flex-wrap:wrap;align-items:center"><select id="tk_tok">${toks.map(t => `<option value="${esc(t[0])}">${esc(t[1])}</option>`).join('')}</select><select id="tk_mode"><option value="listed">Amounts as listed</option><option value="equal">Split a total equally</option></select><input id="tk_tot" placeholder="total to split" size="12"><button class="sm" onclick="window.tkt.preview()">Check list</button><button class="pri" onclick="window.tkt.send()">Review and send</button></div><div style="margin-top:.6rem">${MSG}</div></div>`;
}

// ---------- cleanup & health ----------
function cleanHtml(): string {
  const unused = LINES.filter((l: any) => Number(l.balance) === 0), freed = unused.length * RES.inc, locked = RES.base + RES.inc * (LINES.length + OFFERS), h = healthScore({ reserveShare: NB > 0 ? locked / NB : 0, unusedLines: unused.length, offers: OFFERS, lines: LINES.length });
  return `<div class="row" style="gap:.6rem;flex-wrap:wrap;width:100%">${tile('Wallet health', `<span style="color:${h.score >= 80 ? GREEN : h.score >= 50 ? AMB : RED}">${h.score}/100</span>`, h.notes[0] ? esc(h.notes[0]) : 'Looks tidy')}${tile('Locked as reserve', fmt(locked) + ' ' + esc(ctx.native()), `${LINES.length} trust lines, ${OFFERS} offers`)}${tile('Can be freed', fmt(freed) + ' ' + esc(ctx.native()), `${unused.length} empty trust lines`)}</div>
  <div class="card c12" style="margin-top:.6rem"><div class="k">Empty trust lines</div>${unused.length ? `<div style="max-height:14rem;overflow:auto;margin:.4rem 0">${unused.map((l: any) => `<div class="mut">${esc(M.labelOf({ c: l.currency, i: l.account }))} · ${esc(short(l.account))}</div>`).join('')}</div><button class="pri" onclick="window.tkt.clean()">Remove ${unused.length} empty trust line${unused.length === 1 ? '' : 's'}</button><div class="mut" style="font-size:.78rem;margin-top:.3rem">This only removes lines holding zero. You can add them again any time.</div>` : '<div class="mut">Nothing to clean up.</div>'}${h.notes.slice(1).map(n => `<div class="mut" style="margin-top:.3rem">${esc(n)}</div>`).join('')}</div>`;
}
async function cleanLines() {
  await readWallet(); const unused = LINES.filter((l: any) => Number(l.balance) === 0); if (!unused.length) return ctx.toast('Nothing to clean up.');
  const ok = await PM.review({ title: 'Remove empty trust lines', tone: 'sell', hero: `<div style="font-size:1.4rem;font-weight:800">+${fmt(unused.length * RES.inc)} ${esc(ctx.native())} freed</div>`, rows: [{ k: 'Trust lines removed', v: String(unused.length) }], confirm: 'Remove' }); if (!ok) return;
  const acc = ctx.account()!, prog = PM.progress('Removing', unused.map((l: any) => M.labelOf({ c: l.currency, i: l.account }))); let n = 0;
  for (let i = 0; i < unused.length; i++) { const l = unused[i]; prog.set(i, 'run'); const x = await ctx.submit({ TransactionType: 'TrustSet', Account: acc, LimitAmount: { currency: l.currency, issuer: l.account, value: '0' }, Flags: 0x00020000 }).catch((e: any) => ({ ok: false, msg: String(e?.message || e) })); if (x.ok) { n++; prog.set(i, 'ok'); } else prog.set(i, 'bad', (x.msg || '').slice(0, 60)); }
  ctx.toast(`${n} trust lines removed`, n < unused.length); await readWallet(); paint();
}

// ---------- watchlist & alerts ----------
const WL = (): string[] => rd(WK(), []), AL = (): any[] => rd(AK(), []);
async function watchTick() {
  if (!document.getElementById('tk_root') && !AL().length) return; if (document.hidden) return;
  try { WSNAP = await M.snapshot(); } catch { return; } const al = AL(); let ch = false;
  for (const a of al) { if (a.fired) continue; const px = M.usdPx(WSNAP, a.key) ?? (a.key === 'native' ? WSNAP.usdPerNative : null); if (alertHit(a, px)) { a.fired = Date.now(); ch = true; const msg = `${a.label} is ${a.dir} $${a.price} (now $${px != null ? px.toPrecision(5) : '?'})`; ctx.toast(msg); try { if ((window as any).Notification && Notification.permission === 'granted') new Notification('Starsky price alert', { body: msg }); } catch { /* ignore */ } } }
  if (ch) wr(AK(), al); if (document.getElementById('tk_root') && VIEW === 'watch') paint();
}
const keyPx = (k: string): number | null => !WSNAP ? null : k === 'native' ? WSNAP.usdPerNative : M.usdPx(WSNAP, k);
function watchHtml(): string {
  const w = WL(), al = AL(), opts = WSNAP ? [['native', ctx.native()], ...[...WSNAP.px.keys()].filter(k => k !== 'native').map(k => [k, M.labelOf(fromKey(k))])] : [['native', ctx.native()]];
  const nameOf = (k: string) => (opts.find(o => o[0] === k) || [k, k])[1];
  return `<div class="card c12"><div class="k">Watchlist</div><div class="row" style="gap:.5rem;margin:.4rem 0;flex-wrap:wrap"><select id="tk_w">${opts.map(o => `<option value="${esc(o[0])}">${esc(o[1])}</option>`).join('')}</select><button class="sm" onclick="window.tkt.watch()">Add to watchlist</button></div>${w.length ? `<table style="width:100%">${w.map(k => `<tr><td>${esc(nameOf(k))}</td><td>${keyPx(k) != null ? '$' + (keyPx(k) as number).toPrecision(5) : '–'}</td><td style="text-align:right"><button class="sm" onclick="window.tkt.unwatch('${esc(k)}')">Remove</button></td></tr>`).join('')}</table>` : '<div class="mut">Nothing watched yet.</div>'}</div>
  <div class="card c12" style="margin-top:.6rem"><div class="k">Price alerts</div><div class="mut" style="font-size:.8rem">You are told when the price crosses your line. Alerts check once a minute while Starsky is open.</div><div class="row" style="gap:.5rem;margin:.4rem 0;flex-wrap:wrap"><select id="tk_ak">${opts.map(o => `<option value="${esc(o[0])}">${esc(o[1])}</option>`).join('')}</select><select id="tk_ad"><option value="above">goes above</option><option value="below">falls below</option></select><input id="tk_ap" placeholder="price in USD" size="10"><button class="sm" onclick="window.tkt.alert()">Add alert</button></div>${al.length ? `<table style="width:100%">${al.map((a, i) => `<tr><td>${esc(a.label)} ${a.dir} $${a.price}</td><td>${a.fired ? chip('fired ' + new Date(a.fired).toLocaleString(), GREEN) : chip('waiting', AMB)}</td><td style="text-align:right"><button class="sm" onclick="window.tkt.rmAlert(${i})">Remove</button></td></tr>`).join('')}</table>` : '<div class="mut">No alerts.</div>'}</div>`;
}

// ---------- journal ----------
const amtStr = (a: any): string => a == null ? '' : typeof a === 'string' ? fmt(Number(a) / 1e6) + ' ' + ctx.native() : `${fmt(Number(a.value))} ${M.labelOf({ c: a.currency, i: a.issuer })}`;
async function journalLoad() {
  const acc = ctx.account(); if (!acc) return; JR = []; let marker: any;
  for (let p = 0; p < 4; p++) { const r: any = await ctx.req('account_tx', { account: acc, ledger_index_min: -1, ledger_index_max: -1, limit: 100, ...(marker ? { marker } : {}) }).catch(() => null); if (!r) break;
    for (const x of r.transactions || []) { const t = x.tx_json || x.tx || {}, m = x.meta || x.metadata || {}; if (!t.TransactionType) continue; const when = ((t.date ?? x.close_time_iso ? t.date : 0) + 946684800) * 1000; const out = t.Account === acc;
      JR.push({ when: t.date ? when : 0, type: t.TransactionType, dir: t.TransactionType === 'Payment' ? (out ? 'sent' : 'received') : '', who: t.TransactionType === 'Payment' ? (out ? t.Destination : t.Account) : '', amt: amtStr(m.delivered_amount ?? t.Amount ?? t.TakerGets), ok: (m.TransactionResult || x.meta?.TransactionResult) === 'tesSUCCESS', hash: t.hash || x.hash || '' }); }
    marker = r.marker; if (!marker) break; }
}
function journalCsv() { const lines = [csvRow(['time', 'type', 'direction', 'counterparty', 'amount', 'success', 'hash']), ...JR.map(j => csvRow([j.when ? new Date(j.when).toISOString() : '', j.type, j.dir, j.who, j.amt, j.ok ? 'yes' : 'no', j.hash]))]; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = 'starsky-journal.csv'; a.click(); }
function journalHtml(): string {
  const pay = JR.filter(j => j.type === 'Payment'), sent = pay.filter(j => j.dir === 'sent').length, rec = pay.length - sent;
  return `<div class="row" style="gap:.6rem;flex-wrap:wrap;width:100%">${tile('Transactions', String(JR.length), 'latest 400')}${tile('Sent', String(sent), 'payments')}${tile('Received', String(rec), 'payments')}</div><div class="card c12" style="margin-top:.6rem"><div class="row" style="align-items:center"><div class="k">Journal</div><span class="grow"></span><button class="sm" onclick="window.tkt.csv()">Download CSV</button></div><div style="max-height:26rem;overflow:auto;margin-top:.4rem"><table style="width:100%">${JR.slice(0, 200).map(j => `<tr><td class="mut">${j.when ? new Date(j.when).toLocaleString() : ''}</td><td>${esc(j.type)} ${esc(j.dir)}</td><td>${esc(j.who ? short(j.who) : '')}</td><td>${esc(j.amt)}</td><td>${j.ok ? '' : chip('failed', RED)}</td></tr>`).join('') || '<tr><td class="mut">No transactions yet.</td></tr>'}</table></div></div>`;
}

// ---------- page ----------
export function shell() { return `<div id="tk_root" style="width:100%"><div class="row" id="tk_tabs" style="gap:.4rem;margin-bottom:.7rem;flex-wrap:wrap"></div><div id="tk_body" class="grid" style="width:100%"></div></div>`; }
function paint() {
  const t = document.getElementById('tk_tabs'), b = document.getElementById('tk_body'); if (!t || !b) return;
  t.innerHTML = TABS.map(([k, l]) => `<button class="sm ${VIEW === k ? 'pri' : ''}" onclick="window.tkt.view('${k}')">${l}</button>`).join('');
  const a = document.activeElement; if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) && b.contains(a)) return;
  b.innerHTML = VIEW === 'bulk' ? bulkHtml() : VIEW === 'clean' ? cleanHtml() : VIEW === 'watch' ? watchHtml() : journalHtml();
}
async function refresh() { if (busy) return; busy = true; try { await readWallet(); if (VIEW === 'journal') await journalLoad(); if (VIEW === 'watch') await watchTick(); } finally { busy = false; paint(); } }
export function view(v: VW) { VIEW = v; MSG = ''; paint(); void refresh(); }
export function mount() { paint(); void refresh(); }
export function start() { clearInterval(tmr); tmr = setInterval(() => void watchTick(), 60000); }
export const api = {
  view, preview: bulkPreview, send: bulkSend, clean: cleanLines, csv: journalCsv,
  watch() { const k = $('tk_w')?.value; if (!k) return; const w = WL(); if (!w.includes(k)) w.push(k); wr(WK(), w); paint(); },
  unwatch(k: string) { wr(WK(), WL().filter(x => x !== k)); paint(); },
  alert() { const k = $('tk_ak')?.value || '', d = ($('tk_ad')?.value || 'above') as 'above' | 'below', p = Number($('tk_ap')?.value); if (!(p > 0)) return ctx.toast('Enter a price in USD.', true); const sel = $('tk_ak') as any, label = sel && sel.selectedOptions[0] ? sel.selectedOptions[0].text : k; const al = AL(); al.push({ key: k, label, dir: d, price: p, fired: 0 }); wr(AK(), al); try { if ((window as any).Notification && Notification.permission === 'default') void Notification.requestPermission(); } catch { /* ignore */ } paint(); },
  rmAlert(i: number) { const al = AL(); al.splice(i, 1); wr(AK(), al); paint(); },
};
