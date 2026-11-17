// Starsky extras: preferences, send-safety checks, home attention strip + checklist, theme/large text, hide balances,
// keyboard shortcuts, installable-app manifest, node health card, pending-transfer memory. Everything is local to this browser.
import { ctx } from './ctx.ts';
import { esc, fmt, short, hexName } from './util.ts';
import * as M from './market.ts';
import * as NL from './nodelink.ts';
import * as SF from './safety.ts';
import * as More from './more.ts';
import * as Cv from './convert.ts';
import * as Tl from './toolsui.ts';

const PK = 'starsky.x.prefs';
export interface Prefs {
  hideBal: boolean; theme: 'dark' | 'light'; bigText: boolean;
  limits: Record<string, number>;          // per-asset daily send limit (0 / missing = none)
  allowOnly: boolean;                      // only send to the address book
  backedUp: number;                        // ms timestamp of the last backup export (0 = never)
  known: Record<string, number>;           // recipients we have already paid: classic address -> last ms
  sent: { t: number; a: string; n: number }[]; // recent sends for the daily limit
  notify: boolean; dismissed: Record<string, number>;
}
const D: Prefs = { hideBal: false, theme: 'dark', bigText: false, limits: {}, allowOnly: false, backedUp: 0, known: {}, sent: [], notify: false, dismissed: {} };
let P: Prefs = load();
function load(): Prefs { try { return { ...D, ...JSON.parse(localStorage.getItem(PK) || '{}') }; } catch { return { ...D }; } }
function save() { try { localStorage.setItem(PK, JSON.stringify(P)); } catch {} }
export const prefs = () => P;
const $ = (id: string) => document.getElementById(id);

