import * as xrpl from 'xrpl';
import QRCode from 'qrcode';
import * as LumaAddr from './lumaAddr.ts';
import { setCtx } from './live/ctx.ts';
import { nameToCur, akey } from './live/util.ts';
import * as M from './live/market.ts';
import * as Dex from './live/dex.ts';
import * as Pages from './live/pages.ts';
import { lpApi } from './live/lp.ts';
import * as Supply from './live/supply.ts';
import * as Bot from './live/bot.ts';
import * as Mg from './live/margin.ts';
import * as PL from './live/poolinfo.ts';
import * as Bn from './live/burn.ts';
import * as Nft from './live/nft.ts';
import * as Hist from './live/history.ts';
import * as Hold from './live/holders.ts';
import { tkApi } from './live/tokens.ts';
import { xaApi } from './live/xassets.ts';
import { clearCache } from './live/chain.ts';
import { startTopStats, refreshTopStats } from './live/topstats.ts';
import { xclient } from './live/bridge.ts';

// Types
export interface NetworkDef {
  id: string;
  name: string;
  url: string;
  fallbacks: string[];
  prefix: string;
  native: string;
  networkId?: number;
  rpc?: string;
  controlPanel?: string;
  fund?: string;
  fundAmt?: string;
  faucet?: string;
  isXrpl?: boolean;
}

export interface AccountData {
  id: string;
  label: string;
  seed: string;
  address: string; // classic r-address or L-address
  type: 'luma' | 'xrpl';
  xrplLinkedAddress?: string; // Linked XRPL classic address if any
}

export interface VaultState {
  data: {
    accounts: AccountData[];
    active: string | null;
  };
  key: CryptoKey;
  salt: Uint8Array;
  iter: number;
}

export interface StoredVault {
  v: number;
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

export interface TradingPair {
  b: { c: string; i?: string }; // Base
  q: { c: string; i?: string }; // Quote
}

export interface AppConfig {
  net: string;
  urls: Record<string, string>;
  usd: Record<string, number>;
  book: Array<{ name: string; addr: string }>;
  lockMin: number;
  pairs: Record<string, TradingPair[]>;
  pair: Record<string, string>;
}

// Built-in WSS networks (LUMA Mainnet Network 4242 & Testnet 4243)
export const NETS: NetworkDef[] = [
  {
    id: 'main',
    name: 'LUMA Mainnet',
    networkId: 4242,
    url: 'ws://127.0.0.1:6006',
    fallbacks: [],
    prefix: 'L',
    native: 'LUMA',
    rpc: 'http://127.0.0.1:5006',
    controlPanel: 'http://127.0.0.1:8090',
    fund: 'http://127.0.0.1:8090/api/fund-new',
    fundAmt: '1 LUMA',
  },
  {
    id: 'test',
    name: 'LUMA Testnet',
    networkId: 4243,
    url: 'ws://127.0.0.1:6106',
    fallbacks: [],
    prefix: 'T',
    native: 'LUMA',
    rpc: 'http://127.0.0.1:5106',
    controlPanel: 'http://127.0.0.1:8091',
    fund: 'http://127.0.0.1:8091/api/fund-new',
    fundAmt: '100 LUMA',
    faucet: 'http://127.0.0.1:8091/api/faucet',
  },
  {
    id: 'xrpl-main',
    name: 'XRPL Mainnet',
    networkId: 0,
    url: 'wss://xrplcluster.com',
    fallbacks: ['wss://s1.ripple.com', 'wss://s2.ripple.com'],
    prefix: 'r',
    native: 'XRP',
    isXrpl: true,
  },
  {
    id: 'xrpl-test',
    name: 'XRPL Testnet',
    networkId: 1,
    url: 'wss://s.altnet.rippletest.net:51233',
    fallbacks: ['wss://testnet.xrpl-labs.com'],
    prefix: 'r',
    native: 'XRP',
    isXrpl: true,
    faucet: 'https://faucet.altnet.rippletest.net/accounts',
  },
];

// Site config: lets whoever hosts Starsky point it at their public LUMA nodes, so every visitor connects without setup.
//   window.STARSKY_CONFIG = { default: 'main', main: { url: 'wss://node.example.com', rpc: 'https://node.example.com/rpc', panel: 'https://panel.example.com' }, test: { ... } }
// Query strings work too:  ?luma=wss://...&panel=https://...&ltest=wss://...&ptest=https://...&net=xrpl-main
const SITE: any = (() => {
  const o: any = { ...((typeof window !== 'undefined' && (window as any).STARSKY_CONFIG) || {}) };
  try {
    const q = new URLSearchParams(location.search);
    const ent = (id: string, u: string | null, pn: string | null) => { if (u || pn) o[id] = { ...(o[id] || {}), ...(u ? { url: u } : {}), ...(pn ? { panel: pn } : {}) }; };
    ent('main', q.get('luma'), q.get('panel') !== '1' ? q.get('panel') : null); ent('test', q.get('ltest'), q.get('ptest'));
    if (q.get('net')) o.default = q.get('net');
  } catch {}
  return o;
})();
for (const n of NETS) {
  const c = SITE[n.id]; if (!c) continue;
  if (c.url) n.url = c.url;
  if (c.fallbacks) n.fallbacks = c.fallbacks;
  if (c.rpc) n.rpc = c.rpc;
  if (c.panel) { const b = String(c.panel).replace(/\/$/, ''); n.controlPanel = b; n.fund = b + '/api/fund-new'; if (n.faucet !== undefined || n.id === 'test') n.faucet = b + '/api/faucet'; }
}
const LOCAL_ONLY = (() => { try { return !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname) && location.protocol.startsWith('http'); } catch { return false; } })();

// Fallback storage
const mem: Record<string, string> = {};
export const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return mem[k] ?? null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      mem[k] = v;
    }
  },
  del(k: string) {
    try {
      localStorage.removeItem(k);
    } catch {
      delete mem[k];
    }
  },
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const ITER = 250000;
const VK = 'starsky.vault';
const CK = 'starsky.cfg';

export async function kdf(pw: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations: iter, hash: 'SHA-256' },
    k,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function seal(obj: unknown, key: CryptoKey, salt: Uint8Array, iter: number): Promise<StoredVault> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)))
  );
  return { v: 1, iter, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function openVault(v: StoredVault, pw: string): Promise<VaultState> {
  const salt = unb64(v.salt);
  const key = await kdf(pw, salt, v.iter);
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) }, key, unb64(v.ct));
  } catch {
    throw new Error('Wrong password');
  }
  return { data: JSON.parse(dec.decode(pt)), key, salt, iter: v.iter };
}

// Global state
export let VAULT: VaultState | null = null;
export let CFG: AppConfig = {
  net: 'main', // Default to Mainnet
  urls: {},
  usd: {},
  book: [],
  lockMin: 15,
  pairs: {},
  pair: {},
};

try {
  const raw = store.get(CK);
  if (raw) Object.assign(CFG, JSON.parse(raw));
  else {
    // First visit. If the site was not given public LUMA nodes, open on XRPL (public nodes) so the app is connected straight away.
    const given = SITE.default || (SITE.main && SITE.main.url ? 'main' : '');
    if (given) CFG.net = given; else if (LOCAL_ONLY) CFG.net = 'xrpl-main';
  }
  if (SITE.default && new URLSearchParams(location.search).get('net')) CFG.net = SITE.default;
  // The site's node address changed since this browser last saved one: drop the stale saved address so the new default wins.
  const C: any = CFG; C.siteUrls = C.siteUrls || {};
  let moved = false;
  for (const id of ['main', 'test']) {
    const u = SITE[id] && SITE[id].url;
    if (u && C.siteUrls[id] !== u) { delete C.urls[id]; C.siteUrls[id] = u; moved = true; }
  }
  if (moved) { if (SITE.default) CFG.net = SITE.default; store.set(CK, JSON.stringify(CFG)); }
} catch {}

export const saveCfg = () => store.set(CK, JSON.stringify(CFG));

export function getNet(): NetworkDef {
  const n = NETS.find(x => x.id === CFG.net) || NETS[0];
  if (!n.isXrpl) {
    LumaAddr.use(n.prefix);
  }
  let xm = false;
  try { xm = (st as any).walletMode === 'xrpl'; } catch {}   // XRPL wallet tab: the native coin is XRP and addresses are plain r… addresses
  return { ...n, url: CFG.urls[n.id] || n.url, ...(xm && !n.isXrpl ? { native: 'XRP' } : {}) };
}

const VK_RAW = 'starsky.wallet.vault.v2';
// Panel mode: Starsky runs inside the control panel (an iframe on the same origin). No password: the vault is sealed with a fixed
// key and filled with the panel's own wallets, which the parent page sends by postMessage.
export const PANEL = typeof location !== 'undefined' && new URLSearchParams(location.search).get('panel') === '1';
const PANEL_PW = 'luma-control-panel-embedded';

export const activeAccount = (): AccountData | undefined => {
  return VAULT?.data.accounts.find(a => a.id === VAULT?.data.active);
};

export const syncToPanel = () => {
  // inside the control panel every wallet made here (token issuers, holders, new accounts) is also added to the panel's Wallets page
  if (PANEL && typeof window !== 'undefined' && window.parent !== window) {
    try {
      const mine = VAULT!.data.accounts.filter(a => a.type !== 'xrpl' && !String(a.id).startsWith('panel_')).map(a => ({ label: a.label, address: a.address, seed: a.seed }));
      if (mine.length) window.parent.postMessage({ type: 'starsky-wallets', wallets: mine }, location.origin);
    } catch {}
  }
};

export const persistVault = async () => {
  if (!VAULT) return;
  store.set(VK, JSON.stringify(await seal(VAULT.data, VAULT.key, VAULT.salt, VAULT.iter)));
  syncToPanel();
};

export interface AppState {
  tab: 'home' | 'wallets' | 'dex' | 'pools' | 'markets' | 'bridge' | 'network' | 'bot' | 'margin' | 'supply' | 'burn' | 'nftmarket' | 'send' | 'receive' | 'nfts' | 'activity' | 'holders' | 'more';
  scanSubTab: 'pulse' | 'ledgers' | 'activity' | 'pools' | 'accounts' | 'health';
  walletMode: 'luma' | 'xrpl';
  client: xrpl.Client | null;
  xrplClient: xrpl.Client | null;
  lumaScanClient: xrpl.Client | null;
  status: 'offline' | 'connecting' | 'online';
  url: string;
  info: any;
  bal: { drops: bigint; owner: number; seq?: number; unfunded?: boolean } | null;
  xrplBal: { drops: bigint; owner: number; seq?: number; unfunded?: boolean } | null;
  lines: any[];
  hist: any[];
  mpts: any[];
  nfts: any[];
  px: Record<string, number | null>;
  pools: any[];
  ledger: number;
  err: string;
  tried: Array<{ url: string; err: string }>;
  swap: {
    from: string;
    to: string | null;
    amt: string;
    slip: number;
    q: any;
  };
  chart: Array<{ t: number | null; v: number }>;
  pendingTx?: any;

  // DEX state
  trade: {
    side: 'buy' | 'sell';
    type: 'limit' | 'market';
    tif: 'gtc' | 'post' | 'ioc' | 'fok';
    price: string;
    amt: string;
    total: string;
    slip: string;
  };
  orderBook: {
    asks: Array<{ price: number; size: number; mine?: boolean }>;
    bids: Array<{ price: number; size: number; mine?: boolean }>;
  } | null;
  openOrders: any[];
  tradesTape: Array<{ id: string; t: number; price: number; base: number; quote: number; side: 'buy' | 'sell' }>;

  // XLS-38 Multichain Bridge
  bridge: {
    direction: 'luma_to_xrpl' | 'xrpl_to_luma';
    amount: string;
    destination: string;
    claimId: string;
    lockingDoor: string;
    issuingDoor: string;
    status: string;
    txHash: string;
  };

  // Scan state (LUMA network explorer)
  scan: {
    ledgers: Array<{ seq: number; hash: string; txs: number; at: number }>;
    txs: Array<{ type: string; hash: string; from: string; to?: string; amt?: any; ok?: string; at: number; ledger?: number }>;
    types: Record<string, number>;
    closeTimes: number[];
    txPerLedger: number[];
    lastClose: number;
    totalCoins: number | null;
    feesBurned: number;
    seenCount: number;
    failCount: number;
    acctStats: Record<string, number>;
    largestPayments: Array<{ h: string; f: string; t: string; a: number }>;
    searchQuery: string;
    searchResult: any;
  };
}

export const st: AppState = {
  tab: 'home',
  scanSubTab: 'pulse',
  walletMode: 'luma',
  client: null,
  xrplClient: null,
  lumaScanClient: null,
  status: 'offline',
  url: '',
  info: null,
  bal: null,
  xrplBal: null,
  lines: [],
  hist: [],
  mpts: [],
  nfts: [],
  px: {},
  pools: [],
  ledger: 0,
  err: '',
  tried: [],
  swap: { from: 'native', to: null, amt: '', slip: 1, q: null },
  chart: [],

  trade: {
    side: 'buy',
    type: 'limit',
    tif: 'gtc',
    price: '',
    amt: '',
    total: '',
    slip: '1',
  },
  orderBook: null,
  openOrders: [],
  tradesTape: [],

  bridge: {
    direction: 'luma_to_xrpl',
    amount: '10',
    destination: '',
    claimId: '1',
    lockingDoor: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
    issuingDoor: 'rLumaBridgeDoor1111111111111111111',
    status: '',
    txHash: '',
  },

  scan: {
    ledgers: [],
    txs: [],
    types: {},
    closeTimes: [],
    txPerLedger: [],
    lastClose: 0,
    totalCoins: null,
    feesBurned: 0,
    seenCount: 0,
    failCount: 0,
    acctStats: {},
    largestPayments: [],
    searchQuery: '',
    searchResult: null,
  },
};

// Market Pair Helpers
export const NATIVE = { c: 'native', i: '' };
export const aKey = (a: { c: string; i?: string }) => (a.c === 'native' ? 'native' : `${a.c}|${a.i || ''}`);
export const keyAsset = (k: string) => (k === 'native' ? NATIVE : { c: k.split('|')[0], i: k.split('|')[1] || '' });
export const pKey = (p: TradingPair) => `${aKey(p.b)}/${aKey(p.q)}`;
export const pName = (p: TradingPair) => `${aName(p.b)}/${aName(p.q)}`;

export function currentPairs(): TradingPair[] {
  if (!CFG.pairs[CFG.net]) {
    CFG.pairs[CFG.net] = [];
  }
  return CFG.pairs[CFG.net];
}

export function currentPair(): TradingPair | null {
  const l = currentPairs();
  const k = CFG.pair[CFG.net];
  return l.find(p => pKey(p) === k) || l[0] || null;
}

export function addTradingPair(p: TradingPair, select = false) {
  if (aKey(p.b) === aKey(p.q)) throw new Error('Choose two different assets');
  const l = currentPairs();
  if (!l.some(x => pKey(x) === pKey(p))) l.push(p);
  if (select) CFG.pair[CFG.net] = pKey(p);
  saveCfg();
}

export function autoDetectPairs() {
  let changed = false;
  for (const l of st.lines) {
    const p: TradingPair = { b: { c: l.currency, i: l.account }, q: NATIVE };
    if (!currentPairs().some(x => pKey(x) === pKey(p))) {
      currentPairs().push(p);
      changed = true;
    }
  }
  if (changed) saveCfg();
}

// Utilities
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));

export const fq = (n: number | string | null | undefined, d?: number) => {
  const num = Number(n);
  if (!isFinite(num)) return '–';
  return num.toLocaleString(undefined, {
    maximumFractionDigits: d ?? (Math.abs(num) >= 1000 ? 2 : 6),
  });
};

