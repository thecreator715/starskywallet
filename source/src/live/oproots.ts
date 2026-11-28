// One place that decides where the control panel lives, so every Starsky page finds it on its own.
// Order: the last address that worked, the node this wallet is connected to, the public tunnel and panel addresses from the site
// config, the operator link from Bridge, this computer, and last of all an address someone typed by hand.
import { ctx } from './ctx.ts';
import * as Lg from './connlog.ts';
const net = () => (ctx.netKey() === 'test' ? 'test' : 'main');
const GOOD = 'starsky.op.good.';
const clean = (u: string) => String(u || '').trim().replace(/\/+$/, '');
const toHttp = (u: string) => clean(u).replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/test$/, '');
const rd = (k: string) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
export function opRoots(manualKey?: string): string[] {
  const t = net(), port = t === 'test' ? 8091 : 8090, sc = (window as any).STARSKY_CONFIG || {}, c = sc[t] || sc.main || {};
  let node = ''; try { node = toHttp((ctx as any).nodeUrl ? (ctx as any).nodeUrl() : ''); } catch { /* not connected yet */ }
  const tun = toHttp(c.url || ''); let bridge = ''; try { bridge = (JSON.parse(rd('starsky.bridge.' + t) || '{}') || {}).opUrl || ''; } catch { /* ignore */ }
  const list = [rd(GOOD + t), node && /^https?:/.test(node) ? node + '/panel/' + t : '', tun && /^https?:/.test(tun) ? tun + '/panel/' + t : '', clean(c.panel || ''), bridge, `http://127.0.0.1:${port}`, `http://localhost:${port}`, location.protocol.startsWith('http') ? location.origin : '', manualKey ? rd(manualKey + t) : ''];
  return [...new Set(list.map(clean).filter(Boolean))];
}
export function markGood(b: string) { try { localStorage.setItem(GOOD + net(), clean(b)); } catch { /* storage blocked */ } }
export async function opGet(path: string, init?: RequestInit, manualKey?: string): Promise<{ s: number; j: any; base: string; ms: number }> {
  let last = 'Cannot reach the control panel. Your node operator has not published its address.', n = 0;
  for (const b of opRoots(manualKey)) {
    try {
      const t0 = performance.now(); const r = await fetch(b + path, { cache: 'no-store', ...init, headers: { 'ngrok-skip-browser-warning': '1', ...((init && init.headers) || {}) } }); const txt = await r.text(); let j: any;
      try { j = JSON.parse(txt); } catch { last = 'An address answered with a web page, not the API (' + b.replace(/^https?:\/\//, '').slice(0, 30) + ').'; continue; }
      if (r.status === 404 && !(j && j.error)) { last = 'The operator answered 404 for ' + path.split('?')[0] + '. It needs the latest update and a restart.'; continue; }
      markGood(b); Lg.log('operator', r.status >= 400 ? 'warn' : 'ok', `${(init && init.method) || 'GET'} ${path.split('?')[0]} → ${r.status}`, performance.now() - t0, b); return { s: r.status, j, base: b, ms: performance.now() - t0 };
    } catch { n++; Lg.log('operator', 'error', `Cannot reach ${b.replace(/^https?:\/\//, '').slice(0, 40)} for ${path.split('?')[0]}`); last = 'Cannot reach ' + b.replace(/^https?:\/\//, '').slice(0, 40); }
  }
  throw new Error(last);
}