// ---------- look & feel ----------
export function applyPrefs() {
  const r = document.documentElement;
  r.setAttribute('data-theme', P.theme);
  r.classList.toggle('bigtext', P.bigText);
  r.classList.toggle('hidebal', P.hideBal);
  try { document.querySelector('meta[name=theme-color]')?.setAttribute('content', P.theme === 'light' ? '#f4f1ff' : '#06020d'); } catch {}
}
export function installManifest() {
  try {
    if (document.querySelector('link[rel=manifest]')) return;
    const icon = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#06020d"/><path d="M16 4l3.2 8.4L28 15.4l-7 5.3 2.4 8.6L16 24l-7.4 5.3L11 20.7 4 15.4l8.8-3z" fill="#00ff8c"/></svg>');
    const m = { name: 'Starsky Wallet', short_name: 'Starsky', start_url: './', display: 'standalone', background_color: '#06020d', theme_color: '#06020d', icons: [{ src: icon, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] };
    const l = document.createElement('link'); l.rel = 'manifest'; l.href = 'data:application/manifest+json,' + encodeURIComponent(JSON.stringify(m)); document.head.appendChild(l);
    if (!document.querySelector('meta[name=theme-color]')) { const t = document.createElement('meta'); t.name = 'theme-color'; t.content = '#06020d'; document.head.appendChild(t); }
    for (const [n, c] of [['apple-mobile-web-app-capable', 'yes'], ['mobile-web-app-capable', 'yes'], ['apple-mobile-web-app-title', 'Starsky']]) { if (!document.querySelector(`meta[name="${n}"]`)) { const t = document.createElement('meta'); t.name = n; t.content = c; document.head.appendChild(t); } }
  } catch {}
}

// ---------- send safety ----------
const dayAgo = () => Date.now() - 86400000;
const sentToday = (asset: string) => P.sent.filter(s => s.a === asset && s.t > dayAgo()).reduce((t, s) => t + s.n, 0);
export interface SendIn { dest: string; destShown: string; asset: string; amt: number; avail: number; tag: string; book: { name: string; addr: string }[]; native: string; }
export interface SendCheck { block: string[]; warn: string[]; info: string[]; }
/** Quick local checks (no network). Blocks can be overridden by the user, except an allowlist/limit the user set must be lifted in Preferences. */
export function sendCheckLocal(i: SendIn): SendCheck {
  const block: string[] = [], warn: string[] = [], info: string[] = [];
  const inBook = i.book.some(b => safe(() => ctx.toClassic(b.addr)) === i.dest);
  if (P.allowOnly && !inBook) block.push('Your safety setting only allows sending to saved addresses. Save this one in the address book first (or turn the setting off in More → Preferences).');
  const lim = P.limits[i.asset] || 0;
  if (lim > 0) { const used = sentToday(i.asset); if (used + i.amt > lim + 1e-9) block.push(`This would take today's ${i.asset} sending to ${fmt(used + i.amt, 4)}, above your daily limit of ${fmt(lim, 4)} (${fmt(used, 4)} already sent in the last 24 h). Change the limit in More → Preferences.`); }
  if (!inBook && !P.known[i.dest]) warn.push('First time you are paying this address. Double-check every character, or send a small test first.');
  // look-alike: same start and end as a saved/known address but not the same address
  const cand = [...i.book.map(b => safe(() => ctx.toClassic(b.addr)) || ''), ...Object.keys(P.known)].filter(Boolean);
  const alike = cand.find(c => c !== i.dest && c.slice(0, 5) === i.dest.slice(0, 5) && c.slice(-4) === i.dest.slice(-4));
  if (alike) warn.push(`Looks almost like ${short(ctx.showL(alike), 8, 6)} from your contacts but it is a DIFFERENT address. Scam addresses are often made to look like real ones.`);
  if (i.avail > 0 && i.amt >= i.avail * 0.9) warn.push(`This sends ${Math.round((i.amt / i.avail) * 100)}% of your spendable ${i.asset}.`);
  if (i.asset === i.native && i.avail - i.amt < 0.3 && i.avail - i.amt >= 0) warn.push(`You would be left with under 0.3 ${i.native} for fees.`);
  if (inBook) info.push('Saved contact: ' + (i.book.find(b => safe(() => ctx.toClassic(b.addr)) === i.dest)?.name || ''));
  else if (P.known[i.dest]) info.push('Paid before (' + new Date(P.known[i.dest]).toLocaleDateString() + ')');
  return { block, warn, info };
}
/** Network checks on the recipient (activation, destination-tag requirement). */
export async function sendCheckNet(i: SendIn): Promise<SendCheck> {
  const block: string[] = [], warn: string[] = [], info: string[] = [];
  try {
    const r: any = await Promise.race([ctx.req('account_info', { account: i.dest, ledger_index: 'validated' }), new Promise((_, j) => setTimeout(() => j(new Error('t')), 6000))]);
    const f = Number(r?.account_data?.Flags || 0);
    if (f & 0x00020000 && !i.tag) block.push('This account REQUIRES a destination tag (exchanges and custodians do) and you left it empty. The payment would be rejected or lost. Add the tag.');
    else if (f & 0x00020000) info.push('Destination tag provided ✓');
    if (f & 0x00100000) warn.push('This account has deposit authorization on: it only accepts payments from accounts it approved.');
  } catch (e: any) {
    const m = String(e?.message || e);
    if (/actNotFound|Account not found/i.test(m)) warn.push(i.asset === i.native ? 'This address is not active yet on the ledger. A first payment must be large enough to cover the network reserve or it fails.' : 'This address is not active yet, so it cannot hold tokens until it is funded and sets a trust line.');
  }
  return { block, warn, info };
}
export function renderChecks(c: SendCheck, host: string) {
  const e = $(host); if (!e) return;
  const li = (cls: string, t: string) => `<div style="font-size:.82rem;margin:.25rem 0;color:${cls === 'b' ? 'var(--crit)' : cls === 'w' ? 'var(--warn)' : 'var(--ok)'}">${cls === 'b' ? '⛔' : cls === 'w' ? '⚠' : '✓'} ${esc(t)}</div>`;
  e.innerHTML = c.block.map(t => li('b', t)).join('') + c.warn.map(t => li('w', t)).join('') + c.info.map(t => li('i', t)).join('');
}
export function recordSend(dest: string, asset: string, amt: number) {
  P.known[dest] = Date.now(); P.sent.push({ t: Date.now(), a: asset, n: amt }); P.sent = P.sent.filter(s => s.t > dayAgo()).slice(-200);
  const k = Object.keys(P.known); if (k.length > 300) for (const x of k.sort((a, b) => P.known[a] - P.known[b]).slice(0, k.length - 300)) delete P.known[x];
  save();
}
export const recentRecipients = (n = 5) => Object.entries(P.known).sort((a, b) => b[1] - a[1]).slice(0, n).map(([a]) => a);
export function markBackedUp() { P.backedUp = Date.now(); save(); }
const safe = <T,>(f: () => T): T | '' => { try { return f(); } catch { return '' as any; } };

// ---------- home: attention strip + checklist ----------
export interface HomeCtx { unfunded: boolean; online: boolean; lockMin: number; hasKnown?: boolean; }
function homeStrip(h: HomeCtx) {
  const view = $('view'); if (!view) return;
  $('xhome')?.remove();
  const items: { id: string; t: string; act?: string }[] = [];
  const stale = P.backedUp && Date.now() - P.backedUp > 90 * 86400000;
  if (!P.backedUp) items.push({ id: 'backup', t: 'No encrypted backup yet. If this browser is cleared you lose access to your wallets.', act: `<button class="sm pri" onclick="window.exportVault()">Back up now</button>` });
  else if (stale) items.push({ id: 'backup2', t: 'Your last backup is over 3 months old. Wallets you added since are not in it.', act: `<button class="sm pri" onclick="window.exportVault()">Back up again</button>` });
  if (h.unfunded) items.push({ id: 'unfunded', t: 'This wallet is not activated yet. Fund it to start using it.', act: `<button class="sm" onclick="window.goTab('receive')">Show my address</button>` });
  if (!h.online) items.push({ id: 'offline', t: 'Not connected to the node right now. Balances may be out of date.' });
  if (!h.lockMin) items.push({ id: 'lock', t: 'Auto-lock is off. Anyone with this unlocked browser can spend.', act: `<button class="sm" onclick="window.goTab('more')">Set a timer</button>` });
  const live = items.filter(i => !P.dismissed[i.id] || Date.now() - P.dismissed[i.id] > 7 * 86400000);
  const done = [!!P.backedUp, h.online && !h.unfunded, Object.keys(P.known).length > 0];
  const showList = done.some(d => !d) && !P.dismissed['checklist'];
  if (!live.length && !showList) return;
  const box = document.createElement('div'); box.id = 'xhome'; box.className = 'xhome';
  box.innerHTML = (live.length ? `<div class="card xattn"><div class="k">Needs attention</div>${live.map(i => `<div class="row" style="align-items:center;gap:.5rem;margin:.3rem 0"><span style="color:var(--warn)">●</span><span class="grow" style="font-size:.88rem">${esc(i.t)}</span>${i.act || ''}<button class="sm ghost" title="Hide for a week" onclick="window.xt.dismiss('${i.id}')">✕</button></div>`).join('')}</div>` : '')
    + (showList ? `<div class="card" style="margin-top:.6rem"><div class="row" style="justify-content:space-between"><div class="k" style="margin:0">Getting started</div><button class="sm ghost" onclick="window.xt.dismiss('checklist')">Hide</button></div>${[['Back up your wallets', done[0], "window.exportVault()", 'Export'], ['Fund your wallet', done[1], "window.goTab('receive')", 'Receive'], ['Make your first payment', done[2], "window.goTab('send')", 'Send']].map(([t, d, a, b]: any) => `<div class="row" style="align-items:center;gap:.5rem;margin:.3rem 0"><span style="color:${d ? 'var(--ok)' : 'var(--mut)'};font-size:1.1rem">${d ? '✓' : '○'}</span><span class="grow ${d ? 'mut' : ''}" style="${d ? 'text-decoration:line-through' : ''}">${esc(t)}</span>${d ? '' : `<button class="sm" onclick="${a}">${b}</button>`}</div>`).join('')}</div>` : '');
  view.insertBefore(box, view.firstChild);
}

// ---------- network: node health ----------
let healthT: any = 0;
async function nodeHealth() {
  const view = $('view'); if (!view || !$('nwhealthhost') && !view.querySelector('.nwpage, #nw, [id^=nw]')) { /* still mount on top */ }
  if (!view) return;
  let box = $('xhealth');
  if (!box) { box = document.createElement('div'); box.id = 'xhealth'; box.className = 'card'; box.style.marginBottom = '.8rem'; view.insertBefore(box, view.firstChild); box.innerHTML = '<div class="k">Node health</div><div class="mut">Reading the node…</div>'; }
  try {
    const t0 = Date.now(), r: any = await ctx.req('server_info'); const ms = Date.now() - t0, i = r.info || {}, v = i.validated_ledger || {};
    const age = Number(v.age ?? 0), peers = Number(i.peers ?? 0), q = i.validation_quorum, st = String(i.server_state || '');
    const good = ['full', 'proposing', 'validating'].includes(st) && age < 20, cls = (ok: boolean) => ok ? 'var(--ok)' : 'var(--warn)';
    const cell = (k: string, v2: string, c = '') => `<div style="min-width:7rem"><div class="mut" style="font-size:.72rem">${k}</div><div style="font-weight:700;color:${c}">${v2}</div></div>`;
    box.innerHTML = `<div class="k">Node health</div><div class="row" style="gap:1rem;flex-wrap:wrap">${cell('State', esc(st || '–'), cls(good))}${cell('Ledger', '#' + esc(String(v.seq || '–')))}${cell('Ledger age', age + ' s', cls(age < 20))}${cell('Peers', String(peers), cls(peers > 0))}${cell('Quorum', esc(String(q ?? '–')))}${cell('Response', ms + ' ms', cls(ms < 1500))}${cell('Load', esc(String(i.load_factor ?? 1)))}${cell('Build', esc(String(i.build_version || '–')))}</div>`;
  } catch (e: any) { box.innerHTML = `<div class="k">Node health</div><div style="color:var(--crit)">Cannot read the node: ${esc(String(e?.message || e))}</div>`; }
}

// ---------- keyboard shortcuts ----------
let kbOn = false;
function shortcuts() {
  if (kbOn) return; kbOn = true;
  const map: Record<string, string> = { h: 'home', s: 'send', r: 'receive', d: 'dex', b: 'bridge', m: 'markets', a: 'activity', n: 'network', p: 'pools', w: 'wallets' };
  window.addEventListener('keydown', e => {
    const t = e.target as HTMLElement, typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('#modal:not(:empty), .modal-open, #brwiz, #brflow')) return;
    if (e.key === '/') { const g = $('gs') as HTMLInputElement | null; if (g) { e.preventDefault(); g.focus(); g.select(); } }
    else if (e.key === '?') { e.preventDefault(); ctx.modal(`<h2>Keyboard shortcuts</h2><table style="margin:.8rem 0">${[['/', 'Search a hash or address'], ['h', 'Home'], ['s', 'Send'], ['r', 'Receive'], ['d', 'DEX'], ['b', 'Bridge'], ['m', 'Markets'], ['a', 'Activity'], ['p', 'Pools'], ['n', 'Network'], ['w', 'Wallets'], ['?', 'This list']].map(([k, v]) => `<tr><td><kbd style="padding:.1rem .45rem;border:1px solid var(--line);border-radius:.3rem">${k}</kbd></td><td>${v}</td></tr>`).join('')}</table><button class="pri grow" onclick="window.closeModal()">Close</button>`); }
    else if (map[e.key] && (window as any).goTab) (window as any).goTab(map[e.key]);
  });
}