export const pf = (s: unknown) => {
  const str = String(s ?? '').trim().replace(/,/g, '');
  return /^\d*\.?\d+$/.test(str) || /^\d+\.$/.test(str) ? parseFloat(str) : NaN;
};

export const decN = (n: number) => {
  let s = String(Number(Number(n).toPrecision(15)));
  if (/e/i.test(s)) s = Number(s).toFixed(18).replace(/0+$/, '').replace(/\.$/, '');
  return s;
};

export const showAddr = (r: string) => {
  try {
    return getNet().isXrpl || st.walletMode === 'xrpl' ? r : LumaAddr.toL(r);
  } catch {
    return r;
  }
};

export const toClassic = (a: string) => {
  a = String(a || '').trim();
  if (!a) throw new Error('Enter a destination address');
  if (getNet().isXrpl) {
    if (!xrpl.isValidAddress(a)) throw new Error('Not a valid XRPL address');
    return a;
  }
  if (LumaAddr.isL(a)) return LumaAddr.toR(a);
  const w = LumaAddr.wrongNet(a);
  if (w) throw new Error(w);
  if (!LumaAddr.isR(a)) throw new Error('Not a valid address (check for typos)');
  return a;
};

export const curName = (c: string) => {
  if (c === 'native') return getNet().native;
  if (!c || c.length !== 40) return c;
  const b = (c.match(/../g) || []).map(h => parseInt(h, 16));
  while (b.length && b[b.length - 1] === 0) b.pop();
  return b.length && b.every(x => x >= 32 && x < 127) ? String.fromCharCode(...b) : c.slice(0, 6) + '…';
};

export const aName = (a: { c: string; i?: string }) => (a.c === 'native' ? getNet().native : a.i && M.isOldUsd({ c: a.c, i: a.i }) ? 'USD (old)' : curName(a.c));

export const aRpc = (a: { c: string; i?: string }) =>
  a.c === 'native' ? { currency: getNet().isXrpl ? 'XRP' : 'LUMA' } : { currency: a.c, issuer: a.i };

export const aIssue = (a: { c: string; i?: string }) =>
  a.c === 'native' ? { currency: 'XRP' } : { currency: a.c, issuer: a.i };

export const amtTx = (a: { c: string; i?: string }, n: number) => {
  if (!(n > 0) || !isFinite(n)) throw new Error('Amount must be greater than zero');
  if (a.c === 'native') {
    const d = Math.round(n * 1e6);
    if (d < 1) throw new Error('Below the smallest unit (1 drop)');
    return String(d);
  }
  return { currency: a.c, issuer: a.i, value: decN(n) };
};

export const amtNum = (x: any) => (x == null ? 0 : typeof x === 'string' ? Number(x) / 1e6 : Number(x.value));
export const aOf = (x: any) => (typeof x === 'string' || x?.currency === 'XRP' || x?.currency === 'LUMA' ? NATIVE : { c: x.currency, i: x.issuer });

export const nativeBal = () => (st.bal ? Number(st.bal.drops) / 1e6 : 0);
export const reserveBase = () => {
  const v = st.info?.validated_ledger?.reserve_base_xrp;
  if (v != null) return Number(v);
  if (st.walletMode === 'xrpl') return (st as any).xres ? (st as any).xres.base : 1;
  return 0.1; // read from the node; this is only a fallback
};
export const reserveInc = () => {
  const v = st.info?.validated_ledger?.reserve_inc_xrp;
  if (v != null) return Number(v);
  if (st.walletMode === 'xrpl') return (st as any).xres ? (st as any).xres.inc : 0.2;
  return 0.02;
};
export const spendable = () => Math.max(0, nativeBal() - reserveBase() - reserveInc() * (st.bal?.owner || 0));

export const lineOf = (a: { c: string; i?: string }) =>
  st.lines.find(l => l.currency === a.c && l.account === a.i);
export const availOf = (a: { c: string; i?: string }) =>
  a.c === 'native' ? spendable() : Number(lineOf(a)?.balance || 0);

export function toast(m: string, bad = false) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = m;
  t.style.borderColor = bad ? 'var(--crit)' : 'var(--line)';
  t.style.display = 'block';
  (t as any)._h && clearTimeout((t as any)._h);
  (t as any)._h = setTimeout(() => (t.style.display = 'none'), bad ? 6000 : 3500);
}

export function copyText(t: string) {
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(
    () => toast('Copied to clipboard'),
    () => {
      const a = document.createElement('textarea');
      a.value = t;
      document.body.appendChild(a);
      a.select();
      try {
        document.execCommand('copy');
        toast('Copied to clipboard');
      } catch {}
      a.remove();
    }
  );
}

// Connection manager
let connectGen = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let refreshing = false;

export function getCandidates(): string[] {
  const n = getNet();
  const configured = CFG.urls[n.id] || n.url;
  const list = [configured, ...n.fallbacks];
  const isHttps = location.protocol === 'https:';
  const allowed = list.filter(u => {
    if (isHttps && /^ws:\/\/(?!127\.0\.0\.1|localhost)/.test(u)) return false;
    return true;
  });
  return [...new Set(allowed)];
}

async function tryNode(url: string, gen: number): Promise<{ client: xrpl.Client; info: any }> {
  const client = new xrpl.Client(url, { connectionTimeout: 7000 });
  client.on('disconnected', () => {
    if (connectGen !== gen || st.client !== client) return;
    st.status = 'offline';
    st.err = `Disconnected from ${url}`;
    if (!(st as any).offSince) (st as any).offSince = Date.now();
    renderTop();
    renderBanner();
    reconnectTimer = setTimeout(connectNodes, 400); // reconnect straight away; the banner only appears if it stays down
  });
  client.on('ledgerClosed', l => {
    if (connectGen !== gen) return;
    (st as any).lastLedgerAt = Date.now();
    handleLedgerClosed(l);
  });
  client.on('transaction', txEv => {
    if (connectGen !== gen) return;
    handleTransaction(txEv);
  });

  await client.connect();
  const r = await client.request({ command: 'server_info' });
  return { client, info: (r.result as any).info };
}

function handleLedgerClosed(l: any) {
  const now = Date.now();
  st.ledger = l.ledger_index;
  if (st.scan.lastClose) {
    st.scan.closeTimes.push((now - st.scan.lastClose) / 1000);
    st.scan.closeTimes = st.scan.closeTimes.slice(-40);
  }
  st.scan.lastClose = now;
  if (l.total_coins != null) {
    st.scan.totalCoins = Number(l.total_coins) / 1e6;
  }
  st.scan.ledgers.unshift({
    seq: l.ledger_index,
    hash: l.ledger_hash,
    txs: l.txn_count || 0,
    at: now,
  });
  st.scan.ledgers = st.scan.ledgers.slice(0, 50);
  st.scan.txPerLedger.push(l.txn_count || 0);
  st.scan.txPerLedger = st.scan.txPerLedger.slice(-40);

  renderTop();
  refreshAccount(true);
  if (st.tab === 'dex') Dex.tick();
}

function handleTransaction(ev: any) {
  const t = ev.transaction || ev.tx_json || {};
  const ty = t.TransactionType || 'Unknown';
  st.scan.types[ty] = (st.scan.types[ty] || 0) + 1;
  st.scan.seenCount++;
  st.scan.feesBurned += Number(t.Fee || 0);

  const metaRes = ev.meta?.TransactionResult || ev.engine_result || '';
  if (metaRes && metaRes !== 'tesSUCCESS') {
    st.scan.failCount++;
  }

  if (t.Account) {
    st.scan.acctStats[t.Account] = (st.scan.acctStats[t.Account] || 0) + 1;
  }

  if (typeof t.Amount === 'string' && t.TransactionType === 'Payment' && (!metaRes || metaRes === 'tesSUCCESS')) {
    st.scan.largestPayments.unshift({
      h: t.hash || ev.transaction?.hash || '',
      f: t.Account,
      t: t.Destination,
      a: Number(t.Amount) / 1e6,
    });
    st.scan.largestPayments.sort((x, y) => y.a - x.a);
    st.scan.largestPayments = st.scan.largestPayments.slice(0, 10);
  }

  st.scan.txs.unshift({
    type: ty,
    hash: t.hash || ev.transaction?.hash || '',
    from: t.Account,
    to: t.Destination,
    amt: t.Amount,
    ok: metaRes,
    at: Date.now(),
    ledger: ev.ledger_index,
  });
  st.scan.txs = st.scan.txs.slice(0, 80);


  refreshAccount(true);
}


export async function connectNodes() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const myGen = ++connectGen;

  if (st.client) {
    try {
      st.client.removeAllListeners();
      await st.client.disconnect();
    } catch {}
  }
  st.client = null;
  st.status = 'connecting';
  if (!(st as any).offSince) (st as any).offSince = Date.now();
  st.tried = [];
  renderTop();
  renderBanner();

  const cands = getCandidates();
  let won: { client: xrpl.Client; info: any; url: string } | null = null;

  for (const url of cands) {
    if (connectGen !== myGen) return;
    try {
      const res = await tryNode(url, myGen);
      won = { ...res, url };
      break;
    } catch (e: any) {
      st.tried.push({ url, err: String(e?.message || e) });
    }
  }

  if (connectGen !== myGen) return;

  if (won) {
    st.client = won.client;
    st.url = won.url;
    st.info = won.info;
    st.status = 'online';
    (st as any).offSince = 0;
    (st as any).lastLedgerAt = Date.now();
    st.err = '';
    st.ledger = won.info.validated_ledger?.seq || 0;

    try {
      await st.client.request({ command: 'subscribe', streams: ['ledger', 'transactions'] });
    } catch {}

    const a = activeAccount();
    if (a) {
      st.client.request({ command: 'subscribe', accounts: [a.address] }).catch(() => {});
    }

    renderTop();
    renderBanner();
    await refreshAccount();
    discoverPools();
    return;
  }

  st.status = 'offline';
  st.err = `Could not connect to any ${getNet().name} WSS nodes.`;
  renderTop();
  renderBanner();
  reconnectTimer = setTimeout(connectNodes, 5000);
}

let lastSig = '';
/** The node the active wallet lives on: the LUMA node in LUMA mode, the XRPL node in XRPL mode (tokens, NFTs, history and sending all follow it). */
export async function chainClient(): Promise<any> {
  if (st.walletMode === 'xrpl') return await xclient();
  return st.client;
}
export async function refreshAccount(quiet = false) {
  const a = activeAccount();
  if (!a || !st.client || st.status !== 'online') return;
  if (refreshing) return;
  refreshing = true;

  try {
    const cl: any = await chainClient();
    if (st.walletMode === 'xrpl') { try { const vl = ((await cl.request({ command: 'server_info' })).result.info.validated_ledger) || {}; (st as any).xres = { base: Number(vl.reserve_base_xrp ?? 1), inc: Number(vl.reserve_inc_xrp ?? 0.2) }; } catch {} }
    let bal: any = null;
    let lines: any[] = [];
    try {
      const r = await cl.request({
        command: 'account_info',
        account: a.address,
        ledger_index: 'validated',
      });
      bal = {
        drops: BigInt((r.result.account_data as any).Balance),
        owner: (r.result.account_data as any).OwnerCount || 0,
        seq: (r.result.account_data as any).Sequence,
      };
    } catch (e: any) {
      const msg = JSON.stringify(e?.data || e?.message || e);
      if (/actNotFound/.test(msg)) {
        bal = { drops: 0n, owner: 0, unfunded: true };
      } else {
        throw e;
      }
    }

    if (!bal.unfunded) {
      try {
        const rLines = await cl.request({
          command: 'account_lines',
          account: a.address,
          ledger_index: 'validated',
        });
        lines = (rLines.result as any).lines || [];
      } catch {}

      try {
        const rObj = await cl.request({
          command: 'account_objects',
          account: a.address,
          type: 'mptoken',
          ledger_index: 'validated',
        });
        st.mpts = ((rObj.result as any).account_objects || []).map((o: any) => ({
          id: o.MPTokenIssuanceID,
          amount: String(o.MPTAmount || '0'),
        }));
      } catch {
        st.mpts = [];
      }

      try {
        const rNfts = await cl.request({
          command: 'account_nfts',
          account: a.address,
          ledger_index: 'validated',
          limit: 100,
        });
        st.nfts = (rNfts.result as any).account_nfts || [];
      } catch {
        st.nfts = [];
      }

      try {
        const rTx = await cl.request({
          command: 'account_tx',
          account: a.address,
          limit: 60,
        });
        st.hist = (rTx.result as any).transactions || [];
      } catch {
        st.hist = [];
      }

      try {
        const rOffers = await cl.request({
          command: 'account_offers',
          account: a.address,
          limit: 100,
        });
        st.openOrders = (rOffers.result as any).offers || [];
      } catch {
        st.openOrders = [];
      }
    } else {
      st.lines = [];
      st.mpts = [];
      st.nfts = [];
      st.hist = [];
      st.openOrders = [];
    }

    st.bal = bal;
    st.lines = lines;
    autoDetectPairs();
    buildChart();
    await priceAll();
    const sig = JSON.stringify([String(bal.drops), bal.owner, lines, st.hist.length, (st.hist[0] as any)?.tx?.hash || (st.hist[0] as any)?.hash || '', st.px, st.nfts.length, st.mpts.length]);
    const changed = sig !== lastSig;
    lastSig = sig;
    if (['dex', 'markets', 'network', 'bridge', 'supply', 'burn', 'bot', 'margin', 'nfts', 'nftmarket'].includes(st.tab)) renderTop();
    else if (changed || !quiet) renderApp();
    else renderTop();
  } catch (e: any) {
    if (!quiet) st.err = String(e?.message || e);
  } finally {
    refreshing = false;
  }
}

// Order Book Fetcher

// Pricing
export async function priceOf(a: { c: string; i?: string }): Promise<number | null> {
  if (a.c === 'native' || !st.client) return 1;
  try {
    const r = await st.client.request({
      command: 'amm_info',
      asset: aRpc(NATIVE) as any,
      asset2: aRpc(a) as any,
    });
    const m = (r.result as any).amm;
    if (m) {
      const n = amtNum(m.amount);
      const t = amtNum(m.amount2);
      if (n > 0 && t > 0) return n / t;
    }
  } catch {}

  try {
    const [b, s] = await Promise.all([
      st.client.request({
        command: 'book_offers',
        taker_gets: aRpc(a) as any,
        taker_pays: aRpc(NATIVE) as any,
        limit: 1,
      }),
      st.client.request({
        command: 'book_offers',
        taker_gets: aRpc(NATIVE) as any,
        taker_pays: aRpc(a) as any,
        limit: 1,
      }),
    ]);
    const o1 = (b.result as any).offers?.[0];
    const o2 = (s.result as any).offers?.[0];
    const p: number[] = [];
    if (o1) p.push(amtNum(o1.TakerPays) / amtNum(o1.TakerGets));
    if (o2) p.push(amtNum(o2.TakerGets) / amtNum(o2.TakerPays));
    if (p.length) return p.reduce((x, y) => x + y) / p.length;
  } catch {}

  return null;
}

export async function priceAll() {
  const ks = st.lines.map(l => ({ c: l.currency, i: l.account }));
  await Promise.all(
    ks.map(async a => {
      st.px[aKey(a)] = await priceOf(a);
    })
  );
  st.px.native = 1;
}

export function holdings() {
  const h: Array<{ a: { c: string; i?: string }; name: string; bal: number; px: number | null }> = [
    { a: NATIVE, name: getNet().native, bal: nativeBal(), px: 1 },
  ];
  for (const l of st.lines) {
    const a = { c: l.currency, i: l.account };
    const p = st.px[aKey(a)] ?? null;
    h.push({ a, name: curName(l.currency), bal: Number(l.balance), px: p });
  }
  return h;
}

