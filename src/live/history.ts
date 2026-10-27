// History page: every transaction of the active account on one line, sortable, searchable; click one for the full detail page.
import { ctx } from './ctx.ts';
import { req } from './chain.ts';
import { esc, fmt, hexName, rippleToMs, short } from './util.ts';

interface Row {
  hash: string; ms: number; ledger: number; type: string; res: string; ok: boolean; fee: number; seq: number;
  from: string; to: string; cp: string; out: boolean; amt: string; amtN: number; cur: string; sum: string; raw: any; meta: any;
}
const HX: any = { rows: [] as Row[], marker: null as any, done: false, busy: false, acct: '', q: '', type: '', sort: 'time', dir: -1, sel: '', err: '' };
const $ = (id: string) => document.getElementById(id);
const sh = (a: string) => (a ? short(ctx.show(a), 8, 6) : '');
const cur = (c: string) => (c === 'XRP' || c === 'native' ? ctx.native() : hexName(c));
function amtOf(a: any): { s: string; n: number; c: string } {
  if (a == null) return { s: '', n: 0, c: '' };
  if (typeof a === 'string') return { s: fmt(Number(a) / 1e6, 6) + ' ' + ctx.native(), n: Number(a) / 1e6, c: ctx.native() };
  if (a.currency) return { s: fmt(Number(a.value), 6) + ' ' + cur(a.currency), n: Number(a.value), c: cur(a.currency) };
  return { s: '', n: 0, c: '' };
}
function toRow(x: any, me: string): Row | null {
  const t = x.tx_json || x.tx || {};
  const m = x.meta || x.metaData || {};
  const hash = x.hash || t.hash;
  if (!hash || !t.TransactionType) return null;
  const res = m.TransactionResult || '';
  const dl = m.delivered_amount && m.delivered_amount !== 'unavailable' ? m.delivered_amount : t.Amount;
  const out = t.Account === me;
  const type = t.TransactionType as string;
  const a = amtOf(type === 'OfferCreate' ? t.TakerGets : dl);
  let sum = '';
  if (type === 'Payment') sum = out ? `Sent to ${sh(t.Destination)}` : `Received from ${sh(t.Account)}`;
  else if (type === 'OfferCreate') sum = `Sell ${amtOf(t.TakerGets).s} for ${amtOf(t.TakerPays).s}`;
  else if (type === 'OfferCancel') sum = `Cancel offer #${t.OfferSequence}`;
  else if (type === 'TrustSet') sum = `Trust ${cur(t.LimitAmount?.currency || '')} from ${sh(t.LimitAmount?.issuer || '')}`;
  else if (type.startsWith('NFToken')) sum = type.replace('NFToken', 'NFT ');
  else if (type.startsWith('AMM')) sum = type.replace('AMM', 'Pool ');
  else sum = type;
  return {
    hash, ms: t.date != null ? rippleToMs(t.date) : 0, ledger: Number(x.ledger_index || t.ledger_index || 0), type, res, ok: res === 'tesSUCCESS',
    fee: Number(t.Fee || 0) / 1e6, seq: Number(t.Sequence || 0), from: t.Account || '', to: t.Destination || '', cp: out ? t.Destination || '' : t.Account || '', out,
    amt: a.s, amtN: a.n, cur: a.c, sum, raw: t, meta: m,
  };
}
async function loadMore() {
  const me = ctx.account();
  if (!me || HX.busy || (HX.done && HX.acct === me)) return;
  if (HX.acct !== me) Object.assign(HX, { rows: [], marker: null, done: false, acct: me, sel: '', err: '' });
  HX.busy = true;
  paint();
  try {
    const r: any = await req('account_tx', { account: me, ledger_index_min: -1, ledger_index_max: -1, limit: 100, ...(HX.marker ? { marker: HX.marker } : {}) });
    const seen = new Set(HX.rows.map((x: Row) => x.hash));
    for (const x of r.transactions || []) { const row = toRow(x, me); if (row && !seen.has(row.hash)) HX.rows.push(row); }
    HX.marker = r.marker || null;
    if (!r.marker) HX.done = true;
  } catch (e: any) { HX.err = String(e?.message || e); }
  HX.busy = false;
  paint();
}
export function shell() { return `<div id="hx" class="nwpage"></div>`; }
export function mount() { if (HX.acct !== ctx.account()) Object.assign(HX, { rows: [], marker: null, done: false }); if (!HX.rows.length) loadMore(); else paint(); }
const ago = (ms: number) => (ms ? new Date(ms).toLocaleString() : '–');
function list(): Row[] {
  const q = HX.q.trim().toLowerCase();
  let l: Row[] = HX.rows.filter((r: Row) => (!HX.type || r.type === HX.type) && (!q || (r.type + ' ' + r.sum + ' ' + r.hash + ' ' + r.cp + ' ' + r.amt + ' ' + ctx.show(r.cp)).toLowerCase().includes(q)));
  const k = HX.sort, d = HX.dir;
  l.sort((a: any, b: any) => { const x = k === 'amt' ? a.amtN : k === 'fee' ? a.fee : k === 'ledger' ? a.ledger : k === 'time' ? a.ms : String(a[k] ?? ''); const y = k === 'amt' ? b.amtN : k === 'fee' ? b.fee : k === 'ledger' ? b.ledger : k === 'time' ? b.ms : String(b[k] ?? ''); return (x < y ? -1 : x > y ? 1 : 0) * d || b.ledger - a.ledger; });
  return l;
}
const th = (k: string, l: string, cls = '') => `<th class="${cls} srt" onclick="window.hx.sort('${k}')" style="cursor:pointer;white-space:nowrap">${l}${HX.sort === k ? (HX.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`;
function paint(): void {
  const r = $('hx');
  if (!r) return;
  if (HX.sel) return detail(r);
  const l = list();
  const types = [...new Set(HX.rows.map((x: Row) => x.type))].sort() as string[];
  const fees = HX.rows.reduce((t: number, x: Row) => t + (x.out ? x.fee : 0), 0);
  r.innerHTML = `<div class="card"><div class="row" style="gap:.6rem;flex-wrap:wrap;justify-content:space-between"><div><div class="k" style="margin:0">Transaction history (${ctx.native()})</div><small class="mut">${HX.rows.length} loaded${HX.done ? ', that is everything' : ''} · ${fmt(fees, 6)} ${ctx.native()} paid in fees · click a row for details</small></div>
    <div class="row" style="gap:.5rem;flex-wrap:wrap"><input placeholder="Search type, address, amount or hash" value="${esc(HX.q)}" oninput="window.hx.search(this.value)" style="width:18rem"><select onchange="window.hx.type(this.value)"><option value="">All types</option>${types.map(t => `<option ${HX.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select><button class="sm ghost" onclick="window.hx.reload()">Refresh</button></div></div>
    ${HX.err ? `<div class="crit" style="margin:.5rem 0">${esc(HX.err)}</div>` : ''}
    <div style="overflow:auto;margin-top:.6rem"><table class="dxt hxt"><thead><tr>${th('time', 'Time')}${th('type', 'Type')}<th>Details</th>${th('cp', 'Counterparty')}${th('amt', 'Amount', 'r')}${th('fee', 'Fee', 'r')}${th('ledger', 'Ledger', 'r')}${th('res', 'Result')}</tr></thead><tbody>${
      l.map(x => `<tr class="clk" onclick="window.hx.open('${esc(x.hash)}')"><td class="mut" style="white-space:nowrap">${esc(ago(x.ms))}</td><td><b>${esc(x.type)}</b></td><td style="max-width:22rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.sum)}</td><td class="mono">${x.cp ? esc(sh(x.cp)) : '–'}</td><td class="r ${x.type === 'Payment' ? (x.out ? 'warn' : 'ok') : ''}">${x.amt ? (x.type === 'Payment' ? (x.out ? '−' : '+') : '') + esc(x.amt) : '–'}</td><td class="r mut">${x.out && x.fee ? fmt(x.fee, 6) : '–'}</td><td class="r mono">${x.ledger || '–'}</td><td class="${x.ok ? 'ok' : 'crit'}">${x.ok ? '✓' : esc(x.res || '?')}</td></tr>`).join('') || `<tr><td colspan="8" class="mut" style="padding:1rem">${HX.busy ? 'Reading transactions…' : 'No transactions match.'}</td></tr>`}</tbody></table></div>
    <div class="nmpg">${HX.done ? '' : `<button class="sm pri acc" ${HX.busy ? 'disabled' : ''} onclick="window.hx.more()">${HX.busy ? 'Loading…' : 'Load 100 more'}</button>`}</div></div>`;
}
function kv(k: string, v: string, mono = false) { return `<div><span>${esc(k)}</span><b class="${mono ? 'mono' : ''}" style="${mono ? 'font-size:.78rem;word-break:break-all' : ''}">${v}</b></div>`; }
function changes(row: Row, me: string): string {
  const out: string[] = [];
  for (const n of row.meta.AffectedNodes || []) {
    const k = Object.keys(n)[0], e = n[k], f = e.FinalFields || e.NewFields || {}, p = e.PreviousFields || {};
    if (e.LedgerEntryType === 'AccountRoot' && p.Balance != null && f.Balance != null) {
      const d = (Number(f.Balance) - Number(p.Balance)) / 1e6;
      if (d) out.push(`<tr><td class="mono">${esc(sh(f.Account))}${f.Account === me ? ' <span class="chip">you</span>' : ''}</td><td>${ctx.native()}</td><td class="r ${d < 0 ? 'warn' : 'ok'}">${d > 0 ? '+' : ''}${fmt(d, 6)}</td></tr>`);
    } else if (e.LedgerEntryType === 'RippleState' && p.Balance && f.Balance) {
      const lo = f.LowLimit?.issuer, hi = f.HighLimit?.issuer, c = cur(f.Balance.currency);
      let d = Number(f.Balance.value) - Number(p.Balance.value);
      const mine = hi === me ? -d : lo === me ? d : 0;
      if (d) out.push(`<tr><td class="mono">${esc(sh(lo))} ↔ ${esc(sh(hi))}${lo === me || hi === me ? ' <span class="chip">you</span>' : ''}</td><td>${esc(c)}</td><td class="r ${(lo === me || hi === me ? mine : d) < 0 ? 'warn' : 'ok'}">${(lo === me || hi === me ? mine : d) > 0 ? '+' : ''}${fmt(lo === me || hi === me ? mine : d, 6)}</td></tr>`);
    }
  }
  return out.length ? `<table class="dxt"><thead><tr><th>Account / line</th><th>Asset</th><th class="r">Change</th></tr></thead><tbody>${out.join('')}</tbody></table>` : '<div class="mut">No balance changes.</div>';
}
function detail(r: HTMLElement): void {
  const x: Row | undefined = HX.rows.find((y: Row) => y.hash === HX.sel);
  if (!x) { HX.sel = ''; return paint(); }
  const t = x.raw, me = ctx.account() || '';
  const fields = Object.keys(t).filter(k => !['TxnSignature', 'SigningPubKey', 'hash', 'Signers', 'Account', 'Destination', 'Fee', 'Sequence', 'TransactionType', 'date', 'ledger_index', 'inLedger', 'Flags'].includes(k));
  const show = (v: any): string => (v && typeof v === 'object' ? (v.currency ? esc(amtOf(v).s) + (v.issuer ? ` <small class="mut">issued by ${esc(sh(v.issuer))}</small>` : '') : `<span class="mono" style="font-size:.74rem">${esc(JSON.stringify(v))}</span>`) : /^\d+$/.test(String(v)) && /Amount|Fee|TakerGets|TakerPays|SendMax|DeliverMin/.test('') ? '' : esc(String(v)));
  const memo = (t.Memos || []).map((m: any) => { try { return decodeURIComponent(escape(atob(btoa(String.fromCharCode(...(String(m.Memo?.MemoData || '').match(/../g) || []).map((h: string) => parseInt(h, 16))))))); } catch { return ''; } }).filter(Boolean);
  r.innerHTML = `<div class="row" style="margin-bottom:.8rem;gap:.5rem"><button class="ghost" onclick="window.hx.back()">← Back to history</button><span style="flex:1"></span><button class="sm ghost" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(x.hash)}')">Copy hash</button></div>
  <div class="card"><div class="row" style="gap:.6rem;align-items:center;flex-wrap:wrap"><h2 style="margin:0">${esc(x.type)}</h2><span class="chip ${x.ok ? '' : 'b'}" style="${x.ok ? 'background:rgba(0,255,140,.2);color:#00ff8c' : 'background:rgba(255,80,80,.2);color:#ff5a5a'}">${x.ok ? 'Validated' : esc(x.res)}</span></div>
  <div class="mut" style="margin:.3rem 0 .8rem">${esc(x.sum)} · ${esc(ago(x.ms))}</div>
  <div class="kvl">${kv('Amount', x.amt ? esc(x.amt) : '–')}${kv('Fee', x.fee ? fmt(x.fee, 6) + ' ' + ctx.native() : '–')}${kv('From', esc(ctx.show(x.from)) + (x.from === me ? ' (you)' : ''), true)}${kv('To', x.to ? esc(ctx.show(x.to)) + (x.to === me ? ' (you)' : '') : '–', true)}${kv('Ledger', String(x.ledger || '–'))}${kv('Sequence', String(x.seq || '–'))}${kv('Result', esc(x.res || '–'))}${kv('Index in ledger', String(x.meta.TransactionIndex ?? '–'))}${kv('Transaction hash', esc(x.hash), true)}</div></div>
  ${fields.length ? `<div class="nwh">Transaction fields</div><div class="card"><table class="dxt"><tbody>${fields.map(k => `<tr><td class="mut" style="width:14rem">${esc(k)}</td><td>${show(t[k])}</td></tr>`).join('')}</tbody></table>${memo.length ? `<div class="mut" style="margin-top:.5rem">Memo: ${esc(memo.join(' · '))}</div>` : ''}</div>` : ''}
  <div class="nwh">Balance changes</div><div class="card" style="overflow:auto">${changes(x, me)}</div>
  <div class="nwh">Ledger objects touched</div><div class="card"><div class="row" style="gap:.4rem;flex-wrap:wrap">${(x.meta.AffectedNodes || []).map((n: any) => { const k = Object.keys(n)[0]; return `<span class="chip">${esc(k.replace('Node', ''))} · ${esc(n[k].LedgerEntryType)}</span>`; }).join('') || '<span class="mut">none</span>'}</div></div>
  <details class="card" style="margin-top:1rem"><summary style="cursor:pointer">Raw transaction and metadata (JSON)</summary><pre style="overflow:auto;max-height:28rem;font-size:.72rem">${esc(JSON.stringify({ tx: x.raw, meta: x.meta }, null, 2))}</pre></details>`;
  window.scrollTo?.({ top: 0 });
}
export const hxApi = {
  sort(k: string) { if (HX.sort === k) HX.dir = -HX.dir; else { HX.sort = k; HX.dir = k === 'type' || k === 'cp' || k === 'res' ? 1 : -1; } paint(); },
  search(v: string) { HX.q = v; paint(); const e = document.querySelector('#hx input') as HTMLInputElement; if (e) { e.focus(); e.setSelectionRange(v.length, v.length); } },
  type(v: string) { HX.type = v; paint(); },
  open(h: string) { HX.sel = h; paint(); },
  back() { HX.sel = ''; paint(); },
  more() { loadMore(); },
  reload() { Object.assign(HX, { rows: [], marker: null, done: false, sel: '' }); loadMore(); },
};
