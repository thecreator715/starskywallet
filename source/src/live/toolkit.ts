// Toolkit: bulk pay and split a bill, wallet cleanup and health, watchlist with price alerts, and a journal with CSV export.
// Everything signs in this browser; alerts run while Starsky is open.
import * as xrpl from 'xrpl';
import { ctx } from './ctx.ts';
import { esc, fmt, short, akey, fromKey, NATIVE, isNative, amtTx, type Asset } from './util.ts';
import * as M from './market.ts';
import * as PM from './procmodal.ts';

const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const net = () => (ctx.netKey() === 'test' ? 'test' : 'main');
const rd = (k: string, d: any) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const wr = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } };
const GREEN = '#3ddc84', RED = '#ff5b5b', AMB = '#f5b84b';
const chip = (t: string, c: string) => `<span style="display:inline-block;padding:.08rem .5rem;border-radius:99px;font-size:.78rem;background:${c}22;color:${c}">${esc(t)}</span>`;
const tile = (k: string, v: string, sub = '') => `<div class="tile" style="min-width:9rem;flex:1"><div class="mut" style="font-size:.8rem">${esc(k)}</div><div style="font-size:1.2rem;font-weight:800;margin:.1rem 0">${v}</div><div class="mut" style="font-size:.78rem">${sub}</div></div>`;
type VW = 'bulk' | 'orders' | 'protect' | 'clean' | 'watch' | 'journal';
let VIEW = 'bulk' as VW;
const TABS: [VW, string][] = [['bulk', 'Bulk pay & split bill'], ['orders', 'Auto orders'], ['protect', 'Protect & co-sign'], ['clean', 'Cleanup & health'], ['watch', 'Watchlist & alerts'], ['journal', 'Journal']];

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


