// Vaults: single-asset vaults for any token. Operator-run vaults work today through ordinary payments (deposit the token, get share tokens, hand them back to withdraw).
// Native XRPL vaults (the SingleAssetVault amendment) have their own tab and switch on once the network has the amendment.
import { ctx } from './ctx.ts';
import { esc, fmt, usd } from './util.ts';
import { opGet } from './oproots.ts';

const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const hexOf = (s: string) => Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
type V = 'explore' | 'detail' | 'mine' | 'create' | 'native';
const TABS: [V, string][] = [['explore', 'Vaults'], ['detail', 'Vault analytics'], ['mine', 'My vaults'], ['create', 'Create a vault'], ['native', 'Native XRPL vaults']];
let VIEW: V = 'explore', LIST: any = null, DET: any = null, MINE: any = null, SEL = '', ERR = '', NAT: any = null, timer: any = 0, MSG = '';
const F: any = { q: '', sort: 'tvl', tok: '', amt: '', name: '', cur: '', iss: '', fee: '5', nAsset: '', nVault: '', nAmt: '' };
const AMB = '#f5b84b', GREEN = '#3ddc84', RED = '#ff6b6b';
const pc = (x: number | null | undefined, d = 2) => (x == null || !isFinite(x) ? '–' : (x >= 0 ? '+' : '') + x.toFixed(d) + '%');
const short = (a: string) => (a && a.length > 14 ? a.slice(0, 7) + '…' + a.slice(-5) : a || '');

async function load(force = false) {
  try {
    const r = await opGet('/api/public/vaults'); LIST = r.j; ERR = r.s >= 400 ? (r.j && r.j.error) || 'status ' + r.s : '';
    const me = ctx.account(); if (me) { const m = await opGet('/api/public/vaults/account?addr=' + encodeURIComponent(me)).catch(() => null); MINE = m && m.j && m.j.ok ? m.j : null; }
    if (SEL && (VIEW === 'detail' || force)) { const d = await opGet('/api/public/vaults/' + SEL).catch(() => null); DET = d && d.j && d.j.ok ? d.j : null; }
  } catch (e: any) { ERR = String(e.message || e); }
  paint();
}
export function view(v: V) { VIEW = v; if (v === 'native') void natLoad(); paint(); if (v === 'detail') void load(true); }
export function open(id: string) { SEL = id; DET = null; VIEW = 'detail'; paint(); void load(true); }
export function set(k: string, v: string) { F[k] = v; if (k !== 'q') return; paint(); const e = $('vt_q'); if (e) { e.focus(); e.setSelectionRange(v.length, v.length); } }

