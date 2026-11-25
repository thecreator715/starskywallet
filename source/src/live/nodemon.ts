// Monitoring for nodes running on the person's own machines: live status, sync, peers, earnings, uptime, health checks and an event log, read straight from each node.
import { ctx } from './ctx.ts';
import { info } from './chain.ts';

const $ = (id: string) => document.getElementById(id) as any;
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const fm = (n: any, d = 0) => (n == null || !isFinite(Number(n)) ? '–' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
const LK = 'starsky.nodemon.list', HK = 'starsky.nodemon.h.', EK = 'starsky.nodemon.e.';
interface Nd { id: string; name: string; url: string }
interface St { ok: boolean; at: number; info?: any; err?: string; netSeq?: number; ms?: number }
let LIST: Nd[] = [], S: Record<string, St> = {}, timer: any = 0, EARN: any = null, DEF = 'ws://localhost:6006', busy = false;
const ls = (k: string, d: any) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const sv = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const dur = (s: number) => { s = Math.max(0, Math.floor(s)); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`; };
export function setDefault(wsPort: number | string) { DEF = 'ws://localhost:' + (wsPort || 6006); }
export function setEarnings(e: any) { EARN = e; draw(); }
export function shell() { return `<div class="card" id="nm" style="margin-bottom:1rem"></div>`; }
function ask(url: string, command: string, ms = 4000): Promise<any> {
  return new Promise((res, rej) => {
    let done = false, ws: WebSocket;
    const end = (f: () => void) => { if (done) return; done = true; clearTimeout(t); try { ws.close(); } catch {} f(); };
    const t = setTimeout(() => end(() => rej(new Error('no answer'))), ms);
    try { ws = new WebSocket(url); } catch (e: any) { clearTimeout(t); return rej(e); }
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, command }));
    ws.onerror = () => end(() => rej(new Error('cannot connect')));
    ws.onmessage = ev => end(() => { try { const j = JSON.parse(String(ev.data)); j.status === 'error' || j.error ? rej(new Error(j.error_message || j.error)) : res(j.result); } catch (e) { rej(e); } });
  });
}
const hourKey = () => Math.floor(Date.now() / 3600e3);
function record(n: Nd, up: boolean, state: string) {
  const h: Record<string, [number, number]> = ls(HK + n.id, {}), k = String(hourKey()), c = h[k] || [0, 0];
  c[0] += up ? 1 : 0; c[1] += 1; h[k] = c;
  const min = hourKey() - 168; for (const x of Object.keys(h)) if (+x < min) delete h[x];
  sv(HK + n.id, h);
  const prev = (S[n.id] && S[n.id].info && S[n.id].info.server_state) || (S[n.id] && S[n.id].ok === false ? 'offline' : '');
  const now = up ? state : 'offline';
  if (prev && prev !== now) { const e: any[] = ls(EK + n.id, []); e.unshift({ t: Date.now(), m: up ? (prev === 'offline' ? `Back online (${now})` : `State changed: ${prev} → ${now}`) : 'Node stopped answering' }); sv(EK + n.id, e.slice(0, 40)); }
  else if (!prev) { const e: any[] = ls(EK + n.id, []); if (!e.length) { e.unshift({ t: Date.now(), m: up ? `Monitoring started (${now})` : 'Monitoring started, node not reachable' }); sv(EK + n.id, e); } }
}
async function poll() {
  if (busy || !$('nm')) return; busy = true;
  let net = 0; try { net = (await info()).seq; } catch {}
  await Promise.all(LIST.map(async n => {
    const t0 = Date.now();
    try {
      const r = await ask(n.url, 'server_info'), i = r.info || {};
      record(n, true, i.server_state || '?'); S[n.id] = { ok: true, at: Date.now(), info: i, netSeq: net, ms: Date.now() - t0 };
    } catch (e: any) { record(n, false, ''); S[n.id] = { ok: false, at: Date.now(), err: String(e?.message || e), netSeq: net, info: S[n.id] && S[n.id].info }; }
  }));
  busy = false; draw();
}
function up(n: Nd) { const h: Record<string, [number, number]> = ls(HK + n.id, {}), pct = (hrs: number) => { let u = 0, t = 0; for (let i = 0; i < hrs; i++) { const c = h[String(hourKey() - i)]; if (c) { u += c[0]; t += c[1]; } } return t ? (u / t) * 100 : null; }; return { d1: pct(24), d7: pct(168), bars: Array.from({ length: 24 }, (_, i) => { const c = h[String(hourKey() - 23 + i)]; return c && c[1] ? c[0] / c[1] : null; }) }; }
function card(n: Nd): string {
  const s = S[n.id], i = s && s.info, ok = !!(s && s.ok), u = up(n), now = Date.now();
  const state = ok ? i.server_state : s ? 'offline' : 'checking…', good = ok && ['full', 'proposing', 'validating'].includes(i.server_state), syncing = ok && !good;
  const vseq = ok && i.validated_ledger ? Number(i.validated_ledger.seq) : null, behind = vseq != null && s.netSeq ? Math.max(0, s.netSeq - vseq) : null;
  const peers = ok ? Number(i.peers || 0) : 0, age = ok && i.validated_ledger ? i.validated_ledger.age : null;
  const checks: [boolean | null, string][] = [
    [ok, ok ? 'Node reachable' : 'Node not reachable at ' + n.url + (s && s.err ? ' (' + s.err + ')' : '')],
    [ok ? good : null, ok ? (good ? 'Synced and working (' + state + ')' : 'Not synced yet (' + state + '). A new node needs a while to catch up.') : 'Sync state unknown'],
    [behind == null ? null : behind <= 5, behind == null ? 'Ledger gap unknown' : behind <= 5 ? `Up to date (${behind} ledger${behind === 1 ? '' : 's'} behind)` : `${fmt0(behind)} ledgers behind the network`],
    [ok ? peers >= 3 : null, ok ? `${peers} peer${peers === 1 ? '' : 's'} connected${peers < 3 ? ' (aim for 3 or more: check the open ports)' : ''}` : 'Peers unknown'],
    [u.d1 == null ? null : u.d1 >= 99, u.d1 == null ? 'No uptime history yet' : `Uptime ${u.d1.toFixed(2)}% over 24 hours${u.d1 >= 99 ? '' : ': rewards are only paid for the time the node is up'}`],
  ];
  const ev: any[] = ls(EK + n.id, []);
  const stat = (k: string, v: string, sub = '') => `<div class="tile kvt"><div class="k">${k}</div><div class="big2" style="font-size:1.15rem">${v}</div><div class="mut" style="font-size:.74rem">${sub}</div></div>`;
  return `<div class="lpcard" style="margin-top:.8rem"><div class="row" style="justify-content:space-between;gap:.6rem;flex-wrap:wrap;align-items:center"><div><b style="font-size:1.05rem">${esc(n.name)}</b> <span class="mono mut" style="font-size:.74rem">${esc(n.url)}</span></div>
    <div><span style="padding:.2rem .7rem;border-radius:2rem;font-weight:700;font-size:.8rem;background:${good ? 'rgba(52,211,153,.15);color:#34d399' : ok ? 'rgba(251,191,36,.15);color:#fbbf24' : 'rgba(248,113,113,.15);color:#f87171'}">${good ? '● Running' : ok ? '● Syncing' : '● Offline'}</span> <button class="sm ghost" onclick="window.nm.rm('${n.id}')">Remove</button></div></div>
    <div class="pgrid" style="margin-top:.6rem">${stat('State', esc(state), ok ? 'version ' + esc(String(i.build_version || '').replace(/^.*?(\d)/, '$1')) : '')}${stat('Node uptime', ok ? dur(i.uptime) : '–', 'since the node process started')}
    ${stat('Validated ledger', vseq != null ? '#' + fm(vseq) : '–', behind != null ? (behind <= 5 ? 'in step with the network' : fm(behind) + ' behind') : '')}${stat('Ledger age', age != null ? age + ' s' : '–', ok && i.complete_ledgers ? 'holds ' + esc(String(i.complete_ledgers).slice(0, 30)) : '')}
    ${stat('Peers', ok ? String(peers) : '–', ok && i.network_id != null ? 'network #' + i.network_id : '')}${stat('Load factor', ok ? fm(i.load_factor, 2) : '–', ok && i.io_latency_ms != null ? 'disk latency ' + i.io_latency_ms + ' ms' : '')}
    ${stat('Last ledger close', ok && i.last_close ? fm(i.last_close.converge_time_s, 2) + ' s' : '–', ok && i.last_close ? i.last_close.proposers + ' proposers' : '')}${stat('Reply time', s && s.ms != null ? s.ms + ' ms' : '–', 'node answered')}
    ${stat('Uptime 24h / 7d', (u.d1 != null ? u.d1.toFixed(1) + '%' : '–') + ' / ' + (u.d7 != null ? u.d7.toFixed(1) + '%' : '–'), 'measured while Starsky is open')}</div>
    <div class="nmbars" title="Last 24 hours, one bar per hour">${u.bars.map(b => `<i style="height:${b == null ? 6 : 6 + b * 34}px;background:${b == null ? 'rgba(255,255,255,.12)' : b > 0.98 ? '#34d399' : b > 0.5 ? '#fbbf24' : '#f87171'}"></i>`).join('')}</div>
    <div class="pgrid" style="margin-top:.6rem"><div class="tile"><div class="k">Health checks</div>${checks.map(([g, t]) => `<div class="dxkv"><span>${g == null ? '<span class="mut">•</span>' : g ? '<b class="up">✓</b>' : '<b class="dn">✗</b>'} ${esc(t)}</span></div>`).join('')}</div>
    <div class="tile"><div class="k">Events</div>${ev.length ? ev.slice(0, 8).map(e => `<div class="dxkv"><span class="mut">${esc(new Date(e.t).toLocaleString())}</span><span>${esc(e.m)}</span></div>`).join('') : '<div class="mut">Nothing yet.</div>'}</div></div>
    ${ok && i.pubkey_node ? `<div class="mut mono" style="font-size:.7rem;margin-top:.5rem">Node key ${esc(i.pubkey_node)}</div>` : ''}
    <div class="mut" style="font-size:.78rem;margin-top:.5rem">Last checked ${esc(new Date(s ? s.at : now).toLocaleTimeString())}. Logs: <code>docker logs -f ${esc('luma-node-' + n.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))}</code></div></div>`;
}
const fmt0 = (n: number) => fm(n, 0);
function draw() {
  const e = $('nm'); if (!e) return;
  const inp = document.activeElement && (document.activeElement as any).id;
  if (inp === 'nm_name' || inp === 'nm_url') return;
  const earn = EARN ? `<div class="pgrid" style="margin:.6rem 0">
    <div class="tile kvt"><div class="k">Earned so far</div><div class="big2">${fm(EARN.earned, 4)} LUMA</div><div class="mut" style="font-size:.74rem">${fm(EARN.txs)} transactions credited</div></div>
    <div class="tile kvt"><div class="k">Reward wallet</div><div class="big2" style="font-size:1rem">${EARN.address ? esc(String(EARN.address).slice(0, 8)) + '…' + esc(String(EARN.address).slice(-5)) : 'not set'}</div><div class="mut" style="font-size:.74rem">${EARN.balance != null ? 'balance ' + fm(EARN.balance, 4) + ' LUMA' : ''}</div></div>
    <div class="tile kvt"><div class="k">Request</div><div class="big2" style="font-size:1rem">${esc(EARN.status || '–')}</div><div class="mut" style="font-size:.74rem">${esc(EARN.label || '')}</div></div></div>` : '';
  e.innerHTML = `<div class="row" style="justify-content:space-between;gap:.6rem;flex-wrap:wrap"><div><div class="k" style="margin:0">My nodes: live monitoring</div><div class="mut" style="font-size:.8rem">Starsky reads each node directly on your own computer or server, so you can watch it like a control panel. Keep this page open to build uptime history.</div></div><button class="sm ghost" onclick="window.nm.poll()">Refresh now</button></div>
    ${earn}${LIST.length ? LIST.map(card).join('') : '<div class="mut" style="padding:.8rem 0">No nodes added yet. Add the address of the node you started (the default below is the one the setup command creates).</div>'}
    <div class="row" style="gap:.5rem;flex-wrap:wrap;margin-top:.8rem"><input id="nm_name" placeholder="Node name" style="width:12rem"><input id="nm_url" class="grow" placeholder="Node WebSocket address" value="${esc(DEF)}"><button class="pri acc" onclick="window.nm.add()">Add node</button></div>
    <div class="mut" style="font-size:.74rem;margin-top:.4rem">Use <b>ws://localhost:6006</b> on the same computer, or <b>ws://IP-ADDRESS:6006</b> for a server. Safari can block local addresses from secure pages: use Chrome, Brave or Firefox for monitoring.</div>`;
}
export function mount() {
  LIST = ls(LK, []); draw(); clearInterval(timer);
  void poll(); timer = setInterval(() => { if (!$('nm')) return clearInterval(timer); if (!document.hidden) void poll(); }, 8000);
}
export function unmount() { clearInterval(timer); }
(window as any).nm = {
  poll: () => void poll(),
  add() {
    const name = ($('nm_name').value || '').trim() || 'My node', url = ($('nm_url').value || '').trim();
    if (!/^wss?:\/\//.test(url)) return ctx.toast('The address must start with ws:// or wss://', true);
    LIST.push({ id: Math.random().toString(36).slice(2, 9), name, url }); sv(LK, LIST); draw(); void poll();
  },
  rm(id: string) { LIST = LIST.filter(n => n.id !== id); sv(LK, LIST); try { localStorage.removeItem(HK + id); localStorage.removeItem(EK + id); } catch {} delete S[id]; draw(); },
};
