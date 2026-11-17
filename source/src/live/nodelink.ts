// Node link: how Starsky talks to the operator's node, made visible and safer.
// Reads the gateway/panel feed (announcements, maintenance, minimum app version, node directory, ledger and clock), watches every call
// (latency, failures, rate limits), checks the network ID, warns when the node is behind or slow, and gives a diagnostics report to copy.
import { ctx } from './ctx.ts';
import { esc } from './util.ts';

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
  ctx.req = async (cmd: string, p?: any) => {
    const t0 = Date.now();
    try { const r = await orig(cmd, p); const ms = Date.now() - t0; push({ t: t0, m: cmd, ms, ok: true }); if (ms > 4000) { slow++; } if (cmd === 'server_info' && r?.info) checkInfo(r.info); return r; }
    catch (e: any) { const msg = String(e?.message || e); if (/slowDown|RATE_LIMITED|429/i.test(msg)) rate++; push({ t: t0, m: cmd, ms: Date.now() - t0, ok: false, err: msg.slice(0, 80) }); throw e; }
  };
}
function push(r: Rec) { L.push(r); if (L.length > 150) L.shift(); }
function checkInfo(i: any) {
  if (ctx.xrpl()) return;
  const want = NETID[ctx.netKey()]; netIdSeen = i.network_id == null ? null : Number(i.network_id);
  netIdOk = want == null || netIdSeen == null ? null : netIdSeen === want;
  const age = Number(i.validated_ledger?.age ?? 0), st = String(i.server_state || ''); lagWarn = age > 30 || !['full', 'proposing', 'validating'].includes(st) ? `The node is ${st || 'not synced'} and its newest ledger is ${age}s old. Balances may be out of date.` : '';
}
let lagWarn = '';

async function getJson(u: string, ms = 6000): Promise<any> { const c = new AbortController(), t = setTimeout(() => c.abort(), ms); try { const t0 = Date.now(); const r = await fetch(u, { signal: c.signal }); const d = r.headers.get('date'); if (d) skew = Math.round((Date.now() - new Date(d).getTime() - (Date.now() - t0) / 2) / 1000); return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(t); } }
export async function refresh(force = false) {
  if (ctx.xrpl() || !isGateway() || (!force && Date.now() - feedAt < 45000)) return; feedAt = Date.now();
  const b = base(), pre = net() === 'test' ? '/test' : '';
  [feed, gw] = await Promise.all([getJson(`${b}/panel/${net()}/api/public/nodefeed`), getJson(`${b}${pre}/gw/status`)]);
  if (gw?.now) skew = Math.round((Date.now() - gw.now) / 1000);
}
const needsUpdate = () => { const m = feed?.minApp?.starsky; if (!m) return false; const a = APP_VERSION.split('.').map(Number), b = String(m).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0); } return false; };

