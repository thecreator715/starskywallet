// Network page: full-width live explorer read straight from the connected node (no admin, nothing simulated).
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import * as TK from './tokens.ts';
import { detectGenesis } from './supply.ts';
import { ago, dur, esc, fmt, hexName, rippleToMs, short, usd } from './util.ts';
import { cached, header, info, ledgerAgo, pool as poolMap, secPerLedger } from './chain.ts';

const $ = (id: string) => document.getElementById(id);
const setHtml = (id: string, h: string) => {
  const e = $(id) as any;
  if (e && e.__h !== h) {
    e.innerHTML = h;
    e.__h = h;
  }
};
const wait = (m: string) => `<div class="mut" style="padding:1rem">${m}</div>`;
const kv = (k: string, v: string, sub = '') => `<div class="tile kvt"><div class="k">${k}</div><div class="big2">${v}</div>${sub ? `<div class="mut" style="font-size:.78rem">${sub}</div>` : ''}</div>`;
let gen = 0;
const WINDOW = 40;

interface Row {
  hash: string;
  type: string;
  from: string;
  to: string;
  detail: string;
  amount: string;
  fee: number;
  result: string;
  seq: number;
  ms: number;
  genesis: boolean;
}
interface Led {
  seq: number;
  ms: number;
  hash: string;
  txs: any[];
}
export const NW: any = { led: [] as Led[], rows: [] as Row[], timer: null, f: '', lim: 40, types: [] as string[], keepHtml: '' };

async function ledgerFull(seq: number): Promise<Led | null> {
  try {
    return await cached('lf' + seq, Infinity, async () => {
      const l = (await ctx.req('ledger', { ledger_index: seq, transactions: true, expand: true })).ledger;
      if (!l) throw new Error('none');
      return { seq: Number(l.ledger_index), ms: rippleToMs(l.close_time || 0), hash: l.ledger_hash || '', txs: (l.transactions || []).filter((t: any) => typeof t === 'object') };
    });
  } catch {
    return null;
  }
}
const nat = () => ctx.native();
const cur = (c: string) => (c === 'XRP' ? nat() : hexName(c));
function amt(a: any): string {
  if (a == null) return '';
  if (typeof a === 'string') return fmt(Number(a) / 1e6, 6) + ' ' + nat();
  if (a.value != null) return fmt(Number(a.value)) + ' ' + cur(a.currency);
  return '';
}
const amtLbl = (a: any) => (a == null ? '' : typeof a === 'string' ? nat() : a.currency ? cur(a.currency) : '');
function sh(a: string) {
  try {
    return short(ctx.show(a), 7, 6);
  } catch {
    return short(a, 7, 6);
  }
}
function norm(t: any, l: Led, gen0: string): Row {
  const x = t.tx_json || t;
  const meta = t.meta || t.metaData || {};
  const type = x.TransactionType || t.TransactionType || '?';
  const from = x.Account || '';
  let to = x.Destination || '';
  let detail = '';
  let amount = '';
  switch (type) {
    case 'Payment':
      amount = amt(x.DeliverMax ?? x.Amount);
      detail = to ? '' : 'payment';
      break;
    case 'OfferCreate':
      detail = `${x.Flags & 0x80000 ? 'sell' : 'buy'} ${amt(x.TakerGets)} for ${amt(x.TakerPays)}`;
      break;
    case 'OfferCancel':
      detail = 'cancel offer #' + x.OfferSequence;
      break;
    case 'TrustSet':
      detail = `trust ${cur(x.LimitAmount?.currency || '')} · limit ${fmt(Number(x.LimitAmount?.value || 0))}`;
      break;
    case 'AMMDeposit':
    case 'AMMWithdraw':
      detail = [x.Amount, x.Amount2].filter(Boolean).map(amt).join(' + ') || 'LP tokens';
      amount = amt(x.Amount);
      break;
    case 'AMMCreate':
      detail = `${amt(x.Amount)} + ${amt(x.Amount2)}`;
      amount = amt(x.Amount);
      break;
    case 'NFTokenMint':
      detail = 'mint NFT' + (x.NFTokenTaxon != null ? ' · taxon ' + x.NFTokenTaxon : '');
      break;
    case 'NFTokenCreateOffer':
      detail = (x.Flags & 1 ? 'sell offer ' : 'buy offer ') + amt(x.Amount);
      break;
    case 'AccountSet':
      detail = 'account settings';
      break;
    default:
      detail = '';
  }
  let g = false;
  try {
    g = !!gen0 && ctx.toClassic(gen0) === from;
  } catch {}
  return { hash: t.hash || x.hash || '', type, from, to, detail, amount, fee: Number(x.Fee || 0) / 1e6, result: meta.TransactionResult || t.TransactionResult || '?', seq: l.seq, ms: l.ms, genesis: g };
}
const created = (t: any) => ((t.meta || t.metaData || {}).AffectedNodes || []).filter((n: any) => n.CreatedNode && n.CreatedNode.LedgerEntryType === 'AccountRoot').length;

