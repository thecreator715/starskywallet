// LUMA Scan inside Starsky: the full explorer (Pulse, Ledgers, Activity, Pools, Search, Health, Log, Tokens, NFTs and more) as a full-width page,
// pointed at the same node as the wallet.
import html from './lumascan.html?raw';
import { ctx } from './ctx.ts';

const DEF: any = { main: { ws: 'wss://node.lumanetwork.org', panel: '' }, test: { ws: 'wss://node.lumanetwork.org/test', panel: '' } };
export const cfg = (): any => {
  const site: any = (window as any).STARSKY_CONFIG || {}, out: any = { main: { ...DEF.main }, test: { ...DEF.test } };
  for (const k of ['main', 'test']) { const s = site[k]; if (s) { if (s.url) out[k].ws = s.url; if (s.panel) out[k].panel = s.panel; } }
  try { const k = ctx.netKey() === 'test' ? 'test' : 'main', u = ctx.nodeUrl(); if (u && /^wss?:/.test(u)) out[k].ws = u; } catch {}
  return out;
};
export const doc = (): string => html.replace('window.LUMA_SCAN_CONFIG=window.LUMA_SCAN_CONFIG||{};', () => 'window.LUMA_SCAN_CONFIG=' + JSON.stringify(cfg()).replace(/</g, '\\u003c') + ';');
let loadedFor = '';
export function shell(): string {
  return `<div id="sc_root" style="position:relative;width:100%;height:calc(100vh - 7.5rem);min-height:520px;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.1);background:#000"><iframe id="sc_f" title="LUMA Scan" style="width:100%;height:100%;border:0;display:block" allow="clipboard-write"></iframe></div>`;
}
export function mount(): void {
  const f = document.getElementById('sc_f') as HTMLIFrameElement | null; if (!f) return;
  const key = JSON.stringify(cfg()); if (f.dataset.k === key) return;
  f.dataset.k = key; loadedFor = key; f.srcdoc = doc();
}
export function unmount(): void { loadedFor = ''; }
