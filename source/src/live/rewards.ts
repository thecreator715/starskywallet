// Holder rewards. Every priced token earns a yearly rate on the balance of the connected wallet (LUMA 10%, everything else 5%, the operator can change both).
// Rewards are paid in LUMA from the genesis wallet. The decision is made by the operator's control panel, never here: this page only (1) reads what the panel says is earned,
// (2) ticks the counter up locally between refreshes, and (3) to collect, signs a one-time message with the wallet's own key.
import { sign } from 'ripple-keypairs';
import * as xrpl from 'xrpl';
import { ctx } from './ctx.ts';
import { esc, fmt, usd } from './util.ts';
import { base } from './nodelink.ts';

const $ = (id: string) => document.getElementById(id);
const net = () => (ctx.netKey() === 'test' ? 'test' : 'main');
const roots = (): string[] => { const k = net(), port = k === 'test' ? 8091 : 8090; const c = (window as any).STARSKY_CONFIG || {}, pn = String((c[k] || c.main || {}).panel || '').replace(/\/+$/, '');
  const r = [`${base()}/panel/${k}`]; if (pn) r.push(pn); r.push(`http://127.0.0.1:${port}`, `http://localhost:${port}`); return r; };
let RIGHT = 0;
async function call(p: string, init?: RequestInit): Promise<any> {
  const rs = roots(), tried: string[] = [];
  for (let n = 0; n < rs.length; n++) {
    const i = (RIGHT + n) % rs.length, u = `${rs[i]}/api/public/rewards/${p}`;
    try {
      const r = await fetch(u, { ...init, cache: 'no-store' }); const txt = await r.text().catch(() => ''); let j: any = null; try { j = JSON.parse(txt); } catch {}
      if (j && typeof j === 'object') { RIGHT = i; return j; }
      if (r.status === 429) throw new Error('Too many tries from your network. Wait a little and try again.');
      tried.push(`${new URL(u).host}: ${r.status === 404 ? 'this node has no rewards service yet (update the control panel to the latest lumanet)' : 'answered ' + r.status}`);
    } catch (e: any) { if (/Too many/.test(e.message)) throw e; tried.push(`${(() => { try { return new URL(u).host; } catch { return u; } })()}: not reachable`); }
  }
  throw new Error('The rewards service did not answer. ' + tried.join(' · '));
}
const enc = new TextEncoder();
const hexOf = (s: string) => Array.from(enc.encode(s)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const post = (p: string, body: any) => call(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

interface St { d: any; err: string; busy: boolean; step: string; done: any; at: number; addr: string; loading: boolean }
const S: St = { d: null, err: '', busy: false, step: '', done: null, at: 0, addr: '', loading: false };
let timer: any = 0, refresh: any = 0;

const myAddr = (): string => { try { const a = ctx.account(); return a ? a : ''; } catch { return ''; } };
const walletOf = (): { seed: string; classic: string } | null => {
  const addr = myAddr(); if (!addr) return null;
  const w = ctx.wallets().find(x => { try { return ctx.toClassic(x.address) === addr && x.type !== 'xrpl'; } catch { return false; } });
  return w && w.seed ? { seed: w.seed, classic: addr } : null;
};
const ago = (t: number) => { const s = Math.max(1, Math.round((Date.now() - t) / 1000)); return s < 90 ? s + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
const f6 = (n: number) => (Number(n) || 0).toLocaleString('en', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
const pend = () => { const d = S.d; if (!d || !d.ok || !d.exists) return 0; return d.pending + (d.rate || 0) * Math.max(0, (Date.now() - S.at) / 1000); };

export function shell() { return `<div id="rw" class="grid"><div class="card c12"><div class="k">Rewards</div><div class="muted" style="margin-top:.4rem">Loading…</div></div></div>`; }

function paint() {
  const el = $('rw'); if (!el) return;
  const d = S.d;
  if (ctx.xrpl()) { el.innerHTML = `<div class="card c12"><div class="k">Rewards</div><div class="muted" style="margin-top:.4rem">Rewards are paid to LUMA wallets. Switch the wallet type to LUMA.</div></div>`; return; }
  if (!myAddr()) { el.innerHTML = `<div class="card c12"><div class="k">Rewards</div><div class="muted" style="margin-top:.4rem">Create or open a LUMA wallet to see your rewards.</div></div>`; return; }
  if (!d) { el.innerHTML = `<div class="card c12"><div class="k">Rewards</div><div class="${S.err ? 'dn' : 'muted'}" style="margin-top:.4rem">${esc(S.err || 'Loading…')}</div><div style="margin-top:.6rem"><button class="sm" onclick="window.rw.load()">Try again</button></div></div>`; return; }
  if (!d.ok) { el.innerHTML = `<div class="card c12"><div class="k">Rewards</div><div class="dn" style="margin-top:.4rem">${esc(d.error || 'Could not read your rewards.')}</div><div style="margin-top:.6rem"><button class="sm" onclick="window.rw.load()">Try again</button></div></div>`; return; }
  const c = d.cfg, w = walletOf();
  const rate = d.rate || 0, perDay = rate * 86400, lu = d.lumaUsd || 0, totL = (d.rows || []).reduce((s: number, r: any) => s + r.valueLuma, 0), totU = (d.rows || []).reduce((s: number, r: any) => s + r.valueUsd, 0);
  let action = '';
  if (!d.exists || d.excluded) action = `<div class="muted">${esc(d.message || '')}</div>`;
  else if (S.done) action = `<div class="up" style="font-weight:700">${fmt(S.done.net, 6)} LUMA sent to your wallet.</div><div class="muted" style="font-size:.8rem">Earned ${fmt(S.done.gross, 6)} minus the ${fmt(S.done.fee, 2)} LUMA collect fee.</div>`;
  else if (!c.open) action = `<div class="muted">${esc(c.why || 'Rewards are closed right now.')}</div>`;
  else if (!w) action = `<div class="muted">Unlock your vault with this wallet's key to collect. A watch-only wallet can look but not collect.</div>`;
  else action = `<button class="pri" id="rw_go" ${S.busy ? 'disabled' : ''} onclick="window.rw.collect()">${S.busy ? esc(S.step || 'Working…') : 'Collect rewards'}</button><div class="muted" style="font-size:.8rem;margin-top:.35rem">Collect as often as you like. Each collect costs ${fmt(c.fee, 2)} LUMA, taken from the payout.</div>`;
  const rows = (d.rows || []).map((r: any) => `<tr><td><b>${esc(r.name)}</b>${r.issuer ? `<div class="muted mono" style="font-size:.72rem">${esc(r.issuer.slice(0, 10))}…</div>` : '<div class="muted" style="font-size:.72rem">native coin</div>'}</td>
      <td class="r">${fmt(r.balance, 4)}</td><td class="r">${usd(r.usd)}</td><td class="r">${fmt(r.priceLuma, 6)} LUMA</td><td class="r"><b>${fmt(r.valueLuma, 2)} LUMA</b></td><td class="r">${usd(r.valueUsd)}</td><td class="r up">${fmt(r.apy, 2)}%</td><td class="r">${fmt(r.perDayLuma, 4)} LUMA</td></tr>`).join('');
  const hist = (d.recent || []).length ? d.recent.map((x: any) => `<div class="row" style="justify-content:space-between;font-size:.85rem;padding:.25rem 0"><span class="muted">${ago(x.t)}${x.state !== 'paid' ? ' (' + esc(x.state) + ')' : ''}</span><span>${fmt(x.net, 6)} LUMA <span class="muted">(fee ${fmt(x.fee, 2)})</span></span></div>`).join('') : '<div class="muted">No collects yet.</div>';
  el.innerHTML = `
    <div class="card c12" style="background:linear-gradient(135deg,rgba(52,211,153,.10),rgba(96,165,250,.08))">
      <div class="row" style="align-items:flex-end;gap:1rem;flex-wrap:wrap">
        <div><div class="k">Your rewards, growing every second</div>
          <div style="font-size:2.4rem;font-weight:800;line-height:1.1;margin-top:.2rem;font-variant-numeric:tabular-nums"><span id="rw_n">${f6(pend())}</span> <span class="muted" style="font-size:1rem;font-weight:500">LUMA</span></div>
          <div class="muted" style="margin-top:.2rem">about <span id="rw_u">${usd(pend() * lu)}</span> · earning ${fmt(perDay, 4)} LUMA a day (${usd(perDay * lu)})</div></div>
        <span class="grow"></span><div style="min-width:min(320px,100%)">${action}${S.err ? `<div class="dn" style="margin-top:.5rem">${esc(S.err)}</div>` : ''}</div>
      </div>
      ${c.note ? `<div class="muted" style="margin-top:.6rem">${esc(c.note)}</div>` : ''}
    </div>
    <div class="card c3"><div class="k">Your holdings</div><div style="font-size:1.45rem;font-weight:700;margin-top:.2rem">${fmt(totL, 2)} LUMA</div><div class="muted" style="font-size:.78rem">${usd(totU)}</div></div>
    <div class="card c3"><div class="k">LUMA price</div><div style="font-size:1.45rem;font-weight:700;margin-top:.2rem">${usd(lu)}</div><div class="muted" style="font-size:.78rem">1 LUMA</div></div>
    <div class="card c3"><div class="k">Collected so far</div><div style="font-size:1.45rem;font-weight:700;margin-top:.2rem">${fmt(d.collected || 0, 4)} LUMA</div><div class="muted" style="font-size:.78rem">${fmt(d.collects || 0, 0)} collects</div></div>
    <div class="card c3"><div class="k">Rates</div><div style="font-size:1.45rem;font-weight:700;margin-top:.2rem">${fmt(c.apyLuma, 0)}% · ${fmt(c.apyOther, 0)}%</div><div class="muted" style="font-size:.78rem">LUMA · every other token, per year</div></div>
    <div class="card c12"><div class="k">What you hold and what it is worth</div><div style="overflow-x:auto;margin-top:.5rem"><table class="t" style="width:100%"><thead><tr><th>Token</th><th class="r">Balance</th><th class="r">Price (USD)</th><th class="r">Price (LUMA)</th><th class="r">Value (LUMA)</th><th class="r">Value (USD)</th><th class="r">Yearly rate</th><th class="r">Earns per day</th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="muted">Nothing here earns rewards yet.</td></tr>'}</tbody></table></div></div>
    <div class="card c6"><div class="k">Latest collects</div><div style="margin-top:.4rem">${hist}</div></div>
    <div class="card c6"><div class="k">How rewards work</div><ul class="muted" style="margin:.5rem 0 0 1.1rem;line-height:1.6">
      <li>Every token on the LUMA network that has a price earns on its balance: LUMA ${fmt(c.apyLuma, 0)}% a year, every other token ${fmt(c.apyOther, 0)}%.</li>
      <li>Rewards are worth the token's value in LUMA and are paid in LUMA, from the genesis wallet.</li>
      <li>Collect as many times as you like. Each collect costs ${fmt(c.fee, 2)} LUMA, taken from what you collect.</li>
      <li>Only tokens you really held count: each period uses the smaller of your balance at the start and now.</li>
      <li>You prove the wallet by signing a message with its own key. Nothing else leaves your wallet.</li>
    </ul></div>`;
}

function tick() {
  const n = $('rw_n'); if (!n) { stop(); return; }
  const p = pend(); n.textContent = f6(p); const u = $('rw_u'); if (u && S.d && S.d.lumaUsd) u.textContent = usd(p * S.d.lumaUsd);
}
function stop() { if (timer) { clearInterval(timer); timer = 0; } if (refresh) { clearInterval(refresh); refresh = 0; } }

export async function load(silent = false) {
  if (S.loading) return; S.loading = true;
  try { S.err = ''; const a = myAddr(); S.addr = a; S.d = a ? await call('status?addr=' + encodeURIComponent(a)) : null; S.at = Date.now() - (S.d && S.d.serverTime ? 0 : 0); }
  catch (e: any) { if (!silent) S.d = null; S.err = String(e?.message || e); }
  S.loading = false; if (!(silent && S.busy)) paint();
}

async function run() {
  if (S.busy) return; const w = walletOf(); if (!w) return;
  S.busy = true; S.err = ''; S.done = null; paint();
  try {
    S.step = 'Checking…'; paint();
    const ch = await post('challenge', { address: w.classic });
    if (!ch.ok) throw new Error(ch.error || 'Collecting could not start.');
    S.step = 'Signing…'; paint();
    const kw = xrpl.Wallet.fromSeed(w.seed);
    if (kw.classicAddress !== w.classic) throw new Error("This wallet's key does not match its address.");
    const signature = sign(hexOf(ch.message), kw.privateKey);
    S.step = 'Sending your LUMA…'; paint();
    const r = await post('collect', { id: ch.id, publicKey: kw.publicKey, signature });
    if (!r.ok) throw new Error(r.error || 'The collect was not accepted.');
    S.done = r; ctx.toast(fmt(r.net, 4) + ' LUMA collected', false);
    try { ctx.rerender(); } catch {}
  } catch (e: any) { S.err = String(e?.message || e); }
  S.busy = false; S.step = ''; await load(); paint(); if (S.done) setTimeout(() => { S.done = null; paint(); }, 6000);
}

export function mount() {
  if (!$('rw')) return; stop(); paint(); load();
  timer = setInterval(tick, 100);   // the counter climbs between refreshes
  refresh = setInterval(() => { if (!document.hidden && !S.busy) void load(true); }, 30000);
}
export function unmount() { stop(); }
(window as any).rw = { load: () => load(), collect: () => { void run(); } };