// ---------- automatic orders (pure decision logic, tested) ----------
export interface Order { id: string; kind: 'stop' | 'take' | 'trail' | 'dca'; key: string; label: string; amt: number; trig: number; trailPct: number; high: number; slip: number; every: number; spend: number; runs: number; maxRuns: number; last: number; state: 'active' | 'busy' | 'done' | 'failed'; msg: string }
/** price = native per 1 token. Returns whether the order should run now, and the order with its tracking updated. */
export function orderCheck(o: Order, px: number | null, now: number): { fire: boolean; o: Order } {
  const n = { ...o }; if (n.state !== 'active') return { fire: false, o: n };
  if (n.kind === 'dca') { const due = now - n.last >= n.every * 60000; return { fire: due && (n.maxRuns <= 0 || n.runs < n.maxRuns), o: n }; }
  if (px == null || !(px > 0)) return { fire: false, o: n };
  if (n.kind === 'stop') return { fire: px <= n.trig, o: n };
  if (n.kind === 'take') return { fire: px >= n.trig, o: n };
  n.high = Math.max(n.high || 0, px); return { fire: px <= n.high * (1 - n.trailPct / 100), o: n };
}
export function sellAllPlan(lines: { currency: string; account: string; balance: string }[], px: (k: string) => number | null, minNative = 0.01): { key: string; bal: number; value: number }[] {
  return lines.map(l => { const k = l.currency + '|' + l.account, b = Number(l.balance), p = px(k); return { key: k, bal: b, value: p != null ? b * p : 0 }; }).filter(r => r.bal > 0 && r.value >= minNative).sort((a, b) => b.value - a.value);
}
const OK = () => `starsky.toolkit.orders.${net()}`; const ORD = (): Order[] => rd(OK(), []); const saveOrd = (o: Order[]) => wr(OK(), o);
async function execSwap(from: Asset, to: Asset, x: number, slip: number): Promise<{ ok: boolean; msg: string }> {
  const acc = ctx.account(); if (!acc) return { ok: false, msg: 'Wallet is locked' };
  try {
    const refs = await M.poolRefs(), ms = M.marketsFrom(refs); const m = ms.find((q: any) => (akey(q.base) === akey(from) && akey(q.quote) === akey(to)) || (akey(q.base) === akey(to) && akey(q.quote) === akey(from))); if (!m) return { ok: false, msg: 'No market for this pair' };
    const side: 'buy' | 'sell' = akey(m.quote) === akey(from) ? 'buy' : 'sell', q = await M.quote(m, side, x); if (!q) return { ok: false, msg: 'Not enough liquidity' };
    await readWallet(); if (!isNative(to) && !LINES.some((l: any) => l.currency === to.c && l.account === to.i)) { const t = await ctx.submit({ TransactionType: 'TrustSet', Account: acc, LimitAmount: { currency: to.c, issuer: to.i, value: '1000000000000' } }); if (!t.ok) return { ok: false, msg: t.msg || 'Could not add the trust line' }; }
    const r = await ctx.submit({ TransactionType: 'OfferCreate', Account: acc, TakerGets: amtTx(from, x), TakerPays: amtTx(to, q.out * (1 - slip / 100)), Flags: 0x00080000 | 0x00020000 }); return { ok: !!r.ok, msg: r.ok ? 'Done' : r.msg || 'Rejected' };
  } catch (e: any) { return { ok: false, msg: String(e?.message || e) }; }
}
async function ordersTick() {
  const os = ORD(); if (!os.some(o => o.state === 'active') || !ctx.account() || !ctx.online()) return;
  let snap: M.Snap | null = WSNAP; try { snap = await M.snapshot(); WSNAP = snap; } catch { return; } let ch = false;
  for (let i = 0; i < os.length; i++) {
    const px = os[i].key === 'native' ? 1 : (snap.px.get(os[i].key) as number | undefined) ?? null, r = orderCheck(os[i], px ?? null, Date.now()); os[i] = r.o; if (!r.fire) { if (r.o.high !== (ORD()[i] || ({} as any)).high) ch = true; continue; }
    os[i].state = 'busy'; saveOrd(os); const tok = fromKey(os[i].key); await readWallet(); let res: { ok: boolean; msg: string };
    if (os[i].kind === 'dca') { const spend = Math.min(os[i].spend, balOf(NATIVE)); res = spend > 0 ? await execSwap(NATIVE, tok, spend, os[i].slip) : { ok: false, msg: 'Not enough ' + ctx.native() }; os[i].last = Date.now(); if (res.ok) os[i].runs++; os[i].state = res.ok && (os[i].maxRuns <= 0 || os[i].runs < os[i].maxRuns) ? 'active' : res.ok ? 'done' : 'active'; os[i].msg = res.ok ? `Bought on ${new Date().toLocaleString()}` : 'Skipped: ' + res.msg; }
    else { const x = Math.min(os[i].amt > 0 ? os[i].amt : Infinity, balOf(tok)); res = x > 0 ? await execSwap(tok, NATIVE, x, os[i].slip) : { ok: false, msg: 'Nothing to sell' }; os[i].state = res.ok ? 'done' : 'failed'; os[i].msg = res.ok ? 'Sold ' + fmt(x) + ' ' + os[i].label + ' on ' + new Date().toLocaleString() : 'Could not sell: ' + res.msg; }
    ctx.toast(`${os[i].label}: ${os[i].msg}`, !res.ok); ch = true; saveOrd(os);
  }
  if (ch) saveOrd(os); if (document.getElementById('tk_root') && VIEW === 'orders') paint();
}
async function addOrder() {
  const g = (id: string) => $(id)?.value || '', kind = g('od_kind') as Order['kind'], key = g('od_tok'), sel = $('od_tok') as any, label = sel && sel.selectedOptions[0] ? sel.selectedOptions[0].text : key;
  const o: Order = { id: Math.random().toString(36).slice(2, 9), kind, key, label, amt: Number(g('od_amt')) || 0, trig: Number(g('od_trig')) || 0, trailPct: Number(g('od_trail')) || 0, high: 0, slip: Math.min(10, Math.max(0.1, Number(g('od_slip')) || 2)), every: Number(g('od_every')) || 60, spend: Number(g('od_spend')) || 0, runs: 0, maxRuns: Number(g('od_max')) || 0, last: 0, state: 'active', msg: '' };
  if (kind === 'dca') { if (!(o.spend > 0)) return ctx.toast('Enter how much ' + ctx.native() + ' to spend each time.', true); o.last = Date.now(); }
  else { if (!(o.amt >= 0)) return ctx.toast('Enter an amount to sell (0 = everything you hold).', true); if (kind === 'trail' ? !(o.trailPct > 0 && o.trailPct < 100) : !(o.trig > 0)) return ctx.toast(kind === 'trail' ? 'Enter a trailing percent between 0 and 100.' : 'Enter a trigger price in ' + ctx.native() + '.', true); }
  const what = kind === 'dca' ? `Buy ${fmt(o.spend)} ${ctx.native()} worth of ${label} every ${o.every} min` : kind === 'trail' ? `Sell ${o.amt > 0 ? fmt(o.amt) : 'all'} ${label} if the price falls ${o.trailPct}% from its high` : `Sell ${o.amt > 0 ? fmt(o.amt) : 'all'} ${label} when the price ${kind === 'stop' ? 'falls to' : 'rises to'} ${o.trig} ${ctx.native()}`;
  const ok = await PM.review({ title: 'Create automatic order', tone: 'tip', hero: `<div style="font-weight:700">${esc(what)}</div>`, rows: [{ k: 'Max slippage', v: o.slip + '%' }], warns: ['This runs only while Starsky is open and unlocked in this browser. It signs with this wallet without asking again.'], confirm: 'Create order' }); if (!ok) return;
  const os = ORD(); os.push(o); saveOrd(os); paint();
}
async function sellAll() {
  await readWallet(); const snap = await M.snapshot(); WSNAP = snap; const plan = sellAllPlan(LINES, k => (snap.px.get(k) as number | undefined) ?? null); if (!plan.length) return ctx.toast('Nothing to sell: no token worth more than 0.01 ' + ctx.native() + '.');
  const tot = plan.reduce((a, r) => a + r.value, 0), ok = await PM.review({ title: 'Sell everything to ' + ctx.native(), tone: 'sell', hero: `<div style="font-size:1.4rem;font-weight:800">≈ ${fmt(tot)} ${esc(ctx.native())}</div><div class="mut">${plan.length} tokens, each swapped at the best route with 2% max slippage.</div>`, rows: plan.slice(0, 6).map(r => ({ k: M.labelOf(fromKey(r.key)), v: fmt(r.bal) })), warns: ['Tokens with thin liquidity may not fill. Those are skipped.'], confirm: 'Sell all' }); if (!ok) return;
  const prog = PM.progress('Selling', plan.map(r => M.labelOf(fromKey(r.key)))); let n = 0; for (let i = 0; i < plan.length; i++) { prog.set(i, 'run'); const r = await execSwap(fromKey(plan[i].key), NATIVE, plan[i].bal, 2); if (r.ok) { n++; prog.set(i, 'ok'); } else prog.set(i, 'bad', r.msg.slice(0, 50)); } prog.done(`${n} of ${plan.length} sold`); await readWallet(); paint();
}
function ordersHtml(): string {
  const os = ORD(), held = LINES.map((l: any) => [l.currency + '|' + l.account, M.labelOf({ c: l.currency, i: l.account })]);
  return `<div class="card c12"><div class="k">Automatic orders</div><div class="mut" style="font-size:.82rem;margin:.2rem 0 .5rem">Prices are in ${esc(ctx.native())} per token. Orders are checked every minute while Starsky is open and unlocked.</div>
  <div class="row" style="gap:.5rem;flex-wrap:wrap;align-items:center"><select id="od_kind"><option value="stop">Stop-loss: sell if price falls to</option><option value="take">Take-profit: sell if price rises to</option><option value="trail">Trailing stop: sell if price drops % from its high</option><option value="dca">Buy on a schedule</option></select><select id="od_tok">${held.map(h => `<option value="${esc(h[0])}">${esc(h[1])}</option>`).join('')}</select>
  <input id="od_amt" placeholder="amount to sell (0 = all)" size="14"><input id="od_trig" placeholder="trigger price" size="10"><input id="od_trail" placeholder="trail %" size="6"><input id="od_spend" placeholder="spend per buy" size="10"><input id="od_every" placeholder="every (min)" size="8" value="60"><input id="od_max" placeholder="max buys (0=no limit)" size="10"><input id="od_slip" placeholder="slippage %" size="6" value="2"><button class="pri" onclick="window.tkt.addOrder()">Create order</button></div>
  ${os.length ? `<table style="width:100%;margin-top:.6rem">${os.map((o, i) => `<tr><td>${esc(o.kind === 'dca' ? `Buy ${o.label} every ${o.every} min` : o.kind === 'trail' ? `Trailing ${o.trailPct}% on ${o.label}` : `${o.kind === 'stop' ? 'Stop-loss' : 'Take-profit'} ${o.label} at ${o.trig}`)}</td><td>${chip(o.state, o.state === 'done' ? GREEN : o.state === 'failed' ? RED : AMB)}${o.kind === 'dca' ? ` <span class="mut">${o.runs}${o.maxRuns > 0 ? '/' + o.maxRuns : ''} buys</span>` : ''}</td><td class="mut">${esc(o.msg)}</td><td style="text-align:right"><button class="sm" onclick="window.tkt.rmOrder(${i})">Remove</button></td></tr>`).join('')}</table>` : '<div class="mut" style="margin-top:.6rem">No automatic orders.</div>'}</div>
  <div class="card c12" style="margin-top:.6rem"><div class="k">Sell everything</div><div class="mut" style="font-size:.82rem;margin:.2rem 0 .5rem">Swaps every token you hold into ${esc(ctx.native())}. You review it first.</div><button class="sm" onclick="window.tkt.sellAll()">Sell all tokens to ${esc(ctx.native())}</button></div>`;
}


