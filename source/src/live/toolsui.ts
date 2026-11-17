// On-screen planners for the leverage, bot, NFT and NFT-loan toolkits. Each planner reads what you type, shows results at once,
// and never sends anything. Cards are added to the Margin, Trading Bot and NFT pages.
import { ctx } from './ctx.ts';
import { esc } from './util.ts';
import * as L from './levplus.ts';
import * as B from './botplus.ts';
import * as N from './nftplus.ts';
import * as NL from './nftloan.ts';

const $ = (id: string) => document.getElementById(id);
const v = (id: string) => { const e = $(id) as HTMLInputElement | null; return e ? e.value : ''; };
const f = (id: string) => Number(v(id));
const row = (id: string, label: string, val: string | number, w = '6rem', type = 'number') => `<label class="mut" style="font-size:.76rem;display:flex;flex-direction:column;gap:.15rem">${esc(label)}<input id="${id}" type="${type}" value="${esc(String(val))}" style="width:${w}" oninput="window.xtl.go()"></label>`;
const sel = (id: string, label: string, opts: Array<[string, string]>) => `<label class="mut" style="font-size:.76rem;display:flex;flex-direction:column;gap:.15rem">${esc(label)}<select id="${id}" onchange="window.xtl.go()">${opts.map(([a, b]) => `<option value="${a}">${esc(b)}</option>`).join('')}</select></label>`;
const line = (ok: boolean | null, t: string) => `<div style="font-size:.82rem;${ok === false ? 'color:var(--crit)' : ok ? 'color:var(--ok)' : ''}">${ok === null ? '•' : ok ? '✓' : '✗'} ${esc(t)}</div>`;
const num = (n: number, d = 4) => Number(n).toLocaleString('en', { maximumFractionDigits: d });

