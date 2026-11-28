// Air Dropper: send any token you hold to a list of wallets. Amounts can be fixed, a share of a total pool by holdings, or a percentage of each
// wallet's own balance of any token. Campaigns can repeat on a timer while Starsky is open and unlocked (signing happens in this browser, so it cannot run while closed).
import { ctx } from './ctx.ts';
import { esc, fmt, short, akey, fromKey, NATIVE, isNative, amtTx, type Asset } from './util.ts';
import * as M from './market.ts';

const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const nm = (a: Asset) => M.labelOf(a);
const GREEN = '#3ddc84', RED = '#ff5b5b', AMB = '#f5b84b', BLUE = '#5aa9ff';
const chip = (t: string, c: string) => `<span style="display:inline-block;padding:.08rem .5rem;border-radius:99px;font-size:.78rem;background:${c}22;color:${c}">${esc(t)}</span>`;
const tile = (k: string, v: string, sub = '') => `<div class="tile" style="min-width:9rem;flex:1"><div class="mut" style="font-size:.8rem">${esc(k)}</div><div style="font-size:1.2rem;font-weight:800;margin:.1rem 0">${v}</div><div class="mut" style="font-size:.78rem">${sub}</div></div>`;
const net = () => (ctx.netKey() === 'test' ? 'test' : 'main');
const LK = () => `starsky.airdrop.log.${net()}`, CK = () => `starsky.airdrop.camps.${net()}`;
const rd = (k: string, d: any) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const wr = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } };

export type Mode = 'fixed' | 'pct' | 'pool' | 'equal';
export interface Cfg { name: string; token: string; mode: Mode; amount: number; pct: number; ref: string; minRef: number; cap: number; onePer: boolean; list: string; source: 'list' | 'holders'; holdTok: string; maxN: number; exclude: string; memo: string }
export interface Row { addr: string; ref: number; amt: number; skip?: string }
export interface Ev { t: number; camp: string; run: string; to: string; token: string; amt: number; ok: boolean; hash?: string; msg?: string }
interface Camp { id: string; cfg: Cfg; auto: { on: boolean; hours: number; last: number }; paid: string[] }
type VW = 'new' | 'camps' | 'stats' | 'log';
let VIEW = 'new' as VW;
let CFG: Cfg = { name: '', token: 'native', mode: 'fixed', amount: 1, pct: 1, ref: 'native', minRef: 0, cap: 0, onePer: true, list: '', source: 'list', holdTok: '', maxN: 200, exclude: '', memo: '' };
let PREV: Row[] = [], PMSG = '', running = false, stop = false, prog = { n: 0, of: 0, ok: 0, bad: 0 }, BAL: { native: number; lines: any[] } | null = null, tmr: any = 0, TOK: Asset[] = [];

