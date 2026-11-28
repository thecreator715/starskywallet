// Toolkit "Earn" and "Badges" tabs: yield comparison, interest calendar, liquidation alert, savings goals, achievements and a wallet score.
import { ctx } from './ctx.ts';
import { opGet } from './oproots.ts';
import { esc, fmt, short } from './util.ts';
const rd = (k: string, d: any) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const wr = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } };
const OK = 'starsky.lend.op.', acc = () => ctx.account() || 'x', GK = () => 'starsky.goals.' + acc(), AK = () => 'starsky.hfalert.' + acc();
const chip = (t: string, c: string) => `<span style="display:inline-block;padding:.08rem .5rem;border-radius:99px;font-size:.78rem;background:${c}22;color:${c}">${esc(t)}</span>`;
const GREEN = '#3ddc84', AMB = '#f5b84b', RED = '#ff5b5b';

// ---- pure helpers (unit tested) ----
export interface Goal { name: string; target: number }
export const goalPct = (have: number, target: number) => (target > 0 ? Math.max(0, Math.min(100, (have / target) * 100)) : 0);
export const projectEarn = (supplied: number, apy: number, days: number) => supplied * apy * days / 365;
export const bestMarket = (rows: { asset: string; apy: number }[]) => rows.slice().sort((a, b) => b.apy - a.apy)[0] || null;
export function hfAlert(hf: number | null, debtUsd: number, threshold: number, lastAt: number, now: number, gapMs = 3600e3): boolean { return threshold > 0 && debtUsd > 0 && hf != null && hf < threshold && now - lastAt > gapMs; }
export interface WStats { txs: number; sent: number; received: number; trades: number; lines: number; nfts: number; activated: boolean }
export function achievements(s: WStats): { id: string; name: string; hint: string; done: boolean }[] {
  return [
    { id: 'first', name: 'First steps', hint: 'Wallet activated', done: s.activated }, { id: 'sender', name: 'Sender', hint: 'Send your first payment', done: s.sent >= 1 }, { id: 'receiver', name: 'Receiver', hint: 'Receive a payment', done: s.received >= 1 },
    { id: 'active', name: 'Regular', hint: '25 transactions', done: s.txs >= 25 }, { id: 'veteran', name: 'Veteran', hint: '100 transactions', done: s.txs >= 100 }, { id: 'trader', name: 'Trader', hint: 'Place a trade', done: s.trades >= 1 },
    { id: 'collector', name: 'Collector', hint: 'Hold an NFT', done: s.nfts >= 1 }, { id: 'diverse', name: 'Diversified', hint: 'Hold 3 or more tokens', done: s.lines >= 3 }];
}
export function walletScore(s: WStats): number { if (!s.activated) return 0; return Math.min(100, 20 + Math.min(30, s.txs / 2) + Math.min(15, s.sent * 3) + Math.min(10, s.received * 2) + Math.min(10, s.trades * 2) + Math.min(10, s.lines * 2) + Math.min(5, s.nfts * 5)); }

// ---- state ----
let SNAP: any = null, POS: any = null, ERR = '', WS: WStats | null = null, MSG = '', lastAlert = 0;
async function fetchEarn() {
  try { const r = await opGet('/api/public/lending', undefined, OK); if (r.s >= 400 || !r.j || r.j.error) throw new Error((r.j && r.j.error) || 'The operator answered ' + r.s); SNAP = r.j; ERR = '';
    if (ctx.account()) { const a = await opGet('/api/public/lending/account?addr=' + encodeURIComponent(ctx.account()!), undefined, OK); POS = a.s === 200 ? a.j.position || null : null; } } catch (e: any) { ERR = String(e?.message || e); }
}
async function fetchStats() { const a = ctx.account(); if (!a) return; try { const [tx, ln, nf] = await Promise.all([ctx.req('account_tx', { account: a, limit: 400, ledger_index_min: -1, ledger_index_max: -1 }).catch(() => null), ctx.req('account_lines', { account: a, limit: 400 }).catch(() => null), ctx.req('account_nfts', { account: a, limit: 50 }).catch(() => null)]); const t = (tx?.transactions || []).map((x: any) => x.tx_json || x.tx || {}); WS = { txs: t.length, sent: t.filter((x: any) => x.TransactionType === 'Payment' && x.Account === a).length, received: t.filter((x: any) => x.TransactionType === 'Payment' && x.Destination === a).length, trades: t.filter((x: any) => x.TransactionType === 'OfferCreate').length, lines: (ln?.lines || []).length, nfts: (nf?.account_nfts || []).length, activated: !!tx || !!ln }; } catch { /* keep */ } }

