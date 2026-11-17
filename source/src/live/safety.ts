// Safety and tools: checks a payment before it is signed (simulation), warns about look-alike and first-time recipients,
// reserve planner, token risk from the indexer, payment links, watch-only wallets, cost-basis export, accessibility and developer mode.
// Everything that decides something is a pure function (exported) so it can be tested without a browser.
import { ctx } from './ctx.ts';
import { esc } from './util.ts';

export interface Finding { level: 'block' | 'warn' | 'info'; code: string; msg: string }
const LS = (k: string, d: any) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const SV = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ---------- pure helpers ----------
/** edit distance, capped: used to spot an address that is almost, but not exactly, one you know */
export function distance(a: string, b: string, cap = 6): number {
  if (a === b) return 0; if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const cur = [i]; let min = i; for (let j = 1; j <= b.length; j++) { const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); cur.push(v); if (v < min) min = v; } if (min > cap) return cap + 1; prev = cur; }
  return prev[b.length];
}
/** an address that shares its start and end with a saved contact but is not that contact: the classic "address poisoning" trick */
export function lookalike(addr: string, known: Array<{ name: string; addr: string }>): { name: string; addr: string } | null {
  if (!addr) return null;
  for (const k of known) { if (!k.addr || k.addr === addr) continue; if (k.addr.slice(0, 5) === addr.slice(0, 5) && k.addr.slice(-4) === addr.slice(-4)) return k; if (k.addr.length === addr.length && distance(k.addr, addr, 3) <= 3) return k; }
  return null;
}
/** reserve in LUMA for an account: base + owner count * increment */
export const reserveOf = (base: number, inc: number, owners: number) => base + inc * owners;
export function spendable(balance: number, base: number, inc: number, owners: number, fee = 0.00001) { return Math.max(0, balance - reserveOf(base, inc, owners) - fee); }

export interface PreflightIn {
  tx: any; native: string; balance: number | null; base: number; inc: number; owners: number;
  destExists: boolean | null; destRequiresTag: boolean | null; destDepositAuth?: boolean; trusted?: boolean | null; known: Array<{ name: string; addr: string }>;
  sent: string[]; scam: string[]; self: string;
}
/** Decide what to tell the person before a payment is signed. Pure: all facts are passed in. */
export function preflightCheck(i: PreflightIn): Finding[] {
  const out: Finding[] = [], tx = i.tx; if (tx.TransactionType !== 'Payment') return out;
  const dest: string = tx.Destination, nat = typeof tx.Amount === 'string', amt = nat ? Number(tx.Amount) / 1e6 : Number(tx.Amount?.value);
  if (dest === i.self) out.push({ level: 'block', code: 'self', msg: 'You are sending to your own address.' });
  if (i.scam.includes(dest)) out.push({ level: 'block', code: 'scam', msg: 'This address is on the network operator\'s warning list. Do not send.' });
  if (nat && i.balance != null) {
    const free = spendable(i.balance, i.base, i.inc, i.owners);
    if (amt > free) out.push({ level: 'block', code: 'funds', msg: `You can send at most ${free.toFixed(6)} ${i.native}: the rest is the account reserve (${reserveOf(i.base, i.inc, i.owners)} ${i.native}) that the network keeps locked.` });
    else if (free - amt < 1) out.push({ level: 'info', code: 'low', msg: `After this you will have about ${(free - amt).toFixed(2)} ${i.native} left to spend.` });
  }
  if (nat && i.destExists === false && amt < i.base) out.push({ level: 'block', code: 'newacct', msg: `This address is not active yet. A first payment must be at least ${i.base} ${i.native} to create it.` });
  if (i.destRequiresTag && tx.DestinationTag == null) out.push({ level: 'block', code: 'tag', msg: 'This recipient requires a destination tag (exchanges usually do). Without it the money may be lost.' });
  if (!nat && i.trusted === false) out.push({ level: 'block', code: 'trust', msg: 'The recipient has not set up a trust line for this token, so the payment would fail.' });
  const la = lookalike(dest, i.known); if (la) out.push({ level: 'warn', code: 'lookalike', msg: `This address looks very similar to your saved contact "${la.name}" but is different. Scammers do this. Compare every character.` });
  else if (!i.sent.includes(dest) && !i.known.some(k => k.addr === dest)) out.push({ level: 'warn', code: 'first', msg: 'You have never sent to this address before.' });
  if (nat && i.balance != null && i.balance > 0 && amt >= i.balance * 0.9) out.push({ level: 'warn', code: 'big', msg: 'This is more than 90% of your balance.' });
  return out;
}