const parseList = (txt: string): { addr: string; amt?: number }[] => { const out: { addr: string; amt?: number }[] = [], seen = new Set<string>(); for (const ln of txt.split(/[\n;]+/)) { const p = ln.trim().split(/[\s,\t]+/).filter(Boolean); if (!p.length) continue; const a = p[0]; if (!/^[rXLT][1-9A-HJ-NP-Za-km-z]{20,}$/.test(a) || seen.has(a)) continue; seen.add(a); const n = p[1] != null ? Number(p[1]) : NaN; out.push({ addr: a, amt: isFinite(n) && n > 0 ? n : undefined }); } return out; };
const balOf = (a: Asset) => (!BAL ? 0 : isNative(a) ? BAL.native : Number((BAL.lines.find((l: any) => l.currency === a.c && l.account === a.i) || {}).balance || 0));
async function loadBal() {
  const acc = ctx.account(); if (!acc) return (BAL = null);
  const [ai, al, si] = await Promise.all([ctx.req('account_info', { account: acc, ledger_index: 'validated' }).catch(() => null), ctx.req('account_lines', { account: acc, ledger_index: 'validated', limit: 400 }).catch(() => null), ctx.req('server_info').catch(() => null)]);
  if (!ai?.account_data) return (BAL = { native: 0, lines: [] }); const v = si?.info?.validated_ledger || {};
  BAL = { native: Math.max(0, Number(ai.account_data.Balance) / 1e6 - Number(v.reserve_base_xrp ?? 1) - Number(v.reserve_inc_xrp ?? 0.2) * (ai.account_data.OwnerCount || 0)), lines: al?.lines || [] };
  const m = new Map<string, Asset>(); m.set('native', NATIVE); for (const l of BAL.lines) m.set(`${l.currency}|${l.account}`, { c: l.currency, i: l.account }); try { for (const p of await M.poolRefs()) { m.set(akey(p.a), p.a); m.set(akey(p.b), p.b); } } catch { /* pools unavailable */ } TOK = [...m.values()];
}
async function holderOf(a: Asset, addr: string): Promise<number> {
  try { if (isNative(a)) { const r = await ctx.req('account_info', { account: addr, ledger_index: 'validated' }); return Number(r.account_data.Balance) / 1e6; } const r = await ctx.req('account_lines', { account: addr, peer: a.i, ledger_index: 'validated', limit: 50 }); const l = (r.lines || []).find((x: any) => x.currency === a.c); return l ? Number(l.balance) : 0; } catch { return 0; }
}
async function holdersOf(a: Asset, max: number): Promise<{ addr: string; bal: number }[]> {
  if (isNative(a)) return []; const out: { addr: string; bal: number }[] = []; let marker: any;
  for (let p = 0; p < 8 && out.length < max; p++) { const r: any = await ctx.req('account_lines', { account: a.i, ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) }); for (const l of r.lines || []) if (l.currency === a.c && Number(l.balance) < 0) out.push({ addr: l.account, bal: -Number(l.balance) }); marker = r.marker; if (!marker) break; }
  return out.slice(0, max);
}
export async function preview() {
  PMSG = 'Working it out…'; PREV = []; paint(); await loadBal();
  try {
    const tok = fromKey(CFG.token), ref = fromKey(CFG.ref), me = ctx.account() || '', ex = new Set(CFG.exclude.split(/[\s,]+/).filter(Boolean)); ex.add(me);
    let base: { addr: string; amt?: number; bal?: number }[] = [];
    if (CFG.source === 'holders') { const ha = fromKey(CFG.holdTok || CFG.ref); if (isNative(ha)) throw new Error('Pick a token with an issuer to list its holders.'); base = (await holdersOf(ha, CFG.maxN * 2)).map(h => ({ addr: h.addr, bal: h.bal })); }
    else base = parseList(CFG.list);
    if (!base.length) throw new Error(CFG.source === 'holders' ? 'No holders found for that token.' : 'Paste at least one valid wallet address (one per line, optional amount after a comma).');
    base = base.filter(b => !ex.has(b.addr)).slice(0, CFG.maxN);
    const camp = CAMPS().find(c => c.cfg.name && c.cfg.name === CFG.name), paid = new Set(CFG.onePer && camp ? camp.paid : []);
    const rows: Row[] = []; const needRef = CFG.mode === 'pct' || CFG.mode === 'pool' || CFG.minRef > 0;
    for (let i = 0; i < base.length; i += 8) await Promise.all(base.slice(i, i + 8).map(async b => { const r = needRef ? (b.bal != null && akey(ref) === akey(fromKey(CFG.holdTok || CFG.ref)) ? b.bal : await holderOf(ref, b.addr)) : 0; rows.push({ addr: b.addr, ref: r, amt: b.amt ?? 0 }); }));
    const order = new Map(base.map((b, i) => [b.addr, i])); rows.sort((a, b) => (order.get(a.addr) || 0) - (order.get(b.addr) || 0));
    const elig = rows.filter(r => { if (paid.has(r.addr)) { r.skip = 'already paid by this campaign'; return false; } if (CFG.minRef > 0 && r.ref < CFG.minRef) { r.skip = 'holds less than the minimum'; return false; } if ((CFG.mode === 'pct' || CFG.mode === 'pool') && !(r.ref > 0)) { r.skip = 'holds none of the reference token'; return false; } return true; });
    const totRef = elig.reduce((s, r) => s + r.ref, 0);
    for (const r of elig) {
      let a = r.amt > 0 && CFG.mode === 'fixed' ? r.amt : CFG.mode === 'fixed' ? CFG.amount : CFG.mode === 'pct' ? (r.ref * CFG.pct) / 100 : CFG.mode === 'pool' ? (CFG.amount * r.ref) / totRef : CFG.amount / elig.length;
      if (CFG.cap > 0) a = Math.min(a, CFG.cap); a = Math.floor(a * 1e6) / 1e6; if (!(a > 0)) { r.skip = 'amount rounds to zero'; continue; } r.amt = a;
    }
    PREV = rows; const total = rows.filter(r => !r.skip).reduce((s, r) => s + r.amt, 0), have = balOf(tok);
    PMSG = total > have + 1e-9 ? `bad:You need ${fmt(total, 6)} ${nm(tok)} but can spend ${fmt(have, 6)}.` : `ok:${rows.filter(r => !r.skip).length} wallets, ${fmt(total, 6)} ${nm(tok)} in total. You can spend ${fmt(have, 6)}.`;
  } catch (e: any) { PMSG = 'bad:' + String(e?.message || e); } paint();
}
export function set(k: string, v: any) { (CFG as any)[k] = ['amount', 'pct', 'minRef', 'cap', 'maxN'].includes(k) ? Number(v) || 0 : k === 'onePer' ? !!v : v; if (['token', 'mode', 'ref', 'source'].includes(k)) paint(); }
const CAMPS = (): Camp[] => rd(CK(), []); const LOG = (): Ev[] => rd(LK(), []);
const saveLog = (l: Ev[]) => wr(LK(), l.slice(-5000));
export function saveCamp() {
  if (!CFG.name.trim()) return ctx.toast('Give the campaign a name first.', true); const cs = CAMPS(), i = cs.findIndex(c => c.cfg.name === CFG.name.trim()); const cfg = { ...CFG, name: CFG.name.trim() };
  if (i >= 0) cs[i].cfg = cfg; else cs.push({ id: 'c' + Date.now().toString(36), cfg, auto: { on: false, hours: 24, last: 0 }, paid: [] }); wr(CK(), cs); ctx.toast('Campaign saved'); paint();
}
export function loadCamp(id: string) { const c = CAMPS().find(x => x.id === id); if (!c) return; CFG = { ...c.cfg }; VIEW = 'new'; PREV = []; PMSG = ''; paint(); }
export function delCamp(id: string) { if (!confirm('Delete this campaign? Its activity log stays.')) return; wr(CK(), CAMPS().filter(c => c.id !== id)); paint(); }
export function auto(id: string, on: boolean, hours?: number) { const cs = CAMPS(), c = cs.find(x => x.id === id); if (!c) return; if (on && !confirm(`Run "${c.cfg.name}" automatically every ${hours || c.auto.hours} hours while Starsky is open and unlocked? Each run pays the wallets in the list that have not been paid yet (if "once per wallet" is on). You can switch it off here at any time.`)) return paint(); c.auto.on = on; if (hours) c.auto.hours = Math.max(0.25, hours); if (on) c.auto.last = c.auto.last || 0; wr(CK(), cs); paint(); }
export function stopRun() { stop = true; }
export async function run(campId?: string) {
  if (running) return ctx.toast('A run is already in progress.', true); const acc = ctx.account(); if (!acc) return ctx.toast('Unlock a wallet first.', true);
  const camp = campId ? CAMPS().find(c => c.id === campId) : undefined; if (camp) { CFG = { ...camp.cfg }; }
  await preview(); const rows = PREV.filter(r => !r.skip); const tok = fromKey(CFG.token);
  if (!rows.length) return ctx.toast('Nobody to pay. ' + PMSG.replace(/^(ok|bad):/, ''), true); if (PMSG.startsWith('bad:')) return ctx.toast(PMSG.slice(4), true);
  const total = rows.reduce((s, r) => s + r.amt, 0);
  if (!camp && !confirm(`Send ${fmt(total, 6)} ${nm(tok)} to ${rows.length} wallets?\n\nThis signs ${rows.length} payments from your active wallet and cannot be undone.`)) return;
  running = true; stop = false; prog = { n: 0, of: rows.length, ok: 0, bad: 0 }; const run = 'r' + Date.now().toString(36), log = LOG(), cs = CAMPS(), cur = cs.find(c => c.cfg.name === CFG.name); paint();
  for (const r of rows) {
    if (stop) break; let ev: Ev;
    try { const tx: any = { TransactionType: 'Payment', Account: acc, Destination: r.addr, Amount: amtTx(tok, r.amt) }; if (CFG.memo.trim()) tx.Memos = [{ Memo: { MemoData: Array.from(new TextEncoder().encode(CFG.memo.trim().slice(0, 200))).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase() } }]; const x = await ctx.submit(tx); ev = { t: Date.now(), camp: CFG.name || '(unsaved)', run, to: r.addr, token: nm(tok), amt: r.amt, ok: !!x.ok, hash: x.hash, msg: x.ok ? '' : x.msg }; }
    catch (e: any) { ev = { t: Date.now(), camp: CFG.name || '(unsaved)', run, to: r.addr, token: nm(tok), amt: r.amt, ok: false, msg: String(e?.message || e) }; }
    log.push(ev); prog.n++; if (ev.ok) { prog.ok++; if (cur) cur.paid.push(r.addr); } else prog.bad++; saveLog(log); if (cur) { wr(CK(), cs); } paint();
  }
  if (cur) { cur.auto.last = Date.now(); wr(CK(), cs); } running = false; ctx.toast(`Air drop finished: ${prog.ok} sent, ${prog.bad} failed${stop ? ' (stopped)' : ''}`, prog.bad > 0); await loadBal(); paint();
}
function tickAuto() { if (running || !ctx.account() || !ctx.online()) return; const now = Date.now(); const due = CAMPS().find(c => c.auto.on && now - c.auto.last >= c.auto.hours * 3600e3); if (due) void run(due.id); }
export function startAuto() { clearInterval(tmr); tmr = setInterval(tickAuto, 60000); }
export function exportCsv() { const l = LOG(); const s = 'time,campaign,run,to,token,amount,ok,hash,error\n' + l.map(e => [new Date(e.t).toISOString(), e.camp, e.run, e.to, e.token, e.amt, e.ok, e.hash || '', (e.msg || '').replace(/[",\n]/g, ' ')].join(',')).join('\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([s], { type: 'text/csv' })); a.download = 'airdrops.csv'; a.click(); }
export function clearLog() { if (confirm('Clear the activity log on this device?')) { saveLog([]); paint(); } }
export function view(v: VW) { VIEW = v; paint(); }

// ---------- drawing ----------
const tokSel = (id: string, cur: string, onch: string) => `<select id="${id}" onchange="${onch}">${(TOK.length ? TOK : [NATIVE]).map(a => `<option value="${esc(akey(a))}" ${akey(a) === cur ? 'selected' : ''}>${esc(nm(a))}${BAL ? ' · ' + fmt(balOf(a), 4) : ''}</option>`).join('')}</select>`;
function newHtml(): string {
  const tok = fromKey(CFG.token), pm = PMSG.split(':'), pk = pm[0], pt = pm.slice(1).join(':');
  const modes: [Mode, string][] = [['fixed', 'Fixed amount each'], ['pct', 'Percent of their balance'], ['pool', 'Split a pool by balance'], ['equal', 'Split a pool equally']];
  const amtLbl = CFG.mode === 'fixed' ? 'Amount per wallet' : CFG.mode === 'pct' ? 'Percent of their balance' : 'Total pool to split';
  const f = `<div class="card c6"><div class="k">What to send</div><div class="fgrid" style="margin-top:.5rem"><input id="ad_name" placeholder="Campaign name (to save and repeat it)" value="${esc(CFG.name)}" oninput="window.ad.set('name',this.value)"><label class="mut">Token to send ${tokSel('ad_tok', CFG.token, "window.ad.set('token',this.value)")}</label>
  <label class="mut">How much<select onchange="window.ad.set('mode',this.value)">${modes.map(m => `<option value="${m[0]}" ${CFG.mode === m[0] ? 'selected' : ''}>${m[1]}</option>`).join('')}</select></label>
  <label class="mut">${amtLbl}<input value="${CFG.mode === 'pct' ? CFG.pct : CFG.amount}" inputmode="decimal" oninput="window.ad.set('${CFG.mode === 'pct' ? 'pct' : 'amount'}',this.value)"></label>
  ${CFG.mode === 'pct' || CFG.mode === 'pool' || CFG.minRef > 0 ? '' : ''}<label class="mut">Balance to measure (for percent, pool and minimum) ${tokSel('ad_ref', CFG.ref, "window.ad.set('ref',this.value)")}</label>
  <label class="mut">Only wallets holding at least<input value="${CFG.minRef}" inputmode="decimal" oninput="window.ad.set('minRef',this.value)"></label><label class="mut">Most any one wallet gets (0 = no limit)<input value="${CFG.cap}" inputmode="decimal" oninput="window.ad.set('cap',this.value)"></label>
  <label class="mut"><input type="checkbox" ${CFG.onePer ? 'checked' : ''} onchange="window.ad.set('onePer',this.checked)"> Pay each wallet only once per campaign</label><input placeholder="Note sent with each payment (optional)" maxlength="200" value="${esc(CFG.memo)}" oninput="window.ad.set('memo',this.value)"></div></div>`;
  const w = `<div class="card c6"><div class="k">Who gets it</div><div class="row" style="gap:.4rem;margin:.5rem 0"><button class="sm ${CFG.source === 'list' ? 'pri' : ''}" onclick="window.ad.set('source','list')">My list</button><button class="sm ${CFG.source === 'holders' ? 'pri' : ''}" onclick="window.ad.set('source','holders')">Holders of a token</button></div>
  ${CFG.source === 'list' ? `<textarea rows="9" placeholder="One wallet per line. Add an amount after a comma to set it just for that wallet.\nrAbc…, 25" oninput="window.ad.set('list',this.value)" style="width:100%">${esc(CFG.list)}</textarea><div class="mut" style="font-size:.8rem">${parseList(CFG.list).length} valid wallets</div>` : `<label class="mut">Everyone who holds ${tokSel('ad_hold', CFG.holdTok || CFG.ref, "window.ad.set('holdTok',this.value)")}</label><div class="mut" style="font-size:.8rem;margin-top:.3rem">Reads the token's issuer for its trust lines. Works for tokens that have an issuer.</div>`}
  <div class="fgrid" style="margin-top:.5rem"><label class="mut">Most wallets in one run<input value="${CFG.maxN}" inputmode="numeric" oninput="window.ad.set('maxN',this.value)"></label><input placeholder="Wallets to leave out (addresses, spaces between)" value="${esc(CFG.exclude)}" oninput="window.ad.set('exclude',this.value)"></div></div>`;
  const prog2 = running || prog.n ? `<div style="margin:.5rem 0">${running ? chip('sending', AMB) : chip('last run', BLUE)} ${prog.n} / ${prog.of} · ${prog.ok} sent · ${prog.bad} failed ${running ? '<button class="sm" onclick="window.ad.stopRun()">Stop</button>' : ''}<div style="height:6px;background:rgba(255,255,255,.12);border-radius:4px;margin-top:.3rem"><div style="height:6px;width:${prog.of ? (prog.n / prog.of) * 100 : 0}%;background:${GREEN};border-radius:4px"></div></div></div>` : '';
  const pv = `<div class="card c12"><div class="row" style="align-items:center;gap:.5rem;flex-wrap:wrap"><div class="k">Preview</div><span class="grow"></span><button class="sm" onclick="window.ad.preview()">Work it out</button><button class="sm" onclick="window.ad.saveCamp()">Save campaign</button><button class="pri sm" onclick="window.ad.run()" ${running ? 'disabled' : ''}>Send now</button></div>${pt ? `<div style="margin:.4rem 0;color:${pk === 'bad' ? RED : GREEN}">${esc(pt)}</div>` : '<div class="mut" style="margin:.4rem 0">Press “Work it out” to see exactly who gets what before anything is sent.</div>'}${prog2}${PREV.length ? `<div style="overflow:auto;max-height:20rem"><table style="width:100%;font-size:.84rem"><tr class="mut" style="text-align:left"><th>Wallet</th><th>Holds</th><th>Gets</th><th></th></tr>${PREV.map(r => `<tr><td class="mono">${esc(short(r.addr, 8, 6))}</td><td>${r.ref ? fmt(r.ref, 4) : '–'}</td><td>${r.skip ? '–' : fmt(r.amt, 6) + ' ' + esc(nm(tok))}</td><td>${r.skip ? chip(r.skip, AMB) : ''}</td></tr>`).join('')}</table></div>` : ''}<div class="mut" style="font-size:.78rem;margin-top:.4rem">Payments are signed by your active wallet. A wallet that has not added the token's trust line will fail and is shown in the log; nothing is taken from it.</div></div>`;
  return f + w + pv;
}
function campsHtml(): string {
  const cs = CAMPS(); if (!cs.length) return '<div class="card c12 mut">No saved campaigns yet. Set one up on the New tab and press “Save campaign”.</div>';
  return `<div class="card c12"><table style="width:100%;font-size:.86rem"><tr class="mut" style="text-align:left"><th>Name</th><th>Sends</th><th>Wallets paid</th><th>Automatic</th><th></th></tr>${cs.map(c => `<tr><td><b>${esc(c.cfg.name)}</b></td><td>${esc(c.cfg.mode === 'pct' ? c.cfg.pct + '% of balance' : c.cfg.mode === 'fixed' ? fmt(c.cfg.amount) + ' each' : fmt(c.cfg.amount) + ' pool')} ${esc(nm(fromKey(c.cfg.token)))}</td><td>${c.paid.length}</td><td>${c.auto.on ? chip('every ' + c.auto.hours + ' h', GREEN) + ' <span class="mut">last ' + (c.auto.last ? new Date(c.auto.last).toLocaleString() : 'never') + '</span> <button class="sm" onclick="window.ad.auto(\'' + c.id + '\',false)">Turn off</button>' : `<input id="ad_h_${c.id}" value="${c.auto.hours}" style="width:3.5rem"> h <button class="sm" onclick="window.ad.auto('${c.id}',true,Number(document.getElementById('ad_h_${c.id}').value))">Turn on</button>`}</td><td><button class="sm" onclick="window.ad.run('${c.id}')">Run now</button> <button class="sm" onclick="window.ad.loadCamp('${c.id}')">Edit</button> <button class="sm" onclick="window.ad.delCamp('${c.id}')">Delete</button></td></tr>`).join('')}</table><div class="mut" style="font-size:.8rem;margin-top:.5rem">Automatic runs only happen while Starsky is open and the wallet is unlocked, because the payments are signed here.</div></div>`;
}
function bars(vals: [string, number][], col: string): string { if (!vals.length) return '<div class="mut">No data yet.</div>'; const mx = Math.max(...vals.map(v => v[1]), 1), W = 520, H = 110, bw = W / vals.length; return `<svg viewBox="0 0 ${W} ${H + 16}" style="width:100%;height:${H + 16}px">${vals.map((v, i) => `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - (v[1] / mx) * H).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${((v[1] / mx) * H).toFixed(1)}" fill="${col}"><title>${esc(v[0])}: ${fmt(v[1], 4)}</title></rect>`).join('')}<text x="0" y="${H + 12}" font-size="10" fill="currentColor" opacity=".6">${esc(vals[0][0])}</text><text x="${W}" y="${H + 12}" font-size="10" text-anchor="end" fill="currentColor" opacity=".6">${esc(vals[vals.length - 1][0])}</text></svg>`; }
function statsHtml(): string {
  const l = LOG(); if (!l.length) return '<div class="card c12 mut">No air drops yet. Statistics appear after your first run.</div>';
  const ok = l.filter(e => e.ok), bad = l.length - ok.length, wallets = new Set(ok.map(e => e.to)); const by = new Map<string, number>(), day = new Map<string, number>(), top = new Map<string, number>(), errs = new Map<string, number>(), runs = new Set(l.map(e => e.run));
  for (const e of ok) { by.set(e.token, (by.get(e.token) || 0) + e.amt); const d = new Date(e.t).toISOString().slice(5, 10); day.set(d, (day.get(d) || 0) + 1); top.set(e.to, (top.get(e.to) || 0) + e.amt); }
  for (const e of l) if (!e.ok) { const m = (e.msg || 'unknown').slice(0, 60); errs.set(m, (errs.get(m) || 0) + 1); }
  const days = [...day.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return `<div class="card c12"><div class="row" style="gap:.6rem;flex-wrap:wrap;width:100%">${tile('Payments sent', String(ok.length), bad + ' failed')}${tile('Success rate', ((ok.length / l.length) * 100).toFixed(1) + '%', l.length + ' attempts')}${tile('Wallets reached', String(wallets.size), 'unique')}${tile('Runs', String(runs.size), 'campaigns: ' + new Set(l.map(e => e.camp)).size)}${[...by.entries()].slice(0, 3).map(([k, v]) => tile('Sent ' + k, fmt(v, 4), 'all time')).join('')}</div></div>
  <div class="card c6"><div class="k">Payments per day</div>${bars(days, BLUE)}</div><div class="card c6"><div class="k">Biggest recipients</div><table style="width:100%;font-size:.84rem">${[...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([a, v]) => `<tr><td class="mono">${esc(short(a, 8, 6))}</td><td>${fmt(v, 4)}</td></tr>`).join('')}</table></div>
  <div class="card c12"><div class="k">Why payments failed</div>${errs.size ? `<table style="width:100%;font-size:.84rem">${[...errs.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `<tr><td>${esc(m)}</td><td>${n}</td></tr>`).join('')}</table>` : '<div class="mut">Nothing failed.</div>'}</div>`;
}
function logHtml(): string {
  const l = LOG().slice().reverse().slice(0, 300);
  return `<div class="card c12"><div class="row" style="gap:.5rem;align-items:center"><div class="k">Activity log</div><span class="grow"></span><button class="sm" onclick="window.ad.exportCsv()">Download CSV</button><button class="sm" onclick="window.ad.clearLog()">Clear</button></div><div style="overflow:auto;max-height:32rem"><table style="width:100%;font-size:.82rem;margin-top:.4rem"><tr class="mut" style="text-align:left"><th>Time</th><th>Campaign</th><th>To</th><th>Amount</th><th>Result</th></tr>${l.map(e => `<tr><td>${esc(new Date(e.t).toLocaleString())}</td><td>${esc(e.camp)}</td><td class="mono">${esc(short(e.to, 8, 6))}</td><td>${fmt(e.amt, 6)} ${esc(e.token)}</td><td>${e.ok ? chip('sent', GREEN) + ' <span class="mono mut">' + esc(short(e.hash || '', 6, 4)) + '</span>' : chip('failed', RED) + ' <span class="mut">' + esc(e.msg || '') + '</span>'}</td></tr>`).join('') || '<tr><td colspan="5" class="mut">Nothing yet.</td></tr>'}</table></div></div>`;
}
const TABS: [VW, string][] = [['new', 'New air drop'], ['camps', 'Campaigns & automation'], ['stats', 'Analytics'], ['log', 'Activity log']];
export function shell() { return `<div id="ad_root" style="width:100%"><div class="row" id="ad_tabs" style="gap:.4rem;margin-bottom:.7rem;flex-wrap:wrap"></div><div id="ad_body" class="grid" style="width:100%"></div></div>`; }
function paint() {
  const t = document.getElementById('ad_tabs'), b = document.getElementById('ad_body'); if (!t || !b) return;
  t.innerHTML = TABS.map(([k, l]) => `<button class="sm ${VIEW === k ? 'pri' : ''}" onclick="window.ad.view('${k}')">${l}</button>`).join('');
  const a = document.activeElement as HTMLElement | null; if (a && b.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName) && VIEW === 'new') return;   // never wipe what is being typed
  b.innerHTML = VIEW === 'new' ? newHtml() : VIEW === 'camps' ? campsHtml() : VIEW === 'stats' ? statsHtml() : logHtml();
}
export async function mount() { paint(); await loadBal(); paint(); startAuto(); }
export const api = { view, set, preview, saveCamp, loadCamp, delCamp, auto, run, stopRun, exportCsv, clearLog };