function levHtml() {
  return `<div class="k" style="margin:0">Leverage planner</div><div class="mut" style="font-size:.78rem;margin:.2rem 0 .5rem">Plan a position before you open it. Nothing is sent from here.</div>
  <div class="row" style="gap:.6rem;flex-wrap:wrap">${sel('lv_dir', 'Direction', [['L', 'Long'], ['S', 'Short']])}${row('lv_pe', 'Entry price', 100)}${row('lv_lev', 'Leverage ×', 5, '4.5rem')}${row('lv_coll', 'Collateral', 10)}${row('lv_sl', 'Stop (0 = none)', 0)}${row('lv_tp', 'Target (0 = none)', 0)}${row('lv_eq', 'Your equity', 100)}${row('lv_risk', 'Risk % per trade', 1, '4.5rem')}${row('lv_vol', 'Daily move %', 3, '4.5rem')}</div><div id="lv_out" style="margin-top:.6rem"></div>`;
}
function levOut() {
  const p = { pe: f('lv_pe'), lev: f('lv_lev'), coll: f('lv_coll'), long: v('lv_dir') !== 'S' }, sl = f('lv_sl'), tp = f('lv_tp'), eq = f('lv_eq'), n = p.coll * p.lev;
  if (!(p.pe > 0 && p.lev >= 1 && p.coll > 0)) return '<div class="mut">Enter an entry price, leverage and collateral.</div>';
  const d = L.liqDistancePct(p), st = L.bufferStatus(d), size = sl > 0 ? L.sizeFromRisk(eq, f('lv_risk'), p.pe, sl, p.lev) : null, ft = L.fundingTable(n);
  const chk = L.checklist({ p, sl, tp, equity: eq, balance: eq, poolTvl: 0 }), str = L.stress(p);
  return `${line(null, L.words(p, sl, tp, 'this asset', ctx.native()))}${line(st === 'safe' || st === 'watch' ? true : false, `Liquidation at ${num(L.liq(p))}, ${d}% from entry. ${L.statusText(st)}`)}
  ${line(null, `Break-even after fees and 24 h of funding: ${num(L.breakEven(p, 24))}. Funding costs about ${num(ft.day)} a day, ${num(ft.week)} a week.`)}
  ${sl > 0 && tp > 0 ? line(null, `Reward to risk ${L.rr(p.pe, sl, tp)} : 1`) : ''}${size ? line(size.why ? false : true, size.why || `To risk ${f('lv_risk')}% of your equity at that stop, open ${num(size.notional)} notional (${num(size.coll)} collateral at ${p.lev}×).`) : ''}
  ${line(null, `Highest leverage that keeps liquidation 10% away: ${L.maxSafeLev(10)}×. For a ${f('lv_vol')}% daily move, presets: safe ${L.presets(f('lv_vol') || 3).safe}×, normal ${L.presets(f('lv_vol') || 3).normal}×, aggressive ${L.presets(f('lv_vol') || 3).aggressive}×.`)}
  <details style="margin-top:.4rem"><summary class="mut" style="cursor:pointer;font-size:.8rem">Checklist and stress test</summary>${chk.map(c => line(c.ok, c.text)).join('')}${str.map(s => line(!s.liquidated, `If price moves ${s.shock}% (${num(s.price)}): ${s.liquidated ? 'liquidated, you lose the collateral' : 'equity ' + num(s.equity)}`)).join('')}</details>`;
}
function botHtml() {
  return `<div class="k" style="margin:0">Bot planner</div><div class="mut" style="font-size:.78rem;margin:.2rem 0 .5rem">Check a plan, then test the trend-following rule on prices you paste. Nothing is sent from here.</div>
  <div class="row" style="gap:.6rem;flex-wrap:wrap">${row('bp_low', 'Range low', 90)}${row('bp_high', 'Range high', 110)}${row('bp_lv', 'Levels', 10, '4rem')}${row('bp_amt', 'Amount', 100)}${row('bp_bal', 'Your balance', 300)}${row('bp_px', 'Price now', 100)}${row('bp_fee', 'Fee %', 0.1, '4rem')}${sel('bp_mode', 'Spacing', [['arith', 'Even'], ['geo', 'Percent']])}${sel('bp_stop', 'Stop condition', [['1', 'Max loss set'], ['0', 'None']])}</div>
  <label class="mut" style="font-size:.76rem;display:block;margin-top:.5rem">Closing prices to test (comma separated, at least 40)<textarea id="bp_closes" rows="2" style="width:100%" oninput="window.xtl.go()" placeholder="e.g. 100, 101, 99.5, …"></textarea></label><div id="bp_out" style="margin-top:.6rem"></div>`;
}
function botOut() {
  const low = f('bp_low'), high = f('bp_high'), lv = Math.max(2, Math.floor(f('bp_lv'))), fee = f('bp_fee'), px = f('bp_px');
  const lvls = B.gridLevels(low, high, lv, v('bp_mode') === 'geo' ? 'geo' : 'arith'), chk = B.setupCheck({ amount: f('bp_amt'), balance: f('bp_bal'), levels: lv, low, high, feePct: fee, price: px, hasStop: v('bp_stop') === '1' }), plan = B.gridPlan(lvls, px);
  let h = chk.problems.map(x => line(false, x)).join('') + chk.warnings.map(x => line(null, '⚠ ' + x)).join('');
  if (lvls.length) h += line(null, `${lvls.length} levels, ${B.gridSpacingPct(lvls)}% apart. ${plan.buys.length} buy and ${plan.sells.length} sell orders at the start. About ${num(B.gridProfitPerCycle(lvls, f('bp_amt') / lv, fee))} profit per completed cycle.`) + line(null, B.botWords('grid', { low, high, levels: lv, amount: f('bp_amt') }));
  const c = v('bp_closes').split(/[\s,]+/).map(Number).filter(x => x > 0);
  if (c.length >= 40) { const r = B.backtest(c, s => B.smaCross(s, 5, 20), 1000, fee, 25), w = B.walkForward(c, s => B.smaCross(s, 5, 20)); h += line(r.beatsHold, `Trend rule on your prices: ${r.returnPct}% over ${r.trades} trades, worst fall ${r.maxDrawdownPct}%, versus ${r.buyHoldPct}% for just holding.`) + (w.warn ? line(false, w.warn) : ''); } else if (c.length) h += line(null, 'Paste at least 40 prices to run the test.');
  return h || '<div class="mut">Fill in the plan above.</div>';
}
function nftHtml() {
  return `<div class="k" style="margin:0">NFT tools</div><div class="mut" style="font-size:.78rem;margin:.2rem 0 .5rem">Price a sale, plan a Dutch auction or auto-lower rule, size a loan, and dry-run a batch listing. Nothing is sent from here.</div>
  <div class="row" style="gap:.6rem;flex-wrap:wrap">${row('nt_price', 'Sale price', 100)}${row('nt_fee', 'Market fee %', 0)}${row('nt_roy', 'Royalty %', 5, '4.5rem')}${row('nt_floor', 'Floor', 80)}${row('nt_last', 'Last sale', 90)}${row('nt_pct', 'Rarity top %', 20, '4.5rem')}${row('nt_min', 'Lowest price you accept', 60)}${row('nt_step', 'Lower by % per step', 5, '4.5rem')}${row('nt_steps', 'Steps', 4, '4rem')}</div>
  <div class="row" style="gap:.6rem;flex-wrap:wrap;margin-top:.4rem">${row('nl_amt', 'Loan amount', 30)}${row('nl_apr', 'Interest % a year', 20, '4.5rem')}${row('nl_days', 'Days', 30, '4rem')}</div>
  <label class="mut" style="font-size:.76rem;display:block;margin-top:.5rem">Batch listing, one per line: NFT id, price, days (optional)<textarea id="nt_csv" rows="2" style="width:100%" oninput="window.xtl.go()"></textarea></label><div id="nt_out" style="margin-top:.6rem"></div>`;
}
function nftOut() {
  const price = f('nt_price'), pr = N.proceeds(price, f('nt_fee') * 100, f('nt_roy') * 1000), sg = N.suggestPrice(f('nt_floor') || null, f('nt_pct') || null, f('nt_last') || null);
  let h = line(null, `You sell for ${num(price)}: market fee ${num(pr.fee)}, creator royalty ${num(pr.royalty)}, you receive ${num(pr.net)} ${ctx.native()}.`);
  h += line(null, sg.price == null ? sg.basis : `Suggested price ${num(sg.price)} (${sg.basis}).`);
  h += line(null, `Auto-lower rule: ${[0, 1, f('nt_steps')].map(k => num(N.autoLower(price, f('nt_step'), f('nt_min'), k))).join(' → ')} after 0, 1 and ${f('nt_steps')} steps, never below ${num(f('nt_min'))}. It only runs while the wallet is open.`);
  h += line(null, `Dutch auction from ${num(price)} down to ${num(f('nt_min'))}: halfway through it is ${num(N.dutchPrice(price, f('nt_min'), 0, 2, 1))}.`);
  const val = NL.safeValuation(f('nt_floor') || null, f('nt_last') || null, null), t = { principal: f('nl_amt'), aprPct: f('nl_apr'), days: f('nl_days'), valuation: val || 0 }, vd = NL.validate(t);
  h += line(vd.ok, val == null ? 'Loan: no floor or last sale, so no valuation.' : `Loan: valuation ${num(val)} (the lowest known). The most you can borrow is ${num(NL.maxPrincipal(val))}. ${vd.ok ? 'Repay ' + num(NL.repayAmount(t)) + ' after ' + t.days + ' days.' : vd.problems.join(' ')}`) + vd.warnings.map(w => line(null, '⚠ ' + w)).join('') + line(null, 'Loans are a plan only for now: the escrow step that locks the NFT is not live, so nothing can be borrowed yet.');
  const rows = v('nt_csv').trim() ? N.parseBatch(v('nt_csv'), new Set(v('nt_csv').split(/\r?\n/).map(l => l.split(',')[0].trim()))) : null; if (rows) h += rows.bad.map(b => line(false, b)).join('') + line(rows.bad.length ? null : true, `${rows.ok.length} line${rows.ok.length === 1 ? '' : 's'} look right. Ownership is checked when you list.`);
  return h;
}
const CARDS: Record<string, { id: string; html: () => string; out: string; fn: () => string; at: string }> = {
  margin: { id: 'xlev', html: levHtml, out: 'lv_out', fn: levOut, at: 'view' }, bot: { id: 'xbot', html: botHtml, out: 'bp_out', fn: botOut, at: 'view' },
  nfts: { id: 'xnft', html: nftHtml, out: 'nt_out', fn: nftOut, at: 'view' }, nftmarket: { id: 'xnft', html: nftHtml, out: 'nt_out', fn: nftOut, at: 'view' }
};
let cur = '';
export const xtl = { go() { const c = CARDS[cur]; const o = c && $(c.out); if (o) { try { o.innerHTML = c.fn(); } catch (e: any) { o.innerHTML = `<div class="dn">${esc(e?.message || e)}</div>`; } } } };
export function onRender(tab: string) {
  const c = CARDS[tab]; if (!c) return; cur = tab; (window as any).xtl = xtl;
  if ($(c.id)) return; const host = $(c.at); if (!host) return;
  const d = document.createElement('details'); d.id = c.id; d.className = 'card'; d.style.marginTop = '.8rem';
  d.innerHTML = `<summary style="cursor:pointer;font-weight:600">${tab === 'margin' ? 'Leverage planner' : tab === 'bot' ? 'Bot planner' : 'NFT tools'}</summary><div style="margin-top:.6rem">${c.html()}</div>`;
  host.appendChild(d); xtl.go();
}