/** banners above the page: maintenance, announcements, update needed, node lag, wrong network, clock skew */
export function banners() {
  const view = $('view'); if (!view) return; $('xnl')?.remove(); const d = dis(), items: { id: string; c: string; h: string }[] = [];
  const col = { info: 'var(--ok)', warn: 'var(--warn)', crit: 'var(--crit)' } as any;
  if (netIdOk === false) items.push({ id: '', c: 'crit', h: `<b>Wrong network.</b> This node reports network ID ${netIdSeen}, but ${ctx.netKey() === 'test' ? 'LUMA Testnet' : 'LUMA Mainnet'} is ${NETID[ctx.netKey()]}. Do not send anything until you pick the right node in Settings.` });
  if (feed?.maintenance?.on) items.push({ id: '', c: 'warn', h: `<b>Maintenance.</b> ${esc(feed.maintenance.msg || 'The network is being worked on. Transactions may be slow.')}` });
  for (const a of feed?.announcements || []) if (!d['a:' + a.id]) items.push({ id: 'a:' + a.id, c: a.level || 'info', h: `${a.title ? `<b>${esc(a.title)}</b> ` : ''}${esc(a.msg || '')}${/^https:\/\//.test(a.link || '') ? ` <a href="${esc(a.link)}" target="_blank" rel="noopener">More</a>` : ''}` });
  if (needsUpdate()) items.push({ id: 'upd', c: 'warn', h: `<b>Please refresh.</b> The network operator asks for Starsky ${esc(feed.minApp.starsky)} or newer. Reload the page to get it.` });
  if (lagWarn) items.push({ id: '', c: 'warn', h: esc(lagWarn) });
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
(window as any).xnl = { copy: () => { navigator.clipboard?.writeText(diagnostics()).then(() => ctx.toast('Diagnostics copied'), () => ctx.toast('Could not copy', true)); }, use: (u: string) => { navigator.clipboard?.writeText(u); ctx.toast('Node address copied. Paste it in Settings, Node.'); }, refresh: async () => { await refresh(true); card(); } };

/** card for the Network page */
export function card() {
  const view = $('view'); if (!view) return; let box = $('xnlcard'); if (!box) { box = document.createElement('div'); box.id = 'xnlcard'; box.className = 'card'; box.style.marginBottom = '.8rem'; view.insertBefore(box, view.firstChild); }
  const ok = L.filter(r => r.ok), ms = ok.map(r => r.ms).sort((a, b) => a - b), med = ms.length ? ms[Math.floor(ms.length / 2)] : null, g = gw?.gateway, n = gw?.[net()]?.node, dir: any[] = feed?.directory?.nodes || [];
  const cell = (k: string, v: string, c = '') => `<div style="min-width:7rem"><div class="mut" style="font-size:.72rem">${k}</div><div style="font-weight:700;color:${c}">${v}</div></div>`;
  box.innerHTML = `<div class="row" style="justify-content:space-between"><div class="k" style="margin:0">Node link</div><span><button class="sm ghost" onclick="window.xnl.refresh()">Refresh</button> <button class="sm ghost" onclick="window.xnl.copy()">Copy diagnostics</button></span></div>
  <div class="row" style="gap:1rem;flex-wrap:wrap;margin-top:.5rem">${cell('Network ID', netIdSeen == null ? '–' : String(netIdSeen), netIdOk === false ? 'var(--crit)' : netIdOk ? 'var(--ok)' : '')}${cell('Median call', med == null ? '–' : med + ' ms', med != null && med > 1500 ? 'var(--warn)' : '')}${cell('Failed calls', String(L.length - ok.length) + ' of ' + L.length)}${cell('Rate limited', String(rate), rate ? 'var(--warn)' : '')}${cell('Clock', skew == null ? '–' : (Math.abs(skew) < 30 ? 'in sync' : skew + ' s off'), skew != null && Math.abs(skew) >= 90 ? 'var(--warn)' : '')}${cell('Gateway', g ? 'up ' + Math.round(g.up / 60) + ' min' : isGateway() ? 'no answer' : 'local node')}${cell('Cache hits', g?.cacheHitRate != null ? Math.round(g.cacheHitRate * 100) + '%' : '–')}${cell('Newest ledger', n ? '#' + n.seq : '–')}</div>
  ${dir.length ? `<div class="k" style="margin-top:.8rem">Network nodes</div>${dir.map(x => `<div class="row" style="gap:.6rem;font-size:.82rem;margin:.2rem 0"><span style="color:${x.up ? 'var(--ok)' : 'var(--crit)'}">●</span><span class="grow">${esc(x.name)} <span class="mut">${esc(x.role)}</span></span><span class="mut">${esc(x.state || '')} ${x.seq ? '#' + x.seq : ''}</span></div>`).join('')}` : ''}
  <details style="margin-top:.6rem"><summary class="mut" style="cursor:pointer;font-size:.8rem">Recent calls</summary><div style="font-family:monospace;font-size:.72rem;max-height:10rem;overflow:auto">${L.slice(-25).reverse().map(r => `${new Date(r.t).toISOString().slice(11, 19)} ${esc(r.m)} ${r.ms}ms ${r.ok ? '' : '<span style="color:var(--crit)">' + esc(r.err || 'fail') + '</span>'}`).join('<br>')}</div></details>`;
}

let timer: any = 0;
export function onRender(tab: string) {
  wrapReq(); refresh().then(() => { banners(); if (tab === 'network') card(); }); banners(); if (tab === 'network') card();
  clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh().then(() => { banners(); if (tab === 'network' && $('xnlcard')) card(); }); }, 30000);
}
