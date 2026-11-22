// LUMA Social: a social network whose database is the LUMA chain.
// Every action is a tiny LUMA payment to the network's "hub" address carrying a JSON memo (type "luma-social"). The chain keeps the order, the author (the signer) and the time.
// This page reads the hub's history, replays it in order, and builds everything you see: posts, threads, likes, reactions, follows, profiles, handles, polls, boosts, tips, trends.
// Tips are real payments straight to the person tipped, in LUMA or any token; a small public log entry in the hub lets everyone see them, and every reader verifies each tip on the chain.
// No company server holds anything. Anyone can rebuild the same network from the chain, and nobody can post as you without your key.
import { ctx } from './ctx.ts';
import { amtTx, esc, fmt, hexName } from './util.ts';
import { ipfsAdd, mintFromImage } from './nft.ts';
import * as CAM from './camera.ts';
import { base } from './nodelink.ts';

const MT = 'luma-social';
const HUBS: Record<string, string> = { main: 'rHNDrZSmSH6TqDCfA1KENwwZyKwHmStvPL', test: 'rGeYQ26dzMz3TfTqz34dpBfmpHZpHbeFdE' };
// what each action costs (LUMA). The network fee of the chain is on top. All of it lands in the hub; tips go straight to the person tipped.
const COST: Record<string, number> = { post: 0.000001, rt: 0.001, like: 0.0001, unl: 0.0001, fol: 0.001, unf: 0.001, prof: 0.01, hdl: 1, vote: 0.0001, del: 0.0001, rx: 0.0001, boost: 1, edit: 0.001, pin: 0.0001, tipn: 0.0001, rep: 0.0001, lst: 0.01, lup: 0.001, ofr: 0.0001, ask: 0.0001, ans: 0.0001, rev: 0.0001, chk: 0.000001 };
const MAXTXT = 500, MAXMEMO = 900, MAXPARTS = 10, RIPPLE_EPOCH = 946684800;
const EMOJI = ['🔥', '😂', '🚀', '👏', '😮', '😢'];

const net = () => (ctx.netKey() === 'test' ? 'test' : 'main');
/** Boosts are paid to the Genesis wallet (network config, or the Genesis address saved in Starsky). Falls back to the hub if none is known. */
const genesis = (): string => { const c = (window as any).STARSKY_CONFIG || {}; let g = ''; try { g = (c.genesis && c.genesis[net()]) || localStorage.getItem('starsky.genesis.' + ctx.netKey()) || ''; } catch { /* */ } return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(g) ? g : ''; };
const boostDest = (): string => genesis() || hub();
const hub = () => { const c = (window as any).STARSKY_CONFIG || {}; return (c.socialHub && c.socialHub[net()]) || HUBS[net()]; };
const enc = new TextEncoder(), dec = new TextDecoder();
const toHex = (s: string) => Array.from(enc.encode(s)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const fromHex = (h: string) => { try { const a = new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16))); return dec.decode(a); } catch { return ''; } };
const isAddr = (a: any) => typeof a === 'string' && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a);
const isHash = (a: any) => typeof a === 'string' && /^[0-9A-Fa-f]{64}$/.test(a);

