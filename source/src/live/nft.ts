// NFT Marketplace + My NFTs. Everything is read from the connected node (XLS-20): pages, offers, sales, history.
// Mint stores the file on IPFS (your own Kubo node, set below); the on-chain URI is the ipfs:// address of the metadata (max 256 bytes).
import * as xrpl from 'xrpl';
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { Asset, akey, esc, fmt, hexName, rippleToMs, short, usd, ago } from './util.ts';
import { cached, pool as poolMap, tryReq, info } from './chain.ts';

const $ = (id: string) => document.getElementById(id);
const setHtml = (id: string, h: string) => {
  const e = $(id) as any;
  if (e && e.__h !== h) {
    e.innerHTML = h;
    e.__h = h;
  }
};
export const MAXFILE = 5 * 1024 * 1024;
const TF_BURN = 1,
  TF_TRANSFER = 8;

export interface Item {
  id: string;
  owner: string;
  issuer: string;
  taxon: number;
  flags: number;
  fee: number;
  serial: number;
  uri: string;
}
export interface Offer {
  id: string;
  nft: string;
  owner: string;
  sell: boolean;
  amt: { native: boolean; cur: string; issuer: string; v: number };
  dest: string;
  exp: number;
}
interface Meta {
  name: string;
  desc: string;
  image: string;
  attrs: { k: string; v: string }[];
  coll: string;
  mime: string;
  cdesc?: string;
  cover?: boolean;
  mint?: any;
  total?: number;
}
interface Act {
  type: string;
  nft: string;
  amt: string;
  amtN: number | null;
  from: string;
  to: string;
  seq: number;
  ms: number;
  hash: string;
  ok: boolean;
  sale: boolean;
}
export const NF: any = {
  items: [] as Item[],
  offers: [] as Offer[],
  act: [] as Act[],
  meta: new Map<string, Meta | null>(),
  offerAmt: new Map<string, Offer['amt']>(),
  px: null as M.Snap | null,
  tab: 'items',
  q: '',
  sort: 'new',
  sdir: -1,
  st: 'all',
  pmin: '',
  pmax: '',
  per: 50,
  csort: 'vol',
  cdir: -1,
  coll: '',
  loadedAt: 0,
  busy: false,
  timer: null,
  hist: [] as Act[],
  histAt: 0,
  loading: false,
  loadStart: 0,
  diag: null as any,
  err: '',
};
const nat = () => ctx.native();
// Same storage node as the LUMA control panel (Kubo): Mainnet API 5001 / gateway 8081, Testnet API 5101 / gateway 8181.
// The browser reaches the API through Starsky's own server (/kubo/main, /kubo/test), so no CORS setup is needed.
// The site's own node address (STARSKY_CONFIG) also serves the node's IPFS gateway under /ipfs/ (see luma-gateway.js), so NFT pictures come from the LUMA node itself.
const siteBase = (test: boolean): string => {
  try {
    const c: any = (window as any).STARSKY_CONFIG || {};
    const u = String((c[test ? 'test' : 'main'] || {}).url || '');
    return /^wss?:\/\//.test(u) ? u.replace(/^ws/, 'http').replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
};
const siteGw = (test: boolean): string => {
  try {
    const c: any = (window as any).STARSKY_CONFIG || {};
    const u = String((c[test ? 'test' : 'main'] || {}).url || '');
    return /^wss?:\/\//.test(u) ? u.replace(/^ws/, 'http').replace(/\/+$/, '') + '/ipfs/' : '';
  } catch {
    return '';
  }
};
const PUBLIC_GW = ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://w3s.link/ipfs/'];
const IP = () => {
  const t = ctx.netKey() === 'test';
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname);
  // On a public site (GitHub Pages, a phone) 127.0.0.1 is the visitor's own device and https pages cannot load http gateways, so read through a public IPFS gateway.
  const d = { api: (local ? location.origin : siteBase(t) || location.origin) + (t ? '/kubo/test' : '/kubo/main'), gw: local ? (t ? 'http://127.0.0.1:8181/ipfs/' : 'http://127.0.0.1:8081/ipfs/') : siteGw(t) || PUBLIC_GW[0] };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem('starsky.ipfs.' + ctx.netKey()) || '{}') };
  } catch {
    return d;
  }
};
const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml'];
async function sniff(f: File): Promise<boolean> {
  const h = new Uint8Array(await f.slice(0, 16).arrayBuffer());
  const t = (a: number, b: number) => String.fromCharCode(...h.slice(a, b));
  switch (f.type) {
    case 'image/png': return h[0] === 0x89 && t(1, 4) === 'PNG';
    case 'image/jpeg': return h[0] === 0xff && h[1] === 0xd8;
    case 'image/gif': return /^GIF8[79]a/.test(t(0, 6));
    case 'image/webp': return t(0, 4) === 'RIFF' && t(8, 12) === 'WEBP';
    case 'image/avif': return t(4, 8) === 'ftyp';
    case 'image/svg+xml': { const x = await f.text(); return /<svg[\s>]/i.test(x) && !/<script|onload\s*=|onerror\s*=|javascript:/i.test(x); }
  }
  return false;
}
const hexToStr = (h: string) => {
  try {
    return new TextDecoder().decode(new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16))));
  } catch {
    return '';
  }
};
const strToHex = (s: string) => Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const resolve = (u: string, gw?: string) => {
  if (!u) return '';
  if (u.startsWith('ipfs://')) return (gw || IP().gw).replace(/\/?$/, '/') + u.slice(7).replace(/^ipfs\//, '');
  return u;
};
const acctOf = (hex40: string) => xrpl.encodeAccountID(new Uint8Array((hex40.match(/../g) || []).map(x => parseInt(x, 16))) as any);
const amtOf = (a: any): Offer['amt'] => (typeof a === 'string' ? { native: true, cur: nat(), issuer: '', v: Number(a) / 1e6 } : { native: false, cur: hexName(a.currency), issuer: a.issuer, v: Number(a.value) });
const priceTxt = (a: Offer['amt']) => (a.v === 0 ? 'free (transfer)' : `${fmt(a.v)} ${a.cur}`);
const priceN = (a: Offer['amt']): number | null => {
  if (a.native) return a.v;
  const sn: M.Snap | null = NF.px;
  const p = sn ? sn.px.get(akey({ c: a.cur.length === 3 ? a.cur : a.cur, i: a.issuer } as Asset)) : null;
  if (p != null) return a.v * p;
  const usdK = sn ? sn.usdKey : null;
  if (sn && usdK && usdK.endsWith('|' + a.issuer)) return sn.usdPerNative ? a.v / sn.usdPerNative : null;
  return null;
};
const usdTxt = (n: number | null) => (n == null || !NF.px || NF.px.usdPerNative == null ? '' : usd(n * NF.px.usdPerNative));
const me = () => ctx.account() || '';
const sh = (a: string) => short(ctx.show(a), 7, 5);
const rnow = () => Math.floor(Date.now() / 1000) - 946684800;
const live = (o: Offer) => !o.exp || o.exp > rnow();

/* ------------------------------ XRPL mode ------------------------------ */
// On XRPL there is no way (and no need) to read every NFT of the ledger. The marketplace shows what was minted through Starsky:
// every mint pays 0.05 XRP to the fee wallet with a memo, and that public payment list is the registry. Listing and buying cost no fee.
export const FEE_WALLET = 'rphatRpwXcPAo7CVm46dC78JAQ6kLMqb2M';
export const MINT_FEE_DROPS = '50000';   // 0.05 XRP per mint
const MEMO_T = 'starsky/mint';
const xr = () => ctx.xrpl();
interface RegEntry { i: string; t: number; u: string; ms: number; hash: string }
const mintedId = (meta: any): string => {
  if (meta && meta.nftoken_id) return String(meta.nftoken_id).toUpperCase();
  for (const n of (meta && meta.AffectedNodes) || []) {
    const d = n.CreatedNode || n.ModifiedNode;
    if (!d || d.LedgerEntryType !== 'NFTokenPage') continue;
    const now = ((d.FinalFields || d.NewFields || {}).NFTokens || []).map((z: any) => String((z.NFToken || z).NFTokenID).toUpperCase());
    const before = new Set((((d.PreviousFields || {}).NFTokens) || []).map((z: any) => String((z.NFToken || z).NFTokenID).toUpperCase()));
    const add = now.filter((x: string) => !before.has(x));
    if (add.length === 1) return add[0];
  }
  return '';
};
async function feeRegistry(): Promise<RegEntry[]> {
  return cached('xreg' + ctx.netKey(), 45000, async () => {
    const out: RegEntry[] = [];
    let marker: any;
    for (let p = 0; p < 8; p++) {
      const r: any = await tryReq('account_tx', { account: FEE_WALLET, limit: 200, ledger_index_min: -1, ledger_index_max: -1, ...(marker ? { marker } : {}) });
      if (!r) break;
      for (const x of r.transactions || []) {
        const t = x.tx_json || x.tx || {};
        const meta = x.meta || x.metaData || {};
        if (t.TransactionType !== 'Payment' || t.Destination !== FEE_WALLET || meta.TransactionResult !== 'tesSUCCESS') continue;
        const paid = Number(typeof meta.delivered_amount === 'string' ? meta.delivered_amount : t.Amount);
        if (!(paid >= Number(MINT_FEE_DROPS))) continue;
        for (const m of t.Memos || []) {
          const mm = m.Memo || {};
          if (hexToStr(mm.MemoType || '') !== MEMO_T) continue;
          try { const j = JSON.parse(hexToStr(mm.MemoData || '')); if (j.i && j.u) out.push({ i: String(j.i), t: Number(j.t || 0), u: String(j.u), ms: t.date != null ? rippleToMs(t.date) : 0, hash: t.hash || x.hash || '' }); } catch {}
        }
      }
      marker = r.marker;
      if (!marker) break;
    }
    return out;
  });
}
/** the mint transactions of every registered issuer whose URI was paid for */
async function registeredMints(reg: RegEntry[]): Promise<{ id: string; issuer: string; uri: string; ms: number; hash: string }[]> {
  const byIssuer = new Map<string, Set<string>>();
  for (const e of reg) { if (!byIssuer.has(e.i)) byIssuer.set(e.i, new Set()); byIssuer.get(e.i)!.add(e.u); }
  const res: { id: string; issuer: string; uri: string; ms: number; hash: string }[] = [];
  await poolMap([...byIssuer.entries()].slice(0, 200), 4, async ([issuer, uris]) => {
    let marker: any;
    for (let p = 0; p < 6; p++) {
      const r: any = await tryReq('account_tx', { account: issuer, limit: 200, ledger_index_min: -1, ledger_index_max: -1, ...(marker ? { marker } : {}) });
      if (!r) break;
      for (const x of r.transactions || []) {
        const t = x.tx_json || x.tx || {};
        const meta = x.meta || x.metaData || {};
        if (t.TransactionType !== 'NFTokenMint' || t.Account !== issuer || meta.TransactionResult !== 'tesSUCCESS') continue;
        const uri = hexToStr(t.URI || '');
        if (!uris.has(uri)) continue;
        const id = mintedId(meta);
        if (id) res.push({ id, issuer, uri, ms: t.date != null ? rippleToMs(t.date) : 0, hash: t.hash || x.hash || '' });
      }
      marker = r.marker;
      if (!marker) break;
    }
  });
  return res;
}
const offerOf = (o: any, nft: string, sell: boolean): Offer => ({ id: o.nft_offer_index, nft, owner: o.owner, sell, amt: amtOf(o.amount), dest: o.destination || '', exp: o.expiration || 0 });
async function xindex(force: boolean) {
  if (NF.loading && Date.now() - (NF.loadStart || 0) < 60000) return;
  if (!force && Date.now() - NF.loadedAt < 8000) return;
  NF.loading = true;
  NF.loadStart = Date.now();
  try {
    const acc = me();
    const reg = await feeRegistry();
    const mints = await registeredMints(reg);
    const map = new Map<string, Item>();
    for (const m of mints) { const it = mkItem(m.id, m.issuer, strToHex(m.uri)); if (it && !map.has(it.id)) map.set(it.id, it); }
    const mineIds = new Set<string>();
    if (acc) for (const n of await nftsOf(acc).catch(() => [])) { const it = mkItem(n.NFTokenID, acc, n.URI); if (it) { map.set(it.id, it); mineIds.add(it.id); } }
    // anything minted by an issuer that still holds it is owned by that issuer; the rest is read from its offers
    const items = [...map.values()];
    const ids = items.map(i => i.id).slice(0, 600);
    const offers: Offer[] = [];
    await poolMap(ids, 8, async id => {
      const [sl, by] = await Promise.all([tryReq('nft_sell_offers', { nft_id: id, ledger_index: 'validated' }), mineIds.has(id) ? tryReq('nft_buy_offers', { nft_id: id, ledger_index: 'validated' }) : Promise.resolve(null)]);
      for (const o of (sl && sl.offers) || []) offers.push(offerOf(o, id, true));
      for (const o of (by && by.offers) || []) offers.push(offerOf(o, id, false));
    });
    for (const it of items) { if (!mineIds.has(it.id)) { const sl = offers.find(o => o.nft === it.id && o.sell); it.owner = sl ? sl.owner : it.issuer; } }
    for (const o of offers) NF.offerAmt.set(o.id, o.amt);
    NF.items = items;
    NF.offers = offers;
    NF.px = null;
    NF.xmints = mints;
    NF.diag = null;
    NF.loadedAt = Date.now();
    NF.err = '';
    metaFill(items.slice(0, 600));
  } catch (e: any) {
    NF.err = String(e?.message || e);
  }
  NF.loading = false;
}
function xactivity() {
  NF.histAt = Date.now();
  NF.act = ((NF.xmints || []) as any[]).map(m => ({ type: 'NFTokenMint', nft: m.id, amt: '', amtN: null, from: m.issuer, to: '', seq: 0, ms: m.ms, hash: m.hash, ok: true, sale: false } as Act)).sort((a, b) => b.ms - a.ms);
}
/** XRPL mint: the 0.05 XRP fee goes to the fee wallet first, with a memo that registers the NFT in the marketplace */
async function payMintFee(issuer: string, taxon: number, uri: string) {
  const memo = { Memo: { MemoType: strToHex(MEMO_T), MemoData: strToHex(JSON.stringify({ i: issuer, t: taxon, u: uri })) } };
  const r = await ctx.submit({ TransactionType: 'Payment', Account: issuer, Destination: FEE_WALLET, Amount: MINT_FEE_DROPS, Memos: [memo] });
  if (!r.ok) throw new Error('The 0.05 XRP mint fee was rejected: ' + (r.msg || 'failed') + ' (nothing was minted)');
}

/* ------------------------------ indexing ------------------------------ */
async function pages(type: string, max = 40) {
  const out: any[] = [];
  let marker: any;
  for (let i = 0; i < max; i++) {
    const r: any = await ctx.req('ledger_data', { type, ledger_index: 'validated', limit: 200, ...(marker ? { marker } : {}) });
    out.push(...(r.state || []));
    marker = r.marker;
    if (!marker) break;
  }
  return out;
}
// NFTokenID = flags(2) fee(2) issuer(20) scrambled taxon(4) serial(4); parsed by hand so one odd ID can never drop an NFT
function parseId(id: string) {
  const h = String(id).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(h)) return null;
  const serial = parseInt(h.slice(56, 64), 16) >>> 0;
  const scr = parseInt(h.slice(48, 56), 16) >>> 0;
  const taxon = (scr ^ ((Math.imul(384160001, serial) + 2459) >>> 0)) >>> 0;
  return { flags: parseInt(h.slice(0, 4), 16), fee: parseInt(h.slice(4, 8), 16), issuer: acctOf(h.slice(8, 48)), taxon, serial };
}
const mkItem = (id: string, owner: string, uri: any): Item | null => {
  const d = parseId(id);
  return d ? { id: String(id).toUpperCase(), owner, issuer: d.issuer, taxon: d.taxon, flags: d.flags, fee: d.fee, serial: d.serial, uri: uri ? hexToStr(uri) : '' } : null;
};
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> => Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error('the node did not answer in time')), ms))]);
/** every account that ever minted, and how many NFTs are expected to exist (minted - burned), read from the account roots */
async function accountsOverview() {
  const roots: any[] = [];
  let marker: any;
  for (let i = 0; i < 60; i++) {
    const r: any = await withTimeout(ctx.req('ledger_data', { type: 'account', ledger_index: 'validated', limit: 200, ...(marker ? { marker } : {}) }), 15000);
    roots.push(...(r.state || []));
    marker = r.marker;
    if (!marker) break;
  }
  let minted = 0, burned = 0;
  const issuers: string[] = [], holders: string[] = [];
  for (const a of roots) {
    const m = Number(a.MintedNFTokens || 0), bu = Number(a.BurnedNFTokens || 0);
    minted += m;
    burned += bu;
    if (m > 0) issuers.push(a.Account);
    if (Number(a.OwnerCount || 0) > 0) holders.push(a.Account);
  }
  return { expected: Math.max(0, minted - burned), minted, burned, issuers, holders, accounts: roots.length, complete: !marker };
}
async function nftsOf(acct: string): Promise<any[]> {
  const out: any[] = [];
  let marker: any;
  for (let i = 0; i < 20; i++) {
    const r: any = await ctx.req('account_nfts', { account: acct, ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) });
    out.push(...(r.account_nfts || []));
    marker = r.marker;
    if (!marker) break;
  }
  return out;
}
export async function index(force = false) {
  if (xr()) return xindex(force);
  if (NF.loading && Date.now() - (NF.loadStart || 0) < 90000) return;
  if (!force && Date.now() - NF.loadedAt < 6000) return;
  NF.loading = true;
  NF.loadStart = Date.now();
  try {
    const [pgR, ofR, sn, ovR] = await Promise.allSettled([withTimeout(pages('nft_page', 120), 60000), withTimeout(pages('nft_offer', 120), 60000), M.snapshot(), accountsOverview()]);
    const pg = pgR.status === 'fulfilled' ? pgR.value : [];
    const of = ofR.status === 'fulfilled' ? ofR.value : [];
    const ov: any = ovR.status === 'fulfilled' ? ovR.value : null;
    const map = new Map<string, Item>();
    for (const p of pg) {
      const owner = acctOf(String(p.index || p.LedgerIndex).slice(0, 40));
      for (const t of p.NFTokens || []) {
        const n = t.NFToken || t;
        const it = n.NFTokenID ? mkItem(n.NFTokenID, owner, n.URI) : null;
        if (it) map.set(it.id, it);
      }
    }
    const fromPages = map.size;
    let fromAccounts = 0;
    // second source: ask each minting account (and, when the total still does not add up, every account that owns objects) directly
    if (ov) {
      const need = (list: string[]) => poolMap(list, 8, async (a: string) => { try { for (const n of await nftsOf(a)) { const it = mkItem(n.NFTokenID, n.Owner || a, n.URI); if (it && !map.has(it.id)) { map.set(it.id, it); fromAccounts++; } } } catch {} });
      await need(ov.issuers.slice(0, 300));
      if (map.size < ov.expected) await need(ov.holders.filter((a: string) => !ov.issuers.includes(a)).slice(0, 600));
    }
    const items = [...map.values()];
    const offers: Offer[] = of.map((o: any) => ({ id: o.index || o.LedgerIndex, nft: o.NFTokenID, owner: o.Owner, sell: !!((o.Flags || 0) & 1), amt: amtOf(o.Amount), dest: o.Destination || '', exp: o.Expiration || 0 }));
    for (const o of offers) NF.offerAmt.set(o.id, o.amt);
    NF.items = items;
    NF.offers = offers;
    NF.px = sn.status === 'fulfilled' ? sn.value : NF.px;
    NF.diag = { fromPages, fromAccounts, found: items.length, expected: ov ? ov.expected : null, minted: ov ? ov.minted : null, burned: ov ? ov.burned : null, pageErr: pgR.status === 'rejected' ? String((pgR as any).reason?.message || (pgR as any).reason) : '', at: Date.now() };
    NF.loadedAt = Date.now();
    NF.err = !items.length && pgR.status === 'rejected' ? NF.diag.pageErr : '';
    metaFill(items.slice(0, 3000));
  } catch (e: any) {
    NF.err = String(e?.message || e);
  }
  NF.loading = false;
}
let metaBusy = false;
const metaFails = new Map<string, number>();
let metaWarned = false;
async function metaFill(list: Item[]) {
  if (metaBusy) return;
  metaBusy = true;
  const todo = list.filter(i => !NF.meta.has(i.id) && (metaFails.get(i.id) || 0) < 4);
  let ok = 0;
  await poolMap(todo, 5, async it => {
    const m = await loadMeta(it);
    if (m) { NF.meta.set(it.id, m); ok++; }
    else metaFails.set(it.id, (metaFails.get(it.id) || 0) + 1);
  });
  if (todo.length && !ok && !metaWarned) {
    metaWarned = true;
    ctx.toast('NFT images load from the node\'s IPFS through the tunnel. If they stay blank, the node tunnel needs the updated gateway (luma-tunnel).', true);
  }
  metaBusy = false;
  if (todo.length) paint();
}
// ngrok's free tunnel puts a warning page in front of plain <img> requests; a fetch with the skip header gets the real file, shown from a local blob
async function viaBlob(u: string, resp?: Response): Promise<string> {
  if (!u || !/ngrok/.test(u)) return u;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 15000);
    const r = resp && resp.ok ? resp : await fetch(u, { signal: c.signal, headers: { 'ngrok-skip-browser-warning': '1' } });
    const b = await r.blob();
    clearTimeout(t);
    if (!r.ok || !/^(image|video|audio)\//.test(b.type)) return '';
    return URL.createObjectURL(b);
  } catch {
    return '';
  }
}
async function loadMeta(it: Item): Promise<Meta | null> {
  const gws = it.uri.startsWith('ipfs://') ? [IP().gw, ...PUBLIC_GW.filter(g => g !== IP().gw)] : [''];
  for (const gw of gws) {
    const m = await loadMetaVia(it, gw);
    if (m) return m;
  }
  return it.uri.startsWith('ipfs://') ? null : { name: '', desc: '', image: '', attrs: [], coll: '', mime: '' };
}
async function loadMetaVia(it: Item, gw: string): Promise<Meta | null> {
  const u = resolve(it.uri, gw);
  const base: Meta = { name: '', desc: '', image: '', attrs: [], coll: '', mime: '' };
  if (!u) return base;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    const r = await fetch(u, { signal: c.signal, headers: /ngrok/.test(u) ? { 'ngrok-skip-browser-warning': '1' } : {} });
    clearTimeout(t);
    const ct = r.headers.get('content-type') || '';
    if (ct.startsWith('image/') || ct.startsWith('video/') || ct.startsWith('audio/')) return { ...base, image: await viaBlob(u, r), mime: ct };
    const j: any = await r.json();
    const attrs = Array.isArray(j.attributes) ? j.attributes.map((a: any) => ({ k: String(a.trait_type ?? a.key ?? ''), v: String(a.value ?? '') })) : [];
    return { name: String(j.name || ''), desc: String(j.description || ''), image: await viaBlob(resolve(String(j.image || j.animation_url || ''), gw)), attrs, coll: String((j.collection && (j.collection.name || j.collection)) || ''), mime: String(j.mime || ''), cdesc: String((j.collection && j.collection.description) || ''), cover: !!(j.collection && j.collection.cover), mint: j.collection && j.collection.mint, total: Number((j.collection && j.collection.total) || 0) };
  } catch {
    return null;
  }
}
const nameOf = (i: Item) => (NF.meta.get(i.id) || ({} as Meta)).name || `NFT #${i.serial}`;
const collKey = (i: Item) => i.issuer + ':' + i.taxon;
const collName = (list: Item[]) => {
  for (const i of list) {
    const m: Meta | null = NF.meta.get(i.id);
    if (m && m.coll) return m.coll;
  }
  return `${short(ctx.show(list[0].issuer), 6, 4)} · #${list[0].taxon}`;
};
function listingOf(id: string): Offer | null {
  const ls = NF.offers.filter((o: Offer) => o.nft === id && o.sell && !o.dest && live(o));
  if (!ls.length) return null;
  return ls.sort((a: Offer, b: Offer) => (priceN(a.amt) ?? 1e18) - (priceN(b.amt) ?? 1e18))[0];
}
const img = (i: Item, cls = '') => {
  const m: Meta | null = NF.meta.get(i.id);
  const u = m && m.image;
  const isV = m && /^video\//.test(m.mime);
  const ph = `<div class="nfph">${esc((nameOf(i)[0] || '#').toUpperCase())}</div>`;
  return `<div class="nfimg ${cls}">${u ? (isV ? `<video src="${esc(u)}" muted loop playsinline></video>` : `<img loading="lazy" src="${esc(u)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'nfph',textContent:'${esc((nameOf(i)[0] || '#').toUpperCase())}'}))">`) : ph}</div>`;
};