// ---------- protect: delayed sends and co-signers ----------
export function validSigners(txt: string, quorum: number, self?: string): { entries: { a: string; w: number }[]; err: string } {
  const entries: { a: string; w: number }[] = [], seen = new Set<string>();
  for (const ln of txt.split(/\n+/)) { const p = ln.trim().split(/[\s,;]+/).filter(Boolean); if (!p.length) continue; const w = p[1] != null ? Number(p[1]) : 1; if (!/^r[1-9A-HJ-NP-Za-km-z]{20,}$/.test(p[0])) return { entries: [], err: `${p[0]} is not a valid address` }; if (self && p[0] === self) return { entries: [], err: 'Do not list this wallet as its own co-signer' }; if (seen.has(p[0])) return { entries: [], err: p[0] + ' is listed twice' }; if (!(Number.isInteger(w) && w >= 1 && w <= 65535)) return { entries: [], err: 'Weights are whole numbers from 1 up' }; seen.add(p[0]); entries.push({ a: p[0], w }); }
  if (entries.length < 1) return { entries, err: 'Add at least one co-signer' }; if (entries.length > 32) return { entries, err: 'At most 32 co-signers' };
  const tot = entries.reduce((x, e) => x + e.w, 0); if (!(Number.isInteger(quorum) && quorum >= 1)) return { entries, err: 'Quorum must be a whole number from 1 up' }; if (quorum > tot) return { entries, err: `Quorum ${quorum} is more than the total weight ${tot}: nobody could ever sign` };
  return { entries, err: '' };
}
export function combineSigned(blobs: string[]): string { const b = blobs.map(x => x.trim()).filter(Boolean); if (b.length < 1) throw new Error('Paste at least one signed copy'); return xrpl.multisign(b); }
const DK = () => `starsky.toolkit.delayed.${net()}`; interface Delayed { id: string; to: string; key: string; label: string; amt: number; at: number; state: 'waiting' | 'sent' | 'failed' | 'cancelled'; msg: string }
const DL = (): Delayed[] => rd(DK(), []); const saveDl = (d: Delayed[]) => wr(DK(), d);
export function dueDelayed(d: Delayed[], now: number): Delayed[] { return d.filter(x => x.state === 'waiting' && x.at <= now); }
async function delayedTick() { const d = DL(), due = dueDelayed(d, Date.now()); if (!due.length || !ctx.account() || !ctx.online()) return; await readWallet(); for (const x of due) { x.state = 'sent'; saveDl(d); const a: Asset = fromKey(x.key); try { const r = await ctx.submit({ TransactionType: 'Payment', Account: ctx.account()!, Destination: ctx.toClassic(x.to), Amount: amtTx(a, x.amt) }); x.state = r.ok ? 'sent' : 'failed'; x.msg = r.ok ? 'Sent ' + new Date().toLocaleString() : r.msg || 'Rejected'; } catch (e: any) { x.state = 'failed'; x.msg = String(e?.message || e); } ctx.toast(`Delayed payment to ${short(x.to)}: ${x.msg}`, x.state === 'failed'); saveDl(d); } if (document.getElementById('tk_root') && VIEW === 'protect') paint(); }
async function addDelayed() {
  const g = (id: string) => $(id)?.value || '', to = g('dl_to').trim(), amt = Number(g('dl_amt')), mins = Number(g('dl_min')), key = g('dl_tok') || 'native';
  if (!/^(r|X|L|T|M)[1-9A-HJ-NP-Za-km-z]{20,}$/.test(to)) return ctx.toast('Paste the full wallet address.', true); if (!(amt > 0)) return ctx.toast('Enter an amount.', true); if (!(mins >= 1 && mins <= 10080)) return ctx.toast('Delay must be 1 minute to 7 days.', true);
  const label = key === 'native' ? ctx.native() : M.labelOf(fromKey(key)), ok = await PM.review({ title: 'Schedule a delayed payment', tone: 'tip', hero: `<div style="font-size:1.3rem;font-weight:800">${fmt(amt)} ${esc(label)}</div><div class="mut">to ${esc(short(to))} in ${mins} min</div>`, rows: [{ k: 'You can cancel until', v: new Date(Date.now() + mins * 60000).toLocaleString() }], warns: ['The payment is sent only while Starsky is open and unlocked at that time. If it is closed, it goes out the next time you open it.'], confirm: 'Schedule' }); if (!ok) return;
  const d = DL(); d.push({ id: Math.random().toString(36).slice(2, 9), to, key, label, amt, at: Date.now() + mins * 60000, state: 'waiting', msg: '' }); saveDl(d); paint();
}
let SIG: { list: { a: string; w: number }[]; q: number } | null = null, PMSG = '', OUTB = '';
async function readSigners() { const acc = ctx.account(); if (!acc) return; const r: any = await ctx.req('account_objects', { account: acc, type: 'signer_list', ledger_index: 'validated' }).catch(() => null); const s = r?.account_objects?.[0]; SIG = s ? { list: (s.SignerEntries || []).map((e: any) => ({ a: (e.SignerEntry || e).Account, w: (e.SignerEntry || e).SignerWeight })), q: s.SignerQuorum } : null; }
async function setSigners() {
  const acc = ctx.account()!, q = Number($('sg_q')?.value), v = validSigners($('sg_list')?.value || '', q, acc); if (v.err) return ctx.toast(v.err, true);
  const ok = await PM.review({ title: 'Set co-signers', tone: 'lev', hero: `<div style="font-weight:700">${v.entries.length} co-signers, quorum ${q}</div>`, rows: v.entries.map(e => ({ k: short(e.a), v: 'weight ' + e.w })), warns: ['After this, payments from this wallet can ALSO be approved by enough co-signers together. Your own key still works unless you disable it separately. Test with a small payment first.'], confirm: 'Save co-signers' }); if (!ok) return;
  const r = await ctx.submit({ TransactionType: 'SignerListSet', Account: acc, SignerQuorum: q, SignerEntries: v.entries.map(e => ({ SignerEntry: { Account: e.a, SignerWeight: e.w } })) }); ctx.toast(r.ok ? 'Co-signers saved' : r.msg || 'Rejected', !r.ok); await readSigners(); paint();
}
async function clearSigners() { if (!confirm('Remove all co-signers from this wallet?')) return; const r = await ctx.submit({ TransactionType: 'SignerListSet', Account: ctx.account()!, SignerQuorum: 0 }); ctx.toast(r.ok ? 'Co-signers removed' : r.msg || 'Rejected', !r.ok); await readSigners(); paint(); }
async function coSign() {
  const g = (id: string) => $(id)?.value || '', from = g('ms_from').trim(), to = g('ms_to').trim(), amt = Number(g('ms_amt')), me = g('ms_me'), raw = g('ms_tx').trim(); PMSG = '';
  try {
    const w = ctx.wallets().find((x: any) => x.address === me); if (!w) throw new Error('Pick one of your wallets to sign with');
    const sw = xrpl.Wallet.fromSeed(w.seed); let tx: any;
    if (raw) { tx = JSON.parse(raw); } else {
      if (!/^r[1-9A-HJ-NP-Za-km-z]{20,}$/.test(from) || !/^(r|X|L|T|M)[1-9A-HJ-NP-Za-km-z]{20,}$/.test(to) || !(amt > 0)) throw new Error('Enter the wallet to pay from, the recipient and an amount.');
      const [ai, si, fe] = await Promise.all([ctx.req('account_info', { account: from, ledger_index: 'current' }), ctx.req('server_info', {}), ctx.req('fee', {})]); const info = si.info, nid = info.network_id;
      tx = { TransactionType: 'Payment', Account: from, Destination: ctx.toClassic(to), Amount: String(Math.round(amt * 1e6)), Sequence: ai.account_data.Sequence, Fee: String(Math.ceil(Number(fe.drops?.base_fee || 10) * 4 * 2)), LastLedgerSequence: info.validated_ledger.seq + 500, SigningPubKey: '' }; if (nid && nid > 1024) tx.NetworkID = nid;
    }
    const s = sw.sign(tx, true); OUTB = s.tx_blob; PMSG = `<div style="color:${GREEN}">Signed with ${esc(short(sw.classicAddress))}.</div><div class="mut" style="margin-top:.3rem">Send this signed copy to the other co-signers. Each one adds their own signature to the same payment details, then you combine them below.</div><textarea readonly rows="4" style="width:100%;margin-top:.3rem" onclick="this.select()">${esc(s.tx_blob)}</textarea><div class="mut" style="margin-top:.3rem">Payment details (paste this into "Payment details" for the next co-signer):</div><textarea readonly rows="4" style="width:100%" onclick="this.select()">${esc(JSON.stringify(tx))}</textarea>`;
  } catch (e: any) { PMSG = `<div style="color:${RED}">${esc(String(e?.message || e))}</div>`; } paint();
}
async function combineSend() { try { const blob = combineSigned(($('ms_blobs')?.value || '').split(/\s+/)); const r: any = await ctx.req('submit', { tx_blob: blob }); const ok = r.engine_result === 'tesSUCCESS' || r.engine_result === 'terQUEUED'; PMSG = `<div style="color:${ok ? GREEN : RED}">${ok ? 'Submitted. It should appear in History shortly.' : 'The network refused it: ' + esc(r.engine_result_message || r.engine_result || 'unknown')}</div>`; } catch (e: any) { PMSG = `<div style="color:${RED}">${esc(String(e?.message || e))}</div>`; } paint(); }
function protectHtml(): string {
  const d = DL(), mine = ctx.wallets();
  return `<div class="card c12"><div class="k">Delayed payment with a cancel window</div><div class="mut" style="font-size:.82rem;margin:.2rem 0 .5rem">Schedule a payment to go out later. Cancel it any time before it leaves.</div><div class="row" style="gap:.5rem;flex-wrap:wrap"><input id="dl_to" placeholder="recipient address" size="34"><input id="dl_amt" placeholder="amount" size="8"><select id="dl_tok"><option value="native">${esc(ctx.native())}</option>${LINES.filter((l: any) => Number(l.balance) > 0).map((l: any) => `<option value="${esc(l.currency + '|' + l.account)}">${esc(M.labelOf({ c: l.currency, i: l.account }))}</option>`).join('')}</select><input id="dl_min" placeholder="minutes from now" size="10" value="60"><button class="pri" onclick="window.tkt.addDelayed()">Schedule</button></div>
  ${d.length ? `<table style="width:100%;margin-top:.6rem">${d.map((x, i) => `<tr><td>${fmt(x.amt)} ${esc(x.label)} to ${esc(short(x.to))}</td><td class="mut">${new Date(x.at).toLocaleString()}</td><td>${chip(x.state, x.state === 'sent' ? GREEN : x.state === 'failed' ? RED : AMB)}</td><td class="mut">${esc(x.msg)}</td><td style="text-align:right">${x.state === 'waiting' ? `<button class="sm" onclick="window.tkt.cancelDelayed(${i})">Cancel</button>` : ''}</td></tr>`).join('')}</table>` : ''}</div>
  <div class="card c12" style="margin-top:.6rem"><div class="k">Co-signers and recovery</div><div class="mut" style="font-size:.82rem;margin:.2rem 0 .5rem">Let other wallets approve payments from this wallet together (multi-signature). Trusted contacts can also act as a recovery group. ${SIG ? `<b>Now:</b> ${SIG.list.length} co-signers, quorum ${SIG.q}.` : 'No co-signers set.'}</div>
  <textarea id="sg_list" rows="4" style="width:100%" placeholder="one co-signer per line: address, weight">${esc(SIG ? SIG.list.map(e => e.a + ', ' + e.w).join('\n') : '')}</textarea><div class="row" style="gap:.5rem;margin-top:.4rem;align-items:center"><input id="sg_q" placeholder="weight needed (quorum)" size="10" value="${SIG ? SIG.q : ''}"><button class="pri" onclick="window.tkt.setSigners()">Save co-signers</button>${SIG ? '<button class="sm" onclick="window.tkt.clearSigners()">Remove all</button>' : ''}</div></div>
  <div class="card c12" style="margin-top:.6rem"><div class="k">Approve a payment together</div><div class="mut" style="font-size:.82rem;margin:.2rem 0 .5rem">Step 1: each co-signer signs the same payment here. Step 2: paste all signed copies below and send.</div><div class="row" style="gap:.5rem;flex-wrap:wrap"><select id="ms_me">${mine.map((w: any) => `<option value="${esc(w.address)}">${esc(w.label)} (${esc(short(w.address))})</option>`).join('')}</select><input id="ms_from" placeholder="shared wallet to pay from" size="30"><input id="ms_to" placeholder="pay to" size="30"><input id="ms_amt" placeholder="LUMA" size="8"></div><textarea id="ms_tx" rows="2" style="width:100%;margin-top:.4rem" placeholder="Payment details from another co-signer (leave empty to start a new payment)"></textarea><button class="pri" style="margin-top:.4rem" onclick="window.tkt.coSign()">Sign</button>
  <textarea id="ms_blobs" rows="3" style="width:100%;margin-top:.6rem" placeholder="Paste every co-signer's signed copy, one per line"></textarea><button class="pri" style="margin-top:.4rem" onclick="window.tkt.combine()">Combine and send</button><div style="margin-top:.6rem">${PMSG}</div></div>`;
}

