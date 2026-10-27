// Bridge page: link to the operator, a checklist of everything the bridge needs, an independent reserve check on both ledgers,
// transfer forms with estimates and requirement checks, claim directions and your activity. RLUSD, MINT and MAGIC lanes first, XRP and LUMAX later.
import * as xrpl from 'xrpl';
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { Asset, NATIVE, amtTx, esc, fmt, fromKey, hexName, nameToCur, short, ago, rippleToMs } from './util.ts';
import { req, tryReq } from './chain.ts';

const $ = (id: string) => document.getElementById(id);
const setHtml = (id: string, h: string) => { const e = $(id) as any; if (e && e.__h !== h) { e.innerHTML = h; e.__h = h; } };
const BK = 'starsky.bridge.';
const MEMO_TYPE = 'luma-bridge';
const hex = (s: string) => Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const curHex = (c: string) => (/^[0-9A-F]{40}$/i.test(c) ? c.toUpperCase() : c.length === 3 ? c : hex(c).padEnd(40, '0'));
const sameCur = (a: string, b: string) => a === b || curHex(a) === curHex(b) || hexName(a) === hexName(b);

interface BCfg { lumaVault: string; xrplVault: string; xrplUrl: string; xrplIssuer: string; opUrl: string }
const DEF_WS_TEST = 'wss://s.altnet.rippletest.net:51233', DEF_WS_MAIN = 'wss://xrplcluster.com';
const defWs = () => (ctx.netKey() === 'test' ? DEF_WS_TEST : DEF_WS_MAIN);   // XRPL mainnet for LUMA Mainnet, XRPL testnet for LUMA Testnet
const bcfg = (): BCfg => {
  const d = { lumaVault: '', xrplVault: '', xrplUrl: defWs(), xrplIssuer: '', opUrl: '' };
  try { return { ...d, ...JSON.parse(localStorage.getItem(BK + ctx.netKey()) || '{}') }; } catch { return d; }
};
const saveCfg = (o: BCfg) => localStorage.setItem(BK + ctx.netKey(), JSON.stringify(o));

let xc: xrpl.Client | null = null, xcUrl = '', xDead = { u: '', t: 0 };
let xPend: { u: string; p: Promise<xrpl.Client> } | null = null;
export async function xclient(): Promise<xrpl.Client> {
  const u = bcfg().xrplUrl;
  if (xc && xcUrl === u && xc.isConnected()) return xc;
  if (xDead.u === u && Date.now() - xDead.t < 20000) throw new Error('The XRPL node ' + u + ' is not reachable');   // fail fast instead of waiting for the timeout on every lookup
  if (xPend && xPend.u === u) return xPend.p;   // one connection attempt per node, shared by all lookups
  const old = xc; xc = null; if (old) { try { old.disconnect().catch(() => {}); } catch {} }   // never wait for the old socket
  const cl = new xrpl.Client(u, { connectionTimeout: 6000 });
  // Public XRPL nodes cap requests ("units quota exhausted, retry in ~8000ms"): space requests out, cache identical reads for a few seconds and retry when told to wait.
  { const raw = cl.request.bind(cl) as any, cache = new Map<string, { t: number; v: any }>(); let chain: Promise<any> = Promise.resolve();
    const readCmd = /^(account_info|account_lines|account_nfts|account_tx|server_info|nft_sell_offers|nft_buy_offers|ledger)$/;
    (cl as any).request = (req: any, ...rest: any[]) => {
      const key = readCmd.test(req && req.command) ? JSON.stringify(req) : '', hit = key && cache.get(key); if (hit && Date.now() - hit.t < 4000) return Promise.resolve(hit.v);
      if (!key) cache.clear();   // a submit or anything else may change balances
      const run = async () => { for (let i = 0; ; i++) { try { const v = await raw(req, ...rest); if (key) cache.set(key, { t: Date.now(), v }); return v; } catch (e: any) { const m = String((e && (e.message || e.data?.error_message)) || e), w = /rate limit|quota|slowDown|too many/i.test(m) ? Math.min(15000, (+((m.match(/retry in ~?(\d+)\s*ms/i) || [])[1]) || 3000) + 400) : 0; if (!w || i >= 4) throw e; await new Promise(r => setTimeout(r, w)); } } };
      const job = chain.then(() => new Promise(r => setTimeout(r, 90))).then(run); chain = job.catch(() => {}); return job;
    }; }
  const p = (async () => { try { await cl.connect(); xc = cl; xcUrl = u; return cl; } catch (e) { xDead = { u, t: Date.now() }; try { cl.disconnect().catch(() => {}); } catch {} throw e; } finally { if (xPend && xPend.u === u) xPend = null; } })();
  xPend = { u, p };
  return p;
}
const xreq = async (command: string, params: any = {}) => { const cl = await xclient(); return ((await cl.request({ command, ...params } as any)) as any).result; };
export const xtry = async (command: string, params: any = {}) => { try { return await xreq(command, params); } catch { return null; } };

/* ---------------------------------- state ---------------------------------- */
interface Lane { id: 'xrp' | 'luma' | 'usd' | 'mint' | 'magic'; asset: 'XRP' | 'LUMA' | 'USD' | 'MINT' | 'MAGIC'; pri: number; title: string; luma: string; xrpl: string; xiss?: string }
const OP: any = { snap: null, err: '', at: 0 };            // operator's public feed
const ST: any = { dir: 'out', lane: 'mint', bal: { L: null, X: {} }, check: [], rep: null, chk: null, busy: false, setup: null };
let gen = 0;
const TOKEN_ISSUER = 'rwCsCz93A1svS6Yv8hFqUeKLdTLhBpvqGD';   // XRPL issuer of MINT and MAGIC (used until the operator feed says otherwise)
// MINT and MAGIC on XRPL mainnet have one real issuer: never trust an older, different one from a stale operator feed.
const miIss = (fromFeed?: string) => (OP.snap && OP.snap.net === 'testnet' && fromFeed) ? fromFeed : TOKEN_ISSUER;
const xIss = (ln: Lane, c: BCfg) => ln.id === 'luma' ? c.xrplIssuer : ln.xiss ? ln.xiss : (OP.snap && OP.snap.rlusd && OP.snap.rlusd.issuer) || '';
const lumaIss = async (ln: Lane) => ln.id === 'usd' ? M.MAIN_USD : await issuerOnLuma(ln.luma);
const SHOW_LUMAX = false;   // LUMA ⇄ LUMAX comes later: only XRP, RLUSD, MINT and MAGIC are bridged for now
const lanes = (): Lane[] => {
  const o = OP.snap, codes = (o && o.codes) || { XRP: 'XRPZ', LUMA: 'LUMAX', USD: 'USD' }, rl = (o && o.rlusd && o.rlusd.code) || 'RLUSD';
  return [
    { id: 'xrp', asset: 'XRP', pri: 2, title: `XRP ⇄ ${codes.XRP}`, luma: codes.XRP, xrpl: 'XRP' },
    ...(SHOW_LUMAX ? [{ id: 'luma' as const, asset: 'LUMA' as const, pri: 2, title: `${ctx.native()} ⇄ ${codes.LUMA}`, luma: ctx.native(), xrpl: codes.LUMA }] : []),
    { id: 'usd', asset: 'USD', pri: 1, title: `${rl} ⇄ ${codes.USD}`, luma: codes.USD, xrpl: rl },
    ...(['MINT', 'MAGIC'] as const).map(k => { const t = (o && o.tokenLanes && o.tokenLanes[k]) || {}; return { id: k.toLowerCase() as 'mint' | 'magic', asset: k, pri: 1, title: `${t.xrplName || k} ⇄ ${t.luma || k}`, luma: t.luma || k, xrpl: t.xrplName || k, xiss: miIss(t.xrplIssuer) }; }),
  ];
};
const laneOf = () => lanes().find(l => l.id === ST.lane) || lanes()[0];
const pxOf = (asset: string): number | null => { const p = (OP.snap && OP.snap.prices) || {}; if (asset === 'USD') return 1; const v = p[asset]; return typeof v === 'number' && v > 0 ? v : null; };
const usdOf = (asset: string, n: number) => { const p = pxOf(asset); return p == null ? null : n * p; };
const fUsd = (v: number | null) => v == null ? '<span class="mut">no price yet</span>' : '$' + (v >= 1 ? v.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : v.toLocaleString(undefined, { maximumFractionDigits: 4 }));
const withUsd = (asset: string, n: number) => { const v = usdOf(asset, n); return v == null ? '' : ` <span class="mut">≈ ${fUsd(v)}</span>`; };
const byPri = (a: any, b: any) => (a.pri || (a.lane && a.lane.pri) || 9) - (b.pri || (b.lane && b.lane.pri) || 9);
const rules = (asset: string) => { const a = OP.snap && OP.snap.assets && OP.snap.assets[asset]; return a || { on: true, feeBps: 10, minFee: asset === 'LUMA' ? 1 : 0.1, min: asset === 'LUMA' ? 20 : 2, max: asset === 'LUMA' ? 500000 : 5000, daily: 0, approvalOver: 0, guess: true }; };
const price = (asset: string, amt: number) => { const a = rules(asset); const fee = Math.max(+(amt * a.feeBps / 1e4).toFixed(6), a.minFee || 0); return { fee, net: Math.max(0, Math.floor((amt - fee) * 1e6 + 1e-7) / 1e6) }; };
const xrplWallets = () => ctx.wallets().filter(w => w.type === 'xrpl');
const mineLuma = () => new Set(ctx.wallets().filter(w => w.type !== 'xrpl').map(w => w.address));
const lAddr = (a: string) => { try { return ctx.showL(ctx.toClassic(a)); } catch { return a; } };

/* ---------------------------------- operator link ---------------------------------- */
async function loadOperator(url: string): Promise<any> {
  const base = url.replace(/\/$/, '');
  let r: Response; try { r = await fetch(base + '/api/public/bridge', { cache: 'no-store' }); } catch { throw new Error('Cannot reach ' + base + '. Is the control panel running, and is the address right? (From another computer use an SSH tunnel or Tailscale.)'); }
  if (!r.ok) throw new Error('The operator answered ' + r.status);
  const txt = await r.text(); let j: any; try { j = JSON.parse(txt); } catch { throw new Error('That address answered with a web page, not the bridge feed. Use the control panel address (for example http://127.0.0.1:8090), and make sure the control panel is the latest version: update it and restart it, then try again.'); }
  if (!j.ok) throw new Error(j.error || 'The operator sent an error');
  return j;
}
async function tryOperator() {
  const c = bcfg();
  const cands = [c.opUrl, location.protocol.startsWith('http') ? location.origin : ''].filter(Boolean);
  for (const u of [...new Set(cands)]) {
    try { const j = await loadOperator(u); OP.snap = j; OP.err = ''; OP.at = Date.now(); OP.url = u; return; } catch (e: any) { OP.err = String(e?.message || e); }
  }
}
function applyOperator(): string {
  const j = OP.snap;
  if (!j || !j.set) throw new Error('The operator has not set up the bridge yet.');
  const c = bcfg();
  const o: BCfg = { ...c, lumaVault: ctx.toClassic(j.lumaVault), xrplVault: j.xrplVault, xrplIssuer: '', xrplUrl: j.xrplWs || c.xrplUrl, opUrl: OP.url || c.opUrl };
  saveCfg(o);
  return 'Loaded from the operator: both vaults, the XRPL node, fees and limits.';
}

/* ---------------------------------- balances ---------------------------------- */
async function loadBalances() {
  const acc = ctx.account();
  const L: any = { native: 0, lines: [], ok: false };
  if (acc) {
    const ai = await tryReq('account_info', { account: acc, ledger_index: 'validated' });
    const al = await tryReq('account_lines', { account: acc, ledger_index: 'validated', limit: 300 });
    L.ok = !!ai; L.native = ai ? Number(ai.account_data.Balance) / 1e6 : 0; L.lines = (al && al.lines) || [];
  }
  ST.bal.L = L;
  const X: any = {};
  for (const w of xrplWallets()) {
    const ai = await xtry('account_info', { account: w.address, ledger_index: 'validated' });
    const al = await xtry('account_lines', { account: w.address, ledger_index: 'validated', limit: 300 });
    X[w.address] = { ok: !!(ai && ai.account_data), xrp: ai && ai.account_data ? Number(ai.account_data.Balance) / 1e6 : 0, owners: ai && ai.account_data ? ai.account_data.OwnerCount || 0 : 0, lines: (al && al.lines) || [] };
  }
  ST.bal.X = X;
}
const lumaBal = (cur: string) => { const L = ST.bal.L; if (!L) return 0; if (cur === ctx.native()) return L.native; const l = (L.lines || []).find((x: any) => hexName(x.currency) === cur); return l ? Number(l.balance) : 0; };
const xrplBal = (addr: string, cur: string) => { const x = ST.bal.X[addr]; if (!x) return 0; if (cur === 'XRP') return x.xrp; const l = (x.lines || []).find((z: any) => sameCur(z.currency, cur)); return l ? Number(l.balance) : 0; };