export function totalNative() {
  return holdings().reduce((s, h) => s + (h.px != null ? h.bal * h.px : 0), 0);
}

export function buildChart() {
  const a = activeAccount();
  if (!a) return;
  const pts: Array<{ t: number | null; v: number }> = [];
  for (const x of st.hist) {
    const m = x.meta || x.metaData;
    const t = x.tx_json || x.tx || {};
    if (!m) continue;
    for (const n of m.AffectedNodes || []) {
      const o = n.ModifiedNode || n.CreatedNode;
      if (o && o.LedgerEntryType === 'AccountRoot' && (o.FinalFields || o.NewFields)?.Account === a.address) {
        const f = o.FinalFields || o.NewFields;
        pts.push({
          t: t.date ? (t.date + 946684800) * 1000 : null,
          v: Number(f.Balance) / 1e6,
        });
      }
    }
  }
  pts.reverse();
  st.chart = pts;
}

// Transactions
export async function submitTx(tx: any, seed?: string) {
  const a = activeAccount();
  if (!st.client || (!a && !seed)) throw new Error('No active account or connection');

  const cl: any = await chainClient();
  const w = xrpl.Wallet.fromSeed(seed || a!.seed);
  const p = await cl.autofill(tx);
  if (p.NetworkID == null) {
    try {
      const nid = (await cl.request({ command: 'server_info' })).result.info.network_id;
      if (nid && nid > 1024) p.NetworkID = nid;
    } catch {}
  }
  const s = w.sign(p);
  const r = await cl.submitAndWait(s.tx_blob);
  const code = (r.result.meta as any)?.TransactionResult || (r.result as any).engine_result;
  if (code === 'tesSUCCESS') return { ok: true, hash: s.hash, meta: r.result.meta, ledger: (r.result as any).ledger_index };
  return { ok: false, msg: code };
}

export async function runTx(tx: any, okMsg: string, btn?: HTMLButtonElement | null) {
  if (st.status !== 'online') {
    toast('Not connected to the network yet', true);
    return { ok: false };
  }
  if (btn) {
    btn.disabled = true;
    btn.dataset.t = btn.textContent || '';
    btn.textContent = 'Submitting…';
  }
  try {
    const r = await submitTx(tx);
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.t || 'Submit';
    }
    if (r.ok) {
      toast('✓ ' + okMsg);
      refreshAccount(true);
    } else {
      toast('Transaction rejected: ' + r.msg, true);
    }
    return r;
  } catch (e: any) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.t || 'Submit';
    }
    toast('Error: ' + (e?.message || e), true);
    return { ok: false };
  }
}

// Discover pools
export async function discoverPools() {
  if (st.status !== 'online' || !st.client) return;
  try {
    const [refs, sn] = await Promise.all([M.poolRefs(), M.snapshot().catch(() => null)]);
    const states = await Promise.all(refs.map(r => M.poolState(r)));
    const out: any[] = [];
    refs.forEach((ref, i) => {
      const ps = states[i];
      const r1 = ps ? ps.ra : 0,
        r2 = ps ? ps.rb : 0;
      let tvl: number | null = null;
      if (sn) {
        const pa = sn.px.get(akey(ref.a)),
          pb = sn.px.get(akey(ref.b));
        const nat = pa != null ? r1 * pa * 2 : pb != null ? r2 * pb * 2 : null;
        tvl = nat == null ? null : sn.usdPerNative != null ? nat * sn.usdPerNative : nat;
      }
      out.push({
        m: { account: ref.account, lp_token: { currency: ref.lpCur, value: String(ps ? ps.lp : 0) } },
        a1: ref.a,
        a2: ref.b,
        r1,
        r2,
        fee: ps ? ps.fee : ref.fee,
        price: r1 > 0 ? r2 / r1 : 0,
        tvl,
        usdTvl: !!(sn && sn.usdPerNative != null),
      });
    });
    out.sort((x, y) => (y.tvl ?? 0) - (x.tvl ?? 0));
    st.pools = out;
    if (st.tab === 'pools') renderApp();
  } catch {}
}

// DOM Rendering
const ICON: Record<string, string> = {
  margin: '<path d="M4 18l5-6 4 3 7-9"/><path d="M15 6h5v5"/>',
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z"/>',
  wallets: '<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M16 12h.01M6 6V4a2 2 0 012-2h8a2 2 0 012 2v2"/>',
  charts: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4m4 4H7"/>',
  trade: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
  dex: '<path d="M3 17l5-6 4 3 6-8M3 21h18"/>',
  markets: '<path d="M4 20V9m5 11V4m5 16v-8m5 8V7"/>',
  network: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  pools: '<path d="M12 3s6.5 6.6 6.5 11.2a6.5 6.5 0 0 1-13 0C5.5 9.6 12 3 12 3z"/>',
  bridge: '<path d="M4 12h16M13 5l7 7-7 7"/>',
  scan: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><path d="M11 8v6M8 11h6"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
  receive: '<path d="M12 3v12m0 0l-5-5m5 5l5-5M4 21h16"/>',
  tokens: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.2 9.6c0-1 1-1.6 2.8-1.6s2.8.7 2.8 1.7-1 1.4-2.8 1.8-2.8.8-2.8 1.8 1 1.7 2.8 1.7 2.8-.6 2.8-1.6"/>',
  bot: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9 16.5h6"/>',
  supply: '<circle cx="12" cy="12" r="9"/><path d="M12 3v9l6 3"/>',
  nftmarket: '<path d="M3 9l2-5h14l2 5M3 9v11h18V9M3 9h18M9 14h6"/>',
  nfts: '<path d="M4 4h16v16H4zM4 15l4-4 4 4 5-5 3 3M14 8a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
};

export const ic = (k: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ICON[k] || ''}</svg>`;

export const TABS: Array<[AppState['tab'], string]> = [
  ['home', 'Portfolio'],
  ['wallets', 'Wallets'],
  ['send', 'Send'],
  ['receive', 'Receive'],
  ['markets', 'Markets & Tokens'],
  ['nftmarket', 'NFT Marketplace'],
  ['nfts', 'My NFTs'],
  ['activity', 'History'],
  ['holders', 'Token Holders'],
  ['dex', 'DEX'],
  ['pools', 'Liquidity Pools'],
  ['bridge', 'Bridge'],
  ['network', 'Network'],
  ['supply', 'LUMA Supply'],
  ['burn', 'Burns'],
  ['bot', 'Trading Bot'],
  ['margin', 'Leverage'],
  ['more', 'Settings'],
];

export function modal(h: string) {
  closeModal();
  const m = document.createElement('div');
  m.className = 'modal';
  m.id = 'modal';
  m.innerHTML = `<div class="card">${h}</div>`;
  document.body.appendChild(m);
}

export function closeModal() {
  const m = document.getElementById('modal');
  if (m) m.remove();
}

export function renderTop() {
  const c = document.getElementById('chip');
  if (!c) return;
  if (st.status === 'online') startTopStats();
  else refreshTopStats();
  const isOnline = st.status === 'online';
  c.className = `pill ${isOnline ? 'on' : ''}`;
  c.innerHTML = isOnline
    ? (st.walletMode === 'xrpl' ? `<i></i>XRP Ledger · ${(CFG.urls[CFG.net] || '').includes('altnet') || /test/.test(CFG.net) ? 'Testnet' : 'Mainnet'} (XRPL wallet)` : `<i></i>${esc(getNet().name)} · Ledger #${fq(st.ledger, 0)}`)
    : `<i></i>${st.status === 'connecting' ? 'Connecting to ' + esc(st.url || getNet().url) + '…' : 'Offline'}`;
}

export function renderBanner() {
  const e = document.getElementById('banner');
  if (!e) return;
  if (st.status === 'online' || !VAULT) {
    e.innerHTML = '';
    return;
  }
  // short drops (a node restart, an idle timeout) reconnect by themselves: only warn if it stays down for 12 seconds
  const since = (st as any).offSince || Date.now();
  if (Date.now() - since < 12000) {
    e.innerHTML = '';
    setTimeout(renderBanner, 12100 - (Date.now() - since));
    return;
  }
  const n = getNet();
  const t = st.tried || [];
  e.innerHTML = `
    <div class="card" style="border-color:rgba(255,107,139,.5);margin-bottom:1rem">
      <b class="${st.status === 'connecting' ? 'warn' : 'crit'}">
        ${st.status === 'connecting' ? 'Connecting to ' + esc(n.name) + '…' : 'Node Connection Offline'}
      </b>
      <p class="mut" style="margin:.4rem 0">
        Active Node Target: <span class="mono" style="color:var(--tx)">${esc(st.url || n.url)}</span>
      </p>
      ${
        st.status === 'connecting'
          ? ''
          : `
        <p class="mut" style="font-size:.85rem">Select a public WSS node preset below or enter a custom WebSocket address.</p>
        <div class="row" style="margin:.6rem 0">
          <select id="presetNode" class="grow" onchange="window.selectNodePreset(this.value)">
            ${(n.isXrpl
              ? [['wss://xrplcluster.com', 'XRPL Mainnet'], ['wss://s1.ripple.com', 'XRPL Mainnet (Ripple)'], ['wss://s.altnet.rippletest.net:51233', 'XRPL Testnet']]
              : [[n.url, 'Default ' + n.name + ' node']]
            ).map(([u, l]) => `<option value="${esc(u)}" ${u === (CFG.urls[n.id] || n.url) ? 'selected' : ''}>${esc(l)} (${esc(u)})</option>`).join('')}
          </select>
        </div>
        <div class="row">
          <input id="nodeurl" class="grow" placeholder="wss://..." value="${esc(CFG.urls[n.id] || n.url)}">
          <button class="pri" onclick="window.useNode()">Connect</button>
          <button onclick="window.connectNodes()">Retry</button>
        </div>
        ${
          t.length > 0
            ? `<details style="margin-top:.6rem"><summary class="mut" style="cursor:pointer;font-size:.8rem">Attempt details (${t.length})</summary><div class="mono" style="font-size:.72rem;margin:.5rem 0;max-height:6rem;overflow:auto">${t
                .map(x => `${esc(x.url)}: ${esc(x.err)}`)
                .join('<br>')}</div></details>`
            : ''
        }
      `
      }
    </div>
  `;
}

export function drawChart() {
  const el = document.getElementById('spark');
  if (!el || st.chart.length < 2) return;
  const d = st.chart.map(p => p.v);
  const mn = Math.min(...d);
  const mx = Math.max(...d);
  const rg = mx - mn || 1;
  const pts = d.map((v, i) => [(i / (d.length - 1)) * 400, 92 - ((v - mn) / rg) * 80]);
  const line = pts.map(p => p.join(',')).join(' ');
  el.innerHTML = `
    <defs>
      <linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#00ff8c" stop-opacity=".45"/>
        <stop offset="1" stop-color="#00ff8c" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="lg" x1="0" x2="1">
        <stop offset="0" stop-color="#9b5cff"/>
        <stop offset="1" stop-color="#00ff8c"/>
      </linearGradient>
    </defs>
    <polygon points="0,100 ${line} 400,100" fill="url(#ag)"/>
    <polyline points="${line}" fill="none" stroke="url(#lg)" stroke-width="2.2" vector-effect="non-scaling-stroke"/>
  `;
}

export function drawQR() {
  const el = document.getElementById('qr');
  const a = activeAccount();
  if (!el || !a) return;
  const addr = showAddr(a.address);
  QRCode.toDataURL(addr, { width: 220, margin: 1, color: { dark: '#000000', light: '#ffffff' } }, (err, url) => {
    if (!err && el) {
      el.innerHTML = `<img src="${url}" alt="QR Code" style="width:100%;height:auto;display:block;border-radius:.8rem" />`;
    }
  });
}


// Canvas Visualizers for Scan (LUMA network)
export function drawOrbit(cv: HTMLCanvasElement) {
  const c = cv.getContext('2d');
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = (cv.width = cv.clientWidth * dpr);
  const h = (cv.height = cv.clientHeight * dpr);
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.38;
  const t = performance.now() / 1000;

  c.clearRect(0, 0, w, h);
  const g = c.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.4);
  g.addColorStop(0, 'rgba(0,255,140,.22)');
  g.addColorStop(1, 'rgba(0,255,140,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);

  for (let k = 1; k <= 3; k++) {
    c.strokeStyle = `rgba(255,255,255,${0.06 + k * 0.02})`;
    c.lineWidth = dpr;
    c.beginPath();
    c.arc(cx, cy, (R * k) / 3 * 1.15, 0, Math.PI * 2);
    c.stroke();
  }

  const ledgers = st.scan.ledgers.slice(0, 24);
  ledgers.forEach((l, i) => {
    const a = -t * 0.25 + i * ((Math.PI * 2) / 24);
    const rr = R * (0.55 + Math.min(1, (l.txs || 0) / 20) * 0.6);
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    const age = (Date.now() - l.at) / 1000;
    const al = Math.max(0.25, 1 - age / 120);

    c.strokeStyle = `rgba(0,255,140,${al * 0.3})`;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(x, y);
    c.stroke();

    c.fillStyle = `rgba(0,255,140,${al})`;
    c.shadowColor = '#00ff8c';
    c.shadowBlur = 12 * dpr;
    c.beginPath();
    c.arc(x, y, (3 + Math.min(8, l.txs || 0)) * dpr, 0, Math.PI * 2);
    c.fill();
    c.shadowBlur = 0;
  });

  c.fillStyle = '#fff';
  c.font = `800 ${R * 0.32}px -apple-system, system-ui`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(st.ledger ? '#' + fq(st.ledger, 0) : '—', cx, cy - R * 0.05);

  c.fillStyle = '#9a92b8';
  c.font = `600 ${R * 0.09}px -apple-system, system-ui`;
  c.fillText('LUMA LEDGER TIP', cx, cy + R * 0.28);
}

export function drawDonut(cv: HTMLCanvasElement) {
  const c = cv.getContext('2d');
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = (cv.width = cv.clientWidth * dpr);
  const h = (cv.height = cv.clientHeight * dpr);
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.38;

  const ent = Object.entries(st.scan.types).sort((a, b) => b[1] - a[1]);
  const tot = ent.reduce((a, b) => a + b[1], 0);

  c.clearRect(0, 0, w, h);
  if (!tot) {
    c.fillStyle = '#8e8e93';
    c.font = `${13 * dpr}px system-ui`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('Listening for LUMA activity…', cx, cy);
    return;
  }

  const colors: Record<string, string> = {
    Payment: '#00ff8c',
    OfferCreate: '#00d9a0',
    OfferCancel: '#7dffc4',
    TrustSet: '#9b5cff',
    AMMDeposit: '#a6ff00',
    AMMCreate: '#5cffd6',
    AMMWithdraw: '#ffd60a',
    NFTokenMint: '#ff7ae0',
    AccountSet: '#8e8e93',
  };

  let a0 = -Math.PI / 2;
  ent.forEach(([t, n]) => {
    const a = (n / tot) * Math.PI * 2;
    const col = colors[t] || '#6a3df0';
    c.strokeStyle = col;
    c.lineWidth = R * 0.28;
    c.beginPath();
    c.arc(cx, cy, R, a0, a0 + a - 0.03);
    c.stroke();
    a0 += a;
  });

  c.fillStyle = '#fff';
  c.font = `800 ${R * 0.36}px system-ui`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(fq(tot, 0), cx, cy);

  c.fillStyle = '#8e8e93';
  c.font = `600 ${R * 0.11}px system-ui`;
  c.fillText('LUMA TX SEEN', cx, cy + R * 0.34);
}

