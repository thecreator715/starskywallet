// Free LUMA claim page. Every wallet can claim a fixed amount once. The decision is made by the operator's control panel, never here:
// this page only (1) asks for a one-time challenge, (2) solves a small proof of work, (3) signs the challenge with the wallet's own key, (4) sends it.
import { sign } from 'ripple-keypairs';
import * as xrpl from 'xrpl';
import { ctx } from './ctx.ts';
import { esc, fmt } from './util.ts';
import { base } from './nodelink.ts';

const $ = (id: string) => document.getElementById(id);
const net = () => (ctx.netKey() === 'test' ? 'test' : 'main');
// Where the claim service can be reached: the gateway first (works from anywhere), then the operator's own panel on this computer.
const roots = (): string[] => { const k = net(), port = k === 'test' ? 8091 : 8090; const c = (window as any).STARSKY_CONFIG || {}, pn = String((c[k] || c.main || {}).panel || '').replace(/\/+$/, '');
  const r = [`${base()}/panel/${k}`]; if (pn) r.push(pn); r.push(`http://127.0.0.1:${port}`, `http://localhost:${port}`); return r; };
let RIGHT = 0; let WHY = '';
async function call(p: string, init?: RequestInit): Promise<any> {
  const rs = roots(), tried: string[] = [];
  for (let n = 0; n < rs.length; n++) {
    const i = (RIGHT + n) % rs.length, u = `${rs[i]}/api/public/claim/${p}`;
    try {
      const r = await fetch(u, { ...init, cache: 'no-store' }); const txt = await r.text().catch(() => ''); let j: any = null; try { j = JSON.parse(txt); } catch {}
      if (j && typeof j === 'object') { RIGHT = i; WHY = ''; return j; }
      if (r.status === 429) throw new Error('Too many tries from your network. Wait a little and try again.');
      tried.push(`${new URL(u).host}: ${r.status === 403 ? (/gateway gw-/.test(txt) ? txt.slice(0, 160) : 'blocked by an OLD gateway (' + txt.slice(0, 40) + '): close every Terminal window and run Start LUMA All from the latest lumanet') : r.status === 404 ? 'not found (restart the control panel from the latest lumanet)' : 'HTTP ' + r.status}`);
    } catch (e: any) { if (/Too many/.test(e.message)) throw e; tried.push(`${(() => { try { return new URL(u).host; } catch { return u; } })()}: not reachable`); }
  }
  WHY = tried.join(' · ');
  throw new Error('The claim service did not answer. ' + WHY);
}
const enc = new TextEncoder();
const hexOf = (s: string) => Array.from(enc.encode(s)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const lead = (b: Uint8Array) => { let n = 0; for (const x of b) { if (x === 0) { n += 8; continue; } n += Math.clz32(x) - 24; break; } return n; };

interface St { status: any; stats: any; mine: any; err: string; busy: boolean; step: string; done: any; ts: any; tsToken: string }
const S: St = { status: null, stats: null, mine: null, err: '', busy: false, step: '', done: null, ts: null, tsToken: '' };

const get = (p: string) => call(p);
const post = (p: string, body: any) => call(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const myAddr = (): string => { try { const a = ctx.account(); return a ? a : ''; } catch { return ''; } };
const walletOf = (): { seed: string; classic: string } | null => {
  const addr = myAddr(); if (!addr) return null;
  const w = ctx.wallets().find(x => { try { return ctx.toClassic(x.address) === addr && x.type !== 'xrpl'; } catch { return false; } });
  return w && w.seed ? { seed: w.seed, classic: addr } : null;
};

export function shell() { return `<div id="cl" class="grid"><div class="card c12"><div class="k">Free LUMA</div><div class="muted" style="margin-top:.4rem">Loading…</div></div></div>`; }

function bar(pct: number) { return `<div style="height:10px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden"><div style="height:100%;width:${Math.max(0, Math.min(100, pct)).toFixed(2)}%;background:linear-gradient(90deg,#34d399,#60a5fa)"></div></div>`; }
function bars(series: { d: string; luma: number }[]) {
  const mx = Math.max(1, ...series.map(x => x.luma)), w = 100 / series.length;
  return `<svg viewBox="0 0 100 34" preserveAspectRatio="none" style="width:100%;height:96px"><title>LUMA claimed per day</title>${series.map((x, i) => { const h = x.luma / mx * 30; return `<rect x="${(i * w + 0.5).toFixed(2)}" y="${(32 - h).toFixed(2)}" width="${(w - 1).toFixed(2)}" height="${Math.max(h, x.luma ? 0.6 : 0.25).toFixed(2)}" rx="0.4" fill="${x.luma ? '#34d399' : 'rgba(255,255,255,.12)'}"><title>${x.d}: ${fmt(x.luma, 0)} LUMA</title></rect>`; }).join('')}</svg><div class="muted" style="display:flex;justify-content:space-between;font-size:.75rem"><span>${esc(series[0]?.d || '')}</span><span>${esc(series[series.length - 1]?.d || '')}</span></div>`;
}
const tile = (k: string, v: string, s = '') => `<div class="card c3"><div class="k">${k}</div><div style="font-size:1.45rem;font-weight:700;margin-top:.2rem">${v}</div>${s ? `<div class="muted" style="font-size:.78rem;margin-top:.15rem">${s}</div>` : ''}</div>`;
const ago = (t: number) => { const s = Math.max(1, Math.round((Date.now() - t) / 1000)); return s < 90 ? s + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };

function paint() {
  const el = $('cl'); if (!el) return;
  const s = S.status, t = S.stats;
  if (!s) { el.innerHTML = `<div class="card c12"><div class="k">Free LUMA</div><div class="${S.err ? 'dn' : 'muted'}" style="margin-top:.4rem">${esc(S.err || 'Loading…')}</div><div style="margin-top:.6rem"><button class="sm" onclick="window.cl.load()">Try again</button></div></div>`; return; }
  const w = walletOf(), mine = S.mine, claimed = !!(mine && mine.claimed), pct = s.cap ? s.claimed / s.cap * 100 : 0;
  let action = '';
  if (ctx.xrpl()) action = `<div class="muted">Free LUMA goes to LUMA wallets. Switch the wallet type to LUMA.</div>`;
  else if (!myAddr()) action = `<div class="muted">Create or open a LUMA wallet first.</div>`;
  else if (!w) action = `<div class="muted">Unlock your vault with this wallet's key to sign the claim. A watch-only wallet cannot claim.</div>`;
  else if (claimed) action = `<div class="up" style="font-weight:600">This wallet already claimed ${fmt(mine.amount, 0)} LUMA ${mine.t ? ago(mine.t) : ''}${mine.state !== 'paid' ? ' (' + esc(mine.state) + ')' : ''}.</div>${mine.tx ? `<div class="muted mono" style="font-size:.78rem;margin-top:.3rem;word-break:break-all">${esc(mine.tx)}</div>` : ''}`;
  else if (!s.open) action = `<div class="muted">${esc(s.why || 'The claim is closed right now.')}</div>`;
  else action = `${s.turnstileSite ? '<div id="cl_ts" style="margin:.4rem 0"></div>' : ''}<button class="pri" id="cl_go" ${S.busy ? 'disabled' : ''} onclick="window.cl.claim()">${S.busy ? esc(S.step || 'Working…') : 'Claim ' + fmt(s.amount, 0) + ' LUMA'}</button><div class="muted" style="font-size:.78rem;margin-top:.4rem">Goes to <span class="mono">${esc(ctx.show(myAddr()))}</span>. Takes a few seconds: your device does a small calculation and signs with this wallet's key. Nothing is spent.</div>`;
  if (S.done) action = `<div class="up" style="font-weight:700;font-size:1.05rem">${S.done.queued ? 'Your claim is in. ' + esc(S.done.message || '') : fmt(S.done.amount, 0) + ' LUMA sent to your wallet.'}</div>${S.done.tx ? `<div class="muted mono" style="font-size:.78rem;margin-top:.3rem;word-break:break-all">${esc(S.done.tx)}</div>` : ''}`;
  el.innerHTML = `
    <div class="card c12" style="background:linear-gradient(135deg,rgba(52,211,153,.10),rgba(96,165,250,.08))">
      <div class="row" style="align-items:flex-end;gap:1rem;flex-wrap:wrap">
        <div><div class="k">Free LUMA, one claim per wallet</div><div style="font-size:2.1rem;font-weight:800;line-height:1.1;margin-top:.2rem">${fmt(s.amount, 0)} LUMA <span class="muted" style="font-size:1rem;font-weight:500">for every wallet, once</span></div></div>
        <span class="grow"></span><div style="min-width:min(340px,100%)">${action}${S.err ? `<div class="dn" style="margin-top:.5rem">${esc(S.err)}</div>` : ''}</div>
      </div>
      <div style="margin-top:1.1rem">${bar(pct)}<div class="row" style="justify-content:space-between;margin-top:.35rem;font-size:.85rem"><span>${fmt(s.claimed, 0)} of ${fmt(s.cap, 0)} LUMA claimed</span><span class="muted">${fmt(s.remaining, 0)} left · ${fmt(Math.floor(s.remaining / Math.max(s.amount, 1e-9)), 0)} wallets</span></div></div>
      ${s.note ? `<div class="muted" style="margin-top:.6rem">${esc(s.note)}</div>` : ''}
    </div>
    ${tile('Wallets claimed', fmt(s.claims, 0), (t ? fmt(t.perHour, 1) : '–') + ' per hour on average')}
    ${tile('Claimed today', fmt(s.today, 0), 'limit ' + fmt(s.perDay, 0) + ' a day')}
    ${tile('Share claimed', (t ? fmt(t.pctClaimed, 2) : fmt(pct, 2)) + '%', fmt(s.remaining, 0) + ' LUMA left')}
    ${tile('Status', s.open ? '<span class="up">Open</span>' : '<span class="muted">Closed</span>', s.review ? 'claims are reviewed first' : (s.open ? 'paid within seconds' : esc(s.why || '')))}
    <div class="card c8"><div class="k">LUMA claimed per day, last 30 days</div><div style="margin-top:.5rem">${t ? bars(t.series) : '<span class="muted">…</span>'}</div></div>
    <div class="card c4"><div class="k">Latest claims</div><div style="margin-top:.4rem">${t && t.recent.length ? t.recent.map((x: any) => `<div class="row" style="justify-content:space-between;font-size:.85rem;padding:.2rem 0"><span class="mono">${esc(x.addr)}</span><span><b>+${fmt(x.amount, 0)}</b> <span class="muted">${ago(x.t)}</span></span></div>`).join('') : '<span class="muted">No claims yet.</span>'}</div></div>
    <div class="card c12"><div class="k">How it stays fair</div><ul class="muted" style="margin:.5rem 0 0 1.1rem;line-height:1.6">
      <li>One claim per wallet, ever. The operator's panel records it before any LUMA moves, so a second try, a refresh or many tabs at once cannot pay twice.</li>
      <li>You sign a one-time message with your wallet's key, so only the owner of a wallet can claim for it.</li>
      <li>A short calculation on your device (it gets harder when claims come in fast) and per-network daily limits stop wallet-spamming.</li>
      <li>Wallets that all forward their claim to the same address are flagged and their networks blocked.</li>
    </ul></div>`;
  if (s.open && !claimed && s.turnstileSite && !S.done) mountTurnstile();
}

function mountTurnstile() {
  const host = $('cl_ts'); if (!host || host.dataset.on) return; host.dataset.on = '1';
  const render = () => { try { (window as any).turnstile.render(host, { sitekey: S.status.turnstileSite, theme: 'dark', callback: (t: string) => { S.tsToken = t; } }); } catch {} };
  if ((window as any).turnstile) return render();
  const sc = document.createElement('script'); sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; sc.async = true; sc.onload = render; document.head.appendChild(sc);
}

async function solve(nonce: string, addr: string, bits: number, onProgress: (n: number) => void): Promise<number> {
  const B = 256; let n = 0;
  for (;;) {
    const hs = await Promise.all(Array.from({ length: B }, (_, i) => crypto.subtle.digest('SHA-256', enc.encode(`${nonce}|${addr}|${n + i}`))));
    for (let i = 0; i < B; i++) if (lead(new Uint8Array(hs[i])) >= bits) return n + i;
    n += B; if ((n / B) % 8 === 0) { onProgress(n); await new Promise(r => setTimeout(r)); }
  }
}

export async function load() {
  try { S.err = ''; const [st, ss] = await Promise.all([get('status'), get('stats').catch(() => null)]); S.status = st; S.stats = ss; const a = myAddr(); S.mine = a ? await get('lookup?addr=' + encodeURIComponent(a)).catch(() => null) : null; }
  catch (e: any) { S.status = null; S.err = String(e?.message || e); }
  paint();
}

async function run() {
  if (S.busy) return; const w = walletOf(); if (!w) return;
  S.busy = true; S.err = ''; S.done = null; paint();
  try {
    S.step = 'Checking…'; paint();
    const ch = await post('challenge', { address: w.classic });
    if (!ch.ok) { if (ch.claimed) await load(); throw new Error(ch.error || 'The claim could not start.'); }
    S.step = 'Doing the calculation…'; paint();
    const counter = await solve(ch.nonce, w.classic, ch.bits, n => { S.step = `Doing the calculation… ${fmt(n / 1000, 0)}k`; const b = $('cl_go'); if (b) b.textContent = S.step; });
    S.step = 'Signing…'; paint();
    const kw = xrpl.Wallet.fromSeed(w.seed);
    if (kw.classicAddress !== w.classic) throw new Error('This wallet\'s key does not match its address.');
    const signature = sign(hexOf(ch.message), kw.privateKey);
    S.step = 'Sending your LUMA…'; paint();
    const r = await post('submit', { id: ch.id, counter: String(counter), publicKey: kw.publicKey, signature, turnstile: S.tsToken });
    if (!r.ok) { if (r.claimed) await load(); throw new Error(r.error || 'The claim was not accepted.'); }
    S.done = r; ctx.toast(r.queued ? 'Claim received' : fmt(r.amount, 0) + ' LUMA claimed', false);
    try { ctx.rerender(); } catch {}
  } catch (e: any) { S.err = String(e?.message || e); }
  S.busy = false; S.step = ''; S.tsToken = ''; paint(); if (S.done) setTimeout(() => load().then(() => { S.done = null; paint(); }), 4000); else load();
}

export function mount() { if (!$('cl')) return; paint(); load(); }
(window as any).cl = { load, claim: () => { void run(); } };