/* ---------------------------------- checklist (the "doctor", read straight from the two ledgers) ---------------------------------- */
interface Chk { level: 'ok' | 'warn' | 'bad'; title: string; detail?: string; fix?: string; act?: string }
async function runChecks(): Promise<Chk[]> {
  const c = bcfg(), out: Chk[] = [], nat = ctx.native(), L = lanes();
  const add = (level: Chk['level'], title: string, detail = '', fix = '', act = '') => out.push({ level, title, detail, fix, act });
  add(ctx.online() ? 'ok' : 'bad', 'LUMA node connected', ctx.online() ? '' : 'Starsky cannot reach a LUMA node.', 'Check Network.');
  // operator relayer
  const o = OP.snap;
  if (o && o.set) {
    if (!o.enabled) add('bad', 'Operator has not enabled the bridge', 'Deposits will not be paid out.', 'The operator must press Enable on the control panel Bridge page.');
    else if (o.paused) add('bad', 'Operator bridge is paused', o.backed === false ? 'It auto-paused because a vault holds less than what was issued.' : 'Deposits are seen but nothing is paid out.', 'Ask the operator to fix the backing problem or press Resume.');
    else if (!o.alive) add('bad', 'Relayer is not running', `Last heartbeat ${o.heartbeatSec == null ? 'never' : o.heartbeatSec + 's ago'}: nothing will be paid out until it ticks again.`, 'The operator must keep the control panel running (Bridge page → Doctor → Fix).');
    else add('ok', 'Relayer running', `heartbeat ${o.heartbeatSec}s ago, scanning every ${o.everySec}s`);
  } else add('warn', 'Operator not linked', OP.err ? OP.err : 'Paste the control panel address above to load vaults, fees and relayer status automatically.', 'Or copy the four values by hand from the control panel Bridge page.');
  // config
  if (!c.lumaVault || !c.xrplVault) add('bad', 'Bridge settings incomplete', `Missing: ${[!c.lumaVault && 'LUMA vault', !c.xrplVault && 'XRPL vault', !c.xrplIssuer && 'XRPL issuer'].filter(Boolean).join(', ')}`, 'Use “Load from operator” or fill the four boxes.');
  if (c.lumaVault) {
    const v = ctx.toClassic(c.lumaVault);
    if (mineLuma().has(v) || v === ctx.account()) add('bad', 'The LUMA vault is one of YOUR wallets', `${lAddr(v)} is a wallet in this app. Paying yourself fails with temREDUNDANT and nothing would be bridged.`, 'Use the operator’s BRIDGE VAULT (LUMA) address from the control panel, not your own address.');
    else {
      const ai = await tryReq('account_info', { account: v, ledger_index: 'validated' });
      if (!ai) add('bad', 'LUMA vault does not exist on this network', lAddr(v), 'Check the address or the network (Mainnet/Testnet) switch.');
      else add('ok', 'LUMA vault found', `${fmt(Number(ai.account_data.Balance) / 1e6, 4)} ${nat} · ${short(lAddr(v), 8, 6)}`);
    }
  }
  // XRPL
  let up = false;
  if (c.xrplVault || c.xrplIssuer) {
    const si = await xtry('server_info');
    up = !!si;
    add(up ? 'ok' : 'bad', up ? 'XRPL node reachable' : 'XRPL node unreachable', up ? `${si.info.server_state} · ledger ${si.info.validated_ledger?.seq ?? '?'} · ${c.xrplUrl}` : c.xrplUrl, up ? '' : 'Check the XRPL node address (must start with wss://).');
  }
  if (up && c.xrplVault) { const ai = await xtry('account_info', { account: c.xrplVault, ledger_index: 'validated' }); add(ai && ai.account_data ? 'ok' : 'bad', ai && ai.account_data ? 'XRPL vault funded' : 'XRPL vault not found on that XRPL', ai && ai.account_data ? `${fmt(Number(ai.account_data.Balance) / 1e6, 4)} XRP` : c.xrplVault, ai && ai.account_data ? '' : 'Wrong network? The vault must be on the same XRPL (testnet vs mainnet) as the node above.'); }
  if (up && c.xrplIssuer) { const ai = await xtry('account_info', { account: c.xrplIssuer, ledger_index: 'validated' }); if (c.xrplIssuer === TOKEN_ISSUER) add('bad', 'This is the MINT/MAGIC issuer, not the LUMAX issuer', c.xrplIssuer, 'Press “Load from operator”: it fills in the bridge\'s own issuer. MINT and MAGIC use their own issuer automatically.'); else if (!ai || !ai.account_data) add('bad', 'XRPL issuer not found', c.xrplIssuer, /altnet|testnet|devnet/.test(c.xrplUrl) ? 'This node is the XRPL TEST network. If the bridge runs on mainnet, load the settings from the operator so the node matches.' : 'Check the issuer address and network.'); else { const rip = (ai.account_data.Flags & 0x00800000) !== 0; add(rip ? 'ok' : 'warn', rip ? 'XRPL issuer prepared' : 'XRPL issuer not prepared (DefaultRipple off)', '', rip ? '' : 'The operator should press Prepare issuer.'); } }
  if (up) { const ti = await xtry('account_info', { account: TOKEN_ISSUER, ledger_index: 'validated' }); const tl2: any = (OP.snap && OP.snap.tokenLanes) || {}; const on = Object.keys(tl2).filter(k => (OP.snap.assets || {})[k] && OP.snap.assets[k].on); if (on.length || ti) add(ti && ti.account_data ? 'ok' : 'warn', ti && ti.account_data ? 'MINT / MAGIC issuer found' : 'MINT / MAGIC issuer not found on this XRPL', `${TOKEN_ISSUER}${ti && ti.account_data ? '' : ''}`, ti && ti.account_data ? '' : 'MINT and MAGIC live on the XRPL mainnet. Use a mainnet node (wss://xrplcluster.com) when the operator bridge runs on mainnet.'); }
  // your wallets
  const acc = ctx.account();
  if (acc) { const b = ST.bal.L; add(b && b.ok ? 'ok' : 'warn', 'Your LUMA wallet', b && b.ok ? `${fmt(b.native, 4)} ${nat}` : 'This wallet is not active on the network yet.', b && b.ok ? '' : 'Receive some LUMA first.'); }
  const xw = xrplWallets();
  if (!xw.length) add('warn', 'No XRPL wallet in this app', 'To send from XRPL (XRP, RLUSD, MINT, MAGIC) or to receive on XRPL you need an XRPL wallet here.', 'Wallets → switch to XRPL → import your seed (or create one). Fund it with XRP first.');
  else for (const w of xw) { const x = ST.bal.X[w.address]; add(x && x.ok ? 'ok' : 'warn', `XRPL wallet “${w.label}”`, x && x.ok ? `${fmt(x.xrp, 4)} XRP` : 'Not activated on that XRPL yet (needs its reserve in XRP).', x && x.ok ? '' : 'Send it a few XRP (on testnet use the faucet).'); }
  // receiving trust lines for the priority lanes
  const xrpzIssuer = await issuerOnLuma(L[0].luma);
  if (acc && xrpzIssuer) { const has = ((ST.bal.L && ST.bal.L.lines) || []).some((l: any) => l.account === xrpzIssuer && hexName(l.currency) === L[0].luma); add(has ? 'ok' : 'warn', `Your LUMA wallet can receive ${L[0].luma}`, has ? '' : 'No trust line yet: an XRP → LUMA transfer would wait.', has ? '' : 'Use the “Add trust line” button in the transfer box.'); }
  if (c.xrplIssuer) for (const w of xw) { const x = ST.bal.X[w.address]; if (!x || !x.ok) continue; const has = x.lines.some((l: any) => l.account === c.xrplIssuer && sameCur(l.currency, L[1].xrpl)); add(has ? 'ok' : 'warn', `“${w.label}” can receive ${L[1].xrpl}`, has ? '' : 'No trust line yet: a LUMA → XRPL transfer would wait.', has ? '' : 'Use the “Add trust line” button in the transfer box.'); }
  return out;
}
async function issuerOnLuma(name: string): Promise<string> {
  try { const t = await M.tokenTable(); const r = t.rows.find(x => x.name === name); return r ? r.issuer : ''; } catch { return ''; }
}

/* ---------------------------------- independent reserve validator ---------------------------------- */
async function reserves() {
  const c = bcfg(), o = OP.snap, L = lanes(), res: any[] = [];
  const nat = ctx.native();
  // XRP lane
  try {
    const ai = c.xrplVault ? await xtry('account_info', { account: c.xrplVault, ledger_index: 'validated' }) : null;
    const si = await xtry('server_info'), vl = si?.info?.validated_ledger || {}, rb = Number(vl.reserve_base_xrp ?? 1), ri = Number(vl.reserve_inc_xrp ?? 0.2);
    const bal = ai && ai.account_data ? Number(ai.account_data.Balance) / 1e6 : null, spend = bal == null ? null : Math.max(0, bal - rb - ri * (ai.account_data.OwnerCount || 0));
    const iss = await issuerOnLuma(L[0].luma); let out: number | null = null;
    if (iss) { const g = await tryReq('gateway_balances', { account: iss, ledger_index: 'validated' }); const ob = (g && g.obligations) || {}; const k = Object.keys(ob).find(x => sameCur(x, nameToCur(L[0].luma)) || hexName(x) === L[0].luma); out = k ? Number(ob[k]) : 0; }
    res.push({ lane: L[0], locked: bal, lockedUnit: 'XRP', payout: spend, out, outUnit: L[0].luma, note: 'XRP locked on XRPL backs the XRPZ on LUMA. XRPZ minted before the bridge existed is not backed.' });
  } catch { res.push({ lane: L[0], locked: null, out: null }); }
  // USD lane
  const LU = L.find(z => z.id === 'usd')!;
  try {
    const rl = o && o.rlusd;
    let locked: number | null = null;
    if (c.xrplVault && rl && rl.issuer) { const al = await xtry('account_lines', { account: c.xrplVault, peer: rl.issuer, ledger_index: 'validated' }); const l = ((al && al.lines) || []).find((z: any) => sameCur(z.currency, rl.code)); locked = l ? Number(l.balance) : 0; }
    let out: number | null = null; const ui = M.MAIN_USD;
    if (ui) { const g = await tryReq('gateway_balances', { account: ui, ledger_index: 'validated' }); const ob = (g && g.obligations) || {}; const k = Object.keys(ob).find(x => hexName(x) === 'USD'); out = k ? Number(ob[k]) : 0; }
    res.push({ lane: LU, locked, lockedUnit: LU.xrpl, payout: locked, out, outUnit: LU.luma, note: 'RLUSD locked on XRPL backs the bridged USD. Other USD on LUMA is not bridge-backed.' });
  } catch { res.push({ lane: LU, locked: null, out: null }); }
  // MINT / MAGIC lanes
  for (const ln of L.filter(z => z.id === 'mint' || z.id === 'magic')) {
    try {
      let locked: number | null = null; if (c.xrplVault && ln.xiss) { const al = await xtry('account_lines', { account: c.xrplVault, peer: ln.xiss, ledger_index: 'validated' }); const l = ((al && al.lines) || []).find((z: any) => sameCur(z.currency, ln.xrpl)); locked = al ? (l ? Number(l.balance) : 0) : null; }
      let out: number | null = null; const iss = await issuerOnLuma(ln.luma); if (iss) { const g = await tryReq('gateway_balances', { account: iss, ledger_index: 'validated' }); const ob = (g && g.obligations) || {}; const k = Object.keys(ob).find(x => hexName(x) === ln.luma || sameCur(x, nameToCur(ln.luma))); out = k ? Number(ob[k]) : 0; } else out = null;
      res.push({ lane: ln, locked, lockedUnit: ln.xrpl, payout: locked, out, outUnit: ln.luma, note: `${ln.xrpl} locked on XRPL backs the ${ln.luma} minted on LUMA, 1:1. No market price yet.` });
    } catch { res.push({ lane: ln, locked: null, out: null }); }
  }
  ST.rep = res;
}

/* ---------------------------------- rendering ---------------------------------- */
const lvl = (l: string) => (l === 'ok' ? '<b class="up">✓</b>' : l === 'warn' ? '<b style="color:#ffc400">!</b>' : '<b class="dn">✗</b>');
export function bridgeShell() {
  return `<div id="br" class="brpage"><div id="br_head"></div><div id="br_val"></div><div id="br_nft" class="card" style="margin-top:1rem"></div><div id="br_setup"></div><div class="grid" style="margin-top:1rem"><div class="card c7" id="br_chk"><div class="k">Bridge checklist</div><div class="mut" style="padding:.6rem">Checking both ledgers…</div></div><div class="card c5" id="br_rep"><div class="k">Reserves, checked independently</div><div class="mut" style="padding:.6rem">Reading vault balances…</div></div></div>
  <div class="grid" style="margin-top:1rem"><div class="card c7" id="br_xfer"></div><div class="card c5" id="br_claim"></div></div>
  <div class="card" style="margin-top:1rem"><div class="row" style="justify-content:space-between"><div class="k" style="margin:0">Your bridge activity (read from both ledgers)</div><button class="sm ghost" onclick="window.br.refresh()">Refresh</button></div><div id="br_hist" style="overflow:auto"><div class="mut" style="padding:1rem">Reading…</div></div></div></div>`;
}