/* ------------------------------ activity ------------------------------ */
interface Led {
  seq: number;
  ms: number;
  txs: any[];
}
async function ledgerFull(seq: number): Promise<Led | null> {
  try {
    return await cached('lf' + seq, Infinity, async () => {
      const l = (await ctx.req('ledger', { ledger_index: seq, transactions: true, expand: true })).ledger;
      if (!l) throw new Error('none');
      return { seq: Number(l.ledger_index), ms: rippleToMs(l.close_time || 0), hash: l.ledger_hash || '', txs: (l.transactions || []).filter((t: any) => typeof t === 'object') } as any;
    });
  } catch {
    return null;
  }
}
const NFT_T = /^NFToken/;
function toAct(t: any, seq: number, ms: number): Act | null {
  const x = t.tx_json || t.tx || t;
  const type = x.TransactionType || '';
  if (!NFT_T.test(type)) return null;
  const meta = t.meta || t.metaData || {};
  let amt: Offer['amt'] | null = x.Amount != null ? amtOf(x.Amount) : null;
  let sale = false;
  let to = x.Destination || x.Owner || '';
  const id = x.NFTokenID || '';
  let nft = id;
  if (type === 'NFTokenAcceptOffer') {
    sale = true;
    const oid = x.NFTokenSellOffer || x.NFTokenBuyOffer;
    amt = NF.offerAmt.get(oid) || null;
    for (const n of meta.AffectedNodes || []) {
      const d = n.DeletedNode;
      if (d && d.LedgerEntryType === 'NFTokenOffer' && d.FinalFields) {
        if (d.FinalFields.Amount != null) amt = amtOf(d.FinalFields.Amount);
        nft = d.FinalFields.NFTokenID || nft;
        to = d.FinalFields.Owner || to;
      }
    }
  }
  return { type, nft, amt: amt ? priceTxt(amt) : '', amtN: amt ? priceN(amt) : null, from: x.Account, to, seq, ms, hash: t.hash || x.hash || '', ok: (meta.TransactionResult || 'tesSUCCESS') === 'tesSUCCESS', sale: sale && (meta.TransactionResult || 'tesSUCCESS') === 'tesSUCCESS' };
}
async function loadActivity() {
  if (xr()) return xactivity();
  if (Date.now() - NF.histAt < 15000) return;
  NF.histAt = Date.now();
  const i = await info();
  const seqs = Array.from({ length: 120 }, (_, k) => i.seq - k).filter(s => s >= i.minSeq);
  const led = ((await poolMap(seqs, 6, ledgerFull)).filter(Boolean) as Led[]).sort((a, b) => b.seq - a.seq);
  const out: Act[] = [];
  for (const l of led) for (const t of [...l.txs].reverse()) { const a = toAct(t, l.seq, l.ms); if (a) out.push(a); }
  NF.act = out;
}
async function loadMine() {
  const acc = me();
  if (!acc || Date.now() - NF.histAt < 15000) return;
  const r: any = await tryReq('account_tx', { account: acc, limit: 250, ledger_index_min: -1, ledger_index_max: -1 });
  const out: Act[] = [];
  for (const t of (r && r.transactions) || []) {
    const x = t.tx_json || t.tx || {};
    const ms = x.date != null ? rippleToMs(x.date) : Date.now();
    const a = toAct({ ...t, hash: t.hash || x.hash, tx: x, meta: t.meta }, Number(x.ledger_index || t.ledger_index || 0), ms);
    if (a) out.push(a);
  }
  NF.hist = out;
}

