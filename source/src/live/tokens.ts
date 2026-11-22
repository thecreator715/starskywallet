// Token registry (created tokens), icons stored on the ledger, and the token creator.
import { ipfsAdd } from './nft.ts';
import * as xrpl from 'xrpl';
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { Asset, NATIVE, akey, esc, fmt, hexName, nameToCur, short, usd, isNative } from './util.ts';
import { cached, clearCache, info, tryReq } from './chain.ts';

export const FEE_LUMA = 10; // legacy fee (v1 tokens)
export const FEE_USD = 100; // creation fee: $100 worth, paid in LUMA or any LUMA ecosystem token minted from the Genesis wallet
const FEE_SLACK = 1.02; // pay 2% extra so a small price move before confirmation never leaves the fee short
const FEE_MIN_USD = 95; // the registry accepts a v2 fee worth at least this much at the price recorded in the payment
const T_FEE = 'luma-token-fee',
  T_INFO = 'luma-token-info',
  T_ICON = 'luma-token-icon';
export interface TokenMeta {
  key: string;
  a: Asset;
  name: string;
  creator: string;
  desc: string;
  site: string;
  icon: string; // data URL or ''
  img?: string; // full-size picture on network storage (https gateway URL) or ''
  links?: { x?: string; tg?: string; dc?: string; cat?: string };
  tf?: number; // transfer fee percent
  feeKey?: string; // asset the creation fee was paid in ('native' or key)
  ms: number;
  hash: string;
  supply0: number;
}
const hexOf = (s: string) => Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const bytesOf = (h: string) => new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16)));
const textOf = (h: string) => new TextDecoder().decode(bytesOf(h));
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const SK = 'starsky.genesis.';
export const genesisAddr = (): string => {
  try {
    return localStorage.getItem(SK + ctx.netKey()) || '';
  } catch {
    return '';
  }
};
export const setGenesis = (a: string) => {
  try {
    localStorage.setItem(SK + ctx.netKey(), a);
  } catch {}
  clearCache('reg');
};
const memos = (t: any): { type: string; fmt: string; data: string }[] => (t.Memos || []).map((m: any) => ({ type: textOf((m.Memo || {}).MemoType || ''), fmt: textOf((m.Memo || {}).MemoFormat || ''), data: (m.Memo || {}).MemoData || '' }));
const okMeta = (x: any) => (x.meta || x.metaData || {}).TransactionResult === 'tesSUCCESS';
let regCache: TokenMeta[] = [];
export const cachedRegistry = () => regCache;
export const iconOf = (key: string): string => { const r: any = regCache.find(t => t.key === key) || {}; return r.icon || r.img || ''; };
export const imgOf = (key: string): string => { const r: any = regCache.find(t => t.key === key) || {}; return r.img || r.icon || ''; };

/** every token created through the token creator on this network: read from the fee payments to the genesis wallet */
export async function registry(): Promise<TokenMeta[]> {
  return cached('reg' + genesisAddr(), 30000, async () => {
    const g = genesisAddr();
    if (!g) return (regCache = []);
    const out: TokenMeta[] = [];
    let marker: any;
    for (let page = 0; page < 5; page++) {
      const r: any = await tryReq('account_tx', { account: g, limit: 200, ledger_index_min: -1, ledger_index_max: -1, ...(marker ? { marker } : {}) });
      if (!r) break;
      for (const x of r.transactions || []) {
        const t = x.tx || x.tx_json || {};
        if (t.TransactionType !== 'Payment' || t.Destination !== g || !okMeta(x)) continue;
        const dl = (x.meta || x.metaData || {}).delivered_amount ?? t.Amount;
        const mm = memos(t).find(m => m.type === T_FEE);
        if (!mm) continue;
        try {
          const j = JSON.parse(textOf(mm.data));
          if (!j.c || !j.i) continue;
          let feeKey = 'native';
          if (Number(j.v) >= 2) {
            // v2: $100 worth in LUMA or a Genesis-minted ecosystem token, valued at the price written in the payment
            const amt = typeof dl === 'object' ? Number((dl as any).value || 0) : Number(dl || 0) / 1e6, px = Number(j.p || 0);
            if (!(amt > 0 && px > 0 && amt * px + 1e-9 >= FEE_MIN_USD)) continue;
            if (typeof dl === 'object') feeKey = akey({ c: (dl as any).currency, i: (dl as any).issuer });
          } else if (typeof dl === 'object' || Number(dl || 0) / 1e6 + 1e-9 < FEE_LUMA) continue;
          const key = akey({ c: j.c, i: j.i });
          if (out.some(o => o.key === key)) continue;
          out.push({ key, feeKey, a: { c: j.c, i: j.i }, name: String(j.n || hexName(j.c)).slice(0, 24), creator: t.Account, desc: '', site: '', icon: '', ms: t.date ? (t.date + 946684800) * 1000 : 0, hash: t.hash || x.hash || '', supply0: Number(j.s || 0) });
        } catch {}
      }
      marker = r.marker;
      if (!marker) break;
    }
    // icon and description are written by the issuer account itself
    await Promise.all(
      out.map(async m => {
        const r: any = await tryReq('account_tx', { account: m.a.i, limit: 60, ledger_index_min: -1, ledger_index_max: -1 }, 30000);
        for (const x of (r && r.transactions) || []) {
          const t = x.tx || x.tx_json || {};
          if (t.Account !== m.a.i || t.TransactionType !== 'AccountSet' || !okMeta(x)) continue;
          for (const mm of memos(t)) {
            if (mm.type === T_INFO && !m.desc && !m.site) {
              try {
                const j = JSON.parse(textOf(mm.data));
                m.desc = String(j.d || '').slice(0, 280);
                m.site = /^https?:\/\//.test(j.w || '') ? String(j.w).slice(0, 120) : '';
                m.links = { x: j.x || '', tg: j.tg || '', dc: j.dc || '', cat: j.cat || '' };
                if (/^ipfs:\/\/[A-Za-z0-9]{20,100}$/.test(j.i || '')) m.img = 'https://ipfs.io/ipfs/' + String(j.i).slice(7);
              } catch {}
            }
            if (mm.type === T_ICON && !m.icon && /^image\/(webp|png|jpeg)$/.test(mm.fmt)) m.icon = `data:${mm.fmt};base64,${b64(bytesOf(mm.data))}`;
          }
        }
      })
    );
    for (const m of out) if (!m.icon && m.img) m.icon = m.img;
    const made = new Set(out.map(o => o.key));
    for (let n = out.length - 1; n >= 0; n--) if (out[n].feeKey && out[n].feeKey !== 'native' && made.has(out[n].feeKey as string)) out.splice(n, 1);
    out.sort((a, b) => b.ms - a.ms);
    return (regCache = out);
  });
}