// ---------- payment links ----------
export interface PayReq { to: string; amount?: string; cur?: string; issuer?: string; tag?: number; memo?: string }
export function buildLink(r: PayReq, origin = ''): string {
  const q = new URLSearchParams(); q.set('to', r.to); if (r.amount) q.set('amt', r.amount); if (r.cur && r.cur !== 'native') { q.set('cur', r.cur); if (r.issuer) q.set('iss', r.issuer); } if (r.tag != null) q.set('tag', String(r.tag)); if (r.memo) q.set('memo', r.memo.slice(0, 80));
  return origin + '#pay?' + q.toString();
}
export function parseLink(s: string): PayReq | null {
  const m = /#pay\?(.*)$/.exec(String(s || '')) || /^pay\?(.*)$/.exec(String(s || '')); if (!m) return null; const q = new URLSearchParams(m[1]);
  const to = (q.get('to') || '').trim(); if (!/^[rLT][1-9A-HJ-NP-Za-km-z]{24,35}$/.test(to)) return null;
  const amt = q.get('amt'); if (amt != null && !/^\d+(\.\d{1,6})?$/.test(amt)) return null;
  const tag = q.get('tag'); if (tag != null && !/^\d{1,10}$/.test(tag)) return null; if (tag != null && Number(tag) > 4294967295) return null;
  return { to, amount: amt || undefined, cur: q.get('cur') || undefined, issuer: q.get('iss') || undefined, tag: tag != null ? Number(tag) : undefined, memo: (q.get('memo') || '').replace(/[<>]/g, '').slice(0, 80) || undefined };
}