// ---- UI ----
const supplied = () => (POS?.per || []).reduce((a: number, x: any) => a + (x.supplied || 0) * (x.asset === 'LUMA' ? (SNAP?.prices?.LUMA || SNAP?.price || 0) : 1), 0);
const mk = () => Object.entries(SNAP?.stats?.markets || {}).map(([asset, m]: [string, any]) => ({ asset, supply: Number(m.supplyApy || 0), borrow: Number(m.borrowApy || 0), util: Number(m.util || 0) }));
export function earnHtml(): string {
  if (ERR) return `<div class="card c12" style="border:1px solid ${AMB}"><b>Cannot reach the lending operator.</b><div class="mut" style="margin-top:.3rem">${esc(ERR)}</div><button class="sm" style="margin-top:.5rem" onclick="window.tkt.earnLoad()">Try again</button></div>`;
  if (!SNAP) return '<div class="card c12 mut">Loading lending data…</div>';
  const hold = Number(SNAP.params?.holdApr || 0), rows = mk().map(m => ({ ...m, apy: m.supply + hold })), best = bestMarket(rows), E = POS?.earnings, ER = SNAP.rewards;
  const sup = (POS?.per || []) as any[];
  const tbl = `<table style="width:100%"><tr class="mut" style="text-align:left"><th>Asset</th><th>Supply rate</th><th>Hold reward</th><th>Total</th><th>Borrow rate</th></tr>${rows.map(r => `<tr><td><b>${esc(r.asset === 'LUMA' ? ctx.native() : r.asset)}</b> ${best && best.asset === r.asset ? chip('best', GREEN) : ''}</td><td>${(r.supply * 100).toFixed(2)}%</td><td>${(hold * 100).toFixed(1)}%</td><td><b>${(r.apy * 100).toFixed(2)}%</b></td><td>${(r.borrow * 100).toFixed(2)}%</td></tr>`).join('')}</table>`;
  const cal = (() => { const lines: string[] = []; for (const x of sup) { const m = rows.find(r => r.asset === x.asset); if (!m || !(x.supplied > 0)) continue; const nm = x.asset === 'LUMA' ? ctx.native() : x.asset; lines.push(`<tr><td>${esc(nm)}</td><td>${fmt(x.supplied, 4)}</td><td>${fmt(projectEarn(x.supplied, m.apy, 1), 6)}</td><td>${fmt(projectEarn(x.supplied, m.apy, 7), 6)}</td><td>${fmt(projectEarn(x.supplied, m.apy, 30), 6)}</td></tr>`); }
    return `<div class="mut" style="font-size:.82rem;margin:.2rem 0 .5rem">${ER && ER.autoPayHours ? `Hold rewards are paid automatically every ${ER.autoPayHours} h${ER.nextAuto ? `. <b>Next payout: ${esc(new Date(ER.nextAuto).toLocaleString())}</b>` : ''}.` : 'Hold rewards are claimed by you.'} Projections assume today's rates stay the same.</div>${lines.length ? `<table style="width:100%"><tr class="mut" style="text-align:left"><th>Asset</th><th>Supplied</th><th>Per day</th><th>Per week</th><th>Per month</th></tr>${lines.join('')}</table>` : '<div class="mut">You have nothing supplied yet.</div>'}`; })();
  const al = rd(AK(), { thr: 0 }), hf = POS && POS.debtUsd > 0 ? Number(POS.healthFactor) : null;
  const goals: Goal[] = rd(GK(), []), have = supplied();
  return `<div class="card c12"><div class="k">Where to earn the most</div><div class="mut" style="font-size:.82rem;margin:.2rem 0 .5rem">Supply rate plus the hold reward, side by side.</div>${tbl}</div>
  <div class="card c12" style="margin-top:.6rem"><div class="k">Interest calendar</div>${cal}</div>
  <div class="card c12" style="margin-top:.6rem"><div class="k">Liquidation alert</div><div class="mut" style="font-size:.82rem;margin:.2rem 0 .5rem">Starsky warns you when your health factor drops under the number you pick, while it is open. ${hf != null ? `Right now it is <b style="color:${hf < 1.2 ? RED : hf < 1.5 ? AMB : GREEN}">${hf.toFixed(2)}</b>.` : 'You have no loan open.'}</div><div class="row" style="gap:.5rem;align-items:center"><input id="hf_t" inputmode="decimal" placeholder="for example 1.4" value="${al.thr || ''}" size="10"><button class="sm pri" onclick="window.tkt.hfSet()">Save alert</button>${al.thr ? chip('on at ' + al.thr, GREEN) : chip('off', '#9aa0aa')}</div></div>
  <div class="card c12" style="margin-top:.6rem"><div class="k">Savings goals</div><div class="mut" style="font-size:.82rem;margin:.2rem 0 .5rem">Progress counts what you have supplied (${fmt(have, 2)} USD now).</div><div class="row" style="gap:.5rem;flex-wrap:wrap"><input id="sg_n" placeholder="Goal name" size="16"><input id="sg_t" placeholder="Target in USD" size="12"><button class="sm" onclick="window.tkt.goalAdd()">Add goal</button></div>${MSG ? `<div class="mut" style="margin-top:.4rem">${esc(MSG)}</div>` : ''}${goals.map((g, i) => { const p = goalPct(have, g.target); return `<div style="margin-top:.6rem"><div class="row" style="justify-content:space-between"><b>${esc(g.name)}</b><span class="mut">${fmt(have, 2)} of ${fmt(g.target, 2)} USD · ${p.toFixed(0)}%</span></div><div style="height:8px;border-radius:99px;background:rgba(255,255,255,.1);margin:.3rem 0"><div style="height:100%;width:${p}%;border-radius:99px;background:${p >= 100 ? GREEN : '#7c5cff'}"></div></div><button class="sm" onclick="window.tkt.goalRm(${i})">Remove</button></div>`; }).join('')}</div>`;
}
export function badgesHtml(): string {
  if (!WS) return '<div class="card c12 mut">Reading your wallet…</div>';
  const a = achievements(WS), sc = walletScore(WS), col = sc >= 70 ? GREEN : sc >= 40 ? AMB : '#9aa0aa';
  return `<div class="card c12"><div class="row" style="align-items:center;gap:1rem;flex-wrap:wrap"><div><div class="mut" style="font-size:.8rem">Wallet score</div><div style="font-size:2rem;font-weight:800;color:${col}">${sc}<span class="mut" style="font-size:1rem">/100</span></div></div><div class="mut" style="font-size:.82rem;max-width:34rem">A simple measure of how established this wallet is: activity, variety and age of use. It is calculated here from public chain data and is not shared with anyone.</div></div></div>
  <div class="card c12" style="margin-top:.6rem"><div class="k">Achievements</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.5rem;margin-top:.5rem">${a.map(x => `<div style="border:1px solid ${x.done ? GREEN : 'rgba(255,255,255,.12)'};border-radius:12px;padding:.6rem .7rem;opacity:${x.done ? 1 : .55}"><b>${x.done ? '✓ ' : ''}${esc(x.name)}</b><div class="mut" style="font-size:.78rem">${esc(x.hint)}</div></div>`).join('')}</div><div class="mut" style="font-size:.78rem;margin-top:.5rem">${a.filter(x => x.done).length} of ${a.length} earned · ${WS.txs} transactions read</div></div>`;
}
export const tabs: [string, string][] = [['earn', 'Earn & goals'], ['badges', 'Badges & score']];
export const html = (v: string) => (v === 'earn' ? earnHtml() : badgesHtml());
export async function load(v: string) { if (v === 'earn') await fetchEarn(); else await fetchStats(); }
export async function tick() { const al = rd(AK(), { thr: 0 }); if (!(al.thr > 0) || !ctx.account() || !ctx.online() || document.hidden) return; await fetchEarn(); const hf = POS && POS.debtUsd > 0 ? Number(POS.healthFactor) : null;
  if (hfAlert(hf, POS?.debtUsd || 0, al.thr, lastAlert, Date.now())) { lastAlert = Date.now(); const m = `Your loan health factor is ${hf!.toFixed(2)}, under your ${al.thr} alert. Add collateral or repay to stay safe.`; ctx.toast(m, true); try { if ('Notification' in window && Notification.permission === 'granted') new Notification('Starsky: loan health', { body: m }); } catch { /* ignore */ } } }
export function makeApi(repaint: () => void) {
  return {
    async earnLoad() { await fetchEarn(); repaint(); },
    hfSet() { const v = Number((document.getElementById('hf_t') as HTMLInputElement | null)?.value || 0); wr(AK(), { thr: v > 0 ? v : 0 }); try { if (v > 0 && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission(); } catch { /* ignore */ } MSG = v > 0 ? 'Alert saved.' : 'Alert turned off.'; repaint(); },
    goalAdd() { const n = ((document.getElementById('sg_n') as HTMLInputElement | null)?.value || '').trim(), t = Number((document.getElementById('sg_t') as HTMLInputElement | null)?.value || 0); if (!n || !(t > 0)) { MSG = 'Give the goal a name and a target amount.'; return repaint(); } const g: Goal[] = rd(GK(), []); g.push({ name: n, target: t }); wr(GK(), g); MSG = ''; repaint(); },
    goalRm(i: number) { const g: Goal[] = rd(GK(), []); g.splice(i, 1); wr(GK(), g); repaint(); },
  };
}
void short;
