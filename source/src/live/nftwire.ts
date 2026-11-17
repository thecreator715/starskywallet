// Puts the NFT toolkit (nftplus.ts) onto the existing NFT pages: rarity, spam hiding, tags, portfolio value, and on each NFT's page
// provenance, similar items, safety notes and a share card. It only reads what the page already loaded; nothing is sent.
import { ctx } from './ctx.ts';
import { esc } from './util.ts';
import { NF } from './nft.ts';
import * as N from './nftplus.ts';

const KT = 'starsky.x.nfttags', KS = 'starsky.x.nftspam', KC = 'starsky.x.nftcost';
const rd = (k: string, d: any) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const wr = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const $ = (id: string) => document.getElementById(id);
const collKey = (i: any) => i.issuer + ':' + i.taxon;
const adapt = (i: any): N.It => { const m = NF.meta.get(i.id); return { id: i.id, owner: i.owner, issuer: i.issuer, taxon: i.taxon, serial: i.serial, meta: m ? { name: m.name, collection: m.coll, image: m.image, attrs: (m.attrs || []).map((a: any) => ({ trait_type: a.k, value: a.v })) } : undefined }; };
const byColl = () => { const m = new Map<string, any[]>(); for (const i of NF.items as any[]) (m.get(collKey(i)) || m.set(collKey(i), []).get(collKey(i))!).push(i); return m; };
const listings = (): N.Listing[] => (NF.offers as any[]).filter(o => o.sell && !o.dest && o.amt?.native && (!o.exp || o.exp > Date.now() / 1000 - 946684800)).map(o => ({ id: o.id, nft: o.nft, price: o.amt.v, seller: o.owner }));
const floorColl = (k: string) => { const ids = new Set((byColl().get(k) || []).map(i => i.id)); return N.floorOf(listings().filter(l => ids.has(l.nft))); };
const known = () => new Set([...byColl()].filter(([, v]) => v.length >= 3).map(([k]) => k));
const rankCache = new Map<string, Map<string, any>>();
function ranks(k: string) { const g = byColl().get(k) || []; const sig = g.map(i => i.id + (NF.meta.get(i.id) ? 1 : 0)).join(); const c = rankCache.get(k); if ((c as any)?.sig === sig) return c!; const withAttrs = g.filter(i => NF.meta.get(i.id)?.attrs?.length); const m: any = withAttrs.length >= 5 ? N.rarity(withAttrs.map(adapt)) : new Map(); m.sig = sig; rankCache.set(k, m); return m; }
const tagsOf = () => rd(KT, {}) as Record<string, string[]>;