function paintVal() {
  const o = OP.snap;
  if (!o || !o.set) { setHtml('br_val', `<div class="card" style="margin-top:1rem"><div class="k" style="margin:0">Bridge validator · node link and activity</div><div class="mut" style="margin-top:.4rem">Not linked yet. Paste the operator's control panel address in Bridge settings and press “Load from operator”. This card then shows the relayer's heartbeat, both vaults and everything it is doing, live.</div></div>`); return; }
  const stCol = (s: string) => s === 'done' ? 'up' : /fail|refund|reject/i.test(s) ? 'dn' : '';
  const alive = o.alive && !o.paused && o.enabled, age = OP.at ? Math.round((Date.now() - OP.at) / 1000) : 0;
  const rows = (o.recent || []).slice(0, 14).map((t: any) => `<tr><td class="mut" style="white-space:nowrap">${esc(new Date(t.t).toLocaleTimeString())}</td><td>${esc(t.dir)} · <b>${esc(t.asset)}</b></td><td style="text-align:right">${fmt(Number(t.amount), 4)}</td><td style="text-align:right">${t.net != null ? fmt(Number(t.net), 4) : '–'}</td><td class="${stCol(t.state)}">${esc(t.state)}</td><td class="mono mut" style="font-size:.7rem">${t.srcHash ? esc(short(t.srcHash, 6, 4)) : ''}${t.dstHash ? ' → ' + esc(short(t.dstHash, 6, 4)) : ''}</td></tr>`).join('');
  const used = Object.entries(o.used || {}).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${esc(k)} ${fmt(Number(v), 2)}`).join(' · ');
  setHtml('br_val', `<div class="card" style="margin-top:1rem"><div class="row" style="justify-content:space-between;gap:.6rem;flex-wrap:wrap"><div><div class="k" style="margin:0">Bridge validator · node link and activity</div>
    <div style="margin-top:.35rem"><span class="${alive ? 'up' : 'dn'}" style="font-weight:700">${alive ? '● LINKED · relayer alive' : o.paused ? '● PAUSED by the operator' : '● relayer not running'}</span> <span class="mut">heartbeat ${o.heartbeatSec == null ? 'never' : o.heartbeatSec + 's'} ago · scans every ${o.everySec}s · ${o.backed === false ? '<b class="dn">backing problem</b>' : 'both vaults backed'} · XRPL ${esc(o.net)}</span></div></div>
    <div class="row" style="gap:.4rem"><span class="mut" style="font-size:.74rem">updated ${age}s ago</span><button class="sm ghost" onclick="window.br.refresh()">Refresh</button></div></div>
    <div class="mut mono" style="font-size:.72rem;margin:.5rem 0;word-break:break-all">operator ${esc(OP.url || '')} · LUMA vault ${esc(o.lumaVault || '')} · XRPL vault ${esc(o.xrplVault || '')} · XRPL node ${esc(o.xrplWs || o.xrplUrl || '')}${used ? ' · used today: ' + used : ''}</div>
    <div style="overflow:auto"><table class="hxt" style="width:100%;font-size:.8rem"><thead><tr><th>Time</th><th>Transfer</th><th style="text-align:right">Amount</th><th style="text-align:right">Paid out</th><th>State</th><th>Hashes</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="mut" style="padding:.7rem">No transfers yet.</td></tr>'}</tbody></table></div>
    ${(o.log || []).length ? `<details style="margin-top:.5rem"><summary class="mut" style="cursor:pointer;font-size:.78rem">Relayer log (${o.log.length})</summary><div class="mono mut" style="font-size:.7rem;line-height:1.5;margin-top:.3rem">${o.log.slice(0, 20).map((l: any) => esc(new Date(l.t).toLocaleTimeString()) + ' ' + esc(l.m)).join('<br>')}</div></details>` : ''}</div>`);
}
function paintHead() {
  const o = OP.snap;
  let st = '<span class="mut">Operator not linked: relayer status unknown</span>';
  if (o && o.set) st = !o.enabled ? '<b class="dn">Bridge not enabled by the operator</b>' : o.paused ? '<b class="dn">Paused</b>' : o.alive ? `<b class="up">Relayer running</b> <span class="mut">· heartbeat ${o.heartbeatSec}s ago · ${o.backed === false ? 'backing problem' : 'both vaults backed'}</span>` : `<b class="dn">Relayer silent</b> <span class="mut">· last heartbeat ${o.heartbeatSec == null ? 'never' : o.heartbeatSec + 's ago'}</span>`;
  setHtml('br_head', `<div class="card"><div class="row" style="justify-content:space-between;gap:.6rem;flex-wrap:wrap"><div><div class="k" style="margin:0">XRPL bridge</div><div style="margin-top:.3rem">${st}</div></div><div class="mut" style="font-size:.8rem;max-width:34rem">Lock and mint. RLUSD, MINT and MAGIC come first; XRP and ${esc(ctx.native())} (LUMAX) come later. Values are shown in dollars where a market price exists. A relayer run by the operator pays out on the other ledger a minute or so after your payment confirms.</div></div></div>`);
  paintVal();
}
function paintSetup() {
  const c = bcfg();
  const open = !c.lumaVault || !c.xrplVault || (ST.chk || []).some((x: Chk) => x.level === 'bad');
  setHtml('br_setup', `<details class="card" style="margin-top:1rem" ${open ? 'open' : ''}><summary style="cursor:pointer"><span class="k" style="display:inline">Bridge settings</span> <span class="mut" style="font-size:.8rem">· from the operator, nothing is assumed</span></summary>
    <div class="row" style="gap:.5rem;margin-top:.6rem;flex-wrap:wrap"><input id="br_op" class="grow" placeholder="Operator control panel address, e.g. http://127.0.0.1:8090" value="${esc(c.opUrl || (OP.url || ''))}"><button class="pri" onclick="window.br.loadOp(this)">Load from operator</button></div>
    <div class="mut" style="font-size:.76rem;margin:.3rem 0 .6rem">Fills in both vaults, the XRPL node, fees and limits, and shows if the relayer is alive. Works through an SSH tunnel or Tailscale too. Opened inside the control panel it links itself.</div>
    <div class="fgrid"><input id="br_lv" class="grow" placeholder="LUMA vault address (L… / T…)" value="${esc(c.lumaVault ? ctx.showL(c.lumaVault) : '')}"><input id="br_xv" class="grow" placeholder="XRPL vault address (r…)" value="${esc(c.xrplVault)}"><input id="br_xu" class="grow" placeholder="XRPL node (wss://…)" value="${esc(c.xrplUrl)}"><button class="pri" onclick="window.br.save()">Save settings</button></div>
    <div id="br_cmsg" class="mut" style="font-size:.78rem;margin-top:.3rem"></div></details>`);
}
function paintChecks() {
  const k: Chk[] = ST.chk;
  if (!k) return;
  const bad = k.filter(x => x.level === 'bad').length, warn = k.filter(x => x.level === 'warn').length;
  setHtml('br_chk', `<div class="row" style="justify-content:space-between"><div class="k" style="margin:0">Bridge checklist</div><span>${bad ? `<b class="dn">${bad} to fix</b>` : warn ? `<b style="color:#ffc400">${warn} to check</b>` : '<b class="up">All good</b>'} <button class="sm ghost" onclick="window.br.refresh()">Re-check</button></span></div>
    <div style="margin-top:.5rem">${k.map(x => `<div class="row" style="gap:.6rem;align-items:flex-start;padding:.35rem 0;border-top:1px solid rgba(255,255,255,.05)"><span style="width:1rem">${lvl(x.level)}</span><div style="flex:1"><div>${esc(x.title)}</div>${x.detail ? `<div class="mut" style="font-size:.78rem;word-break:break-word">${esc(x.detail)}</div>` : ''}${x.fix && x.level !== 'ok' ? `<div style="font-size:.78rem;color:#00ff8c">→ ${esc(x.fix)}</div>` : ''}</div></div>`).join('')}</div>`);
}
function paintRep() {
  const r = ST.rep;
  if (!r) return;
  setHtml('br_rep', `<div class="k">Reserves, checked independently</div><div class="mut" style="font-size:.76rem;margin-bottom:.4rem">Read from both ledgers by this app, not taken from the operator.</div>${r.slice().sort(byPri).map((x: any) => {
    const has = x.locked != null && x.out != null, ratio = has && x.out > 0 ? x.locked / x.out : null;
    const state = !has ? '<span class="mut">cannot read yet</span>' : x.out === 0 ? '<span class="up">nothing issued</span>' : ratio! >= 0.999999 ? '<b class="up">fully backed</b>' : `<b style="color:#ffc400">${(ratio! * 100).toFixed(1)}% backed</b>`;
    return `<div style="padding:.5rem 0;border-top:1px solid rgba(255,255,255,.05)"><div class="row" style="justify-content:space-between"><b>${esc(x.lane.title)}${x.lane.pri > 1 ? ' <span class="mut" style="font-weight:400">· later</span>' : ''}</b>${state}</div>
      <div class="row" style="gap:1.2rem;font-size:.84rem;margin-top:.2rem"><div><span class="mut">Locked in vault</span><br><b>${x.locked == null ? '–' : fmt(x.locked, 4)} ${esc(x.lockedUnit || '')}</b>${x.locked == null ? '' : '<br>' + (usdOf(x.lane.asset, x.locked) == null ? '<span class="mut">no price yet</span>' : '<span class="mut">≈ ' + fUsd(usdOf(x.lane.asset, x.locked)) + '</span>')}</div><div><span class="mut">Issued (outstanding)</span><br><b>${x.out == null ? '–' : fmt(x.out, 4)} ${esc(x.outUnit || '')}</b></div><div><span class="mut">Can pay out now</span><br><b>${x.payout == null ? '–' : fmt(x.payout, 4)}</b></div></div>
      <div class="mut" style="font-size:.74rem;margin-top:.2rem">${esc(x.note || '')}</div></div>`;
  }).join('')}`);
}
function walletOptions(kind: 'luma' | 'xrpl') {
  if (kind === 'luma') { const a = ctx.account(); return a ? `<option>${esc(short(ctx.showL(a), 8, 6))} (selected wallet)</option>` : '<option>No wallet selected</option>'; }
  const xw = xrplWallets();
  return xw.map(w => `<option value="${esc(w.address)}">${esc(w.label)} · ${esc(short(w.address, 6, 5))}</option>`).join('') || '<option value="">No XRPL wallet (Wallets → XRPL → import seed)</option>';
}
function paintXfer() {
  const L = lanes(), ln = laneOf(), out = ST.dir === 'out';
  const from = out ? ln.luma : ln.xrpl, to = out ? ln.xrpl : ln.luma;
  const xw = xrplWallets();
  const prev = { amt: (($('br_amt') as HTMLInputElement) || { value: '' }).value, dst: (($('br_dst') as HTMLInputElement) || { value: '' }).value, xw: (($('br_xw') as HTMLSelectElement) || { value: '' }).value };
  const e = $('br_xfer');
  if (!e) return;
  e.innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:.5rem"><div class="row" style="gap:.6rem;align-items:center"><div class="k" style="margin:0">Transfer</div><button class="sm pri acc" onclick="window.brw.start()">✨ Bridge wizard</button></div><div class="seg"><button class="${out ? 'on' : ''}" onclick="window.br.dir('out')">${esc(ctx.native())} → XRPL</button><button class="${out ? '' : 'on'}" onclick="window.br.dir('in')">XRPL → ${esc(ctx.native())}</button></div></div>
    <div class="row" style="gap:.4rem;margin:.6rem 0;flex-wrap:wrap">${L.slice().sort(byPri).map(l => `<button class="${l.id === ln.id ? 'pri acc' : 'ghost'}" onclick="window.br.lane('${l.id}')">${esc(out ? `${l.luma} → ${l.xrpl}` : `${l.xrpl} → ${l.luma}`)}${l.pri > 1 ? ' <small>later</small>' : ''}</button>`).join('')}</div>
    <div class="mut" style="font-size:.8rem;margin-bottom:.4rem">${esc(from)} on ${out ? 'LUMA' : 'XRPL'} becomes <b>${esc(to)}</b> on ${out ? 'XRPL' : 'LUMA'}.</div>
    <div class="row" style="gap:.5rem"><select id="br_xw" class="grow" onchange="window.br.est()" ${out ? 'disabled' : ''}>${out ? walletOptions('luma') : walletOptions('xrpl')}</select></div>
    <div class="row" style="gap:.5rem;margin-top:.4rem"><input id="br_amt" class="grow" placeholder="Amount of ${esc(from)}" inputmode="decimal" oninput="window.br.est()"><button class="ghost" onclick="window.br.max()">Max</button></div>
    <div class="row" style="gap:.5rem;margin-top:.4rem">${out && xw.length ? `<select class="grow" onchange="document.getElementById('br_dst').value=this.value;window.br.est()"><option value="">Pick my XRPL wallet…</option>${xw.map(w => `<option value="${esc(w.address)}">${esc(w.label)} · ${esc(short(w.address, 6, 5))}</option>`).join('')}</select>` : ''}</div>
    <div class="row" style="gap:.5rem;margin-top:.4rem"><input id="br_dst" class="grow" placeholder="${out ? 'Destination on XRPL (r…, optional :tag)' : 'Destination on LUMA (L… / T…)'}" value="${esc(prev.dst || (out ? (xw[0] ? xw[0].address : '') : ctx.account() ? ctx.showL(ctx.account() as string) : ''))}" oninput="window.br.est()"></div>
    <div id="br_est" class="brest" style="margin-top:.7rem"></div>
    <button id="br_go" class="pri acc" style="width:100%;margin-top:.6rem" onclick="window.br.send(this)">Send to the bridge</button><div id="br_msg" class="mut" style="font-size:.78rem;margin-top:.4rem"></div>`;
  if (prev.xw && !out) { const s = $('br_xw') as HTMLSelectElement; if (s && [...s.options].some(o => o.value === prev.xw)) s.value = prev.xw; }
  const a = $('br_amt') as HTMLInputElement; if (a && prev.amt) a.value = prev.amt;
  estimate();
}
function paintClaim() {
  const ln = laneOf(), c = bcfg(), nat = ctx.native(), r = rules(ln.asset), o = OP.snap;
  const steps: Record<string, string[]> = {
    xrp: [
      `<b>XRP → ${esc(ln.luma)}:</b> import your XRPL wallet (Wallets → XRPL), make sure it holds XRP, and that your LUMA wallet has a ${esc(ln.luma)} trust line (the button in the transfer box adds it).`,
      `Choose XRP → ${esc(ln.luma)}, enter the amount and your LUMA address, press Send. Your XRP goes to the XRPL vault with a memo naming your LUMA address.`,
      `The relayer waits for confirmation, then mints ${esc(ln.luma)} to you on LUMA, usually within a minute or two. It appears in your wallet; no claim button is needed.`,
      `<b>Back to XRP:</b> choose ${esc(nat)} → XRPL with ${esc(ln.luma)}, enter your r… address. The relayer burns the ${esc(ln.luma)} and pays XRP from the vault. Your XRPL account must exist (the XRP reserve).`,
    ],
    luma: [
      `<b>${esc(nat)} → ${esc(ln.xrpl)}:</b> your XRPL wallet first needs a ${esc(ln.xrpl)} trust line to the bridge issuer (the button in the transfer box adds it) and a little XRP for fees and reserve.`,
      `Choose ${esc(nat)} → XRPL, enter the amount and your r… address, press Send. Your ${esc(nat)} is locked in the LUMA vault.`,
      `The relayer then issues ${esc(ln.xrpl)} to your XRPL wallet, usually within a minute or two.`,
      `<b>Back to ${esc(nat)}:</b> choose XRPL → ${esc(nat)} with ${esc(ln.xrpl)}. It is sent to the bridge issuer (not the vault), burned, and ${esc(nat)} is released from the LUMA vault to your LUMA address.`,
    ],
    usd: [
      `<b>RLUSD ⇄ ${esc(ln.luma)}:</b> RLUSD is Ripple’s dollar token. Your XRPL wallet needs an RLUSD trust line first (verify the issuer on Ripple’s site before real money).`,
      `RLUSD → ${esc(ln.luma)}: the RLUSD is locked in the XRPL vault and the same amount of ${esc(ln.luma)} appears on LUMA (1:1 less the fee). Your LUMA wallet needs a ${esc(ln.luma)} trust line.`,
      `${esc(ln.luma)} → RLUSD does the reverse. This lane only works once the operator has funded the XRPL vault with RLUSD to pay out.`,
    ],
    tok: [
      `<b>${esc(ln.xrpl)} (XRPL) ⇄ ${esc(ln.luma)} (LUMA):</b> ${esc(ln.xrpl)} is issued on XRPL by ${esc(short(ln.xiss || '', 6, 5))}. Your XRPL wallet needs a ${esc(ln.xrpl)} trust line to that issuer, and your LUMA wallet needs a ${esc(ln.luma)} trust line (both buttons are in the transfer box).`,
      `XRPL → LUMA: your ${esc(ln.xrpl)} is locked in the XRPL vault and the same amount of ${esc(ln.luma)} is minted on LUMA, 1:1 less the fee. LUMA → XRPL burns it and releases the ${esc(ln.xrpl)} from the vault.`,
      `<b>Price:</b> ${esc(ln.xrpl)} has no market price yet, so the bridge does not convert anything: 1 ${esc(ln.xrpl)} on XRPL is always 1 ${esc(ln.luma)} on LUMA (minus the fee). Once an XRP pair exists it will be priced like any other token.`,
      `The operator must hold ${esc(ln.xrpl)} in the XRPL vault before any ${esc(ln.luma)} can be sent back.`,
    ],
  };
  const eta = `Typical time: ${o && o.everySec ? `scan every ${o.everySec}s` : 'about a minute'} plus ledger confirmations.`;
  setHtml('br_claim', `<div class="k">How to claim · ${esc(ln.title)}</div><ol style="margin:.4rem 0 .6rem 1.1rem;padding:0;font-size:.84rem;line-height:1.5">${(steps[ln.id] || steps.tok).map(s => `<li style="margin-bottom:.35rem">${s}</li>`).join('')}</ol>
    <div class="mut" style="font-size:.78rem">Fee ${(r.feeBps / 100).toFixed(2)}% (min ${fmt(r.minFee, 4)}) · allowed ${fmt(r.min, 4)} to ${fmt(r.max, 4)} per transfer${r.daily ? ` · daily room ${fmt(Math.max(0, r.daily - ((o && o.used && o.used[ln.asset]) || 0)), 2)}` : ''}${r.guess ? ' (typical values until the operator is linked)' : ''}<br>${esc(eta)}<br>Nothing is sent without you pressing Send; if a trust line is missing the transfer waits and completes by itself once you add it.</div>
    ${c.lumaVault ? `<div class="mut mono" style="font-size:.7rem;margin-top:.5rem;word-break:break-all">LUMA vault ${esc(lAddr(c.lumaVault))}<br>XRPL vault ${esc(c.xrplVault)}<br>XRPL issuer ${esc(c.xrplIssuer)}</div>` : ''}`);
}
let estT: any = 0;
function estimate() { clearTimeout(estT); estT = setTimeout(() => estimateNow().catch(() => {}), 250); }
async function estimateNow() {
  const el = $('br_est');
  if (!el) return;
  const c = bcfg(), ln = laneOf(), out = ST.dir === 'out', r = rules(ln.asset), amt = parseFloat((($('br_amt') as HTMLInputElement) || { value: '' }).value), from = out ? ln.luma : ln.xrpl, to = out ? ln.xrpl : ln.luma;
  const dst = (($('br_dst') as HTMLInputElement) || { value: '' }).value.trim(), srcX = (($('br_xw') as HTMLSelectElement) || { value: '' }).value;
  const rows: string[] = [], problems: string[] = [], act: string[] = [];
  const row = (k: string, v: string) => rows.push(`<div class="row" style="justify-content:space-between;font-size:.84rem"><span class="mut">${k}</span><span>${v}</span></div>`);
  const have = out ? lumaBal(from) : xrplBal(srcX, from);
  row('Your balance', `${fmt(have, 6)} ${esc(from)}${withUsd(ln.asset, have)}`);
  if (amt > 0) {
    const p = price(ln.asset, amt);
    row('Fee', `${fmt(p.fee, 6)} ${esc(from)}${withUsd(ln.asset, p.fee)}`);
    row('You send', `${fmt(amt, 6)} ${esc(from)}${withUsd(ln.asset, amt)}`); row('You receive about', `<b>${fmt(p.net, 6)} ${esc(to)}</b>${withUsd(ln.asset, p.net)}`); if (pxOf(ln.asset) == null) row('Dollar value', '<span class="mut">no market price yet for ' + esc(ln.asset === 'USD' ? 'USD' : ln.xrpl) + ': it moves 1:1 minus the fee, same amount on both sides</span>'); else row('Value kept', `<span class="mut">${fUsd(usdOf(ln.asset, p.net))} of ${fUsd(usdOf(ln.asset, amt))} (the fee is the difference)</span>`);
    row('Left in your wallet', `${fmt(Math.max(0, have - amt), 6)} ${esc(from)}${withUsd(ln.asset, Math.max(0, have - amt))}`);
    if (amt > have) problems.push(`You only have ${fmt(have, 6)} ${from}.`);
    if (amt < r.min) problems.push(`Below the minimum of ${fmt(r.min, 4)} ${from}.`);
    if (amt > r.max) problems.push(`Above the per-transfer maximum of ${fmt(r.max, 4)} ${from}.`);
    if (p.net <= 0) problems.push('Too small to cover the fee.');
    if (out && from === ctx.native() && have - amt < 0.3) problems.push(`Keep about 0.3 ${ctx.native()} for fees and reserve.`);
    // vault liquidity for the payout side
    const rep = (ST.rep || []).find((z: any) => z.lane.id === ln.id);
    if (rep && rep.payout != null) { if (out && ln.id === 'xrp' && p.net > rep.payout) problems.push(`The XRPL vault can only pay ${fmt(rep.payout, 4)} XRP right now; the transfer would wait for liquidity.`); if (!out && ln.id === 'luma' && p.net > rep.payout) problems.push(`The LUMA vault can only pay ${fmt(rep.payout, 4)} ${ctx.native()} right now.`); if (!out && ln.id === 'usd' && p.net > rep.payout && false) problems.push(''); }
  }
  // destination checks
  if (out) {
    const [addr] = dst.replace(/^xrpl:/i, '').split(':');
    if (!addr) problems.push('Enter your XRPL destination.');
    else if (!xrpl.isValidClassicAddress(addr)) problems.push('The XRPL destination must be an r… address.');
    else {
      const ai = await xtry('account_info', { account: addr, ledger_index: 'validated' });
      if (!ai || !ai.account_data) problems.push(`${short(addr, 6, 5)} is not activated on that XRPL (needs its XRP reserve first${ln.id === 'xrp' ? '; the received XRP must cover it' : ''}).`);
      else if (ln.id !== 'xrp') {
        const issuer = xIss(ln, c);
        if (issuer) { const al = await xtry('account_lines', { account: addr, peer: issuer, ledger_index: 'validated' }); const ok = ((al && al.lines) || []).some((l: any) => sameCur(l.currency, ln.xrpl) && Number(l.limit) > 0); if (!ok) { problems.push(`${short(addr, 6, 5)} has no ${ln.xrpl} trust line yet: the payout waits until it does.`); if (xrplWallets().some(w => w.address === addr)) act.push(`<button class="sm pri" onclick="window.br.trust('x','${esc(addr)}',this)">Add ${esc(ln.xrpl)} trust line on XRPL</button>`); } else row('Destination', `<span class="up">✓ ready to receive ${esc(ln.xrpl)}</span>`); }
      } else row('Destination', '<span class="up">✓ activated</span>');
    }
  } else {
    if (!dst) problems.push('Enter your LUMA destination.');
    else {
      let d = '';
      try { d = ctx.toClassic(dst); } catch { problems.push('That is not a valid LUMA address.'); }
      if (d && ln.id !== 'luma') {
        const iss = await lumaIss(ln);
        const al = d ? await tryReq('account_lines', { account: d, ledger_index: 'validated', limit: 300 }) : null;
        if (!al) problems.push('That LUMA account is not active on this network yet.');
        else if (iss && !(al.lines || []).some((l: any) => l.account === iss && hexName(l.currency) === ln.luma)) { problems.push(`That LUMA account has no ${ln.luma} trust line yet: the payout waits until it does.`); if (d === ctx.account()) act.push(`<button class="sm pri" onclick="window.br.trust('l','${esc(iss)}',this)">Add ${esc(ln.luma)} trust line on LUMA</button>`); } else row('Destination', `<span class="up">✓ ready to receive ${esc(ln.luma)}</span>`);
      }
    }
    if (srcX && c.xrplVault && srcX === c.xrplVault) row('Heads up', '<span class="mut">This is the bridge vault itself, so your tokens stay in it on XRPL (the balance does not drop) while the same amount is credited on LUMA, backed by what the vault holds. Use a different XRPL wallet as the sender for a normal one-way move.</span>');
    if (!srcX) problems.push('Pick an XRPL wallet (Wallets → switch to XRPL → import seed).');
    else if (!(ST.bal.X[srcX] || {}).ok) problems.push('That XRPL wallet is not activated yet (send it some XRP first).');
  }
  if (!c.lumaVault || !c.xrplVault) problems.push('Bridge settings are incomplete (see Bridge settings).');
  if (c.lumaVault && (mineLuma().has(ctx.toClassic(c.lumaVault)))) problems.push('The LUMA vault is your own wallet: fix the settings first.');
  const o = OP.snap;
  if (o && o.set && !o.enabled) problems.push('The operator has not ENABLED the bridge yet (control panel → XRPL Bridge → Enable). Deposits are recorded but nothing is paid out until it is on.');
  else if (o && o.set && o.paused) problems.push('The bridge is PAUSED on the operator’s panel, so nothing is paid out. Press Resume there (it pauses itself when the network is switched).');
  if (o && o.set && o.assets && ln.asset && o.assets[ln.asset] && o.assets[ln.asset].on === false) problems.push(ln.asset + ' transfers are switched off on the operator’s bridge.');
  if (o && o.set && (!o.running || !o.alive)) problems.push('The operator’s relayer is not running: you could send, but nothing would be paid out until it is.');
  ST.block = problems.length;
  el.innerHTML = rows.join('') + (problems.length ? `<div style="margin-top:.4rem">${problems.filter(Boolean).map(p => `<div style="font-size:.8rem;color:#ffc400">! ${esc(p)}</div>`).join('')}</div>` : amt > 0 ? '<div style="font-size:.8rem;color:#00ff8c;margin-top:.4rem">✓ Everything needed is in place.</div>' : '') + (act.length ? `<div class="row" style="gap:.4rem;margin-top:.4rem">${act.join('')}</div>` : '');
}
async function history(g: number) {
  const c = bcfg(), acc = ctx.account(), rows: { ms: number; html: string }[] = [];
  const memoOf = (t: any) => (t.Memos || []).map((mm: any) => { try { return decodeURIComponent(((mm.Memo || {}).MemoData || '').replace(/../g, '%$&')); } catch { return ''; } }).join(' ');
  if (acc && c.lumaVault) {
    const v = ctx.toClassic(c.lumaVault);
    const r: any = await tryReq('account_tx', { account: acc, limit: 200, ledger_index_min: -1, ledger_index_max: -1 });
    for (const x of (r && r.transactions) || []) {
      const t = x.tx || x.tx_json || {}, m = x.meta || x.metaData || {};
      if (t.TransactionType !== 'Payment') continue;
      const toV = t.Destination === v && t.Account === acc, fromV = t.Account === v && t.Destination === acc;
      if (!toV && !fromV) continue;
      const amt = m.delivered_amount || t.Amount, a = typeof amt === 'string' ? `${fmt(Number(amt) / 1e6, 6)} ${ctx.native()}` : `${fmt(Number(amt.value), 6)} ${hexName(amt.currency)}`;
      const ms = t.date ? rippleToMs(t.date) : 0;
      rows.push({ ms, html: `<tr><td class="mut">${ms ? ago(Date.now() - ms) : ''}</td><td>LUMA</td><td>${toV ? '<b class="dn">Sent to bridge</b>' : '<b class="up">Received from bridge</b>'}</td><td class="r">${esc(a)}</td><td class="mono mut">${esc(memoOf(t))}</td><td class="${m.TransactionResult === 'tesSUCCESS' ? 'up' : 'dn'}">${m.TransactionResult === 'tesSUCCESS' ? '✓' : esc(m.TransactionResult || '')}</td></tr>` });
    }
  }
  for (const w of xrplWallets()) {
    if (!c.xrplVault) break;
    const r = await xtry('account_tx', { account: w.address, limit: 100 });
    for (const x of (r && r.transactions) || []) {
      const t = x.tx_json || x.tx || {}, m = x.meta || {};
      if (t.TransactionType !== 'Payment') continue;
      const toV = t.Account === w.address && (t.Destination === c.xrplVault || t.Destination === c.xrplIssuer), fromV = t.Destination === w.address && (t.Account === c.xrplVault || t.Account === c.xrplIssuer);
      if (!toV && !fromV) continue;
      const amt = m.delivered_amount || t.Amount, a = typeof amt === 'string' ? `${fmt(Number(amt) / 1e6, 6)} XRP` : `${fmt(Number(amt.value), 6)} ${hexName(amt.currency)}`;
      const ms = t.date ? rippleToMs(t.date) : 0;
      rows.push({ ms, html: `<tr><td class="mut">${ms ? ago(Date.now() - ms) : ''}</td><td>XRPL</td><td>${toV ? '<b class="dn">Sent to bridge</b>' : '<b class="up">Received from bridge</b>'}</td><td class="r">${esc(a)}</td><td class="mono mut">${esc(memoOf(t))}</td><td class="${m.TransactionResult === 'tesSUCCESS' ? 'up' : 'dn'}">${m.TransactionResult === 'tesSUCCESS' ? '✓' : esc(m.TransactionResult || '')}</td></tr>` });
    }
  }
  rows.sort((a, b) => b.ms - a.ms);
  if (g !== gen) return;
  const lastSent = rows.find(r => /Sent to bridge/.test(r.html)), lastRecv = rows.find(r => /Received from bridge/.test(r.html));
  const waiting = lastSent && (!lastRecv || lastRecv.ms < lastSent.ms) && Date.now() - lastSent.ms < 15 * 60e3;
  setHtml('br_hist', rows.length ? `${waiting ? '<div style="font-size:.82rem;color:#ffc400;margin-bottom:.4rem">Your latest transfer was sent and no payout has been seen yet. That is normal for a minute or two; if it stays like this, check the checklist above (relayer, trust line).</div>' : ''}<table class="dxt"><thead><tr><th>When</th><th>Ledger</th><th>Type</th><th class="r">Amount</th><th>Memo</th><th>Result</th></tr></thead><tbody>${rows.slice(0, 50).map(r => r.html).join('')}</tbody></table>` : '<div class="mut" style="padding:1rem">No transfers with the bridge from your wallets yet.</div>');
}