// ---------- cost basis (average cost) ----------
export interface Fill { t: number; qty: number; price: number }   // qty > 0 buy, < 0 sell; price in the quote currency
export function costBasis(fills: Fill[]): { qty: number; avg: number; realized: number; rows: Array<{ t: number; qty: number; price: number; gain: number }> } {
  let qty = 0, cost = 0, realized = 0; const rows: any[] = [];
  for (const f of fills.slice().sort((a, b) => a.t - b.t)) {
    if (f.qty > 0) { cost += f.qty * f.price; qty += f.qty; rows.push({ ...f, gain: 0 }); }
    else { const s = Math.min(-f.qty, qty), avg = qty ? cost / qty : 0, g = s * (f.price - avg); realized += g; cost -= s * avg; qty -= s; rows.push({ ...f, gain: g }); }
  }
  return { qty, avg: qty ? cost / qty : 0, realized, rows };
}
export const toCsv = (rows: any[][]): string => rows.map(r => r.map(c => { const s = String(c ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');

// ---------- token risk from the indexer ----------
export function riskLabel(t: { holders?: number; gini?: number; mintedRecent?: number; supply?: number; liquidity?: number }): { level: 'low' | 'medium' | 'high'; reasons: string[] } {
  const r: string[] = []; let s = 0;
  if ((t.holders ?? 0) < 20) { s += 2; r.push('very few holders'); } else if ((t.holders ?? 0) < 100) { s += 1; r.push('few holders'); }
  if ((t.gini ?? 0) > 0.9) { s += 2; r.push('almost all of it is held by a few accounts'); } else if ((t.gini ?? 0) > 0.75) { s += 1; r.push('held by a small group'); }
  if (t.supply && t.mintedRecent && t.mintedRecent / t.supply > 0.2) { s += 2; r.push('a lot was created recently'); }
  if (t.liquidity != null && t.liquidity < 1000) { s += 1; r.push('thin liquidity: hard to sell'); }
  return { level: s >= 4 ? 'high' : s >= 2 ? 'medium' : 'low', reasons: r };
}

// ---------- reading the chain (thin wrappers over ctx.req) ----------
const base = () => ctx.nodeUrl().replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '').replace(/\/test$/, '');
const idx = () => base() + (ctx.netKey() === 'test' ? '/test' : '') + '/api/v1';

// ---------- token registry + network health (from the operator's public feed) ----------
export interface RegistryFeed { seq?: number; tokens?: Array<[string, string, string, string]>; blocked?: Array<[string, string]>; at?: number }
export interface HealthFeed { state?: string; headline?: string; detail?: string[]; at?: number }
export type TokenStatus = 'verified' | 'reviewed' | 'suspended' | 'unlisted' | 'unknown';
/** 'unknown' means the app has no registry to judge by (older operator, or the feed was never loaded), which must never look like a warning. */
export function tokenStatus(cur: string, iss: string, reg: RegistryFeed | null | undefined): TokenStatus {
  if (!reg || !(reg.seq || (reg.tokens && reg.tokens.length) || (reg.blocked && reg.blocked.length))) return 'unknown';
  if ((reg.blocked || []).some(b => b[0] === cur && b[1] === iss)) return 'suspended';
  const t = (reg.tokens || []).find(x => x[0] === cur && x[1] === iss); if (!t) return 'unlisted';
  return t[2] === 'verified' ? 'verified' : 'reviewed';
}
const tokensOf = (tx: any): Array<{ cur: string; iss: string; kind: 'trust' | 'pay' | 'offer' }> => {
  const o: Array<{ cur: string; iss: string; kind: 'trust' | 'pay' | 'offer' }> = [], tok = (a: any, kind: 'trust' | 'pay' | 'offer') => { if (a && typeof a === 'object' && a.currency && a.issuer) o.push({ cur: a.currency, iss: a.issuer, kind }); };
  if (tx?.TransactionType === 'TrustSet') tok(tx.LimitAmount, 'trust'); else if (tx?.TransactionType === 'Payment') tok(tx.Amount, 'pay'); else if (tx?.TransactionType === 'OfferCreate') { tok(tx.TakerGets, 'offer'); tok(tx.TakerPays, 'offer'); }
  return o;
};
export function networkFindings(tx: any, reg: RegistryFeed | null | undefined, health: HealthFeed | null | undefined, now = Date.now()): Finding[] {
  const out: Finding[] = [];
  for (const t of tokensOf(tx)) {
    const st = tokenStatus(t.cur, t.iss, reg);
    if (st === 'suspended') out.push({ level: 'block', code: 'tokenblocked', msg: 'The network operator has suspended this token. Do not accept, hold or trade it.' });
    else if (st === 'unlisted' && t.kind !== 'offer') out.push({ level: 'warn', code: 'tokenunlisted', msg: 'This token is not in the network\'s verified registry, so nobody has checked who issues it. Only continue if you trust the issuer.' });
  }
  if (health && health.at && now - health.at < 5 * 60e3) {
    if (health.state === 'outage') out.push({ level: 'warn', code: 'health', msg: `The network is reporting a major problem${health.headline ? ' (' + health.headline + ')' : ''}. Your transaction may not be confirmed.` });
    else if (health.state === 'degraded') out.push({ level: 'warn', code: 'health', msg: 'The network is running with reduced capacity, so this may be slow or need a retry.' });
    else if (health.state === 'maintenance') out.push({ level: 'warn', code: 'health', msg: `The network is in maintenance${health.headline ? ': ' + health.headline : ''}. Transactions may be slow.` });
  }
  return out;
}
const REGK = 'starsky.x.registry', HLTK = 'starsky.x.health';
export function setRegistry(r: any) { if (!r || typeof r !== 'object') return; SV(REGK, { seq: +r.seq || 0, tokens: (Array.isArray(r.tokens) ? r.tokens : []).filter((x: any) => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string').slice(0, 400).map((x: any) => [x[0], x[1], String(x[2] || ''), String(x[3] || '').slice(0, 60)]), blocked: (Array.isArray(r.blocked) ? r.blocked : []).filter((x: any) => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string').slice(0, 400).map((x: any) => [x[0], x[1]]), at: Date.now() }); }
export function setHealth(h: any) { if (!h || typeof h !== 'object') return; SV(HLTK, { state: String(h.state || ''), headline: String(h.headline || '').slice(0, 120), detail: (Array.isArray(h.detail) ? h.detail : []).slice(0, 5).map((x: any) => String(x).slice(0, 160)), at: Date.now() }); }
export const registryNow = (): RegistryFeed | null => LS(REGK, null);
export const healthNow = (): HealthFeed | null => LS(HLTK, null);
/** small pill shown next to a token name */
const curLabel = (c: string) => { if (/^[0-9A-Fa-f]{40}$/.test(c || '')) { try { const t = c.match(/../g)!.map(h => parseInt(h, 16)).filter(n => n > 31 && n < 127).map(n => String.fromCharCode(n)).join('').trim(); return t || c.slice(0, 8); } catch { return c.slice(0, 8); } } return c; };
export function tokenBadge(cur: string, iss: string, reg: RegistryFeed | null | undefined = registryNow()): string {
  const st = tokenStatus(cur, iss, reg), pill = (t: string, bg: string, fg: string, tip: string) => `<span title="${tip.replace(/"/g, '&quot;')}" style="font-size:.68rem;padding:.05rem .4rem;border-radius:.6rem;background:${bg};color:${fg};margin-left:.35rem">${t}</span>`;
  if (st === 'verified') return pill('Verified', 'rgba(0,196,111,.18)', '#00c46f', 'The issuer proved control of its domain and the network operator listed it.');
  if (st === 'reviewed') return pill('Reviewed', 'rgba(120,160,255,.18)', '#8fb0ff', 'Approved by the network operator without a domain proof.');
  if (st === 'suspended') return pill('Suspended', 'rgba(248,81,73,.2)', '#f85149', 'The network operator suspended this token.');
  if (st === 'unlisted') return pill('Not verified', 'rgba(150,150,150,.18)', '#999', 'Not in the operator\'s verified registry. That does not mean it is unsafe, but nobody has checked it.');
  return '';
}
export async function indexerGet(path: string): Promise<any> { const r = await fetch(idx() + path); const j = await r.json().catch(() => null); if (!r.ok || !j || j.ok === false) throw new Error(j?.error?.message || 'indexer ' + r.status); return j; }
export async function tokenRisk(cur: string, issuer: string) {
  const [t, p] = await Promise.all([indexerGet(`/token/${encodeURIComponent(cur)}/${issuer}`), indexerGet(`/price/${encodeURIComponent(cur)}/${issuer}`).catch(() => null)]);
  const k = t.token || t; return { ...riskLabel({ holders: k.holders, gini: k.gini, supply: k.supply, mintedRecent: k.minted24h ?? k.mint24h, liquidity: p?.liquidityNative }), raw: k, price: p };
}
async function facts(tx: any): Promise<Omit<PreflightIn, 'tx' | 'known' | 'sent' | 'scam' | 'self' | 'native'>> {
  const me = tx.Account || ctx.account() || '', f: any = { balance: null, base: 10, inc: 2, owners: 0, destExists: null, destRequiresTag: null, destDepositAuth: false, trusted: null };
  try { const s = await ctx.req('server_info'); const v = s.info?.validated_ledger; if (v) { f.base = Number(v.reserve_base_xrp ?? f.base); f.inc = Number(v.reserve_inc_xrp ?? f.inc); } } catch {}
  try { const a = (await ctx.req('account_info', { account: me, ledger_index: 'validated' })).account_data; f.balance = Number(a.Balance) / 1e6; f.owners = a.OwnerCount || 0; } catch {}
  try { const d = (await ctx.req('account_info', { account: tx.Destination, ledger_index: 'validated' })).account_data; f.destExists = true; f.destRequiresTag = !!(d.Flags & 0x00020000); f.destDepositAuth = !!(d.Flags & 0x01000000); } catch (e: any) { if (/actNotFound/.test(String(e?.message || e))) f.destExists = false; }
  if (typeof tx.Amount === 'object' && tx.Amount?.issuer && f.destExists) { try { const l = (await ctx.req('account_lines', { account: tx.Destination, peer: tx.Amount.issuer })).lines || []; f.trusted = l.some((x: any) => x.currency === tx.Amount.currency); } catch {} }
  return f;
}
const SENT = 'starsky.x.sent', SCAM = 'starsky.x.scam';
export const markSent = (a: string) => { const l: string[] = LS(SENT, []); if (!l.includes(a)) { l.unshift(a); SV(SENT, l.slice(0, 500)); } };
export function setScamList(l: string[]) { SV(SCAM, l.filter(x => typeof x === 'string').slice(0, 5000)); }
export function devMode() { return !!LS('starsky.x.dev', false); }
/** Called by the send path. Returns an error message to stop, or '' to go ahead. Warnings need a yes from the person. */
export async function preflight(tx: any, askUser: (msg: string) => boolean = m => window.confirm(m)): Promise<string> {
  try {
    let found: Finding[] = networkFindings(tx, registryNow(), healthNow());
    if (tx?.TransactionType === 'Payment' && tx.Destination) {
      const f = await facts(tx);
      found = [...preflightCheck({ ...f, tx, native: ctx.native(), known: (ctx.book?.() || []).map(b => { try { return { name: b.name, addr: ctx.toClassic(b.addr) }; } catch { return { name: b.name, addr: String(b.addr || '') }; } }), sent: LS(SENT, []), scam: LS(SCAM, []), self: tx.Account || ctx.account() || '' }), ...found];
    }
    if (!found.length) return '';
    if (devMode()) console.info('[starsky preflight]', JSON.stringify({ tx, found }));
    const b = found.find(x => x.level === 'block'); if (b) return b.msg;
    const w = found.filter(x => x.level === 'warn'); if (w.length && !askUser('Check before sending:\n\n• ' + w.map(x => x.msg).join('\n• ') + '\n\nSend anyway?')) return 'Cancelled: nothing was sent.';
    return '';
  } catch { return ''; }   // the safety check must never be the reason a payment cannot go out
}

// ---------- watch-only wallets ----------
const WK = 'starsky.x.watch';
export const watchList = (): Array<{ label: string; addr: string }> => LS(WK, []);
export function watchAdd(label: string, addr: string): string { addr = ctx.toClassic(addr.trim()); if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr)) return 'That is not a valid address.'; const l = watchList(); if (l.some(x => x.addr === addr)) return 'Already watching this address.'; l.push({ label: label.trim().slice(0, 30) || addr.slice(0, 8), addr }); SV(WK, l.slice(0, 50)); return ''; }
export const watchDel = (addr: string) => SV(WK, watchList().filter(x => x.addr !== addr));

// ---------- accessibility ----------
const AK = 'starsky.x.a11y';
export const a11y = (): { scale: number; contrast: boolean; motion: boolean } => ({ scale: 1, contrast: false, motion: true, ...LS(AK, {}) });
export function applyA11y() { const a = a11y(), r = document.documentElement; r.style.fontSize = Math.round(16 * Math.min(1.6, Math.max(0.85, a.scale))) + 'px'; r.classList.toggle('xhc', a.contrast); r.classList.toggle('xnomotion', !a.motion); }
let styled = false;
function style() { if (styled) return; styled = true; const s = document.createElement('style'); s.textContent = '.xhc{--line:#fff}.xhc .card{border:2px solid #fff!important}.xhc .mut{opacity:1!important;color:#ddd!important}.xnomotion *{animation:none!important;transition:none!important}'; document.head.appendChild(s); }

// ---------- the card (Network tab) ----------
const $ = (id: string) => document.getElementById(id);
export async function card() {
  const view = $('view'); if (!view) return; style(); let box = $('xsafety'); if (!box) { box = document.createElement('div'); box.id = 'xsafety'; box.className = 'card'; box.style.marginBottom = '.8rem'; view.insertBefore(box, view.children[1] || null); }
  const a = a11y(), w = watchList(), me = ctx.account() || '';
  let res = '';
  try { const s = await ctx.req('server_info'), v = s.info?.validated_ledger || {}, base = Number(v.reserve_base_xrp ?? 10), inc = Number(v.reserve_inc_xrp ?? 2); const ai = (await ctx.req('account_info', { account: me, ledger_index: 'validated' })).account_data, bal = Number(ai.Balance) / 1e6, own = ai.OwnerCount || 0;
    res = `<div class="row" style="gap:1rem;flex-wrap:wrap"><div><div class="mut" style="font-size:.72rem">Balance</div><b>${bal.toLocaleString()} ${ctx.native()}</b></div><div><div class="mut" style="font-size:.72rem">Locked reserve</div><b>${reserveOf(base, inc, own)}</b></div><div><div class="mut" style="font-size:.72rem">You can send</div><b>${spendable(bal, base, inc, own).toFixed(2)}</b></div><div><div class="mut" style="font-size:.72rem">Each trust line, offer or NFT page locks</div><b>${inc}</b></div></div><div class="mut" style="font-size:.78rem;margin-top:.3rem">You have ${own} items on the ledger. Removing unused ones (empty trust lines, old offers) frees ${inc} ${ctx.native()} each.</div>`; } catch { res = '<div class="mut">Reserve details appear when the node answers.</div>'; }
  let netBox = ''; try {
    const h = healthNow(), fresh = h && h.at && Date.now() - h.at < 5 * 60e3, reg = registryNow(), col = !fresh ? '#999' : h!.state === 'ok' ? '#00c46f' : h!.state === 'outage' ? '#f85149' : '#d29922', lab = !fresh ? 'Status not available' : h!.state === 'ok' ? 'All systems operational' : (h!.headline || h!.state || '');
    let tk = ''; if (me) { const al = await ctx.req('account_lines', { account: me, ledger_index: 'validated', limit: 100 }).catch(() => null); const ls = (al && (al.lines || al.result?.lines)) || []; tk = ls.length ? ls.map((x: any) => `<div class="row" style="gap:.5rem;font-size:.82rem"><b>${esc(curLabel(x.currency))}</b>${tokenBadge(x.currency, x.account, reg)}<span class="mut" style="margin-left:auto">${esc(x.balance)}</span></div>`).join('') : '<div class="mut" style="font-size:.82rem">No tokens held.</div>'; }
    netBox = `<div style="margin-top:.8rem"><div class="k" style="font-size:.74rem">Network and your tokens</div><div class="row" style="gap:.5rem;align-items:center;font-size:.84rem"><span style="width:.6rem;height:.6rem;border-radius:50%;background:${col};display:inline-block"></span><b>${esc(lab)}</b>${fresh && h!.detail && h!.detail.length ? '<span class="mut">' + esc(h!.detail.join(' ')) + '</span>' : ''}</div><div style="margin-top:.4rem">${tk}</div><div class="mut" style="font-size:.74rem;margin-top:.3rem">Verified means the issuer proved it controls its domain and the network operator listed it. Not verified does not mean unsafe, only unchecked.</div></div>`;
  } catch {}
  const wl = await Promise.all(w.map(async x => { let b = '–'; try { b = (Number((await ctx.req('account_info', { account: x.addr, ledger_index: 'validated' })).account_data.Balance) / 1e6).toLocaleString(); } catch {} return `<div class="row" style="gap:.5rem;font-size:.82rem;margin:.2rem 0"><span class="grow">${esc(x.label)} <span class="mut" style="font-family:monospace">${esc(ctx.show(x.addr).slice(0, 8))}…</span></span><b>${esc(b)}</b><button class="sm ghost" onclick="window.xsafe.unwatch('${esc(x.addr)}')">Remove</button></div>`; }));
  box.innerHTML = `<div class="k" style="margin:0">Safety and tools</div><div style="margin-top:.5rem"><div class="k" style="font-size:.74rem">Reserve planner</div>${res}</div>
  ${netBox}<div style="margin-top:.8rem"><div class="k" style="font-size:.74rem">Watch-only wallets (no keys, view only)</div>${wl.join('') || '<div class="mut" style="font-size:.82rem">None yet.</div>'}<div class="row" style="gap:.4rem;margin-top:.3rem"><input id="xs_wl" placeholder="label" style="width:7rem"><input id="xs_wa" class="grow" placeholder="address"><button class="sm" onclick="window.xsafe.watch()">Watch</button></div></div>
  <div style="margin-top:.8rem"><div class="k" style="font-size:.74rem">Payment request link</div><div class="row" style="gap:.4rem;flex-wrap:wrap"><input id="xs_pa" placeholder="amount" style="width:7rem"><input id="xs_pt" placeholder="tag (optional)" style="width:8rem"><button class="sm" onclick="window.xsafe.link()">Make link</button></div><div id="xs_pl" style="font-family:monospace;font-size:.72rem;word-break:break-all;margin-top:.3rem"></div></div>
  <div style="margin-top:.8rem"><div class="k" style="font-size:.74rem">Display and accessibility</div><div class="row" style="gap:.8rem;flex-wrap:wrap;font-size:.82rem"><label>Text size <select onchange="window.xsafe.scale(this.value)">${[0.9, 1, 1.15, 1.3, 1.5].map(s => `<option value="${s}" ${a.scale === s ? 'selected' : ''}>${Math.round(s * 100)}%</option>`).join('')}</select></label><label><input type="checkbox" ${a.contrast ? 'checked' : ''} onchange="window.xsafe.contrast(this.checked)"> High contrast</label><label><input type="checkbox" ${a.motion ? '' : 'checked'} onchange="window.xsafe.motion(!this.checked)"> Reduce motion</label><label><input type="checkbox" ${devMode() ? 'checked' : ''} onchange="window.xsafe.dev(this.checked)"> Developer mode (log what is checked before each send)</label></div></div>
  <div style="margin-top:.8rem" class="mut"><span style="font-size:.8rem">Before every payment Starsky now checks: enough to spend after the reserve, recipient active, destination tag, trust line, look-alike and first-time recipients.</span></div>`;
}
(window as any).xsafe = {
  watch: () => { const e = watchAdd(($('xs_wl') as HTMLInputElement).value, ($('xs_wa') as HTMLInputElement).value); if (e) ctx.toast(e, true); else { ctx.toast('Watching'); card(); } },
  unwatch: (a: string) => { watchDel(a); card(); },
  link: () => { const amt = ($('xs_pa') as HTMLInputElement).value.trim(), tag = ($('xs_pt') as HTMLInputElement).value.trim(); const me = ctx.account(); if (!me) return; const l = buildLink({ to: ctx.show(me), amount: amt || undefined, tag: tag ? Number(tag) : undefined }, location.origin + location.pathname); const ok = parseLink(l); if (!ok) { ctx.toast('Check the amount and tag', true); return; } const o = $('xs_pl'); if (o) o.textContent = l; try { navigator.clipboard.writeText(l).then(() => ctx.toast('Link copied'), () => ctx.toast('Link ready: copy it from the box')); } catch {} },
  scale: (v: string) => { SV(AK, { ...a11y(), scale: Number(v) }); applyA11y(); },
  contrast: (v: boolean) => { SV(AK, { ...a11y(), contrast: v }); applyA11y(); },
  motion: (v: boolean) => { SV(AK, { ...a11y(), motion: v }); applyA11y(); },
  dev: (v: boolean) => SV('starsky.x.dev', v),
};
let payShown = false;
export const resetPay = () => { payShown = false; };
function showPayRequest() {
  if (payShown) return; const r = pendingPay(); if (!r || !ctx.account()) return; payShown = true; history.replaceState(null, '', location.pathname + location.search);
  const dest = ctx.toClassic(r.to), amt = r.amount ? `${esc(r.amount)} ${esc(r.cur || ctx.native())}` : '';
  (window as any).xsafePay = async () => { ctx.closeModal(); const tx: any = { TransactionType: 'Payment', Account: ctx.account(), Destination: dest, Amount: r.cur && r.cur !== 'native' && r.issuer ? { currency: r.cur, issuer: ctx.toClassic(r.issuer), value: r.amount } : String(Math.round(Number(r.amount) * 1e6)) }; if (r.tag != null) tx.DestinationTag = r.tag; const o = await ctx.submit(tx); ctx.toast(o.ok ? 'Payment sent' : (o.msg || 'Payment failed'), !o.ok); };
  ctx.modal(`<h3 style="margin-top:0">Payment request</h3><p>Someone asked you to pay${amt ? ' <b>' + amt + '</b>' : ''} to</p><p style="font-family:monospace;word-break:break-all">${esc(r.to)}</p>${r.tag != null ? '<p>Destination tag: <b>' + r.tag + '</b></p>' : ''}${r.memo ? '<p>Note: ' + esc(r.memo) + '</p>' : ''}<p class="mut">Check the address with the person who sent you this link before paying.</p><div class="row" style="gap:.5rem"><button class="sm" ${r.amount ? '' : 'disabled'} onclick="window.xsafePay()">Pay</button><button class="sm ghost" onclick="document.querySelector('[data-close]')?.click()">Cancel</button></div>${r.amount ? '' : '<p class="mut">This link has no amount: use the Send page.</p>'}`);
}
export function onRender(tab: string) { style(); applyA11y(); if (tab === 'network') card().catch(() => {}); try { showPayRequest(); } catch {} }
/** open a payment link: returns the request so the send form can be prefilled */
export function pendingPay(): PayReq | null { const r = parseLink(location.hash); return r; }