/* ------------------------------ market page ------------------------------ */
export function nftUnmount() {
  clearInterval(NF.timer);
  clearInterval(NF.rot);
}
async function refresh(force: boolean) {
  await index(force);
  if ($('nm')) loadActivity().then(paint).catch(() => {});
  if ($('mn')) loadMine().then(paint).catch(() => {});
  paint();
}
const priceCell = (o: Offer | null) => (o ? `<b>${esc(priceTxt(o.amt))}</b> <small class="mut">${usdTxt(priceN(o.amt))}</small>` : '<span class="mut">not listed</span>');
const card = (i: Item) => {
  const o = listingOf(i.id);
  return `<div class="nfcard" onclick="window.nm.open('${i.id}')">${img(i)}<div class="nfb"><b>${esc(nameOf(i))}</b><small class="mut">${esc(collName(NF.items.filter((x: Item) => collKey(x) === collKey(i))))}</small><div class="nfp">${priceCell(o)}</div></div></div>`;
};
function filtered(): Item[] {
  const q = NF.q.trim().toLowerCase();
  let l: Item[] = visItems().filter((i: Item) => !NF.coll || collKey(i) === NF.coll);
  if (q) l = l.filter(i => { const o = listingOf(i.id); return (nameOf(i) + ' ' + collName(NF.items.filter((x: Item) => collKey(x) === collKey(i))) + ' ' + i.id + ' ' + i.owner + ' ' + (o ? o.amt.cur + ' ' + o.amt.v : 'not listed')).toLowerCase().includes(q); });
  if (NF.st === 'listed') l = l.filter(i => !!listingOf(i.id)); else if (NF.st === 'unlisted') l = l.filter(i => !listingOf(i.id)); else if (NF.st === 'mine') l = l.filter(i => i.owner === me());
  const lo = parseFloat(NF.pmin), hi = parseFloat(NF.pmax);
  if (lo >= 0 || hi >= 0) l = l.filter(i => { const o = listingOf(i.id), p = o ? priceN(o.amt) : null; return p != null && (!(lo >= 0) || p >= lo) && (!(hi >= 0) || p <= hi); });
  const pr = (i: Item) => { const o = listingOf(i.id); return o ? priceN(o.amt) ?? 1e17 : null; };
  const D = NF.sdir || -1;
  const key = (i: Item): any => {
    const o = listingOf(i.id);
    switch (NF.sort) {
      case 'name': return nameOf(i).toLowerCase();
      case 'coll': return collName(NF.items.filter((x: Item) => collKey(x) === collKey(i))).toLowerCase();
      case 'price': return o ? priceN(o.amt) ?? 1e17 : null;
      case 'tok': return o ? o.amt.cur : null;
      case 'owner': return i.owner;
      case 'roy': return i.fee;
      default: return i.serial;
    }
  };
  l.sort((a, b) => { const x = key(a), y = key(b); if (x == null && y == null) return b.serial - a.serial; if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : x > y ? 1 : 0) * D || b.serial - a.serial; });
  return l;
}
function collections() {
  const g = new Map<string, Item[]>();
  for (const i of NF.items as Item[]) (g.get(collKey(i)) || g.set(collKey(i), []).get(collKey(i))!).push(i);
  const sales: Act[] = NF.act.filter((a: Act) => a.sale);
  return [...g.entries()].map(([k, full]) => {
    const list = full.filter(vis).length ? full.filter(vis) : full;
    const owners = new Map<string, number>();
    for (const i of list) owners.set(i.owner, (owners.get(i.owner) || 0) + 1);
    const listed = list.map(i => listingOf(i.id)).filter(Boolean) as Offer[];
    const prices = listed.map(o => priceN(o.amt)).filter(x => x != null) as number[];
    const ids = new Set(list.map(i => i.id));
    const vol = sales.filter(s => ids.has(s.nft)).reduce((t, s) => t + (s.amtN || 0), 0);
    const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
    const floor = prices.length ? Math.min(...prices) : null;
    const cv = full.find(isCover); return { k, cover: cv || list[0], name: collName(list), list, owners: owners.size, top: Math.max(...owners.values()) / list.length, listed: listed.length, floor, avg, vol, sales: sales.filter(s => ids.has(s.nft)).length };
  });
}
export function paint() {
  if ($('nm')) paintMarket();
  if ($('mn')) paintMine();
  if ($('ndp')) paintDetail();
}
function diagHtml() {
  const d = NF.diag;
  if (!d) return '';
  const short = d.expected != null && d.found < d.expected;
  const ok = !short && d.found > 0;
  return `<div class="card" style="margin-bottom:.8rem;border-color:${ok ? 'rgba(0,255,140,.25)' : 'rgba(255,196,0,.4)'}"><div class="row" style="justify-content:space-between;gap:.6rem;flex-wrap:wrap"><div><b>${fmt(d.found, 0)} NFT${d.found === 1 ? '' : 's'} found on this network</b> <span class="mut" style="font-size:.8rem">${d.expected != null ? `· ${fmt(d.minted, 0)} minted, ${fmt(d.burned, 0)} burned, ${fmt(d.expected, 0)} should exist` : ''}${d.fromAccounts ? ` · ${d.fromAccounts} recovered by asking accounts directly` : ''}</span>${short ? `<div class="crit" style="font-size:.82rem">${fmt(d.expected - d.found, 0)} not visible yet. The node may be behind or not keep that state; press Rescan, or point Starsky at an API node.</div>` : ''}${d.pageErr ? `<div class="mut" style="font-size:.78rem">ledger scan: ${esc(d.pageErr)}</div>` : ''}</div><button class="sm" onclick="window.nm.refresh()">Rescan everything</button></div></div>`;
}
const isCover = (i: Item) => { const m: Meta | null = NF.meta.get(i.id); return !!(m && m.cover); };
const vis = (i: Item) => !isCover(i);   // cover NFTs are the collection's picture: hidden in the marketplace, still yours in My NFTs
const visItems = (): Item[] => (NF.items as Item[]).filter(vis);
NF.view = (() => { try { return localStorage.getItem('starsky.nft.view2') || 'list'; } catch { return 'grid'; } })();
NF.page = 0;
NF.feat = '';
NF.featAt = 0;
const setView = (v: string) => { NF.view = v; try { localStorage.setItem('starsky.nft.view2', v); } catch {} };
const viewToggle = () => `<div class="seg" style="margin-left:.2rem"><button class="${NF.view === 'grid' ? 'on' : ''}" onclick="window.nm.view('grid')">▦ Grid</button><button class="${NF.view === 'list' ? 'on' : ''}" onclick="window.nm.view('list')">☰ List</button></div>`;
const imgUrl = (i: Item) => { const m: Meta | null = NF.meta.get(i.id); return m && m.image ? m.image : ''; };
const i2 = (a: string) => (a === me() ? 'you' : esc(sh(a)));