// ---------- preferences card (More page) ----------
export function settingsShell() {
  const nat = ctx.native(), assets = [nat, 'USD'];
  return `<div class="card c12" id="xprefs"><div class="k">Preferences & safety</div>
  <div class="row" style="gap:.6rem;flex-wrap:wrap;align-items:center"><b style="width:9rem">Look</b>
    <div class="seg"><button class="${P.theme === 'dark' ? 'on' : ''}" onclick="window.xt.set('theme','dark')">Dark</button><button class="${P.theme === 'light' ? 'on' : ''}" onclick="window.xt.set('theme','light')">Light</button></div>
    <label style="display:flex;gap:.4rem;align-items:center"><input type="checkbox" ${P.bigText ? 'checked' : ''} onchange="window.xt.set('bigText',this.checked)"> Larger text</label>
    <label style="display:flex;gap:.4rem;align-items:center"><input type="checkbox" ${P.hideBal ? 'checked' : ''} onchange="window.xt.set('hideBal',this.checked)"> Hide balances</label></div>
  <div class="row" style="gap:.6rem;flex-wrap:wrap;align-items:center;margin-top:.7rem"><b style="width:9rem">Send safety</b>
    <label style="display:flex;gap:.4rem;align-items:center"><input type="checkbox" ${P.allowOnly ? 'checked' : ''} onchange="window.xt.set('allowOnly',this.checked)"> Only send to saved addresses</label></div>
  <div style="margin-top:.5rem" class="mut"><small>Daily send limits (rolling 24 h, 0 = no limit). Applies to Send on this device.</small></div>
  <div class="row" style="gap:.6rem;flex-wrap:wrap;margin-top:.3rem">${assets.map(a => `<label style="display:flex;gap:.4rem;align-items:center">${esc(a)} <input style="width:8rem" inputmode="decimal" value="${P.limits[a] || ''}" placeholder="no limit" onchange="window.xt.limit('${esc(a)}',this.value)"></label>`).join('')}</div>
  <div class="row" style="gap:.6rem;flex-wrap:wrap;align-items:center;margin-top:.7rem"><b style="width:9rem">Backup</b><span class="mut">${P.backedUp ? 'Last exported ' + new Date(P.backedUp).toLocaleDateString() : 'Never exported'}</span><button class="sm" onclick="window.exportVault()">Export now</button></div>
  <div class="row" style="gap:.6rem;flex-wrap:wrap;align-items:center;margin-top:.7rem"><b style="width:9rem">Notifications</b><label style="display:flex;gap:.4rem;align-items:center"><input type="checkbox" ${P.notify ? 'checked' : ''} onchange="window.xt.notify(this.checked)"> Tell me when a bridge transfer arrives</label></div>
  <div class="mut" style="margin-top:.7rem"><small>Tip: press <b>?</b> anywhere for keyboard shortcuts. Install Starsky from your browser menu (Add to Home Screen / Install app) to open it like an app.</small></div></div>`;
}
export const xt = {
  set(k: string, v: any) { (P as any)[k] = v; save(); applyPrefs(); if (k !== 'theme' && k !== 'bigText' && k !== 'hideBal') return; ctx.rerender(); },
  limit(a: string, v: string) { const n = parseFloat(v); if (n > 0) P.limits[a] = n; else delete P.limits[a]; save(); ctx.toast(n > 0 ? `Daily ${a} limit set to ${fmt(n, 4)}` : `Daily ${a} limit removed`); },
  dismiss(id: string) { P.dismissed[id] = Date.now(); save(); const e = $('xhome'); if (e) e.remove(); ctx.rerender(); },
  async notify(on: boolean) { if (on && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} } P.notify = on && (!('Notification' in window) || Notification.permission !== 'denied'); save(); if (on && !P.notify) ctx.toast('Notifications are blocked in your browser settings', true); },
};
export function notifyArrival(title: string, body: string) {
  try { if (P.notify && 'Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body }); } catch {}
}

// ---------- pending bridge transfers (survive a refresh) ----------
const PB = 'starsky.x.pendingBridge';
export interface Pending { srcId: string; destNet: 'xrpl' | 'luma'; dest: string; amt: string; label: string; t: number; }
export const pendingGet = (): Pending | null => { try { const p = JSON.parse(localStorage.getItem(PB) || 'null'); return p && Date.now() - p.t < 30 * 60000 ? p : null; } catch { return null; } };
export const pendingSet = (p: Pending | null) => { try { p ? localStorage.setItem(PB, JSON.stringify(p)) : localStorage.removeItem(PB); } catch {} };

// ---------- price alerts (Markets page) ----------
interface Alert { key: string; label: string; dir: 'above' | 'below'; price: number; unit: 'native' | 'usd'; at: number; }
const AK = () => 'starsky.x.alerts.' + ctx.netKey();
const alerts = (): Alert[] => { try { return JSON.parse(localStorage.getItem(AK()) || '[]'); } catch { return []; } };
const saveAlerts = (a: Alert[]) => { try { localStorage.setItem(AK(), JSON.stringify(a)); } catch {} };
let alertT: any = 0, lastSnap: M.Snap | null = null;
const priceOf = (s: M.Snap, a: Alert): number | null => { const n = a.key === 'native' ? 1 : s.px.get(a.key); if (n == null) return null; return a.unit === 'usd' ? (s.usdPerNative == null ? null : n * s.usdPerNative) : n; };
async function checkAlerts() {
  const list = alerts(); if (!list.length || !ctx.online()) return;
  try {
    const s = await M.snapshot(); lastSnap = s; const keep: Alert[] = [];
    for (const a of list) {
      const p = priceOf(s, a);
      if (p != null && (a.dir === 'above' ? p >= a.price : p <= a.price)) { const t = `${a.label} is ${a.dir === 'above' ? 'above' : 'below'} ${fmt(a.price, 6)} ${a.unit === 'usd' ? 'USD' : ctx.native()} (now ${fmt(p, 6)})`; ctx.toast('🔔 ' + t); notifyArrival('Price alert', t); }
      else keep.push(a);
    }
    if (keep.length !== list.length) { saveAlerts(keep); if ($('xalerts')) alertsPaint(); }
  } catch {}
}
async function alertsPaint() {
  const e = $('xalerts'); if (!e) return;
  const list = alerts();
  if (!lastSnap) { try { lastSnap = await M.snapshot(); } catch {} }
  const opts: { k: string; l: string }[] = [{ k: 'native', l: ctx.native() }];
  if (lastSnap) for (const k of lastSnap.px.keys()) { if (k === 'native') continue; const [c] = k.split('|'); opts.push({ k, l: hexName(c) }); }
  e.innerHTML = `<div class="k">Price alerts</div>
    <div class="row" style="gap:.5rem;flex-wrap:wrap;align-items:center"><select id="xa_k">${opts.map(o => `<option value="${esc(o.k)}">${esc(o.l)}</option>`).join('')}</select>
    <select id="xa_d"><option value="above">goes above</option><option value="below">falls below</option></select>
    <input id="xa_p" inputmode="decimal" placeholder="price" style="width:9rem"><select id="xa_u"><option value="native">${esc(ctx.native())}</option><option value="usd">USD</option></select>
    <button class="sm pri" onclick="window.xt.addAlert()">Add alert</button></div>
    ${list.length ? `<table class="dxt" style="margin-top:.6rem"><tbody>${list.map((a, i) => { const p = lastSnap ? priceOf(lastSnap, a) : null; return `<tr><td><b>${esc(a.label)}</b> ${a.dir === 'above' ? '≥' : '≤'} ${fmt(a.price, 6)} ${a.unit === 'usd' ? 'USD' : esc(ctx.native())}</td><td class="mut">now ${p != null ? fmt(p, 6) : '–'}</td><td class="r"><button class="sm ghost" onclick="window.xt.delAlert(${i})">✕</button></td></tr>`; }).join('')}</tbody></table>` : '<div class="mut" style="margin-top:.5rem;font-size:.84rem">No alerts. Starsky checks the pool prices once a minute while this page is open and tells you when a price crosses.</div>'}`;
}
(xt as any).addAlert = () => {
  const k = ($('xa_k') as HTMLSelectElement).value, d = ($('xa_d') as HTMLSelectElement).value as any, p = parseFloat(($('xa_p') as HTMLInputElement).value), u = ($('xa_u') as HTMLSelectElement).value as any;
  if (!(p > 0)) return ctx.toast('Enter a price above 0', true);
  const label = k === 'native' ? ctx.native() : hexName(k.split('|')[0]);
  saveAlerts([...alerts(), { key: k, label, dir: d, price: p, unit: u, at: Date.now() }]); alertsPaint(); startAlerts();
  const cur = lastSnap ? priceOf(lastSnap, { key: k, label, dir: d, price: p, unit: u, at: 0 }) : null;
  if (cur != null && (d === 'above' ? cur >= p : cur <= p)) ctx.toast('That price is already crossed: the alert fires on the next check');
};
(xt as any).delAlert = (i: number) => { const l = alerts(); l.splice(i, 1); saveAlerts(l); alertsPaint(); };
function startAlerts() { if (alertT) return; alertT = setInterval(checkAlerts, 60000); }

// ---------- operator notice banner (notice.json beside the app) ----------
async function notice() {
  try {
    const r = await fetch('./notice.json?t=' + Math.floor(Date.now() / 60000), { cache: 'no-store' }); if (!r.ok) return;
    const j = await r.json(); if (!j || !j.text || (j.until && Date.parse(j.until) < Date.now())) { $('xnotice')?.remove(); return; }
    if (P.dismissed['n:' + (j.id || j.text)]) return;
    let b = $('xnotice');
    const view = $('view'); if (!view) return;
    if (!b) { b = document.createElement('div'); b.id = 'xnotice'; view.insertBefore(b, view.firstChild); }
    const col = j.level === 'bad' ? 'var(--crit)' : j.level === 'ok' ? 'var(--ok)' : 'var(--warn)';
    b.innerHTML = `<div class="card" style="border-color:${col};margin-bottom:.8rem"><div class="row" style="align-items:center;gap:.6rem"><span style="color:${col};font-size:1.1rem">●</span><span class="grow">${esc(String(j.text))}</span><button class="sm ghost" onclick="window.xt.dismissNotice('${esc(String(j.id || j.text)).replace(/'/g, '')}')">✕</button></div></div>`;
  } catch {}
}
(xt as any).dismissNotice = (id: string) => { P.dismissed['n:' + id] = Date.now(); save(); $('xnotice')?.remove(); };

// ---------- per-render hook ----------
export function afterRender(tab: string, h: HomeCtx) {
  applyPrefs();
  clearInterval(healthT); healthT = 0;
  if (tab === 'home') homeStrip(h);
  notice();
  try { NL.onRender(tab); } catch {}
  try { SF.onRender(tab); } catch {}
  try { More.onRender(tab); } catch {}
  try { Cv.onRender(tab); } catch {}
  try { Tl.onRender(tab); } catch {}
  if (tab === 'markets') { const v = $('view'); if (v && !$('xalerts')) { const c = document.createElement('div'); c.id = 'xalerts'; c.className = 'card'; c.style.marginTop = '1rem'; v.appendChild(c); } alertsPaint(); startAlerts(); }
  if (tab === 'network') { nodeHealth(); healthT = setInterval(() => { if (!$('xhealth')) { clearInterval(healthT); healthT = 0; return; } nodeHealth(); }, 10000); }
}
export function boot() { applyPrefs(); installManifest(); shortcuts(); (window as any).xt = xt; if (alerts().length) startAlerts(); }