/* ---------------------------------- lifecycle ---------------------------------- */

/* ---------------------------------- NFT bridge ---------------------------------- */
const NB: any = { feed: null, err: '', x: [], l: [], act: [], est: null, estFor: '', msg: '', busy: false, xw: '', loaded: false };
const nbBase = () => (OP.url || bcfg().opUrl || '').replace(/\/$/, '');
async function nbFetch(path: string, body?: any): Promise<any> {
  const base = nbBase(); if (!base) throw new Error('Link the operator first (Bridge settings → Load from operator).');
  let r: Response; try { r = await fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body), cache: 'no-store' } : { cache: 'no-store' }); } catch { throw new Error('Cannot reach the operator at ' + base); }
  const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { throw new Error('The operator answered with a web page: update and restart its control panel to get the NFT bridge.'); }
  if (!r.ok || j.error) throw new Error(j.error || 'The operator answered ' + r.status);
  return j;
}
const nbName = (id: string) => { const a = (NB.act || []).find((i: any) => i.lumaId === id || i.xrplId === id); return a && a.name ? a.name : ''; };
const nbMemo = (txt: string) => [{ Memo: { MemoType: hex(MEMO_TYPE), MemoData: hex(txt) } }];
async function nbLoad(light?: boolean) {
  try {
    NB.feed = await nbFetch('/api/public/nftbridge'); NB.err = '';
    const addrs: string[] = []; if (ctx.account()) addrs.push(ctx.showL(ctx.account() as string)); for (const w of xrplWallets()) addrs.push(w.address);
    const all: any[] = []; for (const a of addrs) { try { const r = await nbFetch('/api/public/nftbridge/activity?addr=' + encodeURIComponent(a)); for (const i of r.items) if (!all.find(z => z.id === i.id)) all.push(i); } catch {} }
    NB.act = all.sort((a, b) => b.upd - a.upd);
    if (!light && NB.feed.set) {
      const sel = ($('nb_xw') as HTMLSelectElement | null); NB.xw = (sel && sel.value) || NB.xw || (xrplWallets()[0] || { address: '' }).address;
      NB.xErr = ''; if (NB.xw) { const r: any = await xtry('account_nfts', { account: NB.xw, limit: 400 }); if (!r) { NB.xErr = 'Could not read this wallet from the XRPL node: it may be busy (press Refresh), or the wallet is not activated yet (it has never received XRP).'; NB.x = NB.x || []; } else if (r.error) { NB.xErr = r.error === 'actNotFound' ? 'This XRPL wallet is not activated yet (it has never received XRP).' : 'The XRPL node said: ' + r.error; NB.x = []; } else NB.x = r.account_nfts || []; } else NB.x = [];
      const lv = NB.feed.lumaVault ? ctx.toClassic(NB.feed.lumaVault) : '', acc = ctx.account();
      NB.l = acc && lv ? (((await tryReq('account_nfts', { account: acc, limit: 400 })) || {}).account_nfts || []).filter((n: any) => n.Issuer === lv) : [];
    }
    NB.loaded = true;
  } catch (e: any) { NB.err = String(e?.message || e); }
  paintNft();
}
const nbStateCol = (s: string) => s === 'done' || s === 'offered' || s === 'refunded' ? 'up' : /fail|reject/.test(s) ? 'dn' : /attention|approval|limit|storage|inactive/.test(s) ? 'warnc' : '';
function paintNft() {
  const f = NB.feed;
  if (!$('br_nft')) return;
  if (!nbBase()) { setHtml('br_nft', `<div class="k" style="margin:0">NFT bridge</div><div class="mut" style="margin-top:.4rem">Link the operator above to use the NFT bridge.</div>`); return; }
  if (NB.err && !f) { setHtml('br_nft', `<div class="k" style="margin:0">NFT bridge</div><div class="dn" style="margin-top:.4rem">${esc(NB.err)}</div>`); return; }
  if (!f) { setHtml('br_nft', `<div class="k" style="margin:0">NFT bridge</div><div class="mut" style="margin-top:.4rem">Reading the operator…</div>`); return; }
  if (!f.set || !f.on) { setHtml('br_nft', `<div class="row" style="justify-content:space-between"><div class="k" style="margin:0">NFT bridge · XRPL ⇄ LUMA</div><button class="sm ghost" onclick="window.br.nbLoad()">Refresh</button></div><div class="mut" style="margin-top:.5rem">${!f.set ? 'The operator has not set up the bridge vaults yet.' : 'The operator has not switched the NFT bridge on yet (control panel → Bridge → NFT bridge → Switch on).'}</div>`); return; }
  const xw = xrplWallets();
  const xrow = (n: any) => { const uri = (() => { try { return new TextDecoder().decode(Uint8Array.from((n.URI || '').match(/../g) || [], (x: string) => parseInt(x, 16))); } catch { return ''; } })(); return `<tr><td class="mono" style="font-size:.72rem">${esc(short(n.NFTokenID, 8, 6))}<div class="mut" style="font-family:inherit">${esc(uri.slice(0, 44) || 'no URI')}</div></td><td>${(n.Flags & 8) ? '<span class="mut">transferable</span>' : '<span class="warnc">not transferable</span>'}</td><td style="text-align:right"><button class="sm ghost" onclick="window.br.nbEst('in','${esc(n.NFTokenID)}')">Check</button> <button class="sm pri" onclick="window.br.nbSend('in','${esc(n.NFTokenID)}')">Bridge to LUMA</button></td></tr>`; };
  const lrow = (n: any) => `<tr><td><b>${esc(nbName(n.NFTokenID) || 'Wrapped NFT')}</b><div class="mono mut" style="font-size:.72rem">${esc(short(n.NFTokenID, 8, 6))}</div></td><td><span class="mut">wrapped copy</span></td><td style="text-align:right"><button class="sm ghost" onclick="window.br.nbEst('out','${esc(n.NFTokenID)}')">Check</button> <button class="sm pri" onclick="window.br.nbSend('out','${esc(n.NFTokenID)}')">Send back to XRPL</button></td></tr>`;
  const e = NB.est, estHtml = e ? `<div class="card" style="margin-top:.7rem;background:rgba(0,255,140,.04);border:1px solid rgba(0,255,140,.25)"><div class="k" style="margin:0">Before you send${e.meta ? ' · ' + esc(e.meta.name) : e.nft && e.nft.name ? ' · ' + esc(e.nft.name) : ''}</div>
    ${e.meta ? `<div style="margin:.3rem 0;font-size:.85rem">${e.meta.collection ? 'Collection <b>' + esc(e.meta.collection) + '</b> · ' : ''}${e.meta.attrs.length} trait${e.meta.attrs.length === 1 ? '' : 's'}${e.image ? ' · image ' + (e.image.bytes >= 1048576 ? (e.image.bytes / 1048576).toFixed(2) + ' MB' : (e.image.bytes / 1024).toFixed(1) + ' KB') + ' (' + esc(e.image.type) + ') will be copied to the LUMA network' : ''}</div>` : ''}
    ${e.seconds ? `<div style="font-size:.85rem">Time: about <b>${e.seconds.typical}s</b> (${e.seconds.min}–${e.seconds.max}s)${e.costs ? ' · ' + esc(e.costs.xrplFees) : ''}</div>` : ''}
    ${(e.problems || []).map((p: string) => `<div class="dn" style="font-size:.84rem">✗ ${esc(p)}</div>`).join('')}${(e.notes || []).map((p: string) => `<div class="mut" style="font-size:.8rem">• ${esc(p)}</div>`).join('')}
    ${e.ok ? '<div class="up" style="font-size:.84rem;margin-top:.2rem">✓ Ready to send</div>' : ''}
    <details style="margin-top:.3rem"><summary class="mut" style="cursor:pointer;font-size:.78rem">What happens, step by step</summary><ol style="font-size:.8rem;margin:.3rem 0 0 1.1rem;padding:0">${(e.steps || []).map((x: string) => `<li>${esc(x.replace(/^\d+\.\s*/, ''))}</li>`).join('')}</ol></details></div>` : '';
  const arow = (i: any) => { const mineL = ctx.account() && i.dest && (() => { try { return ctx.toClassic(i.dest) === ctx.account(); } catch { return false; } })(); const xwal = xw.find(w => w.address === i.dest);
    const btn = i.dir === 'in' && i.state === 'offered' && i.lumaOffer && mineL ? `<button class="sm pri" onclick="window.br.nbAccept('${esc(i.lumaOffer)}')">Accept the copy</button>` : i.dir === 'out' && i.xrplOffer && ['done', 'released'].includes(i.state) && xwal ? `<button class="sm pri" onclick="window.br.nbAcceptX('${esc(i.xrplOffer)}','${esc(xwal.address)}')">Accept the original</button>` : '';
    return `<tr style="vertical-align:top"><td class="mut" style="white-space:nowrap">${esc(new Date(i.upd).toLocaleString())}</td><td>${i.dir === 'in' ? 'XRPL → LUMA' : 'LUMA → XRPL'}</td><td><b>${esc(i.name || '–')}</b>${i.collection ? `<div class="mut">${esc(i.collection)}</div>` : ''}</td><td class="${nbStateCol(i.state)}"><b>${esc(i.state)}</b></td><td style="max-width:22rem">${esc(((i.events || []).slice(-1)[0] || {}).m || '')}${i.err && !['done', 'offered'].includes(i.state) ? `<div class="dn">${esc(i.err)}</div>` : ''}<details><summary class="mut" style="cursor:pointer;font-size:.72rem">history</summary>${(i.events || []).map((v: any) => `<div class="mut" style="font-size:.7rem">${esc(new Date(v.t).toLocaleTimeString())} <b>${esc(v.s)}</b> ${esc(v.m)}</div>`).join('')}${i.image ? `<div class="mono mut" style="font-size:.66rem">image ${esc(i.image)}</div>` : ''}</details></td><td style="text-align:right">${btn}</td></tr>`; };
  setHtml('br_nft', `<div class="row" style="justify-content:space-between;gap:.6rem;flex-wrap:wrap"><div><div class="row" style="gap:.6rem;align-items:center"><div class="k" style="margin:0">NFT bridge · XRPL ⇄ LUMA</div><button class="sm pri acc" onclick="window.nbw.start()">✨ NFT bridge wizard</button></div><div class="mut" style="font-size:.8rem;max-width:44rem;margin-top:.25rem">The original is ${f.mode === 'burn' ? '<b class="dn">burned on XRPL</b> (it can never come back)' : '<b>locked</b> in the bridge vault (it comes back when you send the copy back)'}. Name, collection, traits and the image are copied to this network and the copy is minted for you. ${f.approveAll ? 'The operator approves each NFT by hand. ' : ''}${f.running ? '<span class="up">Validator running</span>' : '<span class="dn">Validator not running</span>'} · ${f.usedToday}/${f.perDay} used today</div></div><button class="sm ghost" onclick="window.br.nbLoad()">Refresh</button></div>
    <div class="grid" style="margin-top:.8rem"><div class="card c6"><div class="k">From XRPL → LUMA</div>${xw.length ? `<select id="nb_xw" class="grow" onchange="window.br.nbLoad()">${xw.map(w => `<option value="${esc(w.address)}" ${w.address === NB.xw ? 'selected' : ''}>${esc(w.label)} · ${esc(short(w.address, 6, 5))}</option>`).join('')}</select>` : '<div class="mut">Import an XRPL wallet first (Wallets → XRPL mode → import seed).</div>'}
      <div class="mut" style="font-size:.76rem;margin:.4rem 0">The copy goes to your selected LUMA wallet: <b>${ctx.account() ? esc(short(ctx.showL(ctx.account() as string), 8, 6)) : 'none selected'}</b>. It arrives as an offer you accept below.</div>
      <div style="overflow:auto;max-height:18rem"><table class="hxt" style="width:100%;font-size:.8rem"><tbody>${NB.x.length ? NB.x.map(xrow).join('') : `<tr><td style="padding:.6rem">${NB.xErr ? `<span class="dn">${esc(NB.xErr)}</span>` : '<span class="mut">This XRPL wallet holds no NFTs.</span>'}<div class="mut" style="font-size:.78rem;margin-top:.4rem">Wallet checked: <span class="mono">${esc(NB.xw || 'none')}</span><br>Is your NFT in a different XRPL wallet (for example the rphatR… one)? Paste its seed to add it here:</div><div class="row" style="gap:.4rem;margin-top:.3rem"><input id="nb_seed" type="password" placeholder="XRPL seed (s…)" class="grow"><button class="sm pri" onclick="window.br.nbImport()">Add wallet</button></div></td></tr>`}</tbody></table></div></div>
    <div class="card c6"><div class="k">From LUMA → XRPL (wrapped copies)</div><div class="mut" style="font-size:.76rem;margin:.2rem 0 .4rem">Only copies made by this bridge can go back. The original is offered to your XRPL wallet <b>${esc(short(NB.xw || '', 6, 5))}</b>.</div>
      <div style="overflow:auto;max-height:18rem"><table class="hxt" style="width:100%;font-size:.8rem"><tbody>${NB.l.length ? NB.l.map(lrow).join('') : '<tr><td class="mut" style="padding:.6rem">No wrapped NFTs in this LUMA wallet.</td></tr>'}</tbody></table></div></div></div>
    ${estHtml}<div id="nb_msg" class="mut" style="font-size:.82rem;margin-top:.5rem">${esc(NB.msg)}</div>
    <div class="k" style="margin-top:1rem">Your NFT bridge activity</div><div style="overflow:auto"><table class="hxt" style="width:100%;font-size:.8rem"><thead><tr><th>Time</th><th>Way</th><th>NFT</th><th>State</th><th>Latest</th><th></th></tr></thead><tbody>${NB.act.length ? NB.act.map(arow).join('') : '<tr><td colspan="6" class="mut" style="padding:.7rem">Nothing bridged yet.</td></tr>'}</tbody></table></div>`);
}
const nbSay = (m: string) => { NB.msg = m; const e = $('nb_msg'); if (e) e.textContent = m; };
const nbDest = (dir: string) => dir === 'in' ? (ctx.account() ? ctx.showL(ctx.account() as string) : '') : NB.xw;
const nbApi = {
  nbLoad() { nbLoad(); },
  async nbImport() { try { const sd = (($('nb_seed') as HTMLInputElement) || { value: '' }).value; const a = await (window as any).importXrplSeed(sd); NB.xw = a; const e = $('nb_seed') as HTMLInputElement | null; if (e) e.value = ''; ctx.toast('✓ XRPL wallet added'); await nbLoad(); } catch (e: any) { ctx.toast(String(e?.message || e), true); } },
  async nbEst(dir: string, id: string) { try { nbSay('Checking…'); NB.est = await nbFetch('/api/public/nftbridge/estimate', { dir, id, owner: NB.xw, dest: nbDest(dir) }); NB.estFor = id; nbSay(''); } catch (e: any) { NB.est = null; nbSay(String(e?.message || e)); } paintNft(); },
  async nbSend(dir: string, id: string) {
    if (NB.busy) return; NB.busy = true;
    try {
      const f = NB.feed; if (!f || !f.set || !f.on) throw new Error('The NFT bridge is not on.');
      nbSay('Checking…'); const e = await nbFetch('/api/public/nftbridge/estimate', { dir, id, owner: NB.xw, dest: nbDest(dir) }); NB.est = e; paintNft();
      if (!e.ok) throw new Error('Not sent: ' + (e.problems || []).join(' '));
      const nm = (e.meta && e.meta.name) || e.nft.name || 'this NFT';
      if (!confirm(dir === 'in' ? `Bridge "${nm}" to LUMA?\n\nYour original goes to the bridge vault (${f.mode === 'burn' ? 'it is BURNED afterwards and can never come back' : 'locked, and it comes back when you send the copy back'}). The copy is minted on LUMA for ${nbDest('in')}.` : `Send "${nm}" back to XRPL?\n\nThe wrapped copy is taken and burned on LUMA, and the original is offered to ${NB.xw} on XRPL.`)) { nbSay(''); NB.busy = false; return; }
      if (dir === 'in') {
        const seed = xrplSeedOf(NB.xw); if (!seed) throw new Error('That XRPL wallet is not in this app.');
        const cl = await xclient(), wal = xrpl.Wallet.fromSeed(seed);
        nbSay('Making the offer on XRPL…');
        const p = await cl.autofill({ TransactionType: 'NFTokenCreateOffer', Account: wal.address, NFTokenID: id, Amount: '0', Flags: 1, Destination: f.xrplVault, Memos: nbMemo('luma:' + nbDest('in')) } as any);
        const res: any = await cl.submitAndWait(wal.sign(p).tx_blob); if (res.result.meta?.TransactionResult !== 'tesSUCCESS') throw new Error('XRPL rejected the offer: ' + res.result.meta?.TransactionResult);
        nbSay('Offer made. Telling the validator…'); await nbFetch('/api/public/nftbridge/announce', { dir: 'in', tx: res.result.hash });
      } else {
        if (!ctx.account()) throw new Error('Select a LUMA wallet first.');
        nbSay('Making the offer on LUMA…');
        const r = await ctx.submit({ TransactionType: 'NFTokenCreateOffer', Account: ctx.account(), NFTokenID: id, Amount: '0', Flags: 1, Destination: ctx.toClassic(f.lumaVault), Memos: nbMemo('xrpl:' + NB.xw) });
        if (!r.ok) throw new Error('LUMA rejected the offer: ' + r.msg);
        nbSay('Offer made. Telling the validator…'); await nbFetch('/api/public/nftbridge/announce', { dir: 'out', tx: r.hash });
      }
      nbSay('Sent. The validator takes it within about ' + (e.seconds ? e.seconds.typical : 30) + ' seconds; follow it in the activity list below.');
      setTimeout(() => nbLoad(), 4000);
    } catch (e: any) { nbSay(String(e?.message || e)); }
    NB.busy = false; paintNft();
  },
  async nbAccept(offer: string) {
    try { nbSay('Accepting on LUMA…'); const r = await ctx.submit({ TransactionType: 'NFTokenAcceptOffer', Account: ctx.account(), NFTokenSellOffer: offer }); if (!r.ok) throw new Error(r.msg || 'rejected'); ctx.toast('✓ NFT received'); nbSay('Received. It is in your NFTs.'); setTimeout(() => nbLoad(), 2500); } catch (e: any) { nbSay('Could not accept: ' + String(e?.message || e) + ' (your LUMA wallet needs a little LUMA for the NFT reserve)'); }
  },
  async nbAcceptX(offer: string, addr: string) {
    try { const seed = xrplSeedOf(addr); if (!seed) throw new Error('That XRPL wallet is not in this app.'); nbSay('Accepting on XRPL…'); const cl = await xclient(), wal = xrpl.Wallet.fromSeed(seed); const p = await cl.autofill({ TransactionType: 'NFTokenAcceptOffer', Account: wal.address, NFTokenSellOffer: offer } as any); const res: any = await cl.submitAndWait(wal.sign(p).tx_blob); if (res.result.meta?.TransactionResult !== 'tesSUCCESS') throw new Error(res.result.meta?.TransactionResult); ctx.toast('✓ Original received on XRPL'); nbSay('Received on XRPL.'); setTimeout(() => nbLoad(), 3000); } catch (e: any) { nbSay('Could not accept: ' + String(e?.message || e) + ' (the XRPL wallet needs XRP for the reserve)'); }
  },
};

