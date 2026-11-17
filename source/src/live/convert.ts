// Convert all tokens to the native coin (LUMA). Pure planning functions are exported and tested; the card lives on Portfolio.
// Each token is its own swap, signed in order. Nothing runs without a preview. NFTs are never touched.
import { ctx } from './ctx.ts';
import { esc, hexName, NATIVE, amtTx, akey, type Asset } from './util.ts';
import * as M from './market.ts';
import * as More from './more.ts';

export interface Hold { key: string; name: string; bal: number; a: Asset; lp?: boolean }
export interface Q { out: number; impact: number; src: string }
export type RowState = 'ok' | 'impact' | 'none' | 'dust';
export interface Row { key: string; name: string; bal: number; out: number; impact: number; src: string; state: RowState; reason: string; run: boolean }
export const DEFAULT_SLIP = 1;

/** Decide what happens to each token. impactLimit is a percent; a token over it is skipped unless named in override. */
export function planConvert(holds: Hold[], quotes: Record<string, Q | null>, impactLimit = DEFAULT_SLIP, override: Set<string> = new Set(), unchecked: Set<string> = new Set()): { rows: Row[]; total: number; count: number } {
  const rows: Row[] = holds.map(h => {
    const q = quotes[h.key];
    const base = { key: h.key, name: h.name, bal: h.bal, out: 0, impact: 0, src: '', run: false };
    if (!(h.bal > 0)) return { ...base, state: 'dust' as RowState, reason: 'Nothing to convert.' };
    if (h.lp) return { ...base, state: 'none' as RowState, reason: 'This is a pool share. Withdraw it from the Pools page instead.' };
    if (!q || !(q.out > 0)) return { ...base, state: 'none' as RowState, reason: 'No route to LUMA or not enough liquidity.' };
    const imp = q.impact * 100, over = imp > impactLimit;
    const st: RowState = over && !override.has(h.key) ? 'impact' : 'ok';
    return { ...base, out: q.out, impact: imp, src: q.src, state: st, reason: st === 'impact' ? `Price impact ${imp.toFixed(2)}% is above your ${impactLimit}% limit.` : '', run: st === 'ok' && !unchecked.has(h.key) };
  });
  const sel = rows.filter(r => r.run);
  return { rows, total: sel.reduce((t, r) => t + r.out, 0), count: sel.length };
}
/** the least the swap may return: quote minus the slippage allowance, never zero */
export const minOut = (out: number, slipPct: number) => Math.max(1e-9, out * (1 - slipPct / 100));
/** big conversions need a typed word, like big payments */
export const needsTyping = (total: number, threshold: number) => threshold > 0 && total >= threshold;
/** network fees for n swaps (one transaction each) plus optional line removals */
export const feeTotal = (n: number, fee: number, removals = 0) => +(fee * (n + removals)).toFixed(8);

const CV: any = { holds: [] as Hold[], quotes: {} as Record<string, Q | null>, slip: DEFAULT_SLIP, over: new Set<string>(), off: new Set<string>(), clean: false, busy: false, log: [] as string[], loaded: false };
const $ = (id: string) => document.getElementById(id);
const num = (n: number, d = 4) => Number(n).toLocaleString('en', { maximumFractionDigits: d });