// ---------- page ----------
export function shell() { return `<div id="tk_root" style="width:100%"><div class="row" id="tk_tabs" style="gap:.4rem;margin-bottom:.7rem;flex-wrap:wrap"></div><div id="tk_body" class="grid" style="width:100%"></div></div>`; }
function paint() {
  const t = document.getElementById('tk_tabs'), b = document.getElementById('tk_body'); if (!t || !b) return;
  t.innerHTML = TABS.map(([k, l]) => `<button class="sm ${VIEW === k ? 'pri' : ''}" onclick="window.tkt.view('${k}')">${l}</button>`).join('');
  const a = document.activeElement; if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) && b.contains(a)) return;
  b.innerHTML = VIEW === 'bulk' ? bulkHtml() : VIEW === 'orders' ? ordersHtml() : VIEW === 'protect' ? protectHtml() : VIEW === 'clean' ? cleanHtml() : VIEW === 'watch' ? watchHtml() : journalHtml();
}
async function refresh() { if (busy) return; busy = true; try { await readWallet(); if (VIEW === 'journal') await journalLoad(); if (VIEW === 'watch') await watchTick(); if (VIEW === 'orders') await ordersTick(); if (VIEW === 'protect') { await readSigners(); await delayedTick(); } } finally { busy = false; paint(); } }
export function view(v: VW) { VIEW = v; MSG = ''; paint(); void refresh(); }
export function mount() { paint(); void refresh(); }
export function start() { clearInterval(tmr); tmr = setInterval(() => { void watchTick(); void ordersTick(); void delayedTick(); }, 30000); }
export const api = {
  addOrder, sellAll, rmOrder(i: number) { const os = ORD(); os.splice(i, 1); saveOrd(os); paint(); },
  addDelayed, cancelDelayed(i: number) { const d = DL(); if (d[i] && d[i].state === 'waiting') d[i].state = 'cancelled'; saveDl(d); paint(); }, setSigners, clearSigners, coSign, combine: combineSend,
  view, preview: bulkPreview, send: bulkSend, clean: cleanLines, csv: journalCsv,
  watch() { const k = $('tk_w')?.value; if (!k) return; const w = WL(); if (!w.includes(k)) w.push(k); wr(WK(), w); paint(); },
  unwatch(k: string) { wr(WK(), WL().filter(x => x !== k)); paint(); },
  alert() { const k = $('tk_ak')?.value || '', d = ($('tk_ad')?.value || 'above') as 'above' | 'below', p = Number($('tk_ap')?.value); if (!(p > 0)) return ctx.toast('Enter a price in USD.', true); const sel = $('tk_ak') as any, label = sel && sel.selectedOptions[0] ? sel.selectedOptions[0].text : k; const al = AL(); al.push({ key: k, label, dir: d, price: p, fired: 0 }); wr(AK(), al); try { if ((window as any).Notification && Notification.permission === 'default') void Notification.requestPermission(); } catch { /* ignore */ } paint(); },
  rmAlert(i: number) { const al = AL(); al.splice(i, 1); wr(AK(), al); paint(); },
};
