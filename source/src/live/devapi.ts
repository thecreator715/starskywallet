// Developer API: paid access to the LUMA network for apps and scripts. Each successful call costs the price shown here (0.0001 LUMA by default),
// paid from prepaid credits that you top up by sending LUMA to the API wallet. Keys are claimed with a commit-and-reveal so a key is never sent over the ledger:
// the payment memo carries a hash of a secret that stays in this browser, and the secret is revealed once to receive the key.
import { ctx } from './ctx.ts';
import { opGet, opRoots } from './oproots.ts';
import { esc, fmt, short, ago } from './util.ts';
import * as PM from './procmodal.ts';

const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const N = (v: any, d = 2) => (v == null || !isFinite(+v) ? '–' : (+v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const MS = (v: any) => (v == null ? '–' : v < 1000 ? Math.round(v) + ' ms' : (v / 1000).toFixed(1) + ' s');
const GREEN = '#3ddc84', RED = '#ff5b5b', AMB = '#f5b84b', BLUE = '#5aa9ff';
const chip = (t: string, c: string) => `<span style="display:inline-block;padding:.08rem .5rem;border-radius:99px;font-size:.78rem;background:${c}22;color:${c}">${esc(t)}</span>`;
const tile = (k: string, v: string, sub = '', col = '') => `<div class="tile" style="min-width:9.5rem;flex:1"><div class="mut" style="font-size:.8rem">${esc(k)}</div><div style="font-size:1.25rem;font-weight:800;margin:.1rem 0;${col ? 'color:' + col : ''}">${v}</div><div class="mut" style="font-size:.78rem">${sub}</div></div>`;
const hexOf = (s: string) => Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const rand = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map(b => b.toString(16).padStart(2, '0')).join('');

type VW = 'start' | 'usage' | 'docs';
let VIEW = 'start' as VW;
let INFO: any = null, USE: any = null, ERR = '', base = '', busy = false, timer: any = 0, HRS = 24;
const net = () => (ctx.netKey() === 'test' ? 'test' : 'main');
const KK = () => `starsky.api.key.${net()}.${ctx.account() || ''}`;
const getKey = () => { try { return localStorage.getItem(KK()) || ''; } catch { return ''; } };
const setKey = (k: string) => { try { k ? localStorage.setItem(KK(), k) : localStorage.removeItem(KK()); } catch { /* blocked */ } };
const OK = 'starsky.lend.op.';

async function http(method: string, path: string, body?: any, key?: string): Promise<{ s: number; j: any; ms: number }> {
  const r = await opGet(path, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-luma-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined }, OK); base = r.base; return { s: r.s, j: r.j, ms: r.ms };
}
export async function publicGet(path: string): Promise<any | null> { try { const x = await http('GET', path); return x.s === 200 ? x.j : null; } catch { return null; } }
export async function load(force = false) {
  if (!document.getElementById('dv_root')) return; if (busy && !force) return; busy = true;
  try {
    const i = await http('GET', '/api/public/devapi'); INFO = i.j; ERR = '';
    const k = getKey(); if (k) { const u = await http('GET', '/api/public/v1/usage?hours=' + HRS, undefined, k); if (u.s === 200) USE = u.j; else { USE = null; if (u.s === 401) { ERR = 'The saved key no longer works (revoked or removed).'; } } } else USE = null;
  } catch (e: any) { ERR = String(e?.message || e); INFO = null; } finally { busy = false; paint(); }
}
export function setOp() { const cur = base || opRoots(OK)[0] || ''; const u = prompt('Control panel address (for example http://127.0.0.1:8090)', cur); if (u == null) return; try { localStorage.setItem(OK + net(), u.trim().replace(/\/$/, '')); } catch { /* ignore */ } base = u.trim().replace(/\/$/, ''); void load(true); }
export function view(v: VW) { VIEW = v; paint(); }
export function hours(h: number) { HRS = h; void load(true); }

// ---------- actions ----------
export async function start() {
  if (!INFO || !INFO.set || !INFO.enabled) return ctx.toast('The developer API is not available right now.', true);
  const acc = ctx.account(); if (!acc) return ctx.toast('Unlock a wallet first.', true);
  const amtS = ($('dv_amt') || { value: '1' }).value, amt = Number(amtS), label = (($('dv_label') || { value: '' }).value || '').trim().slice(0, 40) || 'Starsky';
  const min = Number(INFO.minTopupLUMA || 0.001); if (!(amt >= min)) return ctx.toast(`Send at least ${min} ${ctx.native()}.`, true);
  const price = Number(INFO.pricePerCallLUMA); const have = await bal(acc); if (amt + 1.5 > have) return ctx.toast(`This wallet has ${N(have, 4)} ${ctx.native()}. It needs ${N(amt + 1.5, 4)} (a small amount stays for fees and the reserve).`, true);
  const ok = await PM.review({ title: 'Get an API key', tone: 'tip', hero: `<div style="font-size:1.4rem;font-weight:800">${fmt(amt, 6)} ${esc(ctx.native())}</div><div class="mut">becomes about ${N(amt / price, 0)} API calls</div>`, rows: [{ k: 'Paid to', v: `<span class="mono">${esc(short(INFO.payTo, 8, 6))}</span>` }, { k: 'Price per call', v: `${N(price, 6)} ${esc(ctx.native())}` }, { k: 'Your key', v: 'Created for this wallet and shown once' }, { k: 'Network fee', v: '~0.00001 ' + esc(ctx.native()) }], warns: ['Credits are prepaid. Unused credits are not refunded automatically.'], confirm: 'Pay and get my key' });
  if (!ok) return;
  const pg = PM.progress('Get an API key', ['Send the payment', 'Wait for the operator to see it', 'Receive your key'], 'tip');
  try {
    const secret = rand(24), c = await sha256(secret); pg.set(0, 'run');
    const r = await ctx.submit({ TransactionType: 'Payment', Account: acc, Destination: INFO.payToClassic, Amount: String(Math.round(amt * 1e6)), Memos: [{ Memo: { MemoType: hexOf(INFO.memoType || 'luma-api'), MemoData: hexOf(JSON.stringify({ a: 'key', c, label })) } }] });
    if (!r.ok) return pg.fail(r.msg || 'The payment was refused.'); pg.set(0, 'ok'); pg.set(1, 'run');
    for (let i = 0; i < 30; i++) {
      await new Promise(res => setTimeout(res, 3000));
      try { const x = await http('POST', '/api/public/devapi/claim', { secret }); if (x.s === 200 && x.j.key) { setKey(x.j.key); pg.set(1, 'ok'); pg.set(2, 'ok'); pg.done(`Your key is saved in this browser: <span class="mono" style="word-break:break-all">${esc(x.j.key)}</span><br><span class="mut">Copy it somewhere safe. It is shown once and cannot be recovered.</span>`); void load(true); return; } if (x.s === 429) break; } catch { /* retry */ }
    }
    pg.fail('The payment went through but the key is not ready yet. Your secret is kept for this session: press "Claim my key" in a minute.'); pendingSecret = secret;
  } catch (e: any) { pg.fail(String(e?.message || e)); }
}
let pendingSecret = '';
export async function claim() { if (!pendingSecret) return ctx.toast('Nothing to claim in this session.', true); const x = await http('POST', '/api/public/devapi/claim', { secret: pendingSecret }); if (x.s === 200 && x.j.key) { setKey(x.j.key); pendingSecret = ''; ctx.toast('Key saved'); void load(true); } else ctx.toast(x.j.error || 'Not ready yet', true); }
async function bal(acc: string): Promise<number> { try { const ai = await ctx.req('account_info', { account: acc, ledger_index: 'validated' }); return Number(ai.account_data.Balance) / 1e6; } catch { return 0; } }
export async function topup() {
  if (!INFO || !INFO.payTo) return ctx.toast('The developer API is not available right now.', true); const acc = ctx.account(); if (!acc) return ctx.toast('Unlock a wallet first.', true);
  const amt = Number(($('dv_top') || { value: '' }).value); const min = Number(INFO.minTopupLUMA || 0.001); if (!(amt >= min)) return ctx.toast(`Send at least ${min} ${ctx.native()}.`, true);
  const have = await bal(acc); if (amt + 1.5 > have) return ctx.toast(`This wallet has ${N(have, 4)} ${ctx.native()}. It needs ${N(amt + 1.5, 4)}.`, true);
  const ok = await PM.review({ title: 'Add API credits', tone: 'tip', hero: `<div style="font-size:1.4rem;font-weight:800">${fmt(amt, 6)} ${esc(ctx.native())}</div><div class="mut">about ${N(amt / Number(INFO.pricePerCallLUMA), 0)} more calls</div>`, rows: [{ k: 'Credited to', v: `<span class="mono">${esc(short(ctx.show(acc), 8, 6))}</span>` }, { k: 'Paid to', v: `<span class="mono">${esc(short(INFO.payTo, 8, 6))}</span>` }], confirm: 'Add credits' });
  if (!ok) return; const r = await ctx.submit({ TransactionType: 'Payment', Account: acc, Destination: INFO.payToClassic, Amount: String(Math.round(amt * 1e6)), Memos: [{ Memo: { MemoType: hexOf(INFO.memoType || 'luma-api'), MemoData: hexOf(JSON.stringify({ a: 'topup' })) } }] });
  if (!r.ok) return ctx.toast(r.msg || 'Refused', true); ctx.toast('Sent. Credits appear in a few seconds.'); setTimeout(() => void load(true), 6000); setTimeout(() => void load(true), 14000);
}
export function useKey() { const k = (($('dv_have') || { value: '' }).value || '').trim(); if (!/^lk_[0-9a-f]{20,}$/.test(k)) return ctx.toast('That does not look like an API key (it starts with lk_).', true); setKey(k); void load(true); }
export function forget() { if (!confirm('Remove the saved key from this browser? It keeps working for anything else that has it.')) return; setKey(''); USE = null; paint(); }
export async function newKey() { const k = getKey(); if (!k) return; const label = prompt('A name for the new key (for example "production")', ''); if (label == null) return; const x = await http('POST', '/api/public/v1/keys', { label }, k); if (x.s === 200) { alert('Your new key (shown once):\n\n' + x.j.key + '\n\nCopy it now.'); void load(true); } else ctx.toast(x.j.error || 'Could not create the key', true); }
export async function revoke(id: string) { const k = getKey(); if (!confirm('Revoke this key? Anything using it stops working immediately.')) return; const x = await http('POST', '/api/public/v1/keys/revoke', { id }, k); if (x.s === 200) { ctx.toast('Revoked'); void load(true); } else ctx.toast(x.j.error || 'Could not revoke', true); }
export async function copy(what: string) { try { await navigator.clipboard.writeText(what === 'key' ? getKey() : what); ctx.toast('Copied'); } catch { ctx.toast('Copy failed. Select the text and copy it yourself.', true); } }

// ---------- drawing ----------
function line(series: { name: string; color: string; data: [number, number][] }[], fmtY: (v: number) => string): string {
  const W = 560, H = 130, pad = 34; const all = series.flatMap(s => s.data.map(p => p[1])).filter(v => isFinite(v)); if (all.length < 2) return '<div class="mut">No data yet.</div>';
  let lo = Math.min(0, ...all), hi = Math.max(...all); if (hi === lo) hi = lo + 1; const ts = series.flatMap(s => s.data.map(p => p[0])), t0 = Math.min(...ts), t1 = Math.max(...ts);
  const x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad - 6), y = (v: number) => H - 16 - ((v - lo) / (hi - lo)) * (H - 30);
  const tm = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px"><text x="2" y="12" font-size="10" fill="currentColor" opacity=".6">${fmtY(hi)}</text><text x="2" y="${H - 18}" font-size="10" fill="currentColor" opacity=".6">${fmtY(lo)}</text><line x1="${pad}" x2="${W}" y1="${H - 16}" y2="${H - 16}" stroke="currentColor" opacity=".2"/>${series.map(s => `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" points="${s.data.map(p => x(p[0]).toFixed(1) + ',' + y(p[1]).toFixed(1)).join(' ')}"/>`).join('')}<text x="${pad}" y="${H - 3}" font-size="10" fill="currentColor" opacity=".6">${tm(t0)}</text><text x="${W - 6}" y="${H - 3}" font-size="10" text-anchor="end" fill="currentColor" opacity=".6">${tm(t1)}</text></svg>${series.length > 1 ? `<div class="mut" style="font-size:.78rem">${series.map(s => `<span style="color:${s.color}">●</span> ${esc(s.name)}`).join(' &nbsp; ')}</div>` : ''}`;
}
function startHtml(): string {
  if (!INFO) return ERR ? `<div class="card c12" style="border:1px solid ${AMB}"><b>Cannot reach the control panel.</b><div class="mut" style="margin-top:.3rem">${esc(ERR)}</div><button class="sm" style="margin-top:.5rem" onclick="window.dv.setOp()">Set the control panel address</button></div>` : '<div class="card c12 mut">Connecting…</div>';
  const have = getKey(), price = Number(INFO.pricePerCallLUMA);
  const intro = `<div class="card c12"><div class="k">Developer API</div><div class="mut" style="margin-top:.4rem;line-height:1.55">Build apps and scripts on the LUMA network. Read balances, prices, ledgers and history, and submit signed transactions. Each successful call costs <b>${N(price, 6)} ${esc(ctx.native())}</b> (${N(1 / price, 0)} calls per ${esc(ctx.native())}), paid from credits you top up. Failed calls, usage, pricing and key management are free. Your secret keys never leave your wallet: the API only takes signed transactions.</div></div>`;
  if (!INFO.set) return intro + '<div class="card c12" style="border:1px solid ' + AMB + '"><b>The operator has not turned the API on yet.</b></div>';
  const get = have ? `<div class="card c12"><div class="k">Your key</div><div class="row" style="gap:.5rem;margin-top:.5rem;flex-wrap:wrap;align-items:center"><span class="mono" style="word-break:break-all">${esc(have.slice(0, 9))}…${esc(have.slice(-4))}</span><button class="sm" onclick="window.dv.copy('key')">Copy key</button><button class="sm" onclick="window.dv.forget()">Remove from this browser</button></div>${ERR ? `<div style="color:${RED};margin-top:.4rem">${esc(ERR)}</div>` : ''}</div>` :
    `<div class="card c6"><div class="k">Get a key</div><div class="mut" style="font-size:.86rem;margin:.4rem 0">You pay in ${esc(ctx.native())} once. That becomes credits, and a key is created for this wallet.</div><div class="fgrid"><input id="dv_label" placeholder="Name for the key (optional)" maxlength="40"><div class="row" style="gap:.4rem;align-items:center"><input id="dv_amt" class="grow" value="1" inputmode="decimal"><span class="mut">${esc(ctx.native())}</span></div></div><div class="mut" style="font-size:.8rem;margin-top:.4rem">Minimum ${N(INFO.minTopupLUMA, 6)}. 1 ${esc(ctx.native())} is about ${N(1 / price, 0)} calls.</div><div class="row" style="gap:.5rem;margin-top:.6rem"><button class="pri grow" onclick="window.dv.start()">Pay and get my key</button><button class="sm" onclick="window.dv.claim()">Claim my key</button></div></div>
    <div class="card c6"><div class="k">I already have a key</div><div class="fgrid" style="margin-top:.5rem"><input id="dv_have" placeholder="lk_..." autocomplete="off" spellcheck="false"></div><button class="sm" style="margin-top:.5rem" onclick="window.dv.useKey()">Use this key</button>${ERR ? `<div style="color:${RED};margin-top:.4rem">${esc(ERR)}</div>` : ''}</div>`;
  const st = INFO.stats || {};
  const info = `<div class="card c12"><div class="row" style="gap:.6rem;flex-wrap:wrap;width:100%">${tile('Price per call', N(price, 6) + ' ' + esc(ctx.native()), 'successful calls only')}${tile('Rate limit', INFO.defaults.rps + ' / second', 'burst ' + INFO.defaults.burst + (INFO.defaults.daily ? ', ' + N(INFO.defaults.daily, 0) + ' a day' : ''))}${tile('Network calls, 24 h', N(st.calls24h, 0), 'all developers')}${tile('Median / 95th latency', MS(st.p50) + ' / ' + MS(st.p95), 'operator side')}${tile('Error rate', N((st.errorRate || 0) * 100, 1) + '%', 'server errors')}</div></div>`;
  return intro + get + info;
}
function usageHtml(): string {
  if (!getKey()) return '<div class="card c12 mut">Get or add a key first (Start tab).</div>'; if (!USE) return `<div class="card c12 mut">${ERR ? esc(ERR) : 'Loading…'}</div>`;
  const u = USE, a = u.account, d = u.last24h, low = a.callsLeft < 200;
  const tiles = `<div class="card c12"><div class="row" style="gap:.6rem;flex-wrap:wrap;width:100%">${tile('Credits', N(a.creditsLUMA, 4) + ' ' + esc(ctx.native()), N(a.callsLeft, 0) + ' calls left', low ? RED : '')}${tile('Calls, 24 h', N(d.calls, 0), N(d.errors, 0) + ' errors · ' + N(d.limited, 0) + ' rate-limited')}${tile('Spent, 24 h', N(d.spentLUMA, 4) + ' ' + esc(ctx.native()), 'all time ' + N(a.spentLUMA, 4))}${tile('Latency', MS(d.p50) + ' / ' + MS(d.p95), 'median / 95th percentile')}${tile('Paid in to date', N(a.depositedLUMA, 4) + ' ' + esc(ctx.native()), a.grantedLUMA > 0 ? 'plus ' + N(a.grantedLUMA, 4) + ' granted' : '')}</div>
  <div class="row" style="gap:.5rem;margin-top:.7rem;flex-wrap:wrap;align-items:center"><input id="dv_top" placeholder="Add credits (${esc(ctx.native())})" inputmode="decimal" style="width:11rem"><button class="pri sm" onclick="window.dv.topup()">Add credits</button>${low ? chip('running low', RED) : ''}<span class="grow"></span>${[24, 72, 168].map(h => `<button class="sm ${HRS === h ? 'pri' : ''}" onclick="window.dv.hours(${h})">${h === 24 ? '24 h' : h === 72 ? '3 days' : '7 days'}</button>`).join('')}</div></div>`;
  const ch = `<div class="card c6"><div class="k">Calls per hour</div>${line([{ name: 'calls', color: BLUE, data: u.hourly.map((x: any) => [x[0], x[1]]) }, { name: 'errors', color: RED, data: u.hourly.map((x: any) => [x[0], x[2]]) }], v => N(v, 0))}</div><div class="card c6"><div class="k">Spend per hour (${esc(ctx.native())})</div>${line([{ name: 'spend', color: GREEN, data: u.hourly.map((x: any) => [x[0], x[4]]) }], v => N(v, 4))}</div><div class="card c6"><div class="k">Average latency per hour</div>${line([{ name: 'ms', color: AMB, data: u.hourly.map((x: any) => [x[0], x[3]]) }], v => MS(v))}</div>`;
  const ep = `<div class="card c6"><div class="k">By endpoint, 24 h</div><table style="width:100%;font-size:.84rem"><tr class="mut" style="text-align:left"><th>Endpoint</th><th>Calls</th><th>Errors</th><th>Median</th><th>95th</th><th>Spent</th></tr>${u.endpoints.map((e: any) => `<tr><td class="mono">${esc(e.ep)}</td><td>${N(e.n, 0)}</td><td style="color:${e.err ? AMB : 'inherit'}">${N(e.err, 0)}</td><td>${MS(e.p50)}</td><td>${MS(e.p95)}</td><td>${N(e.spentLUMA, 4)}</td></tr>`).join('') || '<tr><td colspan="6" class="mut">No calls yet.</td></tr>'}</table></div>`;
  const keys = `<div class="card c12"><div class="row" style="align-items:center"><div class="k">Keys on this wallet</div><span class="grow"></span><button class="sm" onclick="window.dv.newKey()">New key</button></div><table style="width:100%;font-size:.84rem;margin-top:.4rem"><tr class="mut" style="text-align:left"><th>Name</th><th>Key</th><th>Calls</th><th>Spent</th><th>Last used</th><th></th></tr>${u.keys.map((k: any) => `<tr><td>${esc(k.label || '(no name)')}</td><td class="mono">${esc(k.prefix)}…</td><td>${N(k.calls, 0)}</td><td>${N(k.spentLUMA, 4)}</td><td>${k.lastUsed ? esc(ago(Date.now() - k.lastUsed)) : 'never'}</td><td>${k.revoked ? chip('revoked', RED) : k.id === u.key.id ? chip('this key', BLUE) : `<button class="sm" onclick="window.dv.revoke('${esc(k.id)}')">Revoke</button>`}</td></tr>`).join('')}</table></div>`;
  const rec = `<div class="card c12"><div class="k">Latest requests</div><div style="overflow:auto;max-height:18rem"><table style="width:100%;font-size:.82rem"><tr class="mut" style="text-align:left"><th>When</th><th>Endpoint</th><th>Status</th><th>Time</th><th>Cost</th></tr>${u.recent.map((e: any) => `<tr><td>${new Date(e.t).toLocaleTimeString()}</td><td class="mono">${esc(e.ep)}</td><td>${chip(String(e.status), e.status < 300 ? GREEN : e.status === 429 ? AMB : e.status < 500 ? '#ff8a3d' : RED)}</td><td>${MS(e.ms)}</td><td>${e.cost > 0 ? N(e.cost, 4) : '–'}</td></tr>`).join('') || '<tr><td colspan="5" class="mut">No requests yet.</td></tr>'}</table></div></div>`;
  return tiles + ch + ep + keys + rec;
}
function docsHtml(): string {
  const b = (base || location.origin) + '/api/public/v1', k = getKey() ? getKey().slice(0, 9) + '…' : 'lk_YOUR_KEY';
  const code = (t: string) => `<pre style="background:rgba(255,255,255,.06);padding:.7rem;border-radius:8px;overflow:auto;font-size:.8rem;margin:.4rem 0">${esc(t)}</pre>`;
  const list = INFO ? INFO.endpoints.map((e: string[]) => `<tr><td class="mono">${esc(e[0])}</td><td class="mut">${esc(e[1])}</td></tr>`).join('') : '';
  return `<div class="card c12"><div class="k">Quick start</div><div class="mut" style="margin:.4rem 0">Send your key in the <b>x-luma-key</b> header.</div>${code(`curl -H "x-luma-key: ${k}" ${b}/price\ncurl -H "x-luma-key: ${k}" ${b}/account/<address>\ncurl -X POST -H "x-luma-key: ${k}" -H "content-type: application/json" \\\n  -d '{"method":"fee"}' ${b}/rpc`)}${code(`const r = await fetch("${b}/price", { headers: { "x-luma-key": process.env.LUMA_KEY } });\nconst { result, billed_LUMA, credits_LUMA } = await r.json();`)}<div class="mut" style="font-size:.84rem">Command line: download <b>luma.mjs</b> from the control panel (Developer API → Settings & docs), then <span class="mono">node luma.mjs login ${esc(base || location.origin)} lk_...</span> and <span class="mono">node luma.mjs ask "what is the price"</span>.</div></div>
  <div class="card c12"><div class="k">Endpoints</div><table style="width:100%;font-size:.86rem;margin-top:.4rem">${list}</table><div class="mut" style="font-size:.82rem;margin-top:.5rem;line-height:1.5">Responses carry <span class="mono">x-luma-cost</span> and <span class="mono">x-luma-credits</span>. Status 402 means you are out of credits, 429 means slow down (the response says how fast your key may go), 401 means the key is missing or revoked. Never send a seed or secret to any API: sign transactions yourself and send the signed blob to <span class="mono">/submit</span>.</div></div>`;
}
const TABS: [VW, string][] = [['start', 'Start'], ['usage', 'Usage & analytics'], ['docs', 'Docs']];
export function shell() { return `<div id="dv_root" style="width:100%"><div class="row" style="gap:.4rem;margin-bottom:.7rem;flex-wrap:wrap" id="dv_tabs"></div><div id="dv_body" class="grid" style="width:100%"><div class="card c12 mut">Loading…</div></div></div>`; }
function paint() {
  const tabs = document.getElementById('dv_tabs'), body = document.getElementById('dv_body'); if (!tabs || !body) return;
  tabs.innerHTML = TABS.map(([k, l]) => `<button class="sm ${VIEW === k ? 'pri' : ''}" onclick="window.dv.view('${k}')">${l}</button>`).join('') + '<span class="grow"></span><button class="sm" onclick="window.dv.load(true)">Refresh</button>';
  const a = document.activeElement as HTMLElement | null; if (a && ['dv_top', 'dv_amt', 'dv_label', 'dv_have'].includes(a.id) && body.contains(a)) return;   // never wipe what is being typed
  body.innerHTML = VIEW === 'start' ? startHtml() : VIEW === 'usage' ? usageHtml() : docsHtml();
}
export function mount() { clearInterval(timer); void load(true); timer = setInterval(() => { if (!document.getElementById('dv_root')) { clearInterval(timer); return; } if (!document.hidden) void load(); }, 10000); }
export const api = { load, view, setOp, start, claim, topup, useKey, forget, newKey, revoke, copy, hours };