function spark(data: [number, number][], fmtY: (v: number) => string, color = GREEN): string {
  const d = data.filter(p => isFinite(p[1])); if (d.length < 2) return '<div class="mut" style="padding:.6rem 0;font-size:.85rem">Collecting data. A point is added when something changes and every ten minutes.</div>';
  const W = 560, H = 150, pad = 40; let lo = Math.min(...d.map(p => p[1])), hi = Math.max(...d.map(p => p[1])); if (hi === lo) { hi += hi * 0.01 || 1; lo -= lo * 0.01; }
  const t0 = d[0][0], t1 = d[d.length - 1][0], x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad - 6), y = (v: number) => H - 18 - ((v - lo) / (hi - lo)) * (H - 34);
  const pts = d.map(p => x(p[0]).toFixed(1) + ',' + y(p[1]).toFixed(1)).join(' '), tm = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px"><text x="2" y="12" font-size="10" fill="currentColor" opacity=".6">${fmtY(hi)}</text><text x="2" y="${H - 20}" font-size="10" fill="currentColor" opacity=".6">${fmtY(lo)}</text><line x1="${pad}" x2="${W}" y1="${H - 18}" y2="${H - 18}" stroke="currentColor" opacity=".2"/><polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" points="${pts}"/><text x="${pad}" y="${H - 4}" font-size="10" fill="currentColor" opacity=".6">${tm(t0)}</text><text x="${W - 6}" y="${H - 4}" font-size="10" fill="currentColor" opacity=".6" text-anchor="end">${tm(t1)}</text></svg>`;
}
function bars(rows: { d: string; in: number; out: number }[]): string {
  if (!rows.length) return '<div class="mut" style="font-size:.85rem">No deposits or withdrawals yet.</div>';
  const mx = Math.max(...rows.map(r => Math.max(r.in, r.out)), 1e-9), W = 560, H = 110, bw = (W - 20) / rows.length;
  return `<svg viewBox="0 0 ${W} ${H + 14}" style="width:100%;height:${H + 14}px">${rows.map((r, i) => `<rect x="${10 + i * bw}" y="${H - (r.in / mx) * (H - 6)}" width="${Math.max(2, bw / 2 - 1)}" height="${(r.in / mx) * (H - 6)}" fill="${GREEN}"><title>${r.d}: in ${fmt(r.in, 2)}</title></rect><rect x="${10 + i * bw + bw / 2}" y="${H - (r.out / mx) * (H - 6)}" width="${Math.max(2, bw / 2 - 1)}" height="${(r.out / mx) * (H - 6)}" fill="${RED}"><title>${r.d}: out ${fmt(r.out, 2)}</title></rect>`).join('')}<text x="10" y="${H + 12}" font-size="10" fill="currentColor" opacity=".6">${rows[0].d}</text><text x="${W - 10}" y="${H + 12}" font-size="10" fill="currentColor" opacity=".6" text-anchor="end">${rows[rows.length - 1].d}</text></svg><div class="mut" style="font-size:.75rem">green = deposits, red = withdrawals</div>`;
}
const tile = (k: string, v: string, sub = '') => `<div class="card" style="padding:.8rem"><div class="k">${k}</div><div style="font-size:1.35rem;font-weight:800;margin-top:.15rem;font-variant-numeric:tabular-nums">${v}</div>${sub ? `<div class="mut" style="font-size:.76rem">${sub}</div>` : ''}</div>`;
const banner = () => (ERR ? `<div class="card c12" style="border:1px solid ${AMB}"><b>Cannot reach the vaults service.</b><div class="mut" style="margin-top:.3rem">${esc(ERR)}</div></div>` : '') + (MSG ? `<div class="card c12" style="border:1px solid ${GREEN}">${esc(MSG)}</div>` : '') + (LIST && !LIST.on ? `<div class="card c12" style="border:1px solid ${AMB}">Vaults are switched off by the operator.</div>` : '');

function exploreHtml(): string {
  if (!LIST) return '<div class="card c12 mut">Loading…</div>';
  let vs: any[] = (LIST.vaults || []).slice(); const toks = Array.from(new Set(vs.map(v => v.asset))).sort();
  if (F.tok) vs = vs.filter(v => v.asset === F.tok); if (F.q) vs = vs.filter(v => (v.name + ' ' + v.asset + ' ' + v.owner).toLowerCase().includes(F.q.toLowerCase()));
  const S: Record<string, (a: any, b: any) => number> = { tvl: (a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0), apy: (a, b) => (b.apy7 ?? -1e9) - (a.apy7 ?? -1e9), new: (a, b) => b.createdAt - a.createdAt, dep: (a, b) => b.depositors - a.depositors };
  vs.sort(S[F.sort] || S.tvl);
  const totTvl = (LIST.vaults || []).reduce((s: number, v: any) => s + (v.tvlUsd || 0), 0), totDep = (LIST.vaults || []).reduce((s: number, v: any) => s + v.depositors, 0);
  const cards = vs.map(v => `<div class="card" style="padding:1rem;cursor:pointer" onclick="window.vt.open('${v.id}')"><div class="row" style="justify-content:space-between;gap:.6rem"><div><b style="font-size:1.05rem">${esc(v.name)}</b><div class="mut" style="font-size:.78rem">${esc(v.asset)} vault · by ${esc(short(v.owner))}</div></div><span class="tag ${v.apy7 != null && v.apy7 > 0 ? 'ok' : ''}">${v.apy7 == null ? 'new' : pc(v.apy7, 1) + ' APY'}</span></div>
    <div class="row" style="justify-content:space-between;margin-top:.7rem;font-size:.84rem"><span class="mut">Deposited</span><b>${fmt(v.assets, 4)} ${esc(v.asset)}</b></div><div class="row" style="justify-content:space-between;font-size:.84rem"><span class="mut">Worth</span><b>${v.tvlUsd != null ? usd(v.tvlUsd) : '–'}</b></div><div class="row" style="justify-content:space-between;font-size:.84rem"><span class="mut">Share price</span><span>${fmt(v.pps, 6)} <span style="color:${(v.change24h || 0) >= 0 ? GREEN : RED}">${pc(v.change24h)}</span></span></div><div class="row" style="justify-content:space-between;font-size:.84rem"><span class="mut">Depositors · owner fee</span><span>${v.depositors} · ${fmt(v.ownerFeePct, 2)}%</span></div></div>`).join('');
  return `<div class="card c12"><div class="row" style="gap:.6rem;flex-wrap:wrap;align-items:center"><input id="vt_q" placeholder="Search a vault, token or owner" value="${esc(F.q)}" oninput="window.vt.set('q',this.value)" style="min-width:14rem"><select onchange="window.vt.set('tok',this.value);window.vt.paint()"><option value="">All tokens</option>${toks.map(t => `<option ${F.tok === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select><select onchange="window.vt.set('sort',this.value);window.vt.paint()">${[['tvl', 'Biggest'], ['apy', 'Highest APY'], ['dep', 'Most depositors'], ['new', 'Newest']].map(([k, l]) => `<option value="${k}" ${F.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="grow"></span><button class="sm pri" onclick="window.vt.view('create')">Create a vault</button></div></div>
  <div class="card c4">${tile('Vaults', String((LIST.vaults || []).length))}</div><div class="card c4">${tile('Total value', usd(totTvl))}</div><div class="card c4">${tile('Depositors', String(totDep))}</div>
  <div class="card c12" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:.8rem;background:none;border:0;padding:0">${cards || '<div class="card mut">No vaults match. Create the first one for any token.</div>'}</div>
  <div class="card c12 mut" style="font-size:.8rem">A vault is run by the node operator, not by a smart contract. Deposits are ordinary payments: you receive share tokens that you hand back to withdraw at the current share price.</div>`;
}
function detailHtml(): string {
  if (!SEL || !DET) return `<div class="card c12 mut">${SEL ? 'Loading…' : 'Pick a vault from the list to see its analytics.'}</div>`;
  const v = DET.vault, h: any[] = DET.history || [], me = MINE && (MINE.positions || []).find((p: any) => p.id === v.id), nat = v.native;
  const bal = (a: string) => a;
  const act = `<div class="card c12"><div class="k">Deposit, withdraw or add yield</div><div class="row" style="gap:.5rem;flex-wrap:wrap;align-items:end;margin-top:.4rem"><label>Amount<br><input id="vt_amt" value="${esc(F.amt)}" oninput="window.vt.set('amt',this.value)" style="width:9rem"></label><button class="pri" onclick="window.vt.deposit('${v.id}')">Deposit ${esc(v.asset)}</button><button onclick="window.vt.withdraw('${v.id}')">Withdraw (amount in shares)</button><button class="ghost" onclick="window.vt.addYield('${v.id}')">Add yield (${esc(v.asset)})</button>${me ? `<button class="ghost" onclick="window.vt.maxShares(${me.mine.shares})">Use all my shares</button>` : ''}</div>
    <div class="mut" style="font-size:.8rem;margin-top:.5rem">First time? Your wallet trusts the share token ${esc(v.shareName)} automatically before the deposit. Adding yield raises the share price for everyone${v.ownerFeePct ? ` (the owner keeps ${fmt(v.ownerFeePct, 2)}% of it)` : ''}. Deposits to a closed vault are sent back.</div>${me ? `<div style="margin-top:.5rem;font-size:.88rem">You hold <b>${fmt(me.mine.shares, 6)}</b> shares worth <b>${fmt(me.mine.value, 6)} ${esc(v.asset)}</b> · all-time ${me.mine.gain >= 0 ? '+' : ''}${fmt(me.mine.gain, 6)} ${esc(v.asset)}</div>` : ''}</div>`;
  const ev = (DET.events || []).map((e: any) => `<div style="padding:.35rem 0;border-top:1px solid rgba(255,255,255,.07);font-size:.83rem"><span class="mut">${new Date(e.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span> · <span class="tag" style="color:${e.type === 'deposit' || e.type === 'yield' ? GREEN : e.type === 'withdraw' ? RED : AMB}">${esc(e.type)}</span> ${esc(e.msg)}</div>`).join('') || '<div class="mut">Nothing yet.</div>';
  const top = (DET.top || []).map((t: any) => `<tr><td class="mono">${esc(short(t.who))}</td><td class="r">${fmt(t.shares, 4)}</td><td class="r">${fmt(t.value, 4)}</td><td class="r">${t.pct.toFixed(1)}%</td></tr>`).join('');
  return `<div class="card c12"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:.6rem"><div><b style="font-size:1.25rem">${esc(v.name)}</b> <span class="tag">${esc(v.asset)}</span>${v.closed ? ' <span class="tag" style="color:' + RED + '">closed</span>' : ''}<div class="mut mono" style="font-size:.75rem">vault ${esc(short(v.address))} · share token ${esc(v.shareName)} · owner ${esc(short(v.owner))}</div></div><button class="sm" onclick="window.vt.view('explore')">All vaults</button></div></div>
  <div class="card c3">${tile('Total value', v.tvlUsd != null ? usd(v.tvlUsd) : '–', fmt(v.assets, 4) + ' ' + esc(v.asset))}</div><div class="card c3">${tile('Share price', fmt(v.pps, 6), pc(v.change24h) + ' in 24 h')}</div><div class="card c3">${tile('APY (7 days)', v.apy7 == null ? '–' : pc(v.apy7, 1), '30 days: ' + (v.apy30 == null ? '–' : pc(v.apy30, 1)))}</div><div class="card c3">${tile('Depositors', String(v.depositors), 'biggest holds ' + (DET.concentration ? DET.concentration.toFixed(0) + '%' : '–'))}</div>
  ${act}
  <div class="card c6"><div class="k">Share price</div>${spark(h.map(x => [x.t, x.pps]), x => fmt(x, 5))}</div><div class="card c6"><div class="k">Total deposited (${esc(v.asset)})</div>${spark(h.map(x => [x.t, x.assets]), x => fmt(x, 2), '#7aa7ff')}</div>
  <div class="card c6"><div class="k">Deposits and withdrawals by day</div>${bars(DET.flows || [])}</div><div class="card c6"><div class="k">Money flow</div><table style="width:100%;font-size:.86rem">${[['Deposited, all time', fmt(v.totals.in, 4) + ' ' + v.asset], ['Withdrawn, all time', fmt(v.totals.out, 4) + ' ' + v.asset], ['Yield added', fmt(v.totals.yield, 4) + ' ' + v.asset], ['Owner fees paid', fmt(v.totals.fees, 4) + ' ' + v.asset], ['Created', new Date(v.createdAt).toLocaleDateString()]].map(([a, b]) => `<tr><td class="mut">${a}</td><td class="r">${esc(b)}</td></tr>`).join('')}</table></div>
  <div class="card c6"><div class="k">Biggest depositors</div><table style="width:100%;font-size:.85rem"><thead><tr><th>Wallet</th><th class="r">Shares</th><th class="r">Worth</th><th class="r">Share</th></tr></thead><tbody>${top || '<tr><td colspan="4" class="mut">No depositors yet.</td></tr>'}</tbody></table></div><div class="card c6"><div class="k">Activity</div>${ev}</div>`;
}
function mineHtml(): string {
  if (!ctx.account()) return '<div class="card c12 mut">Open a wallet to see your vaults.</div>';
  if (!MINE) return '<div class="card c12 mut">Loading…</div>';
  const P = MINE.positions || [], O = MINE.owned || [];
  const row = (p: any) => `<tr onclick="window.vt.open('${p.id}')" style="cursor:pointer"><td><b>${esc(p.name)}</b><div class="mut" style="font-size:.74rem">${esc(p.asset)}</div></td><td class="r">${fmt(p.mine.shares, 4)}</td><td class="r">${fmt(p.mine.value, 4)} ${esc(p.asset)}</td><td class="r" style="color:${p.mine.gain >= 0 ? GREEN : RED}">${p.mine.gain >= 0 ? '+' : ''}${fmt(p.mine.gain, 4)}</td><td class="r">${p.apy7 == null ? '–' : pc(p.apy7, 1)}</td></tr>`;
  const own = (p: any) => `<tr onclick="window.vt.open('${p.id}')" style="cursor:pointer"><td><b>${esc(p.name)}</b></td><td>${esc(p.asset)}</td><td class="r">${fmt(p.assets, 4)}</td><td class="r">${p.depositors}</td><td class="r">${fmt(p.totals.fees, 4)}</td></tr>`;
  return `<div class="card c12"><div class="k">Where my money is</div><table style="width:100%"><thead><tr><th>Vault</th><th class="r">Shares</th><th class="r">Worth</th><th class="r">Gain</th><th class="r">APY</th></tr></thead><tbody>${P.map(row).join('') || '<tr><td colspan="5" class="mut">You have not deposited in any vault yet.</td></tr>'}</tbody></table></div>
  <div class="card c12"><div class="k">Vaults I created</div><table style="width:100%"><thead><tr><th>Vault</th><th>Token</th><th class="r">Deposited</th><th class="r">Depositors</th><th class="r">Fees earned</th></tr></thead><tbody>${O.map(own).join('') || '<tr><td colspan="5" class="mut">You have not created a vault.</td></tr>'}</tbody></table></div>`;
}
function createHtml(): string {
  const fee = LIST ? LIST.createFee : 10, gen = LIST && LIST.genesisClassic;
  return `<div class="card c12"><div class="k">Create a vault for any token</div><div class="mut" style="font-size:.85rem;margin:.3rem 0 .6rem">You become the owner and can earn a cut of the yield that gets added. Creating one costs ${fee} LUMA, paid to the Genesis wallet. The vault gets its own wallet and a share token automatically.</div>
  <div class="row" style="gap:.6rem;flex-wrap:wrap;align-items:end"><label>Vault name<br><input id="vt_name" value="${esc(F.name)}" oninput="window.vt.set('name',this.value)" placeholder="e.g. Gold Saver" style="width:12rem"></label><label>Token code<br><input id="vt_cur" value="${esc(F.cur)}" oninput="window.vt.set('cur',this.value)" placeholder="LUMA or GOLD" style="width:9rem"></label><label>Token issuer (blank for LUMA)<br><input id="vt_iss" value="${esc(F.iss)}" oninput="window.vt.set('iss',this.value)" placeholder="issuer address" style="width:17rem"></label><label>Owner cut of yield %<br><input id="vt_fee" value="${esc(F.fee)}" oninput="window.vt.set('fee',this.value)" style="width:6rem"></label><button class="pri" onclick="window.vt.create()" ${gen ? '' : 'disabled'}>Pay ${fee} LUMA and create</button></div>
  ${gen ? '' : '<div class="mut" style="margin-top:.5rem;font-size:.82rem">Waiting for the operator to publish its address.</div>'}<div class="mut" style="font-size:.78rem;margin-top:.6rem">Tip: pick a token from your wallet list for the issuer; Starsky fills it for you when you type its code and it is in your wallet.</div></div>`;
}
async function natLoad() { try { const r: any = await ctx.req('feature', { feature: 'SingleAssetVault' }); const o: any = r && r.features ? Object.values(r.features)[0] : null; NAT = o ? { known: true, enabled: !!o.enabled, supported: !!o.supported, vetoed: !!o.vetoed } : { known: false }; } catch (e: any) { NAT = { known: false, err: String(e.message || e) }; } paint(); }
function nativeHtml(): string {
  const n = NAT; const st = !n ? 'Checking…' : !n.known ? 'This node does not know the SingleAssetVault amendment yet (it needs a newer node build).' : n.enabled ? 'Enabled on this network.' : 'Known to the network but not enabled yet. Validators have to vote it in; the control panel has an Enable button on the Features page.';
  const on = !!(n && n.enabled);
  return `<div class="card c12"><div class="k">Native XRPL vaults</div><div style="margin-top:.3rem"><span class="tag ${on ? 'ok' : ''}">${on ? 'active' : 'not active'}</span> ${esc(st)}</div><div class="mut" style="font-size:.82rem;margin-top:.5rem">Native vaults live in the ledger itself, with no operator in the middle: one token per vault, share tokens issued by the ledger, optional private access. They work only when the amendment is on. Until then use the operator-run vaults on the Vaults tab.</div></div>
  <div class="card c12"><div class="k">Create or use a native vault</div><div class="row" style="gap:.5rem;flex-wrap:wrap;align-items:end;margin-top:.4rem"><label>Token code (blank = ${esc(ctx.native())})<br><input id="vt_nasset" value="${esc(F.nAsset)}" oninput="window.vt.set('nAsset',this.value)" style="width:9rem"></label><label>Token issuer<br><input id="vt_niss" value="${esc(F.iss)}" oninput="window.vt.set('iss',this.value)" style="width:16rem"></label><button class="pri" onclick="window.vt.nativeCreate()" ${on ? '' : 'disabled'}>Create native vault</button></div>
  <div class="row" style="gap:.5rem;flex-wrap:wrap;align-items:end;margin-top:.7rem"><label>Vault ID<br><input id="vt_nid" value="${esc(F.nVault)}" oninput="window.vt.set('nVault',this.value)" style="width:24rem" class="mono"></label><label>Amount<br><input id="vt_namt" value="${esc(F.nAmt)}" oninput="window.vt.set('nAmt',this.value)" style="width:8rem"></label><button onclick="window.vt.nativeMove('VaultDeposit')" ${on ? '' : 'disabled'}>Deposit</button><button onclick="window.vt.nativeMove('VaultWithdraw')" ${on ? '' : 'disabled'}>Withdraw</button></div></div>`;
}
function paint() {
  const root = document.getElementById('vt_root'); if (!root) return; const tabs = document.getElementById('vt_tabs'), body = document.getElementById('vt_body'); if (!tabs || !body) return;
  tabs.innerHTML = TABS.map(([k, l]) => `<button class="sm ${VIEW === k ? 'pri' : ''}" onclick="window.vt.view('${k}')">${l}</button>`).join('') + '<span class="grow"></span><button class="sm" onclick="window.vt.load(true)">Refresh</button>';
  const a = document.activeElement as HTMLElement | null; if (a && /^vt_/.test(a.id) && a.tagName === 'INPUT' && a.id !== 'vt_q') return;   // never repaint under someone typing
  const inner = banner() + (VIEW === 'explore' ? exploreHtml() : VIEW === 'detail' ? detailHtml() : VIEW === 'mine' ? mineHtml() : VIEW === 'create' ? createHtml() : nativeHtml());
  if (body.dataset.sig !== String(inner.length) + inner.slice(0, 60) + inner.slice(-60)) { body.dataset.sig = String(inner.length) + inner.slice(0, 60) + inner.slice(-60); body.innerHTML = inner; }
}
export function shell() { return `<div id="vt_root" style="width:100%"><div class="row" style="gap:.4rem;margin-bottom:.7rem;flex-wrap:wrap" id="vt_tabs"></div><div id="vt_body" class="grid" style="width:100%"><div class="card c12 mut">Loading…</div></div></div>`; }
export function mount() { clearInterval(timer); void load(true); timer = setInterval(() => { if (!document.getElementById('vt_root')) { clearInterval(timer); return; } if (!document.hidden) void load(); }, 15000); }
export function unmount() { clearInterval(timer); }

// ---------- actions ----------
const vOf = (id: string): any => (LIST && (LIST.vaults || []).find((v: any) => v.id === id)) || (DET && DET.vault && DET.vault.id === id ? DET.vault : null);
const num = (s: string) => { const n = Number(s); if (!(n > 0) || !isFinite(n)) throw new Error('Enter an amount above 0'); return Math.floor(n * 1e6) / 1e6; };
const fin = (r: { ok: boolean; msg?: string }, m: string) => { MSG = r.ok ? m : ''; ctx.toast(r.ok ? m : r.msg || 'Failed', !r.ok); paint(); setTimeout(() => void load(true), 5000); setTimeout(() => void load(true), 12000); };
async function hasTrust(addr: string, v: any): Promise<boolean> { const r = await ctx.req('account_lines', { account: addr, peer: v.addressClassic }).catch(() => ({ lines: [] })); return (r.lines || []).some((l: any) => l.currency === v.shareCurrency); }
async function deposit(id: string) {
  try { const v = vOf(id), me = ctx.account(); if (!v || !me) throw new Error('Open a wallet first'); const a = num(F.amt);
    if (!(await hasTrust(me, v))) { const t = await ctx.submit({ TransactionType: 'TrustSet', Account: me, LimitAmount: { currency: v.shareCurrency, issuer: v.addressClassic, value: '999999999999999' } }); if (!t.ok) return fin(t, ''); ctx.toast('Share token trusted. Sending your deposit…'); await new Promise(r => setTimeout(r, 4500)); }
    const Amount: any = v.native ? String(Math.round(a * 1e6)) : { currency: v.assetCurrency, issuer: v.assetIssuerClassic, value: String(a) };
    fin(await ctx.submit({ TransactionType: 'Payment', Account: me, Destination: v.addressClassic, Amount }), `Deposit of ${a} ${v.asset} sent. Your shares arrive in a few seconds.`); }
  catch (e: any) { ctx.toast(e.message || String(e), true); }
}
async function withdraw(id: string) { try { const v = vOf(id), me = ctx.account(); if (!v || !me) throw new Error('Open a wallet first'); const a = num(F.amt); fin(await ctx.submit({ TransactionType: 'Payment', Account: me, Destination: v.addressClassic, Amount: { currency: v.shareCurrency, issuer: v.addressClassic, value: String(a) } }), `Withdrawal of ${a} shares sent. The ${v.asset} arrives in a few seconds.`); } catch (e: any) { ctx.toast(e.message || String(e), true); } }
async function addYield(id: string) { try { const v = vOf(id), me = ctx.account(); if (!v || !me) throw new Error('Open a wallet first'); const a = num(F.amt); const Amount: any = v.native ? String(Math.round(a * 1e6)) : { currency: v.assetCurrency, issuer: v.assetIssuerClassic, value: String(a) };
  fin(await ctx.submit({ TransactionType: 'Payment', Account: me, Destination: v.addressClassic, Amount, Memos: [{ Memo: { MemoType: hexOf('luma-vault-yield'), MemoData: hexOf('{}') } }] }), `${a} ${v.asset} added as yield.`); } catch (e: any) { ctx.toast(e.message || String(e), true); } }
function maxShares(n: number) { F.amt = String(Math.floor(n * 1e6) / 1e6); const e = $('vt_amt'); if (e) e.value = F.amt; }
async function create() {
  try { const me = ctx.account(); if (!me || !LIST || !LIST.genesisClassic) throw new Error('Open a wallet and wait for the operator'); const name = F.name.trim(); if (!name) throw new Error('Give the vault a name');
    const cur = F.cur.trim(), native = !cur || cur.toUpperCase() === ctx.native(); let iss = F.iss.trim(); if (!native && !iss) { const l = await ctx.req('account_lines', { account: me }).catch(() => ({ lines: [] })); const m = (l.lines || []).find((x: any) => x.currency === cur || hexName(x.currency) === cur); if (m) { iss = m.account; F.iss = iss; } }
    if (!native && !iss) throw new Error('Enter the token issuer, or hold the token so Starsky can find it');
    const fee = Math.round((Number(F.fee) || 0) * 100); if (fee < 0 || fee > 2000) throw new Error('Owner cut must be 0% to 20%');
    const body = JSON.stringify({ n: name, c: native ? 'LUMA' : cur, i: native ? '' : ctx.toClassic(iss), f: fee });
    fin(await ctx.submit({ TransactionType: 'Payment', Account: me, Destination: LIST.genesisClassic, Amount: String(Math.round(LIST.createFee * 1e6)), Memos: [{ Memo: { MemoType: hexOf('luma-vault-create'), MemoData: hexOf(body) } }] }), `Vault "${name}" requested. It appears in the list in about a minute.`); }
  catch (e: any) { ctx.toast(e.message || String(e), true); }
}
const hexName = (c: string) => { if (!c || c.length !== 40) return c; const b = (c.match(/../g) || []).map(h => parseInt(h, 16)); while (b.length && b[b.length - 1] === 0) b.pop(); return String.fromCharCode(...b); };
const asset = (cur: string, iss: string) => (!cur || cur.toUpperCase() === ctx.native() ? { currency: ctx.native() } : { currency: /^[A-Za-z0-9]{3}$/.test(cur) ? cur : hexOf(cur).padEnd(40, '0'), issuer: ctx.toClassic(iss) });
async function nativeCreate() { try { const me = ctx.account(); if (!me) throw new Error('Open a wallet first'); fin(await ctx.submit({ TransactionType: 'VaultCreate', Account: me, Asset: asset(F.nAsset, F.iss), Flags: 0 }), 'Native vault created. Find its ID in the transaction result.'); } catch (e: any) { ctx.toast(e.message || String(e), true); } }
async function nativeMove(t: string) { try { const me = ctx.account(); if (!me) throw new Error('Open a wallet first'); if (!/^[0-9A-Fa-f]{64}$/.test(F.nVault)) throw new Error('Paste the 64-character vault ID'); const a = num(F.nAmt); const Amount: any = !F.nAsset || F.nAsset.toUpperCase() === ctx.native() ? String(Math.round(a * 1e6)) : { ...asset(F.nAsset, F.iss), value: String(a) }; fin(await ctx.submit({ TransactionType: t, Account: me, VaultID: F.nVault.toUpperCase(), Amount }), t + ' sent.'); } catch (e: any) { ctx.toast(e.message || String(e), true); } }
export const api = { view, open, set, load, paint, deposit, withdraw, addYield, maxShares, create, nativeCreate, nativeMove };
