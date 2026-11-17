// Node link: how Starsky talks to the operator's node, made visible and safer.
// Reads the gateway/panel feed (announcements, maintenance, minimum app version, node directory, ledger and clock), watches every call
// (latency, failures, rate limits), checks the network ID, warns when the node is behind or slow, and gives a diagnostics report to copy.
import { ctx } from './ctx.ts';
import { esc } from './util.ts';
import { setScamList, setRegistry, setHealth } from './safety.ts';

export const APP_VERSION = '1.0.0';
const NETID: Record<string, number> = { main: 4242, test: 4243 };
interface Rec { t: number; m: string; ms: number; ok: boolean; err?: string }
const L: Rec[] = []; let wrapped = false, feed: any = null, gw: any = null, feedAt = 0, netIdOk: boolean | null = null, netIdSeen: number | null = null, skew: number | null = null, rate = 0, slow = 0;
const $ = (id: string) => document.getElementById(id);
const DIS = 'starsky.x.nl.dis';
const dis = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(DIS) || '{}'); } catch { return {}; } };
const setDis = (id: string) => { try { const d = dis(); d[id] = Date.now(); localStorage.setItem(DIS, JSON.stringify(d)); } catch {} $('xnl')?.remove(); };
export const base = (): string => { const u = ctx.nodeUrl(); return u.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, ''); };
const isGateway = () => !ctx.xrpl();
const net = () => (ctx.netKey() === 'test' ? 'test' : 'main');

