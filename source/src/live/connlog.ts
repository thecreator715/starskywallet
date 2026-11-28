// Activity log for everything Starsky does over the network: node requests, transactions, operator (control panel) calls and
// connection changes. Kept in memory (last 1500) and the latest 300 are saved in this browser so they survive a refresh.
export type Lvl = 'info' | 'ok' | 'warn' | 'error';
export interface Ev { t: number; src: string; lvl: Lvl; msg: string; ms?: number; detail?: string }
const KEY = 'starsky.activity.v1', MAX = 1500, SAVE = 300;
let EV: Ev[] = []; let loaded = false, saveT: any = 0; const subs = new Set<() => void>();
const load = () => { if (loaded) return; loaded = true; try { EV = JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch { EV = []; } };
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(EV.slice(-SAVE))); } catch { /* storage blocked */ } }, 1500); };
export function log(src: string, lvl: Lvl, msg: string, ms?: number, detail?: string) {
  load(); EV.push({ t: Date.now(), src, lvl, msg: String(msg).slice(0, 300), ms: ms == null ? undefined : Math.round(ms), detail: detail ? String(detail).slice(0, 600) : undefined }); if (EV.length > MAX) EV.splice(0, EV.length - MAX); save(); subs.forEach(f => { try { f(); } catch { /* ignore */ } });
}
export const all = (): Ev[] => { load(); return EV; };
export const clear = () => { EV = []; save(); subs.forEach(f => f()); };
export const onChange = (f: () => void) => { subs.add(f); return () => subs.delete(f); };
export interface Filter { src?: string; lvl?: string; q?: string; since?: number }
export function filter(list: Ev[], f: Filter): Ev[] { const q = (f.q || '').toLowerCase(); return list.filter(e => (!f.src || f.src === 'all' || e.src === f.src) && (!f.lvl || f.lvl === 'all' || e.lvl === f.lvl) && (!f.since || e.t >= f.since) && (!q || (e.msg + ' ' + (e.detail || '') + ' ' + e.src).toLowerCase().includes(q))); }
export function stats(list: Ev[]) { const t = list.filter(e => e.ms != null), errs = list.filter(e => e.lvl === 'error').length; const ms = t.map(e => e.ms as number).sort((a, b) => a - b); return { total: list.length, errors: errs, warns: list.filter(e => e.lvl === 'warn').length, avgMs: t.length ? Math.round(t.reduce((a, e) => a + (e.ms as number), 0) / t.length) : null, p95Ms: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : null, sources: [...new Set(list.map(e => e.src))].sort() }; }
const cell = (s: string | number | undefined) => { const v = String(s ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
export const toCsv = (list: Ev[]) => ['time,source,level,message,ms,detail', ...list.map(e => [new Date(e.t).toISOString(), e.src, e.lvl, e.msg, e.ms, e.detail].map(cell).join(','))].join('\n');
