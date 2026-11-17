// NFT toolkit: pure, tested logic for discovery, selling, creators, holding, safety and sharing.
// Nothing here sends a transaction. Features that need history (floor change, price charts, rarity from a full collection)
// work from the NFTs and sales the wallet has seen; they say so in their output ("basis") instead of guessing.
export interface Meta { name?: string; collection?: string; attrs?: Array<{ trait_type: string; value: string }>; image?: string }
export interface It { id: string; owner?: string; issuer?: string; taxon?: number; serial?: number; meta?: Meta }
export interface Listing { id: string; nft: string; price: number; seller?: string; created?: number; expires?: number }
export interface Sale { nft: string; price: number; ms: number; buyer?: string; seller?: string; coll?: string }

// 1. rarity score and rank (rare trait values score higher: sum of 1/frequency)
export function rarity(items: It[]): Map<string, { score: number; rank: number; pct: number }> {
  const freq = new Map<string, number>(), n = items.length;
  for (const i of items) for (const a of i.meta?.attrs || []) { const k = a.trait_type + '\u0000' + a.value; freq.set(k, (freq.get(k) || 0) + 1); }
  const sc = items.map(i => ({ id: i.id, s: (i.meta?.attrs || []).reduce((t, a) => t + n / (freq.get(a.trait_type + '\u0000' + a.value) || n), 0) }));
  sc.sort((a, b) => b.s - a.s || a.id.localeCompare(b.id));
  const out = new Map<string, { score: number; rank: number; pct: number }>();
  sc.forEach((x, r) => out.set(x.id, { score: +x.s.toFixed(3), rank: r + 1, pct: n ? +(((r + 1) / n) * 100).toFixed(1) : 0 }));
  return out;
}
// 2. trait filters with counts
export function traitCounts(items: It[]): Record<string, Record<string, number>> {
  const o: Record<string, Record<string, number>> = {};
  for (const i of items) for (const a of i.meta?.attrs || []) { (o[a.trait_type] ||= {})[a.value] = (o[a.trait_type]?.[a.value] || 0) + 1; }
  return o;
}
export const filterTraits = (items: It[], want: Record<string, string[]>) => items.filter(i => Object.entries(want).every(([t, vs]) => !vs.length || (i.meta?.attrs || []).some(a => a.trait_type === t && vs.includes(a.value))));
// 3. sweep the floor: the N cheapest listings, optionally inside a budget
export function sweep(ls: Listing[], n: number, budget = Infinity): { pick: Listing[]; total: number; skipped: number } {
  const s = [...ls].sort((a, b) => a.price - b.price), pick: Listing[] = []; let total = 0;
  for (const l of s) { if (pick.length >= n) break; if (total + l.price > budget) continue; pick.push(l); total += l.price; }
  return { pick, total: +total.toFixed(6), skipped: Math.min(n, s.length) - pick.length };
}
// 4/5. floor, change and price history from sales
export const floorOf = (ls: Listing[]) => ls.length ? Math.min(...ls.map(l => l.price)) : null;
export function priceSeries(sales: Sale[], bucketMs = 864e5): Array<{ t: number; avg: number; n: number }> {
  const b = new Map<number, number[]>(); for (const s of sales) { const k = Math.floor(s.ms / bucketMs) * bucketMs; (b.get(k) || b.set(k, []).get(k)!).push(s.price); }
  return [...b].sort((x, y) => x[0] - y[0]).map(([t, v]) => ({ t, avg: +(v.reduce((a, c) => a + c, 0) / v.length).toFixed(6), n: v.length }));
}
export function changePct(sales: Sale[], now: number, windowMs: number): number | null {
  const cur = sales.filter(s => s.ms > now - windowMs), prev = sales.filter(s => s.ms <= now - windowMs && s.ms > now - 2 * windowMs);
  if (!cur.length || !prev.length) return null; const m = (a: Sale[]) => a.reduce((t, s) => t + s.price, 0) / a.length;
  return +(((m(cur) - m(prev)) / m(prev)) * 100).toFixed(2);
}
// 6. similar items by shared traits
export function similar(target: It, pool: It[], k = 6): It[] {
  const t = new Set((target.meta?.attrs || []).map(a => a.trait_type + '=' + a.value));
  return pool.filter(p => p.id !== target.id).map(p => ({ p, s: (p.meta?.attrs || []).filter(a => t.has(a.trait_type + '=' + a.value)).length })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.p.id.localeCompare(b.p.id)).slice(0, k).map(x => x.p);
}
// 7. saved searches
export interface Saved { q?: string; max?: number; traits?: Record<string, string[]>; coll?: string }
export const matchesSaved = (s: Saved, i: It, price: number | null) => (!s.q || ((i.meta?.name || '') + ' ' + (i.meta?.collection || '')).toLowerCase().includes(s.q.toLowerCase())) && (s.max == null || (price != null && price <= s.max)) && (!s.coll || i.issuer + ':' + i.taxon === s.coll) && filterTraits([i], s.traits || {}).length === 1;
// 8. tickers
export const recent = <T extends { ms?: number; created?: number }>(a: T[], n = 10) => [...a].sort((x, y) => (y.ms ?? y.created ?? 0) - (x.ms ?? x.created ?? 0)).slice(0, n);
// 9. compare two
export function compare(a: It, b: It, r?: Map<string, { rank: number }>) {
  const A = new Set((a.meta?.attrs || []).map(x => x.trait_type + '=' + x.value)), B = new Set((b.meta?.attrs || []).map(x => x.trait_type + '=' + x.value));
  return { shared: [...A].filter(x => B.has(x)), onlyA: [...A].filter(x => !B.has(x)), onlyB: [...B].filter(x => !A.has(x)), rankA: r?.get(a.id)?.rank ?? null, rankB: r?.get(b.id)?.rank ?? null };
}
// 10. collection leaderboard
export function leaderboard(sales: Sale[], now: number, windowMs = 864e5 * 7) {
  const m = new Map<string, { coll: string; volume: number; sales: number; high: number }>();
  for (const s of sales) { if (s.ms <= now - windowMs || !s.coll) continue; const e = m.get(s.coll) || { coll: s.coll, volume: 0, sales: 0, high: 0 }; e.volume += s.price; e.sales++; e.high = Math.max(e.high, s.price); m.set(s.coll, e); }
  return [...m.values()].map(e => ({ ...e, volume: +e.volume.toFixed(6) })).sort((a, b) => b.volume - a.volume);
}
// 11. suggested price from floor, rarity percentile (lower pct = rarer) and last sale
export function suggestPrice(floor: number | null, rarityPct: number | null, lastSale: number | null): { price: number | null; basis: string } {
  if (floor == null && lastSale == null) return { price: null, basis: 'No floor or past sale to base a price on.' };
  const base = floor ?? lastSale!; const mult = rarityPct == null ? 1 : rarityPct <= 1 ? 3 : rarityPct <= 5 ? 2 : rarityPct <= 10 ? 1.5 : rarityPct <= 25 ? 1.15 : rarityPct >= 75 ? 0.95 : 1;
  const blended = floor != null && lastSale != null ? (base * mult * 0.7 + lastSale * 0.3) : base * mult;
  return { price: +blended.toFixed(6), basis: `${floor != null ? 'floor ' + floor : 'last sale ' + lastSale}${rarityPct != null ? ', top ' + rarityPct + '% rarity' : ''}${floor != null && lastSale != null ? ', blended with the last sale' : ''}` };
}
// 12. expiry
export const expiryState = (exp: number | undefined, now: number, soonMs = 864e5) => exp == null ? 'none' : exp <= now ? 'expired' : exp - now <= soonMs ? 'soon' : 'live';
// 13. bundle
export const bundle = (prices: number[], discountPct = 0) => { const sum = prices.reduce((a, c) => a + c, 0); return { sum: +sum.toFixed(6), price: +(sum * (1 - discountPct / 100)).toFixed(6) }; };
// 14. Dutch auction
export function dutchPrice(start: number, end: number, t0: number, t1: number, now: number): number { if (now <= t0) return start; if (now >= t1) return end; return +(start + (end - start) * ((now - t0) / (t1 - t0))).toFixed(6); }
// 15. English auction with a reserve (bids placed as on-chain offers; the seller accepts the winner)
export function auction(bids: Array<{ from: string; amt: number; ms: number }>, reserve: number, endsAt: number, now: number) {
  const valid = bids.filter(b => b.ms <= endsAt).sort((a, b) => b.amt - a.amt || a.ms - b.ms), top = valid[0] || null;
  return { state: now < endsAt ? 'open' : !top ? 'ended-no-bids' : top.amt >= reserve ? 'sold' : 'reserve-not-met', winner: now >= endsAt && top && top.amt >= reserve ? top : null, top, minNext: top ? +(top.amt * 1.05).toFixed(6) : reserve };
}
// 16/17. offers inbox
export function classifyOffer(amt: number, floor: number | null, lastSale: number | null): { tag: 'low' | 'fair' | 'high' | 'unknown'; counter: number | null } {
  const ref = floor ?? lastSale; if (ref == null) return { tag: 'unknown', counter: null };
  const r = amt / ref; return { tag: r < 0.7 ? 'low' : r < 1.1 ? 'fair' : 'high', counter: r < 1.1 ? +(ref * 1.05).toFixed(6) : null };
}
export const collectionOffer = (offers: Array<{ amt: number; coll: string }>, coll: string) => offers.filter(o => o.coll === coll).sort((a, b) => b.amt - a.amt)[0] || null;
// 18. auto-lower rule: price after N intervals, never below the hard minimum
export const autoLower = (start: number, stepPct: number, min: number, intervals: number) => { let p = start; for (let i = 0; i < intervals; i++) p = Math.max(min, p * (1 - stepPct / 100)); return +Math.max(min, p).toFixed(6); };
// 19. batch list from CSV: id,price[,days]
export function parseBatch(csv: string, owned: Set<string>): { ok: Array<{ id: string; price: number; days?: number }>; bad: string[] } {
  const ok: Array<{ id: string; price: number; days?: number }> = [], bad: string[] = [], seen = new Set<string>();
  csv.split(/\r?\n/).forEach((ln, i) => { if (!ln.trim() || (i === 0 && /^id\s*,/i.test(ln))) return; const [id, p, d] = ln.split(',').map(x => x.trim()); const price = Number(p);
    if (!/^[0-9A-Fa-f]{64}$/.test(id || '')) bad.push(`line ${i + 1}: not an NFT id`); else if (!owned.has(id.toUpperCase()) && !owned.has(id)) bad.push(`line ${i + 1}: you do not own this NFT`); else if (!(price > 0)) bad.push(`line ${i + 1}: price must be above 0`); else if (seen.has(id.toUpperCase())) bad.push(`line ${i + 1}: listed twice`); else { seen.add(id.toUpperCase()); ok.push({ id, price, ...(d ? { days: Number(d) } : {}) }); } });
  return { ok, bad };
}
// 20. sale proceeds breakdown (fees in basis points; royalty is the NFT's fee out of 50000 = 50%)
export function proceeds(price: number, marketFeeBp: number, royaltyField: number) { const fee = price * marketFeeBp / 1e4, roy = price * (royaltyField / 1000) / 100; return { price, fee: +fee.toFixed(6), royalty: +roy.toFixed(6), net: +(price - fee - roy).toFixed(6) }; }
// 21. royalty setting check and earnings report (royaltyField 0..50000 in 1/1000 %)
export const royaltyPct = (f: number) => f / 1000;
export const royaltyValid = (pct: number) => pct >= 0 && pct <= 50 && Math.round(pct * 1000) === pct * 1000;
export function earnings(sales: Sale[], royaltyField: number, mine: (s: Sale) => boolean) { const rows = sales.filter(mine).map(s => ({ ms: s.ms, nft: s.nft, price: s.price, royalty: +(s.price * royaltyField / 1e5).toFixed(6) })); return { rows, total: +rows.reduce((t, r) => t + r.royalty, 0).toFixed(6) }; }
// 22/23. mint phases (allowlist first, public later) and countdown
export interface Phase { name: string; start: number; end: number; allow?: string[]; price: number; cap?: number }
export function phaseAt(phases: Phase[], now: number, addr: string): { phase: Phase | null; can: boolean; why: string; next: Phase | null } {
  const cur = phases.find(p => now >= p.start && now < p.end) || null, next = phases.filter(p => p.start > now).sort((a, b) => a.start - b.start)[0] || null;
  if (!cur) return { phase: null, can: false, why: next ? `Minting opens in ${countdown(next.start - now)}.` : 'Minting is closed.', next };
  if (cur.allow && !cur.allow.includes(addr)) return { phase: cur, can: false, why: `${cur.name} is for the allowlist only.`, next };
  return { phase: cur, can: true, why: '', next };
}
export const countdown = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`; };
// 24/25/26. lazy mint is a plan only (metadata is stored first, the token is minted at first sale); reveal is deterministic from a seed
export const lazyPlan = (n: number, mintFee = 0.05) => ({ now: 0, atSale: n, note: `Nothing is minted until each first sale; the buyer's sale pays the ${mintFee} mint fee share.` });
export function revealOrder(n: number, seed: string): number[] { const a = [...Array(n).keys()]; let h = 2166136261; for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; const rnd = () => (h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0, h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0, ((h ^= h >>> 16) >>> 0) / 4294967296); for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// 27. trait generator for layered art: unique combinations, weighted, seeded
export function generate(layers: Array<{ name: string; options: Array<{ v: string; w: number }> }>, count: number, seed = 'x') {
  const total = layers.reduce((t, l) => t * l.options.length, 1); if (count > total) return { error: `Only ${total} unique combinations exist for these layers.`, items: [] as Array<Record<string, string>> };
  let h = 2166136261; for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; const rnd = () => ((h = (Math.imul(h, 1664525) + 1013904223) >>> 0) / 4294967296);
  const seen = new Set<string>(), items: Array<Record<string, string>> = []; let guard = 0;
  while (items.length < count && guard++ < count * 200 + 1000) { const it: Record<string, string> = {}; for (const l of layers) { const sw = l.options.reduce((t, o) => t + o.w, 0); let r = rnd() * sw; for (const o of l.options) { r -= o.w; if (r <= 0) { it[l.name] = o.v; break; } } it[l.name] ||= l.options[l.options.length - 1].v; } const k = JSON.stringify(it); if (!seen.has(k)) { seen.add(k); items.push(it); } }
  return { error: items.length < count ? 'Could not find enough unique combinations with these weights; flatten the weights.' : '', items };
}
// 28. per-wallet mint cap
export const mintAllowance = (cap: number, minted: Record<string, number>, addr: string, want = 1) => { const left = Math.max(0, cap - (minted[addr] || 0)); return { left, ok: want <= left, why: want <= left ? '' : `This wallet may mint ${cap} in total and has ${left} left.` }; };
// 29. verification badge: a collection is verified when the operator list names it
export const verified = (key: string, list: string[]) => list.includes(key);
// 30. airdrop plan (dry run): who gets what, who is skipped
export function airdropPlan(holders: string[], nfts: string[], valid: (a: string) => boolean) { const to = [...new Set(holders)].filter(valid), skipped = holders.filter(h => !valid(h)); const n = Math.min(to.length, nfts.length); return { sends: to.slice(0, n).map((a, i) => ({ to: a, nft: nfts[i] })), skipped, unmatchedNfts: nfts.length - n, unmatchedHolders: to.length - n }; }
// 31/32. portfolio value and cost basis
export function portfolio(items: It[], floorOfItem: (i: It) => number | null, cost: Record<string, number>) {
  let value = 0, basis = 0, priced = 0; const rows = items.map(i => { const f = floorOfItem(i), c = cost[i.id] ?? null; if (f != null) { value += f; priced++; } if (c != null) basis += c; return { id: i.id, value: f, cost: c, gain: f != null && c != null ? +(f - c).toFixed(6) : null }; });
  return { rows, value: +value.toFixed(6), cost: +basis.toFixed(6), gain: +(value - basis).toFixed(6), priced, unpriced: items.length - priced };
}
// 33. spam score: unknown sender + no metadata + link-y names
export function spamScore(i: It, knownCollections: Set<string>): number { let s = 0; if (!(i.issuer && knownCollections.has(i.issuer + ':' + i.taxon))) s += 1; if (!i.meta?.name) s += 1; if (/(https?:|www\.|claim|airdrop|free|\.com|\.io)/i.test((i.meta?.name || '') + ' ' + (i.meta?.collection || ''))) s += 2; return s; }
// 34. folders and tags
export const tagMap = (m: Record<string, string[]>, id: string, tag: string, on: boolean) => { const t = new Set(m[id] || []); on ? t.add(tag) : t.delete(tag); return { ...m, [id]: [...t].sort() }; };
export const byTag = (m: Record<string, string[]>, tag: string) => Object.keys(m).filter(id => m[id].includes(tag));
// 36. wishlist price alerts
export const wishHits = (wish: Array<{ id: string; max: number }>, ls: Listing[]) => wish.map(w => ({ w, l: ls.filter(l => l.nft === w.id && l.price <= w.max).sort((a, b) => a.price - b.price)[0] })).filter(x => x.l).map(x => ({ id: x.w.id, price: x.l!.price, max: x.w.max, offer: x.l!.id }));
// 37. transfer safety check
export function transferCheck(to: string, from: string, valid: (a: string) => boolean, known: string[], flagged: string[], transferable: boolean) {
  const p: string[] = [], w: string[] = []; if (!valid(to)) p.push('That is not a valid address.'); if (to === from) p.push('You are sending it to yourself.'); if (!transferable) p.push('This NFT is marked non-transferable.'); if (flagged.includes(to)) p.push('This address is on the operator warning list.'); if (valid(to) && !known.includes(to)) w.push('You have not sent to this address before.');
  return { ok: !p.length, problems: p, warnings: w };
}
// 38. bulk burn guard: the word to type depends on the count and any listed/valuable items
export const burnGuard = (n: number, anyValuable: boolean) => n >= 5 || anyValuable ? `BURN ${n}` : '';
// 39. metadata/image health
export function metaHealth(m: Meta | undefined, imgBytes?: number) { const p: string[] = []; if (!m) return { ok: false, problems: ['Metadata could not be read.'] }; if (!m.name) p.push('No name.'); if (!m.image) p.push('No image link.'); else if (/^http:\/\//i.test(m.image)) p.push('Image is on an unsecured http link.'); else if (!/^(ipfs:|https:|data:)/i.test(m.image)) p.push('Image link has an unknown type.'); if (imgBytes === 0) p.push('The image is empty.'); if (!(m.attrs || []).length) p.push('No traits.'); return { ok: !p.length, problems: p }; }
// 40. provenance timeline
export function provenance(id: string, events: Array<{ nft: string; kind: string; from?: string; to?: string; price?: number; ms: number }>) { return events.filter(e => e.nft === id).sort((a, b) => a.ms - b.ms).map(e => ({ ms: e.ms, text: e.kind === 'mint' ? `Minted by ${e.to}` : e.kind === 'sale' ? `Sold by ${e.from} to ${e.to} for ${e.price}` : e.kind === 'burn' ? 'Burned' : `${e.kind} ${e.from || ''} → ${e.to || ''}`.trim() })); }
// 41. impersonation: a new name too close to a verified one (edit distance)
export const lev = (a: string, b: string) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
export function impersonates(name: string, verifiedNames: string[]): string | null { const n = name.trim().toLowerCase(); if (!n) return null; for (const v of verifiedNames) { const x = v.toLowerCase(); if (n === x) continue; if (lev(n, x) <= Math.max(1, Math.floor(x.length / 6)) || (n.includes(x) && n.length > x.length)) return v; } return null; }
// 42. counterfeit check: average hash of an 8x8 grayscale image (64 numbers) compared by Hamming distance
export const ahash = (g: number[]) => { const m = g.reduce((a, c) => a + c, 0) / g.length; return g.map(v => v >= m ? '1' : '0').join(''); };
export const hamming = (a: string, b: string) => { let d = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) d++; return d + Math.abs(a.length - b.length); };
export const looksCopied = (h: string, known: Array<{ h: string; id: string }>, maxDist = 4) => known.map(k => ({ id: k.id, d: hamming(h, k.h) })).filter(x => x.d <= maxDist).sort((a, b) => a.d - b.d)[0] || null;
// 43. flagged collections
export const flagged = (key: string, flaggedList: string[]) => flaggedList.includes(key);
// 44. plain-words preview of an NFT transaction
export function nftWords(tx: any, nm: (id: string) => string = id => id.slice(0, 8) + '…'): string {
  const amt = (a: any) => a == null ? '' : typeof a === 'string' ? `${Number(a) / 1e6} LUMA` : `${a.value} ${a.currency}`;
  switch (tx.TransactionType) {
    case 'NFTokenMint': return `Create a new NFT${tx.TransferFee ? ` with a ${tx.TransferFee / 1000}% creator royalty` : ''}.`;
    case 'NFTokenBurn': return `Destroy ${nm(tx.NFTokenID)} forever. It cannot be recovered.`;
    case 'NFTokenCreateOffer': return tx.Flags & 1 ? (Number(tx.Amount) === 0 && tx.Destination ? `Offer ${nm(tx.NFTokenID)} as a free transfer to ${tx.Destination}. Only they can accept.` : `List ${nm(tx.NFTokenID)} for sale at ${amt(tx.Amount)}.`) : `Offer ${amt(tx.Amount)} to buy ${nm(tx.NFTokenID)}. Nothing moves until the owner accepts.`;
    case 'NFTokenAcceptOffer': return tx.NFTokenSellOffer ? 'Buy the NFT at the listed price. Royalties are paid automatically.' : 'Sell your NFT to the buyer at their offered price.';
    case 'NFTokenCancelOffer': return 'Cancel your offer. It costs only the network fee.';
    default: return 'Not an NFT transaction.';
  }
}
// 45. wash trading: the same two wallets trading back and forth, or one wallet on both sides
export function washFlags(sales: Sale[]): Array<{ nft: string; why: string }> {
  const out: Array<{ nft: string; why: string }> = [], by = new Map<string, Sale[]>(); for (const s of sales) (by.get(s.nft) || by.set(s.nft, []).get(s.nft)!).push(s);
  for (const [nft, ss] of by) { ss.sort((a, b) => a.ms - b.ms); if (ss.some(s => s.buyer && s.buyer === s.seller)) out.push({ nft, why: 'Same wallet on both sides.' }); else for (let i = 2; i < ss.length; i++) if (ss[i].buyer && ss[i].buyer === ss[i - 2].buyer && ss[i].seller === ss[i - 2].seller) { out.push({ nft, why: 'The same two wallets keep trading it back and forth.' }); break; } }
  return out;
}
// 46/47. share card and embed
export const shareText = (name: string, price: string | null, url: string) => `${name}${price ? ' · ' + price : ''}\n${url}`;
export const embedSnippet = (url: string, w = 320, h = 420) => `<iframe src="${url.replace(/"/g, '')}" width="${w}" height="${h}" style="border:0;border-radius:12px" loading="lazy" title="NFT listing"></iframe>`;
// 48. activity feed of followed wallets
export const feed = (events: Array<{ who: string; kind: string; nft: string; ms: number }>, follows: string[], n = 30) => events.filter(e => follows.includes(e.who)).sort((a, b) => b.ms - a.ms).slice(0, n);
// 49. NFT-gated perks
export const gated = (held: It[], rule: { issuer: string; taxon?: number; min?: number }) => { const c = held.filter(i => i.issuer === rule.issuer && (rule.taxon == null || i.taxon === rule.taxon)).length; return { ok: c >= (rule.min ?? 1), have: c }; };
// 50. cross-chain view of bridged NFTs
export function bridgeView(items: Array<{ id: string; dir: string; state: string; name?: string }>) { const label: Record<string, string> = { done: 'Arrived', offered: 'Waiting for you to accept', released: 'Original ready to accept', refunded: 'Returned', failed: 'Failed' }; return items.map(i => ({ ...i, way: i.dir === 'in' ? 'XRPL → LUMA' : 'LUMA → XRPL', label: label[i.state] || (/attention|approval/.test(i.state) ? 'Needs the operator' : 'In progress') })); }