/** wrap ctx.req once: record each call, flag slow answers, rate limits and a wrong network */
export function wrapReq() {
  if (wrapped) return; wrapped = true; const orig = ctx.req;
  const TTL: Record<string, number> = { server_info: 2000, fee: 2000, ledger_current: 1500, ledger_closed: 1500, account_info: 1500, account_lines: 2500, account_offers: 2500, book_offers: 1500, amm_info: 2500, gateway_balances: 3000 };
  const cache = new Map<string, { t: number; v: any }>(), fl = new Map<string, Promise<any>>();
  ctx.req = async (cmd: string, p?: any) => {
    const t0 = Date.now();
    if (P.validatedOnly() && p && p.ledger_index === undefined && /^(account_info|account_lines|account_offers|account_nfts|gateway_balances|amm_info|book_offers)$/.test(cmd)) p = { ...p, ledger_index: 'validated' };
    const ttl = TTL[cmd], key = ttl ? cmd + JSON.stringify(p || {}) + ctx.netKey() + (ctx.xrpl() ? 'x' : '') : '';
    if (ttl) { const h = cache.get(key); if (h && Date.now() - h.t < ttl) { cached++; return h.v; } if (fl.has(key)) { cached++; return fl.get(key)!; } }
    const run = (async () => { try { const r = await orig(cmd, p); const ms = Date.now() - t0; push({ t: t0, m: cmd, ms, ok: true }); if (ms > 4000) { slow++; } if (cmd === 'server_info' && r?.info) { checkInfo(r.info); hist(r.info); } if (ttl) cache.set(key, { t: Date.now(), v: r }); return r; }
    catch (e: any) { const msg = String(e?.message || e); if (/slowDown|RATE_LIMITED|429/i.test(msg)) { rate++; backoffUntil = Date.now() + 15000; } push({ t: t0, m: cmd, ms: Date.now() - t0, ok: false, err: msg.slice(0, 80) }); throw e; } })();
    if (ttl) { fl.set(key, run); run.finally(() => fl.delete(key)).catch(() => {}); }
    if (backoffUntil > Date.now() && /^(ledger_data|account_tx|tx)$/.test(cmd)) await new Promise(r => setTimeout(r, 1200));
    return run;
  };
}
function push(r: Rec) { L.push(r); if (L.length > 150) L.shift(); }
function checkInfo(i: any) {
  if (ctx.xrpl()) return;
  const want = NETID[ctx.netKey()]; netIdSeen = i.network_id == null ? null : Number(i.network_id);
  netIdOk = want == null || netIdSeen == null ? null : netIdSeen === want;
  const age = Number(i.validated_ledger?.age ?? 0), st = String(i.server_state || ''); lagWarn = age > 30 || !['full', 'proposing', 'validating'].includes(st) ? `The node is ${st || 'not synced'} and its newest ledger is ${age}s old. Balances may be out of date.` : '';
}
let lagWarn = '', cached = 0, backoffUntil = 0;
// ---- preferences for node behaviour ----
const PK = 'starsky.x.nl.prefs';
export const P = { validatedOnly: (): boolean => { try { return JSON.parse(localStorage.getItem(PK) || '{}').vo === 1; } catch { return false; } }, setVO: (v: boolean) => { try { const o = JSON.parse(localStorage.getItem(PK) || '{}'); o.vo = v ? 1 : 0; localStorage.setItem(PK, JSON.stringify(o)); } catch {} } };
// ---- server_info history (fee / reserve / load) ----
interface H { t: number; fee: number; res: number; inc: number; load: number; age: number; peers: number }
const HS: H[] = [];
function hist(i: any) { const v = i.validated_ledger || {}; HS.push({ t: Date.now(), fee: Number(v.base_fee_xrp ?? 0), res: Number(v.reserve_base_xrp ?? 0), inc: Number(v.reserve_inc_xrp ?? 0), load: Number(i.load_factor ?? 1), age: Number(v.age ?? 0), peers: Number(i.peers ?? 0) }); if (HS.length > 120) HS.shift(); }
// ---- duplicate-send guard, outcome tracking, offline queue ----
const RECENT = new Map<string, number>(); const QK = 'starsky.x.nl.queue';
const sig = (tx: any) => JSON.stringify([tx.TransactionType, tx.Account, tx.Destination, tx.Amount, tx.DestinationTag, tx.TakerGets, tx.TakerPays, tx.LimitAmount, tx.OfferSequence]);
export function guard(tx: any): string | null { const k = sig(tx), t = RECENT.get(k); if (t && Date.now() - t < 20000) return 'This looks identical to a transaction you sent a moment ago. Wait for it to confirm, then send again if you really mean to pay twice.'; RECENT.set(k, Date.now()); return null; }
export function guardClear(tx: any) { RECENT.delete(sig(tx)); }
export interface Q { id: string; t: number; net: string; tx: any }
const qget = (): Q[] => { try { return JSON.parse(localStorage.getItem(QK) || '[]'); } catch { return []; } };
const qset = (q: Q[]) => { try { localStorage.setItem(QK, JSON.stringify(q.slice(-20))); } catch {} };
export function queueTx(tx: any, why: string) { if (!/not connected|Disconnected|offline|WebSocket|timeout/i.test(why)) return false; const q = qget(); q.push({ id: Math.random().toString(36).slice(2, 8), t: Date.now(), net: ctx.netKey(), tx: { ...tx, Sequence: undefined, LastLedgerSequence: undefined, Fee: undefined, SigningPubKey: undefined, TxnSignature: undefined } }); qset(q); return true; }
(window as any).xnlq = {
  send: async (id: string) => { const q = qget(), it = q.find(x => x.id === id); if (!it) return; if (it.net !== ctx.netKey()) { ctx.toast('Switch to the ' + it.net + ' network first', true); return; } const r = await ctx.submit(JSON.parse(JSON.stringify(it.tx, (_k, v) => v === undefined ? undefined : v))); if (r.ok) { qset(qget().filter(x => x.id !== id)); ctx.toast('Sent from the queue'); } else ctx.toast('Still failing: ' + (r.msg || 'error'), true); banners(); },
  drop: (id: string) => { qset(qget().filter(x => x.id !== id)); banners(); },
};