export function networkShell() {
  return `<div id="nw" class="nwpage">
    <div class="card" style="margin-bottom:1rem"><div class="row" style="gap:.6rem;flex-wrap:wrap">
      <input id="nw_q" class="grow" placeholder="Search an account (L… / T… / r…), transaction hash or ledger number" onkeydown="if(event.key==='Enter')window.nw.search()">
      <button class="pri acc" onclick="window.nw.search()">Search</button></div><div id="nw_err" class="crit" style="font-size:.82rem;margin-top:.4rem"></div></div>
    <div class="nwh">Overview</div><div class="pgrid nwk" id="nw_tiles">${wait('Reading the node…')}</div>
    <div class="nwh">Transactions <small class="mut" id="nw_win"></small></div><div class="pgrid nwk" id="nw_tiles2"></div>
    <div class="nwg3" style="margin-top:1rem">
      <div class="tile"><div class="k">Transactions per ledger</div><div id="nw_chart"></div></div>
      <div class="tile"><div class="k">Ledger close time (seconds)</div><div id="nw_close"></div></div>
      <div class="tile"><div class="k">Transaction types</div><div id="nw_types"></div></div>
    </div>
    <div class="nwg3" style="margin-top:1rem">
      <div class="tile"><div class="k">Most active accounts</div><div id="nw_top"></div></div>
      <div class="tile"><div class="k">Results</div><div id="nw_res"></div></div>
      <div class="tile"><div class="k">Latest ledgers</div><div id="nw_ledgers" class="nwscroll"></div></div>
    </div>
    <div class="card" style="margin-top:1rem"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:.5rem"><div class="k" style="margin:0">Latest transactions</div><div id="nw_chips" class="dxfilters"></div></div>
      <div id="nw_txs" class="nwscroll" style="margin-top:.6rem"></div></div></div>`;
}
export function networkMount() {
  clearInterval(NW.timer);
  NW.timer = setInterval(() => {
    if (!$('nw')) return clearInterval(NW.timer);
    if (ctx.online() && !document.hidden) networkLoad(true);
  }, 15000);
  const e = $('nw') as any;
  if (e && NW.keepHtml) {
    e.innerHTML = NW.keepHtml;
  }
  networkLoad(false);
}
export function networkUnmount() {
  clearInterval(NW.timer);
}
function bars(vals: number[], lab0: string, lab1: string, fmtv: (v: number) => string, color = 'var(--ok)') {
  const W = 640,
    H = 150,
    mx = Math.max(1e-9, ...vals),
    bw = W / Math.max(1, vals.length);
  return `<svg viewBox="0 0 ${W} ${H + 18}" preserveAspectRatio="none" style="width:100%;height:11rem">${[0.25, 0.5, 0.75].map(f => `<line x1="0" x2="${W}" y1="${H * f}" y2="${H * f}" stroke="rgba(255,255,255,.06)"/>`).join('')}${vals.map((v, k) => `<rect x="${k * bw + 1}" y="${H - (v / mx) * H}" width="${Math.max(1, bw - 2)}" height="${(v / mx) * H}" fill="${color}" opacity=".78"><title>${fmtv(v)}</title></rect>`).join('')}<text x="0" y="${H + 14}" fill="#8a9a92" font-size="11">${lab0}</text><text x="${W}" y="${H + 14}" fill="#8a9a92" font-size="11" text-anchor="end">${lab1} · max ${fmtv(mx)}</text></svg>`;
}
function drawTxs() {
  const rows: Row[] = NW.rows.filter((r: Row) => !NW.f || r.type === NW.f);
  const shown = rows.slice(0, NW.lim);
  setHtml(
    'nw_chips',
    ['', ...NW.types].map(t => `<button class="${NW.f === t ? 'on' : ''}" onclick="window.nw.filter('${esc(t)}')">${t ? esc(t) : 'All'}</button>`).join('')
  );
  setHtml(
    'nw_txs',
    `<table class="dxt nwt"><thead><tr><th>Hash</th><th>Type</th><th>From</th><th>To / detail</th><th class="r">Amount</th><th class="r">Fee</th><th>Result</th><th class="r">Ledger</th><th class="r">Time</th></tr></thead><tbody>${
      shown
        .map(r => {
          const ok = r.result === 'tesSUCCESS';
          const to = r.to ? `<a href="#" class="who mono" onclick="window.inspectAccount('${esc(r.to)}');return false">${esc(sh(r.to))}</a>${r.detail ? ' <span class="mut">' + esc(r.detail) + '</span>' : ''}` : `<span class="mut">${esc(r.detail)}</span>`;
          return `<tr><td class="mono"><a href="#" class="who" onclick="window.inspectTx('${esc(r.hash)}');return false">${esc(short(r.hash, 6, 6))}</a></td><td><b>${esc(r.type)}</b></td><td><a href="#" class="who mono" onclick="window.inspectAccount('${esc(r.from)}');return false">${esc(sh(r.from))}</a>${r.genesis ? ' <span class="chip ok">GENESIS</span>' : ''}</td><td>${to}</td><td class="r">${esc(r.amount)}</td><td class="r mut">${fmt(r.fee, 6)}</td><td><span class="chip ${ok ? 'ok' : 'bad'}">${esc(r.result)}</span></td><td class="r"><a href="#" class="who" onclick="window.inspectLedger(${r.seq});return false">${fmt(r.seq, 0)}</a></td><td class="r mut">${ago(Date.now() - r.ms)}</td></tr>`;
        })
        .join('') || '<tr><td colspan="9" class="mut" style="padding:.8rem">No transactions in the latest ledgers.</td></tr>'
    }</tbody></table>${rows.length > shown.length ? `<div style="text-align:center;margin-top:.6rem"><button class="sm ghost" onclick="window.nw.more()">Show more (${rows.length - shown.length} left)</button></div>` : ''}`
  );
}
export async function networkLoad(soft: boolean) {
  const g = ++gen;
  const alive = () => g === gen && !!$('nw');
  if (!ctx.online()) return setHtml('nw_tiles', wait('Not connected to a node. Check the node address in Settings.'));
  try {
    const i = await info();
    const seqs = Array.from({ length: WINDOW }, (_, k) => i.seq - k).filter(s => s >= i.minSeq);
    const led = ((await poolMap(seqs, 6, ledgerFull)).filter(Boolean) as Led[]).sort((a, b) => a.seq - b.seq);
    if (!alive()) return;
    NW.led = led;
    const nowH = await header(i.seq);
    const spl = await secPerLedger();
    const span = led.length > 1 ? (led[led.length - 1].ms - led[0].ms) / 1000 : 0;
    const close = span > 0 ? span / (led.length - 1) : spl;
    const body = led.slice(1);
    const txN = body.reduce((s, l) => s + l.txs.length, 0);
    const tps = span > 0 ? txN / span : 0;
    const day = await ledgerAgo(86400);
    const dh = await header(day.seq);
    const burned = nowH && dh && dh.seq < nowH.seq ? dh.total - nowH.total : null;
    const pr = await M.snapshot().catch(() => null);
    const gen0 = await (async () => {
      try {
        const sn2 = pr;
        const h = await M.holders({ c: 'native', i: '' } as any, nowH ? nowH.total : 0, new Set(sn2 ? sn2.pools.map(p => p.account) : []));
        return (await detectGenesis(nowH ? nowH.total : 0, h)).addr || TK.genesisAddr();
      } catch {
        return '';
      }
    })();
    const rows: Row[] = [];
    for (const l of [...led].reverse()) for (const t of [...l.txs].reverse()) rows.push(norm(t, l, gen0));
    NW.rows = rows;
    const ok = rows.filter(r => r.result === 'tesSUCCESS').length;
    const fails = rows.length - ok;
    const feeSum = rows.reduce((s, r) => s + r.fee, 0);
    let payVol = 0,
      newAcc = 0,
      payN = 0;
    const accts = new Map<string, number>();
    for (const l of led)
      for (const t of l.txs) {
        const x = t.tx_json || t;
        const r = (t.meta || t.metaData || {}).TransactionResult;
        if (x.Account) accts.set(x.Account, (accts.get(x.Account) || 0) + 1);
        newAcc += created(t);
        const a = x.DeliverMax ?? x.Amount;
        if (x.TransactionType === 'Payment' && r === 'tesSUCCESS') {
          payN++;
          if (typeof a === 'string') payVol += Number(a) / 1e6;
        }
      }
    const typeC: Record<string, number> = {};
    for (const r of rows) typeC[r.type] = (typeC[r.type] || 0) + 1;
    const tt = Object.entries(typeC).sort((a, b) => b[1] - a[1]);
    NW.types = tt.map(x => x[0]);
    if (NW.f && !typeC[NW.f]) NW.f = '';
    const tot = rows.length || 1;
    const n = nat();
    setHtml(
      'nw_tiles',
      [
        kv('Validated ledger', '#' + fmt(i.seq, 0), nowH ? ago(Date.now() - nowH.close) : ''),
        kv('Ledger close', close.toFixed(1) + ' s', `average over ${led.length} ledgers`),
        kv('Throughput', tps.toFixed(2) + ' tx/s', `${(txN / Math.max(1, body.length)).toFixed(1)} transactions per ledger`),
        kv('Success rate', rows.length ? ((ok / rows.length) * 100).toFixed(1) + '%' : '–', `${fails} failed of ${rows.length}`),
        kv('Server', esc(i.state || '–'), `${esc(i.version || '')} · up ${dur(i.uptime)}`),
        kv(`${n} supply`, nowH ? fmt(nowH.total, 2) : '–', pr && pr.usdPerNative != null && nowH ? 'market cap ' + usd(nowH.total * pr.usdPerNative) : ''),
        kv('Burned in fees (about 24h)', burned != null ? fmt(burned, 6) + ' ' + n : '–', dh ? `since ledger #${dh.seq}${day.clamped ? ' (the oldest this node keeps)' : ''}` : ''),
        kv('Network', i.networkId != null ? '#' + i.networkId : '–', `peers ${i.peers} · load ${i.load}${i.quorum ? ' · quorum ' + i.quorum : ''} · history from #${i.minSeq}`),
        kv('Base fee · reserves', `${fmt(i.baseFee, 6)} ${n}`, `reserve ${fmt(i.reserveBase)} + ${fmt(i.reserveInc)} per object`),
        kv('Market price', pr && pr.usdPerNative != null ? usd(pr.usdPerNative) : '–', pr ? `${pr.pools.length} AMM pools` : ''),
      ].join('')
    );
    setHtml('nw_win', `in ${led.length} ledgers (#${led[0]?.seq}–#${led[led.length - 1]?.seq})`);
    setHtml(
      'nw_tiles2',
      [
        kv('Transactions', fmt(rows.length, 0), `${payN} payments`),
        kv('Fees burned', fmt(feeSum, 6), n + ' in this window'),
        kv('Payment volume', fmt(payVol, 2), n + ' (successful)'),
        kv('Active accounts', fmt(accts.size, 0), 'sent a transaction'),
        kv('New accounts', fmt(newAcc, 0), 'created in this window'),
        kv('DEX orders', fmt((typeC.OfferCreate || 0) + (typeC.OfferCancel || 0), 0), `${typeC.OfferCreate || 0} created · ${typeC.OfferCancel || 0} cancelled`),
        kv('AMM actions', fmt((typeC.AMMDeposit || 0) + (typeC.AMMWithdraw || 0) + (typeC.AMMCreate || 0) + (typeC.AMMVote || 0), 0), `${typeC.AMMDeposit || 0} deposits · ${typeC.AMMWithdraw || 0} withdrawals`),
        kv('NFT actions', fmt(Object.entries(typeC).filter(([k]) => k.startsWith('NFToken')).reduce((s, x) => s + x[1], 0), 0), 'mints, offers, accepts'),
      ].join('')
    );
    setHtml('nw_chart', bars(led.map(l => l.txs.length), '#' + led[0]?.seq, '#' + led[led.length - 1]?.seq, v => fmt(v, 0) + ' tx'));
    const gaps = led.slice(1).map((l, k) => Math.max(0, (l.ms - led[k].ms) / 1000));
    setHtml('nw_close', bars(gaps, '#' + led[1]?.seq, '#' + led[led.length - 1]?.seq, v => v.toFixed(1) + ' s', 'var(--acc,#00ff8c)'));
    setHtml('nw_types', tt.map(([k, v]) => `<div class="nwbar"><span>${esc(k)}</span><i style="width:${((v / tt[0][1]) * 100).toFixed(0)}%"></i><b>${v} <small class="mut">${((v / tot) * 100).toFixed(0)}%</small></b></div>`).join('') || '<div class="mut">No transactions in these ledgers.</div>');
    const top = [...accts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    setHtml('nw_top', top.map(([a, c]) => `<div class="dxkv"><a href="#" class="who mono" onclick="window.inspectAccount('${esc(a)}');return false">${esc(sh(a))}</a><span>${c} tx <small class="mut">${((c / tot) * 100).toFixed(0)}%</small></span></div>`).join('') || '<div class="mut">No activity.</div>');
    const rc: Record<string, number> = {};
    for (const r of rows) rc[r.result] = (rc[r.result] || 0) + 1;
    setHtml('nw_res', Object.entries(rc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="dxkv"><span class="chip ${k === 'tesSUCCESS' ? 'ok' : 'bad'}">${esc(k)}</span><span>${v} <small class="mut">${((v / tot) * 100).toFixed(1)}%</small></span></div>`).join('') || '<div class="mut">No results yet.</div>');
    const rev = [...led].reverse();
    setHtml('nw_ledgers', `<table class="dxt"><thead><tr><th>Ledger</th><th>Closed</th><th class="r">Txs</th><th>Hash</th></tr></thead><tbody>${rev.slice(0, 12).map(l => `<tr><td><a href="#" class="who" onclick="window.inspectLedger(${l.seq});return false">#${l.seq}</a></td><td class="mut">${ago(Date.now() - l.ms)}</td><td class="r">${l.txs.length}</td><td class="mono mut">${esc(short(l.hash, 6, 4))}</td></tr>`).join('')}</tbody></table>`);
    drawTxs();
    const e = $('nw') as HTMLElement;
    if (e) NW.keepHtml = e.innerHTML;
  } catch (e: any) {
    if (alive()) setHtml('nw_tiles', wait('Could not read the node: ' + esc(e?.message || e)));
  }
}
export const nwApi = {
  filter(t: string) {
    NW.f = t;
    NW.lim = 40;
    drawTxs();
  },
  more() {
    NW.lim += 60;
    drawTxs();
  },
  search() {
    const q = (($('nw_q') as HTMLInputElement) || { value: '' }).value.trim();
    const err = $('nw_err');
    if (err) err.textContent = '';
    if (!q) return;
    const w = window as any;
    if (/^\d+$/.test(q)) return w.inspectLedger(+q);
    if (/^[0-9a-fA-F]{64}$/.test(q)) return w.inspectTx(q.toUpperCase());
    try {
      w.inspectAccount(ctx.toClassic(q));
    } catch {
      if (err) err.textContent = 'That is not an address, a transaction hash or a ledger number.';
    }
  },
};
