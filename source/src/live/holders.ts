// Token Holders page: pick any token on this network, see every wallet holding it, sortable and searchable.
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { req } from './chain.ts';
import { esc, fmt, isNative, NATIVE, akey, short, usd, type Asset } from './util.ts';

const H: any = { tokens: [] as M.TokenRow[], q: '', sel: '', data: null as any, busy: false, hq: '', sort: 'amount', dir: -1, page: 0, err: '' };
const $ = (id: string) => document.getElementById(id);
const addr = (a: string) => ctx.show(a);
export function shell() { return `<div id="hd" class="nwpage"></div>`; }
export async function mount() {
  paint();
  if (!H.tokens.length) {
    try { H.tokens = (await M.tokenTable()).rows; } catch (e: any) { H.err = String(e?.message || e); }
    if (!H.sel) H.sel = 'native';
    paint();
    open(H.sel);
  } else paint();
}
function assetOf(k: string): Asset { if (k === 'native') return NATIVE; const r = H.tokens.find((t: M.TokenRow) => t.key === k); return r ? r.a : { c: k.split('|')[0], i: k.split('|')[1] || '' }; }
async function open(k: string) {
  H.sel = k; H.view = ''; H.det = null; H.data = null; H.page = 0; H.hq = ''; H.err = '';
  paint();
  const a = assetOf(k);
  H.busy = true;
  try {
    const pools = await M.poolRefs().catch(() => []);
    const pa = new Map<string, string>(pools.map((p: any) => [p.account, 'AMM pool']));
    const mine = new Map(ctx.wallets().map(w => [w.address, w.label]));
    const rows: { addr: string; amt: number }[] = [];
    let truncated = false, marker: any;
    if (isNative(a)) {
      for (let p = 0; p < 40; p++) {
        const r: any = await req('ledger_data', { type: 'account', ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) });
        for (const o of r.state || []) if (o.LedgerEntryType === 'AccountRoot' && Number(o.Balance) > 0) rows.push({ addr: o.Account, amt: Number(o.Balance) / 1e6 });
        marker = r.marker; if (!marker) break; if (p === 39) truncated = true;
      }
    } else {
      for (let p = 0; p < 40; p++) {
        const r: any = await req('account_lines', { account: a.i, limit: 400, ledger_index: 'validated', ...(marker ? { marker } : {}) });
        for (const l of r.lines || []) if (l.currency === a.c && Number(l.balance) < 0) rows.push({ addr: l.account, amt: -Number(l.balance) });
        marker = r.marker; if (!marker) break; if (p === 39) truncated = true;
      }
    }
    const total = rows.reduce((t, x) => t + x.amt, 0);
    const sorted = rows.slice().sort((x, y) => y.amt - x.amt);
    const top = (n: number) => sorted.slice(0, n).reduce((t, x) => t + x.amt, 0) / (total || 1) * 100;
    H.data = { key: k, count: rows.length, total, truncated, top1: top(1), top10: top(10), rows: rows.map(x => ({ ...x, pct: total ? (x.amt / total) * 100 : 0, tag: pa.get(x.addr) || '', label: mine.get(x.addr) || '' })) };
  } catch (e: any) { H.err = String(e?.message || e); }
  H.busy = false;
  paint();
}
async function loadDet(a: string) {
  H.view = a; H.det = { loading: true }; paint();
  const D: any = { addr: a };
  try {
    const [ai, al, nf, tx]: any[] = await Promise.all([
      req('account_info', { account: a, ledger_index: 'validated' }).catch(() => null),
      req('account_lines', { account: a, ledger_index: 'validated', limit: 100 }).catch(() => null),
      req('account_nfts', { account: a, ledger_index: 'validated', limit: 100 }).catch(() => null),
      req('account_tx', { account: a, limit: 25 }).catch(() => null),
    ]);
    D.info = ai && ai.account_data; D.lines = (al && al.lines) || []; D.nfts = (nf && nf.account_nfts) || []; D.nftMore = !!(nf && nf.marker);
    D.txs = ((tx && tx.transactions) || []).map((x: any) => { const t = x.tx_json || x.tx || {}; return { hash: t.hash || x.hash || '', type: t.TransactionType || '', from: t.Account || '', to: t.Destination || '', amt: t.Amount, res: (x.meta && x.meta.TransactionResult) || '', ledger: x.ledger_index || t.ledger_index || '' }; });
    try { const pools = await M.poolRefs(); D.pool = pools.find((p: any) => p.account === a) || null; } catch { D.pool = null; }
  } catch (e: any) { D.err = String(e?.message || e); }
  if (H.view === a) { H.det = D; paint(); }
}
function detail(): string {
  const D = H.det || {}, a = H.view, d = H.data;
  const back = `<button class="pri acc" style="margin-bottom:.9rem" onclick="window.hd.back()">‹ Back to holders</button>`;
  if (D.loading) return `${back}<div class="mut">Reading ${esc(addr(a))}…</div>`;
  const row = d && d.rows.find((x: any) => x.addr === a), I = D.info, tok = assetOf(H.sel), N = ctx.native();
  const sample = H.tokens.find((t: M.TokenRow) => t.usdPx != null && t.nativePx);
  const upn: number | null = sample ? (sample.usdPx as number) / (sample.nativePx as number) : null;
  const bal = I ? Number(I.Balance) / 1e6 : 0;
  const pxOf = (l: any) => { const t = H.tokens.find((x: M.TokenRow) => x.a.c === l.currency && x.a.i === l.account); return t && t.usdPx != null ? t.usdPx : null; };
  const lines = (D.lines || []).slice().sort((x: any, y: any) => (Number(y.balance) * (pxOf(y) || 0)) - (Number(x.balance) * (pxOf(x) || 0)) || Number(y.balance) - Number(x.balance));
  const tokUsd = lines.reduce((t: number, l: any) => t + (Number(l.balance) > 0 && pxOf(l) != null ? Number(l.balance) * pxOf(l) : 0), 0);
  const total = upn != null ? bal * upn + tokUsd : null;
  const roles: string[] = [];
  if (D.pool) roles.push('AMM pool'); if (row && row.label) roles.push('Your wallet · ' + row.label);
  const nm = (c: string) => (String(c).length === 40 ? String(c).slice(0, 6) + '…' + String(c).slice(-4) : String(c));
  const amtS = (v: any) => v == null ? '' : typeof v === 'string' ? fmt(Number(v) / 1e6, 6) + ' ' + N : fmt(Number(v.value), 6) + ' ' + nm(v.currency);
  const stat = (k: string, v: string, sub = '') => `<div style="padding:.8rem 1rem;border-radius:1rem;background:rgba(255,255,255,.04);border:1px solid var(--line)"><div class="k" style="margin:0">${k}</div><div style="font-size:1.25rem;font-weight:700;margin-top:.2rem;word-break:break-word">${v}</div>${sub ? `<div class="mut" style="font-size:.74rem">${sub}</div>` : ''}</div>`;
  const hue = (c: string) => { let h = 0; for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  const tcard = (title: string, sub: string, amt: string, usdv: string, c: string) => `<div style="padding:.9rem;border-radius:1rem;border:1px solid var(--line);background:linear-gradient(145deg,hsla(${hue(c)},70%,45%,.16),rgba(255,255,255,.02));display:flex;gap:.7rem;align-items:center"><div style="flex:none;width:2.4rem;height:2.4rem;border-radius:50%;display:grid;place-items:center;font-weight:800;background:hsla(${hue(c)},70%,50%,.35)">${esc((title[0] || '?').toUpperCase())}</div><div style="min-width:0;flex:1"><div style="font-weight:700">${esc(title)}</div><div class="mut mono" style="font-size:.7rem;overflow:hidden;text-overflow:ellipsis">${esc(sub)}</div></div><div style="text-align:right"><div style="font-weight:700">${amt}</div><div class="mut" style="font-size:.74rem">${usdv}</div></div></div>`;
  const cards = [tcard(N, 'native coin', fmt(bal, 4), upn != null ? usd(bal * upn) : '', N)].concat(lines.map((l: any) => {
    const p = pxOf(l), bv = Number(l.balance);
    return tcard(nm(l.currency), 'issuer ' + short(addr(l.account), 6, 4), fmt(bv, bv < 1 ? 6 : 2), p != null ? usd(bv * p) : '', l.currency + l.account);
  }));
  const txr = (D.txs || []).map((t: any) => {
    const out = t.from === a, ok = t.res === 'tesSUCCESS', other = out ? (t.to || '') : t.from;
    return `<div style="display:flex;gap:.6rem;align-items:center;padding:.6rem .2rem;border-bottom:1px solid var(--line);flex-wrap:wrap"><span class="chip">${esc(t.type)}</span><span class="mono mut" style="font-size:.76rem;flex:1;min-width:8rem">${other ? (out ? '→ ' : '← ') + esc(short(addr(other), 6, 4)) : ''}</span><b>${esc(amtS(t.amt))}</b><span class="${ok ? 'ok' : 'crit'}" style="font-size:.74rem">${ok ? '✓' : esc(t.res)}</span><span class="mut" style="font-size:.74rem">#${esc(String(t.ledger))}</span></div>`;
  }).join('');
  return `${back}
  <div style="padding:1.3rem;border-radius:1.4rem;border:1px solid var(--line);background:radial-gradient(120% 140% at 0% 0%,rgba(90,240,160,.16),transparent 55%),linear-gradient(160deg,rgba(130,90,255,.18),rgba(255,255,255,.02))">
    <div class="k" style="margin:0">Wallet</div>
    <div class="mono" style="word-break:break-all;font-size:1rem;margin:.3rem 0">${esc(addr(a))} <a href="#" class="mut" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(addr(a))}');return false">copy</a></div>
    <div>${roles.map(r => `<span class="chip">${esc(r)}</span>`).join(' ')}</div>
    <div style="display:flex;gap:1.6rem;flex-wrap:wrap;margin-top:1rem;align-items:flex-end">
      <div><div class="mut" style="font-size:.78rem">${total != null ? 'Estimated value' : 'Balance'}</div><div style="font-size:2.3rem;font-weight:800;line-height:1.1">${total != null ? usd(total) : fmt(bal, 4) + ' ' + esc(N)}</div></div>
      ${total != null ? `<div><div class="mut" style="font-size:.78rem">${esc(N)} balance</div><div style="font-size:1.3rem;font-weight:700">${fmt(bal, 4)}</div></div>` : ''}
    </div>
  </div>
  <div class="pgrid nwk" style="margin:1rem 0;gap:.6rem">${[
    stat('Holds of ' + (isNative(tok) ? esc(N) : esc(nm(tok.c))), row ? fmt(row.amt, 4) : '–', row ? row.pct.toFixed(4) + '% of supply' : ''),
    stat('Tokens', String(lines.length) + (lines.length >= 100 ? '+' : '')),
    stat('NFTs', String((D.nfts || []).length) + (D.nftMore ? '+' : '')),
    stat('Owned objects', I ? String(I.OwnerCount || 0) : '–'),
    stat('Sequence', I ? String(I.Sequence) : '–', I ? (I.RegularKey ? 'has a regular key' : '') : 'not on ledger'),
  ].join('')}</div>
  <div class="k" style="margin:1.2rem 0 .5rem">Everything this wallet holds</div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(17rem,1fr));gap:.7rem">${cards.join('')}</div>
  ${(D.nfts || []).length ? `<div class="k" style="margin:1.4rem 0 .5rem">NFTs</div><div class="mono mut" style="font-size:.76rem;max-height:8rem;overflow:auto">${D.nfts.slice(0, 60).map((n: any) => `#${esc(String(n.nft_serial ?? ''))} · taxon ${esc(String(n.NFTokenTaxon ?? ''))}`).join('<br>')}</div>` : ''}
  <div class="k" style="margin:1.4rem 0 .3rem">Recent transactions</div>
  ${txr || '<div class="mut">No transactions.</div>'}
  <div style="margin-top:1.2rem">${back}</div>`;
}
function paint() {
  const r = $('hd');
  if (!r) return;
  const q = H.q.toLowerCase();
  const toks = H.tokens.filter((t: M.TokenRow) => !q || (t.name + ' ' + t.issuer).toLowerCase().includes(q));
  const chip = (k: string, l: string, px: string) => `<button class="${H.sel === k ? 'pri acc' : ''}" style="margin:.15rem" onclick="window.hd.open('${esc(k)}')">${esc(l)}${px}</button>`;
  const d = H.data;
  let body = '<div class="mut" style="padding:1rem">Reading holders from the ledger…</div>';
  if (H.err) body = `<div class="crit" style="padding:1rem">${esc(H.err)}</div>`;
  else if (d && d.key === H.sel) {
    const hq = H.hq.toLowerCase();
    let l = d.rows.filter((x: any) => !hq || (addr(x.addr) + ' ' + x.addr + ' ' + x.label + ' ' + x.tag).toLowerCase().includes(hq));
    const k = H.sort;
    l.sort((a: any, b: any) => ((k === 'addr' ? addr(a.addr).localeCompare(addr(b.addr)) : k === 'label' ? (a.label || a.tag).localeCompare(b.label || b.tag) : a.amt - b.amt)) * H.dir);
    const per = 100, pages = Math.max(1, Math.ceil(l.length / per));
    if (H.page >= pages) H.page = pages - 1;
    const sl = l.slice(H.page * per, H.page * per + per);
    const th = (kk: string, t: string, cls = '') => `<th class="${cls}" style="cursor:pointer" onclick="window.hd.sort('${kk}')">${t}${H.sort === kk ? (H.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`;
    const a = assetOf(d.key), row = H.tokens.find((t: M.TokenRow) => t.key === d.key);
    body = `<div class="pgrid nwk" style="margin:.6rem 0">${[['Holders', fmt(d.count, 0)], ['Total held', fmt(d.total, 2)], ['Largest holder', d.top1.toFixed(2) + '%'], ['Top 10 hold', d.top10.toFixed(2) + '%'], ['Price', row && row.usdPx != null ? usd(row.usdPx) : '–']].map(([k, v]) => `<div class="tile kvt"><div class="k">${k}</div><div class="big2">${v}</div></div>`).join('')}</div>
    ${d.truncated ? '<div class="crit">Very large token: only the first holders were read.</div>' : ''}
    <div class="mut" style="font-size:.78rem;margin-bottom:.4rem">${isNative(a) ? 'Native coin: every funded account.' : `Issuer <span class="mono">${esc(addr(a.i))}</span>`}</div>
    <div class="row" style="gap:.5rem;margin-bottom:.5rem;flex-wrap:wrap"><input placeholder="Search address or name" value="${esc(H.hq)}" oninput="window.hd.hsearch(this.value)" style="width:20rem"><button class="sm ghost" onclick="window.hd.refresh()">Refresh</button><button class="sm ghost" onclick="window.hd.csv()">Export CSV</button></div>
    <div style="overflow:auto"><table class="dxt"><thead><tr><th>#</th>${th('addr', 'Wallet')}${th('label', 'Name')}${th('amount', 'Amount', 'r')}<th class="r">Share</th><th style="width:12rem"></th></tr></thead><tbody>${sl.map((x: any, i: number) => `<tr style="cursor:pointer" onclick="window.hd.view('${esc(x.addr)}')"><td class="mut">${H.page * per + i + 1}</td><td class="mono" style="word-break:break-all">${esc(addr(x.addr))} <a href="#" onclick="event.stopPropagation();navigator.clipboard&&navigator.clipboard.writeText('${esc(addr(x.addr))}');return false" class="mut">copy</a></td><td>${x.label ? esc(x.label) + ' <span class="chip">yours</span>' : x.tag ? `<span class="chip">${esc(x.tag)}</span>` : '<span class="mut">–</span>'}</td><td class="r">${esc(fmt(x.amt, 6))}</td><td class="r">${x.pct.toFixed(2)}%</td><td><div style="height:6px;border-radius:3px;background:rgba(255,255,255,.07)"><i style="display:block;height:100%;width:${Math.min(100, x.pct).toFixed(1)}%;background:#00ff8c;border-radius:3px"></i></div></td></tr>`).join('') || '<tr><td colspan="6" class="mut" style="padding:1rem">No holders.</td></tr>'}</tbody></table></div>
    ${pages > 1 ? `<div class="nmpg"><button class="sm ghost" ${H.page === 0 ? 'disabled' : ''} onclick="window.hd.pg(${H.page - 1})">‹ Prev</button><span class="mut">Page ${H.page + 1} of ${pages}</span><button class="sm ghost" ${H.page >= pages - 1 ? 'disabled' : ''} onclick="window.hd.pg(${H.page + 1})">Next ›</button></div>` : ''}`;
  }
  r.innerHTML = `<div class="card"><div class="row" style="gap:.6rem;flex-wrap:wrap;justify-content:space-between"><div class="k" style="margin:0">Token holders</div><input placeholder="Search tokens by name or issuer" value="${esc(H.q)}" oninput="window.hd.search(this.value)" style="width:20rem"></div>
    <div style="margin:.5rem 0">${chip('native', ctx.native(), ' <small class="mut">native</small>')}${toks.map((t: M.TokenRow) => chip(t.key, t.name, t.usdPx != null ? ` <small class="mut">${esc(usd(t.usdPx))}</small>` : '')).join('')}</div></div>
    <div class="card" style="margin-top:1rem">${H.view ? detail() : body}</div>`;
  const e = document.querySelector('#hd input[oninput*="hsearch"]') as HTMLInputElement;
  void e; void akey; void short;
}
export const hdApi = {
  open: (k: string) => open(k),
  search(v: string) { H.q = v; const p = document.activeElement as HTMLInputElement; paint(); const e = document.querySelector('#hd input') as HTMLInputElement; if (e && p) { e.focus(); e.setSelectionRange(v.length, v.length); } },
  hsearch(v: string) { H.hq = v; H.page = 0; paint(); const e = document.querySelectorAll('#hd input')[1] as HTMLInputElement; if (e) { e.focus(); e.setSelectionRange(v.length, v.length); } },
  sort(k: string) { if (H.sort === k) H.dir = -H.dir; else { H.sort = k; H.dir = k === 'amount' ? -1 : 1; } paint(); },
  pg(p: number) { H.page = Math.max(0, p); paint(); },
  refresh() { open(H.sel); },
  view(a: string) { loadDet(a); },
  back() { H.view = ''; H.det = null; paint(); },
  csv() {
    const d = H.data; if (!d) return;
    const csv = 'rank,wallet,name,amount,share_pct\n' + d.rows.slice().sort((a: any, b: any) => b.amt - a.amt).map((x: any, i: number) => `${i + 1},${addr(x.addr)},"${(x.label || x.tag).replace(/"/g, '')}",${x.amt},${x.pct.toFixed(4)}`).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'holders.csv'; a.click();
  },
};