let busy = false;
function enhanceMine() {
  const host = $('mn_owned'); if (!host || busy) return; busy = true;
  try {
    const acc = ctx.account(), mine = (NF.items as any[]).filter(i => i.owner === acc), kn = known(), hideSpam = rd(KS, true), tags = tagsOf(), tagSel = (window as any).__xnwTag || '';
    const spam = new Set(mine.filter(i => N.spamScore(adapt(i), kn) >= 3 && !(NF.meta.get(i.id)?.name && kn.has(collKey(i)))).map(i => i.id));
    let bar = $('xnw_bar'); if (!bar) { bar = document.createElement('div'); bar.id = 'xnw_bar'; bar.style.cssText = 'margin:.2rem 0 .6rem;font-size:.82rem'; host.parentElement!.insertBefore(bar, host); }
    const cost = rd(KC, {}) as Record<string, number>, pf = N.portfolio(mine.map(adapt), i => floorColl(i.issuer + ':' + i.taxon), cost), allTags = [...new Set(Object.values(tags).flat())];
    bar.innerHTML = `<div class="mut">Worth about <b>${esc(pf.value.toLocaleString('en', { maximumFractionDigits: 4 }))} ${esc(ctx.native())}</b> at each collection's lowest ${esc(ctx.native())} listing (${pf.priced} of ${mine.length} priced${pf.cost ? '; cost ' + esc(String(pf.cost)) + ', change ' + esc(String(pf.gain)) : ''}). Collections with no ${esc(ctx.native())} listing are not counted.</div>
    <div class="row" style="gap:.8rem;align-items:center;flex-wrap:wrap;margin-top:.3rem">${spam.size ? `<label><input type="checkbox" ${hideSpam ? 'checked' : ''} onchange="window.xnw.spam(this.checked)"> Hide ${spam.size} possible spam NFT${spam.size === 1 ? '' : 's'}</label>` : ''}${allTags.length ? `<label>Tag <select onchange="window.xnw.tag(this.value)"><option value="">All</option>${allTags.map(t => `<option ${t === tagSel ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` : ''}</div>`;
    host.querySelectorAll<HTMLElement>('.nfcard').forEach(card => {
      const id = (card.getAttribute('onclick') || '').match(/'([0-9A-Fa-f]{64})'/)?.[1]; if (!id) return; const it = mine.find(i => i.id === id); if (!it) return;
      const isSpam = spam.has(id), tg = tags[id] || [], rk = ranks(collKey(it)).get(id);
      card.style.display = (isSpam && hideSpam) || (tagSel && !tg.includes(tagSel)) ? 'none' : '';
      card.querySelector('.xnw_b')?.remove(); const b = document.createElement('div'); b.className = 'xnw_b'; b.style.cssText = 'font-size:.7rem;padding:.2rem .4rem;display:flex;gap:.3rem;flex-wrap:wrap;align-items:center';
      b.innerHTML = `${rk ? `<span class="chip" title="Rarity within the ${(byColl().get(collKey(it)) || []).length} NFTs of this collection this wallet has seen">Rarity #${rk.rank}</span>` : ''}${isSpam ? '<span class="chip" style="color:var(--crit)">Possible spam</span>' : ''}${tg.map(t => `<span class="chip">${esc(t)}</span>`).join('')}<a href="#" onclick="event.stopPropagation();window.xnw.addTag('${id}');return false" class="mut">+ tag</a>`;
      card.appendChild(b);
    });
  } finally { setTimeout(() => { busy = false; }, 0); }
}
function enhanceDetail() {
  const d = $('ndp'); if (!d) return; const id = d.getAttribute('data-id') || (d.innerHTML.match(/[0-9A-Fa-f]{64}/) || [])[0]; if (!id || $('xnd')?.getAttribute('data-for') === id) return;
  const it = (NF.items as any[]).find(i => i.id.toUpperCase() === String(id).toUpperCase()); if (!it) return;
  const all = byColl().get(collKey(it)) || [], rk = ranks(collKey(it)).get(it.id), a = adapt(it), sim = N.similar(a, all.map(adapt), 6);
  const acts = ([...(NF.act || []), ...(NF.hist || [])] as any[]).filter(x => x.nft === it.id), seen = new Set<string>();
  const prov = N.provenance(it.id, acts.filter(x => { const k = x.hash || x.seq + x.type; if (seen.has(k)) return false; seen.add(k); return true; }).map(x => ({ nft: x.nft, kind: x.sale ? 'sale' : /Mint/.test(x.type) ? 'mint' : /Burn/.test(x.type) ? 'burn' : x.type.replace('NFToken', '').toLowerCase(), from: x.from, to: x.to, price: x.amt, ms: x.ms })) as any);
  const sales = acts.filter(x => x.sale && x.amtN != null).map(x => ({ nft: x.nft, price: x.amtN, ms: x.ms, buyer: x.to, seller: x.from })), wash = N.washFlags(sales);
  const big = [...byColl()].filter(([k, v]) => k !== collKey(it) && v.length >= 5).map(([k]) => NF.meta.get((byColl().get(k) || [])[0]?.id)?.coll).filter(Boolean) as string[];
  const imp = a.meta?.collection ? N.impersonates(a.meta.collection, big) : null, health = N.metaHealth(a.meta as any), fl = floorColl(collKey(it));
  const notes: string[] = []; if (imp) notes.push(`The collection name is very close to "${imp}", a larger collection here. Check the creator before you buy.`); wash.forEach(w => notes.push('Possible wash trading: ' + w.why)); if (!health.ok) health.problems.forEach(p => notes.push('Metadata: ' + p));
  const el = document.createElement('div'); el.id = 'xnd'; el.setAttribute('data-for', id); el.className = 'card'; el.style.marginTop = '.8rem';
  el.innerHTML = `<div class="k" style="margin:0">More about this NFT</div>${rk ? `<div style="font-size:.85rem;margin-top:.3rem">Rarity rank <b>#${rk.rank}</b> of ${all.length} (score ${rk.score}). Based on the NFTs of this collection this wallet has loaded.</div>` : '<div class="mut" style="font-size:.8rem;margin-top:.3rem">Rarity needs at least 5 collection NFTs with traits loaded.</div>'}${fl != null ? `<div style="font-size:.85rem">Collection floor ${fl} ${esc(ctx.native())}.</div>` : ''}${notes.map(n => `<div style="font-size:.82rem;color:var(--crit)">⚠ ${esc(n)}</div>`).join('')}
  ${sim.length ? `<div style="margin-top:.5rem;font-size:.82rem">Similar: ${sim.map(s => `<a href="#" onclick="window.nm.open('${s.id}');return false">${esc(s.meta?.name || s.id.slice(0, 8))}</a>`).join(' · ')}</div>` : ''}
  <details style="margin-top:.5rem"><summary class="mut" style="cursor:pointer;font-size:.82rem">History (${prov.length})</summary>${prov.map(p => `<div style="font-size:.8rem">${esc(new Date(p.ms).toLocaleString())}: ${esc(p.text)}</div>`).join('') || '<div class="mut" style="font-size:.8rem">No recent activity seen. History covers the last ~120 ledgers and your own transactions.</div>'}</details>
  <div class="row" style="gap:.5rem;margin-top:.5rem"><button class="sm" onclick="window.xnw.share('${id}')">Copy share text</button></div>`;
  d.appendChild(el);
}
export const xnw = {
  run() { enhanceMine(); enhanceDetail(); },
  spam(on: boolean) { wr(KS, on); enhanceMine(); }, tag(t: string) { (window as any).__xnwTag = t; enhanceMine(); },
  addTag(id: string) { const t = prompt('Tag for this NFT (for example: keep, sell, art). Leave empty to remove tags.'); if (t == null) return; const m = tagsOf(); wr(KT, t.trim() ? N.tagMap(m, id, t.trim().slice(0, 20), true) : { ...m, [id]: [] }); enhanceMine(); },
  share(id: string) { const it = (NF.items as any[]).find(i => i.id === id), nmx = NF.meta.get(id)?.name || 'NFT'; const o = (NF.offers as any[]).find(x => x.nft === id && x.sell && !x.dest); const t = N.shareText(nmx, o?.amt?.native ? `${o.amt.v} ${ctx.native()}` : null, location.href.split('#')[0] + '#nft=' + id); try { navigator.clipboard.writeText(t); ctx.toast('Copied'); } catch { ctx.toast(t); } void it; },
};
let ob: MutationObserver | null = null;
export function onRender(tab: string) {
  if (tab !== 'nfts' && tab !== 'nftmarket') return; (window as any).xnw = xnw; (window as any).__nftState = NF; (window as any).__nftAcct = () => ctx.account();
  if (ob) return; const root = document.body;
  ob = new MutationObserver(() => { if (busy) return; try { enhanceMine(); enhanceDetail(); } catch {} });
  ob.observe(root, { childList: true, subtree: true }); try { enhanceMine(); enhanceDetail(); } catch {}
}
