// Tokens of the XRPL wallet: XRP, every trust line, and RLUSD / MINT / MAGIC (one click to add the trust line). Read straight from the XRPL node.
import { ctx } from './ctx.ts';
import { esc, fmt, hexName, short, usd } from './util.ts';
import { tryReq } from './chain.ts';
import { xrplLaneAssets } from './bridge.ts';

const sameCur = (a: string, b: string) => String(a).toUpperCase() === String(b).toUpperCase() || hexName(a) === hexName(b);
let busy = false;
export async function loadXAssets(setHtml: (id: string, h: string) => void) {
  if (busy) return;
  busy = true;
  try {
    const acc = ctx.account();
    if (!acc) { setHtml('pa', '<div class="mut" style="padding:1rem">No XRPL wallet selected. Wallets → XRPL → add or import one.</div>'); return; }
    const [ai, al, lanes, ob] = await Promise.all([tryReq('account_info', { account: acc, ledger_index: 'validated' }), tryReq('account_lines', { account: acc, ledger_index: 'validated', limit: 400 }), xrplLaneAssets(), tryReq('account_objects', { account: acc, type: 'nft_offer', ledger_index: 'validated', limit: 10 })]);
    void ob;
    const lines: any[] = (al && al.lines) || [];
    const xrp = ai && ai.account_data ? Number(ai.account_data.Balance) / 1e6 : null;
    const rows: string[] = [];
    rows.push(`<tr><td><b>XRP</b><div class="mut" style="font-size:.74rem">native</div></td><td class="r">${xrp == null ? '<span class="mut">not activated (needs 1 XRP reserve)</span>' : fmt(xrp, 6)}</td><td class="mut">–</td><td></td></tr>`);
    const shown = new Set<string>();
    for (const w of lanes) {
      const l = lines.find(z => z.account === w.issuer && sameCur(z.currency, w.code));
      shown.add((l && l.account + '|' + l.currency) || '');
      const bal = l ? Number(l.balance) : 0;
      const isUsd = w.name === 'RLUSD';
      rows.push(`<tr><td><b>${esc(w.name)}</b><div class="mut" style="font-size:.74rem">issuer ${esc(short(w.issuer, 6, 5))}</div></td><td class="r">${l ? fmt(bal, 6) : '<span class="mut">no trust line</span>'}</td><td class="r">${isUsd && l ? usd(bal) : '<span class="mut">no market price yet</span>'}</td><td class="r">${l ? '' : `<button class="sm pri" onclick="window.xa.trust('${esc(w.code)}','${esc(w.issuer)}',this)">Add trust line</button>`}</td></tr>`);
    }
    for (const l of lines) {
      if (shown.has(l.account + '|' + l.currency)) continue;
      rows.push(`<tr><td><b>${esc(hexName(l.currency))}</b><div class="mut" style="font-size:.74rem">issuer ${esc(short(l.account, 6, 5))}</div></td><td class="r">${fmt(Number(l.balance), 6)}</td><td class="mut">–</td><td></td></tr>`);
    }
    setHtml('pa', `<table class="dxt"><thead><tr><th>Token</th><th class="r">Balance</th><th class="r">Value</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table><div class="mut" style="font-size:.76rem;margin-top:.5rem">Read from the XRPL node for ${esc(short(acc, 8, 6))}. Reserve: 1 XRP + 0.2 XRP per trust line. MINT and MAGIC have no market price yet, they move 1:1 through the bridge.</div>`);
  } catch (e: any) {
    setHtml('pa', `<div class="mut" style="padding:1rem">Could not read the XRPL node: ${esc(e?.message || e)}. Check Bridge → XRPL node.</div>`);
  } finally { busy = false; }
}
export const xaApi = {
  async trust(code: string, issuer: string, btn: HTMLButtonElement) {
    btn.disabled = true;
    const r = await ctx.submit({ TransactionType: 'TrustSet', Account: ctx.account(), LimitAmount: { currency: code, issuer, value: '1000000000000' } });
    if (r.ok) ctx.toast('✓ Trust line added'); else { ctx.toast('Rejected: ' + (r.msg || 'failed'), true); btn.disabled = false; }
    ctx.rerender();
  },
};
