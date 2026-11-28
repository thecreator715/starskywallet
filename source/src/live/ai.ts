// Starsky AI: a chat that turns plain requests into estimates you accept or cancel. Everything is local: the parser runs in this browser,
// quotes come from your node, and nothing is signed until you press Accept on a card.
import { ctx } from './ctx.ts';
import { esc, fmt, short, akey, NATIVE, isNative, amtTx, type Asset } from './util.ts';
import * as M from './market.ts';
import { publicGet } from './devapi.ts';
import { parse, LEGEND, type Intent } from './aiParse.ts';

interface Msg { who: 'me' | 'ai'; html: string; id: number }
interface Card { id: number; kind: 'swap' | 'send'; state: 'ready' | 'busy' | 'done' | 'cancelled' | 'failed'; data: any; msg?: string }
const CH: Msg[] = []; const CARDS: Card[] = []; let seq = 1, prev: Intent | null = null, universe: Asset[] = [], uniAt = 0, BAL: { native: number; lines: any[] } | null = null, lastCard = 0;
const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const nm = (a: Asset) => M.labelOf(a);
const say = (html: string, who: 'ai' | 'me' = 'ai') => { CH.push({ who, html, id: seq++ }); paint(true); };
const cardOf = (id: number) => CARDS.find(c => c.id === id);

async function assets(): Promise<Asset[]> {
  if (universe.length && Date.now() - uniAt < 60000) return universe;
  const ms = M.marketsFrom(await M.poolRefs()); const m = new Map<string, Asset>(); m.set('native', NATIVE);
  for (const x of ms) { m.set(akey(x.base), x.base); m.set(akey(x.quote), x.quote); }
  universe = [...m.values()]; uniAt = Date.now(); (universe as any).markets = ms; return universe;
}
function resolve(name: string | undefined, list: Asset[]): Asset | null {
  if (!name) return null; const n = name.toUpperCase();
  if (n === ctx.native().toUpperCase() || n === 'LUMA') return NATIVE;
  const ex = list.filter(a => nm(a).toUpperCase() === n && !M.isOldUsd(a)); if (ex.length) return ex[0];
  const ex2 = list.filter(a => nm(a).toUpperCase().replace(/[^A-Z0-9]/g, '') === n); if (ex2.length) return ex2[0];
  const pre = list.filter(a => !isNative(a) && nm(a).toUpperCase().startsWith(n)); return pre.length === 1 ? pre[0] : null;
}
async function loadBal() {
  const acc = ctx.account(); if (!acc) return (BAL = null);
  const [ai, al, si] = await Promise.all([ctx.req('account_info', { account: acc, ledger_index: 'validated' }).catch(() => null), ctx.req('account_lines', { account: acc, ledger_index: 'validated', limit: 400 }).catch(() => null), ctx.req('server_info').catch(() => null)]);
  if (!ai?.account_data) return (BAL = { native: 0, lines: [] });
  const vl = si?.info?.validated_ledger || {}, rb = Number(vl.reserve_base_xrp ?? 1), ri = Number(vl.reserve_inc_xrp ?? 0.2);
  BAL = { native: Math.max(0, Number(ai.account_data.Balance) / 1e6 - rb - ri * (ai.account_data.OwnerCount || 0)), lines: al?.lines || [] };
}
const balOf = (a: Asset) => (!BAL ? 0 : isNative(a) ? BAL.native : Number((BAL.lines.find((l: any) => l.currency === a.c && l.account === a.i) || {}).balance || 0));
const hasLine = (a: Asset) => isNative(a) || !!BAL?.lines.some((l: any) => l.currency === a.c && l.account === a.i);
const chips = (opts: string[]) => `<div class="aic">${opts.map(o => `<button class="sm" onclick="window.ai.say(${esc(JSON.stringify(o))})">${esc(o)}</button>`).join('')}</div>`;