async function holdings(): Promise<Hold[]> {
  const r: any = await ctx.req('account_lines', { account: ctx.account(), limit: 400 });
  return ((r && r.lines) || []).filter((l: any) => Number(l.balance) > 0).map((l: any) => ({ key: akey({ c: l.currency, i: l.account }), name: hexName(l.currency), bal: Number(l.balance), a: { c: l.currency, i: l.account }, lp: !!M.lpPoolOf({ c: l.currency, i: l.account }) }));
}
async function quoteAll() {
  CV.quotes = {};
  await Promise.all(CV.holds.map(async (h: Hold) => {
    if (h.lp) { CV.quotes[h.key] = null; return; }
    try { const q = await M.quote({ id: h.key + '/native', base: h.a, quote: NATIVE, label: h.name, pool: null } as any, 'sell', h.bal); CV.quotes[h.key] = q ? { out: q.out, impact: q.impact, src: q.src } : null; } catch { CV.quotes[h.key] = null; }
  }));
}
function plan() { return planConvert(CV.holds, CV.quotes, CV.slip, CV.over, CV.off); }
function html(): string {
  if (!CV.loaded) return `<div class="k" style="margin:0">Convert to ${esc(ctx.native())}</div><div class="mut" style="margin-top:.4rem">Reading your tokens and live prices…</div>`;
  if (!CV.holds.length) return `<div class="k" style="margin:0">Convert to ${esc(ctx.native())}</div><div class="mut" style="margin-top:.4rem">You hold no tokens, so there is nothing to convert. NFTs are never converted.</div>`;
  const p = plan(), n = ctx.native();
  const rows = p.rows.map(r => `<tr style="${r.state === 'ok' ? '' : 'opacity:.55'}"><td><input type="checkbox" ${r.run ? 'checked' : ''} ${r.state === 'ok' || (r.state === 'impact') ? '' : 'disabled'} onchange="window.xcv.tog('${esc(r.key)}',this.checked)" aria-label="Convert ${esc(r.name)}"></td><td><b>${esc(r.name)}</b><div class="mut" style="font-size:.74rem">${esc(num(r.bal))} held</div></td><td class="mono" style="text-align:right">${r.out ? esc(num(r.out)) + ' ' + esc(n) : '–'}</td><td style="font-size:.78rem">${r.state === 'ok' ? `<span class="mut">impact ${r.impact.toFixed(2)}% · ${esc(r.src)}</span>` : `<span class="${r.state === 'impact' ? 'warnc' : 'dn'}">${esc(r.reason)}</span>${r.state === 'impact' ? ` <a href="#" onclick="window.xcv.over('${esc(r.key)}');return false">Convert anyway</a>` : ''}`}</td></tr>`).join('');
  const fee = feeTotal(p.count, 0.00001, CV.clean ? p.count : 0);
  return `<div class="row" style="justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap"><div><div class="k" style="margin:0">Convert to ${esc(n)}</div><div class="mut" style="font-size:.78rem">Swap tokens you pick into ${esc(n)}. Prices are live; each swap is its own transaction.</div></div><button class="sm ghost" onclick="window.xcv.load()">Refresh prices</button></div>
  <div style="overflow:auto;margin-top:.5rem"><table class="hxt" style="width:100%;font-size:.82rem"><tbody>${rows}</tbody></table></div>
  <div class="row" style="gap:.8rem;align-items:center;flex-wrap:wrap;margin-top:.6rem"><label style="font-size:.8rem">Price impact limit <input id="xcv_slip" type="number" min="0.1" max="50" step="0.1" value="${CV.slip}" style="width:4.5rem" onchange="window.xcv.slip(this.value)"> %</label><label style="font-size:.8rem"><input type="checkbox" ${CV.clean ? 'checked' : ''} onchange="window.xcv.clean(this.checked)"> Remove the emptied token lines afterwards (frees reserve)</label></div>
  <div style="margin-top:.6rem;font-size:.9rem">You get about <b>${esc(num(p.total))} ${esc(n)}</b> from ${p.count} token${p.count === 1 ? '' : 's'} · network fees about ${esc(String(fee))} ${esc(n)}</div>
  <button class="pri" style="margin-top:.5rem" id="xcv_go" ${p.count && !CV.busy ? '' : 'disabled'} onclick="window.xcv.go()">Review and convert</button>
  <div id="xcv_log" class="mut" style="font-size:.8rem;margin-top:.5rem">${CV.log.map((l: string) => `<div>${esc(l)}</div>`).join('')}</div>
  <div class="mut" style="font-size:.74rem;margin-top:.4rem">Swaps cannot be undone once validated. Token lines with no market, or that you tick off, are left alone.</div>`;
}
const paint = () => { const e = $('xconv'); if (e) e.innerHTML = html(); };
async function load() { CV.loaded = false; paint(); try { if (!ctx.account() || !ctx.online()) { CV.holds = []; CV.loaded = true; paint(); return; } CV.holds = await holdings(); await quoteAll(); } catch { CV.holds = []; } CV.loaded = true; paint(); }
const say = (m: string) => { CV.log.push(m); const e = $('xcv_log'); if (e) e.innerHTML = CV.log.map((l: string) => `<div>${esc(l)}</div>`).join(''); };