// UI Views
export function renderApp() {
  const root = document.getElementById('app');
  if (!root) return;

  if (!VAULT) {
    renderLockScreen(root);
    return;
  }

  const a = activeAccount();
  const n = getNet();
  const h = holdings();
  const tn = totalNative();
  const usd = CFG.usd[CFG.net] || 0;
  const b = st.bal;

  let body = '';
  const LUMA_ONLY = ['dex', 'pools', 'network', 'supply', 'burn', 'bot', 'margin', 'holders'];
  const blocked = st.walletMode === 'xrpl' && LUMA_ONLY.includes(st.tab);   // those pages read the LUMA network: never show them under an XRPL wallet
  switch (blocked ? '__luma_only' : st.tab) {
    case '__luma_only':
      body = `<div class="card"><div class="k">LUMA network only</div><div style="margin:.5rem 0">This page works on the LUMA network. You are in an <b>XRPL wallet</b>, which uses the XRP Ledger.</div><button class="pri acc" onclick="window.setWalletMode('luma')">Switch to LUMA wallet</button> <button onclick="window.goTab('home')">Back to my XRPL wallet</button></div>`;
      break;
    case 'home':
      body = `
        <div class="grid">
          <div class="card hero c12">
            <div class="k" style="color:#d9ccff">Total Balance (${st.walletMode === 'luma' ? 'LUMA Network' : 'XRPL Network'})</div>
            <div class="big"><span>${fq(nativeBal())}</span><small>${esc(n.native)}</small></div>
            <div class="mut" style="color:#d9ccff;margin-top:.3rem">
              ${h.length > 1 ? `Portfolio worth ${fq(tn)} ${esc(n.native)}${usd ? ` · $${fq(tn * usd, 2)}` : ''}` : usd ? `$${fq(nativeBal() * usd, 2)}` : '&nbsp;'}
            </div>
            ${Pages.heroShell()}
            ${b && b.unfunded ? `<div class="warn" style="margin-top:.7rem;position:relative;z-index:1">${n.faucet ? `This account is not activated yet. Click 'Get Test ${esc(n.native)}' below to fund it from the faucet.` : `This account is not activated yet. Send it at least ${fq(reserveBase())} ${esc(n.native)} (the network reserve) from any funded wallet. You can do that from your other wallet on the <a href="#" onclick="window.goTab('wallets');return false" style="color:inherit;text-decoration:underline">Wallets page</a>.`}</div>` : ''}
            <div class="actions">
              <button class="pri" onclick="window.goTab('send')">Send</button>
              <button onclick="window.goTab('receive')">Receive</button>
              <button class="pri acc" onclick="window.goTab('dex')">DEX</button>
              <button onclick="window.goTab('bridge')">Bridge</button>
              ${n.faucet ? `<button onclick="window.requestFaucet(this)">Get Test ${esc(n.native)}</button>` : ''}
            </div>
          </div>
          <div class="card c8">
            <div class="k">Balance History</div>
            ${st.chart.length > 1 ? '<svg class="spark" id="spark" viewBox="0 0 400 100" preserveAspectRatio="none"></svg>' : '<div class="mut" style="padding:1.6rem 0">Transactions will build your live balance chart automatically.</div>'}
          </div>
          <div class="card c4">
            <div class="k">Wallet Mode & Account</div>
            <div class="row" style="margin-bottom:.8rem">
              <button class="sm ${st.walletMode === 'luma' ? 'pri acc' : ''}" onclick="window.setWalletMode('luma')">LUMA Wallet</button>
              <button class="sm ${st.walletMode === 'xrpl' ? 'pri acc' : ''}" onclick="window.setWalletMode('xrpl')">XRPL Wallet</button>
            </div>
            <table>
              <tr><td class="mut">Spendable</td><td class="r">${fq(spendable())}</td></tr>
              <tr><td class="mut">Reserve</td><td class="r">${fq(Math.max(0, nativeBal() - spendable()))}</td></tr>
              <tr><td class="mut">Token Lines</td><td class="r">${st.lines.length}</td></tr>
              <tr><td class="mut">Open Offers</td><td class="r">${st.openOrders.length}</td></tr>
            </table>
          </div>
          ${Pages.assetsShell()}
          <div class="c12">${Mg.portfolioShell()}</div>
        </div>
      `;
      break;

    case 'wallets':
      body = renderWalletsView(a, n);
      break;

    case 'nfts':
      body = Nft.myShell();
      break;

    case 'nftmarket':
      body = Nft.marketShell();
      break;

    case 'dex':
      body = Dex.shell();
      break;

    case 'pools': {
      const lpOf = (m: any) => {
        const l = st.lines.find((x: any) => x.currency === m.lp_token?.currency && x.account === m.account);
        const mine = l ? Number(l.balance) : 0;
        const tot = Number(m.lp_token?.value || 0);
        return tot > 0 ? (mine / tot) * 100 : 0;
      };
      body = `
        <div class="grid pools-page">
          <div class="tile c12">
            <div class="row" style="margin:0;align-items:center">
              <div>
                <div class="k">Automated market maker pools on ${esc(n.name)}</div>
                <h2 style="margin:0">Liquidity Pools <small class="mut" style="font-size:.8rem">${st.pools.length} pools</small></h2>
              </div>
              <span class="grow"></span>
              <div class="row" style="gap:.5rem">
                <button class="pri acc" onclick="window.openCreatePoolModal()">+ Create Liquidity Pool</button>
                <button onclick="window.discoverPools()">Refresh</button>
                <button onclick="window.goTab('markets')">Prices and changes</button>
              </div>
            </div>
          </div>
          <div class="c12">${PL.shell()}</div>
        </div>
      `;
      break;
    }

    case 'bridge':
      body = Pages.bridgeShell();
      break;

    case 'network':
      body = Pages.networkShell();
      break;

    case 'supply':
      body = Supply.supplyShell();
      break;

    case 'burn':
      body = Bn.pageShell();
      break;

    case 'bot':
      body = Bot.botShell();
      break;

    case 'margin':
      body = Mg.pageShell();
      break;

    case 'send':
      body = `
        <div class="grid">
          <div class="card c7">
            <div class="k">Send Payment (${st.walletMode.toUpperCase()})</div>
            <div class="row">
              <select id="s_asset" class="grow">
                ${h.map(x => `<option value="${esc(aKey(x.a))}">${esc(x.name)} — Available: ${fq(availOf(x.a))}</option>`).join('')}
              </select>
            </div>
            <div class="row">
              <input id="s_dest" class="grow" list="abook" placeholder="Recipient address (${n.prefix}… or r…)" autocomplete="off" spellcheck="false">
              <datalist id="abook">
                ${CFG.book.map(b => `<option value="${esc(b.addr)}">${esc(b.name)}</option>`).join('')}
              </datalist>
            </div>
            <div class="row">
              <input id="s_amt" class="grow" placeholder="Amount" inputmode="decimal">
              <button class="sm" onclick="window.sendMax()">Max</button>
              <input id="s_tag" placeholder="Tag (optional)" inputmode="numeric" style="width:8.5rem">
            </div>
            <div class="row">
              <input id="s_memo" class="grow" placeholder="Memo / Note (optional, public on ledger)">
            </div>
            <div class="row" style="margin-top:1rem">
              <button class="pri grow" onclick="window.reviewSend()">Review & Send</button>
            </div>
          </div>
          <div class="card c5">
            <div class="k">Address Book</div>
            ${
              CFG.book.map((b, i) => `
              <div class="row">
                <div class="grow">
                  <b>${esc(b.name)}</b>
                  <div class="mono mut" style="font-size:.72rem;overflow:hidden;text-overflow:ellipsis">${esc(b.addr)}</div>
                </div>
                <button class="sm" onclick="window.useBook('${esc(b.addr)}')">Select</button>
                <button class="sm ghost" onclick="window.delBook(${i})">✕</button>
              </div>
            `).join('') || '<div class="mut" style="padding:.5rem 0">No saved addresses yet.</div>'
            }
            <div class="row" style="margin-top:.8rem">
              <input id="ab_n" placeholder="Name" style="width:7rem">
              <input id="ab_a" class="grow" placeholder="Address">
              <button class="sm" onclick="window.addBook()">Save</button>
            </div>
          </div>
        </div>
      `;
      break;

    case 'receive':
      body = `
        <div class="grid">
          <div class="card c6" style="text-align:center">
            <div class="k">Your ${esc(n.name)} Address</div>
            <div class="qr" id="qr" style="margin:1rem auto"></div>
            <div class="mono" style="word-break:break-all;margin:.6rem 0;font-size:.95rem;font-weight:700">
              ${esc(showAddr(a?.address || ''))}
            </div>
            <div class="row" style="justify-content:center;gap:.6rem;margin-top:.6rem">
              <button class="pri" onclick="window.copyText('${esc(showAddr(a?.address || ''))}')">Copy Address</button>
              <button onclick="window.copyText('${esc(a?.address || '')}')">Copy Classic (r…)</button>
            </div>
          </div>
          <div class="card c6">
            <div class="k">Address Details</div>
            <table>
              <tr><td class="mut">Formatted Address</td><td class="r mono" style="font-size:.8rem">${esc(showAddr(a?.address || ''))}</td></tr>
              <tr><td class="mut">Classic Address</td><td class="r mono" style="font-size:.8rem">${esc(a?.address || '')}</td></tr>
              <tr><td class="mut">Network Mode</td><td class="r">${esc(n.name)} (${esc(n.prefix)}…)</td></tr>
              <tr><td class="mut">Connected Node</td><td class="r mono" style="font-size:.75rem">${esc(st.url || n.url)}</td></tr>
            </table>
            <p class="mut" style="margin-top:1rem;font-size:.85rem">
              This address supports native currency (${esc(n.native)}) and any issued tokens/MPTs.
            </p>
          </div>
        </div>
      `;
      break;

    case 'markets':
      body = Pages.marketsShell();
      break;

    case 'activity':
      body = Hist.shell();
      break;

    case 'holders':
      body = Hold.shell();
      break;

    case 'more':
      body = `
        <div class="grid">
          <div class="card c6">
            <div class="k">Accounts (${st.walletMode.toUpperCase()})</div>
            ${(VAULT?.data.accounts || [])
              .filter(x => (st.walletMode === 'luma' ? x.type !== 'xrpl' : x.type === 'xrpl'))
              .map(
                x => `
              <div class="row">
                <div class="grow">
                  <b>${esc(x.label)}</b>
                  ${a && x.id === a.id ? ' <span class="ok" style="font-size:.75rem">● Active</span>' : ''}
                  <div class="mono mut" style="font-size:.72rem;word-break:break-all">${esc(showAddr(x.address))}</div>
                  ${x.xrplLinkedAddress ? `<div class="mut" style="font-size:.7rem">Linked XRPL: ${esc(x.xrplLinkedAddress)}</div>` : ''}
                </div>
                <button class="sm" onclick="window.switchAcct('${x.id}')">Use</button>
                <button class="sm ghost" onclick="window.revealSeed('${x.id}')">Seed</button>
                <button class="sm ghost" onclick="window.removeAcct('${x.id}')">✕</button>
              </div>
            `
              )
              .join('')}
            <div class="k" style="margin-top:1.2rem">Add New Account (${st.walletMode.toUpperCase()})</div>
            <div class="row">
              <input id="n_l" placeholder="Account Name" style="width:8rem" value="Account ${(VAULT?.data.accounts.length || 0) + 1}">
              <button class="pri" onclick="window.createAcct()">Generate Wallet</button>
            </div>
            <div class="k" style="margin-top:1.2rem">Import From Seed</div>
            <div class="row">
              <input id="i_s" class="grow" type="password" placeholder="s..." autocomplete="off">
              <button onclick="window.importAcct()">Import</button>
            </div>
          </div>
          <div class="card c6">
            <div class="k">WSS Node Settings</div>
            <p class="mut" style="font-size:.85rem;margin-bottom:.5rem">
              Starsky communicates over secure WebSockets with LUMA and XRPL rippled nodes.
            </p>
            <div class="row">
              <b style="width:6rem">Mainnet:</b>
              <input class="grow" id="cfg_url_main" value="${esc(CFG.urls.main || NETS[0].url)}" onchange="window.setUrl('main', this.value)">
            </div>
            <div class="row">
              <b style="width:6rem">Testnet:</b>
              <input class="grow" id="cfg_url_test" value="${esc(CFG.urls.test || NETS[1].url)}" onchange="window.setUrl('test', this.value)">
            </div>
            <div class="row">
              <b style="width:6rem">XRPL Main:</b>
              <input class="grow" id="cfg_url_xrpl" value="${esc(CFG.urls['xrpl-main'] || NETS[2].url)}" onchange="window.setUrl('xrpl-main', this.value)">
            </div>
            <div class="row" style="margin-top:.8rem">
              <button class="sm" onclick="window.resetNets()">Reset to Defaults</button>
            </div>

            <div class="k" style="margin-top:1.4rem">Backup & Security</div>
            <div class="row">
              <button onclick="window.exportVault()">Export Encrypted Backup</button>
              <button onclick="document.getElementById('iv').click()">Import Backup</button>
              <input id="iv" type="file" hidden onchange="window.importVaultFile(this.files[0])">
              <button class="ghost" onclick="window.lockNow()">Lock Wallet</button>
            </div>
          </div>
        </div>
      `;
      break;
  }

  root.innerHTML = `
    <div class="shell">
      <aside>
        <div class="logo">
          <svg viewBox="0 0 32 32" style="width:2rem;height:2rem;filter:drop-shadow(0 0 10px rgba(0, 255, 140, 0.6))">
            <defs>
              <linearGradient id="sg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#00ff8c"/>
                <stop offset="1" stop-color="#4f7cff"/>
              </linearGradient>
            </defs>
            <path d="M16 2l3.6 9.4L29 14.5l-7.6 5.7L24 30l-8-5.4L8 30l2.6-9.8L3 14.5l9.4-3.1z" fill="url(#sg)"/>
          </svg>
          <div>
            <span>STARSKY</span>
            <small style="display:block;color:var(--mut);font-size:.65rem;letter-spacing:.08em;font-weight:700">${st.walletMode === 'xrpl' ? 'XRP LEDGER WALLET' : 'LUMA NETWORK WALLET'}</small>
          </div>
        </div>

        <div class="row" style="margin:.2rem .4rem .6rem;gap:.3rem">
          <button class="sm grow ${st.walletMode === 'luma' ? 'pri acc' : ''}" onclick="window.setWalletMode('luma')">LUMA</button>
          <button class="sm grow ${st.walletMode === 'xrpl' ? 'pri acc' : ''}" onclick="window.setWalletMode('xrpl')">XRPL</button>
        </div>

        <div class="nav-section">Wallet</div>
        ${renderNavItem('home', 'Portfolio')}
        ${renderNavItem('wallets', 'Wallets')}
        ${renderNavItem('send', 'Send')}
        ${renderNavItem('receive', 'Receive')}
        ${renderNavItem('markets', 'Markets & Tokens')}
        ${renderNavItem('nfts', 'My NFTs')}
        ${renderNavItem('activity', 'History')}
        ${renderNavItem('holders', 'Token Holders')}

        <div class="nav-section">DEX & AMM</div>
        ${renderNavItem('nftmarket', 'NFT Marketplace')}
        ${renderNavItem('dex', 'DEX')}
        ${renderNavItem('pools', 'Liquidity Pools')}
        ${renderNavItem('bridge', 'Bridge')}

        <div class="nav-section">Explorer</div>
        ${renderNavItem('network', 'Network')}
        ${renderNavItem('supply', 'LUMA Supply')}
        ${renderNavItem('burn', 'Burns')}

        <div class="nav-section">Automation</div>
        ${renderNavItem('bot', 'Trading Bot')}
        ${renderNavItem('margin', 'Leverage Trading')}

        <div style="flex:1"></div>
        ${renderNavItem('more', 'Settings')}
      </aside>

      <main>
        <div class="top">
          <h1>${esc(TABS.find(t => t[0] === st.tab)?.[1] || '')}</h1>
          <div class="topc"><div class="sw">
            ${NETS.filter(x => !x.isXrpl).map(
              x => `
              <button class="${CFG.net === x.id ? 'on' : ''}" onclick="window.switchNet('${x.id}')">
                ${esc(x.name.replace('LUMA ', ''))}
              </button>
            `
            ).join('')}
          </div>
          <span class="tstat" id="tstat"></span></div>
          <span class="pill ${st.status === 'online' ? 'on' : ''}" id="chip"></span>
        </div>

        ${
          a
            ? `
          <div class="row" style="margin-top:-.6rem;margin-bottom:1rem">
            <select id="acs" onchange="window.switchAcct(this.value)" style="width:auto;max-width:100%">
              ${(VAULT?.data.accounts || [])
                .filter(x => (st.walletMode === 'luma' ? x.type !== 'xrpl' : x.type === 'xrpl'))
                .map(
                  x => `
                <option value="${x.id}" ${x.id === a.id ? 'selected' : ''}>
                  ${esc(x.label)} · ${esc(showAddr(x.address).slice(0, 8))}…${esc(showAddr(x.address).slice(-5))}
                </option>
              `
                )
                .join('')}
            </select>
            <button class="sm ghost" onclick="window.copyText('${esc(showAddr(a.address))}')">Copy Address</button>
            <button class="sm ghost" onclick="window.copyText('${esc(a.address)}')">Copy Classic (r…)</button>
          </div>
        `
            : ''
        }

        <div id="banner"></div>
        <div id="view">${body}</div>
      </main>
    </div>

    <div class="tabs">
      ${TABS.filter(t => ['home', 'send', 'markets', 'dex', 'nftmarket', 'pools', 'bridge', 'network', 'supply', 'burn', 'bot', 'margin'].includes(t[0]))
        .map(
          ([k, l]) => `
        <button class="nav ${st.tab === k ? 'on' : ''}" onclick="window.goTab('${k}')">
          ${ic(k)}
          ${l.replace('Markets & Tokens', 'Markets').replace('Liquidity Pools', 'Pools')}
        </button>
      `
        )
        .join('')}
    </div>
  `;

  renderTop();
  renderBanner();
  if (st.tab === 'home') drawChart();
  if (st.tab === 'receive') drawQR();
  if (st.tab === 'dex') Dex.mount();
  else Dex.unmount();
  if (st.tab === 'network') Pages.networkMount();
  else Pages.networkUnmount();
  if (st.tab === 'nfts' || st.tab === 'nftmarket') Nft.marketMount();
  else Nft.nftUnmount();
  if (st.tab === 'wallets') loadWB();
  if (st.tab === 'pools')
    PL.mount(st.pools, (p: any) => {
      const l = st.lines.find((x: any) => x.currency === p.m.lp_token?.currency && x.account === p.m.account);
      const bal = l ? Number(l.balance) : 0, tot = Number(p.m.lp_token?.value || 0);
      return { bal, share: tot > 0 ? Math.min(1, bal / tot) : 0 };
    });
  if (st.tab === 'activity') Hist.mount();
  if (st.tab === 'holders') Hold.mount();
  if (st.tab === 'burn') Bn.pageMount();
  if (st.tab === 'supply') Supply.supplyMount();
  else Supply.supplyUnmount();
  if (st.tab === 'bot') Bot.botMount();
  Mg.monitor();
  if (st.tab === 'margin') Mg.pageMount();
  if (st.tab === 'home') {
    Mg.paintNow();
    Bn.load();
  }
  if (st.tab === 'markets') Pages.marketsMount();
  else Pages.marketsUnmount();
  if (st.tab === 'bridge') Pages.bridgeMount();
  if (st.tab === 'home') Pages.assetsMount();
}

