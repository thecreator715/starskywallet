// Post tools for the LUMA Social composer: GIF search, emoji, formatting, drafts, snippets, scheduling, preview and more.
// Everything here runs in the browser; a post still goes to the chain exactly as before.
type H = { me: () => string; setMedia: (u: string) => void; post: () => void; toast: (m: string, bad?: boolean) => void; upload: (f: File) => Promise<void>; showL: (a: string) => string };
let h: H; const K = (n: string) => 'sc.pp.' + n;
const J = (k: string, d: any) => { try { const v = localStorage.getItem(K(k)); return v == null ? d : JSON.parse(v); } catch { return d; } };
const W = (k: string, v: any) => { try { localStorage.setItem(K(k), JSON.stringify(v)); } catch {} };
const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const ta = () => document.getElementById('sc-txt') as HTMLTextAreaElement | null;
const DEFKEY = 'dc6zaTOxFJmzC';
const CATS: [string, string[]][] = [['Smileys', '😀😃😄😁😆😅😂🤣😊😇🙂😉😍🥰😘😋😎🤩🥳😏😴🤔🫡🤯😱😭😤😡🥺😬🙄'.match(/\p{Extended_Pictographic}/gu) || []], ['Hands', '👍👎👏🙌🙏💪🤝✌️🤞👌🤙👋🫶🤟👀🫰'.match(/\p{Extended_Pictographic}️?/gu) || []], ['Crypto', ['🚀', '🌕', '💎', '🔥', '💰', '📈', '📉', '🪙', '⚡', '🧠', '🐂', '🐻', '🏦', '🔒', '🛰️', '🌐']], ['Fun', '🎉🎊🎁🏆🥇🎮🎵🎧🎬🍕🍔🍻☕🌴🌈⭐✨💥💯❤️🧡💛💚💙💜🖤'.match(/\p{Extended_Pictographic}️?/gu) || []]];
const GCATS = ['wave', 'hug', 'laugh', 'dance', 'clap', 'celebrate', 'cool', 'happy', 'love', 'kiss', 'cry', 'sad', 'mad', 'facepalm', 'shrug', 'no', 'surprised', 'smug', 'sleep', 'sing'];
const FONT: Record<string, [number, number]> = { b: [0x1d5d4, 0x1d5ee], i: [0x1d608, 0x1d622], m: [0x1d670, 0x1d68a] };
const fmtTxt = (s: string, k: string) => Array.from(s).map(c => { const [u, l] = FONT[k]; if (/[A-Z]/.test(c)) return String.fromCodePoint(u + c.charCodeAt(0) - 65); if (/[a-z]/.test(c)) return String.fromCodePoint(l + c.charCodeAt(0) - 97); return c; }).join('');
const hist: string[] = []; let redo: string[] = [];
let G = { q: 'trending', off: 0, items: [] as { u: string; p: string; t: string }[], busy: false, end: false, err: '' };
let panelEl: HTMLElement | null = null;
function put(txt: string, replace = false) { const t = ta(); if (!t) return; if (replace) t.value = txt; else { const a = t.selectionStart ?? t.value.length, b = t.selectionEnd ?? a; t.value = t.value.slice(0, a) + txt + t.value.slice(b); t.selectionStart = t.selectionEnd = a + txt.length; } t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); }
function snap() { const t = ta(); if (t && hist[hist.length - 1] !== t.value) { hist.push(t.value); if (hist.length > 60) hist.shift(); redo = []; } }
function wrapSel(k: string) { const t = ta(); if (!t) return; snap(); const a = t.selectionStart, b = t.selectionEnd; const sel = t.value.slice(a, b); if (!sel) { h.toast('Select some text first, then pick a style.', true); return; } put(fmtTxt(sel, k)); }
function close() { if (panelEl) { panelEl.remove(); panelEl = null; } curP = ''; }
function open(title: string, body: string) { close(); curP = title; const bar = document.getElementById('pp-bar'); if (!bar) return; panelEl = document.createElement('div'); panelEl.className = 'pp-pn'; panelEl.innerHTML = `<div class="pp-hd"><b>${title}</b><button class="pp-x" data-pp="close" aria-label="Close">✕</button></div>${body}`; bar.after(panelEl); }
const wordStats = (s: string) => { const w = (s.trim().match(/\S+/g) || []).length; return `${w} words · ${s.length} characters · ${Math.max(1, Math.round(w / 200 * 60))} sec read`; };
// ----- GIFs (Giphy) -----
const gkey = () => String(J('giphyKey', '') || '');
// Free GIFs without any account: reaction GIFs from OtakuGIFs and a search of every animated GIF on Wikimedia Commons. A personal Giphy key (optional) switches search to Giphy.
const U = (s: string) => String(s).split('?')[0];
async function gifLoad(reset: boolean) {
  if (G.busy || (G.end && !reset)) return; if (reset) { G.items = []; G.off = 0; G.end = false; G.err = ''; } G.busy = true; paintGifs();
  try {
    const trend = !G.q || G.q === 'trending', react = GCATS.includes(G.q);
    if (gkey() && !react) {
      const url = `https://api.giphy.com/v1/gifs/${trend ? 'trending' : 'search'}?api_key=${encodeURIComponent(gkey())}&limit=24&offset=${G.off}&rating=pg-13${trend ? '' : '&q=' + encodeURIComponent(G.q)}`;
      const r = await fetch(url, { referrerPolicy: 'no-referrer' }); if (!r.ok) throw new Error('Your Giphy key was refused (' + r.status + ').');
      const j = await r.json(); const d = j.data || []; for (const g of d) { const im = g.images || {}; const p = (im.fixed_height_small || im.fixed_height || {}).url; if (g.id && p) G.items.push({ u: 'https://i.giphy.com/' + g.id + '.gif', p: U(p), t: g.title || '' }); }
      G.off += d.length; if (d.length < 24) G.end = true;
    } else if (react) {
      const rs = await Promise.all(Array.from({ length: 12 }, () => fetch('https://api.otakugifs.xyz/gif?reaction=' + encodeURIComponent(G.q)).then(r => r.json()).catch(() => null)));
      const seen = new Set(G.items.map(x => x.u)); for (const x of rs) { const u = x && x.url; if (u && !seen.has(u)) { seen.add(u); G.items.push({ u, p: u, t: G.q }); } }
      if (!rs.some(x => x && x.url)) throw new Error('Could not reach the GIF service from this connection.');
    } else {
      const q = trend ? 'funny' : G.q, url = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=' + encodeURIComponent('filemime:gif ' + q) + '&gsrnamespace=6&gsrlimit=24&gsroffset=' + G.off + '&prop=imageinfo&iiprop=url|size&iiurlwidth=240&format=json&origin=*';
      const r = await fetch(url); if (!r.ok) throw new Error('GIF search failed (' + r.status + ').');
      const j = await r.json(), pages: any[] = Object.values((j.query && j.query.pages) || {}); pages.sort((a, b) => (a.index || 0) - (b.index || 0));
      for (const p of pages) { const ii = p.imageinfo && p.imageinfo[0]; if (ii && ii.url && ii.url.length <= 150 && (ii.size || 0) < 9e6) G.items.push({ u: ii.url, p: ii.thumburl || ii.url, t: String(p.title || '').replace(/^File:|\.gif$/g, '') }); }
      const nx = j.continue && j.continue.gsroffset; if (nx != null) G.off = nx; else G.end = true; if (!pages.length) G.end = true;
    }
  } catch (e: any) { G.err = String(e.message || e).includes('Failed to fetch') ? 'Could not reach the GIF service from this connection.' : String(e.message || e); }
  G.busy = false; paintGifs();
}
function paintGifs() { const el = document.getElementById('pp-gifs'); if (!el) return; el.innerHTML = (G.items.map((g, i) => `<button class="pp-g" data-pp="gifpick" data-i="${i}" title="${esc(g.t)}"><img src="${esc(g.p)}" alt="${esc(g.t)}" loading="lazy" referrerpolicy="no-referrer"></button>`).join('') || (G.busy ? '' : '<div class="sc-m">No GIFs found.</div>')) + (G.busy ? '<div class="sc-m" style="grid-column:1/-1">Searching…</div>' : '') + (G.err ? `<div class="sc-warn" style="grid-column:1/-1">${esc(G.err)}</div>` : '') + (!G.end && !G.busy && G.items.length ? '<button class="sc-btn sm ghost" data-pp="gifmore" style="grid-column:1/-1">Load more</button>' : ''); }
function gifPanel() { open('GIFs', `<div class="sc-row" style="gap:6px"><input class="sc-in" id="pp-gq" placeholder="Search GIFs (cat, dance, space…)" value="${G.q === 'trending' ? '' : esc(G.q)}"><button class="sc-btn sm" data-pp="gifgo">Search</button></div><div class="pp-chips">${GCATS.map(c => `<button class="pp-chip ${G.q === c ? 'on' : ''}" data-pp="gifcat" data-v="${c}">${c}</button>`).join('')}</div><div id="pp-gifs" class="pp-gr"></div><div class="sc-m" style="margin-top:6px">Free, no account needed. Tap a mood for reaction GIFs, or search any word. <a class="sc-l" data-pp="gifkey">Use my own Giphy key</a> for the big Giphy library.</div>`); if (!G.items.length) void gifLoad(true); else paintGifs(); }
let curP = '';
function emojiPanel(q = '') { const rec: string[] = J('recent', []); const all = CATS.flatMap(c => c[1]); const list = q ? all.filter(e => e.includes(q)) : []; open('Emoji', `<input class="sc-in" id="pp-eq" placeholder="Type or paste an emoji to filter" value="${esc(q)}">${rec.length ? `<div class="sc-m">Recent</div><div class="pp-em">${rec.map(e => `<button data-pp="em" data-v="${e}">${e}</button>`).join('')}</div>` : ''}${q ? `<div class="pp-em">${list.map(e => `<button data-pp="em" data-v="${e}">${e}</button>`).join('')}</div>` : CATS.map(c => `<div class="sc-m">${c[0]}</div><div class="pp-em">${c[1].map(e => `<button data-pp="em" data-v="${e}">${e}</button>`).join('')}</div>`).join('')}`); }
function draftsPanel() { const d: { t: string; at: number }[] = J('drafts', []); open('Saved drafts', `<button class="sc-btn sm" data-pp="dsave">Save current draft</button>${d.length ? d.map((x, i) => `<div class="pp-it"><div class="pp-tx">${esc(x.t.slice(0, 140))}</div><div class="sc-row" style="gap:6px"><button class="sc-btn sm ghost" data-pp="duse" data-i="${i}">Use</button><button class="sc-btn sm ghost" data-pp="ddel" data-i="${i}">Delete</button></div></div>`).join('') : '<div class="sc-m" style="margin-top:8px">No saved drafts yet.</div>'}`); }
const SNIP0 = ['Gm LUMA family ☀️', 'Tips are welcome and 100% go to the creator.', 'New $LUMA update is live. Details below 👇', 'What are you building on LUMA today?'];
function snipPanel() { const s: string[] = J('snips', SNIP0); open('Snippets', `<div class="sc-row" style="gap:6px"><input class="sc-in" id="pp-sn" placeholder="Save the current text as a snippet"><button class="sc-btn sm" data-pp="ssave">Save</button></div>${s.map((x, i) => `<div class="pp-it"><div class="pp-tx">${esc(x)}</div><div class="sc-row" style="gap:6px"><button class="sc-btn sm ghost" data-pp="suse" data-i="${i}">Insert</button><button class="sc-btn sm ghost" data-pp="sdel" data-i="${i}">Delete</button></div></div>`).join('')}`); }
const sch = (): { at: number; t: string; m: string }[] => J('sched', []);
function schedPanel() { const t = ta(); const l = sch().filter(x => x.at > 0); const d = new Date(Date.now() + 3600e3 - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16); open('Schedule', `<div class="sc-m">The post goes out at that time while Starsky is open in a tab and your wallet is unlocked. ${t && t.value.trim() ? '' : 'Write your post first.'}</div><div class="sc-row" style="gap:6px;margin-top:6px"><input class="sc-in" type="datetime-local" id="pp-when" value="${d}"><button class="sc-btn sm" data-pp="sset">Schedule this post</button></div>${l.map((x, i) => `<div class="pp-it"><div class="pp-tx">${new Date(x.at).toLocaleString()} · ${esc(x.t.slice(0, 80))}</div><button class="sc-btn sm ghost" data-pp="sdrop" data-i="${i}">Cancel</button></div>`).join('')}`); }
function previewPanel() { const t = ta(); const v = t ? t.value : ''; const m = (document.getElementById('sc-media') as HTMLInputElement | null)?.value || ''; open('Preview', `<div class="pp-pv">${esc(v).replace(/\n/g, '<br>').replace(/(\$[A-Za-z0-9]{2,12}|#\w+|@\w+)/g, '<b style="color:#7dd3fc">$1</b>') || '<span class="sc-m">Nothing written yet.</span>'}${m ? `<img src="${esc(m)}" alt="" referrerpolicy="no-referrer" style="max-width:100%;border-radius:12px;margin-top:8px" onerror="this.remove()">` : ''}</div><div class="sc-m" style="margin-top:6px">${wordStats(v)}</div>`); }
function morePanel() { open('Writing tools', `<div class="pp-chips"><button class="pp-chip" data-pp="fmt" data-v="b">𝗕old</button><button class="pp-chip" data-pp="fmt" data-v="i">𝘐talic</button><button class="pp-chip" data-pp="fmt" data-v="m">𝙼ono</button><button class="pp-chip" data-pp="cw">Content warning</button><button class="pp-chip" data-pp="spoil">Spoiler</button><button class="pp-chip" data-pp="alt">Add picture description</button><button class="pp-chip" data-pp="tipme">Add “tip me” line</button><button class="pp-chip" data-pp="hr">Divider</button><button class="pp-chip" data-pp="gm">Gm / Gn</button><button class="pp-chip" data-pp="vid">Add video link</button><button class="pp-chip" data-pp="undo">Undo</button><button class="pp-chip" data-pp="redo">Redo</button><button class="pp-chip" data-pp="clear">Clear draft</button></div><div class="sc-m" id="pp-st" style="margin-top:8px">${wordStats(ta()?.value || '')}</div><div class="sc-m">Tip: Ctrl or ⌘ + Enter posts. Paste or drop a picture into the box to upload it.</div>`); }
export const CSS = `.pp-bar{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}.pp-bar button{all:unset;cursor:pointer;font-size:.78rem;padding:5px 10px;border-radius:999px;border:1px solid var(--sl);color:#7dd3fc}.pp-bar button:hover{background:var(--sh)}.pp-pn{margin:8px 0;border:1px solid var(--sl);border-radius:14px;padding:10px;max-height:340px;overflow:auto;background:rgba(255,255,255,.03)}.pp-hd{display:flex;justify-content:space-between;margin-bottom:8px}.pp-x{all:unset;cursor:pointer;padding:2px 8px}.pp-gr{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}.pp-g{all:unset;cursor:pointer;border-radius:10px;overflow:hidden;aspect-ratio:1;background:#0003}.pp-g img{width:100%;height:100%;object-fit:cover}.pp-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.pp-chip{all:unset;cursor:pointer;font-size:.78rem;padding:4px 10px;border-radius:999px;border:1px solid var(--sl)}.pp-chip.on,.pp-chip:hover{background:var(--sh)}.pp-em{display:flex;flex-wrap:wrap;gap:2px;margin:4px 0}.pp-em button{all:unset;cursor:pointer;font-size:1.3rem;padding:3px 5px;border-radius:8px}.pp-em button:hover{background:var(--sh)}.pp-it{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--sl)}.pp-tx{flex:1;min-width:0;font-size:.85rem;word-break:break-word}.pp-pv{padding:10px;border:1px solid var(--sl);border-radius:12px;line-height:1.5}`;
export const barHtml = () => `<div class="pp-bar" id="pp-bar"><button data-pp="gif">GIF</button><button data-pp="emoji">Emoji</button><button data-pp="more">Aa Style</button><button data-pp="drafts">Drafts</button><button data-pp="snips">Snippets</button><button data-pp="sched">Schedule</button><button data-pp="prev">Preview</button></div>`;
function runSched() { const l = sch(), now = Date.now(); const due = l.filter(x => x.at > 0 && x.at <= now && x.m === h.me()); if (!due.length) return; const t = ta(); if (!t) return; W('sched', l.filter(x => !due.includes(x))); t.value = due[0].t; t.dispatchEvent(new Event('input', { bubbles: true })); h.toast('Posting your scheduled post…'); h.post(); }
let timer: any = 0;
export function init(hooks: H) { h = hooks; if (!timer) timer = setInterval(runSched, 20000); }
export function onClick(e: Event): boolean {
  const el = (e.target as HTMLElement).closest('[data-pp]') as HTMLElement | null; if (!el) return false; const a = el.dataset.pp!, v = el.dataset.v || '', i = Number(el.dataset.i);
  switch (a) {
    case 'close': close(); break; case 'gif': gifPanel(); break; case 'emoji': emojiPanel(); break; case 'more': morePanel(); break; case 'drafts': draftsPanel(); break; case 'snips': snipPanel(); break; case 'sched': schedPanel(); break; case 'prev': previewPanel(); break;
    case 'gifgo': G.q = (document.getElementById('pp-gq') as HTMLInputElement).value.trim() || 'trending'; void gifLoad(true); break;
    case 'gifcat': G.q = v; (document.getElementById('pp-gq') as HTMLInputElement).value = v === 'trending' ? '' : v; document.querySelectorAll('.pp-chip').forEach(c => c.classList.toggle('on', (c as HTMLElement).dataset.v === v)); void gifLoad(true); break;
    case 'gifmore': G.off = G.off; void gifLoad(false); break;
    case 'gifpick': { const g = G.items[i]; if (g) { h.setMedia(g.u); close(); } break; }
    case 'gifkey': { const k = prompt('Optional: paste your own free Giphy API key (developers.giphy.com) to search the Giphy library. Leave empty for the free built-in GIFs.', String(J('giphyKey', ''))); if (k !== null) { W('giphyKey', k.trim()); G.items = []; void gifLoad(true); } break; }
    case 'em': { snap(); put(v); const r: string[] = J('recent', []); W('recent', [v, ...r.filter(x => x !== v)].slice(0, 16)); break; }
    case 'fmt': wrapSel(v); break;
    case 'cw': snap(); { const t = ta(); if (t && !/^\[CW\]/.test(t.value)) put('[CW] ' + t.value, true); } break;
    case 'spoil': snap(); { const t = ta(); if (t) put('[spoiler] ' + t.value, true); } break;
    case 'alt': { const d = prompt('Describe the picture for people who cannot see it:'); if (d) { snap(); put('\n[picture: ' + d.slice(0, 120) + ']'); } break; }
    case 'tipme': snap(); put('\nTips welcome: ' + h.showL(h.me())); break;
    case 'hr': snap(); put('\n──────────\n'); break;
    case 'gm': snap(); put(new Date().getHours() < 17 ? 'Gm ☀️ ' : 'Gn 🌙 '); break;
    case 'vid': { const u = prompt('Paste a YouTube link. It will show as a playable preview in your post.'); if (u) { snap(); put((ta()?.value ? '\n' : '') + u.trim()); } break; }
    case 'undo': { const t = ta(); if (t && hist.length) { redo.push(t.value); put(hist.pop() as string, true); } break; }
    case 'redo': { const t = ta(); if (t && redo.length) { hist.push(t.value); put(redo.pop() as string, true); } break; }
    case 'clear': snap(); put('', true); break;
    case 'dsave': { const t = ta(); if (t && t.value.trim()) { const d = J('drafts', []); d.unshift({ t: t.value, at: Date.now() }); W('drafts', d.slice(0, 20)); draftsPanel(); } break; }
    case 'duse': { const d = J('drafts', []); if (d[i]) { snap(); put(d[i].t, true); close(); } break; }
    case 'ddel': { const d = J('drafts', []); d.splice(i, 1); W('drafts', d); draftsPanel(); break; }
    case 'ssave': { const x = (document.getElementById('pp-sn') as HTMLInputElement).value.trim() || ta()?.value.trim() || ''; if (x) { W('snips', [x, ...J('snips', SNIP0)].slice(0, 30)); snipPanel(); } break; }
    case 'suse': { const s = J('snips', SNIP0); if (s[i]) { snap(); put(s[i]); } break; }
    case 'sdel': { const s = J('snips', SNIP0); s.splice(i, 1); W('snips', s); snipPanel(); break; }
    case 'sset': { const t = ta(); const w = new Date((document.getElementById('pp-when') as HTMLInputElement).value).getTime(); if (!t || !t.value.trim()) { h.toast('Write your post first.', true); break; } if (!(w > Date.now())) { h.toast('Pick a time in the future.', true); break; } W('sched', [...sch(), { at: w, t: t.value, m: h.me() }]); h.toast('Scheduled for ' + new Date(w).toLocaleString()); schedPanel(); break; }
    case 'sdrop': { const l = sch().filter(x => x.at > 0); l.splice(i, 1); W('sched', l); schedPanel(); break; }
    default: return false;
  }
  e.stopPropagation(); return true;
}
export function onKey(e: KeyboardEvent) { if (e.key === 'Enter' && (e.target as HTMLElement)?.id === 'pp-gq') { e.preventDefault(); G.q = (e.target as HTMLInputElement).value.trim() || 'trending'; void gifLoad(true); return; } if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && (e.target as HTMLElement)?.id === 'sc-txt') { e.preventDefault(); h.post(); } }
export function onInput(e: Event) { const t = e.target as HTMLElement; if (t.id === 'pp-eq') { const v = (t as HTMLInputElement).value; emojiPanel(v); const n = document.getElementById('pp-eq') as HTMLInputElement | null; if (n) { n.focus(); n.setSelectionRange(v.length, v.length); } } if (t.id === 'pp-gq') { /* search on enter */ } const st = document.getElementById('pp-st'); if (st && ta()) st.textContent = wordStats(ta()!.value); }
export function onPaste(e: ClipboardEvent) { if ((e.target as HTMLElement)?.id !== 'sc-txt') return; const f = Array.from(e.clipboardData?.files || []).find(x => x.type.startsWith('image/')); if (f) { e.preventDefault(); void h.upload(f); } }
export function onDrop(e: DragEvent) { if (!(e.target as HTMLElement)?.closest?.('#sc-comp')) return; const f = Array.from(e.dataTransfer?.files || []).find(x => x.type.startsWith('image/')); if (f) { e.preventDefault(); void h.upload(f); } }

const REOPEN: Record<string, () => void> = { GIFs: () => gifPanel(), Emoji: () => emojiPanel(), 'Saved drafts': () => draftsPanel(), Snippets: () => snipPanel(), Schedule: () => schedPanel(), Preview: () => previewPanel(), 'Writing tools': () => morePanel() };
export function isOpen() { return !!document.querySelector('.pp-pn'); }
export function restore() { const w = curP; if (w && !document.querySelector('.pp-pn') && document.getElementById('pp-bar') && REOPEN[w]) { REOPEN[w](); } }