let valTimer: any = 0;
export function bridgeMount() {
  bridgeLoad(); setTimeout(() => nbLoad(), 800);
  if (valTimer) clearInterval(valTimer);
  valTimer = setInterval(async () => { if (!$('br')) { clearInterval(valTimer); valTimer = 0; return; } try { await tryOperator(); paintHead(); await nbLoad(true); } catch {} }, 15000);   // keep the validator card live
}
export async function bridgeLoad() {
  const g = ++gen;
  paintHead(); paintSetup(); paintXfer(); paintClaim();
  try {
    await tryOperator();
    if (g !== gen || !$('br')) return;
    { const c0 = bcfg(); if (OP.snap && OP.snap.set && (!c0.lumaVault || !c0.xrplVault)) { try { applyOperator(); ctx.toast('Bridge linked to the operator automatically'); } catch {} } }   // easy setup: nothing to type when the operator is reachable
    { const c1 = bcfg(), w = OP.snap && OP.snap.xrplWs; const isT = (u: string) => /altnet|testnet|devnet/.test(u || ''); const isPub = (u: string) => /xrplcluster|ripple\.com|rippletest|altnet|testnet\.xrpl|xrpl-labs/.test(u || ''); if (w && c1.opUrl && isPub(c1.xrplUrl) && isT(w) !== isT(c1.xrplUrl)) { saveCfg({ ...c1, xrplUrl: w }); ctx.toast('XRPL node switched to ' + (isT(w) ? 'testnet' : 'mainnet') + ' to match the operator'); } }   // never look for a mainnet wallet on testnet
    paintHead(); paintClaim();
    await loadBalances();
    if (g !== gen || !$('br')) return;
    ST.chk = await runChecks();
    if (g !== gen || !$('br')) return;
    paintSetup(); paintChecks(); paintXfer();
    await reserves();
    if (g !== gen || !$('br')) return;
    paintRep(); estimate();
    await history(g);
  } catch (e: any) {
    setHtml('br_chk', `<div class="k">Bridge checklist</div><div class="dn" style="padding:.6rem">${esc(e?.message || e)}</div>`);
  }
}
const xrplSeedOf = (addr: string) => { const w = xrplWallets().find(x => x.address === addr); return w ? w.seed : ''; };
export const brApi = {
  ...nbApi,
  refresh() { bridgeLoad(); },
  dir(d: string) { ST.dir = d; paintXfer(); paintClaim(); },
  lane(l: string) { ST.lane = l; paintXfer(); paintClaim(); },
  est() { estimate(); },
  max() {
    const ln = laneOf(), out = ST.dir === 'out', from = out ? ln.luma : ln.xrpl, srcX = (($('br_xw') as HTMLSelectElement) || { value: '' }).value;
    let b = out ? lumaBal(from) : xrplBal(srcX, from);
    if (out && from === ctx.native()) b = Math.max(0, b - 0.3);
    if (!out && from === 'XRP') b = Math.max(0, b - 1.5 - 0.2 * ((ST.bal.X[srcX] || {}).owners || 0));
    const a = $('br_amt') as HTMLInputElement; if (a) a.value = String(Math.floor(b * 1e6) / 1e6);
    estimate();
  },
  async loadOp(btn: HTMLButtonElement) {
    const msg = $('br_cmsg'), u = (($('br_op') as HTMLInputElement).value || '').trim();
    try {
      if (!/^https?:\/\//i.test(u)) throw new Error('Enter the control panel address starting with http:// or https://');
      btn.disabled = true;
      const j = await loadOperator(u);
      OP.snap = j; OP.url = u; OP.err = ''; OP.at = Date.now();
      saveCfg({ ...bcfg(), opUrl: u });
      if (msg) msg.textContent = applyOperator();
      bridgeLoad();
    } catch (e: any) { if (msg) msg.textContent = String(e?.message || e) + ' (reach the panel through an SSH tunnel or Tailscale if it is on another machine)'; }
    btn.disabled = false;
  },
  save() {
    const v = (id: string) => (($(id) as HTMLInputElement).value || '').trim(), msg = $('br_cmsg');
    try {
      const o: BCfg = { lumaVault: v('br_lv') ? ctx.toClassic(v('br_lv')) : '', xrplVault: v('br_xv'), xrplUrl: v('br_xu') || defWs(), xrplIssuer: '', opUrl: bcfg().opUrl };
      if (o.lumaVault && (mineLuma().has(o.lumaVault) || o.lumaVault === ctx.account())) throw new Error('That LUMA vault is one of YOUR wallets. The vault is a separate account made by the operator (BRIDGE VAULT (LUMA) on the control panel). Sending to yourself fails with temREDUNDANT.');
      if (o.xrplVault && !xrpl.isValidClassicAddress(o.xrplVault)) throw new Error('The XRPL vault must be a classic r… address');
      if (o.xrplIssuer && !xrpl.isValidClassicAddress(o.xrplIssuer)) throw new Error('The XRPL issuer must be a classic r… address');
      const tl: any = (OP.snap && OP.snap.tokenLanes) || {}; if (o.xrplIssuer && (o.xrplIssuer === TOKEN_ISSUER || Object.values(tl).some((t: any) => t.xrplIssuer === o.xrplIssuer))) throw new Error('That address is the issuer of MINT and MAGIC on XRPL. This box needs the bridge\'s OWN issuer for LUMAX (the operator shows it on the control panel Bridge page; “Load from operator” fills it in). MINT and MAGIC issuers are used automatically.');
      if (o.xrplVault && o.xrplVault === o.xrplIssuer) throw new Error('The XRPL vault and the issuer are different accounts');
      if (!/^wss?:\/\//.test(o.xrplUrl)) throw new Error('The XRPL node must start with wss://');
      saveCfg(o);
      if (msg) msg.textContent = 'Saved.';
      bridgeLoad();
    } catch (e: any) { if (msg) msg.textContent = String(e?.message || e); }
  },
  async trust(side: string, target: string, btn: HTMLButtonElement) {
    const ln = laneOf(), c = bcfg();
    btn.disabled = true;
    try {
      if (side === 'l') {
        const r = await ctx.submit({ TransactionType: 'TrustSet', Account: ctx.account(), LimitAmount: { currency: nameToCur(ln.luma), issuer: target, value: '1000000000' } });
        if (!r.ok) throw new Error(r.msg || 'rejected');
        ctx.toast('✓ Trust line added');
      } else {
        const seed = xrplSeedOf(target); if (!seed) throw new Error('That XRPL wallet is not in this app.');
        const issuer = xIss(ln, c);
        if (!issuer) throw new Error('The issuer is not known yet: load settings from the operator.');
        const cl = await xclient(), wal = xrpl.Wallet.fromSeed(seed);
        const p = await cl.autofill({ TransactionType: 'TrustSet', Account: wal.address, LimitAmount: { currency: curHex(ln.xrpl), issuer, value: '1000000000' } } as any);
        const res: any = await cl.submitAndWait(wal.sign(p).tx_blob);
        if (res.result.meta?.TransactionResult !== 'tesSUCCESS') throw new Error('XRPL rejected it: ' + res.result.meta?.TransactionResult);
        ctx.toast('✓ Trust line added on XRPL');
      }
      bridgeLoad();
    } catch (e: any) { ctx.toast(String(e?.message || e), true); btn.disabled = false; }
  },
  async send(btn: HTMLButtonElement) {
    const c = bcfg(), ln = laneOf(), out = ST.dir === 'out', msg = $('br_msg'), say = (t: string) => msg && (msg.textContent = t);
    let fl: ReturnType<typeof flowModal> | null = null;
    try {
      await estimateNow();
      if (ST.block && !confirm('Some checks above are not satisfied. Send anyway? The payout may wait or fail, and nothing is refunded automatically.')) return;
      const amt = parseFloat((($('br_amt') as HTMLInputElement).value || ''));
      if (!(amt > 0)) throw new Error('Enter an amount.');
      const dst = (($('br_dst') as HTMLInputElement).value || '').trim();
      btn.disabled = true;
      const pr = price(ln.asset, amt), fromNet = out ? 'LUMA' : 'XRP Ledger', toNet = out ? 'XRP Ledger' : 'LUMA';
      const srcX = (($('br_xw') as HTMLSelectElement) || { value: '' }).value;
      const fromWallet = out ? ctx.showL(ctx.account() || '') : srcX, toWallet = out ? dst.replace(/^xrpl:/i, '') : dst;
      fl = flowModal({ title: `${ln.xrpl === ln.luma || ln.id === 'usd' ? '' : ''}Bridging ${ln.id === 'usd' ? (out ? 'USD → RLUSD' : 'RLUSD → USD') : `${out ? ln.luma : ln.xrpl} → ${out ? ln.xrpl : ln.luma}`}`,
        rows: [['You send', `${fmt(amt, 6)} ${out ? ln.luma : ln.xrpl} on ${fromNet}`], ['From wallet', `<span class="mono">${esc(short(fromWallet, 10, 8))}</span> (${fromNet})`], ['Bridge fee', `${fmt(pr.fee, 6)} ${out ? ln.luma : ln.xrpl}`], ['You receive about', `<b>${fmt(pr.net, 6)} ${out ? ln.xrpl : ln.luma}</b> on ${toNet}`], ['To wallet', `<span class="mono">${esc(short(toWallet, 10, 8))}</span> (${toNet})`], ['Usual time', '1 to 3 minutes']],
        steps: [`Sign and send on ${fromNet}`, `Validated on ${fromNet}`, 'Bridge confirms and pays out', `Arrives in your ${toNet} wallet`] });
      fl.step(0, 'run'); say('Sending…');
      let srcId = '';
      if (out) {
        if (!ctx.account()) throw new Error('Select a wallet first.');
        if (!c.lumaVault) throw new Error('Save the LUMA vault address first.');
        const v = ctx.toClassic(c.lumaVault);
        if (v === ctx.account() || mineLuma().has(v)) throw new Error('The LUMA vault is your own wallet. Use the operator’s vault address.');
        const [addr, tag] = dst.replace(/^xrpl:/i, '').split(':');
        if (!xrpl.isValidClassicAddress(addr) || (tag != null && !/^\d{1,10}$/.test(tag))) throw new Error('The XRPL destination must be an r… address, optionally followed by :tag');
        let Amount: any;
        if (ln.luma === ctx.native()) Amount = String(Math.round(amt * 1e6));
        else { const iss = await lumaIss(ln); const l = ((ST.bal.L && ST.bal.L.lines) || []).find((z: any) => z.account === iss && hexName(z.currency) === ln.luma); if (!l) throw new Error(`You hold no ${ln.luma} on this wallet.`); Amount = amtTx({ c: l.currency, i: iss } as Asset, amt); }
        const r = await ctx.submit({ TransactionType: 'Payment', Account: ctx.account(), Destination: v, Amount, Memos: [{ Memo: { MemoType: hex(MEMO_TYPE), MemoData: hex('xrpl:' + addr + (tag != null ? ':' + tag : '')) } }] });
        if (!r.ok) throw new Error('Rejected on LUMA: ' + r.msg);
        srcId = 'l:' + (r.hash || ''); fl.step(0, 'ok'); fl.step(1, 'ok', short(r.hash || '', 8, 6));
        say(`Sent. Transaction ${short(r.hash || '', 8, 6)} is validated on LUMA.`);
        fl.step(2, 'run', 'waiting for the bridge to confirm'); await awaitArrival(fl, srcId, 'xrpl', addr);
      } else {
        const from = srcX, seed = xrplSeedOf(from);
        if (!seed) throw new Error('Pick an XRPL wallet (Wallets → XRPL → import seed).');
        if (!c.xrplVault) throw new Error('Save the XRPL vault address first.');
        const d = ctx.toClassic(dst);
        const target = ln.id === 'luma' ? c.xrplIssuer : c.xrplVault;
        if (!target) throw new Error('The XRPL issuer is not set.');
        let Amount: any;
        if (ln.xrpl === 'XRP') Amount = String(Math.round(amt * 1e6));
        else { const issuer = xIss(ln, c); Amount = { currency: curHex(ln.xrpl), issuer, value: String(amt) }; }
        const cl = await xclient(), wal = xrpl.Wallet.fromSeed(seed);
        const self = wal.address === target;   // the vault wallet itself cannot pay itself (temREDUNDANT): sign a deposit note instead
        const tx: any = self
          ? { TransactionType: 'AccountSet', Account: wal.address, Memos: [{ Memo: { MemoType: hex(MEMO_TYPE), MemoData: hex(`self:${ctx.showL(d)}|${ln.xrpl}|${ln.xrpl === 'XRP' ? '' : xIss(ln, c)}|${amt}`) } }] }
          : { TransactionType: 'Payment', Account: wal.address, Destination: target, Amount, Memos: [{ Memo: { MemoType: hex(MEMO_TYPE), MemoData: hex('luma:' + ctx.showL(d)) } }] };
        const p = await cl.autofill(tx);
        const res: any = await Promise.race([cl.submitAndWait(wal.sign(p).tx_blob), new Promise((_, rj) => setTimeout(() => rj(new Error('The XRPL node took over 90 seconds to confirm. The transaction may still validate: check Your bridge activity below before sending again.')), 90000))]);
        const code = res.result.meta?.TransactionResult;
        if (code !== 'tesSUCCESS') throw new Error('Rejected by XRPL: ' + code);
        srcId = 'x:' + (res.result.hash || ''); fl.step(0, 'ok'); fl.step(1, 'ok', short(res.result.hash || '', 8, 6));
        say(`Sent. XRPL transaction ${short(res.result.hash || '', 8, 6)} is validated.${self ? ' (vault wallet: recorded as a deposit note, the tokens stay in the vault)' : ''}`);
        fl.step(2, 'run', 'waiting for the bridge to confirm'); await awaitArrival(fl, srcId, 'luma', d);
      }
      setTimeout(() => bridgeLoad(), 2500);
    } catch (e: any) { say(String(e?.message || e)); if (fl) fl.fail(String(e?.message || e)); }
    btn.disabled = false;
  },
};


// ---- progress modal for a bridge transfer: timer, steps, who sends / receives what and where ----
function flowModal(o: { title: string; rows: [string, string][]; steps: string[] }) {
  document.getElementById('brflow')?.remove();
  const d = document.createElement('div'); d.id = 'brflow';
  d.style.cssText = 'position:fixed;inset:0;background:rgba(3,6,12,.72);z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem';
  d.innerHTML = `<div class="card" style="max-width:34rem;width:100%;max-height:92vh;overflow:auto;background:#0d1117;border:1px solid rgba(0,255,140,.35)">
    <div class="row" style="justify-content:space-between;align-items:center"><b style="font-size:1.05rem">${esc(o.title)}</b><span id="brf_t" class="mono" style="font-size:1.1rem">0:00</span></div>
    <div style="margin:.6rem 0">${o.rows.map(([k, v]) => `<div class="row" style="justify-content:space-between;font-size:.84rem;gap:.8rem"><span class="mut">${k}</span><span style="text-align:right">${v}</span></div>`).join('')}</div>
    <div id="brf_s">${o.steps.map((s, i) => `<div id="brf_s${i}" class="row" style="gap:.55rem;align-items:flex-start;padding:.3rem 0"><span id="brf_i${i}" style="width:1.2rem;text-align:center">○</span><span style="flex:1">${esc(s)}<div id="brf_d${i}" class="mut" style="font-size:.76rem"></div></span></div>`).join('')}</div>
    <div id="brf_m" style="margin:.6rem 0;font-size:.86rem"></div>
    <button id="brf_x" class="sm ghost" style="width:100%">Close (the transfer keeps going in the background)</button></div>`;
  document.body.appendChild(d);
  const t0 = Date.now(), tm = setInterval(() => { const e = $('brf_t'); if (!e) return clearInterval(tm); const s = Math.floor((Date.now() - t0) / 1000); e.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }, 500);
  const close = () => { clearInterval(tm); d.remove(); }; ($('brf_x') as HTMLElement).onclick = close;
  const ic: any = { run: '◐', ok: '✓', bad: '✕', idle: '○' };
  return {
    step(i: number, st: 'run' | 'ok' | 'bad', note = '') { const e = $('brf_i' + i); if (e) { e.textContent = ic[st]; e.style.color = st === 'ok' ? '#00ff8c' : st === 'bad' ? '#ff5a6e' : '#ffd166'; } const n = $('brf_d' + i); if (n && note) n.textContent = note; },
    msg(h: string) { const e = $('brf_m'); if (e) e.innerHTML = h; },
    done(h: string) { clearInterval(tm); const e = $('brf_m'); if (e) e.innerHTML = `<div class="up" style="font-weight:700">${h}</div>`; const x = $('brf_x'); if (x) x.textContent = 'Done'; },
    fail(h: string) { clearInterval(tm); for (let i = 0; i < 8; i++) { const e = $('brf_i' + i); if (e && e.textContent === ic.run) { e.textContent = ic.bad; e.style.color = '#ff5a6e'; } } const e = $('brf_m'); if (e) e.innerHTML = `<div class="dn" style="font-weight:700">Stopped</div><div style="margin-top:.2rem">${esc(h)}</div>`; const x = $('brf_x'); if (x) x.textContent = 'Close'; },
  };
}
const memoText = (t: any) => (t.Memos || []).map((mm: any) => { try { return decodeURIComponent(((mm.Memo || {}).MemoData || '').replace(/../g, '%$&')); } catch { return ''; } }).join(' ');
// poll the destination wallet until the bridge's payout (its memo is the transfer id) shows up
async function awaitArrival(fl: ReturnType<typeof flowModal>, srcId: string, destNet: 'xrpl' | 'luma', destAddr: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < 8 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 4500));
    let txs: any[] = [];
    try { const r: any = destNet === 'xrpl' ? await xtry('account_tx', { account: destAddr, limit: 40 }) : await tryReq('account_tx', { account: ctx.toClassic(destAddr), limit: 40 }); txs = (r && r.transactions) || []; } catch {}
    const hit = txs.find((x: any) => { const t = x.tx || x.tx_json || x; return t.TransactionType === 'Payment' && memoText(t).trim() === srcId; });
    if (hit) { const t = hit.tx || hit.tx_json || hit; fl.step(2, 'ok'); fl.step(3, 'ok', short(t.hash || hit.hash || '', 8, 6)); fl.done(`Done. The payout has arrived on ${destNet === 'xrpl' ? 'the XRP Ledger' : 'LUMA'}.`); setTimeout(() => bridgeLoad(), 500); return; }
    const e = Math.round((Date.now() - t0) / 1000);
    fl.step(2, 'run', e < 60 ? 'waiting for the bridge to confirm (needs a few ledgers)' : 'still waiting: the bridge scans every 15 s; if this takes more than 5 minutes check the operator panel (enabled, not paused)');
    fl.step(3, 'run', 'watching your wallet for the payout');
  }
  fl.msg('<span class="dn">No payout seen after 8 minutes.</span> Your transfer is recorded: check <b>Your bridge activity</b> below, and ask the operator whether the bridge is enabled and running. Nothing is lost: it is paid or refunded once the bridge runs.');
  fl.step(3, 'run', 'timed out waiting');
}