function renderNavItem(key: AppState['tab'], label: string) {
  return `
    <button class="nav ${st.tab === key ? 'on' : ''}" onclick="window.goTab('${key}')">
      ${ic(key)}
      ${label}
    </button>
  `;
}

// Wallets Management View

const WB: Record<string, { bal: number | null; owner: number }> = {};
let WBsig = '';
function walletBalLine(x: AccountData) {
  const w = WB[x.address];
  if (!w) return '<div class="mut" style="font-size:.78rem;margin-top:.3rem">Reading balance…</div>';
  if (w.bal == null) return `<div class="row" style="margin-top:.4rem;gap:.5rem"><span class="chip warn">Not activated</span><span class="mut" style="font-size:.78rem">needs at least ${fq(reserveBase())} ${esc(getNet().native)}</span></div>`;
  const lock = reserveBase() + reserveInc() * w.owner;
  return `<div class="row" style="margin-top:.4rem;gap:.5rem;flex-wrap:wrap"><span class="chip ok">Balance ${fq(w.bal)} ${esc(getNet().native)}</span><span class="chip">Reserve ${fq(Math.min(lock, w.bal))}</span><span class="chip b">Spendable ${fq(Math.max(0, w.bal - lock))}</span></div>`;
}
function walletFundForm(list: AccountData[], active: AccountData | undefined) {
  const funded = list.filter(x => (WB[x.address]?.bal ?? 0) > reserveBase());
  if (!active) return '<div class="mut">Create a wallet first.</div>';
  const others = funded.filter(x => x.id !== active.id);
  if (!others.length) return `<div class="mut" style="font-size:.84rem">No other funded wallet in this vault. Send ${fq(reserveBase())}+ ${esc(getNet().native)} to <span class="mono">${esc(showAddr(active.address))}</span> from anywhere to activate the selected wallet.</div>`;
  return `<div class="row"><select id="fund_src" class="grow">${others.map(x => `<option value="${x.id}">${esc(x.label)} · ${fq(WB[x.address]?.bal ?? 0)}</option>`).join('')}</select></div>
    <div class="row" style="margin-top:.5rem"><input id="fund_amt" class="grow" value="${reserveBase()}" inputmode="decimal" title="Amount to send to the selected wallet"><button class="pri acc" onclick="window.fundActiveLumaWallet()">Send to ${esc(active.label)}</button></div>`;
}
async function loadWB() {
  if (!st.client || st.status !== 'online' || !VAULT) return;
  const list = VAULT.data.accounts.filter(x => (st.walletMode === 'luma' ? x.type !== 'xrpl' : x.type === 'xrpl'));
  await Promise.all(
    list.map(async x => {
      try {
        const r: any = await st.client!.request({ command: 'account_info', account: x.address, ledger_index: 'validated' });
        WB[x.address] = { bal: Number(r.result.account_data.Balance) / 1e6, owner: Number(r.result.account_data.OwnerCount || 0) };
      } catch {
        WB[x.address] = { bal: null, owner: 0 };
      }
    })
  );
  const sig = JSON.stringify(list.map(x => WB[x.address]));
  if (sig !== WBsig) {
    WBsig = sig;
    if (st.tab === 'wallets' && !document.querySelector('#modal') && !(document.activeElement && (document.activeElement as HTMLElement).tagName === 'INPUT')) renderApp();
  }
}
function renderWalletsView(a: AccountData | undefined, n: NetworkDef) {
  const isLuma = st.walletMode === 'luma';
  const accounts = VAULT?.data.accounts || [];
  const currentModeAccounts = accounts.filter(x => (isLuma ? x.type !== 'xrpl' : x.type === 'xrpl'));

  // Check for unactivated XRPL wallet linked to LUMA e-wallet
  let unactivatedCard = '';
  if (!isLuma) {
    const lumaAccounts = accounts.filter(x => x.type !== 'xrpl');
    for (const lumaAcc of lumaAccounts) {
      let classic = lumaAcc.address;
      try {
        if (LumaAddr.isL(lumaAcc.address)) {
          classic = LumaAddr.toR(lumaAcc.address);
        }
      } catch {}

      unactivatedCard += `
        <div class="tile c12" style="border:1px solid rgba(255,176,32,0.45);background:rgba(255,176,32,0.07);margin-bottom:1.2rem;box-shadow:0 8px 32px rgba(255,176,32,0.1)">
          <div class="row">
            <span class="chip" style="background:var(--warn);color:#05020c;font-weight:700">UNACTIVATED LINKED XRPL WALLET</span>
            <span class="mut" style="font-size:.82rem">Paired with LUMA Account: <b style="color:var(--tx)">${esc(lumaAcc.label)}</b></span>
          </div>
          <div style="margin:.8rem 0">
            <div class="k">Classic XRPL Address:</div>
            <div class="mono font-bold" style="font-size:1.15rem;color:#ffe39f;word-break:break-all">${esc(classic)}</div>
            <p class="mut" style="font-size:.86rem;margin-top:.4rem;line-height:1.5">
              This XRPL classic address corresponds to your active LUMA e-wallet (<b>${esc(showAddr(lumaAcc.address))}</b>) using the identical private key. On the XRP Ledger, new accounts require a <b>10 XRP base reserve</b> to activate before they can submit transactions.
            </p>
            <div class="row" style="margin-top:.8rem;gap:.6rem;flex-wrap:wrap">
              <span class="chip">Base Reserve: <b>10 XRP</b></span>
              <span class="chip warn">Status: <b>Unactivated (0 XRP on XRPL)</b></span>
              <span class="chip ok">Connected to LUMA Network: <b>✓ Active</b></span>
            </div>
          </div>
          <div class="row" style="margin-top:1rem;gap:.6rem;flex-wrap:wrap">
            <button class="pri acc" onclick="window.bridgeToActivate('${classic}')">Bridge LUMA to Activate XRPL</button>
            <button onclick="window.copyText('${classic}')">Copy Classic Address</button>
            ${n.faucet ? `<button class="pri" onclick="window.fundLinkedXrpl('${classic}')">Fund via XRPL Testnet Faucet</button>` : ''}
            <button class="ghost" onclick="window.importLinkedXrplAccount('${lumaAcc.id}')">Add as XRPL Account</button>
          </div>
        </div>
      `;
    }
  }

  return `
    <div class="grid">
      ${unactivatedCard}

      <div class="tile c12">
        <div class="row" style="margin:0;align-items:center">
          <div>
            <div class="k">${isLuma ? 'LUMA Network Accounts' : 'XRPL Network Accounts'}</div>
            <h2 style="margin:0">${isLuma ? 'LUMA Wallets (L… / T…)' : 'XRPL Wallets (Classic r…)'}</h2>
          </div>
          <span class="grow"></span>
          <div class="row" style="gap:.4rem">
            <button class="sm ${isLuma ? 'pri acc' : ''}" onclick="window.setWalletMode('luma')">LUMA Wallets</button>
            <button class="sm ${!isLuma ? 'pri acc' : ''}" onclick="window.setWalletMode('xrpl')">XRPL Wallets</button>
          </div>
        </div>
      </div>

      <!-- Wallet List -->
      <div class="tile c7">
        <div class="k">Stored ${isLuma ? 'LUMA' : 'XRPL'} Wallets in Vault</div>
        <div class="list" style="margin-top:.6rem">
          ${
            currentModeAccounts.map(x => {
              const isActive = a && x.id === a.id;
              const displayAddr = isLuma ? showAddr(x.address) : x.address;
              return `
                <div style="padding:.9rem;border-radius:.9rem;border:1px solid ${isActive ? 'var(--ok)' : 'var(--line)'};background:${isActive ? 'rgba(0,255,140,0.05)' : 'rgba(255,255,255,0.02)'};margin-bottom:.6rem">
                  <div class="row">
                    <b style="font-size:1.05rem">${esc(x.label)}</b>
                    ${isActive ? '<span class="chip ok">Active</span>' : ''}
                    <span class="grow"></span>
                    <button class="sm ${isActive ? 'ghost' : 'pri'}" onclick="window.switchAcct('${x.id}')">${isActive ? 'Selected' : 'Use Wallet'}</button>
                  </div>
                  <div class="mono" style="margin:.4rem 0;font-size:.88rem;word-break:break-all">${esc(displayAddr)}</div>
                  ${isLuma ? `<div class="mono mut" style="font-size:.74rem">Classic Address: ${esc(x.address)}</div>` : ''}
                  ${walletBalLine(x)}
                  <div class="row" style="margin-top:.6rem;gap:.5rem">
                    <button class="sm" onclick="window.copyText('${esc(displayAddr)}')">Copy Address</button>
                    <button class="sm" onclick="window.revealWalletSecret('${x.id}')">Export Secret</button>
                    ${currentModeAccounts.length > 1 ? `<button class="sm ghost" onclick="window.deleteAccount('${x.id}')">Remove</button>` : ''}
                  </div>
                </div>
              `;
            }).join('') || `<div class="mut" style="padding:1.5rem 0">No ${isLuma ? 'LUMA' : 'XRPL'} wallets found. Generate or import one below.</div>`
          }
        </div>
      </div>

      <!-- Create / Import Actions -->
      <div class="tile c5">
        <div class="k">Wallet Management</div>

        <div class="card" style="margin-bottom:1rem">
          <b style="font-size:1.05rem">Generate New ${isLuma ? 'LUMA' : 'XRPL'} Wallet</b>
          <p class="mut" style="font-size:.82rem;margin:.4rem 0 .8rem">
            Instantly create a secure cryptographic keypair for ${isLuma ? 'LUMA Network' : 'XRPL'} stored encrypted in your local browser vault.
          </p>
          <div class="row">
            <input id="new_acc_label" class="grow" placeholder="${isLuma ? 'LUMA Account ' + (currentModeAccounts.length + 1) : 'XRPL Account ' + (currentModeAccounts.length + 1)}">
            <button class="pri acc" onclick="window.generateNewWalletInMode()">+ Generate</button>
          </div>
        </div>

        <div class="card">
          <b style="font-size:1.05rem">Manual Import ${isLuma ? 'LUMA' : 'XRPL'} Wallet</b>
          <p class="mut" style="font-size:.82rem;margin:.4rem 0 .8rem">
            Import an existing seed phrase (s…), secret family seed, or private key.
          </p>
          <div class="row">
            <input id="imp_label" class="grow" placeholder="Account Name (e.g. My Vault)">
          </div>
          <div class="row">
            <input id="imp_secret" class="grow" type="password" placeholder="Secret Key / Seed Phrase (s…)">
          </div>
          <div class="row" style="margin-top:.8rem">
            <button class="pri grow" onclick="window.manualImportWalletInMode()">Import Wallet to Storage</button>
          </div>
        </div>

        ${
          isLuma
            ? `
          <div class="card" style="margin-top:1rem;border-color:rgba(0,255,140,0.3)">
            <b class="ok">Activate or fund a wallet</b>
            <p class="mut" style="font-size:.82rem;margin:.4rem 0 .6rem">
              New wallets start at 0. The network only requires a reserve of <b>${fq(reserveBase())} ${esc(n.native)}</b> (plus ${fq(reserveInc())} per trust line, offer or pool share). Nothing is sent automatically: pick a funded wallet and send what you choose. The reserve stays in the wallet and is never spent on fees; it simply cannot be sent away while the account holds those objects.
            </p>
            ${walletFundForm(currentModeAccounts, a)}
          </div>
        `
            : ''
        }
      </div>
    </div>
  `;
}