async function getJson(u: string, ms = 6000): Promise<any> { const c = new AbortController(), t = setTimeout(() => c.abort(), ms); try { const t0 = Date.now(); const r = await fetch(u, { signal: c.signal }); const d = r.headers.get('date'); if (d) skew = Math.round((Date.now() - new Date(d).getTime() - (Date.now() - t0) / 2) / 1000); return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(t); } }
export async function refresh(force = false) {
  if (ctx.xrpl() || !isGateway() || (!force && Date.now() - feedAt < 45000)) return; feedAt = Date.now();
  const b = base(), pre = net() === 'test' ? '/test' : '';
  [feed, gw] = await Promise.all([getJson(`${b}/panel/${net()}/api/public/nodefeed`), getJson(`${b}${pre}/gw/status`)]);
  if (Array.isArray(feed?.scam)) setScamList(feed.scam);
  if (feed?.registry) setRegistry(feed.registry);
  if (feed?.health) setHealth(feed.health);
  if (gw?.now) skew = Math.round((Date.now() - gw.now) / 1000);
}
const needsUpdate = () => { const m = feed?.minApp?.starsky; if (!m) return false; const a = APP_VERSION.split('.').map(Number), b = String(m).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0); } return false; };

/** banners above the page: maintenance, announcements, update needed, node lag, wrong network, clock skew */
export function banners() {
  const view = $('view'); if (!view) return; $('xnl')?.remove(); const d = dis(), items: { id: string; c: string; h: string }[] = [];
  const col = { info: 'var(--ok)', warn: 'var(--warn)', crit: 'var(--crit)' } as any;
  if (netIdOk === false) items.push({ id: '', c: 'crit', h: `<b>Wrong network.</b> This node reports network ID ${netIdSeen}, but ${ctx.netKey() === 'test' ? 'LUMA Testnet' : 'LUMA Mainnet'} is ${NETID[ctx.netKey()]}. Do not send anything until you pick the right node in Settings.` });
  if (feed?.health?.state === 'outage') items.push({ id: '', c: 'crit', h: `<b>${esc(feed.health.headline || 'Network problem')}.</b> ${esc((feed.health.detail || []).join(' '))} Transactions may not be confirmed.` });
  else if (feed?.health?.state === 'degraded') items.push({ id: '', c: 'warn', h: `<b>${esc(feed.health.headline || 'Reduced capacity')}.</b> ${esc((feed.health.detail || []).join(' '))}` });
  if (feed?.maintenance?.on) items.push({ id: '', c: 'warn', h: `<b>Maintenance.</b> ${esc(feed.maintenance.msg || 'The network is being worked on. Transactions may be slow.')}` });
  for (const a of feed?.announcements || []) if (!d['a:' + a.id]) items.push({ id: 'a:' + a.id, c: a.level || 'info', h: `${a.title ? `<b>${esc(a.title)}</b> ` : ''}${esc(a.msg || '')}${/^https:\/\//.test(a.link || '') ? ` <a href="${esc(a.link)}" target="_blank" rel="noopener">More</a>` : ''}` });
  if (needsUpdate()) items.push({ id: 'upd', c: 'warn', h: `<b>Please refresh.</b> The network operator asks for Starsky ${esc(feed.minApp.starsky)} or newer. Reload the page to get it.` });
  if (lagWarn) items.push({ id: '', c: 'warn', h: esc(lagWarn) });
  for (const q of qget()) { const amt = typeof q.tx.Amount === 'string' ? (Number(q.tx.Amount) / 1e6) + ' native' : q.tx.Amount ? q.tx.Amount.value + ' ' + String(q.tx.Amount.currency || '').slice(0, 8) : q.tx.TransactionType; items.push({ id: '', c: 'warn', h: `<b>Waiting to send:</b> ${esc(q.tx.TransactionType)} ${esc(amt)} ${q.tx.Destination ? 'to ' + esc(ctx.show(q.tx.Destination)) : ''} (${new Date(q.t).toLocaleTimeString()}, ${esc(q.net)}). It was not sent because the node was unreachable. <button class="sm" onclick="window.xnlq.send('${q.id}')">Send now</button> <button class="sm ghost" onclick="window.xnlq.drop('${q.id}')">Discard</button>` }); }
  if (skew != null && Math.abs(skew) > 90 && !d['skew']) items.push({ id: 'skew', c: 'warn', h: `Your device clock is about ${Math.abs(skew)}s ${skew > 0 ? 'ahead of' : 'behind'} the network. Fix your clock if sends are rejected.` });
  if (!items.length) return;
  const box = document.createElement('div'); box.id = 'xnl'; box.style.margin = '0 0 .8rem';
  box.innerHTML = items.map(i => `<div class="card" style="border-left:3px solid ${col[i.c] || col.info};padding:.55rem .8rem;margin:.3rem 0;display:flex;gap:.6rem;align-items:center"><span class="grow" style="font-size:.84rem">${i.h}</span>${i.id ? `<button class="sm ghost" data-nl="${esc(i.id)}">Dismiss</button>` : ''}</div>`).join('');
  box.querySelectorAll('[data-nl]').forEach(b => b.addEventListener('click', () => setDis((b as HTMLElement).dataset.nl || '')));
  view.insertBefore(box, view.firstChild);
}