/* ---------- icon preparation: small enough to live in one ledger memo ---------- */
const MAX_ICON = 760;
async function prepIcon(file: File): Promise<{ bytes: Uint8Array; mime: string; url: string }> {
  if (!/^image\//.test(file.type) || /svg/.test(file.type)) throw new Error('Choose a PNG, JPG or WebP picture.');
  const bmp = await createImageBitmap(file);
  const tryMake = async (px: number, mime: string, q: number): Promise<Blob | null> => {
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    const s = Math.min(bmp.width, bmp.height);
    g.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, px, px);
    return new Promise(r => c.toBlob(b => r(b), mime, q));
  };
  for (const px of [64, 48, 40, 32, 24]) for (const [mime, q] of [['image/webp', 0.8], ['image/webp', 0.5], ['image/webp', 0.3], ['image/png', 1]] as const) {
    const b = await tryMake(px, mime, q);
    if (!b || b.type !== mime) continue;
    if (b.size <= MAX_ICON) {
      const bytes = new Uint8Array(await b.arrayBuffer());
      return { bytes, mime, url: `data:${mime};base64,${b64(bytes)}` };
    }
  }
  throw new Error('That picture is too detailed to store on the ledger (limit about 760 bytes). Use a simpler logo.');
}

/* ---------- creator ---------- */
interface Form {
  name: string;
  sym: string;
  supply: string;
  desc: string;
  site: string;
  lock: boolean;
  x: string;
  tg: string;
  dc: string;
  cat: string;
  tf: string;
  nf: boolean;
  pay: string;
  gen: string;
}
const F0 = (): Form => ({ name: '', sym: '', supply: '1000000', desc: '', site: '', lock: false, x: '', tg: '', dc: '', cat: '', tf: '', nf: false, pay: 'native', gen: '' });
let F: Form = F0();
/** what the $100 creation fee can be paid in: LUMA, or a LUMA ecosystem token minted from the Genesis wallet (never a token made in Starsky) */
interface FeeOpt { key: string; sym: string; cur?: string; iss?: string; px: number; need: number; have: number; ok: boolean; why: string }
let OPTS: FeeOpt[] = [];
async function feeOptions(acc: string, g: string, extra: number): Promise<FeeOpt[]> {
  const out: FeeOpt[] = [];
  const [snap, reg, lines, ai, gl] = await Promise.all([
    M.snapshot().catch(() => null),
    registry().catch(() => [] as TokenMeta[]),
    ctx.req('account_lines', { account: acc, ledger_index: 'validated', limit: 400 }).catch(() => null),
    ctx.req('account_info', { account: acc, ledger_index: 'validated' }).catch(() => null),
    g ? ctx.req('account_lines', { account: g, ledger_index: 'validated', limit: 400 }).catch(() => null) : Promise.resolve(null),
  ]);
  const made = new Set(reg.map(r => r.key));
  const usd = (k: string): number | null => (snap ? usdPxOf(snap, k) : null);
  const nat = snap && (snap as any).usdPerNative ? Number((snap as any).usdPerNative) : 0;
  const nb = ai && ai.account_data ? Number(ai.account_data.Balance || 0) / 1e6 : 0;
  const reserve = 2 + extra; // keep the wallet reserve and the funds that go to the new issuer wallet
  if (nat > 0) { const need = (FEE_USD * FEE_SLACK) / nat; out.push({ key: 'native', sym: ctx.native(), px: nat, need, have: nb, ok: nb - reserve >= need, why: nb - reserve >= need ? '' : 'not enough ' + ctx.native() }); }
  const gset = new Set(((gl && gl.lines) || []).map((l: any) => akey({ c: l.currency, i: l.account })));
  for (const l of (lines && lines.lines) || []) {
    const bal = Number(l.balance || 0); if (!(bal > 0)) continue;
    const key = akey({ c: l.currency, i: l.account });
    if (made.has(key)) continue; // tokens made in Starsky can never pay for another token
    const px = usd(key); if (!px || !(px > 0)) continue;
    const need = (FEE_USD * FEE_SLACK) / px;
    const hasLine = gset.has(key) || l.account === g;
    out.push({ key, sym: hexName(l.currency), cur: l.currency, iss: l.account, px, need, have: bal, ok: bal >= need && hasLine, why: !hasLine ? 'the Genesis wallet has no trust line for it yet' : bal < need ? 'not enough balance' : '' });
  }
  return out;
}
const usdPxOf = (s: any, k: string): number | null => (s.usdPerNative == null ? null : s.px.has(k) ? (s.px.get(k) as number) * s.usdPerNative : null);
let ICON: { bytes: Uint8Array; mime: string; url: string; ipfs?: string } | null = null;
const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const val = (id: string) => ($(id)?.value || '').trim();
export async function openCreate() {
  if (!ctx.account()) return ctx.toast('Select a wallet first', true);
  const i = await info().catch(() => null);
  const reserve = i ? i.reserveBase + 2 * i.reserveInc + 1 : 3;
  let g = genesisAddr();
  let cand = '';
  if (!g) {
    try {
      const top = await M.holders(NATIVE, null, new Set());
      cand = top.top[0] ? top.top[0].addr : '';
    } catch {}
  }
  OPTS = await feeOptions(ctx.account() as string, g || cand, reserve).catch(() => []);
  if (!OPTS.some(o => o.key === F.pay && o.ok)) F.pay = (OPTS.find(o => o.ok) || OPTS[0] || { key: 'native' }).key;
  ctx.page(`<h2>Create a token</h2>
    <p class="mut" style="margin:.2rem 0 .6rem;font-size:.85rem">Creates a new issuer wallet for your token, issues the supply to <b>this wallet</b>, and records the token on the network so it appears under Others with trading and pools.</p>
    <div class="lpcard" style="margin:.5rem 0"><div class="k">Network for this token</div><div class="row" style="gap:.4rem;margin:.4rem 0">${[['main', 'LUMA Mainnet'], ['test', 'LUMA Testnet']].map(([id, nm]) => `<button class="sm grow ${ctx.netKey() === id ? 'pri acc' : ''}" onclick="window.tk.net('${id}')">${nm}</button>`).join('')}</div><div class="mut" style="font-size:.74rem">The token is created on the network selected here, ${ctx.netKey() === 'test' ? 'the Testnet (practice coins, no real value)' : 'the Mainnet (real LUMA)'}. A token exists only on the network it was made on.</div></div>
    <div class="fgrid">
      <input id="tk_name" placeholder="Token name (e.g. Sun Coin)" maxlength="24" value="${esc(F.name)}">
      <input id="tk_sym" placeholder="Symbol (3 letters, or up to 20)" maxlength="20" value="${esc(F.sym)}">
      <input id="tk_sup" placeholder="Total supply to issue" inputmode="decimal" value="${esc(F.supply)}">
      <input id="tk_web" placeholder="Website (optional, https://…)" value="${esc(F.site)}">
    </div>
    <input id="tk_desc" style="width:100%;margin-top:.5rem" placeholder="Short description (optional)" maxlength="200" value="${esc(F.desc)}">
    <div class="row" style="margin-top:.6rem;gap:.8rem;align-items:center"><div id="tk_prev" class="tkicon">${ICON ? `<img src="${ICON.url}">` : '<span class="mut">icon</span>'}</div>
      <div><input id="tk_file" type="file" accept="image/png,image/jpeg,image/webp" onchange="window.tk.icon(this)"><div id="tk_ist" class="mut" style="font-size:.75rem">Uploaded to the network picture storage (IPFS) like Social pictures, plus a tiny copy stored on the ledger so the icon shows everywhere, even if storage is offline.</div></div></div>
    <label class="mut" style="display:block;margin:.6rem 0;font-size:.82rem"><input id="tk_lock" type="checkbox" ${F.lock ? 'checked' : ''}> Lock the supply forever (disables the issuer key so nobody can ever issue more. Cannot be undone.)</label>
    ${g ? '' : `<div class="lpcard" style="margin:.5rem 0"><div class="k">Genesis wallet (receives the creation fee)</div><input id="tk_gen" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" style="width:100%" placeholder="Genesis address (L… / T…)" value="${esc(F.gen || (cand ? ctx.showL(cand) : ''))}" oninput="window.tk.gen(this.value)"><div class="mut" style="font-size:.74rem">${cand ? 'Filled with the largest holder of the native coin, which is normally the genesis wallet. Check it, it is saved for this network.' : 'Paste the genesis address from the control panel.'}</div></div>`}
    <div class="lpcard" style="margin-top:.6rem"><div class="k">More options</div>
      <div class="fgrid" style="margin-top:.4rem">
        <input id="tk_x" placeholder="X / Twitter link (optional)" value="${esc(F.x)}"><input id="tk_tg" placeholder="Telegram link (optional)" value="${esc(F.tg)}">
        <input id="tk_dc" placeholder="Discord link (optional)" value="${esc(F.dc)}">
        <select id="tk_cat"><option value="">Category (optional)</option>${['Meme', 'Utility', 'Gaming', 'Community', 'DeFi', 'Art', 'Real world'].map(c => `<option ${F.cat === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        <input id="tk_tf" placeholder="Transfer fee % on every send (0 to 5, optional)" inputmode="decimal" value="${esc(F.tf)}">
      </div>
      <label class="mut" style="display:block;margin:.5rem 0 0;font-size:.82rem"><input id="tk_nf" type="checkbox" ${F.nf ? 'checked' : ''}> Give up the right to freeze any holder (cannot be undone). Builds trust with buyers.</label></div>
    <div class="lpcard" style="margin-top:.6rem"><div class="k">Creation fee: $${FEE_USD} worth, paid to the Genesis wallet</div>
      <div class="mut" style="font-size:.78rem;margin:.2rem 0 .4rem">Pay in ${esc(ctx.native())} or any LUMA ecosystem token that was minted from the Genesis wallet and has a price. Tokens made in Starsky cannot be used to pay for a new token.</div>
      <select id="tk_pay" style="width:100%" onchange="window.tk.pay(this.value)">${OPTS.map(o => `<option value="${esc(o.key)}" ${o.key === F.pay ? 'selected' : ''} ${o.ok ? '' : 'disabled'}>${esc(o.sym)}: ${fmt(o.need)} ${o.ok ? '' : '(' + esc(o.why) + ')'}</option>`).join('') || '<option value="native">' + esc(ctx.native()) + '</option>'}</select>
      <div id="tk_payx" class="mut" style="font-size:.78rem;margin-top:.3rem"></div>
      <div class="dxkv"><span class="mut">Funds for the new issuer wallet (reserve and fees)</span><b>about ${fmt(reserve)} ${esc(ctx.native())}</b></div>
      <div class="dxkv"><span class="mut">Paid from</span><span class="mono">${esc(short(ctx.showL(ctx.account() as string), 8, 6))}</span></div></div>
    <div id="tk_err" class="crit" style="min-height:1.2rem;font-size:.82rem;margin-top:.4rem"></div>
    <div class="row"><button class="grow" onclick="window.closeModal()">Cancel</button><button class="pri acc grow" id="tk_go" onclick="window.tk.create(this)">Create token</button></div>`, 'Create a token');
}
const keepForm = () => {
  F = { name: val('tk_name'), sym: val('tk_sym'), supply: val('tk_sup'), desc: val('tk_desc'), site: val('tk_web'), lock: !!$('tk_lock')?.checked, x: val('tk_x'), tg: val('tk_tg'), dc: val('tk_dc'), cat: val('tk_cat'), tf: val('tk_tf'), nf: !!$('tk_nf')?.checked, pay: val('tk_pay') || F.pay, gen: val('tk_gen') || F.gen };
};
async function bigBlob(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file), k = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  (c.getContext('2d') as CanvasRenderingContext2D).drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise<Blob>((r, j) => c.toBlob(b => (b ? r(b) : j(new Error('Could not read that picture.'))), 'image/webp', 0.9));
}
export async function pickIcon(inp: HTMLInputElement) {
  keepForm();
  const err = document.getElementById('tk_err'), st = document.getElementById('tk_ist');
  const f = inp.files && inp.files[0];
  if (!f) return;
  ICON = null;
  const say = (m: string) => { if (st) st.textContent = m; };
  let tiny: { bytes: Uint8Array; mime: string; url: string } | null = null, tinyErr = '';
  try { tiny = await prepIcon(f); } catch (e: any) { tinyErr = String(e?.message || e); }
  const p = document.getElementById('tk_prev');
  if (tiny && p) p.innerHTML = `<img src="${tiny.url}">`;
  say('Uploading to network storage\u2026');
  let ipfs = '';
  try { ipfs = 'ipfs://' + (await ipfsAdd(await bigBlob(f), f.name.replace(/\.[^.]+$/, '') + '.webp')); } catch (e: any) { say(String(e?.message || e) + (tiny ? ' The small on-ledger icon will still be used.' : '')); }
  if (!tiny && !ipfs) { if (err) err.textContent = tinyErr; if (p) p.innerHTML = '<span class="mut">icon</span>'; return; }
  ICON = { bytes: tiny ? tiny.bytes : new Uint8Array(0), mime: tiny ? tiny.mime : '', url: tiny ? tiny.url : 'https://ipfs.io/ipfs/' + ipfs.slice(7), ipfs };
  if (!tiny && p) p.innerHTML = `<img src="${ICON.url}">`;
  if (ipfs) say('Uploaded. This picture will show for the token everywhere.');
  if (err) err.textContent = '';
}
export async function create(btn: HTMLButtonElement) {
  keepForm();
  const err = document.getElementById('tk_err');
  const say = (t: string) => err && (err.textContent = t);
  try {
    const acc = ctx.account() as string;
    if (!acc) throw new Error('Select a wallet first.');
    if (!F.name) throw new Error('Give the token a name.');
    const cur = nameToCur(F.sym);
    if (!F.sym || ['XRP', 'LUMA', 'USD'].includes(F.sym.toUpperCase())) throw new Error('Choose another symbol (that one is taken by a built-in coin).');
    const supply = parseFloat(F.supply);
    if (!(supply > 0) || supply > 1e15) throw new Error('Enter a total supply above zero.');
    if (F.site && !/^https?:\/\//.test(F.site)) throw new Error('The website must start with https://');
    let g = genesisAddr();
    if (!g) {
      const gi = val('tk_gen');
      if (!gi) throw new Error('Enter the genesis wallet address.');
      g = ctx.toClassic(gi);
      if (!xrpl.isValidClassicAddress(g)) throw new Error('That genesis address is not valid.');
    }
    const taken = (await registry().catch(() => [])).find(t => t.name.toLowerCase() === F.name.toLowerCase() || hexName(t.a.c).toLowerCase() === F.sym.toLowerCase());
    if (taken && !confirm(`A token called ${taken.name} already exists on this network. Create another one with the same name?`)) return;
    if (F.lock && !confirm('Locking the supply is permanent: the issuer key is disabled and nobody can ever issue more. Continue?')) return;
    for (const [k, v] of [['X link', F.x], ['Telegram link', F.tg], ['Discord link', F.dc]] as const) if (v && !/^https?:\/\//.test(v)) throw new Error(k + ' must start with https://');
    const tfp = F.tf === '' ? 0 : parseFloat(F.tf);
    if (!(tfp >= 0 && tfp <= 5)) throw new Error('The transfer fee must be between 0 and 5 percent.');
    if (F.nf && !confirm('Giving up the freeze right is permanent. Continue?')) return;
    const i = await info();
    const fund = i.reserveBase + 2 * i.reserveInc + 1;
    // re-price the fee right now so it is worth $100 when it lands
    const fresh = await feeOptions(acc, g, fund);
    const po = fresh.find(o => o.key === F.pay);
    if (!po || !po.ok) throw new Error('The chosen fee token cannot cover $' + FEE_USD + ' right now' + (po && po.why ? ' (' + po.why + ')' : '') + '. Pick another one.');
    const feeVal = po.key === 'native' ? String(Math.ceil(po.need * 1e6)) : String(Math.ceil(po.need * 1e6) / 1e6);
    const feeAmt: any = po.key === 'native' ? feeVal : { currency: po.cur, issuer: po.iss, value: feeVal };
    btn.disabled = true;
    const steps: [string, string][] = [];
    const draw = () => ctx.modal(`<h2>Creating ${esc(F.name)}</h2><div class="steps">${steps.map(([s, st]) => `<div class="step ${st}"><i>${st === 'ok' ? '✓' : st === 'run' ? '…' : st === 'bad' ? '✕' : '•'}</i>${esc(s)}</div>`).join('')}</div>${steps.some(x => x[1] === 'bad') ? '<button class="grow" onclick="window.closeModal()">Close</button>' : ''}`);
    const names = ['Create the issuer wallet and keep its key in your vault', `Pay the $${FEE_USD} creation fee (${fmt(po.need)} ${po.sym}) to the genesis wallet`, 'Fund the issuer wallet', 'Set up the issuer (rippling for pools and trading) and record the token details', ...(ICON && ICON.bytes.length ? ['Store the icon on the ledger'] : []), 'Open your trust line to the new token', `Issue ${fmt(supply)} ${F.sym} to your wallet`, ...(F.lock ? ['Lock the supply forever'] : [])];
    names.forEach(n => steps.push([n, 'todo']));
    let k = 0;
    const run = async (fn: () => Promise<{ ok: boolean; msg?: string }>) => {
      steps[k][1] = 'run';
      draw();
      const r = await fn();
      if (!r.ok) {
        steps[k][1] = 'bad';
        draw();
        throw new Error(`Stopped at "${steps[k][0]}": ${r.msg}. Anything already done stays on the ledger, and the issuer wallet is saved in your vault.`);
      }
      steps[k][1] = 'ok';
      k++;
      draw();
    };
    draw();
    const issuer = xrpl.Wallet.generate();
    await run(async () => {
      await ctx.addWallet('Issuer: ' + F.name, issuer.seed as string, issuer.classicAddress);
      return { ok: true };
    });
    await run(() => ctx.submit({ TransactionType: 'Payment', Account: acc, Destination: g, Amount: feeAmt, Memos: [{ Memo: { MemoType: hexOf(T_FEE), MemoData: hexOf(JSON.stringify({ v: 2, c: cur, i: issuer.classicAddress, n: F.name, s: supply, u: FEE_USD, p: po.px })) } }] }));
    await run(() => ctx.submit({ TransactionType: 'Payment', Account: acc, Destination: issuer.classicAddress, Amount: String(Math.round(fund * 1e6)) }));
    await run(() =>
      ctx.submitAs(issuer.seed as string, { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: 8, ...(tfp > 0 ? { TransferRate: Math.round((1 + tfp / 100) * 1e9) } : {}), Memos: [{ Memo: { MemoType: hexOf(T_INFO), MemoFormat: hexOf('application/json'), MemoData: hexOf(JSON.stringify({ n: F.name, d: F.desc, w: F.site, ...(ICON && ICON.ipfs ? { i: ICON.ipfs } : {}), ...(F.x ? { x: F.x } : {}), ...(F.tg ? { tg: F.tg } : {}), ...(F.dc ? { dc: F.dc } : {}), ...(F.cat ? { cat: F.cat } : {}) })) } }] })
    );
    if (ICON && ICON.bytes.length) {
      const ic = ICON;
      await run(() => ctx.submitAs(issuer.seed as string, { TransactionType: 'AccountSet', Account: issuer.classicAddress, Memos: [{ Memo: { MemoType: hexOf(T_ICON), MemoFormat: hexOf(ic.mime), MemoData: Array.from(ic.bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase() } }] }));
    }
    await run(() => ctx.submit({ TransactionType: 'TrustSet', Account: acc, LimitAmount: { currency: cur, issuer: issuer.classicAddress, value: String(supply) } }));
    await run(() => ctx.submitAs(issuer.seed as string, { TransactionType: 'Payment', Account: issuer.classicAddress, Destination: acc, Amount: { currency: cur, issuer: issuer.classicAddress, value: String(supply) } }));
    if (F.nf) await run(() => ctx.submitAs(issuer.seed as string, { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: 6 }));
    if (F.lock) {
      await run(async () => {
        const a = await ctx.submitAs(issuer.seed as string, { TransactionType: 'SetRegularKey', Account: issuer.classicAddress, RegularKey: 'rrrrrrrrrrrrrrrrrrrrBZbvji' });
        if (!a.ok) return a;
        return ctx.submitAs(issuer.seed as string, { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: 4 });
      });
    }
    if (!genesisAddr()) setGenesis(g);
    clearCache();
    const key = akey({ c: cur, i: issuer.classicAddress });
    ICON = null;
    F = F0();
    ctx.modal(`<h2>${esc(steps.length ? 'Token created' : '')}</h2><p>Your token is live and appears under <b>Others</b>. The supply is in your wallet.</p><div class="row" style="gap:.5rem;flex-wrap:wrap"><button class="pri acc grow" onclick="window.closeModal();window.tk.openPool('${esc(key)}')">Create a liquidity pool</button><button class="grow" onclick="window.closeModal();window.pa.trade('${esc(key)}')">Open in the DEX</button><button class="grow" onclick="window.closeModal();window.pa.reload()">Done</button></div>`);
    ctx.rerender();
  } catch (e: any) {
    say(String(e?.message || e));
    btn.disabled = false;
  }
}
export function openPool(key: string) {
  const w = window as any;
  w.goTab('pools');
  setTimeout(() => {
    w.openCreatePoolModal();
    const a = key.split('|');
    const set = (id: string, v: string) => {
      const e = document.getElementById(id) as HTMLInputElement | null;
      if (e) e.value = v;
    };
    set('cp_c2', hexName(a[0]));
    set('cp_i2', ctx.showL(a[1]));
  }, 300);
}
export const tkApi: any = { openCreate, create, icon: pickIcon, openPool, gen: (v: string) => { F.gen = v; }, net: (id: string) => { keepForm(); F.gen = ''; (window as any).switchNet?.(id); setTimeout(() => { void openCreate(); }, 1500); } };

// ---------- manage supply: mint more, burn, cap (lock) ----------
interface Mg { wallet: string; issuer: string; seed: string; label: string; cur: string; name: string; supply: number; mine: number; locked: boolean }
let MGL: Mg[] = [], MGSEL = 0;
async function loadManaged() {
  const out: Mg[] = [], me = ctx.account() as string;
  for (const w of ctx.wallets()) {
    if (!/^Issuer:/.test(w.label)) continue;
    try {
      const [ai, gb, al] = await Promise.all([
        ctx.req('account_info', { account: w.address, ledger_index: 'validated' }),
        ctx.req('gateway_balances', { account: w.address, ledger_index: 'validated' }).catch(() => ({ obligations: {} })),
        ctx.req('account_lines', { account: me, peer: w.address, ledger_index: 'validated' }).catch(() => ({ lines: [] })),
      ]);
      const locked = !!((ai.account_data.Flags || 0) & 0x00100000);
      for (const [cur, v] of Object.entries((gb && gb.obligations) || {})) {
        const ln = ((al && al.lines) || []).find((l: any) => l.currency === cur);
        out.push({ wallet: w.address, issuer: w.address, seed: w.seed, label: w.label.replace(/^Issuer:\s*/, ''), cur, name: hexName(cur), supply: Number(v), mine: ln ? Number(ln.balance) : 0, locked });
      }
    } catch { /* wallet not funded yet */ }
  }
  MGL = out; if (MGSEL >= out.length) MGSEL = 0;
}
function drawManage() {
  const box = document.getElementById('tkm'); if (!box) return;
  if (!MGL.length) { box.innerHTML = '<div class="mut" style="padding:1rem">No tokens made in this wallet vault yet on this network. Create one first, or switch network (Mainnet/Testnet) at the top.</div>'; return; }
  const m = MGL[MGSEL];
  box.innerHTML = `<select id="tkm_sel" style="width:100%" onchange="window.tk.msel(this.value)">${MGL.map((x, i) => `<option value="${i}" ${i === MGSEL ? 'selected' : ''}>${esc(x.label)} (${esc(x.name)})</option>`).join('')}</select>
  <div class="lpcard" style="margin-top:.6rem"><div class="dxkv"><span class="mut">Total supply</span><b>${fmt(m.supply)} ${esc(m.name)}</b></div><div class="dxkv"><span class="mut">In your wallet</span><b>${fmt(m.mine)} ${esc(m.name)}</b></div><div class="dxkv"><span class="mut">Supply cap</span><b>${m.locked ? 'Capped forever: nobody can mint more' : 'Open: you can still mint more'}</b></div></div>
  <div class="lpcard" style="margin-top:.6rem"><div class="k">Mint more</div><div class="mut" style="font-size:.78rem;margin:.2rem 0 .4rem">Creates new tokens and sends them to your wallet. ${m.locked ? 'Not possible: the supply is capped.' : ''}</div>
    <div class="row" style="gap:.5rem"><input id="tkm_mint" class="grow" inputmode="decimal" placeholder="Amount to mint" ${m.locked ? 'disabled' : ''}><button class="pri acc" ${m.locked ? 'disabled' : ''} onclick="window.tk.mint(this)">Mint</button></div></div>
  <div class="lpcard" style="margin-top:.6rem"><div class="k">Burn</div><div class="mut" style="font-size:.78rem;margin:.2rem 0 .4rem">Destroys tokens from your wallet and lowers the total supply. Cannot be undone.</div>
    <div class="row" style="gap:.5rem"><input id="tkm_burn" class="grow" inputmode="decimal" placeholder="Amount to burn"><button onclick="window.tk.burn(this)">Burn</button></div></div>
  <div class="lpcard" style="margin-top:.6rem"><div class="k">Cap the supply</div><div class="mut" style="font-size:.78rem;margin:.2rem 0 .4rem">Locks the issuer key for good, so the supply can never grow past ${fmt(m.supply)} ${esc(m.name)}. Burning still works afterwards. Mint first if you want a higher final number. Cannot be undone.</div>
    <button class="crit" ${m.locked ? 'disabled' : ''} onclick="window.tk.cap(this)">${m.locked ? 'Already capped' : 'Cap supply forever'}</button></div>
  <div id="tkm_err" class="crit" style="min-height:1.2rem;font-size:.82rem;margin-top:.4rem"></div>
  <div id="tkm_an" style="margin-top:.8rem"><div class="mut" style="padding:.8rem">Loading analytics from the ledger…</div></div>`;
  void loadAnalytics(m);
}
export async function openManage() {
  if (!ctx.account()) return ctx.toast('Select a wallet first', true);
  ctx.page('<h2>Manage token supply</h2><div id="tkm"><div class="mut" style="padding:1rem">Loading…</div></div>', 'Manage token supply');
  await loadManaged(); drawManage();
}
const mErr = (s: string) => { const e = document.getElementById('tkm_err'); if (e) e.textContent = s; };
async function mDone(msg: string) { ctx.toast('✓ ' + msg); clearCache(); await loadManaged(); drawManage(); }
Object.assign(tkApi, {
  openManage,
  msel: (v: string) => { MGSEL = Number(v) || 0; drawManage(); },
  async mint(b: HTMLButtonElement) {
    const m = MGL[MGSEL], n = parseFloat(val('tkm_mint')); mErr('');
    if (!(n > 0) || m.supply + n > 1e15) return mErr('Enter an amount above zero.');
    b.disabled = true;
    const r = await ctx.submitAs(m.seed, { TransactionType: 'Payment', Account: m.issuer, Destination: ctx.account() as string, Amount: { currency: m.cur, issuer: m.issuer, value: String(n) } });
    if (r.ok) await mDone(`Minted ${fmt(n)} ${m.name}`); else { mErr('Mint failed: ' + (r.msg || '')); b.disabled = false; }
  },
  async burn(b: HTMLButtonElement) {
    const m = MGL[MGSEL], n = parseFloat(val('tkm_burn')); mErr('');
    if (!(n > 0) || n > m.mine) return mErr('Enter an amount up to what is in your wallet (' + fmt(m.mine) + ').');
    if (!confirm(`Burn ${fmt(n)} ${m.name} for good?`)) return;
    b.disabled = true;
    const r = await ctx.submit({ TransactionType: 'Payment', Account: ctx.account() as string, Destination: m.issuer, Amount: { currency: m.cur, issuer: m.issuer, value: String(n) } });
    if (r.ok) await mDone(`Burned ${fmt(n)} ${m.name}`); else { mErr('Burn failed: ' + (r.msg || '')); b.disabled = false; }
  },
  async cap(b: HTMLButtonElement) {
    const m = MGL[MGSEL]; mErr('');
    if (!confirm(`Cap ${m.name} at ${fmt(m.supply)} forever? Nobody, including you, can mint more after this. This cannot be undone.`)) return;
    b.disabled = true;
    const a = await ctx.submitAs(m.seed, { TransactionType: 'SetRegularKey', Account: m.issuer, RegularKey: 'rrrrrrrrrrrrrrrrrrrrBZbvji' });
    const r = a.ok ? await ctx.submitAs(m.seed, { TransactionType: 'AccountSet', Account: m.issuer, SetFlag: 4 }) : a;
    if (r.ok) await mDone(`${m.name} is capped at ${fmt(m.supply)}`); else { mErr('Could not cap: ' + (r.msg || '')); b.disabled = false; }
  },
});

// ---------- full analytics for a token you created ----------
const SPK = (v: number[], up: boolean) => { if (v.length < 2) return ''; const lo = Math.min(...v), hi = Math.max(...v), r = hi - lo || 1, pts = v.map((y, i) => `${(i / (v.length - 1) * 220).toFixed(1)},${(38 - ((y - lo) / r) * 34).toFixed(1)}`).join(' '); return `<svg viewBox="0 0 220 40" width="100%" height="48" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${up ? '#34d399' : '#f87171'}" stroke-width="2"/></svg>`; };
const kv = (a: string, b: string) => `<div class="dxkv"><span class="mut">${a}</span><b>${b}</b></div>`;
const pc = (n: number | null | undefined) => (n == null ? '–' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%');
let ANG = 0;
async function loadAnalytics(m: Mg) {
  const g = ++ANG, box = () => (g === ANG ? document.getElementById('tkm_an') : null);
  const a: Asset = { c: m.cur, i: m.issuer }, me = ctx.account() as string, key = akey(a);
  const sec = (t: string, h: string) => `<div class="lpcard" style="margin-top:.6rem"><div class="k">${t}</div>${h}</div>`;
  const parts: string[] = [];
  const put = () => { const b = box(); if (b) b.innerHTML = parts.join(''); };
  try {
    // price, market cap, liquidity, changes
    const tt = await M.tokenTable([a]);
    if (!box()) return;
    const row: any = tt.rows.find(r => r.key === key), nativeUsd = tt.now.usdPerNative, px = row ? row.usdPx : null;
    const chg = row ? ['5m', '1h', '24h', '7d'].map(k => `${k.toUpperCase()} ${pc(row.chg[k])}`).join(' · ') : '–';
    parts.push(sec('Price and market', kv('Price', px != null ? usd(px) : row && row.nativePx != null ? fmt(row.nativePx, 6) + ' ' + esc(ctx.native()) : 'No pool yet, so no price')
      + kv('Change', chg) + kv('Market cap', row ? (row.mcapUsd != null ? usd(row.mcapUsd) : row.mcapNative != null ? fmt(row.mcapNative) + ' ' + esc(ctx.native()) : '–') : '–')
      + kv('Fully diluted', px != null ? usd(px * m.supply) : '–') + kv('Liquidity (TVL)', row ? (row.tvlUsd != null ? usd(row.tvlUsd) : fmt(row.tvlNative) + ' ' + esc(ctx.native())) : '–')
      + kv('Pools', String(row ? row.pools : 0)) + kv('Listed at ledger', row && row.listedSeq ? String(row.listedSeq) : '–')));
    put();
    // pools: reserves, fee, price, volume, traders, your pnl
    const refs = (await M.poolRefs()).filter(p => akey(p.a) === key || akey(p.b) === key);
    const states = (await Promise.all(refs.map(r => M.poolState(r).catch(() => null)))).filter(Boolean) as M.PoolState[];
    const dayMs = Date.now() - 86400000;
    let vol24 = 0, volAll = 0, buys = 0, sells = 0, trades = 0, pnlUsd = 0, spentUsd = 0, gotUsd = 0;
    const traders = new Set<string>(), recent: Array<M.Trade & { sym: string }> = [], poolRows: string[] = [];
    const qUsd = (q: Asset): number | null => { if (isNative(q)) return nativeUsd; const r2: any = tt.rows.find(r => r.key === akey(q)); return r2 && r2.usdPx != null ? r2.usdPx : null; };
    for (const st of states) {
      const base = akey(st.a) === key ? st.a : st.b, quote = base === st.a ? st.b : st.a;
      const mk: M.Market = { id: M.marketId(base, quote), base, quote, label: '', pool: st };
      const trs = await M.tradesSince(mk, dayMs - 6 * 86400000).catch(() => [] as M.Trade[]);
      const qu = qUsd(quote);
      for (const t of trs) {
        if (t.kind !== 'buy' && t.kind !== 'sell') continue;
        trades++; traders.add(t.who); if (t.kind === 'buy') buys++; else sells++;
        const v = qu != null ? t.quote * qu : 0; volAll += v; if (t.ms >= dayMs) vol24 += v;
        if (t.who === me && qu != null) { if (t.kind === 'buy') spentUsd += t.quote * qu; else gotUsd += t.quote * qu; }
        recent.push({ ...t, sym: M.labelOf(quote) });
      }
      const pr = M.poolPrice(st, base), tvl = (qu != null ? st.ra : 0);
      poolRows.push(`<tr><td>${esc(M.labelOf(base))}/${esc(M.labelOf(quote))}</td><td class="r">${fmt(akey(st.a) === key ? st.ra : st.rb)} / ${fmt(akey(st.a) === key ? st.rb : st.ra)}</td><td class="r">${pr != null ? fmt(pr, 6) : '–'}</td><td class="r">${st.fee}%</td><td class="r mono">${esc(short(st.account, 5, 4))}</td></tr>`);
      void tvl;
    }
    parts.push(sec('Pools', poolRows.length ? `<table class="dxt"><thead><tr><th>Pair</th><th class="r">Reserves</th><th class="r">Price</th><th class="r">Fee</th><th class="r">Pool</th></tr></thead><tbody>${poolRows.join('')}</tbody></table>` : '<div class="mut">No liquidity pool for this token yet. Create one from Liquidity Pools so people can trade it.</div>'));
    parts.push(sec('Trading (last 7 days of pool history)', kv('Volume 24h', usd(vol24)) + kv('Volume 7d', usd(volAll)) + kv('Swaps', `${trades} (${buys} buys, ${sells} sells)`) + kv('Buy / sell ratio', sells ? (buys / sells).toFixed(2) : buys ? 'all buys' : '–') + kv('Unique traders', String(traders.size))
      + kv('Fees earned by pools', px != null && states.length ? usd(volAll * (states[0].fee / 100)) + ' (paid to liquidity providers)' : '–')));
    // your position and pnl
    const val = px != null ? m.mine * px : null;
    if (px != null) pnlUsd = (val || 0) + gotUsd - spentUsd;
    parts.push(sec('Your position and PnL', kv('Balance', fmt(m.mine) + ' ' + esc(m.name)) + kv('Value now', val != null ? usd(val) : '–') + kv('Bought (pool trades)', usd(spentUsd)) + kv('Sold (pool trades)', usd(gotUsd))
      + kv('PnL', px != null ? `<span style="color:${pnlUsd >= 0 ? '#34d399' : '#f87171'}">${pnlUsd >= 0 ? '+' : ''}${usd(pnlUsd)}</span>` : '–') + '<div class="mut" style="font-size:.74rem;margin-top:.3rem">PnL counts your pool buys and sells plus the value of what you hold. Tokens you minted to yourself count as free, so the figure is your total gain on the token.</div>'));
    put();
    // holders / users
    const pa = new Set(refs.map(r => r.account)), hd = await M.holders(a, m.supply, pa).catch(() => null);
    if (hd) {
      const t10 = hd.top.slice(0, 10).reduce((n, h) => n + (h.share || 0), 0), top1 = hd.top[0];
      parts.push(sec('Users and holders', kv('Holders', fmt(hd.count, 0) + (hd.truncated ? '+' : '')) + kv('Top 10 own', pc(t10 * (t10 <= 1 ? 100 : 1)).replace('+', '')) + kv('Largest holder', top1 ? `${(top1.share || 0) * (top1.share! <= 1 ? 100 : 1) | 0}%` : '–')
        + `<table class="dxt"><thead><tr><th>Holder</th><th class="r">Balance</th><th class="r">Share</th></tr></thead><tbody>${hd.top.slice(0, 10).map(h => `<tr><td class="mono">${esc(short(ctx.showL(h.addr), 6, 4))}${h.tag ? ' <span class="mut">' + esc(h.tag) + '</span>' : ''}</td><td class="r">${fmt(h.bal)}</td><td class="r">${h.share != null ? (h.share * (h.share <= 1 ? 100 : 1)).toFixed(2) + '%' : '–'}</td></tr>`).join('')}</tbody></table>`));
    }
    put();
    // supply history: mints, burns, issuer settings
    const [ai, tx] = await Promise.all([ctx.req('account_info', { account: m.issuer, ledger_index: 'validated' }).catch(() => null), ctx.req('account_tx', { account: m.issuer, limit: 400, ledger_index_min: -1, ledger_index_max: -1 }).catch(() => null)]);
    let minted = 0, burned = 0; const ev: Array<{ t: number; k: string; v: number; who: string }> = [];
    for (const x of (tx && tx.transactions) || []) {
      const t = x.tx || x.tx_json || {}, meta = x.meta || x.metaData || {}; if (t.TransactionType !== 'Payment' || meta.TransactionResult !== 'tesSUCCESS') continue;
      const am = meta.delivered_amount ?? t.Amount ?? t.DeliverMax; if (!am || typeof am !== 'object' || am.currency !== m.cur) continue;
      const v = Number(am.value), ms = ((t.date ?? x.date ?? 0) + 946684800) * 1000;
      if (t.Account === m.issuer) { minted += v; ev.push({ t: ms, k: 'Mint', v, who: t.Destination }); } else if (t.Destination === m.issuer) { burned += v; ev.push({ t: ms, k: 'Burn', v, who: t.Account }); }
    }
    const tr = ai && ai.account_data && ai.account_data.TransferRate ? (Number(ai.account_data.TransferRate) / 1e9 - 1) * 100 : 0;
    parts.push(sec('Supply history', kv('Minted (ever)', fmt(minted)) + kv('Burned (ever)', fmt(burned)) + kv('In circulation', fmt(m.supply)) + kv('Transfer fee on sends', tr > 0 ? tr.toFixed(2) + '%' : 'none') + kv('Issuer', `<span class="mono">${esc(short(ctx.showL(m.issuer), 8, 6))}</span>`)
      + (ev.length ? `<table class="dxt"><thead><tr><th>When</th><th>Type</th><th class="r">Amount</th></tr></thead><tbody>${ev.slice(0, 12).map(e => `<tr><td>${new Date(e.t).toLocaleString()}</td><td>${e.k}</td><td class="r">${fmt(e.v)}</td></tr>`).join('')}</tbody></table>` : '')));
    // recent trades
    recent.sort((x, y) => y.ms - x.ms);
    parts.push(sec('Recent trades', recent.length ? `<table class="dxt"><thead><tr><th>When</th><th>Side</th><th class="r">Amount</th><th class="r">Price</th><th>Trader</th></tr></thead><tbody>${recent.slice(0, 15).map(t => `<tr><td>${new Date(t.ms).toLocaleTimeString()}</td><td style="color:${t.kind === 'buy' ? '#34d399' : '#f87171'}">${t.kind}</td><td class="r">${fmt(t.base)}</td><td class="r">${t.price != null ? fmt(t.price, 6) + ' ' + esc(t.sym) : '–'}</td><td class="mono">${esc(short(ctx.showL(t.who), 5, 4))}</td></tr>`).join('')}</tbody></table>` : '<div class="mut">No trades yet.</div>'));
    // price trend (24h candles)
    if (states.length) {
      const st = states[0], base = akey(st.a) === key ? st.a : st.b, quote = base === st.a ? st.b : st.a;
      const c = await M.candles({ id: M.marketId(base, quote), base, quote, label: '', pool: st }, M.RANGES.find(r => r.k === '1d') as M.RangeDef).catch(() => null);
      if (c && c.list.length > 2) { const cl = c.list.map(x => x.c); parts.splice(1, 0, sec('Price, last 24 hours', SPK(cl, cl[cl.length - 1] >= cl[0]) + kv('Low / high', fmt(Math.min(...c.list.map(x => x.l)), 6) + ' / ' + fmt(Math.max(...c.list.map(x => x.h)), 6) + ' ' + esc(M.labelOf(quote))))); }
    }
    put();
  } catch (e: any) { parts.push(`<div class="crit" style="padding:.6rem">Some analytics could not be read: ${esc(String(e?.message || e))}</div>`); put(); }
}