// ---- bridge wizard: one small popup per step, driving the same form and send flow as the page ----
const WZ: any = { step: 0, dir: 'in', lane: 'mint', xw: '', amt: '', dst: '', est: '' };
function wzSync() {
  if (ST.dir !== WZ.dir) ST.dir = WZ.dir; if (ST.lane !== WZ.lane) ST.lane = WZ.lane;
  paintXfer();
  const xw = $('br_xw') as HTMLSelectElement, a = $('br_amt') as HTMLInputElement, d = $('br_dst') as HTMLInputElement;
  if (xw && WZ.dir === 'in' && WZ.xw) xw.value = WZ.xw; if (a) a.value = WZ.amt; if (d) d.value = WZ.dst;
}
async function wzPaint() {
  let m = document.getElementById('brwiz');
  if (!m) { m = document.createElement('div'); m.id = 'brwiz'; m.style.cssText = 'position:fixed;inset:0;background:rgba(3,6,12,.72);z-index:9998;display:flex;align-items:center;justify-content:center;padding:1rem'; document.body.appendChild(m); }
  const L = lanes().filter(l => l.pri <= 1).sort(byPri), ln = L.find(l => l.id === WZ.lane) || L[0]; WZ.lane = ln.id;
  const out = WZ.dir === 'out', from = out ? ln.luma : ln.xrpl, to = out ? ln.xrpl : ln.luma, xw = xrplWallets(), lw = ctx.wallets().filter(w => w.type !== 'xrpl');
  const titles = ['What do you want to move?', 'Which wallet sends it?', 'How much?', 'Where should it go?', 'Review and send'];
  const dots = titles.map((_, i) => `<span style="width:.55rem;height:.55rem;border-radius:50%;display:inline-block;margin:0 .15rem;background:${i <= WZ.step ? '#00ff8c' : '#2a3a33'}"></span>`).join('');
  let body = '', err = '';
  if (WZ.step === 0) {
    body = `<div class="seg" style="margin-bottom:.7rem"><button class="${WZ.dir === 'in' ? 'on' : ''}" onclick="window.brw.set('dir','in')">XRPL → LUMA</button><button class="${out ? 'on' : ''}" onclick="window.brw.set('dir','out')">LUMA → XRPL</button></div>
      <div class="row" style="gap:.4rem;flex-wrap:wrap">${L.map(l => `<button class="${l.id === ln.id ? 'pri acc' : 'ghost'}" onclick="window.brw.set('lane','${l.id}')">${esc(out ? `${l.luma} → ${l.xrpl}` : `${l.xrpl} → ${l.luma}`)}</button>`).join('')}</div>
      <div class="mut" style="margin-top:.7rem;font-size:.84rem">${esc(from)} on ${out ? 'LUMA' : 'the XRP Ledger'} becomes <b>${esc(to)}</b> on ${out ? 'the XRP Ledger' : 'LUMA'}, 1:1 minus a small fee.</div>`;
  } else if (WZ.step === 1) {
    if (out) { const a = ctx.account(); body = `<div class="card" style="background:rgba(0,255,140,.04)"><div class="k">Sending from your selected LUMA wallet</div><div class="mono" style="font-size:.8rem;word-break:break-all">${esc(a ? ctx.showL(a) : 'none selected')}</div><div style="margin-top:.4rem">Balance: <b>${fmt(lumaBal(from), 6)} ${esc(from)}</b></div></div><div class="mut" style="font-size:.78rem;margin-top:.5rem">To use another LUMA wallet, close this, pick it in the wallet picker, then start again.</div>`; }
    else body = xw.length ? `<div class="mut" style="margin-bottom:.4rem">Pick the XRPL wallet that holds your ${esc(from)}. Use a wallet other than the bridge vault if you have one.</div>${xw.map(w => `<label class="row" style="gap:.6rem;padding:.45rem;border:1px solid ${WZ.xw === w.address ? '#00ff8c' : '#2a3a33'};border-radius:.5rem;margin:.3rem 0;cursor:pointer"><input type="radio" name="wzx" ${WZ.xw === w.address ? 'checked' : ''} onchange="window.brw.set('xw','${esc(w.address)}')"><span class="grow"><b>${esc(w.label)}</b><div class="mono mut" style="font-size:.72rem">${esc(short(w.address, 10, 8))}</div></span><b>${fmt(xrplBal(w.address, from), 4)} ${esc(from)}</b></label>`).join('')}` : `<div class="warn">No XRPL wallet in this app yet. Wallets → XRPL → create or import one.</div>`;
  } else if (WZ.step === 2) {
    const have = out ? lumaBal(from) : xrplBal(WZ.xw, from), pr = parseFloat(WZ.amt) > 0 ? price(ln.asset, parseFloat(WZ.amt)) : null;
    body = `<div class="mut" style="margin-bottom:.4rem">Available: <b>${fmt(have, 6)} ${esc(from)}</b></div><div class="row" style="gap:.5rem"><input id="wz_amt" class="grow" inputmode="decimal" placeholder="Amount of ${esc(from)}" value="${esc(WZ.amt)}" oninput="window.brw.amt(this.value)"><button class="ghost" onclick="window.brw.max()">Max</button></div><div id="wz_pr" class="mut" style="margin-top:.6rem;font-size:.86rem">${pr ? `Fee ${fmt(pr.fee, 6)} ${esc(from)} · you receive about <b>${fmt(pr.net, 6)} ${esc(to)}</b>` : 'Enter an amount to see the fee and what arrives.'}</div>`;
  } else if (WZ.step === 3) {
    const mine = out ? xw.map(w => ({ label: w.label, a: w.address })) : lw.map(w => ({ label: w.label, a: ctx.showL(w.address) }));
    body = `<div class="mut" style="margin-bottom:.4rem">Where should your ${esc(to)} arrive on ${out ? 'the XRP Ledger' : 'LUMA'}?</div>${mine.map(w => `<label class="row" style="gap:.6rem;padding:.45rem;border:1px solid ${WZ.dst === w.a ? '#00ff8c' : '#2a3a33'};border-radius:.5rem;margin:.3rem 0;cursor:pointer"><input type="radio" name="wzd" ${WZ.dst === w.a ? 'checked' : ''} onchange="window.brw.set('dst','${esc(w.a)}')"><span class="grow"><b>${esc(w.label)}</b><div class="mono mut" style="font-size:.72rem">${esc(short(w.a, 10, 8))}</div></span></label>`).join('')}<div class="mut" style="margin:.5rem 0 .2rem;font-size:.8rem">or paste any address</div><input id="wz_dst" style="width:100%" placeholder="${out ? 'r… (optional :tag)' : 'L… / T…'}" value="${esc(mine.some(w => w.a === WZ.dst) ? '' : WZ.dst)}" oninput="window.brw.dstText(this.value)">`;
  } else {
    body = `<div id="wz_est" class="brest">${WZ.est || '<span class="mut">Checking…</span>'}</div>`;
  }
  m.innerHTML = `<div class="card" style="max-width:32rem;width:100%;max-height:92vh;overflow:auto;background:#0d1117;border:1px solid rgba(0,255,140,.35)">
    <div class="row" style="justify-content:space-between;align-items:center"><div class="mut" style="font-size:.75rem">STEP ${WZ.step + 1} OF 5</div><div>${dots}</div></div>
    <div style="font-size:1.1rem;font-weight:700;margin:.5rem 0 .8rem">${titles[WZ.step]}</div>${body}<div id="wz_err" class="dn" style="margin-top:.5rem;font-size:.84rem">${err}</div>
    <div class="row" style="justify-content:space-between;margin-top:1rem;gap:.5rem"><button class="ghost" onclick="window.brw.${WZ.step === 0 ? 'close' : 'back'}()">${WZ.step === 0 ? 'Cancel' : 'Back'}</button>${WZ.step < 4 ? `<button class="pri acc" onclick="window.brw.next()">Next</button>` : `<button class="pri acc" onclick="window.brw.go()">Send to the bridge</button>`}</div></div>`;
}
const brw = {
  start() { const L = lanes().filter(l => l.pri <= 1).sort(byPri); Object.assign(WZ, { step: 0, dir: ST.dir === 'out' ? 'out' : 'in', lane: L.some(l => l.id === ST.lane) ? ST.lane : (L[0] || {}).id, xw: WZ.xw || (xrplWallets()[0] || {}).address || '', amt: '', dst: '', est: '' }); wzPaint(); },
  close() { document.getElementById('brwiz')?.remove(); },
  set(k: string, v: string) { WZ[k] = v; if (k === 'dir' || k === 'lane') { WZ.amt = ''; WZ.dst = ''; } wzPaint(); },
  amt(v: string) { WZ.amt = v; const ln = laneOf(), out = WZ.dir === 'out', e = $('wz_pr'), n = parseFloat(v); if (e) { const l = lanes().find(z => z.id === WZ.lane) || ln, pr = n > 0 ? price(l.asset, n) : null; e.innerHTML = pr ? `Fee ${fmt(pr.fee, 6)} ${esc(out ? l.luma : l.xrpl)} · you receive about <b>${fmt(pr.net, 6)} ${esc(out ? l.xrpl : l.luma)}</b>` : 'Enter an amount to see the fee and what arrives.'; } },
  max() { const l = lanes().find(z => z.id === WZ.lane)!, out = WZ.dir === 'out', have = out ? lumaBal(l.luma) : xrplBal(WZ.xw, l.xrpl); WZ.amt = String(Math.max(0, out && l.luma === ctx.native() ? have - 1 : l.xrpl === 'XRP' ? have - 1.5 : have)); wzPaint(); },
  dstText(v: string) { WZ.dst = v.trim(); },
  back() { WZ.step = Math.max(0, WZ.step - 1); wzPaint(); },
  async next() {
    const bad = (t: string) => { const e = document.getElementById('wz_err'); if (e) e.textContent = t; };
    if (WZ.step === 1 && WZ.dir === 'in' && !WZ.xw) return bad('Pick the XRPL wallet to send from.');
    if (WZ.step === 1 && WZ.dir === 'out' && !ctx.account()) return bad('Select a LUMA wallet first.');
    if (WZ.step === 2 && !(parseFloat(WZ.amt) > 0)) return bad('Enter an amount.');
    if (WZ.step === 3 && !WZ.dst) return bad('Pick or paste the destination address.');
    WZ.step++; if (WZ.step === 4) { WZ.est = ''; await wzPaint(); wzSync(); await estimateNow().catch(() => {}); WZ.est = ($('br_est') || { innerHTML: '' }).innerHTML; } wzPaint();
  },
  async go() { wzSync(); const b = $('br_go') as HTMLButtonElement; brw.close(); if (b) await (window as any).br.send(b); },
};
(window as any).brw = brw;