export function diagnostics(): string {
  const ok = L.filter(r => r.ok), ms = ok.map(r => r.ms).sort((a, b) => a - b), p = (q: number) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * q))] : null;
  return ['Starsky ' + APP_VERSION + ' node diagnostics', new Date().toISOString(), 'network ' + ctx.netKey() + ' (expected id ' + (NETID[ctx.netKey()] ?? 'n/a') + ', node reports ' + (netIdSeen ?? 'unknown') + ')', 'node ' + ctx.nodeUrl(),
    'calls ' + L.length + ', failed ' + (L.length - ok.length) + ', rate-limited ' + rate + ', slow ' + slow, 'latency median ' + (p(0.5) ?? '-') + ' ms, p95 ' + (p(0.95) ?? '-') + ' ms', 'clock skew ' + (skew ?? 'unknown') + ' s',
    'gateway ' + (gw?.gateway ? `up ${gw.gateway.up}s, cache hit ${gw.gateway.cacheHitRate ?? '-'}, serving ${gw[net()]?.serving || '-'}` : 'not reachable'), 'ledger ' + (gw?.[net()]?.node?.seq ?? '-'), 'last calls:', ...L.slice(-20).map(r => `${new Date(r.t).toISOString().slice(11, 19)} ${r.m} ${r.ms}ms ${r.ok ? 'ok' : 'FAIL ' + (r.err || '')}`)].join('\n');
}
const spark = (v: number[], w = 140, h = 26) => { if (v.length < 2) return ''; const mn = Math.min(...v), mx = Math.max(...v), r = mx - mn || 1; return `<svg width="${w}" height="${h}" style="vertical-align:middle"><polyline fill="none" stroke="#00c46f" stroke-width="1.5" points="${v.map((y, i) => (i / (v.length - 1) * w).toFixed(1) + ',' + (h - 2 - (y - mn) / r * (h - 4)).toFixed(1)).join(' ')}"/></svg>`; };
function feeBlock() { const l = HS[HS.length - 1]; if (!l) return ''; return `<div class="k" style="margin-top:.8rem">Network fee and reserve (live)</div><div class="row" style="gap:1.2rem;flex-wrap:wrap;font-size:.84rem"><div>Fee <b>${l.fee}</b> ${esc(ctx.native())}</div><div>Account reserve <b>${l.res}</b></div><div>Per owned object <b>${l.inc}</b></div><div>Load <b>${l.load}</b>×</div><div>Ledger age ${spark(HS.map(x => x.age))}</div><div>Peers ${spark(HS.map(x => x.peers))}</div></div>`; }
// ---- node picker: your own list, speed test, pairing code ----
const NK = 'starsky.x.nl.nodes'; const nodesGet = (): { url: string; name: string }[] => { try { return JSON.parse(localStorage.getItem(NK) || '[]'); } catch { return []; } };
let speed: Record<string, string> = {};
function pickerBlock() { const l = nodesGet(); return `<div class="k" style="margin-top:.8rem">My nodes</div>${l.map(n => `<div class="row" style="gap:.5rem;font-size:.82rem;margin:.2rem 0"><span class="grow">${esc(n.name || n.url)} <span class="mut">${esc(n.url)}</span></span><span class="mut">${esc(speed[n.url] || '')}</span><button class="sm" onclick="window.xnl.use('${esc(n.url)}')">Use</button><button class="sm ghost" onclick="window.xnl.del('${esc(n.url)}')">Remove</button></div>`).join('') || '<div class="mut" style="font-size:.8rem">Add backup nodes: Starsky can switch to the fastest one.</div>'}
  <div class="row" style="gap:.4rem;margin-top:.4rem;flex-wrap:wrap"><input id="xnl_u" class="grow" placeholder="wss://node.example.com" style="min-width:14rem"><button class="sm" onclick="window.xnl.add()">Add</button><button class="sm" onclick="window.xnl.test()">Test speed</button><button class="sm ghost" onclick="window.xnl.fastest()">Use fastest</button></div>
  <div class="row" style="gap:.4rem;margin-top:.4rem;flex-wrap:wrap"><input id="xnl_c" class="grow" placeholder="Pairing code from the node operator (LUMA1.…)" style="min-width:14rem"><button class="sm" onclick="window.xnl.pair()">Connect with code</button></div>`; }