// ---------- the index: rebuilt from the chain ----------
interface Ev { h: string; a: string; t: number; l: number; i: number; v: number; d: any }
interface Post { id: string; a: string; t: number; x: string; m: string[]; q?: string; r?: string; p?: string[]; n?: string; del?: boolean; mod?: boolean; ed?: number }
interface Prof { n?: string; b?: string; i?: string; k?: string; c?: string; w?: string; l?: string; pr?: string; jb?: string; st?: string; sh?: string; ln?: Array<{ t: string; u: string }> }
interface Tip { th: string; by: string; to: string; ref: string; c: string; i: string; v: number; t: number; m: string }
interface Idx {
  posts: Map<string, Post>; replies: Map<string, string[]>; likes: Map<string, Set<string>>; rts: Map<string, Set<string>>; rtEv: Array<{ by: string; ref: string; t: number; h: string }>;
  follows: Map<string, Set<string>>; followers: Map<string, Set<string>>; prof: Map<string, Prof>; owner: Map<string, string>; cur: Map<string, string>;
  votes: Map<string, Map<string, number>>; rx: Map<string, Map<string, string>>; boosts: Map<string, Array<{ by: string; v: number; t: number }>>; pin: Map<string, string>;
  tipClaims: Array<{ th: string; by: string; to: string; ref: string; t: number; m: string; k?: string; q?: number }>; tipsRef: Map<string, Tip[]>; tipsTo: Map<string, Tip[]>; tipsBy: Map<string, Tip[]>; tipsAll: Tip[];
  order: string[]; maxLedger: number; refBy: Map<string, string>; chk: Map<string, Set<number>>;
}
let EV: Ev[] = [];
let TV: Record<string, any> = {};          // verified tips by payment hash (0 = checked and rejected)
let IX: Idx = blank();
function blank(): Idx { return { posts: new Map(), replies: new Map(), likes: new Map(), rts: new Map(), rtEv: [], follows: new Map(), followers: new Map(), prof: new Map(), owner: new Map(), cur: new Map(), votes: new Map(), rx: new Map(), boosts: new Map(), pin: new Map(), tipClaims: [], tipsRef: new Map(), tipsTo: new Map(), tipsBy: new Map(), tipsAll: [], order: [], maxLedger: 0, refBy: new Map(), chk: new Map() }; }
const setOf = <K>(m: Map<K, Set<string>>, k: K) => { let s = m.get(k); if (!s) m.set(k, (s = new Set())); return s; };
const listOf = <V>(m: Map<string, V[]>, k: string) => { let s = m.get(k); if (!s) m.set(k, (s = [])); return s; };
const clip = (v: any, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const safeUrl = (u: any): string => {
  if (typeof u !== 'string') return ''; u = u.trim();
  if (/^ipfs:\/\/[A-Za-z0-9/_.\-]{10,200}$/.test(u)) return pubGw() + u.slice(7).replace(/^ipfs\//, '');
  return /^https:\/\/[^\s"'<>\\]{4,300}$/.test(u) ? u : '';
};
const tokName = (c: string) => (c === 'LUMA' || c === 'native' || c === 'XRP' ? 'LUMA' : hexName(c));
const tokKey = (c: string, i: string) => (tokName(c) === 'LUMA' ? 'LUMA' : c + '|' + i);


// ---------- the platform policy: what the operator hides, bans and allows. The built-in rules below always apply, even when the operator's panel cannot be reached. ----------
const RULES0: Record<string, string> = {
  child: String.raw`\b(child|children|kid|kids|minor|minors|underage|under-?age|teen|teens|toddler|preteen|schoolgirl|schoolboy)\b.{0,50}\b(porn\w*|sex\w*|nude|naked|explicit|xxx|nsfw|erotic\w*)\b|\b(porn\w*|sex\w*|nude|naked|explicit|xxx|nsfw|erotic\w*)\b.{0,50}\b(child|children|kid|kids|minor|minors|underage|under-?age|teen|teens|toddler|preteen|schoolgirl|schoolboy)\b|\b(loli\w*|shota\w*|pedo\w*|paedo\w*)\b`,
  sexual: String.raw`\b(porn\w*|xxx|nsfw|nudes?|hardcore|blowjob|handjob|cumshot|creampie|orgasm\w*|erotic\w*|onlyfans|hentai|milf|dick ?pics?|anal sex|sex ?tapes?|sex ?chat|camgirls?|escort services?|fetish|bondage|horny|naked)\b`,
  violence: String.raw`\b(gore|beheading\w*|decapitat\w*|snuff|torture video|mass shooting|rape\w*|lynch\w*|how to make a bomb|bomb making|i('| wi)ll (kill|murder|shoot|stab) (you|him|her|them|everyone)|kill (yourself|your ?self)|kys|death threat\w*)\b`,
};
interface Pol { on: boolean; readOnly: boolean; banner: string; imageMode: string; imageHosts: string[]; blurMedia: boolean; flags: { sexual: boolean; violence: boolean; child: boolean }; rules: Record<string, string>; words: string[]; patterns: string[]; hidden: Set<string>; banned: Set<string>; verified: Set<string>; badProfiles: string[]; at: number; ok: boolean }
const POL0 = (): Pol => ({ on: true, readOnly: false, banner: '', imageMode: 'any', imageHosts: [], blurMedia: true, flags: { sexual: true, violence: true, child: true }, rules: RULES0, words: [], patterns: [], hidden: new Set(), banned: new Set(), verified: new Set(), badProfiles: [], at: 0, ok: false });
let POL: Pol = POL0(), RXC: Array<[string, RegExp]> = [];
function setPol(j: any) {
  const p = POL0(); p.ok = true; p.on = j.on !== false; p.readOnly = !!j.readOnly; p.banner = String(j.banner || '').slice(0, 240); p.imageMode = ['any', 'allowlist', 'nft', 'off'].includes(j.imageMode) ? j.imageMode : 'any';
  p.imageHosts = Array.isArray(j.imageHosts) ? j.imageHosts.map((x: any) => String(x).toLowerCase()) : []; p.blurMedia = j.blurMedia !== false; p.flags = { sexual: j.flags?.sexual !== false, violence: j.flags?.violence !== false, child: true };
  p.rules = { ...RULES0, ...(j.rules || {}), child: RULES0.child + '|' + (j.rules && j.rules.child ? j.rules.child : RULES0.child) }; p.words = Array.isArray(j.words) ? j.words.map(String) : []; p.patterns = Array.isArray(j.patterns) ? j.patterns.map(String) : [];
  p.hidden = new Set((j.hidden || []).map((x: string) => String(x).toUpperCase())); p.banned = new Set(j.banned || []); p.verified = new Set(j.verified || []); p.badProfiles = j.badProfiles || []; p.at = Date.now(); POL = p;
  RXC = []; const add = (k: string, src: string) => { try { RXC.push([k, new RegExp(src, 'i')]); } catch {} };
  add('child', p.rules.child); if (p.flags.sexual) add('sexual', p.rules.sexual); if (p.flags.violence) add('violence', p.rules.violence);
  for (const w of p.words) add('custom', '\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b'); for (const x of p.patterns) add('custom', x);
}
setPol({}); POL.at = 0; POL.ok = false;
const violates = (t: string): string => { t = String(t || ''); if (!t) return ''; for (const [k, r] of RXC) if (r.test(t)) return k; return ''; };
const hiddenPost = (p: Post) => POL.hidden.has(p.id) || POL.banned.has(p.a) || !!violates(p.x + ' ' + (p.p || []).join(' '));
const NFTHOSTS = ['ipfs.io', 'nftstorage.link', 'cloudflare-ipfs.com', 'arweave.net', 'w3s.link', 'dweb.link'];
const okImg = (u: string): boolean => { if (!u) return false; const m = POL.imageMode; if (m === 'any') return true; if (m === 'off') return false; let h = ''; try { h = new URL(u).hostname.toLowerCase(); } catch { return false; } const hs = (POL.imageHosts.length ? POL.imageHosts : NFTHOSTS).concat(nodeGws().map(g => { try { return new URL(g).hostname.toLowerCase(); } catch { return ''; } }).filter(Boolean)); return hs.some(x => h === x || h.endsWith('.' + x)); };
const WHY: Record<string, string> = { child: 'content that sexualises children', sexual: 'sexual or explicit content', violence: 'graphic violence or threats', custom: 'words this network does not allow' };
const roots = (): string[] => { const k = net(), port = k === 'test' ? 8091 : 8090; const c = (window as any).STARSKY_CONFIG || {}, pn = String((c[k] || c.main || {}).panel || '').replace(/\/+$/, ''); const r = [`${base()}/panel/${k}`]; if (pn) r.push(pn); r.push(`http://127.0.0.1:${port}`, `http://localhost:${port}`); return r; };
let RIGHT = 0;
async function pcall(p: string): Promise<any> {
  const rs = roots();
  for (let n = 0; n < rs.length; n++) { const i = (RIGHT + n) % rs.length; try { const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 5000); const r = await fetch(`${rs[i]}/api/public/social/${p}`, { cache: 'no-store', signal: ctl.signal }); clearTimeout(to); const j = await r.json().catch(() => null); if (j && typeof j === 'object' && j.ok) { RIGHT = i; return j; } } catch {} }
  return null;
}
let polBusy = false;
async function loadPolicy() { if (polBusy || Date.now() - POL.at < 45000) return; polBusy = true; try { const j = await pcall('policy'); if (j) { setPol(j); try { localStorage.setItem('sc.pol.' + net(), JSON.stringify(j)); } catch {} rebuild(); paint(); } } finally { polBusy = false; } }
function cachedPolicy() { try { const j = JSON.parse(localStorage.getItem('sc.pol.' + net()) || 'null'); if (j) { setPol(j); POL.at = 0; } } catch {} }
const blocked = (): string => (!POL.on ? 'LUMA Social is closed by the network operator for now.' : POL.readOnly ? 'LUMA Social is read only right now.' : me() && POL.banned.has(me()) ? 'This account is suspended from LUMA Social by the network operator.' : '');
// token prices and history for the price cards
interface Px { usd: number; chg: number; hist: number[] }
let PX: Record<string, Px> = {}, pxAt = 0;
async function loadPrices() { if (Date.now() - pxAt < 60000) return; pxAt = Date.now(); const j = await pcall('prices'); if (j && j.tokens) { PX = j.tokens; updCard(); paint(); } }
const pxFor = (sym: string): { sym: string; p: Px } | null => { const s = sym.replace(/^\$/, '').toUpperCase(); for (const c of [s, s + 'Z', s + 'X']) for (const k of Object.keys(PX)) if (k.toUpperCase() === c) return { sym: k, p: PX[k] }; return null; };
const usdFmt = (n: number) => '$' + (n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 0.01 ? n.toFixed(4) : n.toPrecision(3));
function spark(h: number[], up: boolean) {
  const a = h.length > 1 ? h : [h[0] || 0, h[0] || 0], mn = Math.min(...a), mx = Math.max(...a), W = 300, H = 56, dy = mx - mn || 1, col = up ? '#34d399' : '#f87171';
  const pts = a.map((v, i) => `${(i / (a.length - 1) * W).toFixed(1)},${(H - 4 - ((v - mn) / dy) * (H - 10)).toFixed(1)}`);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="${H}" aria-hidden="true"><defs><linearGradient id="spg${up ? 'u' : 'd'}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".35"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs><polygon points="0,${H} ${pts.join(' ')} ${W},${H}" fill="url(#spg${up ? 'u' : 'd'})"/><polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

// ---------- autocomplete while typing: $tokens (with price), @handles, #tags ----------
let SG: { items: { ins: string; html: string }[]; i: number; from: number; to: number } | null = null;
function sugClose() { SG = null; document.getElementById('sc-sug')?.remove(); }
function sugPaint() {
  const comp = document.getElementById('sc-comp'); if (!comp || !SG) { sugClose(); return; }
  let el = document.getElementById('sc-sug'); if (!el) { el = document.createElement('div'); el.id = 'sc-sug'; comp.style.position = 'relative'; comp.appendChild(el); }
  el.innerHTML = SG.items.map((x, n) => `<button type="button" class="sc-sgi ${n === SG!.i ? 'on' : ''}" data-n="${n}">${x.html}</button>`).join('');
  el.onmousedown = e => { const b = (e.target as HTMLElement).closest('.sc-sgi') as HTMLElement | null; if (b) { e.preventDefault(); sugPick(Number(b.dataset.n)); } };
}
function sugPick(n: number) {
  const ta = document.getElementById('sc-txt') as HTMLTextAreaElement | null; if (!ta || !SG || !SG.items[n]) return;
  const ins = SG.items[n].ins + ' '; ta.value = ta.value.slice(0, SG.from) + ins + ta.value.slice(SG.to); const c = SG.from + ins.length; ta.setSelectionRange(c, c); ta.focus(); sugClose();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
function sugUpdate(ta: HTMLTextAreaElement) {
  const pos = ta.selectionStart || 0, m = /([$@#])([A-Za-z0-9_]{0,15})$/.exec(ta.value.slice(0, pos));
  if (!m || (m.index > 0 && /[A-Za-z0-9_]/.test(ta.value[m.index - 1]))) { sugClose(); return; }
  const k = m[1], q = m[2].toLowerCase(), items: { ins: string; html: string }[] = [];
  if (k === '$') {
    void loadPrices();
    const seen = new Set<string>(), keys = Object.keys(PX); if (!keys.some(x => x.toUpperCase() === 'LUMA')) keys.unshift('LUMA');
    for (const sym of keys.sort((a, b) => (a.toUpperCase() === 'LUMA' ? -1 : b.toUpperCase() === 'LUMA' ? 1 : (PX[b]?.usd || 0) - (PX[a]?.usd || 0)))) {
      const u = sym.toUpperCase(); if (seen.has(u) || !u.toLowerCase().startsWith(q) || !/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(sym)) continue; seen.add(u); const px = PX[sym];
      items.push({ ins: '$' + u, html: `<b class="sc-cash">$${esc(u)}</b><span class="sc-m">${px ? usdFmt(px.usd) : 'LUMA network token'}</span>${px ? `<span style="margin-left:auto;color:${px.chg >= 0 ? '#34d399' : '#f87171'}">${px.chg >= 0 ? '+' : ''}${(px.chg || 0).toFixed(2)}%</span>` : ''}` });
      if (items.length >= 7) break;
    }
  } else if (k === '@') {
    for (const [h, a] of IX.owner) { if (!h.startsWith(q)) continue; items.push({ ins: '@' + h, html: `<b>@${esc(h)}</b><span class="sc-m">${esc(nameOf(a))}</span>` }); if (items.length >= 7) break; }
  } else {
    const cnt = new Map<string, number>(); for (const id of IX.order) { const p = IX.posts.get(id); if (p && !p.del) for (const t of tagsIn(p.x)) cnt.set(t, (cnt.get(t) || 0) + 1); }
    for (const [t, n] of Array.from(cnt).sort((a, b) => b[1] - a[1])) { if (!t.slice(1).startsWith(q)) continue; items.push({ ins: t, html: `<b class="sc-l">${esc(t)}</b><span class="sc-m">${n} post${n === 1 ? '' : 's'}</span>` }); if (items.length >= 7) break; }
  }
  if (!items.length) { sugClose(); return; }
  SG = { items, i: 0, from: m.index, to: pos }; sugPaint();
}
function bigChart(sym: string) {
  const f = pxFor(sym); if (!f) return; const up = f.p.chg >= 0, h = f.p.hist || [], hi = h.length ? Math.max(...h) : f.p.usd, lo = h.length ? Math.min(...h) : f.p.usd;
  ctx.modal(mcard(`<div class="sc-row" style="justify-content:space-between"><div class="sc-row" style="gap:10px"><span class="sc-pcl" style="background:linear-gradient(135deg,hsl(${hue(f.sym)} 70% 50%),hsl(${(hue(f.sym) + 60) % 360} 70% 38%))">${esc(f.sym[0])}</span><div><b style="font-size:1.2rem">$${esc(f.sym)}</b><div class="sc-m">LUMA network token</div></div></div><button class="sc-ib" onclick="sc.close()" title="Close">${ic('x', 18)}</button></div>
  <div style="margin:12px 0 2px;font-size:1.8rem;font-weight:800">${usdFmt(f.p.usd)} <span style="font-size:1rem;color:${up ? '#34d399' : '#f87171'}">${up ? '+' : ''}${f.p.chg.toFixed(2)}%</span></div>
  <div style="height:190px">${spark(h.length ? h : [f.p.usd, f.p.usd], up).replace('height="56"', 'height="190"')}</div>
  <div class="sc-row" style="justify-content:space-between;margin:6px 0 12px"><span class="sc-m">Low ${usdFmt(lo)}</span><span class="sc-m">High ${usdFmt(hi)}</span></div>
  <div class="sc-row" style="justify-content:center;margin-bottom:8px"><button class="sc-btn" style="width:100%;justify-content:center" onclick="sc.trade('${esc(f.sym)}')">${ic('chart', 16)}Trade $${esc(f.sym)} on the DEX</button></div>
  <div class="sc-row" style="justify-content:center"><button class="sc-btn ghost" onclick="sc.goTag('$${esc(f.sym.toLowerCase())}')">See posts about $${esc(f.sym)}</button><button class="sc-btn ghost" onclick="sc.close()">Close</button></div>`, 460));
}
function priceCard(tagTxt: string, opts: { close?: boolean; expand?: boolean } = {}): string {
  const f = pxFor(tagTxt); if (!f) return ''; const up = f.p.chg >= 0, nm = f.sym;
  return `<div class="sc-pc" data-act="tag" data-v="$${esc(nm.toLowerCase())}"><span class="sc-pcl" style="background:linear-gradient(135deg,hsl(${hue(nm)} 70% 50%),hsl(${(hue(nm) + 60) % 360} 70% 38%))">${esc(nm[0])}</span><div class="sc-pci"><b>${esc(nm)}</b><div><span class="sc-m">${esc(nm)}</span> <b>${usdFmt(f.p.usd)}</b> <span style="color:${up ? '#34d399' : '#f87171'};font-weight:600">${up ? '+' : ''}${f.p.chg.toFixed(2)}%</span></div></div><div class="sc-pcs">${spark(f.p.hist, up)}</div>${opts.expand && !opts.close ? `<span class="sc-pcb"><button class="sc-ib" data-act="pcbig" data-v="${esc(nm)}" title="Expand chart">${ic('expand', 16)}</button></span>` : ''}${opts.close ? `<span class="sc-pcb"><button class="sc-ib" data-act="pcbig" data-v="${esc(nm)}" title="Expand chart">${ic('expand', 16)}</button><button class="sc-ib" data-act="pcx" data-v="${esc(nm)}" title="Remove card">${ic('x', 16)}</button></span>` : ''}</div>`;
}
const cardSyms = (txt: string, comp = false, max = 3): string[] => { const out: string[] = [], seen = new Set<string>(); for (const t of txt.match(/\$[A-Za-z][A-Za-z0-9]{1,9}/g) || []) { const f = pxFor(t); if (f && !seen.has(f.sym) && !(comp && S.noCard.has(f.sym))) { seen.add(f.sym); out.push(t); } if (out.length >= max) break; } return out; };
const cardSym = (txt: string, comp = false): string => { const m = txt.match(/\$[A-Za-z][A-Za-z0-9]{1,9}/g) || []; for (let i = m.length - 1; i >= 0; i--) { const f = pxFor(m[i]); if (f && !(comp && S.noCard.has(f.sym))) return m[i]; } return ''; };
function updCard() { const el = document.getElementById('sc-card'); if (el) el.innerHTML = cardSyms(S.draft, true).map(t => priceCard(t, { close: true })).join(''); const y = document.getElementById('sc-yt'), id = ytId(S.draft); if (y && y.dataset.id !== id) { y.dataset.id = id; y.innerHTML = id ? ytCard(id) : ''; } }
const ytId = (t: string): string => { const m = String(t || '').match(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i); return m ? m[1] : ''; };
const ytCard = (id: string): string => `<div class="sc-yt" data-yt="${id}"><button class="sc-ytb" data-act="ytplay" data-v="${id}" aria-label="Play video"><img src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'"><span class="sc-ytp"><svg viewBox="0 0 24 24" width="30" height="30"><path d="M8 5v14l11-7z" fill="#fff"/></svg></span><span class="sc-ytl">YouTube</span></button></div>`;
const playing = (): boolean => !!document.querySelector('#sc .sc-yt iframe');
let PICKING = 0;
function paintSoft() { if (!playing() && S.view.k !== 'editprof' && !PP.isOpen() && !(PICKING && Date.now() - PICKING < 120000)) paint(); }

function rebuild() {
  const ix = blank(); EV.sort((x, y) => x.l - y.l || x.i - y.i);
  const seenTip = new Set<string>(), mk = mkBlank();
  for (const e of EV) {
    const d = e.d; ix.maxLedger = Math.max(ix.maxLedger, e.l);
    const ref = typeof d.ref === 'string' && isHash(d.ref) ? d.ref.toUpperCase() : '';
    switch (d.t) {
      case 'post': {
        const x = clip(d.x, MAXTXT), m = Array.isArray(d.m) ? d.m.map(safeUrl).filter(Boolean).slice(0, 4) : [], p = Array.isArray(d.p) ? d.p.map((o: any) => clip(o, 40)).filter(Boolean).slice(0, 4) : undefined;
        if (!x && !m.length && !d.q) break; if (ix.posts.has(e.h)) break;
        const po: Post = { id: e.h, a: e.a, t: e.t, x, m, q: isHash(d.q) ? d.q.toUpperCase() : undefined, n: isHash(d.n) ? d.n.toUpperCase() : undefined, r: isHash(d.r) ? d.r.toUpperCase() : undefined, p: p && p.length >= 2 ? p : undefined };
        ix.posts.set(e.h, po); ix.order.push(e.h); if (po.r) listOf(ix.replies, po.r).push(e.h); break;
      }
      case 'edit': { const p = ref ? ix.posts.get(ref) : undefined; if (p && p.a === e.a && !p.del) { const x = clip(d.x, MAXTXT); if (x) { p.x = x; p.ed = e.t; } } break; }
      case 'rt': if (ref && !setOf(ix.rts, ref).has(e.a)) { setOf(ix.rts, ref).add(e.a); ix.rtEv.push({ by: e.a, ref, t: e.t, h: e.h }); } break;
      case 'like': if (ref) setOf(ix.likes, ref).add(e.a); break;
      case 'unl': if (ref) setOf(ix.likes, ref).delete(e.a); break;
      case 'del': { const p = ref ? ix.posts.get(ref) : undefined; if (p && p.a === e.a) p.del = true; break; }
      case 'fol': if (isAddr(d.a) && d.a !== e.a) { setOf(ix.follows, e.a).add(d.a); setOf(ix.followers, d.a).add(e.a); if (isAddr(d.rf) && d.rf !== e.a && !ix.refBy.has(e.a)) ix.refBy.set(e.a, d.rf); } break;
      case 'chk': { let c = ix.chk.get(e.a); if (!c) ix.chk.set(e.a, (c = new Set())); c.add(Math.floor(e.t / 86400)); break; }
      case 'unf': if (isAddr(d.a)) { setOf(ix.follows, e.a).delete(d.a); setOf(ix.followers, d.a).delete(e.a); } break;
      case 'prof': ix.prof.set(e.a, { n: clip(d.n, 40), b: clip(d.b, 200), i: safeUrl(d.i), k: safeUrl(d.k), c: /^#[0-9a-fA-F]{6}$/.test(d.c || '') ? d.c : '', w: safeUrl(d.w), l: clip(d.l, 40), pr: clip(d.pr, 30), jb: clip(d.jb, 40), st: clip(d.st, 50), sh: d.sh === 's' ? 's' : 'c', ln: Array.isArray(d.ln) ? d.ln.slice(0, 2).map((x: any) => ({ t: clip(x && x.t, 20), u: safeUrl(x && x.u) })).filter((x: any) => x.u) : [] }); break;
      case 'hdl': { const h = typeof d.h === 'string' ? d.h.toLowerCase() : ''; if (/^[a-z0-9_]{3,15}$/.test(h)) { if (!ix.owner.has(h)) ix.owner.set(h, e.a); if (ix.owner.get(h) === e.a) ix.cur.set(e.a, h); } break; }
      case 'vote': if (ref && Number.isInteger(d.o)) { let m = ix.votes.get(ref); if (!m) ix.votes.set(ref, (m = new Map())); if (!m.has(e.a)) m.set(e.a, d.o); } break;
      case 'rx': if (ref) { let m = ix.rx.get(ref); if (!m) ix.rx.set(ref, (m = new Map())); if (d.e === '') m.delete(e.a); else if (EMOJI.includes(d.e)) m.set(e.a, d.e); } break;
      case 'boost': if (ref) listOf(ix.boosts, ref).push({ by: e.a, v: e.v, t: e.t }); break;
      case 'pin': if (d.ref === '') ix.pin.delete(e.a); else { const p = ref ? ix.posts.get(ref) : undefined; if (p && p.a === e.a && !p.del && !p.r) ix.pin.set(e.a, ref); } break;
      case 'tipn': if (isHash(d.th) && isAddr(d.to) && !seenTip.has(d.th.toUpperCase())) { seenTip.add(d.th.toUpperCase()); ix.tipClaims.push({ th: d.th.toUpperCase(), by: e.a, to: d.to, ref, t: e.t, m: clip(d.m, 60), k: d.k === 'buy' ? 'buy' : '', q: Math.max(1, Math.min(999, Math.floor(Number(d.q) || 1))) }); } break;
      case 'lst': case 'lup': case 'ofr': case 'ask': case 'ans': case 'rev': mkEvent(mk, e, d, ref); break;
    }
  }
  for (const c of ix.tipClaims) {                   // only tips that the chain itself confirmed are counted
    const r = TV[c.th]; if (!r || r.by !== c.by || r.to !== c.to) continue;
    if (c.k === 'buy') { const l = mk.l.get(c.ref), q = c.q || 1; listOf(mk.sales, c.ref).push({ th: c.th, by: c.by, to: c.to, ref: c.ref, n: r.v, q, t: c.t, ok: !!l && l.a === c.to && tokKey(r.c, r.i) === tokKey(l.c, l.i) && r.v + 1e-9 >= l.pr * q }); continue; }
    const tp: Tip = { th: c.th, by: c.by, to: c.to, ref: c.ref, c: r.c, i: r.i, v: r.v, t: c.t, m: c.m };
    ix.tipsAll.push(tp); listOf(ix.tipsTo, c.to).push(tp); listOf(ix.tipsBy, c.by).push(tp); if (c.ref) listOf(ix.tipsRef, c.ref).push(tp);
  }
  for (const p of ix.posts.values()) if (!p.del && hiddenPost(p)) { p.del = true; p.mod = true; }
  for (const a of POL.badProfiles) ix.prof.delete(a);
  IX = ix; MK = mk;
}

// ---------- reading the chain ----------
const KEY = () => 'sc.ev.' + net() + '.' + hub(), TKEY = () => 'sc.tipv.' + net();
function loadCache() { try { const j = JSON.parse(localStorage.getItem(KEY()) || '[]'); if (Array.isArray(j)) EV = j; } catch { EV = []; } try { TV = JSON.parse(localStorage.getItem(TKEY()) || '{}') || {}; } catch { TV = {}; } rebuild(); }
function saveCache() { try { let a = EV; if (a.length > 6000) a = a.slice(-6000); const s = JSON.stringify(a); if (s.length < 3.5e6) localStorage.setItem(KEY(), s); const k = Object.keys(TV); if (k.length > 4000) for (const x of k.slice(0, k.length - 4000)) delete TV[x]; localStorage.setItem(TKEY(), JSON.stringify(TV)); } catch {} }
function parseTx(x: any, dest: string = hub(), only = ''): Ev | null {
  const tx = x.tx || x.tx_json || {}, meta = x.meta || x.metaData || {};
  if (!(x.validated ?? true) || tx.TransactionType !== 'Payment' || tx.Destination !== dest || meta.TransactionResult !== 'tesSUCCESS') return null;
  const amt = meta.delivered_amount ?? tx.Amount ?? tx.DeliverMax; if (typeof amt !== 'string') return null;
  for (const m of tx.Memos || []) {
    const mm = m.Memo || {}; if (fromHex(mm.MemoType) !== MT) continue;
    let d: any; try { d = JSON.parse(fromHex(mm.MemoData)); } catch { continue; }
    if (!d || d.v !== 1 || typeof d.t !== 'string' || !(d.t in COST) || (only && d.t !== only)) continue;
    if (Number(amt) < COST[d.t] * 1e6 * 0.999) continue;      // underpaid actions do not count
    const h = String(x.hash || tx.hash || '').toUpperCase(); if (!isHash(h)) continue;
    const date = tx.date ?? x.date, t = date != null ? Number(date) + RIPPLE_EPOCH : x.close_time_iso ? Math.floor(Date.parse(x.close_time_iso) / 1000) : Math.floor(Date.now() / 1000);
    return { h, a: tx.Account, t, l: Number(tx.ledger_index ?? x.ledger_index ?? 0), i: Number(meta.TransactionIndex ?? 0), v: Number(amt) / 1e6, d };
  }
  return null;
}
let pulling = false;
export async function pull(full = false) {
  if (pulling) return; pulling = true;
  try {
    if (!ctx.online()) throw new Error('not connected to the network yet');
    const have = new Set(EV.map(e => e.h)), stop = full ? 0 : IX.maxLedger; let marker: any, added = 0;
    for (let page = 0; page < (stop ? 12 : 20); page++) {
      const r = await ctx.req('account_tx', { account: hub(), ledger_index_min: -1, ledger_index_max: -1, limit: 200, forward: false, ...(marker ? { marker } : {}) });
      let old = false;
      for (const x of r.transactions || []) { const e = parseTx(x); const l = Number((x.tx || x.tx_json || {}).ledger_index ?? x.ledger_index ?? 0); if (stop && l && l < stop - 1) old = true; if (e && !have.has(e.h)) { EV.push(e); have.add(e.h); added++; } }
      marker = r.marker; if (!marker || old) break;
    }
    const gn = genesis(); if (gn && gn !== hub()) { try { let mk: any; for (let pg = 0; pg < 3; pg++) { const r = await ctx.req('account_tx', { account: gn, ledger_index_min: -1, ledger_index_max: -1, limit: 200, forward: false, ...(mk ? { marker: mk } : {}) }); for (const x of r.transactions || []) { const e = parseTx(x, gn, 'boost'); if (e && !have.has(e.h)) { EV.push(e); have.add(e.h); added++; } } mk = r.marker; if (!mk) break; } } catch { /* genesis history unavailable: boosts just do not show yet */ } }
    S.hubErr = ''; if (added || full) { rebuild(); saveCache(); }
    S.loaded = true;
  } catch (e: any) { const m = String(e?.message || e); S.hubErr = /actNotFound|Account not found/i.test(m) ? 'The LUMA Social hub is not switched on yet on this network. The network operator turns it on from the control panel (Social tab).' : m; S.loaded = true; }
  pulling = false;
  void verifyTips(); void loadPolicy(); void loadPrices();
}
// a tip is a normal payment. The public log entry only points at it; we read the payment itself to learn who paid whom and how much.
const tipTries = new Map<string, number>(); let verifying = false;
async function verifyTips() {
  if (verifying || !ctx.online()) return; verifying = true;
  try {
    const todo = IX.tipClaims.filter(c => TV[c.th] === undefined && (tipTries.get(c.th) || 0) < 3).slice(-30); let n = 0;
    for (let k = 0; k < todo.length; k += 5) {
      await Promise.all(todo.slice(k, k + 5).map(async c => {
        tipTries.set(c.th, (tipTries.get(c.th) || 0) + 1);
        try {
          const r = await ctx.req('tx', { transaction: c.th }), tx = r.tx_json || r.tx || r, meta = r.meta || r.metaData || {};
          if (r.validated === false) return;
          const amt = meta.delivered_amount ?? tx.DeliverMax ?? tx.Amount;
          if (tx.TransactionType !== 'Payment' || meta.TransactionResult !== 'tesSUCCESS' || tx.Account !== c.by || tx.Destination !== c.to || amt == null) { TV[c.th] = 0; n++; return; }
          const v = typeof amt === 'string' ? { c: 'LUMA', i: '', v: Number(amt) / 1e6 } : { c: amt.currency, i: amt.issuer || '', v: Number(amt.value) };
          TV[c.th] = v.v > 0 ? { by: c.by, to: c.to, ...v } : 0; n++;
        } catch (e: any) { if (/txnNotFound/i.test(String(e?.message || e))) tipTries.set(c.th, 3); }
      }));
    }
    if (n) { rebuild(); saveCache(); paint(); }
  } finally { verifying = false; }
}

// ---------- state ----------
type View = { k: 'home' } | { k: 'explore' } | { k: 'notif' } | { k: 'bm' } | { k: 'dash' } | { k: 'profile'; a: string; tab?: string } | { k: 'thread'; id: string } | { k: 'tag'; tag: string } | { k: 'search'; q: string } | { k: 'market' } | { k: 'stats' } | { k: 'listing'; id: string } | { k: 'editprof' } | { k: 'top' } | { k: 'settings' } | { k: 'compare' };
const S: { view: View; tab: 'foryou' | 'following'; xtab: 'hot' | 'new' | 'tipped'; draft: string; media: string; poll: string[]; pollOn: boolean; quote: string; busy: boolean; step: string; loaded: boolean; hubErr: string; shown: number; q: string; err: string; lb: string; deep: boolean; pend: string; noCard: Set<string>; nft: { id: string; img: string; name: string } | null; rev: Set<string> } =
  { view: { k: 'home' }, tab: 'foryou', xtab: 'hot', draft: '', media: '', poll: ['', ''], pollOn: false, quote: '', busy: false, step: '', loaded: false, hubErr: '', shown: 25, q: '', err: '', lb: '', deep: false, pend: '', noCard: new Set(), nft: null, rev: new Set() };
const hist: View[] = [];
let timer: any = 0, bound: HTMLElement | null = null, kd: ((e: KeyboardEvent) => void) | null = null, KD: ((e: KeyboardEvent) => void) | null = null;
const LS = { get: (k: string, d: any) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set: (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const bmKey = () => 'sc.bm.' + net(), seenKey = () => 'sc.seen.' + net() + '.' + (ctx.account() || ''), muteKey = () => 'sc.mute.' + net(), draftKey = () => 'sc.draft.' + net();
const me = () => ctx.account() || '';
const bookmarks = (): string[] => LS.get(bmKey(), []);
const muted = (): string[] => LS.get(muteKey(), []);
// ---------- settings (kept in this browser, per account) ----------
const SETD = { views: true, compact: false, fs: 100, blurAll: false, words: '', hideTipc: false, confirm: false, cw: false, tipme: false, nLike: true, nFollow: true, nTip: true, nRep: true };
const setKey = () => 'sc.set.' + (me() || '-');
const SET = (): typeof SETD => ({ ...SETD, ...(LS.get(setKey(), {}) || {}) });
const setPut = (k: string, v: any) => { LS.set(setKey(), { ...SET(), [k]: v }); };
const wordMuted = (x: string): boolean => { const w = SET().words.split(/[,\n]/).map(s => s.trim().toLowerCase()).filter(Boolean); if (!w.length) return false; const l = String(x || '').toLowerCase(); return w.some(s => l.includes(s)); };
// ---------- views (counted per account by the network node) ----------
const VW: Record<string, number> = {}; let vwAt = 0; const vwSeen = new Set<string>(), vwQ = new Set<string>(); let vwTimer: any = 0, vwObs: IntersectionObserver | null = null;
async function pcallPost(p: string, body: any): Promise<any> { const rs = roots(); for (let n = 0; n < rs.length; n++) { const i = (RIGHT + n) % rs.length; try { const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 5000); const r = await fetch(`${rs[i]}/api/public/social/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal }); clearTimeout(to); const j = await r.json().catch(() => null); if (j && typeof j === 'object') { RIGHT = i; return j; } } catch {} } return null; }
function vwPaint() { document.querySelectorAll('[data-vw]').forEach(el => { const n = VW[(el as HTMLElement).dataset.vw!] || 0; const s = el.querySelector('.n'); if (s) s.textContent = k(n) || '0'; }); }
async function vwLoad(ids: string[]) { ids = ids.filter(Boolean).slice(0, 100); if (!ids.length || !SET().views) return; const j = await pcall('views?ids=' + ids.join(',')); if (j && j.views) { for (const id of Object.keys(j.views)) VW[id] = j.views[id]; vwPaint(); } }
function vwFlush() { vwTimer = 0; const a = me(); if (!a || !vwQ.size) return; const ids = Array.from(vwQ).slice(0, 25); ids.forEach(i => vwQ.delete(i)); void pcallPost('view', { a: ctx.toClassic ? ctx.toClassic(a) : a, ids }).then(() => { setTimeout(() => void vwLoad(ids), 600); }); if (vwQ.size) vwTimer = setTimeout(vwFlush, 2500); }
function vwObserve() {
  if (!SET().views) return; const root = document.getElementById('sc'); if (!root) return;
  const els = Array.from(root.querySelectorAll('article.sc-post[data-v]')) as HTMLElement[]; if (!els.length) return;
  const ids = Array.from(new Set(els.map(e => e.dataset.v!))); if (Date.now() - vwAt > 20000 || ids.some(i => VW[i] == null)) { vwAt = Date.now(); void vwLoad(ids); } else vwPaint();
  if (!me() || typeof IntersectionObserver === 'undefined') return; if (vwObs) vwObs.disconnect();
  const dwell = new Map<Element, any>();
  vwObs = new IntersectionObserver(es => { for (const en of es) { const el = en.target as HTMLElement, id = el.dataset.v!; if (en.isIntersecting && en.intersectionRatio >= 0.5) { if (!dwell.has(el) && !vwSeen.has(id)) dwell.set(el, setTimeout(() => { dwell.delete(el); const p = IX.posts.get(id); if (p && p.a !== me() && !vwSeen.has(id)) { vwSeen.add(id); vwQ.add(id); if (!vwTimer) vwTimer = setTimeout(vwFlush, 3000); } }, 1000)); } else if (dwell.has(el)) { clearTimeout(dwell.get(el)); dwell.delete(el); } } }, { threshold: [0.5] });
  els.forEach(e => vwObs!.observe(e));
}
let TOPD = 7; const TOPC: Record<number, { at: number; rows: Array<{ id: string; v: number }>; err: string } | undefined> = {};
async function topLoad(force = false) { const d = TOPD, c = TOPC[d]; if (c && !force && Date.now() - c.at < 30000) return; const j = await pcall('top?days=' + d + '&limit=60'); TOPC[d] = { at: Date.now(), rows: j && j.top ? j.top : [], err: j ? '' : 'The network node did not answer, so view counts are not available right now.' }; for (const r of TOPC[d]!.rows) VW[r.id] = r.v; paint(); }
const need0 = () => !!me();
function topView(): string {
  const c = TOPC[TOPD], rows = (c ? c.rows : []).filter(r => { const p = IX.posts.get(r.id); return p && !p.del && !isMuted(p.a) && !wordMuted(p.x); });
  const tab = (d: number, l: string) => `<button class="${TOPD === d ? 'on' : ''}" data-act="topd" data-v="${d}">${l}</button>`;
  return `<div class="sc-head">Top posts<span class="sc-sub">most viewed, by accounts</span></div><div class="sc-tabs">${tab(1, 'Today')}${tab(7, 'This week')}${tab(30, 'This month')}${tab(0, 'All time')}</div>${!c ? '<div class="sc-empty">Counting views…</div>' : c.err ? `<div class="sc-empty">${esc(c.err)}</div>` : rows.length ? rows.map((r, i) => `<div class="sc-m" style="padding:8px 14px 0;font-weight:800">#${i + 1} · ${r.v} ${r.v === 1 ? 'account viewed' : 'accounts viewed'} this</div>${postCard(IX.posts.get(r.id)!)}`).join('') : '<div class="sc-empty">No views counted for this period yet. A view counts when a signed-in account scrolls a post into view.</div>'}`;
}
function settingsView(): string {
  const s = SET(), a = me(), back = `<button class="sc-ib" data-act="back" title="Back">${ic('back')}</button>`;
  const row = (key: string, title: string, sub: string) => `<label class="sc-row" style="justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--sl);cursor:pointer"><span><b>${title}</b><span class="sc-m" style="display:block">${sub}</span></span><input type="checkbox" data-st="${key}" ${(s as any)[key] ? 'checked' : ''} style="width:20px;height:20px;flex:none"></label>`;
  const sec = (h: string, body: string) => `<div class="sc-box" style="margin:12px 10px"><h4 style="margin:0 0 4px">${h}</h4>${body}</div>`;
  const nm = (IX.prof.get(a) || {}).n || '', h = handleOf(a);
  return `<div class="sc-head">${back}Settings<span class="sc-sub">saved in this browser for this account</span></div>
  ${sec('Profile', `<div class="sc-m">${esc(nm || 'No name set')} ${h ? '· @' + esc(h) : '· no handle yet'}</div><div class="sc-row" style="gap:8px;margin-top:8px;flex-wrap:wrap"><button class="sc-btn sm" data-act="editprof">Edit profile</button><button class="sc-btn sm ghost" data-act="user" data-v="${a}">View my profile</button><button class="sc-btn sm ghost" data-act="dash">Creator dashboard</button></div><div class="sc-m" style="margin-top:8px">Name, bio, photos, cover, accent colour, links, location and your @handle are public and saved on the chain.</div>`)}
  ${sec('Feed and display', `${row('views', 'Show view counts', 'See how many accounts viewed each post. Your own views of other people\'s posts are counted.')}${row('compact', 'Compact posts', 'Tighter spacing so more fits on screen.')}<label class="sc-row" style="justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--sl)"><span><b>Text size</b></span><select class="sc-in" data-st="fs" style="width:auto;margin:0">${[90, 100, 110, 125].map(x => `<option value="${x}" ${s.fs === x ? 'selected' : ''}>${x}%</option>`).join('')}</select></label>`)}
  ${sec('Privacy and safety', `${row('blurAll', 'Always blur pictures', 'Every picture stays blurred until you tap it.')}${row('hideTipc', 'Hide tip comments', 'Do not show tips as comments under posts.')}<label class="sc-fl" style="margin-top:8px"><b>Muted words</b><span class="sc-m"> posts with these words are hidden from you (separate with commas)</span><textarea class="sc-in" data-st="words" rows="2" placeholder="word, another word">${esc(s.words)}</textarea></label><div class="sc-m" style="margin-top:6px">Muted accounts are managed in Creator, Muted accounts.</div>`)}
  ${sec('Notifications', `${row('nLike', 'Likes', 'Someone likes your post.')}${row('nRep', 'Replies, quotes and reposts', 'People who respond to or share your posts.')}${row('nFollow', 'New followers', 'Someone follows you.')}${row('nTip', 'Tips', 'Someone tips you or your posts.')}`)}
  ${sec('Posting defaults', `${row('confirm', 'Ask before posting', 'Show a confirmation before anything is sent to the chain.')}${row('cw', 'Start posts with a content warning', 'Adds [CW] to the start of each post.')}${row('tipme', 'Add a tip line to my posts', 'Adds your wallet address so people can tip you.')}`)}
  ${sec('Your data', `<div class="sc-row" style="gap:8px;flex-wrap:wrap"><button class="sc-btn sm ghost" data-act="exportmine">Download my data</button><button class="sc-btn sm ghost" data-act="clrcache">Clear cached posts</button><button class="sc-btn sm ghost" data-act="clrset">Reset these settings</button></div><div class="sc-m" style="margin-top:8px">Your wallet address: ${esc(ctx.showL(a))}<br>Everything you posted stays on the chain; clearing the cache only makes this browser read it again.</div>`)}`;
}
const isMuted = (a: string) => muted().includes(a);

// ---------- icons ----------
const P: Record<string, string> = {
  up: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/>', shop: '<path d="M3 9l1.5-5h15L21 9"/><path d="M3 9a3 3 0 006 0 3 3 0 006 0 3 3 0 006 0"/><path d="M5 12v8h14v-8"/>', home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>',
  bell: '<path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/>', bm: '<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>',
  user: '<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>', pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 00-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 000-7.8z"/>',
  repeat: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>',
  msg: '<path d="M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8z"/>',
  share: '<path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/>', trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>', coin: '<circle cx="12" cy="12" r="9"/><path d="M14.8 9a2.8 2.8 0 00-2.8-1.5c-1.6 0-2.8.9-2.8 2.2s1.2 1.9 2.8 2.3 2.8 1 2.8 2.3-1.2 2.2-2.8 2.2A2.8 2.8 0 019.2 15"/><path d="M12 6v1.5M12 16.5V18"/>',
  chart: '<path d="M18 20V10M12 20V4M6 20v-6"/>', pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 7 3 3v2H7v-2l3-3z"/>', image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>', smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>', back: '<path d="M19 12H5M12 19l-7-7 7-7"/>', link: '<path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7"/>',
  slash: '<circle cx="12" cy="12" r="10"/><path d="M4.9 4.9l14.2 14.2"/>', quote: '<path d="M3 21c3 0 7-1 7-8V5H4v6h4"/><path d="M14 21c3 0 7-1 7-8V5h-6v6h4"/>', trend: '<path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>', expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>', gem: '<path d="M6 3h12l4 6-10 13L2 9z"/><path d="M11 3L8 9l4 13 4-13-3-6M2 9h20"/>', flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>', eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>', check: '<path d="M20 6L9 17l-5-5"/>', at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-3.9 7.9"/>', pinoff: '<path d="M12 17v5"/><path d="M9 3h6l-1 7 3 3v2H7v-2l3-3z"/><path d="M3 3l18 18"/>',
};
const ic = (n: string, s = 18, cls = '') => `<svg class="sc-i ${cls}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ''}</svg>`;
const icFill = (n: string, s = 18) => `<svg class="sc-i" width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ''}</svg>`;
const LOGO = `<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="sc-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#sc-g)"/><path d="M10 8v13a3 3 0 003 3h9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="21.5" cy="11" r="2.2" fill="#fff"/></svg>`;

// ---------- helpers for display ----------
const hue = (a: string) => { let h = 0; for (let i = 0; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) >>> 0; return h % 360; };
const handleOf = (a: string) => IX.cur.get(a) || '';
const nameOf = (a: string) => { const p = IX.prof.get(a); return (p && p.n) || (handleOf(a) ? '@' + handleOf(a) : ctx.showL(a).slice(0, 8) + '…' + ctx.showL(a).slice(-4)); };
const tagOf = (a: string) => (handleOf(a) ? '@' + handleOf(a) : ctx.showL(a).slice(0, 6) + '…' + ctx.showL(a).slice(-4));
const avatar = (a: string, size = 44) => { const p = IX.prof.get(a), ini = (nameOf(a).replace(/^@/, '')[0] || '?').toUpperCase(); return `<span class="sc-av" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:linear-gradient(135deg,hsl(${hue(a)} 70% 48%),hsl(${(hue(a) + 50) % 360} 70% 36%))">${esc(ini)}${p && p.i && okImg(p.i) ? `<img src="${esc(p.i)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>`; };
const badge = (a: string) => (POL.verified.has(a) ? `<span class="sc-chk" title="Verified by the network operator"><svg width="15" height="15" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#f5b73b"/><path d="M7 12.5l3.3 3.2L17 9" fill="none" stroke="#1a1200" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` : handleOf(a) ? `<span class="sc-chk" title="Owns @${esc(handleOf(a))} on the chain"><svg width="15" height="15" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#6aa8ff"/><path d="M7 12.5l3.3 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` : '');
const ago = (t: number) => { const s = Math.max(1, Math.floor(Date.now() / 1000 - t)); if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; if (s < 86400 * 30) return Math.floor(s / 86400) + 'd'; return new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
const full = (t: number) => new Date(t * 1000).toLocaleString();
const TOK = /(https:\/\/[^\s<>"']+|#[\p{L}\p{N}_]{1,40}|@[A-Za-z0-9_]{3,15}|\$[A-Za-z][A-Za-z0-9]{1,9})/gu;
const rich = (txt: string) => txt.split(TOK).map((part, i) => {
  if (i % 2 === 0) return esc(part).replace(/\n/g, '<br>');
  if (part[0] === '#') return `<a class="sc-l" data-act="tag" data-v="${esc(part.slice(1).toLowerCase())}">${esc(part)}</a>`;
  if (part[0] === '$') return `<a class="sc-l sc-cash" data-act="tag" data-v="${esc(part.toLowerCase())}">${esc(part)}</a>`;
  if (part[0] === '@') return `<a class="sc-l" data-act="handle" data-v="${esc(part.slice(1).toLowerCase())}">${esc(part)}</a>`;
  const u = safeUrl(part.replace(/[.,;:!?)]+$/, '')); return u ? `<a class="sc-l" href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">${esc(part.length > 38 ? part.slice(0, 35) + '…' : part)}</a>` : esc(part);
}).join('');
const tagsIn = (txt: string) => Array.from(new Set((txt.match(/#[\p{L}\p{N}_]{1,40}/gu) || []).map(x => x.slice(1).toLowerCase())));
const cashIn = (txt: string) => Array.from(new Set((txt.match(/\$[A-Za-z][A-Za-z0-9]{1,9}/g) || []).map(x => x.toLowerCase())));
const likeN = (id: string) => (IX.likes.get(id) || new Set()).size, rtN = (id: string) => (IX.rts.get(id) || new Set()).size, repN = (id: string) => (IX.replies.get(id) || []).filter(x => !IX.posts.get(x)?.del && !isMuted(IX.posts.get(x)!.a)).length + (IX.tipsRef.get(id) || []).length;
const rxN = (id: string) => (IX.rx.get(id) || new Map()).size;
const iLike = (id: string) => !!me() && (IX.likes.get(id) || new Set()).has(me()), iRt = (id: string) => !!me() && (IX.rts.get(id) || new Set()).has(me());
const folN = (a: string) => (IX.followers.get(a) || new Set()).size, fwgN = (a: string) => (IX.follows.get(a) || new Set()).size;
const iFollow = (a: string) => !!me() && (IX.follows.get(me()) || new Set()).has(a);
const k = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : n ? String(n) : '');
const boostedNow = (id: string) => (IX.boosts.get(id) || []).some(b => Date.now() / 1000 - b.t < 86400);
function score(p: Post) {
  const now = Date.now() / 1000, hrs = (now - p.t) / 3600, tips = (IX.tipsRef.get(p.id) || []).length;
  let boost = 0; for (const b of IX.boosts.get(p.id) || []) boost += Math.min(b.v, 100) * 0.5 * Math.exp(-((now - b.t) / 3600) / 12);
  return (likeN(p.id) + 2 * rtN(p.id) + 1.5 * repN(p.id) + 0.5 * rxN(p.id) + 3 * tips + 1) / Math.pow(hrs + 2, 1.35) + boost / Math.pow(hrs + 2, 0.5);
}
function totals(list: Tip[]) { const m = new Map<string, { name: string; v: number }>(); for (const t of list) { const key = tokKey(t.c, t.i), o = m.get(key) || { name: tokName(t.c), v: 0 }; o.v += t.v; m.set(key, o); } return Array.from(m.values()).sort((a, b) => (a.name === 'LUMA' ? -1 : b.name === 'LUMA' ? 1 : b.v - a.v)); }
const totalStr = (list: Tip[], max = 3) => { const t = totals(list), s = t.slice(0, max).map(x => `${fmt(x.v, 4)} ${esc(x.name)}`).join(' · '); return s + (t.length > max ? ` · +${t.length - max} more` : ''); };

// ---------- sending ----------
function memoFor(d: any) { return [{ Memo: { MemoType: toHex(MT), MemoData: toHex(JSON.stringify({ v: 1, ...d })) } }]; }
const drops = (n: number) => String(Math.max(1, Math.round(n * 1e6)));
async function pay(dest: string, amount: any, d: any, label: string, extra: any = {}): Promise<{ ok: boolean; hash?: string; msg?: string }> {
  if (ctx.xrpl()) return { ok: false, msg: 'LUMA Social works with your LUMA wallet. Switch the wallet type to LUMA.' };
  if (!me()) return { ok: false, msg: 'Create or open a LUMA wallet first.' };
  if (!dest) return { ok: false, msg: 'The Social hub address is not set.' };
  const json = JSON.stringify({ v: 1, ...d }); if (enc.encode(json).length > MAXMEMO) return { ok: false, msg: 'That is too long to store in one transaction. Shorten the text or remove a link.' };
  S.busy = true; S.step = label; paint();
  try { return await ctx.submit({ TransactionType: 'Payment', Account: me(), Destination: dest, Amount: amount, ...extra, Memos: memoFor(d) }); }
  catch (e: any) { return { ok: false, msg: String(e?.message || e) }; }
  finally { S.busy = false; S.step = ''; }
}
function local(d: any, hash: string, v: number) { const e: Ev = { h: hash.toUpperCase(), a: me(), t: Math.floor(Date.now() / 1000), l: IX.maxLedger + 1, i: 9999, v, d }; if (!EV.some(x => x.h === e.h)) { EV.push(e); rebuild(); } }
// one network action: pay the hub, show it at once, confirm from the chain a few seconds later. Returns the transaction hash ('' when it failed).
async function act(d: any, label: string, ok?: string, amount?: number): Promise<string> {
  const v = amount ?? COST[d.t], r = await pay(d.t === 'boost' ? boostDest() : hub(), drops(v), d, label);
  if (!r.ok) { S.err = r.msg || 'The transaction was not accepted.'; ctx.toast(S.err, true); paint(); return ''; }
  S.err = ''; if (r.hash) local(d, r.hash, v); if (ok) ctx.toast(ok, false); paint(); setTimeout(() => { void pull().then(paintSoft); }, 5000); return r.hash || 'ok';
}

// ---------- rendering ----------
const CSS = `
.sc-mm{position:absolute;left:0;bottom:calc(100% + 6px);z-index:30;min-width:230px;background:#141824;border:1px solid var(--sl);border-radius:14px;padding:6px;box-shadow:0 14px 40px rgba(0,0,0,.55);display:flex;flex-direction:column}
.sc-mm button{all:unset;cursor:pointer;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;font-weight:600;font-size:.92rem;color:var(--tx)}.sc-mm button:hover,.sc-mm button:focus-visible{background:var(--sh)}
.sc{--sa:#8b5cf6;--sb:#22d3ee;--sg:linear-gradient(135deg,#8b5cf6,#6366f1 55%,#22d3ee);--sl:rgba(255,255,255,.08);--sh:rgba(139,92,246,.07);display:grid;grid-template-columns:248px minmax(0,620px) 330px;gap:28px;justify-content:center;align-items:start;max-width:1260px;margin:0 auto;font-feature-settings:"cv11","ss01"}
.sc *{box-sizing:border-box}.sc-i{flex:none;display:block}
.sc button{font-family:inherit}
.sc-nav{position:sticky;top:14px;display:flex;flex-direction:column;gap:2px}
.sc-brand{display:flex;align-items:center;gap:10px;padding:6px 14px 16px;font-weight:800;font-size:1.08rem;letter-spacing:-.01em}.sc-brand small{display:block;color:var(--mut);font-weight:500;font-size:.72rem;letter-spacing:0}
.sc-nav button{all:unset;cursor:pointer;display:flex;align-items:center;gap:14px;padding:11px 16px;border-radius:12px;font-size:1rem;font-weight:600;color:var(--tx);position:relative;transition:background .15s}
.sc-nav button:hover{background:var(--sh)}.sc-nav button:focus-visible{outline:2px solid var(--sa);outline-offset:1px}.sc-nav button.on{background:var(--sh);color:#fff}.sc-nav button.on:before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:3px;background:var(--sg)}
.sc-nav button.on .sc-i{color:var(--sb)}
.sc-nav .sc-big{background:var(--sg);color:#fff;justify-content:center;margin-top:14px;font-weight:700;box-shadow:0 6px 22px rgba(99,102,241,.35)}.sc-nav .sc-big:hover{filter:brightness(1.08);background:var(--sg)}
.sc-badge{background:#ef4444;color:#fff;border-radius:999px;padding:1px 7px;font-size:.7rem;font-weight:700;margin-left:auto}
.sc-col{min-width:0}.sc-side{position:sticky;top:14px;display:flex;flex-direction:column;gap:14px}
.sc-box{border:1px solid var(--sl);background:rgba(255,255,255,.025);border-radius:16px;padding:16px}.sc-box h4{margin:0 0 10px;font-size:.98rem;font-weight:700;display:flex;align-items:center;gap:8px}
.sc-head{display:flex;align-items:center;gap:12px;padding:14px 8px;font-size:1.12rem;font-weight:800;position:sticky;top:0;z-index:5;background:rgba(10,12,22,.72);backdrop-filter:blur(14px) saturate(1.3);border-bottom:1px solid var(--sl);letter-spacing:-.01em}
.sc-head .sc-sub{font-size:.8rem;color:var(--mut);font-weight:500;margin-left:2px}
.mk-ck{display:inline-flex;gap:6px;align-items:center;cursor:pointer;font-size:.82rem}.mk-tg{display:inline-flex;gap:4px;align-items:center;padding:3px 10px;border:1px solid var(--sl);border-radius:999px;font-size:.78rem}.mk-bd{position:absolute;top:8px;left:8px;background:#6366f1;color:#fff;font-size:.68rem;font-weight:800;padding:2px 8px;border-radius:999px}.mk-rv{display:flex;gap:10px;overflow-x:auto;padding:4px 12px 10px}.mk-g.mk-l{grid-template-columns:1fr}.mk-g.mk-l .mk-c{display:flex;gap:12px;align-items:center}.mk-g.mk-l .mk-i{width:110px;flex:none}.mk-emb{display:flex;gap:10px;margin:8px 0;border:1px solid var(--sl);border-radius:14px;overflow:hidden;cursor:pointer;background:rgba(255,255,255,.03)}.mk-emb img,.mk-ei{width:96px;height:96px;object-fit:cover;flex:none;display:flex;align-items:center;justify-content:center}.mk-eb{padding:8px 10px 8px 0;min-width:0}.sc-compact .sc-post{padding-top:7px!important;padding-bottom:7px!important}.sc-ib{all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;color:var(--tx)}.sc-ib:hover{background:var(--sh)}.sc-ib:focus-visible{outline:2px solid var(--sa)}
.sc-tabs{display:flex;border-bottom:1px solid var(--sl)}.sc-tabs button{all:unset;cursor:pointer;flex:1;text-align:center;padding:13px 6px;color:var(--mut);font-weight:600;font-size:.94rem;position:relative}.sc-tabs button:hover{background:var(--sh)}.sc-tabs button.on{color:var(--tx)}.sc-tabs button.on:after{content:"";position:absolute;left:30%;right:30%;bottom:0;height:3px;border-radius:3px;background:var(--sg)}.sc-tabs button:focus-visible{outline:2px solid var(--sa);outline-offset:-2px}
.sc-post{display:flex;gap:12px;padding:16px 10px;border-bottom:1px solid var(--sl);cursor:pointer;transition:background .15s}.sc-post:hover{background:rgba(255,255,255,.018)}
.sc-av{position:relative;flex:none;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:700;overflow:hidden}.sc-av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.sc-body{min-width:0;flex:1}.sc-ctx{display:flex;align-items:center;gap:6px;color:var(--mut);font-size:.82rem;font-weight:600;margin:-2px 0 4px}
.sc-who{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.sc-who b{cursor:pointer;font-weight:700}.sc-who b:hover{text-decoration:underline}.sc-m{color:var(--mut);font-size:.88rem}.sc-chk{display:inline-flex}
.sc-who .sc-more{margin-left:auto;width:30px;height:30px;color:var(--mut)}
.sc-txt{margin:3px 0 8px;line-height:1.5;overflow-wrap:anywhere;font-size:1rem}.sc-l{color:#8db4ff;cursor:pointer;text-decoration:none}.sc-l:hover{text-decoration:underline}.sc-cash{color:#7ee0a6;font-weight:600}
.sc-media{display:grid;gap:3px;border-radius:14px;overflow:hidden;margin:8px 0;border:1px solid var(--sl)}.sc-media.n2,.sc-media.n4{grid-template-columns:1fr 1fr}.sc-media img{width:100%;max-height:440px;min-height:120px;object-fit:cover;display:block;cursor:zoom-in;background:rgba(255,255,255,.04)}
.sc-acts{display:flex;justify-content:space-between;max-width:440px;margin:4px 0 0 -8px;color:var(--mut)}
.sc-acts button{all:unset;cursor:pointer;display:inline-flex;gap:6px;align-items:center;padding:6px 8px;border-radius:999px;font-size:.84rem;font-weight:600;transition:background .15s,color .15s}.sc-acts button:hover{background:var(--sh);color:var(--tx)}.sc-acts button:focus-visible{outline:2px solid var(--sa)}
.sc-acts .lk:hover,.sc-acts .lk.on{color:#fb5b8d}.sc-acts .lk.on svg{fill:#fb5b8d}.sc-acts .rt:hover,.sc-acts .rt.on{color:#34d399}.sc-acts .tp:hover{color:#fbbf24}.sc-acts .rc:hover{color:#8db4ff}
.sc-quote{border:1px solid var(--sl);border-radius:14px;padding:10px 12px;margin:8px 0}
.sc-chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 2px}
.sc-rxc{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;border:1px solid var(--sl);background:rgba(255,255,255,.03);font-size:.82rem;font-weight:600}.sc-rxc:hover{border-color:var(--sa)}.sc-rxc.on{border-color:var(--sa);background:rgba(139,92,246,.18)}
.sc-tipc{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:.8rem;font-weight:700;color:#fcd34d;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.28)}.sc-tipc:hover{background:rgba(251,191,36,.18)}
.sc-boost{display:inline-flex;align-items:center;gap:4px;color:#22d3ee;font-weight:700;font-size:.78rem}
.sc-poll{margin:8px 0;display:flex;flex-direction:column;gap:6px}.sc-opt{position:relative;border:1px solid var(--sl);border-radius:10px;padding:9px 12px;overflow:hidden;display:flex;justify-content:space-between;cursor:pointer}.sc-opt:hover{border-color:var(--sa)}.sc-opt i{position:absolute;left:0;top:0;bottom:0;background:rgba(139,92,246,.3);z-index:0}.sc-opt span{position:relative;z-index:1}
.sc-comp{display:flex;gap:12px;padding:16px 10px;border-bottom:1px solid var(--sl)}.sc-comp textarea{width:100%;min-height:64px;background:transparent;border:0;outline:0;color:var(--tx);font-size:1.12rem;resize:none;font-family:inherit;line-height:1.45;overflow:hidden}.sc-comp textarea::placeholder{color:var(--mut)}
.sc-in{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--sl);border-radius:10px;color:var(--tx);padding:9px 12px;margin:4px 0;font-family:inherit;font-size:.95rem}.sc-in:focus{outline:2px solid rgba(139,92,246,.55);border-color:transparent}
.sc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sc-editpg{padding:4px 2px 24px;max-width:680px}.sc-editpg{padding:4px 2px 24px;max-width:680px}.sc-btn{all:unset;cursor:pointer;background:var(--sg);color:#fff;font-weight:700;padding:9px 20px;border-radius:999px;font-size:.94rem;transition:filter .15s,transform .05s;display:inline-flex;align-items:center;gap:8px}.sc-btn:hover{filter:brightness(1.1)}.sc-btn:active{transform:scale(.98)}.sc-btn:focus-visible{outline:2px solid #fff;outline-offset:2px}.sc-btn[disabled]{opacity:.45;cursor:default}
.sc-btn.sm{padding:6px 14px;font-size:.84rem}.sc-btn.ghost{background:transparent;border:1px solid var(--sl);color:var(--tx)}.sc-btn.ghost:hover{background:var(--sh)}.sc-btn.on{background:transparent;border:1px solid var(--sl);color:var(--tx)}.sc-btn.gold{background:linear-gradient(135deg,#f59e0b,#fbbf24);color:#1a1200}
.sc-tool{display:flex;gap:2px;color:var(--sb)}.sc-tool .sc-ib{color:#7dd3fc;width:34px;height:34px}.sc-tool .sc-ib.on{background:var(--sh)}
.sc-ring{display:inline-flex;align-items:center;gap:6px;color:var(--mut);font-size:.8rem}
.sc-prof{border:1px solid var(--sl);border-radius:18px;margin:10px 0;overflow:hidden}.sc-ban{height:140px;background:linear-gradient(135deg,#312e81,#0e7490)}.sc-pinfo{padding:0 18px 16px}
.sc-pav{margin-top:-44px;border:4px solid #0b0d18;border-radius:50%;display:inline-block}.sc-stats{display:flex;gap:18px;color:var(--mut);flex-wrap:wrap}.sc-stats b{color:var(--tx)}
.sc-jar{margin-top:12px;border:1px solid rgba(251,191,36,.28);background:rgba(251,191,36,.07);border-radius:12px;padding:10px 12px;display:flex;align-items:center;gap:10px;cursor:pointer}
.sc-user{display:flex;gap:10px;align-items:center;padding:8px 0}.sc-user .sc-who{flex:1;min-width:0;flex-direction:column;align-items:flex-start;gap:0}
.sc-tag{display:block;padding:8px 0;cursor:pointer}.sc-tag:hover b{text-decoration:underline}.sc-tag b{font-weight:700}
.sc-warn{border:1px solid var(--warn);background:var(--warn-t);border-radius:12px;padding:12px 14px;margin:10px 0}.sc-empty{color:var(--mut);padding:44px 18px;text-align:center;line-height:1.5}
.sc-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}.sc-kpi{border:1px solid var(--sl);background:rgba(255,255,255,.025);border-radius:14px;padding:14px}.sc-kpi b{display:block;font-size:1.5rem;font-weight:800;letter-spacing:-.02em}.sc-kpi span{color:var(--mut);font-size:.82rem}
.sc-nrow{display:flex;gap:12px;padding:14px 10px;border-bottom:1px solid var(--sl)}.sc-nic{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;background:var(--sh)}
.sc-chipt{all:unset;cursor:pointer;display:inline-flex;flex-direction:column;gap:1px;padding:8px 12px;border-radius:12px;border:1px solid var(--sl);font-weight:700;font-size:.9rem;min-width:84px}.sc-chipt small{color:var(--mut);font-weight:500;font-size:.74rem}.sc-chipt:hover{border-color:var(--sa)}.sc-chipt.on{border-color:var(--sa);background:rgba(139,92,246,.2)}.sc-chipt.off{opacity:.45;cursor:not-allowed}
.sc-mi{all:unset;cursor:pointer;display:flex;align-items:center;gap:12px;padding:11px 8px;border-radius:10px;width:100%;box-sizing:border-box}.sc-mi:hover{background:var(--sh)}.sc-mi.bad{color:#f87171}
.sc-skel{display:flex;gap:12px;padding:16px 10px;border-bottom:1px solid var(--sl)}.sc-skel i{display:block;border-radius:8px;background:linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.1),rgba(255,255,255,.05));background-size:200% 100%;animation:scsh 1.4s infinite}
@keyframes scsh{to{background-position:-200% 0}}
@media(prefers-reduced-motion:reduce){.sc-skel i{animation:none}.sc *{transition:none!important}}
.sc-pc{display:flex;align-items:center;gap:12px;border:1px solid var(--sl);border-radius:16px;padding:12px 14px;margin:8px 0;background:rgba(255,255,255,.025);cursor:pointer;position:relative;overflow:hidden}.sc-pc:hover{border-color:rgba(139,92,246,.5)}
.sc-pcl{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;flex:none}.sc-pci{min-width:0}.sc-pci b{font-weight:700}.sc-pcs{flex:1;min-width:90px;max-width:260px;margin-left:auto}
.sc-pcb{position:absolute;top:6px;right:6px;display:flex;gap:4px}.sc-pcb .sc-ib{background:rgba(0,0,0,.55);width:30px;height:30px}
.sc-media{position:relative}.sc-media.blurred img{filter:blur(34px) saturate(.8);transform:scale(1.1);pointer-events:none}.sc-reveal{all:unset;cursor:pointer;position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;gap:8px;font-weight:700;background:rgba(8,8,16,.45);color:#fff}.sc-reveal:hover{background:rgba(8,8,16,.3)}
.sc-nftb{display:inline-flex;align-items:center;gap:6px;font-size:.78rem;color:#c4b5fd;background:rgba(139,92,246,.14);border:1px solid rgba(139,92,246,.35);border-radius:999px;padding:3px 10px;margin-top:6px}.sc-nftb .ok{color:#34d399}.sc-nftb span{color:var(--mut)}.sc-nftb span.ok{color:#34d399}
.sc-nftat{display:flex;gap:12px;align-items:center;border:1px solid rgba(139,92,246,.4);border-radius:14px;padding:8px;margin:8px 0;background:rgba(139,92,246,.08)}.sc-nftat img{width:56px;height:56px;border-radius:10px;object-fit:cover}.sc-nftat>div{flex:1;min-width:0}
.sc-nftg{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}.sc-nftc{border:1px solid var(--sl);border-radius:14px;padding:8px;display:flex;flex-direction:column;gap:6px;background:rgba(255,255,255,.025)}.sc-nftc img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;background:rgba(255,255,255,.05)}.sc-nftc .nm{font-size:.82rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-note{background:linear-gradient(135deg,rgba(245,183,59,.14),rgba(245,183,59,.06));border:1px solid rgba(245,183,59,.4);border-radius:12px;padding:10px 14px;margin:10px 0;font-size:.92rem}
.sc-seg{display:inline-flex;border:1px solid var(--sl);border-radius:12px;padding:3px;margin:10px 0 4px;background:rgba(255,255,255,.03)}.sc-seg button{all:unset;cursor:pointer;padding:7px 16px;border-radius:9px;font-weight:600;font-size:.86rem;color:var(--mut)}.sc-seg button.on{background:#4f46e5;color:#fff}.sc-lg{display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:.8rem;color:var(--mut)}.sc-lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px}.sc-dl{display:block;margin-top:4px;font-size:.74rem;color:var(--mut)}.sc-dl.up{color:#34d399}.sc-dl.dn{color:#f87171}.sc-hb{display:flex;align-items:center;gap:10px;margin:7px 0;font-size:.88rem}.sc-hbl{width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sc-hbt{flex:1;height:9px;border-radius:6px;background:rgba(255,255,255,.07);overflow:hidden}.sc-hbt div{height:100%;border-radius:6px}.sc-hb b{min-width:64px;text-align:right;font-weight:700}.sc-two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.sc-two .sc-box{margin-bottom:0!important}@media(max-width:760px){.sc-two{grid-template-columns:1fr}}
.sc-sgi{all:unset;box-sizing:border-box;display:flex;gap:10px;align-items:center;width:100%;padding:9px 12px;cursor:pointer;font-size:.92rem}.sc-sgi:hover,.sc-sgi.on{background:rgba(99,102,241,.22)}#sc-sug{position:absolute;left:0;right:0;top:100%;margin-top:-6px;z-index:60;background:#12162b;border:1px solid var(--sl);border-radius:14px;box-shadow:0 14px 36px rgba(0,0,0,.55);overflow:hidden;max-width:420px}
.sc-lbx-x{all:unset;position:absolute;top:14px;right:14px;width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.16);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer}.sc-lbx-x:hover{background:rgba(255,255,255,.3)}
.sc-lb{max-width:94vw;max-height:88vh;border-radius:12px;display:block}
@media(max-width:1120px){.sc{grid-template-columns:72px minmax(0,640px);gap:18px}.sc-side{display:none}.sc-nav button span.t,.sc-brand span{display:none}.sc-brand{padding:6px 12px 12px}.sc-nav button{justify-content:center;padding:12px}.sc-badge{position:absolute;top:2px;right:2px;margin:0}.sc-kpis{grid-template-columns:repeat(2,1fr)}}
@media(max-width:720px){.sc{grid-template-columns:minmax(0,1fr)}.sc-brand{display:none}.sc-nav{position:fixed;left:0;right:0;bottom:0;top:auto;flex-direction:row;justify-content:space-around;background:rgba(10,12,22,.92);backdrop-filter:blur(14px);border-top:1px solid var(--sl);z-index:30;padding:4px 2px;gap:0}.sc-nav .sc-big{margin:0;padding:10px 14px}.sc-nav button{padding:10px 8px}.sc-col{padding-bottom:76px}.sc-acts{max-width:none}.sc-nav button.on:before{display:none}}
`;

const CSS3 = `
.sc-yt{position:relative;aspect-ratio:16/9;border-radius:14px;overflow:hidden;margin:8px 0;border:1px solid var(--sl);background:#000}.sc-ytb{all:unset;cursor:pointer;display:block;width:100%;height:100%;position:relative}.sc-ytb img{width:100%;height:100%;object-fit:cover;display:block}.sc-yt iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.sc-ytp{position:absolute;inset:0;margin:auto;width:66px;height:66px;border-radius:50%;background:rgba(255,0,0,.92);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 26px rgba(0,0,0,.5);transition:transform .15s}.sc-ytb:hover .sc-ytp{transform:scale(1.08)}.sc-ytl{position:absolute;left:10px;bottom:10px;background:rgba(0,0,0,.65);color:#fff;font-weight:800;font-size:.72rem;padding:3px 9px;border-radius:999px}
.card .sc-in,.card select.sc-in,.card textarea.sc-in{box-sizing:border-box;max-width:100%;min-width:0}.card .sc-fl{min-width:0;box-sizing:border-box}.card .sc-row>*{min-width:0}
main:has(#sc-root){max-width:none!important;width:100%}main:has(#sc-root) #netstrip,main:has(#sc-root) .top h1{display:none!important}
#sc.sc{grid-template-columns:260px minmax(0,1fr) 340px;gap:26px;max-width:1600px;width:100%;margin:0 auto}
.sc-rail{position:sticky;top:14px;display:flex;flex-direction:column;gap:12px;max-height:calc(100vh - 28px);overflow-y:auto;scrollbar-width:none;padding-bottom:6px}.sc-rail::-webkit-scrollbar{display:none}
.sc-rail .sc-brand{padding:2px 8px}.sc-rail .sc-nav{position:static}
#sc .sc-side{position:sticky;top:14px;max-height:calc(100vh - 28px);overflow-y:auto;scrollbar-width:none}#sc .sc-side::-webkit-scrollbar{display:none}
.mk-mi{position:relative;width:38px;height:38px;border-radius:10px;overflow:hidden;background:linear-gradient(135deg,#1b1f3a,#0e7490);display:flex;align-items:center;justify-content:center;flex:none;color:rgba(255,255,255,.6)}.mk-mi img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.sc-mst{display:flex;justify-content:space-between;margin-top:12px}.sc-mst button{all:unset;cursor:pointer;display:flex;flex-direction:column;align-items:center;flex:1;font-size:.76rem;color:var(--mut);padding:4px 0;border-radius:8px}.sc-mst button:hover{background:var(--sh)}.sc-mst b{font-size:1.05rem;color:var(--tx)}
.sc-rail .sc-nav button{padding:9px 14px}.mk-mi{position:relative;width:38px;height:38px;border-radius:10px;overflow:hidden;background:linear-gradient(135deg,#1b1f3a,#0e7490);display:flex;align-items:center;justify-content:center;flex:none;color:rgba(255,255,255,.6)}.mk-mi img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.sc-dsh{margin:12px 10px;padding:16px;border-radius:20px;border:1px solid var(--sl);background:linear-gradient(135deg,rgba(139,92,246,.16),rgba(34,211,238,.07) 70%),rgba(255,255,255,.02)}.sc-dhi{font-size:1.35rem;font-weight:900;letter-spacing:-.03em}
.sc-dg{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}.sc-dt{all:unset;cursor:pointer;display:flex;flex-direction:column;padding:10px 12px;border-radius:14px;background:rgba(255,255,255,.045);border:1px solid var(--sl)}.sc-dt:hover{border-color:var(--sa)}.sc-dt b{font-size:1.3rem;font-weight:900}.sc-dt span{font-size:.78rem;color:var(--mut)}
@media(min-width:721px) and (max-width:1280px){#sc.sc{grid-template-columns:260px minmax(0,1fr)}#sc .sc-side{display:none}}
@media(min-width:721px) and (max-width:1120px){#sc.sc{grid-template-columns:72px minmax(0,1fr);gap:16px}.sc-rail .sc-mini,.sc-rail .sc-brand span{display:none}.sc-rail .sc-nav button span.t{display:none}.sc-rail .sc-nav button{justify-content:center;padding:12px}.sc-rail .sc-nav .sc-badge{position:absolute;top:2px;right:2px;margin:0}}
@media(max-width:720px){#sc.sc{grid-template-columns:minmax(0,1fr)}.sc-rail{position:static;max-height:none;overflow:visible;display:block}.sc-rail .sc-brand,.sc-rail .sc-mini{display:none}#sc .sc-side{display:none}.sc-dg{grid-template-columns:repeat(2,1fr)}.sc-dsh{margin:8px 0}}
`;
const CSS2 = `
.mk-top{padding:12px 10px;display:flex;flex-direction:column;gap:10px}.mk-cats{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px}.mk-cats button{all:unset;cursor:pointer;white-space:nowrap;padding:6px 14px;border-radius:999px;border:1px solid var(--sl);font-weight:700;font-size:.86rem;color:var(--mut)}.mk-cats button.on{background:var(--sg);color:#fff;border-color:transparent}
.mk-g{display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:14px;padding:6px 10px 14px}.mk-c{cursor:pointer;border-radius:14px;transition:transform .15s}.mk-c:hover{transform:translateY(-2px)}.mk-i{position:relative;aspect-ratio:1;border-radius:14px;overflow:hidden;background:linear-gradient(135deg,#1b1f3a,#0e7490 140%);display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.5);border:1px solid var(--sl)}.mk-i img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.mk-p{font-weight:900;font-size:1.08rem;margin-top:8px}.mk-t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mk-s{position:absolute;left:8px;top:8px;background:#ef4444;color:#fff;font-weight:800;font-size:.74rem;padding:3px 10px;border-radius:999px;z-index:2}
.mk-sv{all:unset;cursor:pointer;position:absolute;right:8px;top:8px;width:30px;height:30px;border-radius:50%;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;color:#fff;z-index:2}.mk-sv.on{color:#fbbf24}.mk-sv.on svg{fill:#fbbf24}
.mk-gal{position:relative;aspect-ratio:4/3;max-height:480px;width:100%;background:linear-gradient(135deg,#1b1f3a,#0e7490 140%);display:flex;align-items:center;justify-content:center;overflow:hidden;color:rgba(255,255,255,.5)}.mk-gal img{width:100%;height:100%;object-fit:contain;background:#05060d}
.mk-th{all:unset;cursor:pointer;width:62px;height:62px;border-radius:10px;overflow:hidden;border:2px solid transparent}.mk-th.on{border-color:var(--sa)}.mk-th img{width:100%;height:100%;object-fit:cover}
.mk-pp{font-size:1.7rem;font-weight:900;letter-spacing:-.03em;background:var(--sg);-webkit-background-clip:text;background-clip:text;color:transparent;width:fit-content}.mk-h{margin:2px 0 6px;font-size:1.35rem;letter-spacing:-.02em}
.mk-d{display:grid;grid-template-columns:110px 1fr;gap:6px 10px;color:var(--mut)}.mk-d b{color:var(--tx)}.mk-q{padding:10px 0;border-bottom:1px solid var(--sl)}.mk-a{margin:6px 0 0 14px;padding-left:10px;border-left:2px solid var(--sa)}
.sc-pname{font-size:1.6em;font-weight:900;letter-spacing:-.03em;margin-top:12px;display:flex;align-items:center;gap:7px}.sc-stt{display:inline-block;margin-top:8px;padding:4px 12px;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid var(--sl);font-size:.9em;font-weight:600}
.sc-mts{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:8px;color:var(--mut);font-size:.92em}.sc-mt{display:inline-flex;align-items:center;gap:6px}.sc-lks{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.sc-lk{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;border:1px solid var(--sl);background:rgba(255,255,255,.05);color:#a5c4ff;text-decoration:none;font-weight:700;font-size:.88em}.sc-lk:hover{border-color:var(--pa,#8b5cf6)}
.sc-stat{all:unset;cursor:pointer;color:var(--mut)}.sc-stat:hover{text-decoration:underline}.sc-stat b{color:var(--tx)}.sc-fy{background:rgba(255,255,255,.08);border-radius:6px;padding:1px 7px;font-size:.78em;font-weight:700}
.sc-bar{height:8px;border-radius:8px;background:rgba(255,255,255,.08);margin-top:10px;overflow:hidden}.sc-bar i{display:block;height:100%;background:var(--sg);border-radius:8px}
.sc-pav.sq .sc-av{border-radius:24%!important}.sc-pav{box-shadow:0 0 0 3px var(--pa,#8b5cf6),0 10px 30px rgba(0,0,0,.5)!important}
.sc-sec{font-weight:800;margin:16px 0 4px;padding-top:12px;border-top:1px solid var(--sl);letter-spacing:-.01em}.sc-fl{display:block;color:var(--mut);font-size:.86em;font-weight:600;margin:6px 0}.sc-sw{all:unset;cursor:pointer;width:26px;height:26px;border-radius:50%;box-shadow:0 0 0 2px rgba(255,255,255,.15)}.sc-sw:hover{box-shadow:0 0 0 2px #fff}

.sc{--sa:#8b5cf6;--sb:#22d3ee;--sc2:#38bdf8;--sg:linear-gradient(135deg,#8b5cf6 0%,#6366f1 45%,#22d3ee 100%);--sg2:linear-gradient(135deg,#38bdf8,#6366f1 55%,#22d3ee);--card2:linear-gradient(180deg,rgba(255,255,255,.065),rgba(255,255,255,.022));--sl:rgba(255,255,255,.09);
 grid-template-columns:minmax(216px,264px) minmax(0,740px) minmax(270px,350px);gap:clamp(16px,2.2vw,34px);max-width:1440px;width:100%;position:relative;font-size:clamp(15px,.95vw + 9px,17px);line-height:1.5;letter-spacing:-.005em}
.sc:before{content:"";position:fixed;inset:-10% -10% auto -10%;height:70vh;pointer-events:none;z-index:-1;background:radial-gradient(40% 50% at 18% 20%,rgba(139,92,246,.22),transparent 70%),radial-gradient(35% 45% at 85% 10%,rgba(34,211,238,.16),transparent 70%),radial-gradient(30% 40% at 60% 60%,rgba(56,189,248,.08),transparent 70%)}
.sc-col{min-width:0}
.sc-brand{font-size:1.3em;font-weight:900;letter-spacing:-.03em;padding:4px 14px 22px}.sc-brand span{background:var(--sg2);-webkit-background-clip:text;background-clip:text;color:transparent}.sc-brand small{-webkit-text-fill-color:var(--mut);font-weight:600;font-size:.56em;letter-spacing:.01em;margin-top:2px}
.sc-nav button{font-weight:700;font-size:1.04em;padding:12px 16px;border-radius:14px;gap:15px}.sc-nav button .sc-i{width:23px;height:23px}
.sc-nav button.on{background:linear-gradient(135deg,rgba(139,92,246,.26),rgba(34,211,238,.12));box-shadow:inset 0 0 0 1px rgba(139,92,246,.45)}.sc-nav button.on:before{display:none}
.sc-nav .sc-big{padding:15px 18px;font-weight:800;font-size:1.06em;border-radius:16px;box-shadow:0 10px 30px rgba(99,102,241,.45),inset 0 1px 0 rgba(255,255,255,.3)}
.sc-head{font-size:1.3em;font-weight:900;letter-spacing:-.03em;padding:16px 10px;background:linear-gradient(180deg,rgba(10,12,24,.86),rgba(10,12,24,.66));border-bottom:1px solid var(--sl)}
.sc-tabs{margin:12px 0 4px;padding:4px;border:1px solid var(--sl);border-radius:16px;background:rgba(255,255,255,.03);gap:4px;border-bottom:1px solid var(--sl)}
.sc-tabs button{padding:11px 8px;border-radius:12px;font-weight:700;font-size:.97em}.sc-tabs button.on{background:var(--sg);color:#fff;box-shadow:0 6px 18px rgba(99,102,241,.35)}.sc-tabs button.on:after{display:none}.sc-tabs button:hover:not(.on){background:rgba(255,255,255,.06)}
.sc-comp{margin:14px 0;padding:clamp(14px,1.6vw,22px);border:1px solid transparent;border-radius:22px;background:linear-gradient(#0d1020,#0d1020) padding-box,linear-gradient(135deg,rgba(139,92,246,.7),rgba(34,211,238,.45),rgba(56,189,248,.4)) border-box;box-shadow:0 14px 44px rgba(79,70,229,.18)}
.sc-comp textarea{font-size:1.2em;font-weight:500;min-height:72px}
.sc-post{margin:10px 0;padding:clamp(14px,1.5vw,20px);border:1px solid var(--sl);border-radius:20px;background:var(--card2);box-shadow:0 8px 28px rgba(0,0,0,.28);transition:transform .15s,border-color .15s,box-shadow .15s}
.sc-post:hover{background:var(--card2);border-color:rgba(139,92,246,.5);box-shadow:0 12px 36px rgba(79,70,229,.2);transform:translateY(-1px)}
.sc-who b{font-weight:800;font-size:1.06em;letter-spacing:-.015em}.sc-txt{font-size:1.07em;line-height:1.58;font-weight:450}
.sc-av{box-shadow:0 0 0 2px rgba(255,255,255,.12),0 6px 16px rgba(0,0,0,.35)}
.sc-acts button{padding:7px 11px;font-weight:700;border-radius:12px}.sc-acts button:hover{background:rgba(255,255,255,.08)}
.sc-box{border-radius:20px;background:var(--card2);border:1px solid var(--sl);box-shadow:0 8px 28px rgba(0,0,0,.25);padding:18px}.sc-box h4{font-size:1.04em;font-weight:800;letter-spacing:-.02em}
.sc-btn{font-weight:800;border-radius:14px;padding:11px 24px;box-shadow:0 8px 22px rgba(99,102,241,.4),inset 0 1px 0 rgba(255,255,255,.28)}.sc-btn.sm{padding:7px 16px;border-radius:12px}.sc-btn.ghost,.sc-btn.on{box-shadow:none;background:rgba(255,255,255,.04)}
.sc-btn.gold{box-shadow:0 8px 22px rgba(245,158,11,.4),inset 0 1px 0 rgba(255,255,255,.4)}
.sc-in{border-radius:14px;padding:12px 14px;background:rgba(255,255,255,.05);border:1px solid var(--sl)}
.sc-prof{border-radius:26px;box-shadow:0 18px 50px rgba(0,0,0,.4);background:var(--card2)}.sc-ban{height:clamp(120px,16vw,190px);background:var(--sg);position:relative}.sc-ban:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 40%,rgba(10,12,24,.55))}
.sc-pav{border:4px solid #0b0d18;box-shadow:0 0 0 3px rgba(139,92,246,.7),0 10px 30px rgba(0,0,0,.5);margin-top:-52px}
.sc-pinfo>div:nth-of-type(2){font-size:1.55em!important;font-weight:900!important;letter-spacing:-.03em}
.sc-stats b{font-weight:900;font-size:1.08em}
.sc-kpis{gap:14px}.sc-kpi{border-radius:20px;padding:18px;background:var(--card2);box-shadow:0 8px 24px rgba(0,0,0,.25)}.sc-kpi b{font-size:2em;font-weight:900;letter-spacing:-.04em;background:var(--sg2);-webkit-background-clip:text;background-clip:text;color:transparent}
.sc-tipc{padding:5px 12px;font-weight:800}.sc-rxc{padding:5px 11px}.sc-jar{border-radius:16px;background:linear-gradient(135deg,rgba(251,191,36,.14),rgba(245,158,11,.05))}
.sc-pc{border-radius:20px;padding:14px 16px;background:var(--card2)}.sc-pci b{font-weight:800}
.sc-media{border-radius:18px;box-shadow:0 8px 26px rgba(0,0,0,.35)}
.sc-nrow{border-radius:18px;margin:8px 0;border:1px solid var(--sl);background:var(--card2)}.sc-nic{width:40px;height:40px;background:rgba(255,255,255,.07)}
.sc-nftc,.sc-quote,.sc-opt,.sc-skel{border-radius:16px}.sc-nftb{font-weight:700}
.sc-empty{font-weight:600;font-size:1.02em;padding:56px 20px}
.sc-user{padding:10px 0}.sc-tag b{font-weight:800}
.sc *::-webkit-scrollbar{width:10px;height:10px}.sc *::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:10px}
@media(max-width:1200px){.sc{grid-template-columns:76px minmax(0,1fr);gap:18px}.sc-nav button.on{box-shadow:inset 0 0 0 1px rgba(139,92,246,.45)}}
@media(max-width:720px){.sc{grid-template-columns:minmax(0,1fr);font-size:15.5px}.sc-post{padding:14px;border-radius:18px;margin:8px 0}.sc-comp{border-radius:18px}.sc-nav{border-radius:20px 20px 0 0;box-shadow:0 -10px 30px rgba(0,0,0,.4)}.sc-nav button.on{background:rgba(139,92,246,.25)}.sc-head{font-size:1.2em}.sc-tabs button{padding:10px 4px;font-size:.92em}.sc-kpi b{font-size:1.6em}}
`;

function postCard(p: Post, opts: { quoted?: boolean; rtBy?: string; pinned?: boolean; full?: boolean } = {}): string {
  if (!p) return '';
  if (!opts.full && !opts.quoted && p.a !== me() && wordMuted(p.x)) return '';
  if (p.del) { const w = p.mod ? 'This post was removed by the network moderators.' : 'This post was deleted.'; return opts.quoted ? `<div class="sc-quote sc-m">${w}</div>` : `<div class="sc-post" style="cursor:default"><div class="sc-m">${w}</div></div>`; }
  const imgs = p.m.filter(okImg), blur = (POL.blurMedia || SET().blurAll) && !(LS.get('sc.noblur', false) && !SET().blurAll) && !S.rev.has(p.id);
  const nftBar = p.n ? nftBadge(p) : (p.a === me() && p.m.some(u => /^ipfs:\/\//.test(u)) && !opts.quoted ? `<div class="sc-m" style="margin:6px 0;display:flex;align-items:center;gap:8px">${ic('image', 14)} Only you see this: <button class="sc-btn" data-act="mintnft" data-v="${p.id}" style="padding:4px 10px">Mint this picture as an NFT</button></div>` : '');
  const media = imgs.length ? `${nftBar}<div class="sc-media n${imgs.length} ${blur ? 'blurred' : ''}">${blur ? `<button class="sc-reveal" data-act="reveal" data-v="${p.id}">${ic('eye', 18)}Show image</button>` : ''}${imgs.map(u => CAM.isVideoUrl(u) ? `<video src="${esc(u)}" controls playsinline preload="metadata" loop style="width:100%;max-height:70vh;border-radius:12px;background:#000" onerror="this.remove()"></video>` : `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-act="img" data-v="${esc(u)}" onerror="this.remove()">`).join('')}</div>` : (p.m.length && !imgs.length ? `<div class="sc-m" style="margin:6px 0">${ic('image', 14)} Image hidden: this network only allows ${POL.imageMode === 'off' ? 'no images' : 'images from approved sources'}.</div>` : '');
  const q = p.q && IX.posts.get(p.q) && !opts.quoted ? `<div class="sc-quote" data-act="open" data-v="${p.q}">${postCard(IX.posts.get(p.q)!, { quoted: true })}</div>` : '';
  let poll = '';
  if (p.p) {
    const votes = IX.votes.get(p.id) || new Map<string, number>(), tot = votes.size, mine = me() ? votes.get(me()) : undefined;
    poll = `<div class="sc-poll">${p.p.map((o, i) => { const n = Array.from(votes.values()).filter(v => v === i).length, pc = tot ? Math.round(n / tot * 100) : 0, show = mine != null; return `<div class="sc-opt" data-act="vote" data-v="${p.id}" data-o="${i}">${show ? `<i style="width:${pc}%"></i>` : ''}<span>${esc(o)}${mine === i ? ' ✓' : ''}</span>${show ? `<span>${pc}%</span>` : ''}</div>`; }).join('')}<div class="sc-m">${tot} vote${tot === 1 ? '' : 's'}${mine == null ? ' · tap an option (0.0001 LUMA)' : ''}</div></div>`;
  }
  if (opts.quoted) return `<div><div class="sc-who"><b>${esc(nameOf(p.a))}</b>${badge(p.a)}<span class="sc-m">${esc(tagOf(p.a))} · ${ago(p.t)}</span></div><div class="sc-txt">${rich(p.x)}</div>${media}</div>`;
  const rxm = IX.rx.get(p.id) || new Map<string, string>(), rxc = new Map<string, number>(); for (const e of rxm.values()) rxc.set(e, (rxc.get(e) || 0) + 1);
  const mineRx = rxm.get(me());
  const tips = IX.tipsRef.get(p.id) || [];
  const chips = rxc.size || tips.length ? `<div class="sc-chips">${Array.from(rxc.entries()).sort((a, b) => b[1] - a[1]).map(([e, n]) => `<button class="sc-rxc ${mineRx === e ? 'on' : ''}" data-act="rx" data-v="${p.id}" data-e="${e}" title="React">${e} ${n}</button>`).join('')}${tips.length ? `<button class="sc-tipc" data-act="sup" data-v="${p.id}" title="See who tipped">${ic('coin', 14)}${totalStr(tips, 2)} · ${tips.length} tip${tips.length === 1 ? '' : 's'}</button>` : ''}</div>` : '';
  const bm = bookmarks().includes(p.id);
  const acts = `<div class="sc-acts"><button class="rc" data-act="reply" data-v="${p.id}" title="Reply">${ic('msg')}${k(repN(p.id))}</button><button class="rt ${iRt(p.id) ? 'on' : ''}" data-act="rt" data-v="${p.id}" title="Repost (${COST.rt} LUMA)">${ic('repeat')}${k(rtN(p.id))}</button><button class="lk ${iLike(p.id) ? 'on' : ''}" data-act="like" data-v="${p.id}" title="Like (${COST.like} LUMA)">${iLike(p.id) ? icFill('heart') : ic('heart')}${k(likeN(p.id))}</button><button data-act="react" data-v="${p.id}" title="React">${ic('smile')}${k(rxN(p.id))}</button>${SET().views ? `<span class="sc-vw" data-vw="${p.id}" title="Accounts that viewed this post" style="display:inline-flex;gap:5px;align-items:center;padding:7px 8px;font-size:.84rem;font-weight:600">${ic('eye', 15)}<span class="n">${k(VW[p.id] || 0) || '0'}</span></span>` : ''}<button class="tp" data-act="tip" data-v="${p.id}" title="Tip this post in any token">${ic('coin')}Tip</button><button data-act="menu" data-v="${p.id}" title="More">${ic('more')}</button></div>`;
  const ctxl = opts.rtBy ? `<div class="sc-ctx">${ic('repeat', 14)}${esc(nameOf(opts.rtBy))} reposted</div>` : opts.pinned ? `<div class="sc-ctx">${ic('pin', 14)}Pinned</div>` : boostedNow(p.id) ? `<div class="sc-ctx" style="color:#22d3ee">${ic('zap', 14)}Boosted</div>` : '';
  const rp = p.r && IX.posts.get(p.r) && !opts.full ? `<div class="sc-m" style="margin-bottom:2px">Replying to <a class="sc-l" data-act="user" data-v="${IX.posts.get(p.r)!.a}">${esc(tagOf(IX.posts.get(p.r)!.a))}</a></div>` : '';
  return `<article class="sc-post" data-act="open" data-v="${p.id}"><div data-act="user" data-v="${p.a}" style="cursor:pointer">${avatar(p.a, opts.full ? 48 : 44)}</div><div class="sc-body">${ctxl}<div class="sc-who"><b data-act="user" data-v="${p.a}">${esc(nameOf(p.a))}</b>${badge(p.a)}<span class="sc-m">${esc(tagOf(p.a))} · <span title="${esc(full(p.t))}">${ago(p.t)}</span>${p.ed ? ' · <span title="Edited ' + esc(full(p.ed)) + '">edited</span>' : ''}</span></div>${rp}<div class="sc-txt" ${opts.full ? 'style="font-size:1.12rem"' : ''}>${rich(p.x)}</div>${cardSyms(p.x, false, 2).map(t => priceCard(t, { expand: true })).join('')}${ytId(p.x) ? ytCard(ytId(p.x)) : ''}${listingEmbed(p.x)}${media}${poll}${q}${chips}${acts}</div></article>`;
}
function skeleton(n = 4) { return Array.from({ length: n }, () => `<div class="sc-skel"><i style="width:44px;height:44px;border-radius:50%"></i><div style="flex:1;display:flex;flex-direction:column;gap:9px"><i style="height:12px;width:38%"></i><i style="height:12px;width:92%"></i><i style="height:12px;width:70%"></i></div></div>`).join(''); }
function feedList(items: Array<{ p: Post; rtBy?: string; pinned?: boolean; t: number }>, more: boolean, empty = 'Nothing here yet. Be the first to post.'): string {
  if (!items.length) return S.loaded ? `<div class="sc-empty">${empty}</div>` : skeleton();
  return items.map(i => postCard(i.p, { rtBy: i.rtBy, pinned: i.pinned })).join('') + (more ? `<div style="text-align:center;padding:16px"><button class="sc-btn ghost" data-act="more">Show more</button></div>` : '');
}
function topLevel(filter: (p: Post) => boolean) {
  const out: Array<{ p: Post; rtBy?: string; t: number }> = [];
  for (const id of IX.order) { const p = IX.posts.get(id)!; if (p.del || p.r || isMuted(p.a) || !filter(p)) continue; out.push({ p, t: p.t }); }
  for (const r of IX.rtEv) { const p = IX.posts.get(r.ref); if (p && !p.del && !isMuted(r.by) && !isMuted(p.a) && filter({ ...p, a: r.by })) out.push({ p, rtBy: r.by, t: r.t }); }
  return out;
}
const draftLen = () => S.draft.length;
function ringHtml(len: number) {
  const over = len > MAXTXT, parts = Math.ceil(len / 470), pc = Math.min(1, len / MAXTXT);
  return `<span class="sc-ring" id="sc-ring"><svg width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="3"/><circle cx="12" cy="12" r="9" fill="none" stroke="${over ? '#fbbf24' : '#8b5cf6'}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${(pc * 56.5).toFixed(1)} 100" transform="rotate(-90 12 12)"/></svg>${over ? `<span style="color:#fbbf24">Thread of ${parts}</span>` : len > MAXTXT - 60 ? MAXTXT - len : ''}</span>`;
}
function composer(opts: { reply?: string; quote?: string } = {}): string {
  const rep = opts.reply ? IX.posts.get(opts.reply) : undefined, qq = opts.quote ? IX.posts.get(opts.quote) : undefined;
  if (!me()) return `<div class="sc-comp"><div class="sc-m">Open a LUMA wallet to post, reply, like and tip.</div></div>`;
  { const bl = blocked(); if (bl) return `<div class="sc-comp"><div class="sc-m">${esc(bl)}</div></div>`; }
  const nParts = Math.max(1, Math.ceil(Math.max(S.draft.length, 1) / 470)), cost = S.draft.length > MAXTXT ? nParts * COST.post : COST.post;
  return `<div class="sc-comp" id="sc-comp">${avatar(me())}<div style="flex:1;min-width:0">${rep ? `<div class="sc-m" style="margin-bottom:2px">Replying to ${esc(tagOf(rep.a))}</div>` : ''}<textarea id="sc-txt" maxlength="${MAXTXT * MAXPARTS - 200}" rows="2" placeholder="${rep ? 'Post your reply' : qq ? 'Add your take' : 'What is happening on the chain?  Try $LUMA or #tags'}">${esc(S.draft)}</textarea>
  <div id="sc-card">${cardSyms(S.draft, true).map(t => priceCard(t, { close: true })).join('')}</div><div id="sc-yt">${ytId(S.draft) ? ytCard(ytId(S.draft)) : ''}</div>
  ${S.nft ? `<div class="sc-nftat"><img src="${esc(S.nft.img)}" alt="" referrerpolicy="no-referrer"><div><b>${esc(S.nft.name)}</b><div class="sc-m">NFT attached. It will be shown with a check that you own it.</div></div><button class="sc-ib" data-act="nftx" title="Remove">${ic('x', 16)}</button></div>` : ''}
  ${S.media && !S.nft ? `<div class="sc-nftat">${CAM.isVideoUrl(S.media) ? `<video src="${esc(safeUrl(S.media))}" muted playsinline style="width:64px;height:64px;object-fit:cover;border-radius:8px"></video>` : `<img src="${esc(safeUrl(S.media))}" alt="" referrerpolicy="no-referrer">`}<div><b>${CAM.isVideoUrl(S.media) ? 'Video attached' : 'Picture attached'}</b><div class="sc-m">${UP ? 'Uploading…' : 'It will be shown in your post.'}</div></div><button class="sc-ib" data-act="mediax" title="Remove">${ic('x', 16)}</button></div>` : ''}
  ${qq ? `<div class="sc-quote">${postCard(qq, { quoted: true })}<button class="sc-btn sm ghost" data-act="noquote" style="margin-top:6px">Remove quote</button></div>` : ''}
  ${PP.barHtml()}
  <input class="sc-in" id="sc-media" placeholder="Image link (https:// or ipfs://)" value="${esc(S.media)}" style="${S.media || (document.activeElement as any)?.id === 'sc-media' ? '' : 'display:none'}">
  ${S.pollOn ? `<div id="sc-poll">${S.poll.map((o, i) => `<input class="sc-in sc-po" data-i="${i}" maxlength="40" placeholder="Option ${i + 1}" value="${esc(o)}">`).join('')}${S.poll.length < 4 ? `<button class="sc-btn sm ghost" data-act="addopt">Add option</button>` : ''}</div>` : ''}
  <div class="sc-row" style="justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px solid var(--sl)"><div class="sc-row" style="gap:4px"><div class="sc-tool" style="position:relative"><button class="sc-ib ${S.media || S.nft || MMO ? 'on' : ''}" data-act="mm" title="Add a picture, video or NFT" aria-haspopup="true" aria-expanded="${MMO}">${ic('image')}</button><input type="file" id="sc-file" accept="image/*,video/*" hidden onchange="sc.upload(this,'post')">${MMO ? `<div class="sc-mm" role="menu">${TOUCH ? `<button data-act="upl">${ic('image', 16)}Photo or video</button>` : `<button data-act="cam">${ic('image', 16)}Take a photo or video</button><button data-act="upl">${ic('up', 16)}Upload a picture or video</button>`}<button data-act="showmedia">${ic('link', 16)}Add a picture link</button><button data-act="nftpick">${ic('gem', 16)}Use one of my NFTs</button></div>` : ''}${!opts.reply && !qq ? `<button class="sc-ib ${S.pollOn ? 'on' : ''}" data-act="poll" title="Add a poll">${ic('list')}</button>` : ''}</div>${ringHtml(S.draft.length)}</div>
  <button class="sc-btn" id="sc-go" data-act="post" data-reply="${opts.reply || ''}" data-quote="${opts.quote || ''}" ${S.busy ? 'disabled' : ''}>${S.busy ? esc(S.step || 'Working…') : (rep ? 'Reply' : 'Post')}<span id="sc-cost" style="font-weight:500;opacity:.8;font-size:.8em">${fmt(cost, 6)} LUMA</span></button></div></div></div>`;
}

function topTipped(days = 7) {
  const since = Date.now() / 1000 - days * 86400, m = new Map<string, number>();
  for (const t of IX.tipsAll) if (t.t >= since) m.set(t.to, (m.get(t.to) || 0) + 1);
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
}
function sidebar(): string {
  const day = Date.now() / 1000 - 86400 * 2, tg = new Map<string, number>(), cg = new Map<string, number>();
  for (const id of IX.order) { const p = IX.posts.get(id)!; if (p.del || p.t < day || isMuted(p.a)) continue; for (const t of tagsIn(p.x)) tg.set(t, (tg.get(t) || 0) + 1); for (const t of cashIn(p.x)) cg.set(t, (cg.get(t) || 0) + 1); }
  for (const t of IX.tipsAll) if (t.t >= day && tokName(t.c) !== 'LUMA') { const key = '$' + tokName(t.c).toLowerCase(); cg.set(key, (cg.get(key) || 0) + 2); }
  const trends = Array.from(tg.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5), coins = Array.from(cg.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const m = me(), who = Array.from(IX.followers.entries()).filter(([a]) => a !== m && !iFollow(a) && !isMuted(a)).sort((a, b) => b[1].size - a[1].size).slice(0, 4).map(x => x[0]);
  const fill = who.length < 4 ? Array.from(new Set(IX.order.map(i => IX.posts.get(i)!.a))).filter(a => a !== m && !iFollow(a) && !who.includes(a) && !isMuted(a)).slice(-(4 - who.length)) : [];
  const tt = topTipped();
  const userRow = (a: string, right: string) => `<div class="sc-user"><span data-act="user" data-v="${a}" style="cursor:pointer">${avatar(a, 38)}</span><div class="sc-who"><b data-act="user" data-v="${a}">${esc(nameOf(a))}${badge(a)}</b><span class="sc-m">${esc(tagOf(a))}</span></div>${right}</div>`;
  const W: Record<string, string> = {
    search: `<div class="sc-box" style="padding:10px"><input class="sc-in" id="sc-q" placeholder="Search posts, #tags, $tokens, @people" value="${esc(S.q)}" style="margin:0"></div>`,
    checkin: `${me() ? `<div class="sc-box"><h4>${ic('trend', 17)}Daily check-in</h4><div class="sc-row" style="justify-content:space-between"><div><b style="font-size:1.3rem">${streak(me())}</b> <span class="sc-m">day streak</span></div>${(IX.chk.get(me()) || new Set()).has(today()) ? '<span class="sc-m">Checked in today</span>' : `<button class="sc-btn sm" data-act="chk">Check in</button>`}</div><div class="sc-row" style="margin-top:10px;justify-content:space-between"><span class="sc-m">Reputation <b style="color:#fff">${reputation(me())}</b> · ${invited(me())} invited</span><button class="sc-btn sm ghost" data-act="invite">Invite friends</button></div><button class="sc-btn sm ghost" style="margin-top:8px" data-act="nav" data-v="stats">${ic('chart', 15)}Network stats</button></div>` : ''}`,
    market: `${(() => { const l = visible().filter(x => !isSold(x)).sort((a, b) => b.t - a.t).slice(0, 3); return `<div class="sc-box"><h4>${ic('shop', 17)}Fresh in the marketplace</h4>${l.length ? l.map(x => `<div class="sc-user" style="cursor:pointer" data-act="lopen" data-v="${x.id}"><span class="mk-mi">${x.m.find(okImg) ? `<img src="${esc(x.m.find(okImg)!)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ic('shop', 18)}</span><div class="sc-who"><b>${esc(x.ti)}</b><span class="sc-m">${esc(priceStr(x))}</span></div></div>`).join('') : '<div class="sc-m">Nothing listed yet.</div>'}<button class="sc-btn sm ghost" style="margin-top:8px" data-act="nav" data-v="market">Open marketplace</button></div>`; })()}`,
    tokens: `<div class="sc-box"><h4>${ic('trend', 17)}Trending tokens</h4>${coins.length ? coins.map(([t, n]) => `<a class="sc-tag" data-act="tag" data-v="${esc(t)}"><b class="sc-cash">${esc(t.toUpperCase())}</b><div class="sc-m">${n} mention${n === 1 ? '' : 's'} and tips</div></a>`).join('') : '<div class="sc-m">Write $USD or $LUMA in a post and the token shows up here.</div>'}</div>`,
    topics: `<div class="sc-box"><h4>${ic('chart', 17)}Trending topics</h4>${trends.length ? trends.map(([t, n]) => `<a class="sc-tag" data-act="tag" data-v="${esc(t)}"><b>#${esc(t)}</b><div class="sc-m">${n} post${n === 1 ? '' : 's'}</div></a>`).join('') : '<div class="sc-m">Tags show up here when people use them.</div>'}</div>`,
    tipped: `${tt.length ? `<div class="sc-box"><h4>${ic('coin', 17)}Most tipped this week</h4>${tt.map(([a, n]) => userRow(a, `<span class="sc-m">${n} tip${n === 1 ? '' : 's'}</span>`)).join('')}</div>` : ''}`,
    follow: `<div class="sc-box"><h4>${ic('user', 17)}Who to follow</h4>${[...who, ...fill].length ? [...who, ...fill].map(a => userRow(a, `<button class="sc-btn sm" data-act="follow" data-v="${a}">Follow</button>`)).join('') : '<div class="sc-m">No one yet. Invite your friends.</div>'}</div>`,
    foot: `<div class="sc-m" style="padding:0 6px;line-height:1.55;font-size:.8rem">Everything here is stored on the LUMA chain. You own your account, your posts and your followers. Actions cost a fraction of a cent of LUMA. Tips, in any token, go 100% to the person tipped.</div></div>`,
  };
  const cfg = dashCfg();
  return `<div class="sc-side">${W.search}${cfg.order.filter(id => !cfg.off.includes(id)).map(id => W[id] || '').join('')}${W.foot}</div>`;
}

function notifications() { const s = SET(); return notifAll().filter(n => !(n.ic === 'heart' && !s.nLike) && !(n.ic === 'user' && !s.nFollow) && !(n.ic === 'coin' && !s.nTip) && !((n.ic === 'msg' || n.ic === 'quote' || n.ic === 'repeat') && !s.nRep)); }
function notifAll(): Array<{ t: number; ic: string; col: string; html: string }> {
  const m = me(), out: Array<{ t: number; ic: string; col: string; html: string }> = []; if (!m) return out;
  const handle = handleOf(m), mention = handle ? new RegExp('@' + handle + '\\b', 'i') : null;
  for (const e of EV) {
    const d = e.d, who = `<b data-act="user" data-v="${e.a}">${esc(nameOf(e.a))}</b>`; if (e.a === m || isMuted(e.a)) continue;
    const ref = typeof d.ref === 'string' ? IX.posts.get(d.ref.toUpperCase()) : undefined, snip = ref ? `<div class="sc-m">${esc(ref.x.slice(0, 120))}</div>` : '';
    if (d.t === 'like' && ref && ref.a === m) out.push({ t: e.t, ic: 'heart', col: '#fb5b8d', html: `${who} liked your post${snip}` });
    else if (d.t === 'rt' && ref && ref.a === m) out.push({ t: e.t, ic: 'repeat', col: '#34d399', html: `${who} reposted your post${snip}` });
    else if (d.t === 'rx' && ref && ref.a === m && d.e) out.push({ t: e.t, ic: 'smile', col: '#fbbf24', html: `${who} reacted ${esc(d.e)} to your post${snip}` });
    else if (d.t === 'boost' && ref && ref.a === m) out.push({ t: e.t, ic: 'zap', col: '#22d3ee', html: `${who} boosted your post with ${fmt(e.v, 2)} LUMA${snip}` });
    else if (d.t === 'fol' && d.a === m) out.push({ t: e.t, ic: 'user', col: '#8db4ff', html: `${who} followed you` });
    else if (d.t === 'vote' && ref && ref.a === m) out.push({ t: e.t, ic: 'list', col: '#a78bfa', html: `${who} voted in your poll` });
    else if (d.t === 'post') { const p = IX.posts.get(e.h); if (!p || p.del) continue; const parent = p.r && IX.posts.get(p.r), q = p.q && IX.posts.get(p.q);
      if (parent && parent.a === m) out.push({ t: e.t, ic: 'msg', col: '#8db4ff', html: `${who} replied<div class="sc-m">${esc(p.x.slice(0, 140))}</div>` }); else if (q && q.a === m) out.push({ t: e.t, ic: 'quote', col: '#a78bfa', html: `${who} quoted your post<div class="sc-m">${esc(p.x.slice(0, 140))}</div>` }); else if (mention && mention.test(p.x)) out.push({ t: e.t, ic: 'at', col: '#8db4ff', html: `${who} mentioned you<div class="sc-m">${esc(p.x.slice(0, 140))}</div>` }); }
  }
  for (const tp of IX.tipsTo.get(m) || []) if (tp.by !== m && !isMuted(tp.by)) out.push({ t: tp.t, ic: 'coin', col: '#fbbf24', html: `<b data-act="user" data-v="${tp.by}">${esc(nameOf(tp.by))}</b> tipped you <b>${fmt(tp.v, 4)} ${esc(tokName(tp.c))}</b>${tp.m ? `<div class="sc-m">“${esc(tp.m)}”</div>` : ''}` });
  return out.sort((a, b) => b.t - a.t).slice(0, 80);
}
const unread = () => { const seen = LS.get(seenKey(), 0); return notifications().filter(n => n.t > seen).length; };

const tipRows = (list: Tip[]) => list.slice().sort((a, b) => b.t - a.t).slice(0, 40).map(t => `<div class="sc-user">${avatar(t.by, 36)}<div class="sc-who"><b data-act="user" data-v="${t.by}">${esc(nameOf(t.by))}${badge(t.by)}</b><span class="sc-m">${t.m ? '“' + esc(t.m) + '” · ' : ''}${ago(t.t)} ago</span></div><b style="color:#fcd34d">${fmt(t.v, 4)} ${esc(tokName(t.c))}</b></div>`).join('');
function profileView(a: string, tab = 'posts'): string {
  const p: Prof = IX.prof.get(a) || {}, mine = a === me(), h = handleOf(a);
  const posts = IX.order.map(i => IX.posts.get(i)!).filter(x => !x.del && x.a === a);
  let list: Post[] = [];
  if (tab === 'posts') list = posts.filter(x => !x.r); else if (tab === 'replies') list = posts.filter(x => x.r); else if (tab === 'media') list = posts.filter(x => x.m.length); else if (tab === 'likes') list = Array.from(IX.likes.entries()).filter(([, s]) => s.has(a)).map(([id]) => IX.posts.get(id)!).filter(x => x && !x.del && !isMuted(x.a));
  list = list.sort((x, y) => y.t - x.t);
  const pinId = IX.pin.get(a), pinned = tab === 'posts' && pinId ? IX.posts.get(pinId) : undefined; if (pinned && !pinned.del) list = list.filter(x => x.id !== pinId);
  const joined = posts[0], got = IX.tipsTo.get(a) || [], sup = new Set(got.map(t => t.by)).size, accent = p.c || '#6366f1';
  const banner = p.k && okImg(p.k) ? `background:#0d1020 url('${esc(p.k)}') center/cover` : `background:linear-gradient(135deg,${accent},#312e81 60%,#0e7490)`;
  const mut = !mine && me() ? Array.from(IX.followers.get(a) || []).filter(x => x !== me() && iFollow(x)) : [];
  const likesGot = posts.reduce((n, x) => n + likeN(x.id), 0);
  const links = (p.ln || []).map(l => `<a class="sc-lk" href="${esc(l.u)}" target="_blank" rel="noopener noreferrer nofollow">${ic('link', 14)}${esc(l.t || l.u.replace(/^https:\/\//, '').slice(0, 24))}</a>`).join('');
  const meta = [p.jb ? `${ic('pen', 14)}${esc(p.jb)}` : '', p.l ? `${ic('pin', 14)}${esc(p.l)}` : '', p.pr ? `${ic('user', 14)}${esc(p.pr)}` : '', joined ? `${ic('home', 14)}Active since ${new Date(joined.t * 1000).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}` : ''].filter(Boolean).map(x => `<span class="sc-mt">${x}</span>`).join('');
  const checks: Array<[string, boolean]> = [['Add a photo', !!p.i], ['Add a cover picture', !!p.k], ['Write a bio', !!p.b], ['Claim your @handle', !!h], ['Add a link', !!(p.w || (p.ln || []).length)], ['Pin a post', !!pinId]], done = checks.filter(x => x[1]).length;
  const shine = mine && done < checks.length ? `<div class="sc-box" style="margin:10px 0"><div class="sc-row" style="justify-content:space-between"><h4 style="margin:0">Make your profile shine</h4><span class="sc-m">${done}/${checks.length}</span></div><div class="sc-bar"><i style="width:${Math.round(done / checks.length * 100)}%"></i></div><div class="sc-row" style="margin-top:10px">${checks.filter(x => !x[1]).map(x => `<button class="sc-btn sm ghost" data-act="editprof">${esc(x[0])}</button>`).join('')}</div></div>` : '';
  const tabs: Array<[string, string]> = [['posts', 'Posts'], ['replies', 'Replies'], ['media', 'Media'], ['shop', 'Shop'], ['nfts', 'NFTs'], ['tips', 'Tips'], ['likes', 'Likes']];
  const body = tab === 'shop' ? `<div style="padding:10px">${shopGrid(a)}</div>` : tab === 'nfts' ? nftTab(a) : tab === 'tips' ? `<div style="padding:10px">${got.length ? `<div class="sc-m" style="margin-bottom:6px">${totalStr(got, 6)} from ${sup} supporter${sup === 1 ? '' : 's'}</div>${tipRows(got)}` : '<div class="sc-empty">No tips yet.</div>'}</div>` : list.length ? list.slice(0, S.shown).map(x => postCard(x)).join('') : pinned ? '' : '<div class="sc-empty">Nothing here yet.</div>';
  return `<div class="sc-prof" style="--pa:${esc(accent)}"><div class="sc-ban" style="${banner}"></div><div class="sc-pinfo"><div class="sc-row" style="justify-content:space-between;align-items:flex-end"><span class="sc-pav ${p.sh === 's' ? 'sq' : ''}">${avatar(a, 96)}</span>${mine ? `<div class="sc-row"><button class="sc-btn sm ghost" data-act="plink" data-v="${a}">${ic('share', 15)}Share</button><button class="sc-btn sm ghost" data-act="nav" data-v="dash">${ic('chart', 15)}Creator</button><button class="sc-btn sm" data-act="editprof">${ic('pen', 15)}Edit profile</button><button class="sc-btn sm ghost" data-act="nav" data-v="settings" style="margin-left:6px">Settings</button></div>` : `<div class="sc-row"><button class="sc-ib" data-act="menuu" data-v="${a}" title="More">${ic('more')}</button><button class="sc-ib" data-act="plink" data-v="${a}" title="Copy profile link">${ic('share')}</button><button class="sc-btn sm gold" data-act="tip" data-to="${a}">${ic('coin', 15)}Tip</button><button class="sc-btn sm ${iFollow(a) ? 'on' : ''}" data-act="follow" data-v="${a}">${iFollow(a) ? 'Following' : 'Follow'}</button></div>`}</div>
  <div class="sc-pname">${esc(nameOf(a))}${badge(a)}</div><div class="sc-m">${h ? '@' + esc(h) + ' · ' : ''}<span class="mono">${esc(ctx.showL(a))}</span>${!mine && me() && (IX.follows.get(a) || new Set()).has(me()) ? ' <span class="sc-fy">Follows you</span>' : ''}</div>
  ${p.st ? `<div class="sc-stt">${esc(p.st)}</div>` : ''}${p.b ? `<div class="sc-txt" style="margin:10px 0 6px">${rich(p.b)}</div>` : mine ? `<div class="sc-m" style="margin-top:10px">Add a bio so people know who you are.</div>` : ''}
  <div class="sc-mts">${meta}<span class="sc-mt">${ic('gem', 14)}Reputation ${reputation(a)}</span>${streak(a) > 1 ? `<span class="sc-mt">${ic('trend', 14)}${streak(a)} day streak</span>` : ''}</div>${achievements(a).length ? `<div class="sc-lks">${achievements(a).map(x => `<span class="sc-lk" style="cursor:default">${ic(x[0], 13)}${esc(x[1])}</span>`).join('')}</div>` : ''}${p.w || links ? `<div class="sc-lks">${p.w ? `<a class="sc-lk" href="${esc(p.w)}" target="_blank" rel="noopener noreferrer nofollow">${ic('link', 14)}${esc(p.w.replace(/^https:\/\//, '').slice(0, 30))}</a>` : ''}${links}</div>` : ''}
  <div class="sc-stats" style="margin-top:12px"><button class="sc-stat" data-act="flist" data-v="${a}" data-k="following"><b>${fwgN(a)}</b> Following</button><button class="sc-stat" data-act="flist" data-v="${a}" data-k="followers"><b>${folN(a)}</b> Followers</button><span><b>${posts.length}</b> Posts</span><span><b>${likesGot}</b> Likes</span></div>
  ${mut.length ? `<div class="sc-m" style="margin-top:8px">Followed by ${mut.slice(0, 2).map(x => esc(nameOf(x))).join(', ')}${mut.length > 2 ? ' and ' + (mut.length - 2) + ' more you follow' : ''}</div>` : ''}
  ${got.length ? `<div class="sc-jar" data-act="supu" data-v="${a}">${ic('coin', 20)}<div><b style="color:#fcd34d">Tip jar</b><div class="sc-m">${totalStr(got)} from ${sup} supporter${sup === 1 ? '' : 's'}</div></div></div>` : ''}
  ${isMuted(a) ? `<div class="sc-warn" style="margin-bottom:0">You muted this account. <a class="sc-l" data-act="unmute" data-v="${a}">Unmute</a></div>` : ''}${POL.banned.has(a) ? `<div class="sc-warn" style="margin-bottom:0">This account is suspended by the network operator.</div>` : ''}</div></div>${shine}
  <div class="sc-tabs">${tabs.map(([t, l]) => `<button class="${tab === t ? 'on' : ''}" data-act="ptab" data-v="${t}">${l}</button>`).join('')}</div>${pinned && !pinned.del && tab === 'posts' ? postCard(pinned, { pinned: true }) : ''}${body}`;
}
function flistModal(a: string, kind: string) {
  const set = Array.from((kind === 'followers' ? IX.followers.get(a) : IX.follows.get(a)) || []);
  ctx.modal(mcard(`<div class="k" style="margin-bottom:8px">${kind === 'followers' ? 'Followers' : 'Following'} of ${esc(nameOf(a))} (${set.length})</div>${set.length ? set.slice(0, 80).map(x => `<div class="sc-user">${avatar(x, 40)}<div class="sc-who"><b style="cursor:pointer" onclick="sc.goU('${x}')">${esc(nameOf(x))}${badge(x)}</b><span class="sc-m">${esc(tagOf(x))}${(IX.prof.get(x) || {}).b ? ' · ' + esc((IX.prof.get(x) || {}).b!.slice(0, 50)) : ''}</span></div>${x !== me() ? `<button class="sc-btn sm ${iFollow(x) ? 'on' : ''}" onclick="sc.fol('${x}')">${iFollow(x) ? 'Following' : 'Follow'}</button>` : ''}</div>`).join('') : '<div class="sc-m">Nobody yet.</div>'}<div class="sc-row" style="justify-content:flex-end;margin-top:8px"><button class="sc-btn ghost" onclick="sc.close()">Close</button></div>`, 420));
}
function nftTab(a: string): string {
  const c = NFTS.get(a); if (!c) { void loadNfts(a).then(() => { paint(); }); return skeleton(2); }
  return `<div style="padding:10px">${a === me() ? '<div class="sc-m" style="margin-bottom:8px">Tap Share to post one of your NFTs with a check that you own it.</div>' : ''}${nftGrid(c.list, false, a === me())}</div>`;
}
const tipComment = (tp: Tip): string => `<div class="sc-post" style="display:flex;gap:10px;padding:12px;border-bottom:1px solid var(--sl);background:linear-gradient(90deg,rgba(251,191,36,.10),transparent)">${avatar(tp.by)}<div style="flex:1;min-width:0"><div><b data-act="user" data-v="${tp.by}" style="cursor:pointer">${esc(nameOf(tp.by))}</b> <span class="sc-m">${esc(tagOf(tp.by))} · ${ago(tp.t)}</span></div><div style="color:#fcd34d;font-weight:700;margin-top:2px">${ic('coin', 15)} Tipped ${fmt(tp.v, 4)} ${esc(tokName(tp.c))} to ${esc(nameOf(tp.to))}</div>${tp.m ? `<div style="margin-top:4px;word-break:break-word">${esc(tp.m)}</div>` : ''}</div></div>`;
function threadView(id: string): string {
  const p = IX.posts.get(id); if (!p) return `<div class="sc-empty">${S.loaded ? 'This post was not found.' : 'Reading the chain…'}</div>`;
  const chain: Post[] = []; let cur: Post | undefined = p; while (cur && cur.r && chain.length < 12) { cur = IX.posts.get(cur.r); if (cur) chain.unshift(cur); }
  const replies = (IX.replies.get(id) || []).map(x => IX.posts.get(x)!).filter(x => x && !x.del && !isMuted(x.a)).sort((a, b) => score(b) - score(a) || b.t - a.t);
  const likers = Array.from(IX.likes.get(id) || []).slice(0, 8), tips = IX.tipsRef.get(id) || [];
  return `${chain.map(c => postCard(c)).join('')}<div style="border-bottom:1px solid var(--sl)">${postCard(p, { full: true })}${likers.length ? `<div class="sc-m" style="padding:0 12px 14px">Liked by ${likers.map(a => esc(nameOf(a))).join(', ')}${likeN(id) > likers.length ? ' and ' + (likeN(id) - likers.length) + ' more' : ''}</div>` : ''}${tips.length ? `<div class="sc-m" style="padding:0 12px 14px;color:#fcd34d">${ic('coin', 14)} ${totalStr(tips)} tipped by ${new Set(tips.map(t => t.by)).size} people</div>` : ''}</div>${composer({ reply: id })}${tips.filter(x => !isMuted(x.by) && !SET().hideTipc).sort((x, y) => y.t - x.t).map(tipComment).join('')}${replies.length ? replies.map(r => postCard(r)).join('') : (tips.length ? '' : '<div class="sc-empty">No replies yet.</div>')}`;
}
function searchView(q: string): string {
  const needle = q.trim().toLowerCase().replace(/^[#@]/, ''); if (!needle) return '<div class="sc-empty">Type something to search.</div>';
  const people = Array.from(new Set([...IX.cur.keys(), ...IX.prof.keys(), ...IX.order.map(i => IX.posts.get(i)!.a)])).filter(a => !isMuted(a) && (nameOf(a).toLowerCase().includes(needle) || handleOf(a).includes(needle) || ctx.showL(a).toLowerCase().startsWith(q.trim().toLowerCase()))).slice(0, 6);
  const posts = IX.order.map(i => IX.posts.get(i)!).filter(p => !p.del && !isMuted(p.a) && p.x.toLowerCase().includes(needle)).sort((a, b) => b.t - a.t).slice(0, 40);
  return `${people.length ? `<div class="sc-box" style="margin:10px 0"><h4>People</h4>${people.map(a => `<div class="sc-user"><span data-act="user" data-v="${a}" style="cursor:pointer">${avatar(a, 38)}</span><div class="sc-who"><b data-act="user" data-v="${a}">${esc(nameOf(a))}${badge(a)}</b><span class="sc-m">${esc(tagOf(a))} · ${folN(a)} followers</span></div></div>`).join('')}</div>` : ''}${posts.length ? posts.map(p => postCard(p)).join('') : '<div class="sc-empty">No posts match.</div>'}`;
}
// ---------- creator analytics: charts and numbers for your own account ----------
const AC = { a: '#6366f1', b: '#22d3ee', c: '#34d399', d: '#fbbf24', e: '#60a5fa' };
const dayIx = (t: number) => Math.floor((t * 1000 - new Date(t * 1000).getTimezoneOffset() * 6e4) / 864e5);
const nz = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
function niceMax(v: number) { if (v <= 4) return 4; const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
function chartLine(series: { name: string; color: string; vals: number[] }[], labels: string[], h = 160): string {
  const W = 600, L = 34, R = 8, T = 8, B = 22, n = labels.length, mx = niceMax(Math.max(1, ...series.flatMap(s => s.vals))), iw = W - L - R, ih = h - T - B;
  const X = (i: number) => L + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw), Y = (v: number) => T + ih - (v / mx) * ih;
  const grid = [0, 1, 2, 3, 4].map(k => { const y = T + ih - (k / 4) * ih; return `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,.07)"/><text x="${L - 6}" y="${y + 3}" text-anchor="end" fill="#8d93ad" font-size="10">${nz(mx * k / 4)}</text>`; }).join('');
  const xl = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i).map(i => `<text x="${X(i)}" y="${h - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" fill="#8d93ad" font-size="10">${esc(labels[i] || '')}</text>`).join('');
  const ln = series.map((s, si) => { const pts = s.vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' '); return `${si === 0 ? `<polygon points="${L},${T + ih} ${pts} ${X(n - 1).toFixed(1)},${T + ih}" fill="${s.color}" opacity=".13"/>` : ''}<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`; }).join('');
  const dots = series.map(s => s.vals.map((v, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="7" fill="transparent"><title>${esc(labels[i])} · ${esc(s.name)}: ${nz(v)}</title></circle>`).join('')).join('');
  return `<svg viewBox="0 0 ${W} ${h}" width="100%" role="img" style="display:block">${grid}${xl}${ln}${dots}</svg>`;
}
function chartBars(stacks: { name: string; color: string; vals: number[] }[], labels: string[], h = 160, every = 1): string {
  const W = 600, L = 34, R = 8, T = 8, B = 22, n = labels.length, tot = labels.map((_, i) => stacks.reduce((s, k) => s + k.vals[i], 0)), mx = niceMax(Math.max(1, ...tot)), iw = W - L - R, ih = h - T - B, bw = iw / n;
  const grid = [0, 1, 2, 3, 4].map(k => { const y = T + ih - (k / 4) * ih; return `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,.07)"/><text x="${L - 6}" y="${y + 3}" text-anchor="end" fill="#8d93ad" font-size="10">${nz(mx * k / 4)}</text>`; }).join('');
  let bars = '';
  for (let i = 0; i < n; i++) { let y = T + ih; for (const s of stacks) { const hh = (s.vals[i] / mx) * ih; if (hh <= 0) continue; y -= hh; bars += `<rect x="${(L + i * bw + bw * .14).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * .72).toFixed(1)}" height="${hh.toFixed(1)}" rx="1.5" fill="${s.color}"><title>${esc(labels[i])} · ${esc(s.name)}: ${nz(s.vals[i])}</title></rect>`; } }
  const xl = labels.map((l, i) => i % every === 0 ? `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle" fill="#8d93ad" font-size="10">${esc(l)}</text>` : '').join('');
  return `<svg viewBox="0 0 ${W} ${h}" width="100%" role="img" style="display:block">${grid}${xl}${bars}</svg>`;
}
const legend = (s: { name: string; color: string }[]) => `<div class="sc-lg">${s.map(x => `<span><i style="background:${x.color}"></i>${esc(x.name)}</span>`).join('')}</div>`;
const hbars = (rows: { l: string; v: number; sub?: string }[], color: string) => { const mx = Math.max(1, ...rows.map(r => r.v)); return rows.length ? rows.map(r => `<div class="sc-hb"><span class="sc-hbl">${esc(r.l)}</span><div class="sc-hbt"><div style="width:${Math.max(2, r.v / mx * 100).toFixed(1)}%;background:${color}"></div></div><b>${esc(r.sub ?? nz(r.v))}</b></div>`).join('') : '<div class="sc-m">Nothing yet.</div>'; };
const delta = (c: number, p: number) => { if (!p && !c) return '<small class="sc-dl">no change</small>'; if (!p) return '<small class="sc-dl up">new</small>'; const d = (c - p) / p * 100; return `<small class="sc-dl ${d >= 0 ? 'up' : 'dn'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)}% vs previous</small>`; };
function analyticsHtml(m: string): string {
  const R: number = [7, 30, 90].includes((S as any).dr) ? (S as any).dr : 30, nowD = dayIx(Date.now() / 1000), d0 = nowD - R + 1, p0 = d0 - R;
  const mineAll = IX.order.map(i => IX.posts.get(i)!).filter(p => p.a === m && !p.del), myIds = new Set(mineAll.map(p => p.id));
  const mk = () => new Array(R).fill(0), post = mk(), lk = mk(), rt = mk(), rp = mk(), rx = mk(), fl = mk(), tp = mk();
  const prev = { post: 0, eng: 0, fol: 0, tips: 0 }, cur = { post: 0, eng: 0, fol: 0, tips: 0 }, hour = new Array(24).fill(0), dow = new Array(7).fill(0), who = new Map<string, number>(), seen = new Set<string>();
  const add = (arr: number[], t: number, key: 'eng' | 'fol' | 'tips' | 'post', by?: string) => { const d = dayIx(t); if (d >= d0 && d <= nowD) { arr[d - d0]++; cur[key]++; } else if (d >= p0 && d < d0) prev[key]++; if (d >= d0 && d <= nowD && key === 'eng') { const dt = new Date(t * 1000); hour[dt.getHours()]++; dow[dt.getDay()]++; if (by) who.set(by, (who.get(by) || 0) + 1); } };
  for (const p of mineAll) add(post, p.t, 'post');
  for (const p of IX.posts.values()) if (!p.del && p.r && p.a !== m && myIds.has(p.r)) add(rp, p.t, 'eng', p.a);
  for (const e of EV) { const d = e.d; if (!d) continue; const ref = typeof d.ref === 'string' ? d.ref.toUpperCase() : '';
    if (d.t === 'fol' && d.a === m && e.a !== m) { const k = 'f' + e.a; if (!seen.has(k)) { seen.add(k); add(fl, e.t, 'fol'); } }
    else if (ref && myIds.has(ref) && e.a !== m) { const k = d.t + e.a + ref; if (seen.has(k)) continue;
      if (d.t === 'like') { seen.add(k); add(lk, e.t, 'eng', e.a); } else if (d.t === 'rt') { seen.add(k); add(rt, e.t, 'eng', e.a); } else if (d.t === 'rx' && d.e) { seen.add(k); add(rx, e.t, 'eng', e.a); } } }
  for (const t of IX.tipsTo.get(m) || []) if (t.by !== m) add(tp, t.t, 'tips');
  const labels = Array.from({ length: R }, (_, i) => { const dt = new Date((d0 + i) * 864e5 + new Date().getTimezoneOffset() * 6e4); return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); });
  const eng = lk.map((v, i) => v + rt[i] + rp[i] + rx[i]), engT = eng.reduce((a, b) => a + b, 0), postT = cur.post, rate = postT ? engT / postT : 0, prate = prev.post ? prev.eng / prev.post : 0;
  const fNow = folN(m), cum = mk(); let acc = fNow - cur.fol; for (let i = 0; i < R; i++) { acc += fl[i]; cum[i] = Math.max(0, acc); }
  const bestH = hour.indexOf(Math.max(...hour)), bestD = dow.indexOf(Math.max(...dow)), DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], hl = (h: number) => (h % 12 || 12) + (h < 12 ? ' am' : ' pm');
  const inR = mineAll.filter(p => { const d = dayIx(p.t); return d >= d0 && d <= nowD; }), engOf = (p: Post) => likeN(p.id) + rtN(p.id) + (IX.replies.get(p.id) || []).length + rxN(p.id);
  const mix = [['Text only', inR.filter(p => !p.m.length && !p.r && !p.q && !p.p)], ['With a picture', inR.filter(p => p.m.length)], ['Replies', inR.filter(p => p.r)], ['Quotes', inR.filter(p => p.q)], ['Polls', inR.filter(p => p.p)]] as [string, Post[]][];
  const mixRows = mix.filter(x => x[1].length).map(([l, a]) => ({ l: l + ' (' + a.length + ')', v: a.reduce((s, p) => s + engOf(p), 0) / a.length, sub: (a.reduce((s, p) => s + engOf(p), 0) / a.length).toFixed(1) + ' avg' }));
  const gotR = (IX.tipsTo.get(m) || []).filter(t => t.by !== m && dayIx(t.t) >= d0), tokRows = totals(gotR).slice(0, 6).map(x => ({ l: x.name, v: x.v, sub: fmt(x.v, 4) }));
  const topW = Array.from(who.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([a, n]) => ({ l: nameOf(a), v: n, sub: n + ' actions' }));
  const topP = inR.slice().sort((a, b) => engOf(b) - engOf(a)).filter(p => engOf(p) > 0).slice(0, 5);
  const kp = (v: string, l: string, d: string) => `<div class="sc-kpi"><b>${v}</b><span>${l}</span>${d}</div>`;
  const box = (t: string, inner: string, sub = '') => `<div class="sc-box" style="margin-bottom:12px"><h4>${t}</h4>${sub ? `<div class="sc-m" style="margin:-4px 0 8px">${sub}</div>` : ''}${inner}</div>`;
  const hrs = hour.map((v, i) => ({ v, i })), hLab = Array.from({ length: 24 }, (_, i) => (i % 6 === 0 ? hl(i).replace(' ', '') : ''));
  return `<div class="sc-seg" role="tablist">${[7, 30, 90].map(r => `<button class="${r === R ? 'on' : ''}" data-act="drange" data-v="${r}">${r} days</button>`).join('')}</div>
  <div class="sc-kpis">${kp(nz(engT), 'Engagement received', delta(cur.eng, prev.eng))}${kp(nz(postT), 'Posts published', delta(cur.post, prev.post))}${kp(nz(cur.fol), 'New followers', delta(cur.fol, prev.fol))}${kp(rate.toFixed(1), 'Engagement per post', delta(rate, prate))}${kp(nz(cur.tips), 'Tips received', delta(cur.tips, prev.tips))}${kp(nz(fNow), 'Total followers', '<small class="sc-dl">all time</small>')}</div>
  ${box(ic('chart', 17) + 'Engagement by day', chartBars([{ name: 'Likes', color: AC.a, vals: lk }, { name: 'Reposts', color: AC.b, vals: rt }, { name: 'Replies', color: AC.c, vals: rp }, { name: 'Reactions', color: AC.d, vals: rx }], labels, 170, Math.ceil(R / 6)) + legend([{ name: 'Likes', color: AC.a }, { name: 'Reposts', color: AC.b }, { name: 'Replies', color: AC.c }, { name: 'Reactions', color: AC.d }]), 'What other people did on your posts, by day.')}
  ${box(ic('user', 17) + 'Follower growth', chartLine([{ name: 'Followers', color: AC.c, vals: cum }], labels, 150), `${cur.fol >= 0 ? '+' : ''}${cur.fol} in the last ${R} days.`)}
  ${box(ic('list', 17) + 'Posting activity and tips', chartLine([{ name: 'Posts', color: AC.e, vals: post }, { name: 'Tips', color: AC.d, vals: tp }], labels, 140) + legend([{ name: 'Posts', color: AC.e }, { name: 'Tips', color: AC.d }]))}
  ${box(ic('chart', 17) + 'When your audience is active', chartBars([{ name: 'Actions', color: AC.a, vals: hour }], Array.from({ length: 24 }, (_, i) => (i % 6 === 0 ? hl(i).replace(' ', '') : String(i))), 130, 6) + (engT ? `<div class="sc-m" style="margin-top:6px">Most active hour: <b>${hl(bestH)}</b> · best day: <b>${DOW[bestD]}</b>. Times are in your time zone.</div>` : ''), 'Likes, reposts, replies and reactions by hour of the day.')}
  <div class="sc-two">${box(ic('chart', 17) + 'Content that works', hbars(mixRows, AC.b), 'Average engagement per post by type.')}${box(ic('coin', 17) + 'Tips by token', hbars(tokRows, AC.d), `Received in the last ${R} days.`)}</div>
  ${box(ic('user', 17) + 'Most engaged people', hbars(topW, AC.c), 'Who interacted with your posts the most.')}
  ${box(ic('chart', 17) + `Best posts, last ${R} days`, topP.length ? topP.map((p, i) => `<div class="sc-tag" data-act="open" data-v="${p.id}"><div><b style="color:${AC.b}">#${i + 1}</b> ${esc(p.x.slice(0, 110))}</div><div class="sc-m">${likeN(p.id)} likes · ${rtN(p.id)} reposts · ${(IX.replies.get(p.id) || []).length} replies · ${rxN(p.id)} reactions · ${totalStr(IX.tipsRef.get(p.id) || [], 2) || '0 tips'}</div></div>`).join('') : '<div class="sc-m">Post something and it will show up here.</div>')}`;
}
function dashView(): string {
  const m = me(); if (!m) return `<div class="sc-empty">Open a LUMA wallet to see your creator numbers.</div>`;
  const xp = `<div class="sc-box" style="margin:10px 0"><h4>Your data</h4><div class="sc-m" style="margin-bottom:8px">Download everything you have done on LUMA Social as a file. It is yours.</div><div class="sc-row"><button class="sc-btn sm ghost" data-act="export">Export my data</button><button class="sc-btn sm ghost" data-act="invite">Copy my invite link</button></div></div>`;
  const mine = IX.order.map(i => IX.posts.get(i)!).filter(p => p.a === m && !p.del);
  let likes = 0, rts = 0, reps = 0, rxs = 0, bst = 0; for (const p of mine) { likes += likeN(p.id); rts += rtN(p.id); reps += (IX.replies.get(p.id) || []).length; rxs += rxN(p.id); for (const b of IX.boosts.get(p.id) || []) bst += b.v; }
  const got = IX.tipsTo.get(m) || [], sent = IX.tipsBy.get(m) || [], eng = (p: Post) => likeN(p.id) + 2 * rtN(p.id) + (IX.replies.get(p.id) || []).length + rxN(p.id) + 3 * (IX.tipsRef.get(p.id) || []).length;
  const top = mine.slice().sort((a, b) => eng(b) - eng(a)).slice(0, 5).filter(p => eng(p) > 0);
  const sup = new Map<string, Tip[]>(); for (const t of got) { if (t.by === m) continue; const l = sup.get(t.by) || []; l.push(t); sup.set(t.by, l); }
  const board = Array.from(sup.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 8), mu = muted();
  const kpi = (n: string | number, l: string) => `<div class="sc-kpi"><b>${n}</b><span>${l}</span></div>`;
  return xp + analyticsHtml(m) + `<div class="sc-kpis" style="display:none">${kpi(folN(m), 'Followers')}${kpi(mine.length, 'Posts')}${kpi(likes, 'Likes received')}${kpi(rts, 'Reposts')}${kpi(reps, 'Replies')}${kpi(rxs, 'Reactions')}</div>
  <div class="sc-box" style="margin-bottom:12px"><h4>${ic('coin', 17)}Tips received</h4>${got.length ? `<div style="font-size:1.25rem;font-weight:800;color:#fcd34d">${totalStr(got, 6)}</div><div class="sc-m">${got.length} tip${got.length === 1 ? '' : 's'} from ${sup.size} supporter${sup.size === 1 ? '' : 's'}. Sent by you: ${sent.length ? totalStr(sent, 4) : 'none yet'}.</div>` : '<div class="sc-m">No tips yet. Tips arrive in your wallet in LUMA or any token. Share your profile to get your first.</div>'}</div>
  ${board.length ? `<div class="sc-box" style="margin-bottom:12px"><h4>${ic('user', 17)}Top supporters</h4>${board.map(([a, l], i) => `<div class="sc-user"><span class="sc-m" style="width:18px">${i + 1}</span><span data-act="user" data-v="${a}" style="cursor:pointer">${avatar(a, 36)}</span><div class="sc-who"><b data-act="user" data-v="${a}">${esc(nameOf(a))}${badge(a)}</b><span class="sc-m">${totalStr(l, 3)}</span></div><span class="sc-m">${l.length}x</span></div>`).join('')}</div>` : ''}
  <div class="sc-box" style="margin-bottom:12px"><h4>${ic('chart', 17)}Top posts</h4>${top.length ? top.map(p => `<div class="sc-tag" data-act="open" data-v="${p.id}"><div>${esc(p.x.slice(0, 110))}</div><div class="sc-m">${likeN(p.id)} likes · ${rtN(p.id)} reposts · ${(IX.replies.get(p.id) || []).length} replies · ${rxN(p.id)} reactions</div></div>`).join('') : '<div class="sc-m">Your most engaging posts show up here.</div>'}${bst ? `<div class="sc-m" style="margin-top:8px">${fmt(bst, 2)} LUMA spent on boosts.</div>` : ''}</div>
  <div class="sc-box" style="margin-bottom:12px"><h4>${ic('eye', 17)}Safety and display</h4><label class="sc-m" style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" ${LS.get('sc.noblur', false) ? 'checked' : ''} data-act="noblur"> Show images without blurring them first${POL.blurMedia ? '' : ' (this network does not blur by default)'}</label><div class="sc-m" style="margin-top:8px;line-height:1.5">This network blocks ${POL.flags.sexual ? 'sexual content, ' : ''}${POL.flags.violence ? 'graphic violence and threats, ' : ''}and anything that sexualises children. Report a post from its menu and moderators will review it.</div></div>
  <div class="sc-box"><h4>${ic('slash', 17)}Muted accounts</h4>${mu.length ? mu.map(a => `<div class="sc-user">${avatar(a, 32)}<div class="sc-who"><b>${esc(nameOf(a))}</b></div><button class="sc-btn sm ghost" data-act="unmute" data-v="${a}">Unmute</button></div>`).join('') : '<div class="sc-m">You have not muted anyone. Muting is private and stays on this device.</div>'}</div>`;
}
function center(): string {
  if (!POL.on) return `<div class="sc-head">LUMA Social</div><div class="sc-empty">LUMA Social is closed by the network operator for now. Please check back later.</div>`;
  const v = S.view, back = `<button class="sc-ib" data-act="back" title="Back">${ic('back')}</button>`;
  if (v.k === 'home') {
    const fl = S.tab === 'following' ? topLevel(p => p.a === me() || (IX.follows.get(me()) || new Set()).has(p.a)).sort((a, b) => b.t - a.t) : topLevel(() => true).sort((a, b) => score(b.p) - score(a.p) || b.t - a.t);
    return `<div class="sc-head">Home</div>${dashStrip()}<div class="sc-tabs"><button class="${S.tab === 'foryou' ? 'on' : ''}" data-act="tab" data-v="foryou">For you</button><button class="${S.tab === 'following' ? 'on' : ''}" data-act="tab" data-v="following">Following</button></div>${composer({ quote: S.quote || undefined })}${feedList(fl.slice(0, S.shown), fl.length > S.shown, S.tab === 'following' ? 'Follow people and their posts will show up here.' : undefined)}`;
  }
  if (v.k === 'explore') {
    const all = topLevel(() => true), tipped = (p: Post) => totals(IX.tipsRef.get(p.id) || []).length ? (IX.tipsRef.get(p.id) || []).length : 0;
    const list = S.xtab === 'new' ? all.sort((a, b) => b.t - a.t) : S.xtab === 'tipped' ? all.filter(x => tipped(x.p)).sort((a, b) => tipped(b.p) - tipped(a.p) || b.t - a.t) : all.sort((a, b) => score(b.p) - score(a.p));
    return `<div class="sc-head">Explore</div><div class="sc-box" style="margin:10px 0"><input class="sc-in" id="sc-q2" placeholder="Search posts, #tags, $tokens, @people" value="${esc(S.q)}" style="margin:0"></div><div class="sc-tabs">${([['hot', 'Trending'], ['new', 'Latest'], ['tipped', 'Tipped']] as const).map(([x, l]) => `<button class="${S.xtab === x ? 'on' : ''}" data-act="xtab" data-v="${x}">${l}</button>`).join('')}</div>${feedList(list.slice(0, S.shown), list.length > S.shown, S.xtab === 'tipped' ? 'Posts that people tip show up here.' : undefined)}`;
  }
  if (v.k === 'notif') { const n = notifications(); return `<div class="sc-head">Notifications</div>${n.length ? n.map(x => `<div class="sc-nrow"><span class="sc-nic" style="color:${x.col}">${ic(x.ic, 18)}</span><div class="sc-body"><div>${x.html}</div><div class="sc-m">${ago(x.t)} ago</div></div></div>`).join('') : '<div class="sc-empty">Likes, replies, follows, mentions, reactions and tips show up here.</div>'}`; }
  if (v.k === 'compare') return compareView();
  if (v.k === 'top') { if (!TOPC[TOPD]) void topLoad(); return topView(); }
  if (v.k === 'settings') return need0() ? settingsView() : '<div class="sc-empty">Open a LUMA wallet to see settings.</div>';
  if (v.k === 'bm') { const b = bookmarks().map(i => IX.posts.get(i)).filter(Boolean) as Post[]; return `<div class="sc-head">Bookmarks<span class="sc-sub">saved on this device</span></div>${b.length ? b.map(p => postCard(p)).join('') : '<div class="sc-empty">Choose Save from a post menu to keep it here.</div>'}`; }
  if (v.k === 'market') return `<div class="sc-head">Marketplace</div>${marketView()}`;
  if (v.k === 'stats') return `<div class="sc-head">${back}Network stats</div>${statsView()}`;
  if (v.k === 'listing') return `<div class="sc-head">${back}Listing</div>${listingView(v.id)}`;
  if (v.k === 'editprof') return `<div class="sc-head">${back}Edit profile</div>${editHtml()}`;
  if (v.k === 'dash') return `<div class="sc-head">Creator dashboard</div>${dashView()}`;
  if (v.k === 'profile') return `<div class="sc-head">${back}${esc(nameOf(v.a))}</div>${profileView(v.a, v.tab || 'posts')}`;
  if (v.k === 'thread') return `<div class="sc-head">${back}Post</div>${threadView(v.id)}`;
  if (v.k === 'tag') {
    const isC = v.tag[0] === '$', l = topLevel(p => (isC ? cashIn(p.x) : tagsIn(p.x)).includes(v.tag)).sort((a, b) => b.t - a.t);
    const tl = isC ? IX.tipsAll.filter(t => '$' + tokName(t.c).toLowerCase() === v.tag) : [];
    return `<div class="sc-head">${back}<span class="${isC ? 'sc-cash' : ''}">${isC ? esc(v.tag.toUpperCase()) : '#' + esc(v.tag)}</span></div>${isC ? `<div style="margin:10px 0">${priceCard(v.tag)}</div>` : ''}${isC ? `<div class="sc-box" style="margin:10px 0"><div class="sc-m">${tl.length ? `${totalStr(tl)} tipped on LUMA Social in ${tl.length} tip${tl.length === 1 ? '' : 's'}.` : 'Posts that mention this token. Tip it on any post.'}</div></div>` : ''}${feedList(l.slice(0, S.shown), l.length > S.shown, 'No posts yet.')}`;
  }
  return `<div class="sc-head">${back}Search</div>${searchView(v.q)}`;
}

export function shell() { return `<div id="sc-root"><style>${CSS}${CSS2}${CSS3}${PP.CSS}</style><div class="sc" id="sc"></div></div>`; }
function resolvePend() { if (!S.pend) return; for (const k of IX.posts.keys()) { if (String(k).toUpperCase().startsWith(S.pend)) { S.view = { k: 'thread', id: String(k).toUpperCase() } as any; S.pend = ''; break; } } }
let EDP = false;
function paint() {
  resolvePend();
  const root = document.getElementById('sc'); if (!root) return;
  if (S.view.k !== 'editprof') EDP = false; else if (EDP && root.querySelector('.sc-editpg')) return; // never repaint the profile editor under someone who is typing
  if (ctx.xrpl()) { root.innerHTML = `<div class="sc-box" style="grid-column:1/-1">LUMA Social runs on the LUMA chain. Switch the wallet type to LUMA to use it.</div>`; return; }
  const keep = document.activeElement as HTMLElement | null, kid = keep && keep.id, ss = (keep as any)?.selectionStart;
  const un = unread(), v = S.view, on = (x: string) => (v.k === x ? 'on' : ''); if (v.k === 'editprof') EDP = true;
  const nb = (id: string, icon: string, label: string, extra = '', cls = '') => `<button class="${cls}" data-act="nav" data-v="${id}" aria-label="${label}">${ic(icon, 21)}<span class="t">${label}</span>${extra}</button>`;
  root.innerHTML = `<div class="sc-rail"><div class="sc-brand">${LOGO}<span>LUMA Social<small>on-chain, owned by you</small></span></div>${miniProfile()}<div class="sc-nav">${nb('home', 'home', 'Home', '', on('home'))}${nb('explore', 'search', 'Explore', '', on('explore') || on('search') || on('tag'))}${nb('notif', 'bell', 'Notifications', un ? `<span class="sc-badge">${un > 99 ? '99+' : un}</span>` : '', on('notif'))}${nb('top', 'zap', 'Top posts', '', on('top'))}${nb('bm', 'bm', 'Bookmarks', '', on('bm'))}${nb('settings', 'more', 'Settings', '', on('settings'))}${nb('market', 'shop', 'Marketplace', '', on('market') || on('listing'))}${nb('dash', 'chart', 'Creator', '', on('dash'))}${nb('me', 'user', 'Profile', '', v.k === 'profile' && v.a === me() ? 'on' : '')}${nb('compose', 'pen', 'Post', '', 'sc-big')}</div></div>
  <div class="sc-col">${POL.banner ? `<div class="sc-note">${esc(POL.banner)}</div>` : ''}${S.hubErr ? `<div class="sc-warn">${esc(S.hubErr)}</div>` : ''}${S.err ? `<div class="sc-warn">${esc(S.err)}</div>` : ''}${center()}</div>${sidebar()}`;
  const ta = document.getElementById('sc-txt') as HTMLTextAreaElement | null; if (ta) grow(ta); void fillNft(); { const st = SET(); root.style.fontSize = st.fs + '%'; root.classList.toggle('sc-compact', st.compact); } vwObserve(); PP.restore();
  if (kid) { const el = document.getElementById(kid) as HTMLInputElement | null; if (el) { el.focus(); try { if (ss != null) el.setSelectionRange(ss, ss); } catch {} } }
}
const grow = (t: HTMLTextAreaElement) => { t.style.height = 'auto'; t.style.height = Math.min(360, Math.max(64, t.scrollHeight)) + 'px'; };


// ---------- NFTs: use them as pictures and share the ones you own ----------
interface Nft { id: string; uri: string; issuer: string; serial: number }
const NFTS = new Map<string, { at: number; list: Nft[] }>(), NM: Record<string, { name: string; img: string }> = LS.get('sc.nftm2', {}), askOwner = new Set<string>();
async function loadNfts(a: string, force = false): Promise<Nft[]> {
  const c = NFTS.get(a); if (c && !force && Date.now() - c.at < 120000) return c.list;
  const list: Nft[] = []; try { let marker: any; for (let i = 0; i < 4; i++) { const r = await ctx.req('account_nfts', { account: a, limit: 100, ...(marker ? { marker } : {}) }); for (const n of r.account_nfts || []) list.push({ id: String(n.NFTokenID).toUpperCase(), uri: fromHex(n.URI || ''), issuer: n.Issuer || '', serial: n.nft_serial || 0 }); marker = r.marker; if (!marker) break; } } catch {}
  NFTS.set(a, { at: Date.now(), list }); return list;
}
const gw = (u: string) => { u = String(u || '').trim(); if (/^ipfs:\/\//.test(u)) return 'https://ipfs.io/ipfs/' + u.slice(7).replace(/^ipfs\//, ''); return /^https:\/\/[^\s"'<>\\]{4,400}$/.test(u) ? u : ''; };
const nodeGws = (): string[] => {
  const out: string[] = [], add = (u: string) => { u = String(u || '').trim(); if (/^https?:\/\//.test(u)) { u = u.replace(/\/+$/, '') + '/'; if (!out.includes(u)) out.push(u); } };
  try { add(JSON.parse(localStorage.getItem('starsky.ipfs.' + ctx.netKey()) || '{}').gw); } catch {}
  try { add(String(ctx.nodeUrl() || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '') + '/ipfs'); } catch {}
  try { const c = (window as any).STARSKY_CONFIG || {}, u = String((c[net()] || c.main || {}).url || ''); if (/^wss?:\/\//.test(u)) add(u.replace(/^ws/, 'http').replace(/\/+$/, '') + '/ipfs'); } catch {}
  return out;
};
const GWS = (): string[] => nodeGws().concat(['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://w3s.link/ipfs/']);
const pubGw = (): string => nodeGws().find(g => g.startsWith('https://')) || 'https://ipfs.io/ipfs/';
const MAXIMG = 5 * 1024 * 1024;
let UP = false;
const TOUCH = typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 0 && /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent));
/** one picker for pictures and videos. The input is created here (not inside the page) so a repaint while the phone's picker is open cannot lose the choice. */
function pickMedia() {
  if (!need()) return; const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*,video/*'; i.style.display = 'none'; document.body.appendChild(i); PICKING = Date.now();
  const done = () => { PICKING = 0; setTimeout(() => i.remove(), 1000); };
  i.onchange = async () => {
    const f = i.files && i.files[0]; if (!f) { done(); return; }
    UP = true; paint();
    try { const u = await uploadFiles([f], 1, true); if (u[0]) { S.media = u[0]; S.nft = null as any; ctx.toast(CAM.isVideoUrl(u[0]) ? 'Video added. Write something and press Post.' : 'Picture added. Write something and press Post.'); } }
    catch (e: any) { ctx.toast(String(e?.message || e), true); }
    UP = false; done(); paint();
  };
  i.addEventListener('cancel', done); i.click();
}
function sc_cam(kind: string) {
  if (!need()) return;
  CAM.openCamera(async f => {
    const u = await uploadFiles([f], 1, kind === 'post'); if (!u[0]) return;
    if (kind === 'post') { S.media = u[0]; S.nft = null as any; paint(); ctx.toast(CAM.isVideoUrl(u[0]) ? 'Video added. Write something and press Post.' : 'Photo added. Write something and press Post.'); }
    else if (kind === 'mk') { ED = { ...collectListing(), __mk: 1, eid: (ED && ED.eid) || '' }; const mm: string[] = ED.m || []; if (mm.length < 4) mm.push(u[0]); ED.m = mm; void listModal(ED.eid); }
    else { const i = document.getElementById(kind === 'avatar' ? 'pf-i' : 'pf-k') as HTMLInputElement | null; if (i) { i.value = u[0]; i.dispatchEvent(new Event('input')); } }
  }, (m, b) => ctx.toast(m, b));
}
async function uploadFiles(files: FileList | File[], max: number, allowVid = false): Promise<string[]> {
  const out: string[] = [], list = Array.from(files).slice(0, max);
  for (let f of list) {
    if (/^video\//i.test(f.type) || /\.(mp4|webm|mov|m4v)$/i.test(f.name)) {
      if (!allowVid) { ctx.toast('Videos can only be added to posts.', true); continue; }
      try { ctx.toast('Checking video…'); const g = await CAM.prepareVideo(f, m => ctx.toast(m)); ctx.toast('Uploading video…'); const c = await ipfsAdd(g, g.name), ext = /mp4/.test(g.type) || /\.(mp4|mov|m4v)$/i.test(g.name) ? 'mp4' : 'webm'; out.push(pubGw() + c + '?filename=clip.' + ext); } catch (e: any) { ctx.toast(String(e?.message || e), true); }
      continue;
    }
    if (!/^image\//i.test(f.type)) { ctx.toast(`${f.name}: choose a picture.`, true); continue; }
    if (f.size > MAXIMG || !/^image\/(png|jpe?g|gif|webp)$/i.test(f.type)) { try { ctx.toast(`Shrinking ${f.name} to fit 5 MB…`); const g = !/^image\/(png|jpe?g|gif|webp)$/i.test(f.type) ? await CAM.compressImage(f, 0, undefined).catch(() => f) : await CAM.compressImage(f, MAXIMG * 0.94); if (g.size > MAXIMG) throw new Error('Could not shrink that picture under 5 MB.'); f = g; } catch (e: any) { ctx.toast(String(e?.message || e), true); continue; } }
    try { ctx.toast('Uploading ' + f.name + '…'); out.push('ipfs://' + await ipfsAdd(f, f.name)); } catch (e: any) { ctx.toast(String(e?.message || e), true); break; }
  }
  return out;
}
const ipfsPath = (u: string): string => { u = String(u || '').trim(); if (/^ipfs:\/\//.test(u)) return u.slice(7).replace(/^ipfs\//, ''); const m = u.match(/^https:\/\/[^/]+\/ipfs\/(.+)$/); return m ? m[1] : ''; };
async function fetchT(u: string, ms = 7000): Promise<Response | null> { try { const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms); const r = await fetch(u, { signal: ctl.signal }); clearTimeout(to); return r.ok ? r : null; } catch { return null; } }
async function nftMeta(n: Nft): Promise<{ name: string; img: string }> {
  if (NM[n.id]) return NM[n.id];
  const out = { name: '', img: '' }, path = ipfsPath(n.uri), plain = gw(n.uri), list = path ? GWS().map(g => g + path) : plain ? [plain] : [];
  for (const u of list) {
    const r = await fetchT(u); if (!r) continue; const g = path ? u.slice(0, u.length - path.length) : '', ct = r.headers.get('content-type') || '';
    if (/^image\//.test(ct)) { out.img = u; break; }
    try { const t = await r.text(); if (t.trim()[0] === '{') { const j = JSON.parse(t), im = String(j.image || j.image_url || j.imageUri || ''), ip = ipfsPath(im); out.name = clip(j.name || '', 60); out.img = ip && g ? g + ip : gw(im); if (out.img) break; } } catch {}
  }
  if (!out.img && plain && /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(plain)) out.img = plain;
  if (out.img) { NM[n.id] = out; const k = Object.keys(NM); if (k.length > 150) delete NM[k[0]]; LS.set('sc.nftm2', NM); }
  return out;
}
const nftFind = (id: string): Nft | undefined => { for (const v of NFTS.values()) { const n = v.list.find(x => x.id === id); if (n) return n; } return undefined; };
async function fillNft() {
  const els = Array.from(document.querySelectorAll('[data-nft]')).slice(0, 40) as HTMLElement[];
  for (const el of els) { const n = nftFind(el.dataset.nft || ''); if (!n) continue; const m = await nftMeta(n); if (!el.isConnected) continue; const im = el.querySelector('img') as HTMLImageElement | null, nm = el.querySelector('.nm'); if (m.img && im && !im.src) im.src = m.img; if (nm) nm.textContent = m.name || 'NFT #' + n.serial; }
}
let rpt: any = 0;
function nftBadge(p: Post): string {
  const c = NFTS.get(p.a); if (!c && !askOwner.has(p.a)) { askOwner.add(p.a); void loadNfts(p.a).then(() => { clearTimeout(rpt); rpt = setTimeout(paint, 500); }); }
  const ok = c ? c.list.some(n => n.id === p.n) : undefined;
  return `<div class="sc-nftb">${ic('gem', 14)}<b>NFT</b><span class="${ok ? 'ok' : ''}">${ok === undefined ? 'checking owner…' : ok ? 'verified: ' + esc(nameOf(p.a)) + ' owns it' : 'owner not verified'}</span></div>`;
}
let PICK = 'post', ED: any = {};
function nftGrid(list: Nft[], pick: boolean, mine: boolean) {
  if (!list.length) return `<div class="sc-empty">${pick ? 'This wallet holds no NFTs yet.' : 'No NFTs here.'}</div>`;
  return `<div class="sc-nftg">${list.slice(0, 60).map(n => `<div class="sc-nftc" data-nft="${n.id}"><img alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'"><div class="nm">NFT #${n.serial}</div>${pick ? `<button class="sc-btn sm" onclick="sc.nftPick('${n.id}')">Use this</button>` : mine ? `<button class="sc-btn sm" data-act="nftshare" data-v="${n.id}">Share</button>` : ''}</div>`).join('')}</div>`;
}
async function openNfts(purpose: string) {
  if (!need()) return; PICK = purpose; const what = purpose === 'avatar' ? 'profile photo' : purpose === 'banner' ? 'cover picture' : 'post';
  ctx.modal(mcard(`<div class="k">Choose an NFT for your ${what}</div><div class="muted" style="margin:6px 0 10px">Your NFTs, read live from your wallet. Only NFTs you hold are shown.</div><div class="sc-m">Reading your wallet…</div>`, 520));
  const list = await loadNfts(me(), true);
  ctx.modal(mcard(`<div class="k">Choose an NFT for your ${what}</div><div class="muted" style="margin:6px 0 10px">Your NFTs, read live from your wallet.${POL.imageMode !== 'any' ? ' This network only shows pictures from approved sources such as IPFS, so some NFTs may not display.' : ''}</div>${nftGrid(list, true, true)}<div class="sc-row" style="justify-content:flex-end;margin-top:10px"><button class="sc-btn ghost" onclick="sc.close()">Cancel</button></div>`, 520));
  void fillNft();
}
async function nftPick(id: string) {
  const n = nftFind(id); if (!n) return; const m = await nftMeta(n);
  if (!m.img) { ctx.toast('This NFT has no picture that can be shown here.', true); return; }
  if (!okImg(m.img)) { ctx.toast('This network does not allow pictures from that source.', true); return; }
  ctx.closeModal();
  if (PICK === 'post') { S.nft = { id, img: m.img, name: m.name || 'NFT #' + n.serial }; S.media = m.img; paint(); }
  else if (PICK === 'mk') { const mm: string[] = ED.m || []; const sh = m.img.replace(/^https:\/\/ipfs\.io\/ipfs\//, 'ipfs://'); if (mm.length < 4) mm.push(sh); ED.m = mm; listModal(); }
  else { ED[PICK === 'avatar' ? 'i' : 'k'] = m.img; editModal(); }
}

// ---------- marketplace ----------
interface Lst { id: string; a: string; t: number; ti: string; ds: string; pr: number; c: string; i: string; cat: string; cd: string; lc: string; m: string[]; q: number; st: string; ed: number }
interface Sale { th: string; by: string; to: string; ref: string; n: number; q: number; t: number; ok: boolean }
interface MKI { l: Map<string, Lst>; ofr: Map<string, Array<{ by: string; pr: number; x: string; t: number; h: string }>>; ask: Map<string, Array<{ h: string; by: string; x: string; t: number; an?: string; at?: number }>>; rev: Map<string, Array<{ by: string; s: number; x: string; t: number }>>; sales: Map<string, Sale[]>; order: string[] }
const CATS = ['Electronics', 'Vehicles', 'Home', 'Fashion', 'Collectibles', 'Art & NFTs', 'Services', 'Tools', 'Sports', 'Toys', 'Books', 'Other'], CONDS = ['New', 'Like new', 'Good', 'Fair', 'For parts'];
const mkBlank = (): MKI => ({ l: new Map(), ofr: new Map(), ask: new Map(), rev: new Map(), sales: new Map(), order: [] });
let MK: MKI = mkBlank();
const MK_S: { q: string; cat: string; sort: string; view: string; img: number } = { q: '', cat: '', sort: 'new', view: 'all', img: 0 };
const mkSaveKey = () => 'sc.mksave.' + net();
const MKBAD = /\b(firearms?|guns?|ammo|ammunition|explosives?|cocaine|heroin|meth|fentanyl|counterfeit|stolen|fake ids?|escorts?|porn|nudes?)\b/i;
const mkHidden = (l: Lst) => POL.hidden.has(l.id) || POL.banned.has(l.a) || !!violates(l.ti + ' ' + l.ds) || MKBAD.test(l.ti + ' ' + l.ds);
function mkEvent(mk: MKI, e: Ev, d: any, ref: string) {
  switch (d.t) {
    case 'lst': { const ti = clip(d.ti, 60), pr = Number(d.pr); if (!ti || !(pr >= 0) || !isFinite(pr) || mk.l.has(e.h)) break; mk.l.set(e.h, { id: e.h, a: e.a, t: e.t, ti, ds: clip(d.ds, 300), pr, c: clip(d.c, 40) || 'LUMA', i: isAddr(d.i) ? d.i : '', cat: CATS.includes(d.cat) ? d.cat : 'Other', cd: CONDS.includes(d.cd) ? d.cd : '', lc: clip(d.lc, 40), m: Array.isArray(d.m) ? d.m.map(safeUrl).filter(Boolean).slice(0, 4) : [], q: Math.max(1, Math.min(999, Math.floor(Number(d.q) || 1))), st: 'active', ed: 0 }); mk.order.push(e.h); break; }
    case 'lup': { const l = ref ? mk.l.get(ref) : undefined; if (!l || l.a !== e.a || l.st === 'del') break; if (d.st === 'del' || d.st === 'sold' || d.st === 'active') l.st = d.st; if (d.pr != null && Number(d.pr) >= 0 && isFinite(Number(d.pr))) l.pr = Number(d.pr); if (d.ti) l.ti = clip(d.ti, 60) || l.ti; if (typeof d.ds === 'string') l.ds = clip(d.ds, 300); if (d.q) l.q = Math.max(1, Math.min(999, Math.floor(Number(d.q) || 1))); l.ed = e.t; break; }
    case 'ofr': if (ref) listOf(mk.ofr as any, ref).push({ by: e.a, pr: Math.max(0, Number(d.pr) || 0), x: clip(d.x, 100), t: e.t, h: e.h }); break;
    case 'ask': if (ref) listOf(mk.ask as any, ref).push({ h: e.h, by: e.a, x: clip(d.x, 140), t: e.t }); break;
    case 'ans': { const l = mk.l.get(ref), q = (mk.ask.get(ref) || []).find(x => x.h === (isHash(d.q) ? d.q.toUpperCase() : '')); if (q && l && l.a === e.a) { q.an = clip(d.x, 140); q.at = e.t; } break; }
    case 'rev': { const s = Math.floor(Number(d.s)); if (ref && s >= 1 && s <= 5 && !(mk.rev.get(ref) || []).some(r => r.by === e.a)) listOf(mk.rev as any, ref).push({ by: e.a, s, x: clip(d.x, 100), t: e.t }); break; }
  }
}
const left = (l: Lst) => l.q - (MK.sales.get(l.id) || []).filter(x => x.ok).reduce((n, x) => n + x.q, 0);
const isSold = (l: Lst) => l.st === 'sold' || left(l) <= 0;
const priceStr = (l: Lst) => (l.pr === 0 ? 'Free' : fmt(l.pr, 6) + ' ' + tokName(l.c));
const revsFor = (id: string) => (MK.rev.get(id) || []).filter(r => (MK.sales.get(id) || []).some(x => x.ok && x.by === r.by));
const rating = (a: string) => { let t = 0, n = 0; for (const l of MK.l.values()) if (l.a === a) for (const r of revsFor(l.id)) { t += r.s; n++; } return { n, avg: n ? t / n : 0 }; };
const soldBy = (a: string) => { let n = 0; for (const v of MK.sales.values()) for (const x of v) if (x.ok && x.to === a) n += x.q; return n; };
const stars = (n: number) => '★★★★★'.slice(0, Math.round(n)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n));
function lcard(l: Lst): string {
  const img = l.m.find(okImg), sold = isSold(l), sv = (LS.get(mkSaveKey(), []) as string[]).includes(l.id);
  return `<div class="mk-c" data-act="lopen" data-v="${l.id}"><div class="mk-i">${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : ic('shop', 34)}${sold ? '<span class="mk-s">Sold</span>' : lbadges(l)}<button class="mk-sv ${sv ? 'on' : ''}" data-act="lsave" data-v="${l.id}" title="Save" aria-label="Save">${ic('bm', 16)}</button></div><div class="mk-p">${esc(priceStr(l))}</div><div class="mk-t">${esc(l.ti)}</div><div class="sc-m">${esc(l.lc)}${l.lc ? ' · ' : ''}${ago(l.t)} ago</div>${lcardX(l)}</div>`;
}
const visible = () => Array.from(MK.l.values()).filter(l => l.st !== 'del' && !mkHidden(l));
const shopGrid = (a: string) => { const l = visible().filter(x => x.a === a).sort((x, y) => y.t - x.t); return l.length ? `<div class="mk-g">${l.map(lcard).join('')}</div>` : '<div class="sc-empty">Nothing for sale.</div>'; };
// ---------- marketplace plus: filters, sorts, compare, alerts, sharing to the feed ----------
interface MKFs { min: string; max: string; maxUsd: string; tok: string; cond: string; loc: string; ver: boolean; hideSold: boolean; free: boolean; photos: boolean; offers: boolean; within: number; tag: string; layout: string; open: boolean }
const MKF0: MKFs = { min: '', max: '', maxUsd: '', tok: '', cond: '', loc: '', ver: false, hideSold: false, free: false, photos: false, offers: false, within: 0, tag: '', layout: 'grid', open: false };
let MKFS: MKFs = { ...MKF0, ...(LS.get('sc.mkf', {}) || {}) };
const mkfSave = () => LS.set('sc.mkf', MKFS);
const listUsd = (l: Lst, q = 1): number | null => { const p = pxFor(tokName(l.c)); return p && p.p.usd ? l.pr * q * p.p.usd : null; };
const usdStr = (n: number | null) => (n == null ? '' : n < 0.01 ? '< $0.01' : '≈ $' + n.toLocaleString('en', { maximumFractionDigits: n < 10 ? 2 : 0 }));
const tagsOf = (l: Lst): string[] => Array.from(new Set((l.ds.match(/#[A-Za-z0-9_]{2,24}/g) || []).map(x => x.toLowerCase())));
const offN = (id: string) => (MK.ofr.get(id) || []).length;
const vwN = (id: string) => VW[id] || 0;
const lstList = (key: string): string[] => LS.get(key, []) || [];
const CMPK = () => 'sc.cmp.' + net(), RECK = () => 'sc.mkrec.' + net(), ALK = () => 'sc.mkal.' + net(), SSK = () => 'sc.mkss.' + net();
function mkApply(l: Lst[]): Lst[] {
  const f = MKFS, mn = parseFloat(f.min), mx = parseFloat(f.max), mu = parseFloat(f.maxUsd), loc = f.loc.trim().toLowerCase(), since = f.within ? Date.now() / 1000 - f.within * 86400 : 0;
  return l.filter(x => !(f.hideSold && isSold(x)) && !(f.free && x.pr !== 0) && !(f.photos && !x.m.some(okImg)) && !(f.offers && !offN(x.id)) && !(f.ver && !POL.verified.has(x.a)) && !(f.tok && tokKey(x.c, x.i) !== f.tok) && !(f.cond && x.cd !== f.cond) && !(loc && !x.lc.toLowerCase().includes(loc)) && !(since && x.t < since) && !(f.tag && !tagsOf(x).includes(f.tag)) && !(mn >= 0 && x.pr < mn) && !(mx >= 0 && x.pr > mx) && !(mu >= 0 && (listUsd(x) ?? 0) > mu && listUsd(x) != null));
}
function mkSort(l: Lst[]): Lst[] {
  const s = MK_S.sort, cmp: Record<string, (a: Lst, b: Lst) => number> = { new: (a, b) => b.t - a.t, old: (a, b) => a.t - b.t, low: (a, b) => a.pr - b.pr, high: (a, b) => b.pr - a.pr, az: (a, b) => a.ti.localeCompare(b.ti), views: (a, b) => vwN(b.id) - vwN(a.id) || b.t - a.t, rated: (a, b) => rating(b.a).avg - rating(a.a).avg || b.t - a.t, offers: (a, b) => offN(b.id) - offN(a.id) || b.t - a.t };
  return l.sort((a, b) => (Number(isSold(a)) - Number(isSold(b))) || (cmp[s] || cmp.new)(a, b));
}
function mkFilterPanel(l: Lst[]): string {
  const f = MKFS, toks = Array.from(new Map(visible().map(x => [tokKey(x.c, x.i), tokName(x.c)])).entries()), ss: any[] = LS.get(SSK(), []);
  const chk = (k: string, lbl: string) => `<label class="mk-ck"><input type="checkbox" data-mkx="${k}" ${(f as any)[k] ? 'checked' : ''}>${lbl}</label>`;
  const n = (k: string, ph: string) => `<input class="sc-in" data-mkx="${k}" type="number" min="0" step="any" placeholder="${ph}" value="${esc((f as any)[k])}" style="margin:0;width:100px">`;
  const active = [f.min, f.max, f.maxUsd, f.tok, f.cond, f.loc, f.tag].filter(Boolean).length + [f.ver, f.hideSold, f.free, f.photos, f.offers].filter(Boolean).length + (f.within ? 1 : 0);
  return `<div class="sc-row" style="justify-content:space-between;margin:6px 0"><button class="sc-btn sm ghost" data-act="mkx" data-k="open" data-v="${f.open ? '' : '1'}">Filters${active ? ' (' + active + ')' : ''}</button><div class="sc-row" style="gap:6px"><span class="sc-m">${l.length} item${l.length === 1 ? '' : 's'}</span><button class="sc-ib ${f.layout === 'grid' ? 'on' : ''}" data-act="mkx" data-k="layout" data-v="grid" title="Grid">${ic('list', 17)}</button><button class="sc-ib ${f.layout === 'list' ? 'on' : ''}" data-act="mkx" data-k="layout" data-v="list" title="List">${ic('menu' as any, 17)}</button></div></div>
  ${f.open ? `<div class="sc-box" style="margin:6px 0"><div class="sc-row" style="gap:8px;flex-wrap:wrap">${n('min', 'Min price')}${n('max', 'Max price')}${n('maxUsd', 'Max USD')}<select class="sc-in" data-mkx="tok" style="width:auto;margin:0"><option value="">Any token</option>${toks.map(([k, nm]) => `<option value="${esc(k)}" ${f.tok === k ? 'selected' : ''}>${esc(nm)}</option>`).join('')}</select><select class="sc-in" data-mkx="cond" style="width:auto;margin:0"><option value="">Any condition</option>${CONDS.map(c => `<option ${f.cond === c ? 'selected' : ''}>${c}</option>`).join('')}</select><select class="sc-in" data-mkx="within" style="width:auto;margin:0">${[[0, 'Any time'], [1, 'Last 24 hours'], [7, 'Last 7 days'], [30, 'Last 30 days']].map(([d, lb]) => `<option value="${d}" ${f.within === d ? 'selected' : ''}>${lb}</option>`).join('')}</select><input class="sc-in" data-mkx="loc" placeholder="Location" value="${esc(f.loc)}" style="margin:0;width:140px"></div>
  <div class="sc-row" style="gap:12px;flex-wrap:wrap;margin-top:8px">${chk('ver', 'Verified sellers')}${chk('hideSold', 'Hide sold')}${chk('free', 'Free only')}${chk('photos', 'With photos')}${chk('offers', 'Has offers')}</div>
  ${f.tag ? `<div class="mk-tg" style="margin-top:8px">Tag <b>${esc(f.tag)}</b> <button class="sc-ib" data-act="mkx" data-k="tag" data-v="" aria-label="Remove tag">${ic('x', 14)}</button></div>` : ''}
  <div class="sc-row" style="gap:6px;margin-top:10px;flex-wrap:wrap"><button class="sc-btn sm ghost" data-act="mkclear">Clear filters</button><button class="sc-btn sm" data-act="mkss">Save this search</button>${ss.map((x, i) => `<span class="mk-tg"><a class="sc-l" data-act="mkssuse" data-v="${i}">${esc(x.n)}</a><button class="sc-ib" data-act="mkssdel" data-v="${i}" aria-label="Delete">${ic('x', 13)}</button></span>`).join('')}</div></div>` : ''}`;
}
function mkRecent(): string { const r = lstList(RECK()).map(i => MK.l.get(i)).filter((x): x is Lst => !!x && x.st !== 'del' && !mkHidden(x)).slice(0, 8); return r.length ? `<div class="sc-m" style="padding:4px 12px">Recently viewed</div><div class="mk-rv">${r.map(x => `<div class="mk-c" data-act="lopen" data-v="${x.id}" style="width:120px;flex:none"><div class="mk-i" style="aspect-ratio:1">${x.m.find(okImg) ? `<img src="${esc(x.m.find(okImg)!)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : ic('shop', 26)}</div><div class="mk-t" style="font-size:.78rem">${esc(x.ti)}</div></div>`).join('')}</div>` : ''; }
function lcardX(l: Lst): string {
  const u = usdStr(listUsd(l)), rt = rating(l.a), cmp = lstList(CMPK()).includes(l.id);
  return `<div class="sc-m" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:.76rem">${u ? `<span>${u}</span>` : ''}${rt.n ? `<span>★ ${rt.avg.toFixed(1)}</span>` : ''}${vwN(l.id) ? `<span>${ic('eye', 12)} ${k(vwN(l.id))}</span>` : ''}${offN(l.id) ? `<span>${offN(l.id)} offer${offN(l.id) === 1 ? '' : 's'}</span>` : ''}${POL.verified.has(l.a) ? '<span style="color:#f5b73b">Verified seller</span>' : ''}</div><label class="mk-ck" data-act="noop" style="margin-top:4px;font-size:.76rem"><input type="checkbox" data-act="lcmp" data-v="${l.id}" ${cmp ? 'checked' : ''}>Compare</label>`;
}
function lbadges(l: Lst): string { const n = Date.now() / 1000 - l.t < 86400, few = l.q > 1 && left(l) > 0 && left(l) <= 3, fr = l.pr === 0; return `${n ? '<span class="mk-bd">New</span>' : ''}${few ? `<span class="mk-bd" style="top:30px;background:#f59e0b">${left(l)} left</span>` : ''}${fr ? '<span class="mk-bd" style="right:8px;left:auto;background:#10b981">Free</span>' : ''}`; }
function listingEmbed(x: string): string { const m = String(x || '').match(/(?:\/l\/|[?&]social=l:)([0-9A-Fa-f]{64})/); if (!m) return ''; const l = MK.l.get(m[1].toUpperCase()); if (!l || l.st === 'del' || mkHidden(l)) return ''; const im = l.m.find(okImg); return `<div class="mk-emb" data-act="lopen" data-v="${l.id}">${im ? `<img src="${esc(im)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : `<span class="mk-ei">${ic('shop', 28)}</span>`}<div class="mk-eb"><div class="mk-t">${esc(l.ti)}</div><div class="mk-p">${esc(priceStr(l))} <span class="sc-m">${usdStr(listUsd(l))}</span></div><div class="sc-m">${esc(nameOf(l.a))}${l.lc ? ' · ' + esc(l.lc) : ''}${isSold(l) ? ' · Sold' : ''}</div></div></div>`; }
function shareToFeed(id: string) { const l = MK.l.get(id); if (!l) return; S.draft = `${l.ti}\n${priceStr(l)}${l.lc ? ' · ' + l.lc : ''}${tagsOf(l).slice(0, 3).map(x => ' ' + x).join('')}\n${linkFor('l', id)}`; const im = l.m.find(okImg); S.media = im && /^(https:|ipfs:)/.test(im) ? im : ''; S.nft = null; LS.set(draftKey(), S.draft); go({ k: 'home' }); setTimeout(() => (document.getElementById('sc-txt') as HTMLElement | null)?.focus(), 30); ctx.toast('Review the post, then press Post to share this item in the feed.'); }
function listingTools(l: Lst, id: string): string {
  const mine = l.a === me(), qty = 1, u = listUsd(l, qty), cmp = lstList(CMPK()).includes(id), al: Record<string, number> = LS.get(ALK(), {}) || {}, tg = tagsOf(l);
  return `<div class="sc-row" style="gap:6px;flex-wrap:wrap;margin:4px 0 10px"><button class="sc-btn sm ghost" data-act="lfeed" data-v="${id}">${ic('share', 14)}Share to feed</button>${typeof navigator !== 'undefined' && (navigator as any).share ? `<button class="sc-btn sm ghost" data-act="lnative" data-v="${id}">Share…</button>` : ''}<button class="sc-btn sm ghost" data-act="lcmpb" data-v="${id}">${cmp ? 'In compare' : 'Compare'}</button>${!mine && l.pr > 0 ? `<button class="sc-btn sm ghost" data-act="lalert" data-v="${id}">${al[id] ? 'Alert at ' + fmt(al[id], 4) : 'Price alert'}</button>` : ''}${!mine ? `<button class="sc-btn sm ghost" data-act="follow" data-v="${l.a}">${iFollow(l.a) ? 'Following seller' : 'Follow seller'}</button>` : `<button class="sc-btn sm ghost" data-act="ldup" data-v="${id}">Duplicate</button>`}</div>
  <div class="sc-m" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:6px">${u ? `<span>${usdStr(u)}</span>` : ''}<span>${ic('eye', 13)} ${vwN(id)} account${vwN(id) === 1 ? '' : 's'} viewed</span><span>${offN(id)} offer${offN(id) === 1 ? '' : 's'}</span><span>Listed ${esc(full(l.t))}</span></div>${tg.length ? `<div class="sc-row" style="gap:6px;flex-wrap:wrap;margin-bottom:6px">${tg.map(x => `<a class="mk-tg sc-l" data-act="mktag" data-v="${esc(x)}">${esc(x)}</a>`).join('')}</div>` : ''}`;
}
function listingMore(l: Lst, id: string): string {
  const rel = visible().filter(x => x.id !== id && !isSold(x) && (x.cat === l.cat) && x.a !== l.a).sort((a, b) => b.t - a.t).slice(0, 6), mo = visible().filter(x => x.id !== id && x.a === l.a && !isSold(x)).sort((a, b) => b.t - a.t).slice(0, 6);
  const row = (h: string, a: Lst[]) => a.length ? `<div class="sc-sec">${h}</div><div class="mk-g" style="padding:6px 0">${a.map(lcard).join('')}</div>` : '';
  return row('More from this seller', mo) + row('Similar items', rel);
}
function compareView(): string {
  const back = `<button class="sc-ib" data-act="back" title="Back">${ic('back')}</button>`, ids = lstList(CMPK()), ls = ids.map(i => MK.l.get(i)).filter((x): x is Lst => !!x && x.st !== 'del');
  if (!ls.length) return `<div class="sc-head">${back}Compare</div><div class="sc-empty">Tick Compare on up to 3 items to see them side by side.</div>`;
  const rw = (n: string, f: (x: Lst) => string) => `<tr><th style="text-align:left;padding:6px 8px;color:var(--mut);font-weight:600">${n}</th>${ls.map(x => `<td style="padding:6px 8px;vertical-align:top">${f(x)}</td>`).join('')}</tr>`;
  return `<div class="sc-head">${back}Compare<span class="sc-sub">${ls.length} item${ls.length === 1 ? '' : 's'}</span></div><div style="overflow-x:auto;padding:10px"><table style="border-collapse:collapse;min-width:100%;font-size:.9rem">${rw('', x => `<div class="mk-c" data-act="lopen" data-v="${x.id}"><div class="mk-i">${x.m.find(okImg) ? `<img src="${esc(x.m.find(okImg)!)}" alt="" referrerpolicy="no-referrer">` : ic('shop', 30)}</div></div><button class="sc-btn sm ghost" data-act="lcmp2" data-v="${x.id}" style="margin-top:4px">Remove</button>`)}${rw('Item', x => `<b>${esc(x.ti)}</b>`)}${rw('Price', x => `<b>${esc(priceStr(x))}</b> <span class="sc-m">${usdStr(listUsd(x))}</span>`)}${rw('Condition', x => esc(x.cd || '—'))}${rw('Category', x => esc(x.cat))}${rw('Location', x => esc(x.lc || '—'))}${rw('Available', x => isSold(x) ? 'Sold' : String(left(x)))}${rw('Seller', x => esc(nameOf(x.a)) + (POL.verified.has(x.a) ? ' ✔' : ''))}${rw('Rating', x => { const r = rating(x.a); return r.n ? stars(r.avg) + ' (' + r.n + ')' : '—'; })}${rw('Offers', x => String(offN(x.id)))}${rw('Views', x => String(vwN(x.id)))}${rw('Listed', x => ago(x.t) + ' ago')}</table></div>`;
}
function sellerPanel(): string {
  const a = me(), mine = visible().filter(x => x.a === a), all = Array.from(MK.l.values()).filter(x => x.a === a && x.st !== 'del'), sales = all.flatMap(x => (MK.sales.get(x.id) || []).filter(s => s.ok).map(s => ({ s, x }))), earn = new Map<string, number>();
  for (const { s, x } of sales) earn.set(tokName(x.c), (earn.get(tokName(x.c)) || 0) + s.n);
  const views = all.reduce((n, x) => n + vwN(x.id), 0), offs = all.reduce((n, x) => n + offN(x.id), 0), tile = (v: string | number, l: string) => `<div class="sc-box" style="text-align:center;margin:0;padding:8px"><div style="font-weight:800;font-size:1.1rem">${v}</div><div class="sc-m">${l}</div></div>`;
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;padding:6px 10px">${tile(mine.filter(x => !isSold(x)).length, 'Active')}${tile(sales.reduce((n, y) => n + y.s.q, 0), 'Sold')}${tile(views, 'Views')}${tile(offs, 'Offers')}${tile(Array.from(earn.entries()).map(([k2, v]) => fmt(v, 4) + ' ' + k2).join(', ') || '—', 'Earned')}</div><div class="sc-row" style="gap:6px;padding:0 10px 8px"><button class="sc-btn sm ghost" data-act="mkcsv">Export my listings (CSV)</button></div>`;
}
function boughtList(): Lst[] { const a = me(), ids = new Set<string>(); for (const [id, v] of MK.sales) if (v.some(s => s.ok && s.by === a)) ids.add(id); return Array.from(ids).map(i => MK.l.get(i)).filter((x): x is Lst => !!x); }
function mkCsv() { const a = me(), rows = [['title', 'price', 'token', 'category', 'condition', 'location', 'quantity', 'left', 'status', 'views', 'offers', 'listed', 'link']]; for (const l of MK.l.values()) if (l.a === a && l.st !== 'del') rows.push([l.ti, String(l.pr), tokName(l.c), l.cat, l.cd, l.lc, String(l.q), String(left(l)), isSold(l) ? 'sold' : 'active', String(vwN(l.id)), String(offN(l.id)), new Date(l.t * 1000).toISOString(), linkFor('l', l.id)]); const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n'), b = new Blob([csv], { type: 'text/csv' }), u = URL.createObjectURL(b), x = document.createElement('a'); x.href = u; x.download = 'my-luma-listings.csv'; x.click(); setTimeout(() => URL.revokeObjectURL(u), 3000); }
function mkAlerts() { const al: Record<string, number> = LS.get(ALK(), {}) || {}, done: string[] = LS.get('sc.mkald.' + net(), []) || []; let ch = false; for (const id of Object.keys(al)) { const l = MK.l.get(id); if (l && l.st !== 'del' && !isSold(l) && l.pr <= al[id] && !done.includes(id + '@' + l.pr)) { ctx.toast(`Price alert: ${l.ti} is now ${priceStr(l)}`); done.push(id + '@' + l.pr); ch = true; } } if (ch) LS.set('sc.mkald.' + net(), done.slice(-200)); }
function mkSeen(id: string) { const r = lstList(RECK()).filter(x => x !== id); r.unshift(id); LS.set(RECK(), r.slice(0, 20)); const l = MK.l.get(id); if (l && me() && l.a !== me() && !vwSeen.has(id)) { vwSeen.add(id); vwQ.add(id); if (!vwTimer) vwTimer = setTimeout(vwFlush, 2000); } void vwLoad([id]); }
function marketView(): string {
  const saved = LS.get(mkSaveKey(), []) as string[], q = MK_S.q.trim().toLowerCase();
  let l = visible();
  if (MK_S.view === 'mine') l = l.filter(x => x.a === me()); else if (MK_S.view === 'saved') l = l.filter(x => saved.includes(x.id));
  if (MK_S.cat) l = l.filter(x => x.cat === MK_S.cat);
  if (MK_S.view === 'bought') l = boughtList();
  if (q) l = l.filter(x => (x.ti + ' ' + x.ds + ' ' + x.lc + ' ' + x.cat).toLowerCase().includes(q));
  l = mkSort(mkApply(l)); mkAlerts(); void vwLoad(l.slice(0, 60).map(x => x.id));
  const seg = (v: string, t: string) => `<button class="${MK_S.view === v ? 'on' : ''}" data-act="mkview" data-v="${v}">${t}</button>`;
  return `<div class="mk-top"><div class="sc-row" style="flex-wrap:nowrap"><input class="sc-in" id="mk-q" placeholder="Search the marketplace" value="${esc(MK_S.q)}" oninput="sc.mkf('q',this.value)" style="margin:0"><button class="sc-btn" data-act="sell">${ic('pen', 16)}Sell</button></div>
  <div class="mk-cats"><button class="${MK_S.cat ? '' : 'on'}" data-act="mkcat" data-v="">All</button>${CATS.map(c => `<button class="${MK_S.cat === c ? 'on' : ''}" data-act="mkcat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>
  <div class="sc-row" style="justify-content:space-between"><div class="sc-tabs" style="border:0;flex:none;min-width:240px">${seg('all', 'Browse')}${seg('saved', 'Saved')}${seg('mine', 'Your listings')}${seg('bought', 'Bought')}${lstList(CMPK()).length ? '<button data-act="nav" data-v="compare">Compare (' + lstList(CMPK()).length + ')</button>' : ''}</div><select class="sc-in" style="width:auto;margin:0" onchange="sc.mkf('sort',this.value)"><option value="new" ${MK_S.sort === 'new' ? 'selected' : ''}>Newest</option><option value="low" ${MK_S.sort === 'low' ? 'selected' : ''}>Price: low to high</option><option value="high" ${MK_S.sort === 'high' ? 'selected' : ''}>Price: high to low</option>${[['old', 'Oldest'], ['az', 'A to Z'], ['views', 'Most viewed'], ['rated', 'Top rated sellers'], ['offers', 'Most offers']].map(([v2, n2]) => `<option value="${v2}" ${MK_S.sort === v2 ? 'selected' : ''}>${n2}</option>`).join('')}</select></div>${MK_S.view === 'mine' ? sellerPanel() : ''}${mkFilterPanel(l)}${MK_S.view === 'all' && !q && !MK_S.cat ? mkRecent() : ''}</div>
  ${l.length ? `<div class="mk-g ${MKFS.layout === 'list' ? 'mk-l' : ''}">${l.slice(0, S.shown).map(lcard).join('')}</div>${l.length > S.shown ? '<div style="text-align:center;padding:14px"><button class="sc-btn ghost" data-act="more">Show more</button></div>' : ''}` : `<div class="sc-empty">${MK_S.view === 'mine' ? 'You have not listed anything yet.' : MK_S.view === 'saved' ? 'Nothing saved yet.' : 'No listings match. Be the first to sell something.'}<div style="margin-top:12px"><button class="sc-btn" data-act="sell">Create a listing</button></div></div>`}`;
}
let LISTSEEN = '';
function listingView(id: string): string {
  const l = MK.l.get(id); if (!l || l.st === 'del' || mkHidden(l)) return `<div class="sc-empty">This listing is not available.</div>`;
  if (LISTSEEN !== id) { LISTSEEN = id; setTimeout(() => mkSeen(id), 0); }
  const mine = l.a === me(), sold = isSold(l), imgs = l.m.filter(okImg), sel = Math.min(MK_S.img, Math.max(0, imgs.length - 1));
  const offers = (MK.ofr.get(id) || []).slice().sort((a, b) => b.t - a.t), asks = (MK.ask.get(id) || []).slice().sort((a, b) => a.t - b.t), revs = revsFor(id), rt = rating(l.a);
  const got = (MK.sales.get(id) || []).filter(x => x.ok), myBuy = got.some(x => x.by === me()), myRev = revs.some(r => r.by === me()), sv = (LS.get(mkSaveKey(), []) as string[]).includes(id);
  return `<div class="mk-gal" ${imgs.length ? `data-act="lbox" data-v="${sel}" style="cursor:zoom-in"` : ''}>${imgs.length ? `<img src="${esc(imgs[sel])}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ic('shop', 56)}${sold ? '<span class="mk-s">Sold</span>' : ''}</div>
  ${imgs.length > 1 ? `<div class="sc-row" style="margin:8px 0">${imgs.map((u, i) => `<button class="mk-th ${i === sel ? 'on' : ''}" data-act="limg" data-v="${i}"><img src="${esc(u)}" alt="" referrerpolicy="no-referrer"></button>`).join('')}</div>` : ''}
  <div style="padding:6px 10px"><div class="mk-pp">${esc(priceStr(l))}</div><h2 class="mk-h">${esc(l.ti)}</h2><div class="sc-m">Listed ${ago(l.t)} ago${l.lc ? ' in ' + esc(l.lc) : ''} · ${left(l) > 0 ? left(l) + ' available' : 'none left'}</div>
  <div class="sc-row" style="margin:10px 0">${!mine && !sold && l.pr > 0 ? `<button class="sc-btn gold" data-act="lbuy" data-v="${id}">${ic('coin', 16)}Buy now</button>` : ''}${!mine && !sold ? `<button class="sc-btn" data-act="loffer" data-v="${id}">Make an offer</button>` : ''}${!mine ? `<button class="sc-btn ghost" data-act="lask" data-v="${id}">Ask a question</button>` : ''}<button class="sc-btn ghost" data-act="lsave" data-v="${id}">${ic('bm', 15)}${sv ? 'Saved' : 'Save'}</button><button class="sc-ib" data-act="lshare" data-v="${id}" title="Copy link">${ic('share')}</button>${!mine ? `<button class="sc-ib" data-act="lrep" data-v="${id}" title="Report">${ic('flag')}</button>` : ''}</div>
  ${listingTools(l, id)}
  ${mine ? `<div class="sc-box" style="margin:8px 0"><div class="sc-m" style="margin-bottom:8px">Your listing</div><div class="sc-row"><button class="sc-btn sm" data-act="ledit" data-v="${id}">Edit</button>${l.st === 'sold' ? `<button class="sc-btn sm ghost" data-act="lset" data-v="${id}" data-s="active">Mark available</button>` : `<button class="sc-btn sm ghost" data-act="lset" data-v="${id}" data-s="sold">Mark as sold</button>`}<button class="sc-btn sm ghost" data-act="lset" data-v="${id}" data-s="del">Remove</button></div></div>` : ''}
  <div class="sc-box" style="margin:10px 0"><h4>Details</h4><div class="mk-d"><span>Category</span><b>${esc(l.cat)}</b>${l.cd ? `<span>Condition</span><b>${esc(l.cd)}</b>` : ''}<span>Price in</span><b>${esc(tokName(l.c))}</b></div>${l.ds ? `<div class="sc-txt" style="margin-top:10px">${rich(l.ds)}</div>` : ''}</div>
  <div class="sc-box sc-user" style="cursor:pointer" data-act="user" data-v="${l.a}">${avatar(l.a, 46)}<div class="sc-who"><b>${esc(nameOf(l.a))}${badge(l.a)}</b><span class="sc-m">${rt.n ? stars(rt.avg) + ' ' + rt.avg.toFixed(1) + ' (' + rt.n + ') · ' : ''}${soldBy(l.a)} sold</span></div><span class="sc-m">View shop</span></div>
  ${got.length ? `<div class="sc-m" style="margin:10px 0">${got.reduce((n, x) => n + x.q, 0)} sold, paid on the chain and verified.</div>` : ''}
  <div class="sc-sec">Questions (${asks.length})</div>${asks.length ? asks.map(q => `<div class="mk-q"><div><b data-act="user" data-v="${q.by}" style="cursor:pointer">${esc(nameOf(q.by))}</b> <span class="sc-m">${ago(q.t)} ago</span></div><div>${esc(q.x)}</div>${q.an ? `<div class="mk-a"><b>${esc(nameOf(l.a))}</b> ${esc(q.an)}</div>` : mine ? `<button class="sc-btn sm ghost" data-act="lans" data-v="${id}" data-q="${q.h}">Answer</button>` : ''}</div>`).join('') : '<div class="sc-m">No questions yet.</div>'}
  <div class="sc-sec">Offers (${offers.length})</div>${offers.length ? offers.slice(0, 20).map(o => `<div class="mk-q"><div><b data-act="user" data-v="${o.by}" style="cursor:pointer">${esc(nameOf(o.by))}</b> offered <b style="color:#fcd34d">${fmt(o.pr, 6)} ${esc(tokName(l.c))}</b> <span class="sc-m">${ago(o.t)} ago</span></div>${o.x ? `<div class="sc-m">${esc(o.x)}</div>` : ''}${mine && !sold && o.pr > 0 ? `<button class="sc-btn sm ghost" data-act="lset" data-v="${id}" data-s="price" data-p="${o.pr}">Set my price to this</button>` : ''}</div>`).join('') : '<div class="sc-m">No offers yet. Offers are public.</div>'}
  <div class="sc-sec">Reviews (${revs.length})</div>${revs.length ? revs.map(r => `<div class="mk-q"><div>${stars(r.s)} <b>${esc(nameOf(r.by))}</b> <span class="sc-m">${ago(r.t)} ago</span></div>${r.x ? `<div>${esc(r.x)}</div>` : ''}</div>`).join('') : '<div class="sc-m">Verified buyers can leave a review.</div>'}${myBuy && !myRev ? `<div style="margin-top:8px"><button class="sc-btn" data-act="lrev" data-v="${id}">Review this seller</button></div>` : ''}${listingMore(l, id)}</div>`;
}
// listing form
function collectListing(): any { const g = (i: string) => fv(i).trim(), m: string[] = []; for (let i = 0; i < 4; i++) { const u = g('mk-m' + i); if (u) m.push(u); } return { ti: g('mk-ti'), ds: g('mk-ds'), pr: g('mk-pr'), tk: fv('mk-tk'), cat: fv('mk-cat'), cd: fv('mk-cd'), lc: g('mk-lc'), q: g('mk-q2') || '1', m }; }
async function listModal(editId = '', fresh = false) {
  if (fresh) ED = {};
  if (!ED.__mk) { const l = editId ? MK.l.get(editId) : undefined; ED = { __mk: 1, eid: editId, ...(l ? { ti: l.ti, ds: l.ds, pr: String(l.pr), tk: l.c + '|' + l.i, cat: l.cat, cd: l.cd, lc: l.lc, q: String(l.q), m: l.m.map(u => u.replace(/^https:\/\/ipfs\.io\/ipfs\//, 'ipfs://')) } : {}) }; }
  ctx.page(`<div class="sc-m" style="padding:12px 0">Reading your wallet…</div>`, ED.eid ? 'Edit listing' : 'Create a listing');
  const opts = await loadHold(me()).catch(() => [{ c: 'LUMA', i: '', name: 'LUMA', bal: 0, ok: true }] as TipOpt[]), e = ED, ms: string[] = e.m || [];
  const O = (i: string, label: string, v: string, max: number, ph = '') => `<label class="sc-fl">${label}<input class="sc-in" id="${i}" maxlength="${max}" value="${esc(v || '')}" placeholder="${esc(ph)}"></label>`;
  ctx.page(`<div class="k" style="font-size:1.1em">${e.eid ? 'Edit listing' : 'Create a listing'}</div><div class="muted" style="margin:4px 0 8px">${e.eid ? COST.lup : COST.lst} LUMA to publish. Buyers pay you directly, with no middleman. Offers and questions are public.</div>
  ${O('mk-ti', 'Title', e.ti, 60, 'What are you selling?')}
  <div class="sc-row"><label class="sc-fl" style="flex:1">Price<input class="sc-in" id="mk-pr" type="number" min="0" step="any" value="${esc(e.pr || '')}" placeholder="0 for free"></label><label class="sc-fl" style="flex:1">Paid in<select class="sc-in" id="mk-tk">${opts.map(o => `<option value="${esc(o.c + '|' + o.i)}" ${(e.tk || 'LUMA|') === o.c + '|' + o.i ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label><label class="sc-fl" style="width:90px">Quantity<input class="sc-in" id="mk-q2" type="number" min="1" max="999" value="${esc(e.q || '1')}"></label></div>
  <div class="sc-row"><label class="sc-fl" style="flex:1">Category<select class="sc-in" id="mk-cat">${CATS.map(c => `<option ${e.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label><label class="sc-fl" style="flex:1">Condition<select class="sc-in" id="mk-cd"><option value="">Not applicable</option>${CONDS.map(c => `<option ${e.cd === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label></div>
  ${O('mk-lc', 'Location', e.lc, 40, 'City or "Ships worldwide"')}
  <label class="sc-fl">Description<textarea class="sc-in" id="mk-ds" maxlength="300" rows="4" placeholder="Condition, size, what is included, how to receive it">${esc(e.ds || '')}</textarea></label>
  <div class="sc-sec">Photos (up to 4, 5 MB each)</div>${[0, 1, 2, 3].map(i => `<input class="sc-in" id="mk-m${i}" value="${esc(ms[i] || '')}" placeholder="Photo ${i + 1}: https:// or ipfs://">`).join('')}
  <div class="sc-row" style="margin-top:6px"><button class="sc-btn sm" onclick="document.getElementById('mk-file').click()">${ic('up', 15)}Upload from your computer</button><input type="file" id="mk-file" accept="image/*" multiple hidden onchange="sc.upload(this,'mk')"><button class="sc-btn sm" onclick="sc.cam('mk')">${ic('image', 15)}Take a photo</button><button class="sc-btn sm ghost" onclick="sc.lpick()">${ic('gem', 15)}Add a photo from your NFTs</button></div>
  <div class="sc-row" style="margin-top:14px;justify-content:flex-end"><button class="sc-btn ghost" onclick="sc.close()">Cancel</button><button class="sc-btn" onclick="sc.lsubmit()">${e.eid ? 'Save changes' : 'Publish listing'}</button></div>`, e.eid ? 'Edit listing' : 'Create a listing');
}
async function listSubmit() {
  const v = collectListing(), eid = (ED && ED.eid) || '', pr = Number(v.pr || 0), [c, i] = (v.tk || 'LUMA|').split('|'), txt = v.ti + ' ' + v.ds + ' ' + v.lc;
  if (!v.ti) { ctx.toast('Add a title.', true); return; } if (!(pr >= 0) || !isFinite(pr) || v.pr === '') { ctx.toast('Enter a price. Use 0 for free.', true); return; }
  const bp = violates(txt); if (bp) { ctx.toast(`Not published: it contains ${WHY[bp]}, which is not allowed here.`, true); return; }
  if (MKBAD.test(txt)) { ctx.toast('Not published: weapons, drugs, counterfeit or stolen goods and adult services are not allowed.', true); return; }
  for (const u of v.m) { if (!safeUrl(u)) { ctx.toast('Photos must start with https:// or ipfs://', true); return; } if (!okImg(safeUrl(u))) { ctx.toast('Pictures from that link are not allowed on this network. Use an NFT or an approved source.', true); return; } }
  const d: any = eid ? { t: 'lup', ref: eid, ti: v.ti, ds: v.ds, pr, q: Math.max(1, Math.floor(Number(v.q) || 1)) } : { t: 'lst', ti: v.ti, ds: v.ds, pr, c: c || 'LUMA', i: i || '', cat: v.cat, cd: v.cd, lc: v.lc, m: v.m, q: Math.max(1, Math.floor(Number(v.q) || 1)) };
  if (enc.encode(JSON.stringify({ v: 1, ...d })).length > MAXMEMO - 20) { ctx.toast('This listing is too long for one transaction. Shorten the description or use fewer photos.', true); return; }
  ED = {}; ctx.closeModal(); const h = await act(d, eid ? 'Saving listing…' : 'Publishing…', eid ? 'Listing updated' : 'Listing published');
  if (h && !eid && h !== 'ok') { go({ k: 'listing', id: h.toUpperCase() }); }
}
// buying
let BS: { id: string; qty: number; opt?: TipOpt; load: boolean; err: string; busy: boolean } | null = null;
async function buyModal(id: string) {
  const l = MK.l.get(id); if (!l || isSold(l)) return; if (l.a === me()) { ctx.toast('This is your own listing.', true); return; }
  BS = { id, qty: 1, load: true, err: '', busy: false }; renderBuy();
  try { const o = await loadHold(l.a); if (!BS || BS.id !== id) return; BS.opt = o.find(x => tokKey(x.c, x.i) === tokKey(l.c, l.i)); BS.load = false; if (!BS.opt) BS.err = `You do not hold ${tokName(l.c)}.`; else if (!BS.opt.ok) BS.err = `The seller cannot receive ${tokName(l.c)} yet. Make an offer or ask them to set it up.`; } catch { if (BS) { BS.load = false; BS.err = 'Could not read your wallet.'; } }
  renderBuy();
}
function renderBuy() {
  const b = BS; if (!b) return; const l = MK.l.get(b.id); if (!l) return; const tot = l.pr * b.qty;
  ctx.modal(mcard(`<div class="k">Buy now</div><div class="sc-row" style="margin:10px 0">${avatar(l.a, 40)}<div><b>${esc(l.ti)}</b><div class="sc-m">from ${esc(nameOf(l.a))}</div></div></div>
  <label class="muted">Quantity (${left(l)} available)<input class="sc-in" type="number" min="1" max="${left(l)}" value="${b.qty}" oninput="sc.buyQty(this.value)"></label>
  <div class="mk-pp" style="margin:8px 0">${fmt(tot, 6)} ${esc(tokName(l.c))}</div><div class="sc-m">${b.opt ? 'You hold ' + fmt(b.opt.bal, 6) + ' ' + esc(b.opt.name) + '. ' : ''}Your payment goes straight to the seller's wallet. Arrange delivery with them in the questions. Plus a ${COST.tipn} LUMA fee to record the sale publicly.</div>
  ${b.err ? `<div class="sc-warn" style="margin:8px 0">${esc(b.err)}</div>` : ''}<div class="sc-row" style="justify-content:flex-end;margin-top:10px"><button class="sc-btn ghost" onclick="sc.close()">Cancel</button><button class="sc-btn gold" ${b.load || b.busy || !b.opt || !b.opt.ok || b.qty > left(l) ? 'disabled' : ''} onclick="sc.buySend()">${b.busy ? 'Paying…' : 'Pay ' + fmt(tot, 6) + ' ' + esc(tokName(l.c))}</button></div>`, 420));
}
async function buySend() {
  const b = BS; if (!b || b.busy) return; const l = MK.l.get(b.id), o = b.opt; if (!l || !o) return; const n = l.pr * b.qty;
  if (b.qty > left(l)) { b.err = 'Not enough in stock.'; renderBuy(); return; } if (n > o.bal) { b.err = `You only hold ${fmt(o.bal, 6)} ${o.name}.`; renderBuy(); return; }
  let amount: any; try { amount = amtTx(o.name === 'LUMA' ? { c: 'native', i: '' } : { c: o.c, i: o.i }, n); } catch (e: any) { b.err = String(e?.message || e); renderBuy(); return; }
  b.busy = true; b.err = ''; renderBuy();
  const r = await pay(l.a, amount, { t: 'buy', ref: b.id, q: b.qty }, 'Paying the seller…');
  if (!r.ok || !r.hash) { b.busy = false; b.err = r.msg || 'The payment was not sent.'; renderBuy(); return; }
  const th = r.hash.toUpperCase(), id = b.id, q = b.qty; BS = null; ctx.closeModal(); TV[th] = { by: me(), to: l.a, c: o.name === 'LUMA' ? 'LUMA' : o.c, i: o.i, v: n };
  ctx.toast(`Paid ${fmt(n, 4)} ${o.name} to ${nameOf(l.a)}`, false);
  const d: any = { t: 'tipn', k: 'buy', th, to: l.a, c: o.name === 'LUMA' ? 'LUMA' : o.c, i: o.i, n, ref: id, q }, lr = await pay(hub(), drops(COST.tipn), d, 'Recording the sale…');
  if (lr.ok && lr.hash) { local(d, lr.hash, COST.tipn); saveCache(); setTimeout(() => { void pull().then(paintSoft); }, 5000); } else ctx.toast('Your payment was delivered, but the sale could not be recorded publicly: ' + (lr.msg || 'try again later'), true);
  paint();
}
function offerModal(id: string) { const l = MK.l.get(id); if (!l) return; ctx.modal(mcard(`<div class="k">Make an offer</div><div class="sc-m" style="margin:6px 0">Listed at ${esc(priceStr(l))}. Offers are public. (${COST.ofr} LUMA)</div><label class="muted">Your offer in ${esc(tokName(l.c))}<input class="sc-in" id="mk-op" type="number" min="0" step="any"></label><label class="muted">Message (optional)<input class="sc-in" id="mk-ox" maxlength="100" placeholder="Can pick up today"></label><div class="sc-row" style="justify-content:flex-end;margin-top:10px"><button class="sc-btn ghost" onclick="sc.close()">Cancel</button><button class="sc-btn" onclick="sc.offerSend('${id}')">Send offer</button></div>`, 400)); }
async function offerSend(id: string) { const pr = Number(fv('mk-op')), x = fv('mk-ox').trim(); if (!(pr > 0) || !isFinite(pr)) { ctx.toast('Enter an offer above zero.', true); return; } const bp = violates(x); if (bp) { ctx.toast(`Not sent: it contains ${WHY[bp]}.`, true); return; } ctx.closeModal(); const d: any = { t: 'ofr', ref: id, pr }; if (x) d.x = x; await act(d, 'Sending offer…', 'Offer sent'); }
function askModal(id: string) { ctx.modal(mcard(`<div class="k">Ask the seller</div><div class="sc-m" style="margin:6px 0">Questions and answers are public. Do not share private details. (${COST.ask} LUMA)</div><input class="sc-in" id="mk-ax" maxlength="140" placeholder="Is this still available?"><div class="sc-row" style="justify-content:flex-end;margin-top:10px"><button class="sc-btn ghost" onclick="sc.close()">Cancel</button><button class="sc-btn" onclick="sc.askSend('${id}')">Ask</button></div>`, 400)); }
async function askSend(id: string) { const x = fv('mk-ax').trim(); if (!x) return; const bp = violates(x); if (bp) { ctx.toast(`Not sent: it contains ${WHY[bp]}.`, true); return; } ctx.closeModal(); await act({ t: 'ask', ref: id, x }, 'Asking…', 'Question sent'); }
function ansModal(id: string, q: string) { ctx.modal(mcard(`<div class="k">Answer</div><input class="sc-in" id="mk-nx" maxlength="140" placeholder="Your answer"><div class="sc-row" style="justify-content:flex-end;margin-top:10px"><button class="sc-btn ghost" onclick="sc.close()">Cancel</button><button class="sc-btn" onclick="sc.ansSend('${id}','${q}')">Answer</button></div>`, 400)); }
async function ansSend(id: string, q: string) { const x = fv('mk-nx').trim(); if (!x) return; const bp = violates(x); if (bp) { ctx.toast(`Not sent: it contains ${WHY[bp]}.`, true); return; } ctx.closeModal(); await act({ t: 'ans', ref: id, q, x }, 'Answering…', 'Answer posted'); }
function revModal(id: string) { ctx.modal(mcard(`<div class="k">Review the seller</div><label class="muted">Rating<select class="sc-in" id="mk-rs"><option value="5">★★★★★ Great</option><option value="4">★★★★ Good</option><option value="3">★★★ Okay</option><option value="2">★★ Poor</option><option value="1">★ Bad</option></select></label><input class="sc-in" id="mk-rx" maxlength="100" placeholder="How did it go?"><div class="sc-m" style="margin:6px 0">Only buyers with a verified payment can review. (${COST.rev} LUMA)</div><div class="sc-row" style="justify-content:flex-end"><button class="sc-btn ghost" onclick="sc.close()">Cancel</button><button class="sc-btn" onclick="sc.revSend('${id}')">Post review</button></div>`, 400)); }
async function revSend(id: string) { const s = Number(fv('mk-rs')), x = fv('mk-rx').trim(), bp = violates(x); if (bp) { ctx.toast(`Not sent: it contains ${WHY[bp]}.`, true); return; } ctx.closeModal(); const d: any = { t: 'rev', ref: id, s }; if (x) d.x = x; await act(d, 'Posting review…', 'Review posted'); }

// ---------- growth: check-ins, referrals, reputation, badges, network stats ----------
const refKey = () => 'sc.ref.' + net();
const folEv = (a: string): any => { const d: any = { t: 'fol', a }, r = LS.get(refKey(), ''); if (isAddr(r) && r !== me() && !IX.refBy.has(me())) d.rf = r; return d; };
const today = () => Math.floor(Date.now() / 86400000);
function streak(a: string): number { const c = IX.chk.get(a); if (!c) return 0; let d = c.has(today()) ? today() : today() - 1, n = 0; while (c.has(d)) { n++; d--; } return n; }
const invited = (a: string) => Array.from(IX.refBy.entries()).filter(([, r]) => r === a).length;
function reputation(a: string): number {
  const posts = IX.order.map(i => IX.posts.get(i)!).filter(p => p.a === a && !p.del); let likes = 0; for (const p of posts) likes += likeN(p.id);
  const rt = rating(a); return Math.round((IX.followers.get(a)?.size || 0) * 3 + posts.length + likes + (IX.tipsTo.get(a) || []).length * 3 + soldBy(a) * 6 + streak(a) * 2 + invited(a) * 4 + rt.avg * rt.n * 4);
}
function achievements(a: string): Array<[string, string]> {
  const out: Array<[string, string]> = [], posts = IX.order.map(i => IX.posts.get(i)!).filter(p => p.a === a && !p.del), rt = rating(a);
  let likes = 0; for (const p of posts) likes += likeN(p.id);
  if (posts.length) out.push(['pen', 'Posted']); if (posts.length >= 25) out.push(['pen', '25 posts']); if (likes >= 50) out.push(['heart', '50 likes']);
  if ((IX.followers.get(a)?.size || 0) >= 10) out.push(['user', '10 followers']); if ((IX.tipsTo.get(a) || []).length >= 5) out.push(['coin', 'Tipped 5 times']); if ((IX.tipsBy.get(a) || []).length >= 5) out.push(['coin', 'Generous tipper']);
  if (soldBy(a) >= 1) out.push(['shop', 'Seller']); if (rt.n >= 3 && rt.avg >= 4.5) out.push(['gem', 'Trusted seller']); if (streak(a) >= 7) out.push(['trend', '7 day streak']); if (invited(a) >= 3) out.push(['share', 'Connector']); if (handleOf(a)) out.push(['gem', 'Has a handle']);
  return out;
}
const topBy = (m: Map<string, number>, n = 5) => Array.from(m.entries()).sort((x, y) => y[1] - x[1]).slice(0, n);
function statsView(): string {
  const posts = IX.order.map(i => IX.posts.get(i)!).filter(p => !p.del), users = new Set<string>(); for (const p of posts) users.add(p.a); for (const [a] of IX.prof) users.add(a);
  const vol = new Map<string, number>(); for (const t of IX.tipsAll) { const k = tokName(t.c); vol.set(k, (vol.get(k) || 0) + t.v); }
  const earn = new Map<string, number>(), give = new Map<string, number>(), inv = new Map<string, number>(), sell = new Map<string, number>();
  for (const t of IX.tipsAll) { earn.set(t.to, (earn.get(t.to) || 0) + 1); give.set(t.by, (give.get(t.by) || 0) + 1); } for (const [, r] of IX.refBy) inv.set(r, (inv.get(r) || 0) + 1); for (const v of MK.sales.values()) for (const x of v) if (x.ok) sell.set(x.to, (sell.get(x.to) || 0) + x.q);
  const lst = visible(), nSold = Array.from(sell.values()).reduce((a, b) => a + b, 0), box = (t: string, m: Map<string, number>, u: string) => `<div class="sc-box" style="margin:10px"><h4>${t}</h4>${topBy(m).length ? topBy(m).map(([a, n], i) => `<div class="sc-user"><span class="sc-m" style="width:18px">${i + 1}</span><span data-act="user" data-v="${a}" style="cursor:pointer">${avatar(a, 34)}</span><div class="sc-who"><b data-act="user" data-v="${a}">${esc(nameOf(a))}${badge(a)}</b></div><span class="sc-m">${n} ${u}</span></div>`).join('') : '<div class="sc-m">Nothing yet.</div>'}</div>`;
  const rep = new Map<string, number>(); for (const a of users) rep.set(a, reputation(a));
  const tile = (n: string | number, l: string) => `<div class="sc-box" style="text-align:center;padding:14px 8px"><div style="font-size:1.5rem;font-weight:900">${n}</div><div class="sc-m">${l}</div></div>`;
  return `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:10px">${tile(users.size, 'People')}${tile(posts.length, 'Posts')}${tile(IX.tipsAll.length, 'Verified tips')}${tile(lst.length, 'Listings')}${tile(nSold, 'Items sold')}${tile(Array.from(vol.entries()).slice(0, 1).map(([k, v]) => fmt(v, 2) + ' ' + k).join('') || '0', 'Tipped')}</div>${box('Top reputation', rep, 'rep')}${box('Most tipped creators', earn, 'tips')}${box('Most generous', give, 'tips')}${box('Top inviters', inv, 'invited')}${box('Top sellers', sell, 'sold')}`;
}
function exportMine() {
  const a = me(), data = { exportedAt: new Date().toISOString(), account: a, network: net(), hub: hub(), events: EV.filter(e => e.a === a).map(e => ({ tx: e.h, time: e.t, paid: e.v, data: e.d })), tipsSent: (IX.tipsBy.get(a) || []), tipsReceived: (IX.tipsTo.get(a) || []) };
  const b = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), u = URL.createObjectURL(b), l = document.createElement('a'); l.href = u; l.download = 'luma-social-' + net() + '-export.json'; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); ctx.toast('Your data was exported');
}
// ---------- your dashboard ----------
const DASH_IDS: Array<[string, string]> = [['checkin', 'Check-in and reputation'], ['market', 'Fresh in the marketplace'], ['tokens', 'Trending tokens'], ['topics', 'Trending topics'], ['tipped', 'Most tipped'], ['follow', 'Who to follow']];
const dashKey = () => 'sc.dash.' + net();
function dashCfg(): { order: string[]; off: string[]; strip: boolean } {
  const c = LS.get(dashKey(), {}) as any, ids = DASH_IDS.map(x => x[0]), ord: string[] = (Array.isArray(c.order) ? c.order : []).filter((x: string) => ids.includes(x));
  for (const id of ids) if (!ord.includes(id)) ord.push(id); return { order: ord, off: (Array.isArray(c.off) ? c.off : []).filter((x: string) => ids.includes(x)), strip: c.strip !== false };
}
const saveDash = (c: { order: string[]; off: string[]; strip: boolean }) => LS.set(dashKey(), c);
function miniProfile(): string {
  const a = me(); if (!a) return '';
  const h = handleOf(a), posts = IX.order.filter(i => { const p = IX.posts.get(i)!; return p.a === a && !p.del; }).length;
  return `<div class="sc-mini"><div class="sc-row" style="flex-wrap:nowrap;cursor:pointer" data-act="user" data-v="${a}">${avatar(a, 46)}<div class="sc-who" style="flex-direction:column;align-items:flex-start;gap:0;min-width:0"><b>${esc(nameOf(a))}${badge(a)}</b><span class="sc-m">${h ? '@' + esc(h) : esc(ctx.showL(a).slice(0, 8) + '…')}</span></div></div>
  <div class="sc-mst"><button data-act="flist" data-v="${a}" data-k="following"><b>${fwgN(a)}</b>Following</button><button data-act="flist" data-v="${a}" data-k="followers"><b>${folN(a)}</b>Followers</button><button data-act="user" data-v="${a}"><b>${posts}</b>Posts</button></div></div>`;
}
function dashStrip(): string {
  const a = me(), cfg = dashCfg(); if (!a || !cfg.strip) return '';
  const hr = new Date().getHours(), hi = hr < 5 ? 'Still up' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening', got = IX.tipsTo.get(a) || [], tile = (n: string | number, l: string, act: string, v = '') => `<button class="sc-dt" data-act="${act}" data-v="${v}"><b>${n}</b><span>${l}</span></button>`;
  const first = ((IX.prof.get(a) || {}).n || handleOf(a) || '').split(' ')[0], checked = (IX.chk.get(a) || new Set()).has(today());
  return `<div class="sc-dsh"><div class="sc-row" style="justify-content:space-between;align-items:flex-start"><div><div class="sc-dhi">${hi}${first ? ', ' + esc(first) : ''}</div><div class="sc-m">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div></div><button class="sc-btn sm ghost" data-act="dcust">${ic('pen', 14)}Customize</button></div>
  <div class="sc-dg">${tile(reputation(a), 'Reputation', 'nav', 'stats')}${tile(folN(a), 'Followers', 'flist', a)}${tile(got.length, 'Tips received', 'nav', 'dash')}${tile(streak(a), 'Day streak', checked ? 'nav' : 'chk', checked ? 'dash' : '')}${tile(visible().filter(x => x.a === a).length, 'Listings', 'mkview', 'mine')}${tile(invited(a), 'Invited', 'invite')}</div>
  <div class="sc-row" style="margin-top:10px">${checked ? '' : `<button class="sc-btn sm" data-act="chk">Check in</button>`}<button class="sc-btn sm ghost" data-act="sell">${ic('shop', 14)}Sell something</button><button class="sc-btn sm ghost" data-act="invite">${ic('share', 14)}Invite friends</button><button class="sc-btn sm ghost" data-act="editprof">${ic('pen', 14)}Edit profile</button></div></div>`;
}
function custModal() {
  const c = dashCfg(), nm = (id: string) => (DASH_IDS.find(x => x[0] === id) || ['', id])[1];
  ctx.modal(mcard(`<div class="k">Customize your dashboard</div><div class="muted" style="margin:4px 0 10px">Choose what appears on your home page and in the right-hand panel, and in what order. Saved on this device.</div>
  <label class="sc-row" style="padding:8px 0"><input type="checkbox" ${c.strip ? 'checked' : ''} onchange="sc.dstrip()"><b>Dashboard summary on Home</b></label>
  ${c.order.map((id, i) => `<div class="sc-row" style="padding:7px 0;border-top:1px solid var(--sl)"><label class="sc-row" style="flex:1"><input type="checkbox" ${c.off.includes(id) ? '' : 'checked'} onchange="sc.dtog('${id}')">${esc(nm(id))}</label><button class="sc-ib" ${i ? '' : 'disabled'} onclick="sc.dmove('${id}',-1)" aria-label="Move up">▲</button><button class="sc-ib" ${i < c.order.length - 1 ? '' : 'disabled'} onclick="sc.dmove('${id}',1)" aria-label="Move down">▼</button></div>`).join('')}
  <div class="sc-row" style="justify-content:space-between;margin-top:12px"><button class="sc-btn sm ghost" onclick="sc.dreset()">Reset</button><button class="sc-btn" onclick="sc.close()">Done</button></div>`, 440));
}
// ---------- modals ----------
const need = (): boolean => { const bl = blocked(); if (bl) { ctx.toast(bl, true); return false; } if (!me()) { ctx.toast('Create or open a LUMA wallet first', true); return false; } return true; };
const go = (v: View) => { hist.push(S.view); if (hist.length > 30) hist.shift(); S.view = v; S.shown = 25; S.err = ''; window.scrollTo({ top: 0 }); paint(); };
const mcard = (inner: string, w = 400) => `<div class="card" style="width:min(${w}px,92vw);max-width:94vw;max-height:88vh;overflow-y:auto;overflow-x:hidden;box-sizing:border-box">${inner}</div>`;
const mi = (icon: string, label: string, fn: string, cls = '') => `<button class="sc-mi ${cls}" onclick="${fn}">${ic(icon, 19)}<span>${label}</span></button>`;
const LOCALH = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(location.hostname) || /\.local$/i.test(location.hostname);
const PRETTY = !LOCALH;   // shared links always use the official address, whichever address you opened Starsky from
const SHAREBASE = 'https://www.starsky-luma.org';
const linkFor = (kind: string, id: string) => {
  if (PRETTY) { const o = SHAREBASE, k = ({ post: 'p', u: 'u', tag: 't', ref: 'r', l: 'l' } as any)[kind]; if (k) return o + '/' + k + '/' + encodeURIComponent(kind === 'post' ? id.slice(0, 12).toLowerCase() : id); }
  return location.href.split(/[?#]/)[0] + '?social=' + kind + ':' + encodeURIComponent(id);
};
function postMenu(id: string) {
  const p = IX.posts.get(id); if (!p) return; const mine = p.a === me(), bm = bookmarks().includes(id), pinned = IX.pin.get(me()) === id;
  ctx.modal(mcard(`<div class="k" style="margin-bottom:6px">Post options</div>${mi('link', 'Copy link', `sc.m('copy','${id}')`)}${typeof navigator !== 'undefined' && (navigator as any).share ? mi('share', 'Share…', `sc.m('share','${id}')`) : ''}${mi('share', 'Share to X', `sc.m('sx','${id}')`)}${mi('quote', 'Quote post', `sc.m('quote','${id}')`)}${mi('bm', bm ? 'Remove bookmark' : 'Save to bookmarks', `sc.m('bm','${id}')`)}${mi('zap', 'Boost this post (1 LUMA or more)', `sc.m('boost','${id}')`)}${mi('smile', 'React', `sc.m('react','${id}')`)}${mine ? mi('pen', 'Edit text', `sc.m('edit','${id}')`) + (p.r ? '' : mi(pinned ? 'pinoff' : 'pin', pinned ? 'Unpin from profile' : 'Pin to profile', `sc.m('${pinned ? 'unpin' : 'pin'}','${id}')`)) + mi('trash', 'Delete', `sc.m('del','${id}')`, 'bad') : mi('slash', 'Mute ' + esc(tagOf(p.a)), `sc.m('mute','${p.a}')`, 'bad') + mi('flag', 'Report this post', `sc.m('report','${id}')`, 'bad')}`));
}
function reportModal(id: string) {
  const why: Array<[string, string]> = [['sexual', 'Sexual or explicit content'], ['violence', 'Violence or threats'], ['child', 'Child safety'], ['harass', 'Harassment or hate'], ['scam', 'Scam or spam'], ['other', 'Something else']];
  ctx.modal(mcard(`<div class="k" style="margin-bottom:4px">Report this post</div><div class="muted" style="margin-bottom:8px">Reports go to the network moderators. A post that enough different people report is hidden automatically. (${COST.rep} LUMA)</div>${why.map(w => mi('flag', w[1], `sc.report('${id}','${w[0]}')`)).join('')}`, 360));
}
function reactModal(id: string) {
  const mineRx = (IX.rx.get(id) || new Map()).get(me());
  ctx.modal(mcard(`<div class="k" style="margin-bottom:10px">React (${COST.rx} LUMA)</div><div class="sc-row" style="gap:8px;justify-content:center">${EMOJI.map(e => `<button class="sc-rxc ${mineRx === e ? 'on' : ''}" style="font-size:1.6rem;padding:8px 12px" onclick="sc.rx('${id}','${e}')">${e}</button>`).join('')}</div>${mineRx ? `<div style="text-align:center;margin-top:10px"><button class="sc-btn sm ghost" onclick="sc.rx('${id}','')">Remove my reaction</button></div>` : ''}`, 340));
}
function boostModal(id: string) {
  ctx.modal(mcard(`<div class="k">Boost this post</div><div class="muted" style="margin:6px 0 10px;line-height:1.5">A boost lifts the post in For you and Explore for about a day, and the post shows a Boosted label. The more LUMA, the stronger the lift (counts up to 100 LUMA). It is paid from your connected wallet to the Genesis wallet${genesis() ? ' (' + genesis().slice(0, 6) + '…' + genesis().slice(-4) + ')' : ', or to the network hub until a Genesis address is set in Create token'}, not to the author.</div><div class="sc-row">${[1, 5, 25, 100].map(n => `<button class="sc-btn sm ghost" onclick="document.getElementById('sc-bst').value=${n}">${n}</button>`).join('')}</div><input class="sc-in" id="sc-bst" type="number" min="1" step="any" value="1" style="margin-top:8px"><div class="sc-row" style="margin-top:10px;justify-content:flex-end"><button class="sc-btn ghost" onclick="sc.close()">Cancel</button><button class="sc-btn" onclick="sc.boost('${id}')">${ic('zap', 16)}Boost</button></div>`));
}
function editPostModal(id: string) {
  const p = IX.posts.get(id); if (!p) return;
  ctx.modal(mcard(`<div class="k">Edit post</div><div class="muted" style="margin:6px 0">Saved on the chain for ${COST.edit} LUMA. The post shows “edited”, and the old version stays in the chain history.</div><textarea class="sc-in" id="sc-ed" rows="5" maxlength="${MAXTXT}">${esc(p.x)}</textarea><div class="sc-row" style="margin-top:10px;justify-content:flex-end"><button class="sc-btn ghost" onclick="sc.close()">Cancel</button><button class="sc-btn" onclick="sc.edit('${id}')">Save</button></div>`, 440));
}
function supModal(list: Tip[], title: string) {
  const sorted = list.slice().sort((a, b) => b.t - a.t).slice(0, 40);
  ctx.modal(mcard(`<div class="k">${esc(title)}</div><div class="muted" style="margin:6px 0 8px">${totalStr(list, 5)} in ${list.length} tip${list.length === 1 ? '' : 's'}. Each one is a real payment that anyone can check on the chain.</div>${sorted.map(t => `<div class="sc-user">${avatar(t.by, 34)}<div class="sc-who"><b>${esc(nameOf(t.by))}${badge(t.by)}</b><span class="sc-m">${t.m ? '“' + esc(t.m) + '” · ' : ''}${ago(t.t)} ago</span></div><b style="color:#fcd34d">${fmt(t.v, 4)} ${esc(tokName(t.c))}</b></div>`).join('')}<div class="sc-row" style="justify-content:flex-end;margin-top:8px"><button class="sc-btn ghost" onclick="sc.close()">Close</button></div>`, 400));
}
const SWATCH = ['#6366f1', '#8b5cf6', '#0ea5e9', '#14b8a6', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6'];
const fv = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value || '';
function collectProf(): any { return { n: fv('pf-n').trim(), b: fv('pf-b').trim(), i: fv('pf-i').trim(), k: fv('pf-k').trim(), c: fv('pf-c'), w: fv('pf-w').trim(), l: fv('pf-l').trim(), pr: fv('pf-pr').trim(), jb: fv('pf-jb').trim(), st: fv('pf-st').trim(), sh: fv('pf-sh') === 's' ? 's' : 'c', l1t: fv('pf-l1t').trim(), l1u: fv('pf-l1u').trim(), l2t: fv('pf-l2t').trim(), l2u: fv('pf-l2u').trim() }; }
function profEvent(v: any): any {
  const d: any = { t: 'prof' }; for (const k of ['n', 'b', 'i', 'k', 'c', 'w', 'l', 'pr', 'jb', 'st']) if (v[k]) d[k] = v[k]; if (v.sh === 's') d.sh = 's';
  const ln: any[] = []; for (const x of [['l1t', 'l1u'], ['l2t', 'l2u']]) if (v[x[1]]) ln.push({ t: v[x[0]] || '', u: v[x[1]] }); if (ln.length) d.ln = ln; return d;
}
function prevHtml(v: any): string {
  const a = me(), img = v.i && safeUrl(v.i) && okImg(safeUrl(v.i)), ban = v.k && safeUrl(v.k) && okImg(safeUrl(v.k)), acc = /^#[0-9a-f]{6}$/i.test(v.c || '') ? v.c : '#6366f1', ini = ((v.n || handleOf(a) || '?')[0] || '?').toUpperCase();
  return `<div class="sc-prof" style="margin:0;--pa:${acc}"><div class="sc-ban" style="height:84px;${ban ? `background:#0d1020 url('${esc(safeUrl(v.k))}') center/cover` : `background:linear-gradient(135deg,${acc},#312e81 60%,#0e7490)`}"></div><div class="sc-pinfo" style="padding-bottom:12px"><span class="sc-pav ${v.sh === 's' ? 'sq' : ''}" style="margin-top:-34px"><span class="sc-av" style="width:64px;height:64px;font-size:26px;background:linear-gradient(135deg,hsl(${hue(a)} 70% 48%),hsl(${(hue(a) + 50) % 360} 70% 36%))">${esc(ini)}${img ? `<img src="${esc(safeUrl(v.i))}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span></span><div style="font-weight:900;font-size:1.15em;margin-top:6px">${esc(v.n || nameOf(a))}</div>${v.st ? `<div class="sc-stt">${esc(v.st)}</div>` : ''}${v.b ? `<div class="sc-m" style="margin-top:4px">${esc(v.b)}</div>` : ''}<div class="sc-m" style="margin-top:4px">${[v.jb, v.l, v.pr].filter(Boolean).map(esc).join(' · ')}</div></div></div>`;
}
function editModal() { if (S.view.k !== 'editprof') go({ k: 'editprof' }); else paint(); setTimeout(() => (window as any).sc.prev(), 0); }
function leaveEdit() { ED = {}; const p = hist.pop(); S.view = p && p.k !== 'editprof' ? p : { k: 'profile', a: me() }; }
function editHtml(): string {
  const q: any = IX.prof.get(me()) || {}, h = handleOf(me()), p: any = { ...q, l1t: (q.ln && q.ln[0] && q.ln[0].t) || '', l1u: (q.ln && q.ln[0] && q.ln[0].u) || '', l2t: (q.ln && q.ln[1] && q.ln[1].t) || '', l2u: (q.ln && q.ln[1] && q.ln[1].u) || '', ...(ED.__mk ? {} : ED) };
  const L = (id: string, label: string, val: string, max: number, ph = '') => `<label class="sc-fl">${label}<input class="sc-in" id="${id}" maxlength="${max}" value="${esc(val || '')}" placeholder="${esc(ph)}" oninput="sc.prev()"></label>`;
  return (`<div class="sc-editpg"><div class="k" style="font-size:1.1em">Edit profile</div><div class="muted" style="margin:4px 0 10px">Saved on the chain for ${COST.prof} LUMA and visible to everyone. Everything below is optional.</div>
  <div id="pf-prev">${prevHtml(p)}</div>
  <div class="sc-sec">Pictures</div>
  <label class="sc-fl">Profile photo<div class="sc-row"><input class="sc-in" id="pf-i" value="${esc(p.i || '')}" placeholder="https:// or ipfs://" style="flex:1" oninput="sc.prev()"><button class="sc-btn sm ghost" onclick="sc.cam('avatar')">${ic('image', 15)}Camera</button><button class="sc-btn sm ghost" onclick="sc.pickFor('avatar')">${ic('gem', 15)}Use an NFT</button></div></label>
  <label class="sc-fl">Cover picture<div class="sc-row"><input class="sc-in" id="pf-k" value="${esc(p.k || '')}" placeholder="https:// or ipfs://" style="flex:1" oninput="sc.prev()"><button class="sc-btn sm ghost" onclick="sc.cam('banner')">${ic('image', 15)}Camera</button><button class="sc-btn sm ghost" onclick="sc.pickFor('banner')">${ic('gem', 15)}Use an NFT</button></div></label>
  <div class="sc-row" style="margin:6px 0"><label class="sc-fl" style="flex:1">Photo shape<select class="sc-in" id="pf-sh" onchange="sc.prev()"><option value="c" ${p.sh !== 's' ? 'selected' : ''}>Round</option><option value="s" ${p.sh === 's' ? 'selected' : ''}>Rounded square (best for NFTs)</option></select></label></div>
  <label class="sc-fl">Accent colour<div class="sc-row" style="gap:8px"><input class="sc-in" id="pf-c" type="color" value="${esc(p.c || '#6366f1')}" style="width:54px;height:40px;padding:2px;flex:none" oninput="sc.prev()">${SWATCH.map(c => `<button type="button" class="sc-sw" style="background:${c}" onclick="sc.swatch('${c}')" aria-label="${c}"></button>`).join('')}</div></label>
  <div class="sc-sec">About you</div>
  ${L('pf-n', 'Name', p.n, 40, 'Your name')}${L('pf-st', 'Status', p.st, 50, 'What are you up to?')}
  <label class="sc-fl">Bio<textarea class="sc-in" id="pf-b" maxlength="200" rows="3" placeholder="Tell people who you are. Use #tags, $tokens and @handles." oninput="sc.prev()">${esc(p.b || '')}</textarea></label>
  <div class="sc-row">${L('pf-jb', 'Work', p.jb, 40, 'What you do').replace('class="sc-fl"', 'class="sc-fl" style="flex:1"')}${L('pf-pr', 'Pronouns', p.pr, 30, 'optional').replace('class="sc-fl"', 'class="sc-fl" style="flex:1"')}</div>
  ${L('pf-l', 'Location', p.l, 40, 'City, country')}
  <div class="sc-sec">Links</div>
  ${L('pf-w', 'Website', p.w, 200, 'https://')}
  <div class="sc-row"><label class="sc-fl" style="width:34%">Link 1 label<input class="sc-in" id="pf-l1t" maxlength="20" value="${esc(p.l1t)}" placeholder="Shop" oninput="sc.prev()"></label><label class="sc-fl" style="flex:1">Link 1<input class="sc-in" id="pf-l1u" value="${esc(p.l1u)}" placeholder="https://" oninput="sc.prev()"></label></div>
  <div class="sc-row"><label class="sc-fl" style="width:34%">Link 2 label<input class="sc-in" id="pf-l2t" maxlength="20" value="${esc(p.l2t)}" placeholder="Music" oninput="sc.prev()"></label><label class="sc-fl" style="flex:1">Link 2<input class="sc-in" id="pf-l2u" value="${esc(p.l2u)}" placeholder="https://" oninput="sc.prev()"></label></div>
  <div class="sc-sec">Your @handle</div><div class="muted" style="margin:2px 0 6px">${h ? 'You are @' + esc(h) + '. ' : ''}A handle costs ${COST.hdl} LUMA and adds a check mark. First to claim it keeps it.</div><div class="sc-row"><input class="sc-in" id="pf-h" maxlength="15" placeholder="yourname" style="flex:1" value=""><button class="sc-btn sm" onclick="sc.claim()">Claim</button></div><div class="sc-m" id="pf-hm">3 to 15 letters, numbers or _</div>
  <div class="sc-row" style="margin-top:14px;justify-content:space-between;position:sticky;bottom:-1px;padding:10px 0;background:#0d1020"><span class="sc-m" id="pf-size"></span><div class="sc-row"><button class="sc-btn ghost" onclick="sc.editBack()">Cancel</button><button class="sc-btn" onclick="sc.saveProf()">Save profile</button></div></div></div>`);
}
function keysModal() {
  const r = (a: string, b: string) => `<div class="sc-row" style="justify-content:space-between;padding:5px 0"><span>${b}</span><kbd style="background:rgba(255,255,255,.08);border-radius:6px;padding:2px 8px">${a}</kbd></div>`;
  ctx.modal(mcard(`<div class="k" style="margin-bottom:6px">Keyboard shortcuts</div>${r('n', 'New post')}${r('/', 'Search')}${r('g then h', 'Home')}${r('g then n', 'Notifications')}${r('Ctrl/Cmd + Enter', 'Send the post you are writing')}${r('Esc', 'Close a window')}${r('?', 'Show this list')}<div class="sc-row" style="justify-content:flex-end;margin-top:8px"><button class="sc-btn ghost" onclick="sc.close()">Close</button></div>`, 340));
}

// ---------- tipping: any amount, any token you hold ----------
interface TipOpt { c: string; i: string; name: string; bal: number; ok: boolean }
let TS: { ref: string; to: string; opts: TipOpt[]; sel: number; amt: string; note: string; load: boolean; err: string; busy: boolean } | null = null;
async function allLines(acct: string): Promise<any[]> {
  const out: any[] = []; let marker: any;
  for (let i = 0; i < 6; i++) { const r = await ctx.req('account_lines', { account: acct, ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) }).catch(() => null); if (!r) break; out.push(...(r.lines || [])); marker = r.marker; if (!marker) break; }
  return out;
}
const RATES = new Map<string, { r: number; at: number }>();
/** the issuer's transfer fee as a multiplier (1 = no fee). A holder paying a token that has a fee must allow for it with SendMax, or the payment fails. */
async function rateOf(issuer: string): Promise<number> {
  const c = RATES.get(issuer); if (c && Date.now() - c.at < 300000) return c.r;
  let r = 1; try { const i = await ctx.req('account_info', { account: issuer, ledger_index: 'validated' }); const tr = Number(i?.account_data?.TransferRate || 0); if (tr > 1e9) r = tr / 1e9; } catch { /* assume no fee */ }
  RATES.set(issuer, { r, at: Date.now() }); return r;
}
async function loadHold(to: string): Promise<TipOpt[]> {
  const m = me(), out: TipOpt[] = [];
  const [ai, al, bl] = await Promise.all([ctx.req('account_info', { account: m, ledger_index: 'validated' }).catch(() => null), allLines(m), allLines(to)]);
  const lum = ai && ai.account_data ? Number(ai.account_data.Balance) / 1e6 : 0; out.push({ c: 'LUMA', i: '', name: 'LUMA', bal: lum, ok: true });
  const theirs = new Set(bl.map((l: any) => l.currency + '|' + l.account));
  const mine = al.filter((l: any) => Number(l.balance) > 0), iss = Array.from(new Set(mine.map((l: any) => String(l.account)))).filter(x => x !== m && x !== to).slice(0, 40);
  const rates = new Map<string, number>(); await Promise.all(iss.map(async x => { rates.set(x, await rateOf(x)); }));
  for (const l of mine) { const bal = Number(l.balance), rate = l.account === to ? 1 : rates.get(l.account) || 1; out.push({ c: l.currency, i: l.account, name: hexName(l.currency), bal, rate, ok: l.account === to || theirs.has(l.currency + '|' + l.account) } as any); }
  // the wallet that issued tokens (the Genesis wallet) holds none of its own: it can send as much as it likes, so list what it issued
  try { const gb = await ctx.req('gateway_balances', { account: m, ledger_index: 'validated' }); for (const [cur, v] of Object.entries((gb && gb.obligations) || {})) { const tot = Number(v); if (tot > 0) out.push({ c: cur, i: m, name: hexName(cur), bal: Math.max(tot * 1000, 1e12), rate: 1, ok: theirs.has(cur + '|' + m) } as any); } } catch { /* not an issuer */ }
  return out.sort((a, b) => (a.name === 'LUMA' ? -1 : b.name === 'LUMA' ? 1 : Number(b.ok) - Number(a.ok) || a.name.localeCompare(b.name)));
}
function tipModal(ref: string, to: string) {
  const a = to || (IX.posts.get(ref)?.a || ''); if (!a || !need()) return;
  if (a === me()) { ctx.toast('You cannot tip yourself', true); return; }
  TS = { ref: to ? '' : ref, to: a, opts: [], sel: 0, amt: '1', note: '', load: true, err: '', busy: false }; renderTip();
  void loadHold(a).then(o => { if (!TS || TS.to !== a) return; TS.opts = o; TS.load = false; renderTip(); }).catch(() => { if (TS) { TS.load = false; TS.opts = [{ c: 'LUMA', i: '', name: 'LUMA', bal: 0, ok: true }]; renderTip(); } });
}
const pres = (o: TipOpt) => (o.name === 'LUMA' ? [1, 5, 25, 100].map(n => ({ l: String(n), v: String(n) })) : [0.1, 0.25, 0.5, 1].map(f => ({ l: f === 1 ? 'Max' : f * 100 + '%', v: String(Number((o.bal / ((o as any).rate || 1) * f).toPrecision(6))) })));
function renderTip() {
  const t = TS; if (!t) return; const o = t.opts[t.sel], a = t.to;
  ctx.modal(mcard(`<div class="k">Send a tip</div><div class="sc-row" style="margin:10px 0">${avatar(a, 42)}<div><b>${esc(nameOf(a))}</b>${badge(a)}<div class="sc-m">${esc(tagOf(a))}${t.ref ? ' · for this post' : ''}</div></div></div>
  <div class="muted" style="margin-bottom:8px">Pick any token in your wallet. 100% goes to ${esc(nameOf(a))}, straight to their wallet.</div>
  ${t.load ? '<div class="sc-m" style="padding:14px 0">Reading your wallet…</div>' : `<div class="sc-row" style="gap:6px;max-height:150px;overflow:auto;margin-bottom:6px">${t.opts.map((x, i) => `<button class="sc-chipt ${i === t.sel ? 'on' : ''} ${x.ok ? '' : 'off'}" onclick="sc.tipPick(${i})" title="${x.ok ? 'You hold ' + fmt(x.bal, 6) : esc(nameOf(a)) + ' needs to add this token to their wallet first'}">${esc(x.name)}<small>${x.ok ? fmt(x.bal, 4) : 'not accepted'}</small></button>`).join('')}</div>
  ${o ? `<div class="sc-row" style="margin-top:8px">${pres(o).map(p => `<button class="sc-btn sm ghost" onclick="sc.tipPreset('${p.v}')">${p.l}</button>`).join('')}</div><label class="muted">Amount in ${esc(o.name)}<input class="sc-in" id="sc-tip" type="number" min="0" step="any" value="${esc(t.amt)}" oninput="sc.tipUpd()"></label>` : ''}
  <label class="muted">Message (optional, public)<input class="sc-in" id="sc-tipn" maxlength="60" placeholder="Great post" value="${esc(t.note)}" oninput="sc.tipUpd()"></label>
  <div class="sc-m" style="margin:6px 0">Adds a public tip note on the post for ${COST.tipn} LUMA (plus the network fee).</div>`}
  ${t.err ? `<div class="sc-warn" style="margin:6px 0">${esc(t.err)}</div>` : ''}<div class="sc-row" style="margin-top:10px;justify-content:flex-end"><button class="sc-btn ghost" onclick="sc.close()">Cancel</button><button class="sc-btn gold" ${t.load || t.busy || !o || !o.ok ? 'disabled' : ''} onclick="sc.tipSend()">${t.busy ? 'Sending…' : ic('coin', 16) + 'Send tip'}</button></div>`, 420));
}
async function tipSend() {
  const t = TS; if (!t || t.busy) return; const o = t.opts[t.sel]; if (!o || !o.ok) return; sc.tipUpd();
  const n = Number(t.amt); if (!(n > 0) || !isFinite(n)) { t.err = 'Enter an amount above zero.'; renderTip(); return; }
  const rate: number = (o as any).rate || 1; if (n * rate > o.bal * 1.0000001) { t.err = rate > 1 ? `This token has a ${((rate - 1) * 100).toFixed(2)}% transfer fee, so the most you can send is ${fmt(o.bal / rate, 6)} ${o.name}.` : `You only hold ${fmt(o.bal, 6)} ${o.name}.`; renderTip(); return; }
  let amount: any; try { amount = amtTx(o.name === 'LUMA' ? { c: 'native', i: '' } : { c: o.c, i: o.i }, n); } catch (e: any) { t.err = String(e?.message || e); renderTip(); return; }
  t.busy = true; t.err = ''; renderTip();
  const note = t.note.trim().slice(0, 60), memo: any = { t: 'tip' }; if (t.ref) memo.ref = t.ref; if (note) memo.m = note;
  const sm = rate > 1 && o.name !== 'LUMA' ? { SendMax: { currency: o.c, issuer: o.i, value: String(Number((n * rate * 1.000001).toPrecision(15))) } } : {};
  const r = await pay(t.to, amount, memo, 'Sending tip…', sm);
  if (!r.ok || !r.hash) { t.busy = false; t.err = r.msg || 'The tip was not sent.'; renderTip(); return; }
  const to = t.to, ref = t.ref; TS = null; ctx.closeModal();
  const th = r.hash.toUpperCase(); TV[th] = { by: me(), to, c: o.name === 'LUMA' ? 'LUMA' : o.c, i: o.i, v: n };
  const d: any = { t: 'tipn', th, to, c: o.name === 'LUMA' ? 'LUMA' : o.c, i: o.i, n }; if (ref) d.ref = ref; if (note) d.m = note;
  ctx.toast(`Sent ${fmt(n, 4)} ${o.name} to ${nameOf(to)}`, false);
  const lr = await pay(hub(), drops(COST.tipn), d, 'Listing the tip…');
  if (lr.ok && lr.hash) { local(d, lr.hash, COST.tipn); saveCache(); setTimeout(() => { void pull().then(paintSoft); }, 5000); } else ctx.toast('The tip was delivered, but it could not be added to the public list: ' + (lr.msg || 'try again later'), true);
  paint();
}

// ---------- actions ----------
let MMO = false;
async function onClick(el: HTMLElement, ev: Event) {
  const a = el.dataset.act!, v = el.dataset.v || '';
  if (a === 'mm') { MMO = !MMO; ev.stopPropagation(); paint(); return; }
  if (MMO) { MMO = false; document.querySelector('.sc-mm')?.remove(); }
  ev.stopPropagation();
  switch (a) {
    case 'nav': if (v === 'me') { if (need()) go({ k: 'profile', a: me() }); } else if (v === 'compose') { go({ k: 'home' }); setTimeout(() => (document.getElementById('sc-txt') as HTMLElement | null)?.focus(), 30); } else { go({ k: v } as any); if (v === 'notif') { LS.set(seenKey(), Math.floor(Date.now() / 1000)); paint(); } } break;
    case 'back': { const p = hist.pop(); S.view = p || { k: 'home' }; paint(); break; }
    case 'tab': S.tab = v as any; S.shown = 25; paint(); break;
    case 'xtab': S.xtab = v as any; S.shown = 25; paint(); break;
    case 'more': S.shown += 25; paint(); break;
    case 'open': go({ k: 'thread', id: v }); break;
    case 'user': go({ k: 'profile', a: v }); break;
    case 'handle': { const o = IX.owner.get(v); if (o) go({ k: 'profile', a: o }); else ctx.toast('Nobody has @' + v + ' yet'); break; }
    case 'tag': go({ k: 'tag', tag: v }); break;
    case 'ptab': if (S.view.k === 'profile') { S.view = { ...S.view, tab: v }; S.shown = 25; paint(); } break;
    case 'showmedia': { const i = document.getElementById('sc-media') as HTMLInputElement; i.style.display = ''; i.focus(); break; }
    case 'poll': S.pollOn = !S.pollOn; paint(); break;
    case 'addopt': if (S.poll.length < 4) S.poll.push(''); paint(); break;
    case 'reply': go({ k: 'thread', id: v }); setTimeout(() => (document.getElementById('sc-txt') as HTMLElement | null)?.focus(), 30); break;
    case 'noquote': S.quote = ''; paint(); break;
    case 'reveal': S.rev.add(v); paint(); break;
    case 'chk': if (need() && !S.busy) { if ((IX.chk.get(me()) || new Set()).has(today())) { ctx.toast('Already checked in today'); break; } await act({ t: 'chk' }, 'Checking in…', 'Checked in. Keep your streak going!'); } break;
    case 'invite': { const u = linkFor('ref', me()); try { void navigator.clipboard.writeText(u); ctx.toast('Invite link copied. You earn reputation for each friend who follows through it.'); } catch { ctx.toast(u); } break; }
    case 'export': if (me()) exportMine(); break;
    case 'dcust': custModal(); break;
    case 'mkx': { const kk = el.dataset.k as string; (MKFS as any)[kk] = kk === 'open' ? !!v : v; mkfSave(); paint(); break; }
    case 'mkclear': MKFS = { ...MKF0, open: true, layout: MKFS.layout }; mkfSave(); paint(); break;
    case 'mktag': MKFS.tag = v; MKFS.open = true; mkfSave(); MK_S.view = 'all'; go({ k: 'market' }); break;
    case 'mkss': { const n = (MK_S.q || MK_S.cat || MKFS.tag || 'Search ' + (LS.get(SSK(), []) as any[]).length + 1).slice(0, 20), ss: any[] = LS.get(SSK(), []); ss.unshift({ n, q: MK_S.q, cat: MK_S.cat, sort: MK_S.sort, f: MKFS }); LS.set(SSK(), ss.slice(0, 12)); ctx.toast('Search saved'); paint(); break; }
    case 'mkssuse': { const x = (LS.get(SSK(), []) as any[])[Number(v)]; if (x) { MK_S.q = x.q; MK_S.cat = x.cat; MK_S.sort = x.sort; MKFS = { ...MKF0, ...x.f, open: true }; mkfSave(); paint(); } break; }
    case 'mkssdel': { const ss: any[] = LS.get(SSK(), []); ss.splice(Number(v), 1); LS.set(SSK(), ss); paint(); break; }
    case 'lcmp': case 'lcmpb': case 'lcmp2': { ev.stopPropagation(); const c = lstList(CMPK()), i = c.indexOf(v); if (i >= 0) c.splice(i, 1); else if (a === 'lcmp2') { } else { if (c.length >= 3) { ctx.toast('Compare up to 3 items. Remove one first.', true); if (a === 'lcmp') paint(); break; } c.push(v); } LS.set(CMPK(), c); paint(); break; }
    case 'lfeed': shareToFeed(v); break;
    case 'lnative': { const l = MK.l.get(v); if (l) try { await (navigator as any).share({ title: l.ti, text: l.ti + ' · ' + priceStr(l), url: linkFor('l', v) }); } catch {} break; }
    case 'lalert': { const l = MK.l.get(v); if (!l) break; const al: Record<string, number> = LS.get(ALK(), {}) || {}; if (al[v]) { delete al[v]; LS.set(ALK(), al); ctx.toast('Price alert removed'); paint(); break; } const x = prompt('Alert me when the price drops to or below (' + tokName(l.c) + '):', String(l.pr)); const n = Number(x); if (x && n > 0) { al[v] = n; LS.set(ALK(), al); ctx.toast('Alert set. Starsky checks while it is open.'); paint(); } break; }
    case 'ldup': { const l = MK.l.get(v); if (l && need()) { ED = { __mk: 1, eid: '', ti: l.ti, ds: l.ds, pr: String(l.pr), tk: l.c + '|' + l.i, cat: l.cat, cd: l.cd, lc: l.lc, q: String(l.q), m: l.m.map(u => u.replace(/^https:\/\/ipfs\.io\/ipfs\//, 'ipfs://')) }; void listModal(''); } break; }
    case 'lbox': { const id2 = (S.view as any).id as string, ll = MK.l.get(id2); if (!ll) break; const im = ll.m.filter(okImg); if (!im.length) break; const n = ((Number(v) % im.length) + im.length) % im.length; ctx.modal(`<div style="position:relative;max-width:96vw;max-height:92vh;text-align:center"><img src="${esc(im[n])}" alt="" referrerpolicy="no-referrer" style="max-width:96vw;max-height:84vh;border-radius:12px"><div class="sc-row" style="justify-content:center;gap:10px;margin-top:8px"><button class="sc-btn sm ghost" data-act="lbox" data-v="${n - 1}">Previous</button><span class="sc-m">${n + 1} / ${im.length}</span><button class="sc-btn sm ghost" data-act="lbox" data-v="${n + 1}">Next</button><button class="sc-btn sm" onclick="sc.close()">Close</button></div></div>`); break; }
    case 'mkcsv': mkCsv(); break;
    case 'lopen': MK_S.img = 0; go({ k: 'listing', id: v }); break;
    case 'lsave': { const b: string[] = LS.get(mkSaveKey(), []), i = b.indexOf(v); if (i >= 0) b.splice(i, 1); else b.unshift(v); LS.set(mkSaveKey(), b.slice(0, 200)); paint(); break; }
    case 'sell': if (need()) void listModal('', true); break;
    case 'mkcat': MK_S.cat = v; paint(); break;
    case 'mkview': MK_S.view = v; paint(); break;
    case 'limg': MK_S.img = Number(v) || 0; paint(); break;
    case 'lbuy': if (need()) void buyModal(v); break;
    case 'loffer': if (need()) offerModal(v); break;
    case 'lask': if (need()) askModal(v); break;
    case 'lans': if (need()) ansModal(v, el.dataset.q || ''); break;
    case 'lrev': if (need()) revModal(v); break;
    case 'ledit': if (need()) void listModal(v, true); break;
    case 'lset': if (need() && !S.busy) { const w = el.dataset.s || ''; void act(w === 'price' ? { t: 'lup', ref: v, pr: Number(el.dataset.p) } : { t: 'lup', ref: v, st: w }, 'Updating listing…', w === 'del' ? 'Listing removed' : 'Listing updated'); } break;
    case 'lshare': { const u = linkFor('l', v); try { void navigator.clipboard.writeText(u); ctx.toast('Listing link copied'); } catch { ctx.toast(u); } break; }
    case 'lrep': if (need()) reportModal(v); break;
    case 'flist': flistModal(v, el.dataset.k || 'followers'); break;
    case 'plink': sc.m('copyu', v); break;
    case 'ytplay': { const box = el.closest('.sc-yt') as HTMLElement | null; if (box) box.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(v)}?autoplay=1&rel=0&playsinline=1" title="YouTube video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`; break; }
    case 'cam': sc_cam('post'); break;
    case 'upl': pickMedia(); break;
    case 'mediax': S.media = ''; paint(); break;
    case 'pcbig': bigChart(v); break;
    case 'pcx': S.noCard.add(v); updCard(); break;
    case 'nftpick': await openNfts('post'); break;
    case 'nftx': S.nft = null; S.media = ''; paint(); break;
    case 'nftshare': { if (!need()) break; const n = nftFind(v); if (!n) break; const m = await nftMeta(n); if (!m.img) { ctx.toast('Still loading this NFT picture. Try again in a moment.', true); break; } if (!okImg(m.img)) { ctx.toast('This network does not allow pictures from that source.', true); break; } S.nft = { id: v, img: m.img, name: m.name || 'NFT #' + n.serial }; S.media = m.img; go({ k: 'home' }); setTimeout(() => (document.getElementById('sc-txt') as HTMLElement | null)?.focus(), 30); break; }
    case 'noblur': LS.set('sc.noblur', !LS.get('sc.noblur', false)); paint(); break;
    case 'like': if (need() && !S.busy) await act(iLike(v) ? { t: 'unl', ref: v } : { t: 'like', ref: v }, 'Liking…'); break;
    case 'rt': if (need() && !S.busy) { if (iRt(v)) ctx.toast('You already reposted this'); else await act({ t: 'rt', ref: v }, 'Reposting…', 'Reposted'); } break;
    case 'follow': if (need() && !S.busy) { if (v === me()) break; await act(iFollow(v) ? { t: 'unf', a: v } : folEv(v), 'Updating…', iFollow(v) ? 'Unfollowed' : 'Following ' + nameOf(v)); } break;
    case 'tip': tipModal(v, el.dataset.to || ''); break;
    case 'react': if (need()) reactModal(v); break;
    case 'rx': if (need() && !S.busy) { const cur = (IX.rx.get(v) || new Map()).get(me()); await act({ t: 'rx', ref: v, e: cur === el.dataset.e ? '' : el.dataset.e }, 'Reacting…'); } break;
    case 'menu': postMenu(v); break;
    case 'menuu': ctx.modal(mcard(`<div class="k" style="margin-bottom:6px">${esc(nameOf(v))}</div>${mi('link', 'Copy profile link', `sc.m('copyu','${v}')`)}${mi('slash', isMuted(v) ? 'Unmute' : 'Mute', `sc.m('${isMuted(v) ? 'unmute' : 'mute'}','${v}')`, isMuted(v) ? '' : 'bad')}`, 320)); break;
    case 'sup': supModal(IX.tipsRef.get(v) || [], 'Tips on this post'); break;
    case 'supu': supModal(IX.tipsTo.get(v) || [], 'Tip jar of ' + nameOf(v)); break;
    case 'unmute': LS.set(muteKey(), muted().filter(x => x !== v)); paint(); break;
    case 'drange': (S as any).dr = Number(v); paint(); break;
    case 'img': { S.lb = v; document.getElementById('sc-lbx')?.remove(); const d = document.createElement('div'); d.id = 'sc-lbx'; d.innerHTML = `<button class="sc-lbx-x" aria-label="Close">${ic('x', 22)}</button><img src="${esc(v)}" alt="" referrerpolicy="no-referrer">`; document.body.appendChild(d); const close = () => { document.removeEventListener('keydown', key); d.remove(); }; const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; document.addEventListener('keydown', key); d.addEventListener('click', close); break; }
    case 'vote': if (need() && !S.busy) { const m = IX.votes.get(v); if (m && m.has(me())) { ctx.toast('You already voted'); break; } await act({ t: 'vote', ref: v, o: Number(el.dataset.o) }, 'Voting…', 'Vote counted'); } break;
    case 'topd': TOPD = Number(v); void topLoad(true); paint(); break;
    case 'exportmine': exportMine(); break;
    case 'clrcache': try { localStorage.removeItem(KEY()); localStorage.removeItem(TKEY()); } catch {} EV = []; rebuild(); ctx.toast('Cache cleared. Reading the chain again…'); void pull(true).then(() => paint()); break;
    case 'clrset': LS.set(setKey(), {}); ctx.toast('Settings reset.'); paint(); break;
    case 'editprof': if (need()) { ED = {}; editModal(); } break;
    case 'post': await doPost(el.dataset.reply || '', el.dataset.quote || ''); break;
  }
}
function splitThread(s: string): string[] {
  s = s.trim(); if (s.length <= MAXTXT) return [s];
  const parts: string[] = [], LIM = 470;
  while (s.length > LIM) {
    let cut = s.lastIndexOf('\n\n', LIM); if (cut < LIM * 0.5) cut = s.lastIndexOf('\n', LIM); if (cut < LIM * 0.5) cut = s.lastIndexOf('. ', LIM) + 1; if (cut < LIM * 0.5) cut = s.lastIndexOf(' ', LIM); if (cut < LIM * 0.5) cut = LIM;
    parts.push(s.slice(0, cut).trim()); s = s.slice(cut).trim();
  }
  if (s) parts.push(s);
  return parts.map((p, i) => `${p} (${i + 1}/${parts.length})`);
}
async function doPost(reply: string, quote: string) {
  if (!need() || S.busy) return;
  let x = ((document.getElementById('sc-txt') as HTMLTextAreaElement | null)?.value ?? S.draft).trim(), media = ((document.getElementById('sc-media') as HTMLInputElement | null)?.value ?? S.media).trim();
  const m = media ? [safeUrl(media)].filter(Boolean) : []; if (media && !m.length) { S.err = 'The image link must start with https:// or ipfs://'; paint(); return; }
  const poll = S.pollOn ? S.poll.map(o => o.trim()).filter(Boolean) : []; if (S.pollOn && poll.length < 2) { S.err = 'A poll needs at least two options.'; paint(); return; }
  if (!x && !m.length) { S.err = 'Write something first.'; paint(); return; }
  { const st = SET(); if (st.cw && !/^\[CW\]/.test(x)) x = '[CW] ' + x; if (st.tipme && !reply) x = (x + '\nTips welcome: ' + ctx.showL(me())).trim(); if (st.confirm && !confirm('Send this post to the chain?')) return; }
  const bad = violates(x + ' ' + poll.join(' ')); if (bad) { S.err = `This post was not sent. It contains ${WHY[bad]}, which is not allowed on LUMA Social.`; paint(); return; }
  if (m.length && !okImg(m[0])) { S.err = 'Pictures from that link are not allowed on this network. Use an NFT or an image from an approved source.'; paint(); return; }
  const parts = splitThread(x);
  if (parts.length > MAXPARTS) { S.err = `That is too long even for a thread (up to ${MAXPARTS} posts). Shorten it.`; paint(); return; }
  if (parts.some(p => enc.encode(JSON.stringify({ v: 1, t: 'post', x: p, r: 'F'.repeat(64) })).length > MAXMEMO)) { S.err = 'Part of the text has too many special characters to fit in one transaction. Shorten it or split it yourself.'; paint(); return; }
  let prev = reply, first = true;
  for (let i = 0; i < parts.length; i++) {
    const d: any = { t: 'post', x: parts[i] }; if (first) { if (m.length) d.m = m; if (S.nft && m[0] === S.nft.img) d.n = S.nft.id; if (quote) d.q = quote; if (poll.length) d.p = poll; } if (prev) d.r = prev;
    const h = await act(d, parts.length > 1 ? `Posting ${i + 1} of ${parts.length}…` : 'Posting…', i === parts.length - 1 ? (parts.length > 1 ? `Thread of ${parts.length} posted on the chain` : 'Posted on the chain') : undefined);
    if (!h) { if (i) ctx.toast(`Only ${i} of ${parts.length} posts went through.`, true); return; }
    if (h === 'ok' && i < parts.length - 1) { S.err = 'The network did not return the transaction hash, so the thread was stopped.'; paint(); return; }
    prev = h; first = false;
  }
  S.draft = ''; S.media = ''; S.nft = null; S.poll = ['', '']; S.pollOn = false; S.quote = ''; LS.set(draftKey(), ''); ctx.closeModal(); paint();
}
let draftT: any = 0;
function bind() {
  const root = document.getElementById('sc-root'); if (!root || bound === root) return; bound = root;
  root.addEventListener('click', e => { PP.onClick(e); }, true);
  root.addEventListener('keydown', PP.onKey as any); root.addEventListener('input', PP.onInput); root.addEventListener('paste', PP.onPaste as any); root.addEventListener('drop', PP.onDrop as any);
  root.addEventListener('click', e => { const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null; if (!el || !root.contains(el)) return; if ((e.target as HTMLElement).closest('a[href]')) return; void onClick(el, e); });
  root.addEventListener('change', e => { const t = e.target as HTMLInputElement; const mk = t.dataset && t.dataset.mkx; if (mk) { (MKFS as any)[mk] = t.type === 'checkbox' ? t.checked : mk === 'within' ? Number(t.value) : t.value; mkfSave(); paint(); return; } const key = t.dataset && t.dataset.st; if (!key) return; setPut(key, t.type === 'checkbox' ? t.checked : key === 'fs' ? Number(t.value) : t.value); paint(); });
  root.addEventListener('input', e => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'sc-txt') { sugUpdate(t as any); S.draft = t.value; grow(t as any); const r = document.getElementById('sc-ring'); if (r) r.outerHTML = ringHtml(t.value.length); updCard(); const c = document.getElementById('sc-cost'); if (c) c.textContent = fmt(t.value.length > MAXTXT ? Math.ceil(t.value.length / 470) * COST.post : COST.post, 4) + ' LUMA'; clearTimeout(draftT); draftT = setTimeout(() => LS.set(draftKey(), S.draft), 400); }
    else if (t.id === 'sc-media') S.media = t.value; else if (t.classList.contains('sc-po')) S.poll[Number(t.dataset.i)] = t.value;
    else if (t.id === 'sc-q' || t.id === 'sc-q2') S.q = t.value;
  });
  root.addEventListener('keydown', e => { const t = e.target as HTMLInputElement; if (SG && t.id === 'sc-txt') { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); SG.i = (SG.i + (e.key === 'ArrowDown' ? 1 : SG.items.length - 1)) % SG.items.length; sugPaint(); return; } if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') { e.preventDefault(); sugPick(SG.i); return; } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); sugClose(); return; } } if (e.key === 'Enter' && (t.id === 'sc-q' || t.id === 'sc-q2')) { go({ k: 'search', q: t.value }); } if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && t.id === 'sc-txt') { const b = document.getElementById('sc-go'); b && (b as HTMLElement).click(); } });
  let g = 0;
  KD = (e: KeyboardEvent) => {
    if (!document.getElementById('sc')) return; const t = e.target as HTMLElement;
    if (e.key === 'Escape') { ctx.closeModal(); if (t && /INPUT|TEXTAREA/.test(t.tagName)) t.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || (t && (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable))) return;
    if (e.key === 'n') { e.preventDefault(); go({ k: 'home' }); setTimeout(() => (document.getElementById('sc-txt') as HTMLElement | null)?.focus(), 30); }
    else if (e.key === '/') { e.preventDefault(); const q = (document.getElementById('sc-q') || document.getElementById('sc-q2')) as HTMLElement | null; if (q) q.focus(); else { go({ k: 'explore' }); setTimeout(() => (document.getElementById('sc-q2') as HTMLElement | null)?.focus(), 30); } }
    else if (e.key === '?') keysModal();
    else if (e.key === 'g') { g = Date.now(); }
    else if (Date.now() - g < 1200 && e.key === 'h') { g = 0; go({ k: 'home' }); } else if (Date.now() - g < 1200 && e.key === 'n') { g = 0; go({ k: 'notif' }); LS.set(seenKey(), Math.floor(Date.now() / 1000)); }
  };
}

export const sc: any = {
  editBack() { leaveEdit(); paint(); },
  close: () => { TS = null; ED = {}; ctx.closeModal(); },
  m(a: string, id: string) {
    ctx.closeModal();
    switch (a) {
      case 'copy': case 'copyu': { const u = linkFor(a === 'copy' ? 'post' : 'u', id); try { void navigator.clipboard.writeText(u); ctx.toast('Link copied'); } catch { ctx.toast(u); } break; }
      case 'share': try { void (navigator as any).share({ url: linkFor('post', id), title: 'LUMA Social' }); } catch {} break;
      case 'sx': { const q = IX.posts.get(id); const u = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent((q ? q.x.slice(0, 200) : '') + '\n') + '&url=' + encodeURIComponent(linkFor('post', id)); window.open(u, '_blank', 'noopener,noreferrer'); break; }
      case 'quote': if (need()) { S.quote = id; S.view = { k: 'home' }; window.scrollTo({ top: 0 }); paint(); setTimeout(() => (document.getElementById('sc-txt') as HTMLElement | null)?.focus(), 30); } break;
      case 'bm': { const b = bookmarks(), i = b.indexOf(id); if (i >= 0) b.splice(i, 1); else b.unshift(id); LS.set(bmKey(), b); ctx.toast(i >= 0 ? 'Removed from bookmarks' : 'Saved to bookmarks'); paint(); break; }
      case 'boost': if (need()) boostModal(id); break;
      case 'report': if (need()) reportModal(id); break;
      case 'react': if (need()) reactModal(id); break;
      case 'edit': if (need()) editPostModal(id); break;
      case 'mintnft': { const p = IX.posts.get(id), u = p && p.m.find(x => /^ipfs:\/\//.test(x)); if (!p || !u || !need()) break; ctx.toast('Loading your picture…'); fetch(safeUrl(u)).then(r => r.blob()).then(bl => mintFromImage(new File([bl], 'post-' + String(id).slice(0, 6) + '.' + ((bl.type.split('/')[1] || 'png').replace('+xml', '')), { type: bl.type }), String((p as any).x || '').slice(0, 40) || 'My NFT')).catch(() => ctx.toast('Could not load the picture to mint it.', true)); break; }
      case 'pin': if (need() && !S.busy) void act({ t: 'pin', ref: id }, 'Pinning…', 'Pinned to your profile'); break;
      case 'unpin': if (need() && !S.busy) void act({ t: 'pin', ref: '' }, 'Unpinning…', 'Unpinned'); break;
      case 'del': if (need() && !S.busy && confirm('Delete this post? It stays in the chain history but disappears from LUMA Social.')) void act({ t: 'del', ref: id }, 'Deleting…', 'Deleted'); break;
      case 'mute': LS.set(muteKey(), Array.from(new Set([...muted(), id]))); ctx.toast('Muted. You can undo this in Creator, Muted accounts.'); paint(); break;
      case 'unmute': LS.set(muteKey(), muted().filter(x => x !== id)); paint(); break;
    }
  },
  async report(id: string, r: string) { ctx.closeModal(); if (need() && !S.busy) await act({ t: 'rep', ref: id, r }, 'Reporting…', 'Thanks. Your report went to the moderators.'); },
  nftPick: (id: string) => void nftPick(id),
  pickFor(kind: string) { ED = collectProf(); void openNfts(kind); },
  async rx(id: string, e: string) { ctx.closeModal(); if (need() && !S.busy) await act({ t: 'rx', ref: id, e }, 'Reacting…', e ? 'Reacted ' + e : 'Reaction removed'); },
  async boost(id: string) { const n = Number((document.getElementById('sc-bst') as HTMLInputElement)?.value); if (!(n >= 1)) { ctx.toast('The smallest boost is 1 LUMA', true); return; } ctx.closeModal(); if (need() && !S.busy) await act({ t: 'boost', ref: id }, 'Boosting…', 'Boosted with ' + fmt(n, 2) + ' LUMA', n); },
  async edit(id: string) { const x = ((document.getElementById('sc-ed') as HTMLTextAreaElement)?.value || '').trim(); if (!x) { ctx.toast('The text cannot be empty', true); return; } const bd = violates(x); if (bd) { ctx.toast(`Not saved: it contains ${WHY[bd]}, which is not allowed here.`, true); return; } ctx.closeModal(); if (need() && !S.busy) await act({ t: 'edit', ref: id, x }, 'Saving…', 'Post updated'); },
  tipPick(i: number) { if (!TS || !TS.opts[i] || !TS.opts[i].ok) return; sc.tipUpd(); TS.sel = i; TS.amt = pres(TS.opts[i])[0].v; TS.err = ''; renderTip(); },
  tipPreset(v: string) { if (!TS) return; sc.tipUpd(); TS.amt = v; renderTip(); },
  tipUpd() { if (!TS) return; const a = document.getElementById('sc-tip') as HTMLInputElement | null, n = document.getElementById('sc-tipn') as HTMLInputElement | null; if (a) TS.amt = a.value; if (n) TS.note = n.value; },
  tipSend: () => void tipSend(),
  dstrip() { const c = dashCfg(); c.strip = !c.strip; saveDash(c); paint(); custModal(); },
  dtog(id: string) { const c = dashCfg(), i = c.off.indexOf(id); if (i >= 0) c.off.splice(i, 1); else c.off.push(id); saveDash(c); paint(); custModal(); },
  dmove(id: string, d: number) { const c = dashCfg(), i = c.order.indexOf(id), j = i + d; if (i < 0 || j < 0 || j >= c.order.length) return; c.order.splice(j, 0, c.order.splice(i, 1)[0]); saveDash(c); paint(); custModal(); },
  dreset() { LS.set(dashKey(), {}); paint(); custModal(); },
  goTag(t: string) { ctx.closeModal(); go({ k: 'tag', tag: t }); },
  shareNft(id: string) { const el = document.createElement('i'); el.dataset.act = 'nftshare'; el.dataset.v = id; void onClick(el, new Event('click')); },
  cam(k: string) { sc_cam(k); },
  trade(sym: string) { ctx.closeModal(); const w: any = window; try { w.dx?.wantSym?.(sym); w.goTab('dex'); setTimeout(() => { const id = w.dx?.findSym?.(sym); if (id) w.dx.pick(id); }, 700); } catch { ctx.toast('Open the DEX tab to trade ' + sym, true); } },
  async upload(inp: HTMLInputElement, kind: string) {
    const files = inp.files; if (!files || !files.length || UP || !need()) { inp.value = ''; return; } UP = true;
    try {
      if (kind === 'post') { const u = await uploadFiles(files, 1, true); if (u[0]) { S.media = u[0]; S.nft = null as any; } paint(); }
      else { ED = { ...collectListing(), __mk: 1, eid: (ED && ED.eid) || '' }; const mm: string[] = ED.m || [], u = await uploadFiles(files, 4 - mm.length); ED.m = mm.concat(u); void listModal(ED.eid); }
    } finally { UP = false; inp.value = ''; }
  },
  mkf(k: string, v: string) { (MK_S as any)[k] = v; paint(); },
  lpick() { ED = { ...collectListing(), __mk: 1 }; void openNfts('mk'); },
  async lsubmit() { await listSubmit(); },
  buyQty(v: string) { if (BS) { BS.qty = Math.max(1, Math.min(999, Math.floor(Number(v) || 1))); renderBuy(); } },
  async buySend() { await buySend(); },
  async offerSend(id: string) { await offerSend(id); },
  async askSend(id: string) { await askSend(id); },
  async ansSend(id: string, q: string) { await ansSend(id, q); },
  async revSend(id: string) { await revSend(id); },
  prev() { const v = collectProf(), pv = document.getElementById('pf-prev'); if (pv) pv.innerHTML = prevHtml(v); const sz = enc.encode(JSON.stringify({ v: 1, ...profEvent(v) })).length, el = document.getElementById('pf-size'); if (el) { el.textContent = `Profile size ${sz} of ${MAXMEMO - 20} bytes`; (el as HTMLElement).style.color = sz > MAXMEMO - 20 ? '#f87171' : ''; } },
  swatch(c: string) { const i = document.getElementById('pf-c') as HTMLInputElement | null; if (i) i.value = c; sc.prev(); },
  goU(a: string) { ctx.closeModal(); go({ k: 'profile', a }); },
  async fol(a: string) { ctx.closeModal(); if (need() && !S.busy) await act(iFollow(a) ? { t: 'unf', a } : folEv(a), 'Updating…', iFollow(a) ? 'Unfollowed' : 'Following ' + nameOf(a)); },
  async saveProf() {
    const v = collectProf(), d = profEvent(v), txt = [v.n, v.b, v.l, v.pr, v.jb, v.st, v.l1t, v.l2t].join(' '), bp = violates(txt);
    if (bp) { ctx.toast(`Not saved: your profile contains ${WHY[bp]}, which is not allowed here.`, true); return; }
    for (const [k, nm] of [['i', 'photo'], ['k', 'cover picture'], ['w', 'website'], ['l1u', 'link 1'], ['l2u', 'link 2']] as const) if (v[k] && !safeUrl(v[k])) { ctx.toast(`The ${nm} must start with https:// or ipfs://`, true); return; }
    if ((v.i && !okImg(safeUrl(v.i))) || (v.k && !okImg(safeUrl(v.k)))) { ctx.toast('Pictures from that link are not allowed on this network. Use an NFT or an approved source.', true); return; }
    if (enc.encode(JSON.stringify({ v: 1, ...d })).length > MAXMEMO - 20) { ctx.toast('Your profile is too long to store in one transaction. Shorten the bio, links or text.', true); return; }
    leaveEdit(); await act(d, 'Saving profile…', 'Profile saved on the chain'); },
  async claim() { const h = ((document.getElementById('pf-h') as HTMLInputElement)?.value || '').trim().toLowerCase().replace(/^@/, ''); const m = document.getElementById('pf-hm');
    if (!/^[a-z0-9_]{3,15}$/.test(h)) { if (m) m.textContent = 'Use 3 to 15 letters, numbers or _'; return; } const o = IX.owner.get(h); if (o && o !== me()) { if (m) m.textContent = '@' + h + ' is taken'; return; }
    if (S.view.k === 'editprof') leaveEdit(); await act({ t: 'hdl', h }, 'Claiming…', 'You are @' + h); },
};
(window as any).sc = sc;

function deepLink() {
  if (S.deep) return; S.deep = true;
  try {
    let q = new URLSearchParams(location.search).get('social');
    const pm = location.pathname.match(/^\/(p|u|t|r|l)\/([^/]+)\/?$/); if (!q && pm) q = ({ p: 'post', u: 'u', t: 'tag', r: 'ref', l: 'l' } as any)[pm[1]] + ':' + pm[2];
    if (!q) return; const i = q.indexOf(':'), kind = q.slice(0, i), id = decodeURIComponent(q.slice(i + 1));
    if (kind === 'post' && /^[0-9a-f]{6,63}$/i.test(id)) { S.pend = id.toUpperCase(); return; }
    if (kind === 'post' && isHash(id)) S.view = { k: 'thread', id: id.toUpperCase() }; else if (kind === 'u' && isAddr(id)) S.view = { k: 'profile', a: id }; else if (kind === 'tag' && id) S.view = { k: 'tag', tag: id.toLowerCase() }; else if (kind === 'ref' && isAddr(id)) { LS.set(refKey(), id); } else if (kind === 'l' && isHash(id)) S.view = { k: 'listing', id: id.toUpperCase() };
  } catch {}
}
let LASTACC: string | null = null;
import * as PP from './postplus.ts';
export async function mount() {
  if (!document.getElementById('sc-root')) return;
  if (me() && LASTACC !== me()) { const first = LASTACC === null; LASTACC = me(); if (!first) { S.view = { k: 'home' } as any; hist.length = 0; S.draft = ''; S.media = ''; S.nft = null; S.quote = ''; S.err = ''; S.loaded = false; POL.at = 0; } }
  PP.init({ cam: () => sc_cam('post'), me, setMedia: u => { S.media = u; S.nft = null; paint(); }, post: () => { const b = document.getElementById('sc-go') as HTMLElement | null; if (b) b.click(); }, toast: (m, b) => ctx.toast(m, b), upload: async f => { const u = await uploadFiles([f], 1, true); if (u[0]) { S.media = u[0]; S.nft = null; paint(); } }, showL: a => ctx.showL(a) }); cachedPolicy(); stop(); bind(); if (KD) { kd = KD; document.addEventListener('keydown', kd); } loadCache(); if (!S.draft) S.draft = LS.get(draftKey(), '') || ''; deepLink(); paint();
  await pull(); paint();
  timer = setInterval(() => { if (document.hidden || !document.getElementById('sc')) { if (!document.getElementById('sc')) stop(); return; } void pull().then(() => { const a = document.activeElement as HTMLElement | null; if (!(a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) && !document.getElementById('m')?.innerHTML) paintSoft(); }); }, 9000);
}
function stop() { if (timer) { clearInterval(timer); timer = 0; } if (kd) { document.removeEventListener('keydown', kd); kd = null; } }
export function unmount() { stop(); bound = null; }