// ---- NFT bridge wizard: pick direction, wallet and NFT, check, send, then follow it until you can accept the result ----
const NW: any = { step: 0, dir: 'in', id: '', est: null, busy: false };
const nwUri = (n: any) => { try { return new TextDecoder().decode(Uint8Array.from((n.URI || '').match(/../g) || [], (x: string) => parseInt(x, 16))); } catch { return ''; } };
async function nwPaint() {
  let m = document.getElementById('nbwiz');
  if (!m) { m = document.createElement('div'); m.id = 'nbwiz'; m.style.cssText = 'position:fixed;inset:0;background:rgba(3,6,12,.72);z-index:9998;display:flex;align-items:center;justify-content:center;padding:1rem'; document.body.appendChild(m); }
  const f = NB.feed, xw = xrplWallets(), inn = NW.dir === 'in', titles = ['Which way?', inn ? 'Which XRPL NFT?' : 'Which wrapped NFT?', 'Where will it arrive?', 'Check', 'Send'];
  const dots = titles.map((_, i) => `<span style="width:.55rem;height:.55rem;border-radius:50%;display:inline-block;margin:0 .15rem;background:${i <= NW.step ? '#00ff8c' : '#2a3a33'}"></span>`).join('');
  let body = '';
  if (!f || !f.set || !f.on) body = `<div class="warn">The NFT bridge is not switched on by the operator yet. Ask the operator to run the <b>NFT bridge setup wizard</b> on the control panel, then try again.</div>`;
  else if (NW.step === 0) body = `<div class="seg" style="margin-bottom:.7rem"><button class="${inn ? 'on' : ''}" onclick="window.nbw.set('dir','in')">XRPL → LUMA</button><button class="${inn ? '' : 'on'}" onclick="window.nbw.set('dir','out')">LUMA → XRPL</button></div><div class="mut" style="font-size:.86rem">${inn ? `Your XRPL NFT is handed to the bridge vault (${f.mode === 'burn' ? '<b class="dn">then burned: it can never come back</b>' : 'locked: it comes back when you send the copy back'}). A copy with the same name, traits and image is minted for you on LUMA.` : 'The wrapped copy is taken and burned on LUMA, and the original XRPL NFT is offered back to your XRPL wallet.'}</div>`;
  else if (NW.step === 1) {
    const list = inn ? NB.x : NB.l;
    body = `${inn ? (xw.length ? `<div class="mut" style="margin-bottom:.3rem">XRPL wallet</div><select id="nw_xw" style="width:100%;margin-bottom:.6rem" onchange="window.nbw.wallet(this.value)">${xw.map(w => `<option value="${esc(w.address)}" ${w.address === NB.xw ? 'selected' : ''}>${esc(w.label)} · ${esc(short(w.address, 6, 5))}</option>`).join('')}</select>` : '<div class="warn">No XRPL wallet in this app yet.</div>') : `<div class="mut" style="margin-bottom:.4rem">From your selected LUMA wallet <b>${ctx.account() ? esc(short(ctx.showL(ctx.account() as string), 8, 6)) : 'none'}</b></div>`}
      <div style="max-height:16rem;overflow:auto">${(list || []).length ? (list as any[]).map(n => { const id = n.NFTokenID, nm = inn ? (nwUri(n).slice(0, 40) || 'NFT') : (nbName(id) || 'Wrapped NFT'); return `<label class="row" style="gap:.6rem;padding:.45rem;border:1px solid ${NW.id === id ? '#00ff8c' : '#2a3a33'};border-radius:.5rem;margin:.3rem 0;cursor:pointer"><input type="radio" name="nwn" ${NW.id === id ? 'checked' : ''} onchange="window.nbw.set('id','${esc(id)}')"><span class="grow"><b>${esc(nm)}</b><div class="mono mut" style="font-size:.72rem">${esc(short(id, 10, 8))}</div></span>${inn && !(n.Flags & 8) ? '<span class="dn" style="font-size:.74rem">not transferable</span>' : ''}</label>`; }).join('') : `<div class="mut" style="padding:.6rem">${inn ? 'This XRPL wallet holds no NFTs. Close this and use <b>Add wallet</b> in the NFT bridge card if your NFT is in another XRPL wallet.' : 'No wrapped NFTs in this LUMA wallet.'}</div>`}</div>`;
  } else if (NW.step === 2) {
    const dest = nbDest(NW.dir);
    body = `<div class="card" style="background:rgba(0,255,140,.04)"><div class="k">${inn ? 'The copy is minted on LUMA for' : 'The original is offered on XRPL to'}</div><div class="mono" style="font-size:.8rem;word-break:break-all">${esc(dest || 'none')}</div><div class="mut" style="font-size:.78rem;margin-top:.4rem">${inn ? 'It arrives as an offer you accept in the activity list (the wizard shows the button when it is ready). Choose a different LUMA wallet by selecting it in the wallet picker first.' : 'It arrives as an offer you accept with your XRPL wallet.'}</div></div>`;
  } else if (NW.step === 3) {
    const e = NW.est; body = e ? `<div style="margin:.2rem 0"><b>${esc((e.meta && e.meta.name) || (e.nft && e.nft.name) || 'This NFT')}</b></div>${e.seconds ? `<div class="mut" style="font-size:.85rem">About ${e.seconds.typical}s (${e.seconds.min}–${e.seconds.max}s)${e.costs ? ' · ' + esc(e.costs.xrplFees) : ''}</div>` : ''}${(e.problems || []).map((p: string) => `<div class="dn" style="margin:.3rem 0">✗ ${esc(p)}</div>`).join('')}${(e.notes || []).map((p: string) => `<div class="mut" style="font-size:.8rem;margin:.2rem 0">• ${esc(p)}</div>`).join('')}${e.ok ? '<div class="up" style="margin-top:.4rem">✓ Ready to send</div>' : ''}` : '<span class="mut">Checking with the operator…</span>';
  } else body = `<div id="nw_p" class="mut">Press Send: your wallet signs one transaction, then the validator does the rest.</div>`;
  m.innerHTML = `<div class="card" style="max-width:32rem;width:100%;max-height:92vh;overflow:auto;background:#0d1117;border:1px solid rgba(0,255,140,.35)"><div class="row" style="justify-content:space-between;align-items:center"><div class="mut" style="font-size:.75rem">NFT BRIDGE · STEP ${NW.step + 1} OF 5</div><div>${dots}</div></div>
    <div style="font-size:1.1rem;font-weight:700;margin:.5rem 0 .8rem">${titles[NW.step]}</div>${body}<div id="nw_err" class="dn" style="margin-top:.5rem;font-size:.84rem"></div>
    <div class="row" style="justify-content:space-between;margin-top:1rem;gap:.5rem"><button class="ghost" onclick="window.nbw.${NW.step === 0 ? 'close' : 'back'}()">${NW.step === 0 ? 'Cancel' : 'Back'}</button>${NW.step < 4 ? `<button class="pri acc" onclick="window.nbw.next()">Next</button>` : `<button id="nw_go" class="pri acc" onclick="window.nbw.go()">Send</button>`}</div></div>`;
}
const nbw = {
  async start() { Object.assign(NW, { step: 0, dir: 'in', id: '', est: null, busy: false }); await nbLoad().catch(() => {}); nwPaint(); },
  close() { document.getElementById('nbwiz')?.remove(); },
  set(k: string, v: string) { NW[k] = v; if (k === 'dir') NW.id = ''; nwPaint(); },
  async wallet(a: string) { NB.xw = a; NW.id = ''; const s = $('nb_xw') as HTMLSelectElement | null; if (s) s.value = a; await nbLoad(); nwPaint(); },
  back() { NW.step = Math.max(0, NW.step - 1); nwPaint(); },
  async next() {
    const bad = (t: string) => { const e = document.getElementById('nw_err'); if (e) e.textContent = t; };
    if (!NB.feed || !NB.feed.set || !NB.feed.on) return bad('The NFT bridge is not on yet.');
    if (NW.step === 1 && !NW.id) return bad('Pick an NFT.');
    if (NW.step === 2 && !nbDest(NW.dir)) return bad(NW.dir === 'in' ? 'Select a LUMA wallet first.' : 'Pick an XRPL wallet first.');
    NW.step++; if (NW.step === 3) { NW.est = null; nwPaint(); try { NW.est = await nbFetch('/api/public/nftbridge/estimate', { dir: NW.dir, id: NW.id, owner: NB.xw, dest: nbDest(NW.dir) }); } catch (e: any) { NW.est = { ok: false, problems: [String(e?.message || e)] }; } }
    nwPaint();
  },
  async go() {
    if (NW.busy) return; NW.busy = true; const dir = NW.dir, id = NW.id; nbw.close();
    const inn = dir === 'in', nm = (NW.est && NW.est.meta && NW.est.meta.name) || nbName(id) || 'NFT';
    const fl = flowModal({ title: `Bridging "${nm}" ${inn ? 'XRPL → LUMA' : 'LUMA → XRPL'}`, rows: [['From', inn ? `XRPL wallet ${short(NB.xw || '', 8, 6)}` : `LUMA wallet ${short(ctx.showL(ctx.account() as string), 8, 6)}`], ['To', inn ? `LUMA wallet ${short(nbDest('in'), 8, 6)}` : `XRPL wallet ${short(NB.xw || '', 8, 6)}`], ['What you get', inn ? 'A copy minted on LUMA (you accept it)' : 'The original back on XRPL (you accept it)'], ['Usual time', NW.est && NW.est.seconds ? `about ${NW.est.seconds.typical}s` : '1 to 2 minutes']],
      steps: [`Make the offer on ${inn ? 'XRPL' : 'LUMA'}`, 'Validator takes the NFT', inn ? 'Copy minted on LUMA' : 'Original released on XRPL', 'You accept it']});
    fl.step(0, 'run');
    try {
      await nbApi.nbSend(dir, id);
      if (!/^Sent\./.test(NB.msg || '')) throw new Error(NB.msg || 'Not sent.');
      fl.step(0, 'ok'); fl.step(1, 'run', 'validator is picking it up');
      const t0 = Date.now(); let done = false;
      while (Date.now() - t0 < 6 * 60 * 1000 && !done) {
        await new Promise(r => setTimeout(r, 5000)); await nbLoad(true).catch(() => {});
        const it = (NB.act || []).find((a: any) => a.xrplId === id || a.lumaId === id);
        if (!it) continue; const st = String(it.state || '');
        if (/fail|reject/.test(st)) throw new Error('The bridge stopped it: ' + (it.latest || st));
        if (/attention|approval|limit|storage|inactive/.test(st)) fl.step(1, 'run', 'waiting: ' + st + (it.latest ? ' · ' + String(it.latest).slice(0, 80) : ''));
        if (['offered', 'done', 'released'].includes(st)) {
          fl.step(1, 'ok'); fl.step(2, 'ok');
          const off = inn ? it.lumaOffer : it.xrplOffer;
          if (off) { fl.step(3, 'run', 'ready: press Accept'); fl.msg(`<button id="nw_acc" class="pri acc" style="width:100%">Accept ${inn ? 'the copy on LUMA' : 'the original on XRPL'}</button>`);
            await new Promise<void>(res => { const b = document.getElementById('nw_acc'); if (b) b.onclick = async () => { b.setAttribute('disabled', 'true'); if (inn) await nbApi.nbAccept(off); else await nbApi.nbAcceptX(off, NB.xw); fl.step(3, 'ok'); fl.done('Done. The NFT is in your wallet.'); res(); }; }); }
          else { fl.step(3, 'ok'); fl.done('Done.'); }
          done = true;
        } else fl.step(1, 'run', 'validator state: ' + st);
      }
      if (!done) fl.msg('<span class="dn">Not finished after 6 minutes.</span> Follow it in <b>Your NFT bridge activity</b> below. Nothing is lost: it is completed or sent back.');
    } catch (e: any) { fl.fail(String(e?.message || e)); }
    NW.busy = false;
  },
};
(window as any).nbw = nbw;