function setNode(url: string) { try { const c = JSON.parse(localStorage.getItem('starsky.cfg') || '{}'); c.urls = { ...(c.urls || {}), [ctx.netKey()]: url }; localStorage.setItem('starsky.cfg', JSON.stringify(c)); } catch {} location.reload(); }
function probe(url: string): Promise<{ ms: number; id: number | null; seq: number } | null> { return new Promise(res => { let ws: WebSocket; const t0 = Date.now(), to = setTimeout(() => { try { ws.close(); } catch {} res(null); }, 5000); try { ws = new WebSocket(url); } catch { clearTimeout(to); return res(null); } ws.onopen = () => ws.send(JSON.stringify({ id: 1, command: 'server_info' })); ws.onmessage = m => { try { const i = JSON.parse(m.data as string).result.info; clearTimeout(to); ws.close(); res({ ms: Date.now() - t0, id: i.network_id == null ? null : Number(i.network_id), seq: i.validated_ledger?.seq || 0 }); } catch { clearTimeout(to); res(null); } }; ws.onerror = () => { clearTimeout(to); res(null); }; }); }
async function testAll() { const want = NETID[ctx.netKey()]; await Promise.all(nodesGet().map(async n => { const r = await probe(n.url); speed[n.url] = !r ? 'no answer' : (want != null && r.id != null && r.id !== want ? 'wrong network (' + r.id + ')' : r.ms + ' ms · #' + r.seq); (speed as any)['_' + n.url] = r && !(want != null && r.id != null && r.id !== want) ? r.ms : 1e9; })); card(); }
(window as any).xnl = {
  vo: (v: boolean) => { P.setVO(v); ctx.toast(v ? 'Reading confirmed data only' : 'Reading latest data'); },
  add: () => { const u = ($('xnl_u') as HTMLInputElement)?.value.trim(); if (!/^wss?:\/\/[^\s]+$/.test(u || '')) { ctx.toast('Use a ws:// or wss:// address', true); return; } const l = nodesGet(); if (!l.some(x => x.url === u)) l.push({ url: u, name: u.replace(/^wss?:\/\//, '') }); localStorage.setItem(NK, JSON.stringify(l)); card(); },
  del: (u: string) => { localStorage.setItem(NK, JSON.stringify(nodesGet().filter(x => x.url !== u))); card(); },
  use: (u: string) => setNode(u), test: testAll,
  fastest: async () => { await testAll(); const l = nodesGet().map(n => ({ n, ms: (speed as any)['_' + n.url] ?? 1e9 })).sort((a, b) => a.ms - b.ms); if (!l.length || l[0].ms >= 1e9) { ctx.toast('No working node in your list', true); return; } setNode(l[0].n.url); },
  pair: () => { const c = ($('xnl_c') as HTMLInputElement)?.value.trim() || ''; try { const j = JSON.parse(atob(c.replace(/^LUMA1\./, '').replace(/-/g, '+').replace(/_/g, '/'))); if (!/^wss?:\/\//.test(j.ws || '')) throw 0; if (j.net && j.net !== ctx.netKey()) { ctx.toast('That code is for the ' + j.net + ' network. Switch network first.', true); return; } setNode(j.ws); } catch { ctx.toast('That pairing code is not valid', true); } }, copy: () => { navigator.clipboard?.writeText(diagnostics()).then(() => ctx.toast('Diagnostics copied'), () => ctx.toast('Could not copy', true)); }, refresh: async () => { await refresh(true); card(); } };

/** card for the Network page */
export function card() {
  const view = $('view'); if (!view) return; let box = $('xnlcard'); if (!box) { box = document.createElement('div'); box.id = 'xnlcard'; box.className = 'card'; box.style.marginBottom = '.8rem'; view.insertBefore(box, view.firstChild); }
  const ok = L.filter(r => r.ok), ms = ok.map(r => r.ms).sort((a, b) => a - b), med = ms.length ? ms[Math.floor(ms.length / 2)] : null, g = gw?.gateway, n = gw?.[net()]?.node, dir: any[] = feed?.directory?.nodes || [];
  const cell = (k: string, v: string, c = '') => `<div style="min-width:7rem"><div class="mut" style="font-size:.72rem">${k}</div><div style="font-weight:700;color:${c}">${v}</div></div>`;
  box.innerHTML = `<div class="row" style="justify-content:space-between"><div class="k" style="margin:0">Node link</div><span><button class="sm ghost" onclick="window.xnl.refresh()">Refresh</button> <button class="sm ghost" onclick="window.xnl.copy()">Copy diagnostics</button></span></div>
  <div class="row" style="gap:1rem;flex-wrap:wrap;margin-top:.5rem">${cell('Network ID', netIdSeen == null ? '–' : String(netIdSeen), netIdOk === false ? 'var(--crit)' : netIdOk ? 'var(--ok)' : '')}${cell('Median call', med == null ? '–' : med + ' ms', med != null && med > 1500 ? 'var(--warn)' : '')}${cell('Failed calls', String(L.length - ok.length) + ' of ' + L.length)}${cell('Rate limited', String(rate), rate ? 'var(--warn)' : '')}${cell('Clock', skew == null ? '–' : (Math.abs(skew) < 30 ? 'in sync' : skew + ' s off'), skew != null && Math.abs(skew) >= 90 ? 'var(--warn)' : '')}${cell('Gateway', g ? 'up ' + Math.round(g.up / 60) + ' min' : isGateway() ? 'no answer' : 'local node')}${cell('Cache hits', g?.cacheHitRate != null ? Math.round(g.cacheHitRate * 100) + '%' : '–')}${cell('Newest ledger', n ? '#' + n.seq : '–')}</div>
  ${dir.length ? `<div class="k" style="margin-top:.8rem">Network nodes</div>${dir.map(x => `<div class="row" style="gap:.6rem;font-size:.82rem;margin:.2rem 0"><span style="color:${x.up ? 'var(--ok)' : 'var(--crit)'}">●</span><span class="grow">${esc(x.name)} <span class="mut">${esc(x.role)}</span></span><span class="mut">${esc(x.state || '')} ${x.seq ? '#' + x.seq : ''}</span></div>`).join('')}` : ''}
  ${feeBlock()}
  <div class="row" style="gap:.6rem;align-items:center;margin-top:.7rem"><label style="font-size:.82rem"><input type="checkbox" ${P.validatedOnly() ? 'checked' : ''} onchange="window.xnl.vo(this.checked)"> Read only confirmed (validated) ledger data</label><span class="mut" style="font-size:.74rem">Slightly older but never rolled back. Calls served from the short cache: ${cached}</span></div>
  ${pickerBlock()}
  <details style="margin-top:.6rem"><summary class="mut" style="cursor:pointer;font-size:.8rem">Recent calls</summary><div style="font-family:monospace;font-size:.72rem;max-height:10rem;overflow:auto">${L.slice(-25).reverse().map(r => `${new Date(r.t).toISOString().slice(11, 19)} ${esc(r.m)} ${r.ms}ms ${r.ok ? '' : '<span style="color:var(--crit)">' + esc(r.err || 'fail') + '</span>'}`).join('<br>')}</div></details>`;
}

let timer: any = 0;
export function onRender(tab: string) {
  wrapReq(); refresh().then(() => { banners(); if (tab === 'network') card(); }); banners(); if (tab === 'network') card();
  clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh().then(() => { banners(); if (tab === 'network' && $('xnlcard')) card(); }); }, 30000);
}