export function marketShell() {
  return `<div id="nm" class="nwpage nmpro">
    <div id="nm_stats" class="pgrid nwk" style="margin-bottom:1rem"></div>
    <div id="nm_diag"></div>
    <div id="nm_hero"><div class="mut" style="padding:1rem">Reading NFTs from the ledger…</div></div>
    <div class="nmh"><h3>Trending now</h3><small class="mut">listed pieces, highest first</small></div><div id="nm_four" class="nf4"></div>
    <div class="nmh"><h3>Top collections</h3><small class="mut">by volume and size</small></div><div id="nm_cols" class="nf6"></div>
    <div class="nmh"><h3>Latest NFTs</h3><small class="mut">newest mints on the network</small></div><div id="nm_new" class="nf5"></div>
    <div class="card" style="margin-top:1.4rem">
      <div class="row nmtb" style="gap:.45rem;flex-wrap:nowrap;align-items:center;overflow-x:auto;padding-bottom:.2rem">
        <div class="seg" id="nm_tabs" style="flex:none">${[['items', 'All NFTs'], ['collections', 'Collections'], ['activity', 'Sales & activity']].map(([k, l]) => `<button data-k="${k}" class="${NF.tab === k ? 'on' : ''}" onclick="window.nm.tab('${k}')">${l}</button>`).join('')}</div>
        <input id="nm_q" placeholder="Search name, collection, ID, owner" value="${esc(NF.q)}" oninput="window.nm.search(this.value)" style="flex:1 1 11rem;min-width:9rem">
        <span id="nm_flt" style="display:contents">
          <select id="nm_st" title="Status" onchange="window.nm.fl('st',this.value)" style="flex:none">${[['all', 'All items'], ['listed', 'Listed'], ['unlisted', 'Not listed'], ['mine', 'Mine']].map(([k, t]) => `<option value="${k}" ${NF.st === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <input id="nm_pmin" placeholder="Min" value="${esc(NF.pmin)}" inputmode="decimal" style="width:4.2rem;flex:none" onchange="window.nm.fl('pmin',this.value)"><input id="nm_pmax" placeholder="Max" value="${esc(NF.pmax)}" inputmode="decimal" style="width:4.2rem;flex:none" onchange="window.nm.fl('pmax',this.value)">
          <select id="nm_per" title="Rows per page" onchange="window.nm.fl('per',this.value)" style="flex:none">${[25, 50, 100, 200].map(n => `<option value="${n}" ${+NF.per === n ? 'selected' : ''}>${n}/page</option>`).join('')}</select>
        </span>
        <select title="Sort" onchange="window.nm.sort(this.value)" style="flex:none">${[['new:-1', 'Newest'], ['new:1', 'Oldest'], ['price:1', 'Price ↑'], ['price:-1', 'Price ↓'], ['name:1', 'Name A–Z']].map(([k, l]) => `<option value="${k}" ${NF.sort + ':' + NF.sdir === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span id="nm_vt" style="flex:none">${viewToggle()}</span>
        <button class="sm ghost" style="flex:none" title="Export the filtered list as CSV" onclick="window.nm.csv()">⇩ CSV</button><button class="sm ghost" style="flex:none" onclick="window.nm.reset()">Reset</button>
        <button class="sm ghost" style="flex:none" onclick="window.nm.refresh()">Refresh</button><button class="sm pri acc" style="flex:none" onclick="window.nm.mint()">+ Mint</button></div>
      <div id="nm_list" style="margin-top:.8rem"></div><div id="nm_pager" class="nmpg"></div></div></div>`;
}
export function marketMount() {
  clearInterval(NF.timer);
  clearInterval(NF.rot);
  NF.timer = setInterval(() => ($('nm') || $('mn') ? (document.hidden || refresh(false)) : clearInterval(NF.timer)), 60000);
  NF.rot = setInterval(() => { if (!$('nm')) return clearInterval(NF.rot); rotateFeat(); }, 60000);
  refresh(false);
}
function pickFeat(avoid = ''): Item | null {
  const pool = visItems().filter(i => i.id !== avoid);
  if (!pool.length) return null;
  const withImg = pool.filter(i => imgUrl(i));
  const p = withImg.length ? withImg : pool;
  return p[Math.floor(Math.random() * p.length)];
}
function rotateFeat() {
  const next = pickFeat(NF.feat);
  const el = $('nm_hero');
  if (!next || !el) return;
  el.classList.add('fo');
  setTimeout(() => { NF.feat = next.id; NF.featAt = Date.now(); paintHero(); el.classList.remove('fo'); }, 650);
}
function paintHero() {
  const items = visItems();
  let feat = items.find(i => i.id === NF.feat);
  if (!feat) { feat = pickFeat() || undefined; if (feat) { NF.feat = feat.id; NF.featAt = Date.now(); } }
  if (!feat) {
    setHtml('nm_hero', `<div class="card" style="text-align:center;padding:2.4rem"><b style="font-size:1.3rem">No NFTs on this network yet</b><p class="mut">Mint the first one from the studio.</p><button class="pri acc" onclick="window.nm.mint()">+ Mint</button></div>`);
    return;
  }
  const fo = listingOf(feat.id), fm: Meta | null = NF.meta.get(feat.id), u = imgUrl(feat), col = items.filter(x => collKey(x) === collKey(feat!));
  const left = Math.max(1, 60 - Math.floor((Date.now() - NF.featAt) / 1000));
  setHtml('nm_hero', `<div class="nfhero2" onclick="window.nm.open('${feat.id}')">${u ? `<div class="nfh_bg" style="background-image:url('${esc(u)}')"></div>` : ''}<div class="nfh_in"><div class="nfh_img">${img(feat, 'big')}<button class="nfh_fs" title="Full screen" onclick="event.stopPropagation();window.nm.full('${feat.id}')">⛶</button></div>
    <div class="nfh_t"><div class="row" style="gap:.5rem"><span class="chip">FEATURED</span>${fo ? '<span class="chip" style="background:rgba(0,255,140,.2);color:#00ff8c">FOR SALE</span>' : ''}</div><h2>${esc(nameOf(feat))}</h2>
      <div class="mut">${esc(collName(col))} · ${col.length} item${col.length === 1 ? '' : 's'} · by <span class="mono">${esc(sh(feat.issuer))}</span></div>
      <p class="mut nfh_d">${esc((fm && fm.desc) || 'Native XLS-20 NFT on ' + nat() + '.')}</p>
      <div class="row" style="gap:1.8rem;flex-wrap:wrap;margin:.6rem 0"><div><div class="k">${fo ? 'Price' : 'Status'}</div><div class="nfh_pr">${fo ? `${esc(fmt(fo.amt.v))} <span>${esc(fo.amt.cur)}</span>` : 'Not listed'}</div><small class="mut">${fo ? usdTxt(priceN(fo.amt)) : ''}</small></div><div><div class="k">Owner</div><div class="mono">${i2(feat.owner)}</div></div><div><div class="k">Royalty</div><div>${(feat.fee / 1000).toFixed(1)}%</div></div><div><div class="k">Serial</div><div>#${feat.serial}</div></div></div>
      <div class="row" style="gap:.6rem">${fo && fo.owner !== me() ? `<button class="pri acc" onclick="event.stopPropagation();window.nm.buy('${fo.id}',this)">Buy now</button>` : ''}<button onclick="event.stopPropagation();window.nm.open('${feat.id}')">View details</button><button class="ghost" onclick="event.stopPropagation();window.nm.nextFeat()">Next ›</button></div>
      <div class="nfh_prog"><i style="animation-duration:${left}s"></i></div></div></div></div>`);
}
const colCard = (c: any) => `<div class="nfcol" onclick="window.nm.coll('${esc(c.k)}')"><div class="nfcol_i">${img(c.cover)}</div><div class="nfb"><b>${esc(c.name)}</b><small class="mut">${c.list.length} items · ${c.owners} owners</small><small>${c.floor != null ? 'Floor <b>' + esc(fmt(c.floor)) + '</b> ' + nat() : '<span class="mut">none listed</span>'}</small></div></div>`;
function paintMarket() {
  const dg = $('nm_diag');
  if (dg) dg.innerHTML = diagHtml();
  const items = visItems();
  const cols = collections();
  const listings = (NF.offers as Offer[]).filter(o => o.sell && !o.dest && live(o) && items.some(i => i.id === o.nft));
  const day = NF.act.filter((a: Act) => a.sale && Date.now() - a.ms < 86400e3);
  const vol = day.reduce((t: number, a: Act) => t + (a.amtN || 0), 0);
  const floors = listings.map(o => priceN(o.amt)).filter(x => x != null) as number[];
  setHtml('nm_stats', [
    ['Items', fmt(items.length, 0), `${new Set(items.map(i => i.owner)).size} owners`],
    ['Collections', fmt(cols.length, 0), ''],
    ['Listed', fmt(listings.length, 0), items.length ? ((listings.length / items.length) * 100).toFixed(1) + '% of items' : ''],
    ['Lowest price', floors.length ? fmt(Math.min(...floors)) + ' ' + nat() : '–', floors.length ? usdTxt(Math.min(...floors)) : ''],
    ['Sales 24h', fmt(day.length, 0), 'from the last ' + (NF.act.length ? '120' : '–') + ' ledgers'],
    ['Volume 24h', vol ? fmt(vol) + ' ' + nat() : '–', vol ? usdTxt(vol) : ''],
  ].map(([k, v, s]) => `<div class="tile kvt"><div class="k">${k}</div><div class="big2">${v}</div><div class="mut" style="font-size:.78rem">${s}</div></div>`).join(''));
  paintHero();
  if (!items.length) { setHtml('nm_four', ''); setHtml('nm_cols', ''); setHtml('nm_new', ''); setHtml('nm_list', ''); setHtml('nm_pager', ''); return; }
  const ranked = items.slice().sort((a, b) => { const x = listingOf(a.id), y = listingOf(b.id); return (y ? priceN(y.amt) ?? 0 : -1) - (x ? priceN(x.amt) ?? 0 : -1) || b.serial - a.serial; });
  setHtml('nm_four', ranked.filter(i => i.id !== NF.feat).slice(0, 4).map(card).join(''));
  setHtml('nm_cols', cols.slice().sort((a, b) => (b.vol - a.vol) || b.list.length - a.list.length).slice(0, 6).map(colCard).join('') || '<div class="mut">No collections yet.</div>');
  setHtml('nm_new', items.slice().sort((a, b) => b.serial - a.serial).slice(0, 5).map(card).join(''));
  document.querySelectorAll('#nm_tabs button').forEach(b => b.classList.toggle('on', (b as HTMLElement).dataset.k === NF.tab));
  const vt = $('nm_vt'); if (vt) vt.innerHTML = viewToggle();
  const fl = $('nm_flt'); if (fl) fl.style.display = NF.tab === 'items' ? 'contents' : 'none';
  let pager = '';
  if (NF.tab === 'items') {
    const l = filtered();
    const per = +NF.per || 50, pages = Math.max(1, Math.ceil(l.length / per));
    if (NF.page >= pages) NF.page = pages - 1;
    const slice = l.slice(NF.page * per, NF.page * per + per);
    const body = NF.view === 'grid'
      ? `<div class="nf5 nfgrid">${slice.map(card).join('') || '<div class="mut" style="padding:1rem">No NFTs match.</div>'}</div>`
      : `<div style="overflow:auto"><table class="dxt nmtab"><colgroup><col style="width:3.6rem"><col style="width:20%"><col style="width:17%"><col style="width:15%"><col style="width:8%"><col style="width:14%"><col style="width:8%"><col style="width:8%"><col style="width:6rem"></colgroup><thead><tr><th></th>${[['name', 'Name', ''], ['coll', 'Collection', ''], ['price', 'Price', 'r'], ['tok', 'Token', ''], ['owner', 'Owner', ''], ['roy', 'Royalty', 'r'], ['new', 'Serial / latest', 'r']].map(([k, l, c]) => `<th class="${c} srt" style="cursor:pointer;user-select:none" title="Double-click to sort" ondblclick="window.nm.hs('${k}')">${l}${NF.sort === k ? (NF.sdir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('')}<th></th></tr></thead><tbody>${slice.map(i => { const o = listingOf(i.id), mine = i.owner === me(); return `<tr class="clk" onclick="window.nm.open('${i.id}')"><td style="width:3.4rem">${img(i, 'sm')}</td><td><b>${esc(nameOf(i))}</b></td><td class="mut">${esc(collName(items.filter(x => collKey(x) === collKey(i))))}</td><td class="r">${o ? `<b>${esc(fmt(o.amt.v))}</b> <small class="mut">${usdTxt(priceN(o.amt))}</small>` : '<span class="mut">not listed</span>'}</td><td>${o ? `<span class="chip">${esc(o.amt.cur)}</span>` : '–'}</td><td class="mono">${i2(i.owner)}</td><td class="r">${(i.fee / 1000).toFixed(1)}%</td><td class="r mono">${i.serial}</td><td class="r">${o && !mine ? `<button class="sm pri acc" onclick="event.stopPropagation();window.nm.buy('${o.id}',this)">Buy</button>` : mine ? '<span class="chip">yours</span>' : ''}</td></tr>`; }).join('') || '<tr><td colspan="9" class="mut" style="padding:1rem">No NFTs match.</td></tr>'}</tbody></table></div>`;
    setHtml('nm_list', (NF.coll ? `<div style="margin-bottom:.5rem"><button class="sm ghost" onclick="window.nm.coll('')">× Clear collection filter</button></div>` : '') + body);
    const win = (p: number) => { const a = new Set([0, pages - 1, p - 2, p - 1, p, p + 1, p + 2].filter(x => x >= 0 && x < pages)); const s = [...a].sort((x, y) => x - y); let out = '', prev = -1; for (const x of s) { if (prev >= 0 && x - prev > 1) out += '<span class="mut">…</span>'; out += `<button class="sm ${x === p ? 'pri acc' : 'ghost'}" onclick="window.nm.pg(${x})">${x + 1}</button>`; prev = x; } return out; };
    pager = l.length > per ? `<span class="mut">${NF.page * per + 1}–${Math.min(l.length, NF.page * per + per)} of ${fmt(l.length, 0)}</span><button class="sm ghost" ${NF.page === 0 ? 'disabled' : ''} onclick="window.nm.pg(${NF.page - 1})">‹ Prev</button>${win(NF.page)}<button class="sm ghost" ${NF.page >= pages - 1 ? 'disabled' : ''} onclick="window.nm.pg(${NF.page + 1})">Next ›</button>` : `<span class="mut">${fmt(l.length, 0)} NFT${l.length === 1 ? '' : 's'}</span>`;
  } else if (NF.tab === 'collections') {
    const q = NF.q.trim().toLowerCase();
    const ck: any = { name: (c: any) => c.name.toLowerCase(), items: (c: any) => c.list.length, owners: (c: any) => c.owners, listed: (c: any) => c.listed, floor: (c: any) => c.floor ?? 1e18, avg: (c: any) => c.avg ?? 1e18, top: (c: any) => c.top, sales: (c: any) => c.sales, vol: (c: any) => c.vol };
    const kf = ck[NF.csort] || ck.vol, cd = NF.cdir || -1;
    const l = cols.filter(c => !q || c.name.toLowerCase().includes(q)).sort((a, b) => { const x = kf(a), y = kf(b); return (x < y ? -1 : x > y ? 1 : 0) * cd || (b.vol - a.vol) || b.list.length - a.list.length; });
    setHtml('nm_list', NF.view === 'grid' ? `<div class="nf6 nfgrid">${l.map(colCard).join('')}</div>` : `<div style="overflow:auto"><table class="dxt nmtab"><colgroup><col style="width:3.6rem"><col style="width:24%"><col span="8"></colgroup><thead><tr><th></th>${[['name', 'Collection', ''], ['items', 'Items', 'r'], ['owners', 'Owners', 'r'], ['listed', 'Listed', 'r'], ['floor', 'Floor', 'r'], ['avg', 'Avg listed', 'r'], ['top', 'Top holder', 'r'], ['sales', 'Sales', 'r'], ['vol', 'Volume', 'r']].map(([k, t, c]) => `<th class="${c}" style="cursor:pointer;user-select:none" title="Double-click to sort" ondblclick="window.nm.cs('${k}')">${t}${NF.csort === k ? (NF.cdir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead><tbody>${l.map(c => `<tr class="clk" onclick="window.nm.coll('${esc(c.k)}')"><td style="width:3.4rem">${img(c.cover, 'sm')}</td><td><b>${esc(c.name)}</b><br><small class="mut mono">${esc(sh(c.list[0].issuer))}</small></td><td class="r">${c.list.length}</td><td class="r">${c.owners}</td><td class="r">${c.listed}</td><td class="r">${c.floor != null ? fmt(c.floor) + ' ' + nat() : '–'}</td><td class="r">${c.avg != null ? fmt(c.avg) : '–'}</td><td class="r">${(c.top * 100).toFixed(0)}%</td><td class="r">${c.sales}</td><td class="r">${c.vol ? fmt(c.vol) + ' ' + nat() : '–'}</td></tr>`).join('')}</tbody></table></div>`);
    pager = `<span class="mut">${l.length} collection${l.length === 1 ? '' : 's'}</span>`;
  } else {
    setHtml('nm_list', `<div style="overflow:auto">${actTable(NF.act.slice(0, 200))}</div>`);
  }
  setHtml('nm_pager', pager);
}

/* ------------------------------ NFT detail: full page ------------------------------ */
NF.cur = '';
NF.nh = new Map();
async function nftHist(id: string) {
  const it = (NF.items as Item[]).find(x => x.id === id);
  if (!it) return;
  const accs = [...new Set([it.owner, it.issuer, ...(NF.offers as Offer[]).filter(o => o.nft === id).map(o => o.owner)])].slice(0, 6);
  const out: Act[] = [];
  const seen = new Set<string>();
  for (const a of accs) {
    const r: any = await tryReq('account_tx', { account: a, limit: 300, ledger_index_min: -1, ledger_index_max: -1 }, 6000);
    for (const t of (r && r.transactions) || []) {
      const x = t.tx_json || t.tx || {};
      const hash = t.hash || x.hash || '';
      if (seen.has(hash) || !/^NFToken/.test(x.TransactionType || '')) continue;
      const act = toAct({ ...t, hash, tx: x, meta: t.meta }, Number(x.ledger_index || t.ledger_index || 0), x.date != null ? rippleToMs(x.date) : Date.now());
      const isMint = x.TransactionType === 'NFTokenMint' && x.Account === it.issuer && hexToStr(x.URI || '') === it.uri;
      if (!act) continue;
      if (act.nft === id || (isMint && Number(x.NFTokenTaxon) === it.taxon)) { seen.add(hash); out.push(isMint ? { ...act, nft: id } : act); }
    }
  }
  NF.nh.set(id, out.sort((a, b) => b.ms - a.ms));
  if ($('ndp') && NF.cur === id) paintDetail();
}
function detail(id: string) {
  const i = (NF.items as Item[]).find(x => x.id === id);
  if (!i) return;
  if (!$('ndp')) NF.prev = $('ncp') ? { t: 'coll', v: CP.key } : $('mn') ? { t: 'tab', v: 'nfts' } : { t: 'tab', v: 'nftmarket' };
  NF.cur = id;
  if (!$('ndp')) swapRoot('', 'ndp');
  window.scrollTo?.({ top: 0 });
  paintDetail();
  nftHist(id).catch(() => {});
}
function paintDetail() {
  const r = $('ndp');
  const i = (NF.items as Item[]).find(x => x.id === NF.cur);
  if (!r || !i) return;
  const m: Meta = NF.meta.get(i.id) || { name: '', desc: '', image: '', attrs: [], coll: '', mime: '' };
  const offers = (NF.offers as Offer[]).filter(o => o.nft === i.id && live(o));
  const mine = i.owner === me();
  const lst = listingOf(i.id);
  const colItems = (NF.items as Item[]).filter(x => collKey(x) === collKey(i));
  const more = colItems.filter(x => x.id !== i.id && vis(x)).slice(0, 5);
  const hist: Act[] = (NF.nh.get(i.id) || NF.act.filter((a: Act) => a.nft === i.id)) as Act[];
  const u = m.image;
  const rows = offers.map(o => `<tr><td><span class="chip ${o.sell ? '' : 'b'}">${o.sell ? 'Listing' : 'Offer'}</span></td><td class="r"><b>${esc(fmt(o.amt.v))}</b> ${esc(o.amt.cur)} <small class="mut">${usdTxt(priceN(o.amt))}</small></td><td class="mono mut">${esc(o.owner === me() ? 'you' : sh(o.owner))}</td><td class="mut">${o.exp ? 'expires ' + new Date(rippleToMs(o.exp)).toLocaleDateString() : 'no expiry'}${o.dest ? ' · private' : ''}</td><td class="r">${o.owner === me() ? `<button class="sm" onclick="window.nm.cancel('${o.id}',this)">Cancel</button>` : o.sell && (!o.dest || o.dest === me()) ? `<button class="sm pri acc" onclick="window.nm.buy('${o.id}',this)">Buy</button>` : mine && !o.sell ? `<button class="sm pri acc" onclick="window.nm.accept('${o.id}',false,this)">Accept</button>` : ''}</td></tr>`).join('');
  const evLbl = (a: Act) => a.sale ? 'Sale' : a.type === 'NFTokenMint' ? 'Minted' : a.type.replace('NFToken', '').replace('CreateOffer', 'Listing / offer').replace('CancelOffer', 'Cancelled').replace('AcceptOffer', 'Accepted').replace('Burn', 'Burned');
  r.innerHTML = `<div class="row" style="margin-bottom:.8rem;gap:.5rem"><button class="ghost" onclick="window.nm.dback()">← Back</button><span class="mut">${esc(collName(colItems))}</span><span style="flex:1"></span><button class="sm ghost" onclick="window.nm.refresh()">Refresh</button></div>
  <div class="ndp"><div class="ndp_l"><div class="ndp_img" onclick="window.nm.full('${i.id}')">${img(i, 'big')}<button class="nfh_fs" title="Full screen">⛶</button></div>${u ? `<div class="row" style="gap:.4rem;margin-top:.5rem"><button class="sm" onclick="window.nm.full('${i.id}')">Full screen</button><a class="sm btnlike" href="${esc(u)}" target="_blank" rel="noopener">Open original</a></div>` : ''}</div>
  <div class="ndp_r"><div class="row" style="gap:.5rem"><a class="chip" href="#" onclick="window.nm.coll('${esc(collKey(i))}');return false">${esc(collName(colItems))}</a>${isCover(i) ? '<span class="chip">COVER</span>' : ''}${lst ? '<span class="chip" style="background:rgba(0,255,140,.2);color:#00ff8c">FOR SALE</span>' : ''}</div>
    <h1 style="margin:.3rem 0">${esc(nameOf(i))}</h1><div class="mut">Owned by <b class="mono">${mine ? 'you' : esc(sh(i.owner))}</b> · created by <span class="mono">${esc(sh(i.issuer))}</span></div>
    <div class="card ndp_buy"><div class="k">${lst ? 'Current price' : 'Not listed'}</div><div class="nfh_pr">${lst ? `${esc(fmt(lst.amt.v))} <span>${esc(lst.amt.cur)}</span>` : '–'}</div><small class="mut">${lst ? usdTxt(priceN(lst.amt)) : ''}</small>
      <div class="row" style="margin-top:.7rem;gap:.5rem;flex-wrap:wrap">${mine ? `<button class="pri acc" onclick="window.nm.list('${i.id}')">${lst ? 'Change listing' : 'List for sale'}</button><button onclick="window.nm.send('${i.id}')">Send</button><button class="ghost" onclick="window.nm.burn('${i.id}',this)">Burn</button>` : `${lst && (!lst.dest || lst.dest === me()) ? `<button class="pri acc" onclick="window.nm.buy('${lst.id}',this)">Buy now</button>` : ''}<button onclick="window.nm.offer('${i.id}')">Make an offer</button>`}</div></div>
    ${m.desc ? `<p class="mut" style="margin:.8rem 0">${esc(m.desc)}</p>` : ''}
    ${m.attrs.length ? `<div class="nwh" style="font-size:1rem">Traits</div><div class="row" style="gap:.4rem;flex-wrap:wrap">${m.attrs.map(a => `<div class="trait"><small>${esc(a.k)}</small><b>${esc(a.v)}</b></div>`).join('')}</div>` : ''}
    <div class="nwh" style="font-size:1rem">Details</div><div class="kvl"><div><span>Royalty</span><b>${(i.fee / 1000).toFixed(1)}%</b></div><div><span>Transferable</span><b>${i.flags & TF_TRANSFER ? 'yes' : 'no'}</b></div><div><span>Burnable</span><b>${i.flags & TF_BURN ? 'yes' : 'no'}</b></div><div><span>Serial · taxon</span><b>${i.serial} · ${i.taxon}</b></div><div style="grid-column:1/-1"><span>Token ID</span><b class="mono" style="font-size:.72rem;word-break:break-all">${esc(i.id)}</b></div>${i.uri ? `<div style="grid-column:1/-1"><span>Metadata URI</span><b class="mono" style="font-size:.72rem;word-break:break-all">${esc(i.uri)}</b></div>` : ''}</div></div></div>
  <div class="nwh">Listings and offers</div><div class="card">${rows ? `<table class="dxt"><tbody>${rows}</tbody></table>` : '<div class="mut">No listings or offers.</div>'}</div>
  <div class="nwh">Activity <small class="mut">mints, listings, offers, sales, transfers and burns of this NFT</small></div><div class="card nwscroll" style="max-height:24rem">${hist.length ? `<table class="dxt"><thead><tr><th>Event</th><th class="r">Price</th><th>From</th><th>To</th><th class="r">Time</th><th>Tx</th></tr></thead><tbody>${hist.map(a => `<tr><td><span class="chip ${a.sale ? '' : 'b'}">${esc(evLbl(a))}</span></td><td class="r">${esc(a.amt || '–')}</td><td class="mono">${a.from ? i2(a.from) : '–'}</td><td class="mono">${a.to ? i2(a.to) : '–'}</td><td class="r mut">${a.ms ? ago(Date.now() - a.ms) : '–'}</td><td><a class="mut" href="#" onclick="window.inspectTx&&window.inspectTx('${esc(a.hash)}');return false">${esc(short(a.hash, 6, 4))}</a></td></tr>`).join('')}</tbody></table>` : `<div class="mut">${NF.nh.has(i.id) ? 'No recorded activity yet.' : 'Reading this NFT’s history from the ledger…'}</div>`}</div>
  ${more.length ? `<div class="nwh">More from this collection</div><div class="nf5">${more.map(card).join('')}</div>` : ''}`;
}
function fullscreen(id: string) {
  const i = (NF.items as Item[]).find(x => x.id === id);
  if (!i) return;
  const m: Meta | null = NF.meta.get(id);
  const u = m && m.image;
  if (!u) return ctx.toast('This NFT has no image to show.', true);
  const isV = /^video\//.test((m && m.mime) || '');
  const d = document.createElement('div');
  d.id = 'nf_full';
  d.innerHTML = `<div class="nff_top"><b>${esc(nameOf(i))}</b><span style="flex:1"></span><button class="sm" id="nff_z">Zoom</button><button class="sm" id="nff_x">✕ Close</button></div>${isV ? `<video src="${esc(u)}" controls autoplay loop></video>` : `<img src="${esc(u)}" alt="">`}`;
  document.body.appendChild(d);
  const close = () => { document.removeEventListener('keydown', key); if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); d.remove(); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', key);
  d.querySelector('#nff_x')!.addEventListener('click', close);
  const im = d.querySelector('img');
  d.querySelector('#nff_z')!.addEventListener('click', () => im && im.classList.toggle('z'));
  im && im.addEventListener('click', () => im.classList.toggle('z'));
  d.addEventListener('click', e => { if (e.target === d) close(); });
  try { d.requestFullscreen?.().catch(() => {}); } catch {}
}

function actTable(rows: Act[]) {
  return `<table class="dxt"><thead><tr><th>Event</th><th>NFT</th><th class="r">Price</th><th>From</th><th>To</th><th>Result</th><th class="r">Ledger</th><th class="r">Time</th></tr></thead><tbody>${
    rows.map(a => { const it = (NF.items as Item[]).find(i => i.id === a.nft); const lbl = a.sale ? 'Sale' : a.type.replace('NFToken', '').replace('CreateOffer', 'Offer / listing').replace('CancelOffer', 'Cancel offer').replace('AcceptOffer', 'Accept'); return `<tr><td><span class="chip ${a.sale ? '' : 'b'}">${esc(lbl)}</span></td><td>${it ? `<a href="#" class="who" onclick="window.nm.open('${it.id}');return false">${esc(nameOf(it))}</a>` : `<span class="mono mut">${esc(short(a.nft, 6, 4)) || '–'}</span>`}</td><td class="r">${esc(a.amt)}</td><td class="mono mut">${esc(sh(a.from || ''))}</td><td class="mono mut">${a.to ? esc(sh(a.to)) : ''}</td><td><span class="chip ${a.ok ? '' : 'bad'}">${a.ok ? 'ok' : 'failed'}</span></td><td class="r mut">${a.seq || ''}</td><td class="r mut">${a.ms ? ago(Date.now() - a.ms) : ''}</td></tr>`; }).join('') || '<tr><td colspan="8" class="mut" style="padding:1rem">No NFT activity in the recent ledgers.</td></tr>'
  }</tbody></table>`;
}

/* ------------------------------ My NFTs ------------------------------ */
export function myShell() {
  return `<div id="mn" class="nwpage">
    <div class="card" style="margin-bottom:1rem"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:.6rem"><div><div class="k" style="margin:0">My NFTs</div><div class="mut" style="font-size:.82rem;margin-top:.3rem">Everything you own, list, offer and claim, with full history.</div></div>
      <div class="row" style="gap:.5rem"><button class="pri acc" onclick="window.nm.mint()">+ Mint NFT / collection</button><button onclick="window.goTab('nftmarket')">Open marketplace</button><button class="ghost" onclick="window.nm.refresh()">Refresh</button></div></div></div>
    <div id="mn_stats" class="pgrid nwk"></div>
    <div class="nwh">Claims &amp; offers for you</div><div class="card nwscroll" id="mn_claims" style="max-height:20rem"></div>
    <div class="nwh">Owned</div><div id="mn_owned" class="nf4 many"></div>
    <div class="nwh">Your listings and offers</div><div class="card nwscroll" id="mn_offers" style="max-height:20rem"></div>
    <div class="nwh">History</div><div class="card nwscroll" id="mn_hist" style="max-height:26rem"></div></div>`;
}
function paintMine() {
  const acc = me();
  const mine: Item[] = NF.items.filter((i: Item) => i.owner === acc);
  const myOffers: Offer[] = NF.offers.filter((o: Offer) => o.owner === acc);
  const mineIds = new Set(mine.map(i => i.id));
  const claims: Offer[] = NF.offers.filter((o: Offer) => live(o) && ((o.sell && o.dest === acc && o.owner !== acc) || (!o.sell && mineIds.has(o.nft) && o.owner !== acc)));
  setHtml(
    'mn_stats',
    [
      ['Owned', fmt(mine.length, 0), `${new Set(mine.map(i => collKey(i))).size} collections`],
      ['Listed by you', fmt(myOffers.filter(o => o.sell).length, 0), ''],
      ['Offers you made', fmt(myOffers.filter(o => !o.sell).length, 0), ''],
      ['To claim', fmt(claims.length, 0), 'offers and transfers for you'],
      ['Minted by you', fmt((NF.items as Item[]).filter(i => i.issuer === acc).length, 0), 'across the network'],
    ]
      .map(([k, v, s]) => `<div class="tile kvt"><div class="k">${k}</div><div class="big2">${v}</div><div class="mut" style="font-size:.78rem">${s}</div></div>`)
      .join('')
  );
  const item = (id: string) => (NF.items as Item[]).find(i => i.id === id);
  setHtml(
    'mn_claims',
    claims.length
      ? `<table class="dxt"><thead><tr><th>Type</th><th>NFT</th><th class="r">Amount</th><th>From</th><th></th></tr></thead><tbody>${claims.map(o => { const it = item(o.nft); return `<tr><td><span class="chip ${o.sell ? '' : 'b'}">${o.sell ? (o.amt.v === 0 ? 'Transfer to you' : 'Sale offer for you') : 'Buy offer on yours'}</span></td><td>${it ? `<a class="who" href="#" onclick="window.nm.open('${it.id}');return false">${esc(nameOf(it))}</a>` : esc(short(o.nft, 6, 4))}</td><td class="r">${esc(priceTxt(o.amt))}</td><td class="mono mut">${esc(sh(o.owner))}</td><td class="r"><button class="sm pri acc" onclick="window.nm.accept('${o.id}',${o.sell},this)">${o.sell ? (o.amt.v === 0 ? 'Claim' : 'Buy') : 'Accept offer'}</button></td></tr>`; }).join('')}</tbody></table>`
      : '<div class="mut" style="padding:.8rem">Nothing waiting for you.</div>'
  );
  setHtml('mn_owned', mine.length ? mine.map(i => { const o = listingOf(i.id); const mo = myOffers.find(x => x.sell && x.nft === i.id); return `<div class="nfcard" onclick="window.nm.open('${i.id}')">${img(i)}<div class="nfb"><b>${esc(nameOf(i))}</b><small class="mut">${esc(collName(NF.items.filter((x: Item) => collKey(x) === collKey(i))))}</small><div class="nfp">${priceCell(mo || o)}</div><div class="row" style="gap:.3rem;margin-top:.4rem" onclick="event.stopPropagation()">${mo ? `<button class="sm" onclick="window.nm.cancel('${mo.id}',this)">Unlist</button>` : `<button class="sm pri" onclick="window.nm.list('${i.id}')">List</button>`}<button class="sm" onclick="window.nm.send('${i.id}')">Send</button></div></div></div>`; }).join('') : '<div class="card mut" style="grid-column:1/-1;padding:1rem">You do not own any NFTs yet. Mint one, or buy from the marketplace.</div>');
  setHtml(
    'mn_offers',
    myOffers.length
      ? `<table class="dxt"><thead><tr><th>Type</th><th>NFT</th><th class="r">Amount</th><th>For</th><th>Expires</th><th></th></tr></thead><tbody>${myOffers.map(o => { const it = item(o.nft); return `<tr><td><span class="chip ${o.sell ? '' : 'b'}">${o.sell ? 'Listing' : 'Your offer'}</span></td><td>${it ? esc(nameOf(it)) : esc(short(o.nft, 6, 4))}</td><td class="r">${esc(priceTxt(o.amt))}</td><td class="mono mut">${o.dest ? esc(sh(o.dest)) : 'anyone'}</td><td class="mut">${o.exp ? new Date(rippleToMs(o.exp)).toLocaleString() : 'never'}</td><td class="r"><button class="sm" onclick="window.nm.cancel('${o.id}',this)">Cancel</button></td></tr>`; }).join('')}</tbody></table>`
      : '<div class="mut" style="padding:.8rem">No open listings or offers.</div>'
  );
  setHtml('mn_hist', actTable(NF.hist.slice(0, 250)));
}

/* ------------------------------ detail + actions ------------------------------ */
async function tx(t: any, btn?: HTMLButtonElement | null, ok = 'Done') {
  if (btn) btn.disabled = true;
  try {
    const r = await ctx.submit({ ...t, Account: me() });
    if (!r.ok) {
      ctx.toast('Rejected: ' + (r.msg || 'failed'), true);
      if (btn) btn.disabled = false;
      return false;
    }
    ctx.toast('✓ ' + ok);
    ctx.closeModal();
    NF.loadedAt = 0;
    NF.histAt = 0;
    await refresh(true);
    return true;
  } catch (e: any) {
    ctx.toast(String(e?.message || e), true);
    if (btn) btn.disabled = false;
    return false;
  }
}
const tokOpts = () => {
  const o: { k: string; l: string }[] = [{ k: 'native', l: nat() }];
  const seen = new Set(['native']);
  const px: M.Snap | null = NF.px;
  const add = (k: string) => { if (!k || seen.has(k)) return; seen.add(k); o.push({ k, l: hexName(k.split('|')[0]) }); };
  if (px) { if (px.usdKey) add(px.usdKey); for (const k of px.px.keys()) add(k); }
  return o;
};
const tokSelect = (id: string, sel = 'native') => `<select id="${id}">${tokOpts().map(t => `<option value="${esc(t.k)}" ${t.k === sel ? 'selected' : ''}>${esc(t.l)}</option>`).join('')}</select>`;
const priceInput = (id: string) => `<div class="row" style="gap:.5rem"><input id="${id}" class="grow" placeholder="Price" inputmode="decimal">${tokSelect(id + '_c')}</div>`;
const readAmt = (id: string, allowZero = false) => {
  const v = parseFloat(($(id) as HTMLInputElement).value);
  const c = ($(id + '_c') as HTMLSelectElement).value;
  if (!(v > 0) && !(allowZero && v === 0)) throw new Error('Enter a price.');
  if (c === 'native') return String(Math.round(v * 1e6));
  const a = c.split('|');
  return { currency: a[0], issuer: a[1], value: String(v) };
};
const expiry = (id: string) => {
  const d = parseFloat((($(id) as HTMLInputElement) || { value: '' }).value);
  return d > 0 ? { Expiration: rnow() + Math.round(d * 86400) } : {};
};
/* ------------------------------ mint studio (full page) + collection page ------------------------------ */
const stem = (n: string) => n.replace(/\.[^.]+$/, '');
const natCmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const ST: any = { items: [], cover: null, coverUrl: '', coll: '', cdesc: '', pat: '{coll} {n}', dpat: '', start: 1, pad: 0, roy: 5, taxon: '', tr: true, bu: true, price: '', ptok: 'native', sale: true, busy: false, stop: false, log: '', prog: 0, from: 'nfts' };
const fillPat = (p: string, n: number, f: string, total: number) =>
  p.replace(/\{coll\}/g, ST.coll || 'NFT').replace(/\{n\}/g, ST.pad > 0 ? String(n).padStart(ST.pad, '0') : String(n)).replace(/\{file\}/g, f).replace(/\{total\}/g, String(total));
const swapRoot = (html: string, id: string) => {
  const root = $('nm') || $('mn') || $('nms') || $('ncp') || $('ndp');
  if (!root) return null;
  const d = document.createElement('div');
  d.id = id;
  d.className = 'nwpage';
  d.innerHTML = html;
  root.replaceWith(d);
  return d;
};
function nameFor(i: number) {
  return fillPat(ST.pat || '{coll} {n}', (+ST.start || 1) + i, stem(ST.items[i].f.name), ST.items.length);
}
function applyNames(force: boolean) {
  ST.items.forEach((it: any, i: number) => {
    if (force || !it.ed) it.name = nameFor(i);
    if (ST.dpat && (force || !it.dd)) it.desc = fillPat(ST.dpat, (+ST.start || 1) + i, stem(it.f.name), ST.items.length);
    const e = $('ni_' + i) as HTMLInputElement | null;
    if (e) e.value = it.name;
    const d = $('nd_' + i) as HTMLInputElement | null;
    if (d) d.value = it.desc;
  });
  const pv = $('ns_prev');
  if (pv && ST.items.length) pv.textContent = `${ST.items[0].name} … ${ST.items[ST.items.length - 1].name}`;
}
async function fileOk(f: File): Promise<string> {
  if (f.size > MAXFILE) return `${f.name}: over 5 MB`;
  if (!TYPES.includes(f.type)) return `${f.name}: only PNG, JPEG, GIF, WebP, AVIF or SVG`;
  if (!(await sniff(f))) return `${f.name}: contents do not match its type (or SVG contains scripts)`;
  return '';
}
function studioHtml() {
  const n = ST.items.length;
  const rows = ST.items.map((it: any, i: number) => `<div class="nsr ${it.minted ? 'done' : ''}"><img src="${it.url}" alt=""><div class="nsf"><div class="row" style="gap:.4rem"><span class="mut mono" style="min-width:2.4rem">#${(+ST.start || 1) + i}</span><input id="ni_${i}" value="${esc(it.name)}" placeholder="Name" oninput="window.ns.ed(${i},'name',this.value)"></div><input id="nd_${i}" value="${esc(it.desc)}" placeholder="Description (optional)" oninput="window.ns.ed(${i},'desc',this.value)"><input value="${esc(it.attrs)}" placeholder="Traits: background=blue, hat=red" oninput="window.ns.ed(${i},'attrs',this.value)"></div><div class="nsx">${it.minted ? '<b class="up">✓</b>' : `<button class="sm ghost" title="Remove" onclick="window.ns.rm(${i})">✕</button>`}</div></div>`).join('');
  const price = parseFloat(ST.price);
  return `<div class="card" style="margin-bottom:1rem"><div class="row" style="justify-content:space-between;gap:.6rem;flex-wrap:wrap"><div><div class="k" style="margin:0">Mint studio</div><div class="mut" style="font-size:.82rem;margin-top:.3rem">One image for a single NFT, or a whole collection: name, number, describe and price every piece, add a cover, then mint. Files are stored on your NFT storage node; each NFT holds the ipfs:// address of its metadata.</div></div><button class="ghost" onclick="window.ns.back()">← Back</button></div></div>
  <div class="nsgrid"><div>
   <div class="card"><div class="k">1 · Images</div>
    <div class="nsdrop" id="ns_drop"><input id="ns_f" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml" multiple onchange="window.ns.add(this.files);this.value=''"><div><b>Drop images here</b> or choose files <span class="mut">(up to 500, each 5 MB)</span></div></div>
    <div id="ns_msg0" class="mut" style="font-size:.8rem;margin-top:.4rem"></div></div>
   <div class="card" style="margin-top:1rem"><div class="k">2 · Collection &amp; numbering</div>
    <div class="btgrid">
     <label class="btf"><span>Collection name (empty = single NFT)</span><input id="ns_c" value="${esc(ST.coll)}" placeholder="MAGICMINT" oninput="ST_set('coll',this.value)"></label>
     <label class="btf"><span>Name pattern ({n} number · {coll} · {file})</span><input id="ns_p" value="${esc(ST.pat)}" oninput="ST_set('pat',this.value)"></label>
     <label class="btf"><span>Start number</span><input id="ns_s" type="number" min="0" value="${ST.start}" oninput="ST_set('start',this.value)"></label>
     <label class="btf"><span>Zero padding (3 → 001)</span><input id="ns_z" type="number" min="0" max="6" value="${ST.pad}" oninput="ST_set('pad',this.value)"></label>
     <label class="btf" style="grid-column:1/-1"><span>Description for all (same tokens; optional)</span><input id="ns_dp" value="${esc(ST.dpat)}" oninput="ST_set('dpat',this.value)"></label>
     <label class="btf" style="grid-column:1/-1"><span>Collection description (shown on the collection page)</span><input id="ns_cd" value="${esc(ST.cdesc)}" oninput="ST_set('cdesc',this.value)"></label>
    </div>
    <div class="row" style="gap:.5rem;margin-top:.5rem;flex-wrap:wrap"><button class="sm" onclick="window.ns.apply(true)">Apply to every item</button><button class="sm ghost" onclick="window.ns.sort()">Sort by file name</button><span id="ns_prev" class="mut mono" style="font-size:.78rem"></span></div>
    <div class="mut" style="font-size:.76rem;margin-top:.3rem">Example: pattern “MAGICMINT {n}”, start 1 with 500 images gives MAGICMINT 1 … MAGICMINT 500. Names you edit by hand are kept when you change the pattern, unless you press Apply to every item.</div></div>
   <div class="card" style="margin-top:1rem"><div class="k">3 · Cover image (minted as the collection’s NFT)</div>
    <div class="row" style="gap:.8rem;align-items:center">${ST.coverUrl ? `<img src="${ST.coverUrl}" class="nscov">` : '<div class="nscov ph">no cover</div>'}<div><input id="ns_cv" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml" onchange="window.ns.cover(this.files)">${ST.coverUrl ? '<button class="sm ghost" onclick="window.ns.cover(null)">Remove</button>' : ''}<div class="mut" style="font-size:.76rem;margin-top:.3rem">It is a real NFT in the same collection: you can move, send or list it like any other. The collection page uses it as its picture.</div></div></div></div>
   <div class="card" style="margin-top:1rem"><div class="k">4 · Rules &amp; price</div>
    <div class="btgrid"><label class="btf"><span>Royalty %</span><input id="ns_r" type="number" min="0" max="50" step="0.1" value="${ST.roy}" oninput="ST_set('roy',this.value)"></label><label class="btf"><span>Collection ID (taxon, empty = auto)</span><input value="${esc(ST.taxon)}" oninput="ST_set('taxon',this.value)"></label>
     <label class="row" style="gap:.5rem"><input type="checkbox" ${ST.tr ? 'checked' : ''} style="width:auto" onchange="ST_set('tr',this.checked)"> <span>Transferable</span></label><label class="row" style="gap:.5rem"><input type="checkbox" ${ST.bu ? 'checked' : ''} style="width:auto" onchange="ST_set('bu',this.checked)"> <span>Burnable by me</span></label>
     <label class="btf"><span>Mint price per NFT (empty = not for sale)</span><div class="row" style="gap:.4rem"><input id="ns_pr" class="grow" value="${esc(ST.price)}" inputmode="decimal" placeholder="e.g. 25" oninput="ST_set('price',this.value)">${tokSelect('ns_pt', ST.ptok).replace('<select ', '<select onchange="ST_set(\'ptok\',this.value)" ')}</div></label>
     <label class="row" style="gap:.5rem;align-items:flex-start"><input type="checkbox" ${ST.sale ? 'checked' : ''} style="width:auto;margin-top:.2rem" onchange="ST_set('sale',this.checked)"> <span>Open the public mint: list every item at the mint price, so anyone can press <b>Mint</b> on the collection page and receive the next one</span></label></div></div>
  </div><div>
   <div class="card" style="position:sticky;top:.6rem"><div class="k">5 · Review &amp; mint <span class="mut">${n} item${n === 1 ? '' : 's'}${ST.cover ? ' + cover' : ''}</span></div>
    <div class="nsrows" id="ns_rows">${rows || '<div class="mut" style="padding:1rem">No images yet. Drop some on the left.</div>'}</div>
    <div class="mut" style="font-size:.76rem;margin:.5rem 0">Showing about five at a time: scroll the list to edit the rest. Traits are optional: <span class="mono">trait=value, trait=value</span>.</div>
    <div id="ns_sum" class="mut" style="font-size:.82rem"></div>
    <div class="nsbar"><i id="ns_bar" style="width:${ST.prog}%"></i></div><div id="ns_msg" class="mut" style="font-size:.8rem;margin:.4rem 0;white-space:pre-wrap">${esc(ST.log)}</div>
    <div class="row" style="gap:.5rem"><button id="ns_go" class="pri acc grow" onclick="window.ns.go(this)" ${ST.busy ? 'disabled' : ''}>${n > 1 || ST.cover ? 'Mint collection' : 'Mint NFT'}${price > 0 && ST.sale ? ' &amp; open public mint' : ''}</button>${ST.busy ? '<button onclick="window.ns.halt()">Stop</button>' : ''}</div></div>
  </div></div>`;
}
(window as any).ST_set = (k: string, v: any) => {
  ST[k] = k === 'tr' || k === 'bu' || k === 'sale' ? !!v : v;
  if (['coll', 'pat', 'start', 'pad', 'dpat'].includes(k)) {
    if (k === 'coll' && /^\{coll\} \{n\}$/.test(ST.pat) === false && !ST.pat) ST.pat = '{coll} {n}';
    applyNames(false);
  }
  ns_sum();
};
function ns_sum() {
  const e = $('ns_sum');
  if (!e) return;
  const n = ST.items.length + (ST.cover ? 1 : 0);
  const p = parseFloat(ST.price);
  const tl = tokOpts().find(t => t.k === ST.ptok);
  e.textContent = `${n} mint transaction${n === 1 ? '' : 's'}${p > 0 && ST.sale ? ` + ${ST.items.length} sell offers at ${fmt(p)} ${tl ? tl.l : ''} each (total ${fmt(p * ST.items.length)} ${tl ? tl.l : ''} if everything sells)` : ''}. Each costs a small network fee.`;
}
function studioPaint() {
  const r = $('nms');
  if (!r) return;
  r.innerHTML = studioHtml();
  applyNames(false);
  ns_sum();
  const d = $('ns_drop');
  if (d) {
    d.ondragover = e => { e.preventDefault(); d.classList.add('on'); };
    d.ondragleave = () => d.classList.remove('on');
    d.ondrop = e => { e.preventDefault(); d.classList.remove('on'); nsApi.add((e as DragEvent).dataTransfer!.files); };
  }
}
const nsApi: any = {
  open(from = 'nfts') {
    ST.from = from;
    if (xr()) { if (ST.roy === 5) { ST.roy = 0; ST.royAuto = true; } } else if (ST.royAuto) { ST.roy = 5; ST.royAuto = false; }   // XRPL marketplace: no royalty by default (no sale fee)
    if (!me()) return ctx.toast('Select or create a wallet first.', true);
    if (!swapRoot('', 'nms')) return;
    studioPaint();
  },
  back() { ST.items.forEach((i: any) => URL.revokeObjectURL(i.url)); ST.items = []; ST.cover = null; ST.coverUrl = ''; ST.log = ''; ST.prog = 0; (window as any).goTab(ST.from || 'nfts'); },
  ed(i: number, k: string, v: string) { const it = ST.items[i]; if (!it) return; if (k === 'name') { it.name = v; it.ed = true; } else if (k === 'desc') { it.desc = v; it.dd = true; } else it.attrs = v; },
  rm(i: number) { URL.revokeObjectURL(ST.items[i].url); ST.items.splice(i, 1); applyNames(false); studioPaint(); },
  apply(force: boolean) { if (force) ST.items.forEach((i: any) => { i.ed = false; i.dd = false; }); applyNames(true); },
  sort() { ST.items.sort((a: any, b: any) => natCmp(a.f.name, b.f.name)); applyNames(false); studioPaint(); },
  async add(fl: FileList | null) {
    const files = Array.from(fl || []).sort((a, b) => natCmp(a.name, b.name));
    const bad: string[] = [];
    for (const f of files) {
      if (ST.items.length >= 500) { bad.push('limit of 500 items reached'); break; }
      const e = await fileOk(f);
      if (e) { bad.push(e); continue; }
      ST.items.push({ f, url: URL.createObjectURL(f), name: '', desc: '', attrs: '', ed: false, dd: false });
    }
    applyNames(false);
    studioPaint();
    const m = $('ns_msg0');
    if (m) m.innerHTML = bad.length ? `<span class="crit">${bad.slice(0, 5).map(esc).join('<br>')}${bad.length > 5 ? `<br>and ${bad.length - 5} more` : ''}</span>` : '';
  },
  async cover(fl: FileList | null) {
    if (ST.coverUrl) URL.revokeObjectURL(ST.coverUrl);
    ST.cover = null;
    ST.coverUrl = '';
    const f = fl && fl[0];
    if (f) { const e = await fileOk(f); if (e) ctx.toast(e, true); else { ST.cover = f; ST.coverUrl = URL.createObjectURL(f); } }
    studioPaint();
  },
  halt() { ST.stop = true; },
  async go(btn: HTMLButtonElement) {
    const msg = (t: string, p?: number) => { ST.log = t; if (p != null) ST.prog = p; const e = $('ns_msg'); if (e) e.textContent = t; const b = $('ns_bar'); if (b) b.style.width = ST.prog + '%'; };
    const ip = IP(), api = ip.api.replace(/\/$/, '');
    const n = ST.items.length;
    if (!n && !ST.cover) return msg('Add at least one image.');
    const roy = Math.round(parseFloat(String(ST.roy || 0)) * 1000);
    if (!(roy >= 0 && roy <= 50000)) return msg('Royalty must be between 0 and 50%.');
    const price = parseFloat(ST.price);
    const sale = price > 0 && ST.sale;
    if (ST.price && !(price > 0)) return msg('The mint price must be a number above zero (or empty).');
    const coll = String(ST.coll || '').trim();
    if (sale && !coll && n > 1) return msg('Give the collection a name so the public mint has a collection page.');
    let taxon = parseInt(ST.taxon, 10);
    if (!(taxon >= 0)) { let h = 7; for (const ch of coll || me() + Date.now()) h = (h * 31 + ch.charCodeAt(0)) >>> 1; taxon = h % 2147483647; }
    const flags = (ST.tr ? TF_TRANSFER : 0) | (ST.bu ? TF_BURN : 0);
    if (sale && !(flags & TF_TRANSFER)) return msg('A public mint needs “Transferable” switched on.');
    const add = async (blob: Blob, name: string): Promise<string> => {
      const fd = new FormData();
      fd.append('file', blob, name);
      let r: Response;
      try { r = await fetch(`${api}/api/v0/add?pin=true&cid-version=1&raw-leaves=true`, { method: 'POST', body: fd, headers: { 'ngrok-skip-browser-warning': '1' } }); }
      catch { throw new Error(`Cannot reach the NFT storage node (${api}).\nOpen the LUMA control panel → NFT storage → Start (Docker must be running), then press Mint again: nothing is lost, finished items are skipped.`); }
      if (!r.ok) throw new Error('IPFS add failed: HTTP ' + r.status);
      const lines = (await r.text()).trim().split('\n');
      return JSON.parse(lines[lines.length - 1]).Hash;
    };
    const tl = tokOpts().find(t => t.k === ST.ptok);
    const tokObj = ST.ptok === 'native' ? { cur: nat(), issuer: '' } : { cur: ST.ptok.split('|')[0], issuer: ST.ptok.split('|')[1] };
    ST.busy = true;
    ST.stop = false;
    studioPaint();
    const total = n + (ST.cover ? 1 : 0) + (sale ? n : 0);
    let done = 0;
    const step = () => Math.round((done / total) * 100);
    try {
      // 1) upload everything first (3 at a time): a storage problem stops the run before anything is minted
      const queue = ST.items.filter((i: any) => !i.uri);
      let up = 0;
      const doUp = async (it: any, idx: number) => {
        if (ST.stop) throw new Error('Stopped. Nothing is lost: press Mint to continue.');
        const cid = it.cid || (it.cid = await add(it.f, it.f.name));
        const attrs = String(it.attrs || '').split(',').map(x => x.trim()).filter(Boolean).map(x => { const [k, ...v] = x.split('='); return { trait_type: k.trim(), value: v.join('=').trim() }; }).filter(a => a.trait_type && a.value);
        const meta = { name: it.name || stem(it.f.name), description: it.desc || '', image: 'ipfs://' + cid, attributes: attrs, edition: (+ST.start || 1) + ST.items.indexOf(it), ...(coll ? { collection: { name: coll, description: ST.cdesc || '' } } : {}) };
        const mc = await add(new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'metadata.json');
        it.uri = 'ipfs://' + mc;
        up++;
        msg(`Uploading ${up}/${queue.length}…`, Math.round((up / Math.max(1, queue.length)) * 8));
      };
      let k = 0;
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { while (k < queue.length) { const it = queue[k++]; await doUp(it, 0); } }));
      if (ST.cover && !ST.coverUri) {
        const cid = await add(ST.cover, ST.cover.name);
        const meta = { name: `${coll || 'NFT'} · Cover`, description: ST.cdesc || '', image: 'ipfs://' + cid, attributes: [], collection: { name: coll, description: ST.cdesc || '', cover: true, total: n, mint: sale ? { price, token: tokObj, public: true } : { public: false } } };
        ST.coverUri = 'ipfs://' + (await add(new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'metadata.json'));
      }
      const mintOne = async (uri: string) => {
        if (xr()) await payMintFee(me(), taxon, uri);
        const r = await ctx.submit({ TransactionType: 'NFTokenMint', Account: me(), NFTokenTaxon: taxon, Flags: flags, TransferFee: flags & TF_TRANSFER ? roy : 0, URI: strToHex(uri) });
        if (!r.ok) throw new Error('Mint was rejected: ' + r.msg);
        return '';
      };
      // 2) cover first (lowest serial), then the items in order
      if (ST.cover && !ST.coverId) { msg('Minting the cover NFT…', step()); ST.coverId = (await mintOne(ST.coverUri)) || 'minted'; done++; }
      else if (ST.cover) done++;
      for (let i = 0; i < ST.items.length; i++) {
        const it = ST.items[i];
        if (it.minted) { done++; continue; }
        if (ST.stop) throw new Error(`Stopped after ${done} of ${total}. Press Mint to continue where it left off.`);
        msg(`Minting ${i + 1}/${n}: ${it.name}`, step());
        it.id = await mintOne(it.uri);
        it.minted = true;
        done++;
      }
      // 3) public mint: sell offers at the mint price in the chosen token
      if (sale) {
        if (ST.ptok !== 'native') { try { await ctx.submit({ TransactionType: 'TrustSet', Account: me(), LimitAmount: { currency: tokObj.cur, issuer: tokObj.issuer, value: '1000000000000' } }); } catch {} }
        const amount: any = ST.ptok === 'native' ? String(Math.round(price * 1e6)) : { currency: tokObj.cur, issuer: tokObj.issuer, value: String(price) };
        const byUri = new Map<string, string>();
        for (const x of (await nftsOf(me()).catch(() => [])) as any[]) byUri.set(hexToStr(x.URI || ''), String(x.NFTokenID));
        for (let i = 0; i < ST.items.length; i++) {
          const it = ST.items[i];
          if (it.listed) { done++; continue; }
          if (ST.stop) throw new Error(`Stopped while opening the public mint (${i}/${n} listed). Press Mint to continue.`);
          if (!it.id) it.id = byUri.get(it.uri) || '';
          if (!it.id) throw new Error(`Could not find ${it.name} in your wallet to list it.`);
          msg(`Listing ${i + 1}/${n} at ${fmt(price)} ${tl ? tl.l : ''}`, step());
          const r = await ctx.submit({ TransactionType: 'NFTokenCreateOffer', Account: me(), NFTokenID: it.id, Amount: amount, Flags: 1 });
          if (!r.ok) throw new Error('Listing was rejected: ' + r.msg);
          it.listed = true;
          done++;
        }
      }
      ST.prog = 100;
      ctx.toast(`✓ Minted ${n + (ST.cover ? 1 : 0)} NFT${n > 0 ? 's' : ''}${sale ? ' and opened the public mint' : ''}`);
      NF.loadedAt = 0;
      await refresh(true);
      ST.busy = false;
      const key = me() + ':' + taxon;
      ST.items = []; ST.cover = null; ST.coverId = ''; ST.coverUri = ''; ST.coverUrl = ''; ST.log = ''; ST.prog = 0;
      if (coll) collPage(key); else (window as any).goTab('nfts');
    } catch (e: any) {
      ST.busy = false;
      msg(String(e?.message || e));
      studioPaint();
      NF.loadedAt = 0;
      refresh(true);
    }
  },
};
(window as any).ns = nsApi;

/* ---- collection page: cover, details, public Mint button, items ---- */
const CP: any = { key: '', timer: 0, qty: 1 };
function collData(k: string) {
  const list: Item[] = (NF.items as Item[]).filter(i => collKey(i) === k);
  const metas = list.map(i => ({ i, m: NF.meta.get(i.id) as Meta | null }));
  const cover = metas.find(x => x.m && x.m.cover);
  const info = cover ? cover.m! : (metas.find(x => x.m && x.m.coll)?.m || null);
  const items = list.filter(i => !cover || i.id !== cover.i.id).sort((a, b) => a.serial - b.serial);
  const creator = list.length ? list[0].issuer : '';
  const avail = items.map(i => ({ i, o: (NF.offers as Offer[]).filter(o => o.nft === i.id && o.sell && !o.dest && live(o) && o.owner === creator && i.owner === creator).sort((a, b) => a.amt.v - b.amt.v)[0] })).filter(x => x.o) as { i: Item; o: Offer }[];
  const owners = new Set(items.map(i => i.owner));
  const sales: Act[] = (NF.act as Act[]).filter(a => a.sale && items.some(i => i.id === a.nft));
  return { list, items, cover, info, creator, avail, owners, sales, name: (info && info.coll) || collName(list) };
}
function collHtml() {
  const d = collData(CP.key);
  if (!d.list.length) return `<div class="card"><button class="ghost" onclick="window.cp.back()">← Back</button><div class="mut" style="padding:1.5rem">Reading this collection from the ledger…</div></div>`;
  const first = d.avail[0];
  const mp = (d.info && d.info.mint && d.info.mint.price) || (first ? first.o.amt.v : null);
  const unit = first ? first.o.amt.cur : d.info && d.info.mint && d.info.mint.token ? d.info.mint.token.cur : '';
  const minted = d.items.length, total = (d.info && d.info.total) || minted, mine = d.creator === me();
  const heroImg = d.cover ? img(d.cover.i, 'big') : d.items[0] ? img(d.items[0], 'big') : '';
  const q = Math.max(1, Math.min(CP.qty, Math.min(20, d.avail.length || 1)));
  const stat = (k: string, v: string, s = '') => `<div class="tile kvt"><div class="k">${k}</div><div class="big2">${v}</div><div class="mut" style="font-size:.78rem">${s}</div></div>`;
  const floor = d.avail.length ? Math.min(...d.avail.map(x => priceN(x.o.amt) ?? 1e18)) : null;
  const vol = d.sales.reduce((t, s) => t + (s.amtN || 0), 0);
  return `<div class="row" style="margin-bottom:.8rem"><button class="ghost" onclick="window.cp.back()">← Back</button><button class="sm ghost" onclick="window.cp.refresh()">Refresh</button></div>
  <div class="card cpmain"><div class="cpimg">${heroImg}</div><div class="cpinfo"><span class="chip">COLLECTION</span><h1 style="margin:.3rem 0">${esc(d.name)}</h1><div class="mut">by <span class="mono">${esc(sh(d.creator))}</span>${mine ? ' · you' : ''}</div>
    <p class="mut">${esc((d.info && d.info.cdesc) || 'A native XLS-20 NFT collection.')}</p>
    <div class="row" style="gap:1.4rem;flex-wrap:wrap"><div><div class="k">Mint price</div><div class="big2">${mp != null ? esc(fmt(mp) + ' ' + unit) : 'not for sale'}</div><small class="mut">${first ? usdTxt(priceN(first.o.amt)) : ''}</small></div><div><div class="k">Minted</div><div class="big2">${minted - d.avail.length} / ${total}</div></div><div><div class="k">Available</div><div class="big2">${d.avail.length}</div></div></div>
    <div class="nsbar" style="margin:.8rem 0"><i style="width:${total ? Math.round(((minted - d.avail.length) / total) * 100) : 0}%"></i></div>
    <div class="row" style="gap:.6rem;flex-wrap:wrap;align-items:center">${d.avail.length && !mine ? `<input id="cp_q" type="number" min="1" max="${Math.min(20, d.avail.length)}" value="${q}" style="width:5rem" oninput="window.cp.qty(this.value)"><button id="cp_mint" class="pri acc" onclick="window.cp.mint(this)">Mint ${q}${mp != null ? ' for ' + esc(fmt(mp * q) + ' ' + unit) : ''}</button>` : mine ? '<span class="mut">You created this collection. Others can mint from this page.</span>' : '<b class="mut">Sold out or not open for minting</b>'}</div>
    <div class="mut" style="font-size:.76rem;margin-top:.5rem">Minting buys the next available NFT straight from the creator at the mint price. The creator’s royalty is built into the NFT; nothing else is charged.</div>
    ${mine ? `<div class="card" style="margin-top:.8rem"><div class="k">Creator tools</div><div class="row" style="gap:.5rem;flex-wrap:wrap">${priceInput('cp_np')}<button class="sm" onclick="window.cp.reprice(this)">Set price for the ${d.items.filter(i => i.owner === d.creator).length} unsold</button><button class="sm ghost" onclick="window.cp.unlist(this)">Close the mint (cancel listings)</button></div></div>` : ''}</div></div>
  <div class="pgrid nwk" style="margin-top:1rem">${stat('Items', fmt(minted, 0), d.cover ? '+ cover' : '')}${stat('Owners', fmt(d.owners.size, 0), minted ? ((d.owners.size / minted) * 100).toFixed(0) + '% unique' : '')}${stat('Floor', floor != null && floor < 1e17 ? fmt(floor) + ' ' + nat() : '–', floor != null && floor < 1e17 ? usdTxt(floor) : '')}${stat('Sales', fmt(d.sales.length, 0), '')}${stat('Volume', vol ? fmt(vol) + ' ' + nat() : '–', vol ? usdTxt(vol) : '')}${stat('Royalty', d.list[0] ? (d.list[0].fee / 1000).toFixed(1) + '%' : '–', '')}</div>
  <div class="nwh">Items (${minted})</div><div class="nf4 many" style="max-height:60vh;overflow:auto">${d.items.map(card).join('') || '<div class="mut">No items.</div>'}</div>`;
}
function collPage(k: string) {
  CP.key = k;
  const r = swapRoot('', 'ncp');
  if (!r) return;
  const paintC = () => { const e = $('ncp'); if (!e) { clearInterval(CP.timer); return; } const h = collHtml(); if ((e as any).__h !== h) { e.innerHTML = h; (e as any).__h = h; } };
  paintC();
  clearInterval(CP.timer);
  CP.timer = setInterval(async () => { if (!$('ncp')) return clearInterval(CP.timer); await index(false); paintC(); }, 8000);
  CP.paint = paintC;
  index(true).then(() => metaFill(NF.items.filter((i: Item) => collKey(i) === k)).then(paintC));
}
const cpApi: any = {
  back() { clearInterval(CP.timer); (window as any).goTab('nftmarket'); },
  refresh() { NF.loadedAt = 0; index(true).then(() => CP.paint && CP.paint()); },
  qty(v: string) { CP.qty = Math.max(1, parseInt(v, 10) || 1); const d = collData(CP.key), b = $('cp_mint'); if (b) { const f = d.avail[0]; b.textContent = `Mint ${CP.qty}` + (f ? ' for ' + fmt(f.o.amt.v * CP.qty) + ' ' + f.o.amt.cur : ''); } },
  async mint(btn: HTMLButtonElement) {
    const d = collData(CP.key);
    const n = Math.max(1, Math.min(CP.qty, d.avail.length, 20));
    const picks = d.avail.slice(0, n);
    if (!picks.length) return ctx.toast('Nothing left to mint.', true);
    const tot = picks.reduce((t, p) => t + p.o.amt.v, 0);
    if (!confirm(`Mint ${n} for ${fmt(tot)} ${picks[0].o.amt.cur}? The price goes to the creator.`)) return;
    btn.disabled = true;
    let ok = 0;
    for (const p of picks) {
      const r = await ctx.submit({ TransactionType: 'NFTokenAcceptOffer', Account: me(), NFTokenSellOffer: p.o.id });
      if (!r.ok) { ctx.toast(`Stopped after ${ok}: ${r.msg || 'rejected'} (someone else may have minted it first)`, true); break; }
      ok++;
    }
    if (ok) ctx.toast(`✓ Minted ${ok} NFT${ok > 1 ? 's' : ''}: find them in My NFTs`);
    NF.loadedAt = 0;
    await index(true);
    CP.paint && CP.paint();
  },
  async unlist(btn: HTMLButtonElement) {
    const d = collData(CP.key);
    const ids = d.avail.map(x => x.o.id);
    if (!ids.length || !confirm(`Cancel ${ids.length} listings and close the public mint?`)) return;
    btn.disabled = true;
    for (let i = 0; i < ids.length; i += 100) { const r = await ctx.submit({ TransactionType: 'NFTokenCancelOffer', Account: me(), NFTokenOffers: ids.slice(i, i + 100) }); if (!r.ok) { ctx.toast('Rejected: ' + r.msg, true); break; } }
    NF.loadedAt = 0; await index(true); CP.paint && CP.paint();
  },
  async reprice(btn: HTMLButtonElement) {
    const d = collData(CP.key);
    let amt: any;
    try { amt = readAmt('cp_np'); } catch (e: any) { return ctx.toast(e.message, true); }
    const mine = d.items.filter(i => i.owner === d.creator);
    if (!mine.length || !confirm(`List ${mine.length} unsold NFTs at the new price? Old listings are cancelled first.`)) return;
    btn.disabled = true;
    const old = d.avail.map(x => x.o.id);
    for (let i = 0; i < old.length; i += 100) await ctx.submit({ TransactionType: 'NFTokenCancelOffer', Account: me(), NFTokenOffers: old.slice(i, i + 100) });
    if (typeof amt !== 'string') { try { await ctx.submit({ TransactionType: 'TrustSet', Account: me(), LimitAmount: { currency: amt.currency, issuer: amt.issuer, value: '1000000000000' } }); } catch {} }
    let ok = 0;
    for (const i of mine) { const r = await ctx.submit({ TransactionType: 'NFTokenCreateOffer', Account: me(), NFTokenID: i.id, Amount: amt, Flags: 1 }); if (!r.ok) { ctx.toast('Stopped: ' + r.msg, true); break; } ok++; }
    ctx.toast(`✓ ${ok} listed`);
    NF.loadedAt = 0; await index(true); CP.paint && CP.paint();
  },
};
(window as any).cp = cpApi;

export const nmApi = {
  tab(k: string) { NF.tab = k; NF.page = 0; paint(); },
  search(v: string) { NF.q = v; NF.page = 0; paintMarket(); },
  sort(v: string) { const [k, d] = v.split(':'); NF.sort = k; NF.sdir = +d || 1; NF.page = 0; paintMarket(); },
  fl(k: string, v: string) { (NF as any)[k] = k === 'per' ? +v : v; NF.page = 0; paintMarket(); },
  reset() { Object.assign(NF, { q: '', st: 'all', pmin: '', pmax: '', coll: '', sort: 'new', sdir: -1, page: 0 }); const q = $('nm_q') as HTMLInputElement | null; if (q) q.value = ''; for (const [id, v] of [['nm_st', 'all'], ['nm_pmin', ''], ['nm_pmax', '']]) { const e = $(id) as HTMLInputElement | null; if (e) e.value = v; } paintMarket(); },
  cs(k: string) { if (NF.csort === k) NF.cdir = -NF.cdir; else { NF.csort = k; NF.cdir = k === 'name' ? 1 : -1; } paintMarket(); },
  csv() { const l = filtered(), q = (v: any) => '"' + String(v ?? '').replace(/"/g, '""') + '"'; const rows = [['Name', 'Collection', 'Price', 'Token', 'Owner', 'Royalty %', 'Serial', 'NFT ID']].concat(l.map((i: Item) => { const o = listingOf(i.id); return [nameOf(i), collName(NF.items.filter((x: Item) => collKey(x) === collKey(i))), o ? String(o.amt.v) : '', o ? o.amt.cur : '', i.owner, (i.fee / 1000).toFixed(1), String(i.serial), i.id]; })); const blob = new Blob([rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'nfts.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); },
  hs(k: string) { if (NF.sort === k) NF.sdir = -NF.sdir; else { NF.sort = k; NF.sdir = k === 'new' || k === 'roy' ? -1 : 1; } NF.page = 0; paintMarket(); },
  view(v: string) { setView(v); paintMarket(); const m = $('mn'); if (m) paint(); },
  pg(p: number) { NF.page = Math.max(0, p); paintMarket(); $('nm_list')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  full: (id: string) => fullscreen(id),
  nextFeat() { rotateFeat(); NF.featAt = Date.now(); },
  dback() { const p = NF.prev || { t: 'tab', v: 'nftmarket' }; if (p.t === 'coll') collPage(p.v); else (window as any).goTab(p.v); },
  coll(k: string) { if (!k) { NF.coll = ''; paintMarket(); return; } collPage(k); },
  items(k: string) { NF.coll = k; NF.tab = 'items'; NF.page = 0; paintMarket(); },
  refresh() { NF.histAt = 0; refresh(true); },
  open: (id: string) => detail(id),
  async buy(offerId: string, btn: HTMLButtonElement) {
    const o = (NF.offers as Offer[]).find(x => x.id === offerId);
    if (!o) return ctx.toast('That listing is gone.', true);
    if (!confirm(`Buy for ${priceTxt(o.amt)}? Royalties are paid automatically.`)) return;
    tx({ TransactionType: 'NFTokenAcceptOffer', NFTokenSellOffer: offerId }, btn, 'NFT bought');
  },
  accept(offerId: string, sell: boolean, btn: HTMLButtonElement) {
    tx({ TransactionType: 'NFTokenAcceptOffer', ...(sell ? { NFTokenSellOffer: offerId } : { NFTokenBuyOffer: offerId }) }, btn, sell ? 'Done' : 'Offer accepted');
  },
  cancel(offerId: string, btn: HTMLButtonElement) {
    tx({ TransactionType: 'NFTokenCancelOffer', NFTokenOffers: [offerId] }, btn, 'Cancelled');
  },
  burn(id: string, btn: HTMLButtonElement) {
    if (!confirm('Burn this NFT forever?')) return;
    tx({ TransactionType: 'NFTokenBurn', NFTokenID: id }, btn, 'Burned');
  },
  list(id: string) {
    ctx.modal(`<h2>List for sale</h2><p class="mut">${esc(nameOf((NF.items as Item[]).find(i => i.id === id)!))}. The buyer pays the price; the creator royalty is taken automatically.</p>${priceInput('nl_p')}<label class="mut" style="font-size:.8rem;display:block;margin:.6rem 0 .2rem">Expires after (days, empty = never)</label><input id="nl_e" inputmode="decimal"><div class="row" style="margin-top:1rem"><button class="grow" onclick="window.closeModal()">Cancel</button><button class="pri acc grow" onclick="window.nm.doList('${id}',this)">List</button></div>`);
  },
  doList(id: string, btn: HTMLButtonElement) {
    try { tx({ TransactionType: 'NFTokenCreateOffer', NFTokenID: id, Amount: readAmt('nl_p'), Flags: 1, ...expiry('nl_e') }, btn, 'Listed'); } catch (e: any) { ctx.toast(e.message, true); }
  },
  offer(id: string) {
    const i = (NF.items as Item[]).find(x => x.id === id)!;
    ctx.modal(`<h2>Make an offer</h2><p class="mut">Your offer stays open until the owner accepts or you cancel it. Cancelling is free.</p>${priceInput('no_p')}<label class="mut" style="font-size:.8rem;display:block;margin:.6rem 0 .2rem">Expires after (days, empty = never)</label><input id="no_e" inputmode="decimal"><div class="row" style="margin-top:1rem"><button class="grow" onclick="window.closeModal()">Cancel</button><button class="pri acc grow" onclick="window.nm.doOffer('${id}','${i.owner}',this)">Send offer</button></div>`);
  },
  doOffer(id: string, owner: string, btn: HTMLButtonElement) {
    try { tx({ TransactionType: 'NFTokenCreateOffer', NFTokenID: id, Amount: readAmt('no_p'), Owner: owner, Flags: 0, ...expiry('no_e') }, btn, 'Offer sent'); } catch (e: any) { ctx.toast(e.message, true); }
  },
  send(id: string) {
    ctx.modal(`<h2>Send NFT</h2><p class="mut">Creates a free transfer offer that only the receiver can accept (they claim it under My NFTs).</p><input id="ns_to" placeholder="Receiver address (L… / T… / r…)"><div class="row" style="margin-top:1rem"><button class="grow" onclick="window.closeModal()">Cancel</button><button class="pri acc grow" onclick="window.nm.doSend('${id}',this)">Send</button></div>`);
  },
  doSend(id: string, btn: HTMLButtonElement) {
    let to = '';
    try { to = ctx.toClassic(($('ns_to') as HTMLInputElement).value.trim()); } catch { return ctx.toast('That is not a valid address.', true); }
    tx({ TransactionType: 'NFTokenCreateOffer', NFTokenID: id, Amount: '0', Destination: to, Flags: 1 }, btn, 'Transfer offered');
  },
  /* ---- mint: full page ---- */
  mint() { nsApi.open($('mn') ? 'nfts' : 'nftmarket'); }
};