export const xcv = {
  load, tog(k: string, on: boolean) { on ? CV.off.delete(k) : CV.off.add(k); paint(); },
  over(k: string) { CV.over.add(k); paint(); }, slip(v: string) { const x = parseFloat(v); if (x > 0 && x <= 50) CV.slip = x; paint(); },
  clean(on: boolean) { CV.clean = on; paint(); },
  async go() {
    if (CV.busy) return; const p = plan(); if (!p.count) return;
    const lines = p.rows.filter(r => r.run).map(r => `${num(r.bal)} ${r.name} → about ${num(r.out)} ${ctx.native()} (impact ${r.impact.toFixed(2)}%)`);
    if (!confirm(`Convert ${p.count} token${p.count === 1 ? '' : 's'} to ${ctx.native()}?\n\n${lines.join('\n')}\n\nTotal about ${num(p.total)} ${ctx.native()}. Each swap needs at least ${100 - CV.slip}% of the quote. This cannot be undone.`)) return;
    if (needsTyping(p.total, More.bigThreshold())) { const w = prompt(`This is a large conversion (about ${num(p.total)} ${ctx.native()}). Type CONVERT to go on:`); if (!w || w.trim().toUpperCase() !== 'CONVERT') { ctx.toast('Cancelled: nothing was converted.', true); return; } }
    CV.busy = true; CV.log = []; paint();
    let ok = 0, done: string[] = [];
    for (const r of p.rows.filter(x => x.run)) {
      const h = CV.holds.find((x: Hold) => x.key === r.key) as Hold;
      try {
        const q = await M.quote({ id: h.key + '/native', base: h.a, quote: NATIVE, label: h.name, pool: null } as any, 'sell', h.bal);
        if (!q || q.impact * 100 > Math.max(CV.slip, CV.over.has(h.key) ? 100 : 0)) { say(`${r.name}: skipped, the price moved (${q ? (q.impact * 100).toFixed(2) + '% impact' : 'no liquidity'}).`); continue; }
        const res = await ctx.submit({ TransactionType: 'OfferCreate', Account: ctx.account(), TakerGets: amtTx(h.a, h.bal), TakerPays: amtTx(NATIVE, minOut(q.out, CV.slip)), Flags: 0x00080000 | 0x00020000 });
        if (res.ok) { ok++; done.push(h.key); say(`✓ ${r.name} converted`); } else say(`${r.name}: not converted (${res.msg || 'rejected'}). The rest continue.`);
      } catch (e: any) { say(`${r.name}: not converted (${String(e?.message || e)}). The rest continue.`); }
    }
    if (CV.clean && done.length) {
      const bal: any = await ctx.req('account_lines', { account: ctx.account(), limit: 400 }).catch(() => null);
      for (const l of ((bal && bal.lines) || []).filter((x: any) => done.includes(akey({ c: x.currency, i: x.account })) && Number(x.balance) === 0)) {
        const res = await ctx.submit({ TransactionType: 'TrustSet', Account: ctx.account(), LimitAmount: { currency: l.currency, issuer: l.account, value: '0' }, Flags: 0x00020000 });
        say(res.ok ? `✓ ${hexName(l.currency)} line removed` : `${hexName(l.currency)} line kept (${res.msg || 'still has a balance or an open order'}).`);
      }
    }
    CV.busy = false; ctx.toast(`${ok} of ${p.count} converted`); await load();
  }
};
export function onRender(tab: string) {
  if (tab !== 'home') return;
  if ($('xconv')) return;
  const pa = $('pa')?.closest('.card'); if (!pa) return;
  const c = document.createElement('div'); c.id = 'xconv'; c.className = 'card c12'; c.style.marginTop = '.8rem'; pa.insertAdjacentElement('afterend', c);
  (window as any).xcv = xcv; load();
}