async function swapCard(it: Intent) {
  const acc = ctx.account(); if (!acc) return say('Unlock or create a wallet first, then ask me again.');
  const list = await assets(), ms: M.Market[] = (list as any).markets || []; await loadBal();
  const from = resolve(it.from, list), to = resolve(it.to, list);
  if (!from) return say(`I don't know <b>${esc(it.from)}</b>. Tokens I can see: ${chips(list.map(nm).slice(0, 12))}`);
  if (!to) return say(`I don't know <b>${esc(it.to)}</b>. Tokens I can see: ${chips(list.map(nm).slice(0, 12))}`);
  if (akey(from) === akey(to)) return say('Those are the same token. Pick two different ones.');
  const m = ms.find(x => (akey(x.base) === akey(from) && akey(x.quote) === akey(to)) || (akey(x.base) === akey(to) && akey(x.quote) === akey(from)));
  if (!m) return say(`There is no direct market between ${esc(nm(from))} and ${esc(nm(to))}. Try going through ${esc(ctx.native())}: <i>trade ${esc(nm(from))} for ${esc(ctx.native())}</i>, then <i>trade ${esc(ctx.native())} for ${esc(nm(to))}</i>.`);
  const side: 'buy' | 'sell' = akey(m.quote) === akey(from) ? 'buy' : 'sell';
  const bal = balOf(from); let x = it.amount === 'all' ? bal : it.amount === 'half' ? bal / 2 : Number(it.amount);
  if (it.amountIsTarget && typeof it.amount === 'number') {   // "buy 100 LUMA with XRP": find what to pay for that much
    const p = await M.quote(m, side, 1); if (!p) return say('No liquidity to price that.'); x = it.amount / p.rate;
    for (let i = 0; i < 3; i++) { const q = await M.quote(m, side, x); if (!q) break; x = x * (it.amount / q.out); }
  }
  if (!(x > 0)) return say(`You have no ${esc(nm(from))} to trade.`);
  if (x > bal + 1e-9) return say(`You have ${fmt(bal)} ${esc(nm(from))}, which is less than ${fmt(x)}. ${chips([`trade all my ${nm(from)} for ${nm(to)}`, `trade half my ${nm(from)} for ${nm(to)}`])}`);
  const q = await M.quote(m, side, x); if (!q) return say('There is not enough liquidity for that size. Try a smaller amount.');
  const P0 = POL || {}, slip = it.slip && it.slip > 0 && it.slip <= 50 ? Math.min(it.slip, P0.maxSlipPct || 50) : (P0.defaultSlipPct || 1), min = q.out * (1 - slip / 100);
  const warns: string[] = []; if (P0.maxImpactPct && q.impact * 100 > P0.maxImpactPct) return say(`That would move the price by ${(q.impact * 100).toFixed(1)}%, above the ${P0.maxImpactPct}% limit set for trades here. Try a smaller amount.`);
  if (q.impact > 0.05) warns.push(`High price impact: ${(q.impact * 100).toFixed(1)}%.`); else if (q.impact > 0.02) warns.push(`Price impact ${(q.impact * 100).toFixed(1)}%.`);
  if (isNative(from) && bal - x < 0.5) warns.push('This leaves almost nothing for fees.'); if (!hasLine(to)) warns.push(`${nm(to)} needs a trust line. Accept adds it first (a small reserve is held).`);
  const c: Card = { id: seq++, kind: 'swap', state: 'ready', data: { from, to, m, side, x, q, min, slip, warns } }; CARDS.push(c); lastCard = c.id;
  say(`Here is what that would do. Nothing is sent until you press Accept.<div data-card="${c.id}"></div>`);
}
async function sendCard(it: Intent) {
  const acc = ctx.account(); if (!acc) return say('Unlock or create a wallet first.');
  if (!it.dest || !/^(r|X|L|T)[1-9A-HJ-NP-Za-km-z]{20,}$/.test(it.dest)) return say('Paste the full wallet address to send to. I do not guess names.');
  let dest: string; try { dest = ctx.toClassic(it.dest); } catch { return say('That address is not valid for this network.'); }
  const list = await assets(); await loadBal(); const a = it.asset ? resolve(it.asset, list) : NATIVE; if (!a) return say(`I don't know <b>${esc(it.asset)}</b>.`);
  const bal = balOf(a), x = it.amount === 'all' ? bal : it.amount === 'half' ? bal / 2 : Number(it.amount);
  if (!(x > 0)) return say('Tell me an amount, for example <i>send 10 LUMA to r…</i>.'); if (x > bal + 1e-9) return say(`You have ${fmt(bal)} ${esc(nm(a))}, which is less than ${fmt(x)}.`);
  const c: Card = { id: seq++, kind: 'send', state: 'ready', data: { a, x, dest, warns: [] } }; CARDS.push(c); lastCard = c.id;
  say(`Check the details. Nothing is sent until you press Accept.<div data-card="${c.id}"></div>`);
}
async function balanceReply(it: Intent) {
  if (!ctx.account()) return say('Unlock or create a wallet first.'); await loadBal(); const list = await assets();
  const rows: [string, number][] = [[ctx.native(), balOf(NATIVE)], ...(BAL?.lines || []).filter((l: any) => Number(l.balance) !== 0).map((l: any) => [nm({ c: l.currency, i: l.account }), Number(l.balance)] as [string, number])];
  const f = it.asset ? rows.filter(r => r[0].toUpperCase() === it.asset) : rows; void list;
  say(f.length ? `<table class="aitb">${f.map(r => `<tr><td>${esc(r[0])}</td><td>${fmt(r[1], 6)}</td></tr>`).join('')}</table><span class="mut">${esc(ctx.native())} shown is what you can spend (the account reserve is held back).</span>` : `You hold no ${esc(it.asset)}.`);
}
async function priceReply(it: Intent) {
  const list = await assets(), ms: M.Market[] = (list as any).markets || []; const a = it.asset ? resolve(it.asset, list) : NATIVE; if (!a) return say(`I don't know <b>${esc(it.asset)}</b>.`);
  const mm = ms.filter(x => akey(x.base) === akey(a) || akey(x.quote) === akey(a)).slice(0, 5); if (!mm.length) return say(`${esc(nm(a))} has no market yet.`);
  const rows: string[] = []; for (const x of mm) { const q = await M.quote(x, akey(x.base) === akey(a) ? 'sell' : 'buy', 1).catch(() => null); const other = akey(x.base) === akey(a) ? x.quote : x.base; if (q) rows.push(`<tr><td>1 ${esc(nm(a))}</td><td>≈ ${fmt(q.out, 8)} ${esc(nm(other))}</td><td class="mut">${esc(q.src)}</td></tr>`); }
  say(rows.length ? `<table class="aitb">${rows.join('')}</table>` : 'No quote available right now.');
}
async function historyReply() {
  const acc = ctx.account(); if (!acc) return say('Unlock or create a wallet first.');
  const r = await ctx.req('account_tx', { account: acc, limit: 8 }).catch(() => null); const t = r?.transactions || [];
  say(t.length ? `<table class="aitb">${t.map((e: any) => { const x = e.tx || e.tx_json || {}; return `<tr><td>${esc(x.TransactionType || '')}</td><td class="mono">${esc(short(e.hash || x.hash || '', 8, 6))}</td><td class="mut">${esc((e.meta || e.metaData || {}).TransactionResult || '')}</td></tr>`; }).join('')}</table>` : 'No transactions yet.');
}
function go(tab: string, after?: () => void) { (window as any).goTab(tab); if (after) setTimeout(after, 400); }
let POL: any = null, polAt = 0;
async function policy() { if (Date.now() - polAt < 300000) return POL; polAt = Date.now(); const j = await publicGet('/api/public/ai'); POL = j && j.ok ? j : null; return POL; }
const KMAP: Record<string, string> = { swap: 'swap', send: 'send', balance: 'balance', price: 'price', history: 'history', lend: 'lend', check: 'check', bridge: 'bridge', api: 'api', nav: 'nav' };
async function handle(text: string) {
  const it = parse(text, prev); const gate = (k: string) => k; const P = await policy();
  if (P) { if (P.enabled === false) return say('The AI page is switched off right now. You can still do everything from the other pages.'); const k = KMAP[it.kind]; if (k && Array.isArray(P.disabled) && P.disabled.includes(k)) return say('That request is turned off by the network operator for now. You can do it from the normal page instead.'); if (P.notice && !(P as any).__shown) { (P as any).__shown = 1; say('<b>Notice:</b> ' + esc(String(P.notice))); } if (it.slip && P.maxSlipPct && it.slip > P.maxSlipPct) it.slip = P.maxSlipPct; }
  if (it.kind === 'yes') { const c = cardOf(lastCard); if (c && c.state === 'ready') return void accept(c.id); return say('Nothing is waiting for your answer.'); }
  if (it.kind === 'cancel') { const c = cardOf(lastCard); if (c && c.state === 'ready') { c.state = 'cancelled'; paint(true); return; } prev = null; return say('Okay.'); }
  if (it.kind === 'help') return say(legendHtml());
  if (it.missing.length) { prev = it; const q = it.missing[0] === 'amount' ? 'How much?' : it.missing[0] === 'from' ? 'What do you want to pay with?' : it.missing[0] === 'to' ? 'What do you want to get?' : it.missing[0] === 'dest' ? 'Paste the wallet address to send to.' : 'Tell me a bit more.'; return say(q + (it.missing[0] === 'amount' ? chips(['all', 'half', '10', '100']) : '')); }
  prev = null; void gate;
  switch (it.kind) {
    case 'swap': return swapCard(it); case 'send': return sendCard(it); case 'balance': return balanceReply(it); case 'price': return priceReply(it); case 'history': return historyReply();
    case 'lend': say(`Opening Lending with ${it.action} ${it.amount ?? ''} ${esc(it.asset || '')} filled in. Review it there.`); return go('lending', () => { const L = (window as any).ld; if (L) { if (it.asset) L.set('asset', it.asset); if (typeof it.amount === 'number') L.set('amt', String(it.amount)); } });
    case 'check': say('Opening Checks.'); return go('checks', () => { const C = (window as any).ck; if (C && typeof it.amount === 'number') C.f('amt', String(it.amount)); if (C && it.dest) C.f('to', it.dest); });
    case 'bridge': say('Opening the bridge.'); return go('bridge');
    case 'api': return go('api');
    case 'nav': say(`Opening ${esc(it.action)}.`); return go(it.action as string);
    default: say(`I did not get that. Try something like <i>trade 5 XRP for ${esc(ctx.native())}</i>, or type <b>help</b> to see everything I understand.`);
  }
}
export async function accept(id: number) {
  const c = cardOf(id); if (!c || c.state !== 'ready') return; c.state = 'busy'; c.msg = 'Signing and sending…'; paint(true);
  try {
    const acc = ctx.account()!;
    if (c.kind === 'swap') {
      const { from, to, side, x, min } = c.data as any; await loadBal();
      if (!hasLine(to)) { c.msg = 'Adding the trust line…'; paint(true); const t = await ctx.submit({ TransactionType: 'TrustSet', Account: acc, LimitAmount: { currency: to.c, issuer: to.i, value: '1000000000000' } }); if (!t.ok) throw new Error(t.msg || 'Could not add the trust line'); }
      const q = await M.quote(c.data.m, side, x); if (!q) throw new Error('Liquidity is gone. Ask me again.'); if (q.out < min * 0.995) throw new Error('The price moved past your slippage limit. Ask me again for a fresh estimate.');
      c.msg = 'Waiting for the ledger…'; paint(true);
      const r = await ctx.submit({ TransactionType: 'OfferCreate', Account: acc, TakerGets: amtTx(from, x), TakerPays: amtTx(to, min), Flags: 0x00080000 | 0x00020000 });
      if (!r.ok) throw new Error(r.msg || 'Rejected by the network'); c.state = 'done'; c.msg = 'Done. Transaction ' + short(r.hash || '', 8, 6);
    } else {
      const { a, x, dest } = c.data as any; const r = await ctx.submit({ TransactionType: 'Payment', Account: acc, Destination: dest, Amount: amtTx(a, x) });
      if (!r.ok) throw new Error(r.msg || 'Rejected by the network'); c.state = 'done'; c.msg = 'Sent. Transaction ' + short(r.hash || '', 8, 6);
    }
    await loadBal();
  } catch (e: any) { c.state = 'failed'; c.msg = String(e?.message || e); }
  paint(true);
}
export function decline(id: number) { const c = cardOf(id); if (c && c.state === 'ready') { c.state = 'cancelled'; paint(true); } }
export function setSlip(id: number, s: number) { const c = cardOf(id); if (!c || c.state !== 'ready' || c.kind !== 'swap') return; c.data.slip = s; c.data.min = c.data.q.out * (1 - s / 100); paint(true); }
function cardHtml(c: Card): string {
  const d = c.data, row = (k: string, v: string) => `<div class="aikv"><span class="mut">${k}</span><span>${v}</span></div>`;
  let body = '', head = '';
  if (c.kind === 'swap') {
    head = `${fmt(d.x)} ${esc(nm(d.from))} → ≈ ${fmt(d.q.out, 6)} ${esc(nm(d.to))}`;
    body = row('You pay', `${fmt(d.x, 8)} ${esc(nm(d.from))}`) + row('You receive (estimate)', `${fmt(d.q.out, 8)} ${esc(nm(d.to))}`) + row('Minimum you will get', `${fmt(d.min, 8)} ${esc(nm(d.to))}`) + row('Rate', `1 ${esc(nm(d.from))} ≈ ${fmt(d.q.rate, 8)} ${esc(nm(d.to))}`) + row('Price impact', `${(d.q.impact * 100).toFixed(2)}%`) + row('Route', esc(d.q.src) + (d.q.src === 'AMM pool' ? ` · fee ${d.q.feePct}%` : ''))
      + (c.state === 'ready' ? `<div class="aic" style="margin-top:.4rem"><span class="mut">Slippage</span>${[0.5, 1, 2, 5].map(s => `<button class="sm ${d.slip === s ? 'pri' : ''}" onclick="window.ai.slip(${c.id},${s})">${s}%</button>`).join('')}</div>` : '');
  } else { head = `Send ${fmt(d.x)} ${esc(nm(d.a))}`; body = row('Amount', `${fmt(d.x, 8)} ${esc(nm(d.a))}`) + row('To', `<span class="mono">${esc(short(ctx.show(d.dest), 10, 8))}</span>`); }
  const w = (d.warns || []).map((t: string) => `<div class="aiw">${esc(t)}</div>`).join('');
  const act = c.state === 'ready' ? `<div class="aic" style="margin-top:.5rem"><button class="pri" onclick="window.ai.accept(${c.id})">Accept</button><button class="sm" onclick="window.ai.decline(${c.id})">Cancel</button></div>` : `<div style="margin-top:.5rem;color:${c.state === 'done' ? 'var(--ok,#3ddc84)' : c.state === 'failed' ? 'var(--crit,#ff5b5b)' : 'inherit'}">${c.state === 'cancelled' ? 'Cancelled. Nothing was sent.' : esc(c.msg || '')}</div>`;
  return `<div class="aicard"><div style="font-weight:700;margin-bottom:.3rem">${head}</div>${body}${w}${act}</div>`;
}
const legendHtml = () => LEGEND.map(g => `<div style="margin:.4rem 0"><b>${esc(g.group)}</b>${g.items.map(i => `<div class="ailg"><button class="sm" onclick="window.ai.say(${esc(JSON.stringify(i[0]))})">${esc(i[0])}</button><span class="mut">${esc(i[1])}</span></div>`).join('')}</div>`).join('');
export function shell() {
  return `<style>.aiwrap{display:grid;grid-template-columns:minmax(0,1fr) 20rem;gap:1rem}@media(max-width:900px){.aiwrap{grid-template-columns:1fr}}.aichat{display:flex;flex-direction:column;height:min(70vh,40rem)}#ai_log{flex:1;overflow:auto;display:flex;flex-direction:column;gap:.5rem;padding:.2rem}.aim{max-width:92%;padding:.5rem .7rem;border-radius:12px;line-height:1.45;font-size:.92rem}.aim.me{align-self:flex-end;background:var(--acc,#5aa9ff);color:#fff}.aim.ai{align-self:flex-start;background:rgba(255,255,255,.07)}.aic{display:flex;gap:.35rem;flex-wrap:wrap;align-items:center;margin-top:.35rem}.aicard{margin-top:.5rem;padding:.6rem;border:1px solid rgba(255,255,255,.18);border-radius:10px}.aikv{display:flex;justify-content:space-between;gap:.6rem;font-size:.86rem;padding:.12rem 0}.aiw{margin-top:.3rem;color:#f5b84b;font-size:.82rem}.aitb td{padding:.1rem .6rem .1rem 0;font-size:.86rem}.ailg{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.2rem 0}.ailg .mut{font-size:.78rem}</style><div class="aiwrap" id="ai_root"><div class="card aichat"><div id="ai_log"></div><div class="row" style="gap:.4rem;margin-top:.5rem"><input id="ai_in" class="grow" placeholder="Try: trade 5 XRP for ${esc(ctx.native())}" autocomplete="off" onkeydown="if(event.key==='Enter')window.ai.send()"><button class="pri" onclick="window.ai.send()">Send</button></div></div><div class="card" style="overflow:auto;max-height:min(70vh,40rem)"><div class="k">What you can say</div><div class="mut" style="font-size:.8rem;margin:.2rem 0">Tap any line to run it. Any wording works.</div>${legendHtml()}</div></div>`;
}
function paint(scroll = false) {
  const log = document.getElementById('ai_log'); if (!log) return;
  log.innerHTML = CH.map(m => `<div class="aim ${m.who}">${m.html}</div>`).join('');
  log.querySelectorAll('[data-card]').forEach(el => { const c = cardOf(Number(el.getAttribute('data-card'))); if (c) el.outerHTML = cardHtml(c); });
  if (scroll) log.scrollTop = log.scrollHeight;
}
export async function send(text?: string) {
  const inp = $('ai_in'); const t = (text ?? inp?.value ?? '').trim(); if (!t) return; if (inp && text == null) inp.value = '';
  say(esc(t), 'me'); try { await handle(t); } catch (e: any) { say(`Something went wrong: ${esc(String(e?.message || e))}`); }
}
export function mount() { if (!CH.length) say(`Hi. Tell me what you want to do, in your own words. I show an estimate first and nothing happens until you press <b>Accept</b>.${chips([`trade 5 XRP for ${ctx.native()}`, 'balance', 'help'])}`); else paint(true); setTimeout(() => $('ai_in')?.focus(), 50); }
export const api = { send, say: (t: string) => void send(t), accept, decline, slip: setSlip };
