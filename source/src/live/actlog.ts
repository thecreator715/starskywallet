// Activity log under the Send and Receive pages: payments sent from and received into the active wallet.
import { ctx } from './ctx.ts';
import { esc, fmt, hexName, rippleToMs, short } from './util.ts';

const $ = (id: string) => document.getElementById(id);
let gen = 0;
const ago = (ms: number) => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? Math.round(s) + 's ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(ms).toLocaleDateString(); };
export function shell(kind: 'send' | 'receive') {
  return `<div class="card" style="margin-top:1rem"><div class="row" style="justify-content:space-between;gap:.6rem;flex-wrap:wrap"><div class="k" style="margin:0">${kind === 'send' ? 'Sent and received' : 'Received payments'} <small class="mut">this wallet</small></div>
    <div class="seg" id="al_f">${kind === 'send' ? '<button class="on" onclick="window.al.f(\'all\')">All</button><button onclick="window.al.f(\'out\')">Sent</button><button onclick="window.al.f(\'in\')">Received</button>' : ''}<button class="sm ghost" onclick="window.al.load()">Refresh</button></div></div>
    <div id="al_box" style="overflow:auto;margin-top:.5rem"><div class="mut" style="padding:.8rem">Reading the ledger…</div></div></div>`;
}
let ROWS: any[] = [], FILT = 'all', KIND: 'send' | 'receive' = 'send';
function paint() {
  const b = $('al_box'); if (!b) return;
  const rows = ROWS.filter(r => (KIND === 'receive' ? !r.out : FILT === 'all' || (FILT === 'out') === r.out));
  b.innerHTML = rows.length ? `<table class="dxt"><thead><tr><th>When</th><th>Direction</th><th>Counterparty</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>${rows.map(r => `<tr><td class="mut" style="white-space:nowrap">${esc(ago(r.ms))}</td>
    <td><b style="color:${r.out ? '#f87171' : '#34d399'}">${r.out ? '↑ Sent' : '↓ Received'}</b></td><td class="mono"><a href="#" class="who" onclick="window.inspectAccount('${esc(r.cp)}');return false">${esc(short(ctx.showL(r.cp), 8, 6))}</a></td>
    <td class="r"><b>${r.out ? '−' : '+'}${esc(r.amt)}</b></td><td>${r.ok ? '<span class="up">Confirmed</span>' : '<span class="dn">' + esc(r.res) + '</span>'}</td></tr>`).join('')}</tbody></table>` : '<div class="mut" style="padding:.8rem">No payments yet.</div>';
}
export async function load(kind?: 'send' | 'receive') {
  if (kind) KIND = kind;
  const g = ++gen, me = ctx.account();
  if (!me || !ctx.online()) return;
  try {
    const r: any = await ctx.req('account_tx', { account: me, limit: 120, ledger_index_min: -1, ledger_index_max: -1 });
    if (g !== gen) return;
    ROWS = ((r && r.transactions) || []).map((x: any) => {
      const t = x.tx_json || x.tx || {}, m = x.meta || x.metaData || {};
      if (t.TransactionType !== 'Payment') return null;
      const a = m.delivered_amount && m.delivered_amount !== 'unavailable' ? m.delivered_amount : t.Amount ?? t.DeliverMax;
      const out = t.Account === me, ok = m.TransactionResult === 'tesSUCCESS';
      const amt = typeof a === 'string' ? fmt(Number(a) / 1e6, 6) + ' ' + ctx.native() : a && a.currency ? fmt(Number(a.value), 6) + ' ' + hexName(a.currency) : '';
      return { ms: t.date != null ? rippleToMs(t.date) : x.date != null ? rippleToMs(x.date) : 0, out, cp: out ? t.Destination : t.Account, amt, ok, res: m.TransactionResult || '' };
    }).filter(Boolean);
    paint();
  } catch (e: any) { const b = $('al_box'); if (b && g === gen) b.innerHTML = '<div class="mut" style="padding:.8rem">Could not read the activity: ' + esc(e?.message || e) + '</div>'; }
}
export const alApi = {
  load: () => load(),
  f(k: string) { FILT = k; document.querySelectorAll('#al_f button').forEach((b, i) => b.classList.toggle('on', ['all', 'out', 'in'][i] === k)); paint(); },
};