// NFT Studio View
function renderNftView(a: AccountData | undefined, n: NetworkDef) {
  const nfts = st.nfts || [];
  return `
    <div class="grid">
      <div class="tile c12">
        <div class="row" style="margin:0;align-items:center">
          <div>
            <div class="k">Native Ledger NFTs (XLS-20)</div>
            <h2 style="margin:0">NFT Studio & Gallery</h2>
          </div>
          <span class="grow"></span>
          <div class="row" style="gap:.5rem">
            <button class="pri acc" onclick="window.openMintNftModal()">+ Mint New NFT</button>
            <button onclick="window.openTransferNftModal()">Transfer NFT</button>
            <button onclick="window.goTab('receive')">Receive NFT</button>
          </div>
        </div>
      </div>

      <div class="tile c4">
        <div class="k">NFTs in Connected Wallet</div>
        <div class="big">${nfts.length}</div>
        <div class="sub">Verified XLS-20 Non-Fungible Tokens</div>
      </div>
      <div class="tile c4">
        <div class="k">On-Ledger Standard</div>
        <div class="big">XLS-20</div>
        <div class="sub">Native built-in royalties & zero gas minting</div>
      </div>
      <div class="tile c4">
        <div class="k">Active Network</div>
        <div class="big">${esc(n.name)}</div>
        <div class="sub">Network ID: ${n.networkId || 4242}</div>
      </div>

      <!-- NFT Gallery -->
      <div class="tile c12">
        <div class="k" style="margin-bottom:1rem">Your NFT Collection</div>
        ${
          nfts.length
            ? `
          <div class="grid">
            ${nfts.map((nft, idx) => `
              <div class="tile c4" style="background:rgba(20,10,40,0.7);border-radius:1rem;overflow:hidden;padding:1rem">
                <div style="height:12rem;border-radius:.8rem;background:linear-gradient(135deg,rgba(155,92,255,0.3),rgba(0,255,140,0.3));display:flex;align-items:center;justify-content:center;margin-bottom:.8rem;overflow:hidden">
                  ${nft.image ? `<img src="${esc(nft.image)}" style="width:100%;height:100%;object-fit:cover" />` : `<svg viewBox="0 0 24 24" style="width:4rem;height:4rem;stroke:var(--ok);fill:none;stroke-width:1.5"><path d="M4 4h16v16H4zM4 15l4-4 4 4 5-5 3 3M14 8a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/></svg>`}
                </div>
                <b style="font-size:1.1rem;display:block">${esc(nft.name || 'LUMA NFT #' + (nft.sequence || idx + 1))}</b>
                <p class="mut" style="font-size:.8rem;margin:.3rem 0 .6rem">${esc(nft.desc || 'Native XLS-20 NFT on LUMA ledger')}</p>
                <div class="row" style="margin:.4rem 0">
                  <span class="chip">Taxon: ${nft.taxon || 0}</span>
                  <span class="chip b">Royalties: ${((nft.transferFee || 0) / 1000).toFixed(1)}%</span>
                  <span class="chip ok">Transferable</span>
                </div>
                <div class="mono mut" style="font-size:.7rem;margin:.4rem 0;overflow:hidden;text-overflow:ellipsis">ID: ${esc(nft.id)}</div>
                <div class="row" style="margin-top:.8rem">
                  <button class="pri sm grow" onclick="window.openTransferNftModal('${esc(nft.id)}')">Transfer NFT</button>
                </div>
              </div>
            `).join('')}
          </div>
        `
            : `
          <div class="card" style="text-align:center;padding:3rem 1.5rem">
            <svg viewBox="0 0 24 24" style="width:3.5rem;height:3.5rem;stroke:var(--mut);fill:none;stroke-width:1.5;margin:0 auto 1rem"><path d="M4 4h16v16H4zM4 15l4-4 4 4 5-5 3 3M14 8a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/></svg>
            <h3>No NFTs in this Wallet</h3>
            <p class="mut" style="max-width:28rem;margin:.6rem auto 1.4rem">
              Mint your first digital asset or collection directly onto the LUMA / XRPL ledger with native royalty enforcement and decentralized custody.
            </p>
            <button class="pri acc" onclick="window.openMintNftModal()">+ Mint Your First LUMA NFT</button>
          </div>
        `
        }
      </div>
    </div>
  `;
}

export function renderLockScreen(root: HTMLElement) {
  if (PANEL) {
    root.innerHTML = '<div class="lock"><div class="card"><div class="mut" style="padding:1rem">Connecting to the control panel…</div></div></div>';
    return;
  }
  const hasVault = !!store.get(VK);
  root.innerHTML = `
    <div class="lock">
      <div class="card">
        <div class="logo" style="justify-content:center;font-size:1.8rem;padding-bottom:.4rem">
          <svg viewBox="0 0 32 32" style="width:3rem;height:3rem;filter:drop-shadow(0 0 10px rgba(0, 255, 140, 0.6))">
            <defs>
              <linearGradient id="sg2" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#00ff8c"/>
                <stop offset="1" stop-color="#4f7cff"/>
              </linearGradient>
            </defs>
            <path d="M16 2l3.6 9.4L29 14.5l-7.6 5.7L24 30l-8-5.4L8 30l2.6-9.8L3 14.5l9.4-3.1z" fill="url(#sg2)"/>
          </svg>
          <div>
            <span>STARSKY</span>
            <small style="display:block;color:var(--mut);font-size:.65rem;letter-spacing:.08em;font-weight:700">LUMA NETWORK WALLET</small>
          </div>
        </div>
        <p class="mut" style="margin:.4rem 0 1.2rem">
          ${
            hasVault
              ? 'Enter your master password to unlock your encrypted wallet.'
              : 'Create a password to encrypt your wallet keys securely in this browser.'
          }
        </p>

        <div class="row">
          <input id="pw" type="password" class="grow" placeholder="${hasVault ? 'Password' : 'Create Password (8+ characters)'}" onkeydown="if(event.key==='Enter') ${hasVault ? 'window.unlockVault()' : 'window.createVault()'}">
        </div>
        ${
          hasVault
            ? ''
            : `
          <div class="row">
            <input id="pw2" type="password" class="grow" placeholder="Confirm Password" onkeydown="if(event.key==='Enter') window.createVault()">
          </div>
        `
        }

        <div class="row" style="margin-top:1rem">
          <button class="pri acc grow" onclick="${hasVault ? 'window.unlockVault()' : 'window.createVault()'}">
            ${hasVault ? 'Unlock Wallet' : 'Create New Vault'}
          </button>
        </div>

        <div id="lerr" class="crit" style="min-height:1.4rem;margin-top:.5rem;font-size:.85rem"></div>

      </div>
    </div>
  `;

  setTimeout(() => {
    document.getElementById('pw')?.focus();
  }, 100);
}

export async function panelBoot() {
  if (!PANEL) return;
  document.body.classList.add('panelmode');
  const q = new URLSearchParams(location.search);
  const net = q.get('net') === 'test' ? 'test' : 'main';
  CFG.net = net;
  const ws = q.get('ws');
  if (ws) CFG.urls[net] = ws;
  CFG.lockMin = 0;
  const tab = q.get('tab');
  if (tab) (st as any).tab = tab;
  window.addEventListener('message', async (e: MessageEvent) => {
    const d: any = e.data;
    if (!d || e.origin !== location.origin) return;
    if (d.type === 'starsky-tab' && d.tab) {
      (window as any).goTab(d.tab);
      return;
    }
    if (d.type !== 'panel-wallets') return;
    const list: AccountData[] = (d.wallets || []).filter((x: any) => x && x.seed && x.address).map((x: any, i: number) => ({ id: 'panel_' + x.address, label: x.label || 'Wallet ' + (i + 1), seed: x.seed, address: x.address, type: 'luma' as const }));
    if (!list.length) return;
    if (!VAULT) {
      const raw = store.get(VK);
      let opened: VaultState | null = null;
      if (raw) {
        try {
          opened = await openVault(JSON.parse(raw), PANEL_PW);
        } catch {}
      }
      if (opened) VAULT = opened;
      else {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await kdf(PANEL_PW, salt, 1000);
        VAULT = { data: { accounts: [], active: null }, key, salt, iter: 1000 };
      }
    }
    const v = VAULT!;
    let changed = false;
    for (const a of list) {
      const have = v.data.accounts.find(x => x.address === a.address);
      if (!have) {
        v.data.accounts.push(a);
        changed = true;
      } else if (have.seed !== a.seed) {
        have.seed = a.seed;
        changed = true;
      }
    }
    // drop wallets the panel no longer has
    const keep = new Set(list.map(x => x.address));
    const before = v.data.accounts.length;
    v.data.accounts = v.data.accounts.filter(x => keep.has(x.address));
    if (v.data.accounts.length !== before) changed = true;
    const want = d.active ? v.data.accounts.find(x => x.address === d.active) : null;
    if (!v.data.active || !v.data.accounts.find(x => x.id === v.data.active)) v.data.active = (want || v.data.accounts[0]).id;
    if (changed) await persistVault(); else syncToPanel();
    if (!st.client) {
      renderApp();
      connectNodes();
    } else renderApp();
  });
  try {
    window.parent.postMessage({ type: 'starsky-ready' }, location.origin);
  } catch {}
}

// Window actions
export function initWindowBindings() {
  (window as any).dx = Dex.api;
  (window as any).nw = Pages.nwApi;
  (window as any).sp = Supply.spApi;
  (window as any).nm = Nft.nmApi;
  (window as any).hx = Hist.hxApi;
  (window as any).hd = Hold.hdApi;
  (window as any).bt = Bot.btApi;
  (window as any).mg = Mg.mgApi;
  (window as any).bn = Bn.api;
  (window as any).mk = Pages.mkApi;
  (window as any).br = Pages.brApi;
  (window as any).pa = Pages.paApi;
  (window as any).pl = PL.plApi;
  (window as any).lp = lpApi;
  (window as any).tk = tkApi;
  (window as any).xa = xaApi;
  setCtx({
    req: async (command: string, params: any = {}) => {
      if (!st.client) throw new Error('not connected');
      const cl: any = await chainClient();
      const r: any = await cl.request({ command, ...params });
      return r.result;
    },
    xrpl: () => st.walletMode === 'xrpl',
    online: () => st.status === 'online' && !!st.client,
    native: () => (st.walletMode === 'xrpl' ? 'XRP' : getNet().native),
    netKey: () => CFG.net,
    account: () => activeAccount()?.address ? LumaAddr.toR(activeAccount()!.address) : undefined,
    show: (r: string) => (st.walletMode === 'xrpl' ? r : showAddr(r)),
    toClassic: (a: string) => { try { return LumaAddr.toR(a); } catch { return a; } },
    usdName: () => 'USD',
    submit: async (tx: any) => {
      try {
        const r: any = await submitTx(tx);
        return r.ok ? { ok: true, hash: r.hash } : { ok: false, msg: r.msg };
      } catch (e: any) { return { ok: false, msg: String(e?.message || e) }; }
    },
    toast: (m: string, bad?: boolean) => toast(m, !!bad),
    rerender: () => renderApp(),
    wallets: () => (VAULT?.data.accounts || []).map(x => ({ label: x.label, address: x.address, seed: x.seed, type: x.type })),
    nodeUrl: () => getNet().url,
    submitAs: async (seed: string, tx: any) => {
      try {
        const r: any = await submitTx(tx, seed);
        return r.ok ? { ok: true, hash: r.hash } : { ok: false, msg: r.msg };
      } catch (e: any) { return { ok: false, msg: String(e?.message || e) }; }
    },
    addWallet: async (label: string, seed: string, address: string) => {
      if (!VAULT) throw new Error('Wallet is locked');
      VAULT.data.accounts.push({ id: Math.random().toString(36).slice(2, 10), label, seed, address, type: 'luma' });
      await persistVault();
    },
    modal: (h: string) => modal(h),
    closeModal: () => closeModal(),
    showL: (r: string) => { try { return LumaAddr.toL(r); } catch { return r; } },
  });
  (window as any).goTab = (t: AppState['tab']) => {
    st.tab = t;
    renderApp();
    if (t === 'pools') discoverPools();
    window.scrollTo(0, 0);
  };

  (window as any).setWalletMode = (mode: 'luma' | 'xrpl') => {
    st.walletMode = mode;
    const accounts = VAULT?.data.accounts || [];
    const match = accounts.find(x => (mode === 'luma' ? x.type !== 'xrpl' : x.type === 'xrpl'));
    if (match && VAULT) {
      VAULT.data.active = match.id;
      persistVault();
    } else if (!match && VAULT) {
      // Auto-create wallet for this mode
      const w = xrpl.Wallet.generate();
      const id = Math.random().toString(36).slice(2, 10);
      VAULT.data.accounts.push({
        id,
        label: mode === 'luma' ? 'LUMA Main' : 'XRPL Main',
        seed: w.seed!,
        address: w.classicAddress,
        type: mode,
      });
      VAULT.data.active = id;
      persistVault();
    }
    st.bal = null;
    st.lines = [];
    st.hist = [];
    clearCache();   // nothing fetched from the other network may be shown again
    if (mode === 'xrpl' && ['dex', 'pools', 'network', 'supply', 'burn', 'bot', 'margin', 'holders'].includes(st.tab)) st.tab = 'home';
    Object.assign(Nft.NF, { items: [], offers: [], act: [], hist: [], loadedAt: 0, histAt: 0, xmints: [], err: '' });   // NFTs follow the wallet tab: LUMA ledger or XRP Ledger
    renderApp();
    refreshAccount();
  };

  (window as any).copyText = copyText;

  (window as any).switchNet = async (id: string) => {
    if (CFG.net === id) return;
    CFG.net = id;
    saveCfg();
    st.bal = null;
    st.lines = [];
    st.hist = [];
    st.mpts = [];
    st.nfts = [];
    st.px = {};
    st.pools = [];
    st.chart = [];
    getNet();
    renderApp();
    connectNodes();
  };

  (window as any).switchAcct = (id: string) => {
    if (!VAULT) return;
    VAULT.data.active = id;
    persistVault();
    st.bal = null;
    st.lines = [];
    st.hist = [];
    st.chart = [];
    renderApp();
    if (st.client && st.status === 'online') {
      const a = activeAccount();
      if (a) {
        st.client.request({ command: 'subscribe', accounts: [a.address] }).catch(() => {});
        refreshAccount();
      }
    }
  };

  (window as any).selectNodePreset = (url: string) => {
    const input = document.getElementById('nodeurl') as HTMLInputElement | null;
    if (input) input.value = url;
    CFG.urls[CFG.net] = url;
    saveCfg();
    connectNodes();
  };

  (window as any).useNode = () => {
    const v = (document.getElementById('nodeurl') as HTMLInputElement)?.value.trim();
    if (!v) {
      delete CFG.urls[CFG.net];
      saveCfg();
      return connectNodes();
    }
    if (!/^wss?:\/\/[^\s]+$/.test(v)) {
      toast('Please enter a valid ws:// or wss:// URL', true);
      return;
    }
    CFG.urls[CFG.net] = v;
    saveCfg();
    connectNodes();
  };

  (window as any).connectNodes = connectNodes;
  (window as any).discoverPools = discoverPools;

  (window as any).setUrl = (id: string, url: string) => {
    CFG.urls[id] = url.trim();
    saveCfg();
    if (CFG.net === id) connectNodes();
  };

  (window as any).resetNets = () => {
    CFG.urls = {};
    saveCfg();
    renderApp();
    connectNodes();
  };

  (window as any).requestFaucet = async (btn: HTMLButtonElement) => {
    const a = activeAccount();
    if (!a) return;
    btn.disabled = true;
    btn.textContent = 'Requesting…';
    toast('Requesting testnet funds from faucet…');

    try {
      const res = await fetch('https://faucet.altnet.rippletest.net/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination: a.address }),
      });
      if (res.ok) {
        toast('✓ Testnet funds dispatched! Checking balance…');
        setTimeout(() => refreshAccount(), 3000);
      } else {
        throw new Error('Faucet HTTP ' + res.status);
      }
    } catch (e) {
      if (st.client) {
        try {
          const w = xrpl.Wallet.fromSeed(a.seed);
          await st.client.fundWallet(w);
          toast('✓ Funded wallet from node faucet!');
          setTimeout(() => refreshAccount(), 1000);
        } catch (e2: any) {
          toast('Faucet failed: ' + (e2?.message || String(e)), true);
        }
      } else {
        toast('Faucet request failed: ' + String(e), true);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = `Get Test ${getNet().native}`;
    }
  };

  (window as any).sendMax = () => {
    const aSelect = document.getElementById('s_asset') as HTMLSelectElement | null;
    const amtInput = document.getElementById('s_amt') as HTMLInputElement | null;
    if (!aSelect || !amtInput) return;
    const a = keyAsset(aSelect.value);
    const av = availOf(a);
    amtInput.value = decN(Math.max(0, a.c === 'native' ? av - 0.00002 : av));
  };

  (window as any).useBook = (addr: string) => {
    (window as any).goTab('send');
    setTimeout(() => {
      const destInput = document.getElementById('s_dest') as HTMLInputElement | null;
      if (destInput) destInput.value = addr;
    }, 50);
  };

  (window as any).addBook = () => {
    const n = (document.getElementById('ab_n') as HTMLInputElement)?.value.trim();
    const a = (document.getElementById('ab_a') as HTMLInputElement)?.value.trim();
    if (!n || !a) {
      toast('Name and address required', true);
      return;
    }
    try {
      toClassic(a);
      CFG.book.push({ name: n, addr: a });
      saveCfg();
      renderApp();
      toast('Contact saved');
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  (window as any).delBook = (idx: number) => {
    CFG.book.splice(idx, 1);
    saveCfg();
    renderApp();
  };

  (window as any).reviewSend = () => {
    try {
      const aSelect = (document.getElementById('s_asset') as HTMLSelectElement)?.value;
      const destVal = (document.getElementById('s_dest') as HTMLInputElement)?.value;
      const amtVal = (document.getElementById('s_amt') as HTMLInputElement)?.value;
      const tagVal = (document.getElementById('s_tag') as HTMLInputElement)?.value.trim();
      const memoVal = (document.getElementById('s_memo') as HTMLInputElement)?.value.trim();

      const a = keyAsset(aSelect);
      const dest = toClassic(destVal);
      const amt = pf(amtVal);

      if (!(amt > 0)) throw new Error('Enter a valid amount');
      if (dest === activeAccount()?.address) throw new Error('Cannot send to your own address');
      if (amt > availOf(a) + 1e-9) throw new Error(`Exceeds spendable balance of ${fq(availOf(a))} ${aName(a)}`);

      if (tagVal && !/^\d{1,10}$/.test(tagVal)) throw new Error('Tag must be an integer');

      const tx: any = {
        TransactionType: 'Payment',
        Account: activeAccount()!.address,
        Destination: dest,
        Amount: amtTx(a, amt),
      };

      if (tagVal) tx.DestinationTag = Number(tagVal);
      if (memoVal) {
        tx.Memos = [
          {
            Memo: {
              MemoType: xrpl.convertStringToHex('text/plain'),
              MemoData: xrpl.convertStringToHex(memoVal),
            },
          },
        ];
      }

      st.pendingTx = tx;
      modal(`
        <h2>Confirm Payment</h2>
        <table style="margin:.8rem 0">
          <tr><td class="mut">Amount</td><td class="r"><b>${fq(amt)} ${esc(aName(a))}</b></td></tr>
          <tr><td class="mut">Destination</td><td class="r mono" style="font-size:.78rem;word-break:break-all">${esc(showAddr(dest))}</td></tr>
          ${tagVal ? `<tr><td class="mut">Tag</td><td class="r">${esc(tagVal)}</td></tr>` : ''}
          <tr><td class="mut">Network</td><td class="r">${esc(getNet().name)}</td></tr>
        </table>
        <div class="row">
          <button class="grow" onclick="window.closeModal()">Cancel</button>
          <button class="pri acc grow" id="cfsend" onclick="window.doSend()">Send Now</button>
        </div>
      `);
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  (window as any).doSend = async () => {
    const btn = document.getElementById('cfsend') as HTMLButtonElement | null;
    const r = await runTx(st.pendingTx, 'Payment executed successfully', btn);
    if (r.ok) {
      closeModal();
      (window as any).goTab('activity');
    }
  };

  (window as any).closeModal = closeModal;

  (window as any).openManualImportModal = () => {
    (window as any).goTab('wallets');
  };

  (window as any).openCreatePoolModal = () => {
    modal(`
      <h2>Create Liquidity Pool (XLS-30)</h2>
      <p class="mut" style="margin:.4rem 0">Deposit starting assets to initialize an on-ledger automated market maker pool.</p>
      <div class="row">
        <input id="cp_c1" class="grow" placeholder="Asset 1 Currency (LUMA or USD, GOLD)" value="LUMA">
        <input id="cp_i1" class="grow" placeholder="Asset 1 Issuer (leave empty for native)">
      </div>
      <div class="row">
        <input id="cp_a1" class="grow" placeholder="Asset 1 Deposit Amount" inputmode="decimal">
      </div>
      <div class="row" style="margin-top:1rem">
        <input id="cp_c2" class="grow" placeholder="Asset 2 Currency (e.g. USD, GOLD)">
        <input id="cp_i2" class="grow" placeholder="Asset 2 Issuer address">
      </div>
      <div class="row">
        <input id="cp_a2" class="grow" placeholder="Asset 2 Deposit Amount" inputmode="decimal">
      </div>
      <div class="row">
        <input id="cp_fee" placeholder="Trading Fee % (e.g. 0.3)" value="0.3" style="width:10rem">
      </div>
      <div class="row" style="margin-top:1.2rem">
        <button class="grow" onclick="window.closeModal()">Cancel</button>
        <button class="pri acc grow" onclick="window.doCreatePool()">Create Pool</button>
      </div>
    `);
  };

  (window as any).doCreatePool = async () => {
    try {
      const c1 = (document.getElementById('cp_c1') as HTMLInputElement)?.value.trim();
      const i1 = (document.getElementById('cp_i1') as HTMLInputElement)?.value.trim();
      const a1 = pf((document.getElementById('cp_a1') as HTMLInputElement)?.value);
      const c2 = (document.getElementById('cp_c2') as HTMLInputElement)?.value.trim();
      const i2 = (document.getElementById('cp_i2') as HTMLInputElement)?.value.trim();
      const a2 = pf((document.getElementById('cp_a2') as HTMLInputElement)?.value);
      const fee = pf((document.getElementById('cp_fee') as HTMLInputElement)?.value) || 0.3;

      if (!(a1 > 0) || !(a2 > 0)) throw new Error('Enter deposit amounts for both pool assets');
      const asset1 = c1.toUpperCase() === 'LUMA' || c1.toUpperCase() === 'XRP' || !i1 ? NATIVE : { c: nameToCur(c1), i: toClassic(i1) };
      const asset2 = c2.toUpperCase() === 'LUMA' || c2.toUpperCase() === 'XRP' || !i2 ? NATIVE : { c: nameToCur(c2), i: toClassic(i2) };

      const tx = {
        TransactionType: 'AMMCreate',
        Account: activeAccount()!.address,
        Amount: amtTx(asset1, a1),
        Amount2: amtTx(asset2, a2),
        TradingFee: Math.round(fee * 1000),
      };

      closeModal();
      await runTx(tx, 'AMM Pool created successfully');
      setTimeout(() => discoverPools(), 2000);
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  (window as any).openDepositModal = (idx: number) => {
    const p = st.pools[idx];
    if (p) lpApi.openDeposit(p.m.account);
  };

  (window as any).doPoolDeposit = async (idx: number) => {
    const p = st.pools[idx];
    if (!p) return;
    try {
      const a1 = pf((document.getElementById('dp_a1') as HTMLInputElement)?.value);
      const a2 = pf((document.getElementById('dp_a2') as HTMLInputElement)?.value);
      if (!(a1 > 0) && !(a2 > 0)) throw new Error('Enter an amount to deposit');

      const tx: any = {
        TransactionType: 'AMMDeposit',
        Account: activeAccount()!.address,
        Asset: aIssue(p.a1),
        Asset2: aIssue(p.a2),
      };

      if (a1 > 0 && a2 > 0) {
        tx.Amount = amtTx(p.a1, a1);
        tx.Amount2 = amtTx(p.a2, a2);
        tx.Flags = 0x00100000;
      } else if (a1 > 0) {
        tx.Amount = amtTx(p.a1, a1);
        tx.Flags = 0x00080000;
      } else {
        tx.Amount = amtTx(p.a2, a2);
        tx.Flags = 0x00080000;
      }

      closeModal();
      await runTx(tx, 'Liquidity added to pool');
      setTimeout(() => discoverPools(), 2000);
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  (window as any).openWithdrawModal = (idx: number) => {
    const p = st.pools[idx];
    if (p) lpApi.openWithdraw(p.m.account);
  };

  (window as any).doPoolWithdraw = async (idx: number, pc: number) => {
    const p = st.pools[idx];
    if (!p) return;
    try {
      const mine = st.lines.find(l => l.account === p.m?.account);
      if (!mine || Number(mine.balance) <= 0) throw new Error('No LP tokens for this pool held in account');
      const bal = Number(mine.balance);

      const tx: any = {
        TransactionType: 'AMMWithdraw',
        Account: activeAccount()!.address,
        Asset: aIssue(p.a1),
        Asset2: aIssue(p.a2),
      };

      if (pc >= 100) {
        tx.Flags = 0x00020000;
      } else {
        tx.Flags = 0x00010000;
        tx.LPTokenIn = {
          currency: mine.currency,
          issuer: mine.account,
          value: decN((bal * pc) / 100),
        };
      }

      closeModal();
      await runTx(tx, `Withdrew ${pc}% of pool position`);
      setTimeout(() => discoverPools(), 2000);
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  // Add Market Modal
  (window as any).inspectLedger = async (seq: number) => {
    if (!st.client) return;
    modal(`<h2>Inspecting LUMA Ledger #${seq}</h2><div class="mut">Retrieving full ledger data…</div>`);
    try {
      const r = await st.client.request({ command: 'ledger', ledger_index: seq, transactions: true, expand: true });
      const l = (r.result as any).ledger;
      modal(`
        <h2>LUMA Ledger #${fq(seq, 0)}</h2>
        <table>
          <tr><td class="mut">Ledger Hash</td><td class="mono font-bold">${esc(l.ledger_hash)}</td></tr>
          <tr><td class="mut">Close Time</td><td>${esc(l.close_time_human || new Date((l.close_time + 946684800) * 1000).toLocaleString())}</td></tr>
          <tr><td class="mut">Total Supply</td><td>${fq(Number(l.total_coins) / 1e6)} ${getNet().native}</td></tr>
          <tr><td class="mut">Transactions</td><td>${(l.transactions || []).length}</td></tr>
        </table>
        <div class="k" style="margin-top:1rem">Transactions in this ledger</div>
        <div class="list" style="max-height:16rem;overflow-y:auto">
          ${
            (l.transactions || []).map((t: any) => `
              <div onclick="window.inspectTx('${t.hash}')">
                <span class="chip">${t.TransactionType}</span>
                <span class="a">${esc(showAddr(t.Account).slice(0, 8))}…</span>
                <span class="m mono" style="font-size:.74rem">${esc(t.hash.slice(0, 10))}…</span>
              </div>
            `).join('') || '<div class="mut">Empty ledger</div>'
          }
        </div>
        <div class="row" style="margin-top:1rem"><button class="pri grow" onclick="window.closeModal()">Close</button></div>
      `);
    } catch (e: any) {
      modal(`<h2>Error</h2><div class="al crit">${esc(e.message)}</div><button class="pri grow" onclick="window.closeModal()">Close</button>`);
    }
  };

  (window as any).inspectTx = async (hash: string) => {
    if (!st.client || !hash) return;
    modal(`<h2>Transaction Details</h2><div class="mut">Loading transaction ${hash.slice(0, 10)}…</div>`);
    try {
      const r = await st.client.request({ command: 'tx', transaction: hash });
      const t = (r.result as any).tx_json || r.result;
      const meta = (r.result as any).meta || {};
      modal(`
        <h2>Transaction Info</h2>
        <table>
          <tr><td class="mut">Type</td><td><b>${esc(t.TransactionType)}</b></td></tr>
          <tr><td class="mut">Result</td><td class="${meta.TransactionResult === 'tesSUCCESS' ? 'ok' : 'crit'}"><b>${esc(meta.TransactionResult || 'Validated')}</b></td></tr>
          <tr><td class="mut">Sender</td><td class="mono" style="font-size:.76rem">${esc(showAddr(t.Account))}</td></tr>
          ${t.Destination ? `<tr><td class="mut">Destination</td><td class="mono" style="font-size:.76rem">${esc(showAddr(t.Destination))}</td></tr>` : ''}
          ${t.Amount ? `<tr><td class="mut">Amount</td><td><b>${esc(typeof t.Amount === 'string' ? fq(Number(t.Amount) / 1e6) + ' ' + getNet().native : fq(Number(t.Amount?.value)) + ' ' + curName(t.Amount?.currency))}</b></td></tr>` : ''}
          <tr><td class="mut">Fee Burned</td><td>${fq(Number(t.Fee) / 1e6, 6)} ${getNet().native}</td></tr>
          <tr><td class="mut">Ledger Index</td><td>#${(r.result as any).ledger_index}</td></tr>
        </table>
        <div class="k" style="margin-top:1rem">Raw Ledger JSON</div>
        <pre>${esc(JSON.stringify(r.result, null, 2))}</pre>
        <div class="row" style="margin-top:1rem"><button class="pri grow" onclick="window.closeModal()">Close</button></div>
      `);
    } catch (e: any) {
      modal(`<h2>Error</h2><div class="al crit">${esc(e.message)}</div><button class="pri grow" onclick="window.closeModal()">Close</button>`);
    }
  };

  (window as any).inspectAccount = async (addr: string) => {
    if (!st.client || !addr) return;
    modal(`<h2>Account</h2><div class="mut">Reading the ledger…</div>`);
    try {
      const classic = toClassic(addr);
      const [ai, al, at] = await Promise.all([
        st.client.request({ command: 'account_info', account: classic, ledger_index: 'validated' }).catch(() => null),
        st.client.request({ command: 'account_lines', account: classic, ledger_index: 'validated', limit: 100 }).catch(() => null),
        st.client.request({ command: 'account_tx', account: classic, limit: 12 }).catch(() => null),
      ]);
      const d = ai && (ai.result as any).account_data;
      if (!d) {
        modal(`<h2>Account</h2><p class="mut mono" style="word-break:break-all">${esc(showAddr(classic))}</p><p>This account does not exist on ${esc(getNet().name)} (it has never been funded).</p><button class="grow" onclick="window.closeModal()">Close</button>`);
        return;
      }
      const lines = (al && (al.result as any).lines) || [];
      const txs = (at && (at.result as any).transactions) || [];
      modal(`
        <h2>Account</h2>
        <div class="mono" style="word-break:break-all;font-size:.8rem;margin-bottom:.6rem">${esc(showAddr(d.Account))}</div>
        <table>
          <tr><td class="mut">Balance</td><td><b>${fq(Number(d.Balance) / 1e6)} ${esc(getNet().native)}</b></td></tr>
          <tr><td class="mut">Sequence</td><td>${d.Sequence}</td></tr>
          <tr><td class="mut">Owned objects</td><td>${d.OwnerCount}</td></tr>
        </table>
        ${lines.length ? `<div class="k" style="margin-top:1rem">Trust lines</div><table>${lines.map((x: any) => `<tr><td><b>${esc(curName(x.currency))}</b></td><td class="mono mut">${esc(showAddr(x.account).slice(0, 12))}…</td><td class="r">${esc(x.balance)}</td></tr>`).join('')}</table>` : ''}
        <div class="k" style="margin-top:1rem">Recent transactions</div>
        <table>${txs.map((x: any) => { const t = x.tx || x.tx_json || {}; const m = x.meta || {}; return `<tr onclick="window.inspectTx('${esc(t.hash || x.hash || '')}')" style="cursor:pointer"><td><b>${esc(t.TransactionType || '')}</b></td><td class="${m.TransactionResult === 'tesSUCCESS' ? 'ok' : 'crit'}">${esc(m.TransactionResult || '')}</td><td class="mut">#${esc(x.ledger_index || t.ledger_index || '')}</td></tr>`; }).join('') || '<tr><td class="mut">None</td></tr>'}</table>
        <div class="row" style="margin-top:1rem"><button class="grow" onclick="window.closeModal()">Close</button></div>
      `);
    } catch (e: any) {
      modal(`<h2>Account</h2><div class="crit">${esc(e.message)}</div><button class="grow" onclick="window.closeModal()">Close</button>`);
    }
  };

  (window as any).addTrustline = async (btn: HTMLButtonElement) => {
    try {
      const iss = toClassic((document.getElementById('t_iss') as HTMLInputElement)?.value);
      const cur = (document.getElementById('t_cur') as HTMLInputElement)?.value.trim();
      const lim = (document.getElementById('t_lim') as HTMLInputElement)?.value.trim() || '1000000000';
      if (!cur) throw new Error('Enter a currency symbol');

      const tx = {
        TransactionType: 'TrustSet',
        Account: activeAccount()!.address,
        LimitAmount: { currency: nameToCur(cur), issuer: iss, value: lim },
      };
      await runTx(tx, `Trustline enabled for ${cur}`, btn);
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  (window as any).fundActiveLumaWallet = async () => {
    const src = VAULT?.data.accounts.find(x => x.id === (document.getElementById('fund_src') as HTMLSelectElement | null)?.value);
    const dst = activeAccount();
    const amt = parseFloat((document.getElementById('fund_amt') as HTMLInputElement | null)?.value || '');
    if (!src || !dst) return toast('Pick a funding wallet', true);
    if (!(amt > 0)) return toast('Enter an amount', true);
    const have = WB[src.address]?.bal ?? 0;
    const keep = reserveBase() + reserveInc() * (WB[src.address]?.owner || 0);
    if (amt + 0.001 > have - keep) return toast(`${src.label} can send at most ${fq(Math.max(0, have - keep - 0.001))} (its own reserve stays)`, true);
    let r: any;
    try {
      r = await submitTx({ TransactionType: 'Payment', Account: src.address, Destination: dst.address, Amount: String(Math.round(amt * 1e6)) }, src.seed);
    } catch (e: any) {
      return toast(String(e?.message || e), true);
    }
    if ((r as any)?.ok === false) return toast('Rejected: ' + ((r as any).msg || 'failed'), true);
    toast(`✓ Sent ${fq(amt)} ${getNet().native} to ${dst.label}`);
    WBsig = '';
    await loadWB();
    refreshAccount();
  };

  (window as any).createAcct = async () => {
    const labelInput = document.getElementById('n_l') as HTMLInputElement | null;
    const label = labelInput?.value.trim() || 'Account';
    const w = xrpl.Wallet.generate();
    const mode = st.walletMode;
    modal(`
      <h2>Save Secret Seed</h2>
      <p class="mut" style="margin:.6rem 0">
        This seed is the master key to your account. Write it down and keep it secure offline:
      </p>
      <div class="mono card" style="word-break:break-all;margin:.8rem 0;user-select:all;color:var(--ok)">
        ${esc(w.seed)}
      </div>
      <div class="row">
        <label class="row"><input type="checkbox" id="savedSeed" style="width:auto"> <span>I have securely written down this seed</span></label>
      </div>
      <div class="row" style="margin-top:1rem">
        <button class="grow" onclick="window.closeModal()">Cancel</button>
        <button class="pri acc grow" onclick="window.confirmAddAcct('${esc(label)}', '${esc(w.seed || '')}', '${mode}')">Confirm & Activate</button>
      </div>
    `);
  };

  (window as any).confirmAddAcct = async (label: string, seed: string, mode: 'luma' | 'xrpl') => {
    const chk = document.getElementById('savedSeed') as HTMLInputElement | null;
    if (!chk?.checked) {
      toast('Please verify you have saved the seed', true);
      return;
    }
    const w = xrpl.Wallet.fromSeed(seed);
    const id = Math.random().toString(36).slice(2, 10);
    VAULT!.data.accounts.push({ id, label, seed: w.seed!, address: w.classicAddress, type: mode });
    VAULT!.data.active = id;
    await persistVault();
    closeModal();
    renderApp();
    refreshAccount();
    toast('✓ Account added');
  };

  (window as any).generateNewWalletInMode = async () => {
    if (!VAULT) return toast('Unlock the vault first', true);
    const mode = st.walletMode;
    const inp = document.getElementById('new_acc_label') as HTMLInputElement | null;
    const n = VAULT.data.accounts.filter(x => (mode === 'luma' ? x.type !== 'xrpl' : x.type === 'xrpl')).length + 1;
    const label = inp?.value.trim() || `${mode === 'luma' ? 'LUMA' : 'XRPL'} Account ${n}`;
    const w = xrpl.Wallet.generate();
    modal(`
      <h2>Save Secret Seed</h2>
      <p class="mut" style="margin:.6rem 0">This seed is the master key to <b>${esc(label)}</b>. Write it down and keep it offline:</p>
      <div class="mono card" style="word-break:break-all;margin:.8rem 0;user-select:all;color:var(--ok)">${esc(w.seed)}</div>
      <label class="row"><input type="checkbox" id="savedSeed" style="width:auto"> <span>I have securely written down this seed</span></label>
      <div class="row" style="margin-top:1rem">
        <button class="grow" onclick="window.closeModal()">Cancel</button>
        <button class="pri acc grow" onclick="window.confirmAddAcct('${esc(label)}', '${esc(w.seed || '')}', '${mode}')">Confirm & Activate</button>
      </div>`);
  };

  (window as any).manualImportWalletInMode = async () => {
    if (!VAULT) return toast('Unlock the vault first', true);
    const mode = st.walletMode;
    const lab = (document.getElementById('imp_label') as HTMLInputElement | null)?.value.trim() || '';
    const secret = (document.getElementById('imp_secret') as HTMLInputElement | null)?.value.trim() || '';
    if (!secret) return toast('Enter the secret seed (starts with s)', true);
    let w: xrpl.Wallet;
    try {
      w = xrpl.Wallet.fromSeed(secret);
    } catch {
      return toast('That is not a valid seed. It must be a family seed starting with "s".', true);
    }
    const ex = VAULT.data.accounts.find(x => x.address === w.classicAddress);
    if (ex) {
      VAULT.data.active = ex.id;
      await persistVault();
      renderApp();
      refreshAccount();
      return toast('This wallet is already in your vault, switched to it.');
    }
    const n = VAULT.data.accounts.filter(x => (mode === 'luma' ? x.type !== 'xrpl' : x.type === 'xrpl')).length + 1;
    const id = Math.random().toString(36).slice(2, 10);
    VAULT.data.accounts.push({ id, label: lab || `Imported ${n}`, seed: w.seed!, address: w.classicAddress, type: mode });
    VAULT.data.active = id;
    await persistVault();
    st.bal = null;
    st.lines = [];
    st.hist = [];
    renderApp();
    refreshAccount();
    toast('✓ Wallet imported');
  };

  (window as any).importAcct = async () => {
    const seed = (document.getElementById('i_s') as HTMLInputElement)?.value.trim();
    if (!seed) {
      toast('Please enter a secret seed (starts with s)', true);
      return;
    }
    try {
      const w = xrpl.Wallet.fromSeed(seed);
      if (VAULT!.data.accounts.some(x => x.address === w.classicAddress)) {
        throw new Error('This account already exists in your vault');
      }
      const id = Math.random().toString(36).slice(2, 10);
      VAULT!.data.accounts.push({
        id,
        label: `Imported ${VAULT!.data.accounts.length + 1}`,
        seed: w.seed!,
        address: w.classicAddress,
        type: st.walletMode,
      });
      VAULT!.data.active = id;
      await persistVault();
      renderApp();
      refreshAccount();
      toast('✓ Account imported');
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  // Add an XRPL wallet from its seed without leaving the bridge page (does not change the wallet mode you are in).
  (window as any).importXrplSeed = async (seed: string): Promise<string> => {
    seed = String(seed || '').trim(); if (!seed) throw new Error('Paste the XRPL seed (starts with s)');
    const w = xrpl.Wallet.fromSeed(seed);
    const ex = VAULT!.data.accounts.find(x => x.address === w.classicAddress);
    if (ex) return ex.address;
    const id = Math.random().toString(36).slice(2, 10);
    VAULT!.data.accounts.push({ id, label: `XRPL ${w.classicAddress.slice(0, 5)}…`, seed: w.seed!, address: w.classicAddress, type: 'xrpl' });
    await persistVault(); renderApp();
    return w.classicAddress;
  };

  (window as any).revealSeed = (id: string) => {
    const ac = VAULT?.data.accounts.find(x => x.id === id);
    if (!ac) return;
    modal(`
      <h2>Seed for ${esc(ac.label)}</h2>
      <div class="mono card" style="word-break:break-all;margin:.8rem 0;user-select:all;color:var(--ok)">
        ${esc(ac.seed)}
      </div>
      <div class="row">
        <button class="pri grow" onclick="window.closeModal()">Close</button>
      </div>
    `);
  };

  (window as any).removeAcct = async (id: string) => {
    if (!confirm('Remove this account from your active wallet? Ensure you have backed up its seed.')) return;
    VAULT!.data.accounts = VAULT!.data.accounts.filter(x => x.id !== id);
    if (VAULT!.data.active === id) {
      VAULT!.data.active = VAULT!.data.accounts[0]?.id || null;
    }
    await persistVault();
    renderApp();
    refreshAccount();
  };

  (window as any).exportVault = () => {
    const v = store.get(VK);
    if (!v) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([v], { type: 'application/json' }));
    a.download = 'starsky-wallet-backup.json';
    a.click();
  };

  (window as any).importVaultFile = async (f: File) => {
    try {
      const text = await f.text();
      const v = JSON.parse(text);
      if (!v.ct || !v.salt) throw new Error('Invalid backup structure');
      const p = prompt('Enter the password for this backup:');
      if (!p) return;
      VAULT = await openVault(v, p);
      store.set(VK, JSON.stringify(v));
      renderApp();
      connectNodes();
      toast('✓ Vault restored successfully');
    } catch (e: any) {
      toast('Import failed: ' + (e?.message || 'Invalid backup or wrong password'), true);
    }
  };

  (window as any).createVault = async () => {
    const p1 = (document.getElementById('pw') as HTMLInputElement)?.value;
    const p2 = (document.getElementById('pw2') as HTMLInputElement)?.value;
    const err = document.getElementById('lerr');
    if (!p1 || p1.length < 8) {
      if (err) err.textContent = 'Password must be at least 8 characters';
      return;
    }
    if (p1 !== p2) {
      if (err) err.textContent = 'Passwords do not match';
      return;
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await kdf(p1, salt, ITER);
    let legacy: AccountData[] = [];
    try {
      const lr = store.get(VK_RAW);
      if (lr) legacy = (JSON.parse(lr).accounts || []).filter((x: AccountData) => x && x.seed && x.address);
    } catch {}
    const initialWallet = xrpl.Wallet.generate();
    const accounts: AccountData[] = legacy.length
      ? legacy
      : [{ id: 'acct_1', label: 'LUMA Main Account', seed: initialWallet.seed!, address: initialWallet.classicAddress, type: 'luma' }];
    VAULT = {
      data: { accounts, active: accounts[0].id },
      key,
      salt,
      iter: ITER,
    };
    await persistVault();
    store.del(VK_RAW);
    renderApp();
    connectNodes();
  };

  (window as any).unlockVault = async () => {
    const p = (document.getElementById('pw') as HTMLInputElement)?.value;
    const err = document.getElementById('lerr');
    if (err) err.textContent = 'Decrypting keys…';
    try {
      const raw = store.get(VK);
      if (!raw) throw new Error('No vault found');
      VAULT = await openVault(JSON.parse(raw), p);
      renderApp();
      connectNodes();
    } catch (e: any) {
      if (err) err.textContent = e.message === 'Wrong password' ? 'Incorrect password' : e.message;
    }
  };

  (window as any).lockNow = () => {
    VAULT = null;
    if (st.client) {
      try {
        st.client.removeAllListeners();
        st.client.disconnect();
      } catch {}
    }
    st.client = null;
    st.status = 'offline';
    st.bal = null;
    st.lines = [];
    st.hist = [];
    closeModal();
    renderApp();
  };
}

// Background Starfield & Orbit Animation with dense stars
export function initStarfield() {
  const c = document.getElementById('sky') as HTMLCanvasElement | null;
  if (!c) return;
  const ctx = c.getContext('2d');
  if (!ctx) return;

  let W: number, H: number;
  let stars: Array<{ x: number; y: number; r: number; a: number; v: number }> = [];

  const resize = () => {
    W = c.width = innerWidth;
    H = c.height = innerHeight;
    stars = Array.from({ length: Math.min(300, (innerWidth / 5) | 0) }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.5 + 0.2,
      a: Math.random(),
      v: Math.random() * 0.02 + 0.005,
    }));
  };
  resize();
  window.addEventListener('resize', resize);

  const context = ctx;
  const reducedMotion = matchMedia('(prefers-reduced-motion:reduce)').matches;
  function loop() {
    context.clearRect(0, 0, W, H);
    for (const s of stars) {
      if (!reducedMotion) s.a += s.v;
      const opacity = 0.2 + 0.8 * Math.abs(Math.sin(s.a));
      context.fillStyle = `rgba(210, 200, 255, ${opacity})`;
      context.beginPath();
      context.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      context.fill();
    }
    if (!reducedMotion) requestAnimationFrame(loop);
  }
  loop();
}

// Inactivity Auto-Lock
export function initAutoLock() {
  let lastActivity = Date.now();
  const mark = () => {
    lastActivity = Date.now();
  };
  ['pointerdown', 'keydown'].forEach(evt => window.addEventListener(evt, mark));

  setInterval(() => {
    if (VAULT && CFG.lockMin > 0 && Date.now() - lastActivity > CFG.lockMin * 60000) {
      (window as any).lockNow();
    }
  }, 15000);
}

// Keep the node connection alive and replace a silently dead one (idle timeouts, sleeping laptops, restarted nodes).
setInterval(async () => {
  if (!VAULT || st.status !== 'online' || !st.client) return;
  const c = st.client;
  try {
    await Promise.race([c.request({ command: 'ping' } as any), new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), 8000))]);
  } catch {
    if (st.client === c && st.status === 'online') {
      st.status = 'offline';
      if (!(st as any).offSince) (st as any).offSince = Date.now();
      connectNodes();
    }
    return;
  }
  if (Date.now() - ((st as any).lastLedgerAt || Date.now()) > 90000 && st.client === c) {
    // answers pings but no ledger events for 90 s: the subscription died, start a fresh connection
    connectNodes();
  }
}, 15000);
