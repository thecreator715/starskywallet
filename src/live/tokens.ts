// Token registry (created tokens), icons stored on the ledger, and the token creator.
import * as xrpl from 'xrpl';
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { Asset, NATIVE, akey, esc, fmt, hexName, nameToCur, short } from './util.ts';
import { cached, clearCache, info, tryReq } from './chain.ts';

export const FEE_LUMA = 10;
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
export const iconOf = (key: string): string => (regCache.find(t => t.key === key) || ({} as any)).icon || '';

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
        const paid = Number(((x.meta || x.metaData || {}).delivered_amount ?? t.Amount) || 0) / 1e6;
        if (paid + 1e-9 < FEE_LUMA) continue;
        const mm = memos(t).find(m => m.type === T_FEE);
        if (!mm) continue;
        try {
          const j = JSON.parse(textOf(mm.data));
          if (!j.c || !j.i) continue;
          const key = akey({ c: j.c, i: j.i });
          if (out.some(o => o.key === key)) continue;
          out.push({ key, a: { c: j.c, i: j.i }, name: String(j.n || hexName(j.c)).slice(0, 24), creator: t.Account, desc: '', site: '', icon: '', ms: t.date ? (t.date + 946684800) * 1000 : 0, hash: t.hash || x.hash || '', supply0: Number(j.s || 0) });
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
              } catch {}
            }
            if (mm.type === T_ICON && !m.icon && /^image\/(webp|png|jpeg)$/.test(mm.fmt)) m.icon = `data:${mm.fmt};base64,${b64(bytesOf(mm.data))}`;
          }
        }
      })
    );
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
}
let F: Form = { name: '', sym: '', supply: '1000000', desc: '', site: '', lock: false };
let ICON: { bytes: Uint8Array; mime: string; url: string } | null = null;
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
  ctx.modal(`<h2>Create a token</h2>
    <p class="mut" style="margin:.2rem 0 .6rem;font-size:.85rem">Creates a new issuer wallet for your token, issues the supply to <b>this wallet</b>, and records the token on the network so it appears under Others with trading and pools.</p>
    <div class="fgrid">
      <input id="tk_name" placeholder="Token name (e.g. Sun Coin)" maxlength="24" value="${esc(F.name)}">
      <input id="tk_sym" placeholder="Symbol (3 letters, or up to 20)" maxlength="20" value="${esc(F.sym)}">
      <input id="tk_sup" placeholder="Total supply to issue" inputmode="decimal" value="${esc(F.supply)}">
      <input id="tk_web" placeholder="Website (optional, https://…)" value="${esc(F.site)}">
    </div>
    <input id="tk_desc" style="width:100%;margin-top:.5rem" placeholder="Short description (optional)" maxlength="200" value="${esc(F.desc)}">
    <div class="row" style="margin-top:.6rem;gap:.8rem;align-items:center"><div id="tk_prev" class="tkicon">${ICON ? `<img src="${ICON.url}">` : '<span class="mut">icon</span>'}</div>
      <div><input id="tk_file" type="file" accept="image/png,image/jpeg,image/webp" onchange="window.tk.icon(this)"><div class="mut" style="font-size:.75rem">Shrunk to a tiny square and stored on the ledger itself (under 760 bytes), so it never depends on a server.</div></div></div>
    <label class="mut" style="display:block;margin:.6rem 0;font-size:.82rem"><input id="tk_lock" type="checkbox" ${F.lock ? 'checked' : ''}> Lock the supply forever (disables the issuer key so nobody can ever issue more. Cannot be undone.)</label>
    ${g ? '' : `<div class="lpcard" style="margin:.5rem 0"><div class="k">Genesis wallet (receives the creation fee)</div><input id="tk_gen" style="width:100%" placeholder="Genesis address (L… / T…)" value="${esc(cand ? ctx.showL(cand) : '')}"><div class="mut" style="font-size:.74rem">${cand ? 'Filled with the largest holder of the native coin, which is normally the genesis wallet. Check it, it is saved for this network.' : 'Paste the genesis address from the control panel.'}</div></div>`}
    <div class="lpcard"><div class="dxkv"><span class="mut">Creation fee to genesis</span><b>${FEE_LUMA} ${esc(ctx.native())}</b></div>
      <div class="dxkv"><span class="mut">Funds for the new issuer wallet (reserve and fees)</span><b>about ${fmt(reserve)} ${esc(ctx.native())}</b></div>
      <div class="dxkv"><span class="mut">Paid from</span><span class="mono">${esc(short(ctx.showL(ctx.account() as string), 8, 6))}</span></div></div>
    <div id="tk_err" class="crit" style="min-height:1.2rem;font-size:.82rem;margin-top:.4rem"></div>
    <div class="row"><button class="grow" onclick="window.closeModal()">Cancel</button><button class="pri acc grow" id="tk_go" onclick="window.tk.create(this)">Create token</button></div>`);
}
const keepForm = () => {
  F = { name: val('tk_name'), sym: val('tk_sym'), supply: val('tk_sup'), desc: val('tk_desc'), site: val('tk_web'), lock: !!$('tk_lock')?.checked };
};
export async function pickIcon(inp: HTMLInputElement) {
  keepForm();
  const err = document.getElementById('tk_err');
  try {
    const f = inp.files && inp.files[0];
    if (!f) return;
    ICON = await prepIcon(f);
    const p = document.getElementById('tk_prev');
    if (p) p.innerHTML = `<img src="${ICON.url}">`;
    if (err) err.textContent = '';
  } catch (e: any) {
    ICON = null;
    if (err) err.textContent = String(e?.message || e);
  }
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
    const i = await info();
    const fund = i.reserveBase + 2 * i.reserveInc + 1;
    btn.disabled = true;
    const steps: [string, string][] = [];
    const draw = () => ctx.modal(`<h2>Creating ${esc(F.name)}</h2><div class="steps">${steps.map(([s, st]) => `<div class="step ${st}"><i>${st === 'ok' ? '✓' : st === 'run' ? '…' : st === 'bad' ? '✕' : '•'}</i>${esc(s)}</div>`).join('')}</div>${steps.some(x => x[1] === 'bad') ? '<button class="grow" onclick="window.closeModal()">Close</button>' : ''}`);
    const names = ['Create the issuer wallet and keep its key in your vault', `Pay the ${FEE_LUMA} ${ctx.native()} creation fee to the genesis wallet`, 'Fund the issuer wallet', 'Set up the issuer (rippling for pools and trading) and record the token details', ...(ICON ? ['Store the icon on the ledger'] : []), 'Open your trust line to the new token', `Issue ${fmt(supply)} ${F.sym} to your wallet`, ...(F.lock ? ['Lock the supply forever'] : [])];
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
    await run(() => ctx.submit({ TransactionType: 'Payment', Account: acc, Destination: g, Amount: String(FEE_LUMA * 1e6), Memos: [{ Memo: { MemoType: hexOf(T_FEE), MemoData: hexOf(JSON.stringify({ v: 1, c: cur, i: issuer.classicAddress, n: F.name, s: supply })) } }] }));
    await run(() => ctx.submit({ TransactionType: 'Payment', Account: acc, Destination: issuer.classicAddress, Amount: String(Math.round(fund * 1e6)) }));
    await run(() =>
      ctx.submitAs(issuer.seed as string, { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: 8, Memos: [{ Memo: { MemoType: hexOf(T_INFO), MemoFormat: hexOf('application/json'), MemoData: hexOf(JSON.stringify({ n: F.name, d: F.desc, w: F.site })) } }] })
    );
    if (ICON) {
      const ic = ICON;
      await run(() => ctx.submitAs(issuer.seed as string, { TransactionType: 'AccountSet', Account: issuer.classicAddress, Memos: [{ Memo: { MemoType: hexOf(T_ICON), MemoFormat: hexOf(ic.mime), MemoData: Array.from(ic.bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase() } }] }));
    }
    await run(() => ctx.submit({ TransactionType: 'TrustSet', Account: acc, LimitAmount: { currency: cur, issuer: issuer.classicAddress, value: String(supply) } }));
    await run(() => ctx.submitAs(issuer.seed as string, { TransactionType: 'Payment', Account: issuer.classicAddress, Destination: acc, Amount: { currency: cur, issuer: issuer.classicAddress, value: String(supply) } }));
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
    F = { name: '', sym: '', supply: '1000000', desc: '', site: '', lock: false };
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
export const tkApi: any = { openCreate, create, icon: pickIcon, openPool };