// MINT and MAGIC as LUMA-side assets (from the operator feed), so they show in Tokens before anything is held.
export async function laneAssets(): Promise<{ c: string; i: string }[]> {
  if (!OP.snap || Date.now() - (OP.at || 0) > 60000) { try { await tryOperator(); } catch {} }
  const tl: any = (OP.snap && OP.snap.tokenLanes) || {};
  const out: { c: string; i: string }[] = [];
  for (const k of Object.keys(tl)) { const t = tl[k]; if (t && t.lumaIssuer && t.lumaCurrency) out.push({ c: t.lumaCurrency, i: ctx.toClassic(t.lumaIssuer) }); }
  return out;
}

// The XRPL tokens this wallet should always see (so a trust line is one click away): RLUSD, MINT, MAGIC.
export async function xrplLaneAssets(): Promise<{ name: string; code: string; issuer: string }[]> {
  if (!OP.snap || Date.now() - (OP.at || 0) > 120000) { try { await tryOperator(); } catch {} }
  const o = OP.snap, tl: any = (o && o.tokenLanes) || {}, out: { name: string; code: string; issuer: string }[] = [];
  const hx = (n: string) => Array.from(new TextEncoder().encode(n)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase().padEnd(40, '0');
  const rl = o && o.rlusd;
  out.push({ name: (rl && rl.code && rl.code.length <= 20 ? rl.code : 'RLUSD'), code: hx('RLUSD'), issuer: (rl && rl.issuer) || 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' });
  for (const k of ['MINT', 'MAGIC']) { const t = tl[k] || {}; out.push({ name: k, code: String(t.xrplCode || hx(k)).toUpperCase(), issuer: miIss(t.xrplIssuer) }); }
  return out;
}
(window as any).__flowModal = flowModal;
