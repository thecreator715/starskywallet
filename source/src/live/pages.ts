// Live pages: Network overview + explorer, Markets (pools, all tokens, trust lines, portfolio), Bridge. All data is read from the connected node.
import * as xrpl from 'xrpl';
import { ctx } from './ctx.ts';
import * as M from './market.ts';
import { Asset, NATIVE, akey, amtNum, amtTx, dur, esc, fmt, fromKey, hexName, isNative, nameToCur, pctHtml, short, usd, ago, rippleToMs, assetOf } from './util.ts';
import * as TK from './tokens.ts';
import { loadXAssets } from './xassets.ts';
import { cached, header, info, ledgerAgo, pool as poolMap, req, secPerLedger, tryReq, WINDOWS } from './chain.ts';

const $ = (id: string) => document.getElementById(id);
const setHtml = (id: string, h: string) => {
  const e = $(id) as any;
  if (e && e.__h !== h) {
    e.innerHTML = h;
    e.__h = h;
  }
};
const kv = (k: string, v: string, sub = '') => `<div class="tile kvt"><div class="k">${k}</div><div class="big2">${v}</div>${sub ? `<div class="mut" style="font-size:.78rem">${sub}</div>` : ''}</div>`;
const wait = (m: string) => `<div class="mut" style="padding:1rem">${m}</div>`;
let gen = 0;
const alive = (g: number, id: string) => g === gen && !!$(id);
const keep: Record<string, string> = {};
const stash = (id: string) => {
  const e = $(id);
  if (e && e.innerHTML && !/Reading the node|Reading pools/.test(e.innerHTML)) keep[id] = e.innerHTML;
};
const restore = (id: string, dflt: string) => keep[id] || dflt;

export { networkShell, networkMount, networkUnmount, networkLoad, nwApi, NW } from './network.ts';

/* =============================== MARKETS =============================== */
export const MK: any = { other: new Set<string>(), tokens: null, bal: null, timer: null, range: '24h', busy: false };
export function marketsShell() {
  return `<div id="mk">
    <div class="row" style="gap:.6rem;margin-bottom:.8rem;align-items:center"><span class="mut" style="font-size:.78rem;text-transform:uppercase;letter-spacing:.08em">Chart range</span>
      <div class="seg">${['1h', '24h', '7d', 'all'].map(x => `<button id="mk_r_${x}" class="${MK.range === x ? 'on' : ''}" onclick="window.mk.range('${x}')">${x}</button>`).join('')}</div>
      <button class="sm ghost" onclick="window.mk.refresh()">Refresh now</button><span id="mk_meta" class="mut" style="font-size:.76rem"></span></div>
    <div class="pgrid" id="mk_tiles">${wait('Reading pools…')}</div>
    <div class="k" style="margin:1.2rem 0 .5rem">Growth</div>
    <div class="pgrid" id="mk_growth">${wait('')}</div>
    <div class="card" style="margin-top:1rem"><div class="k">Tokens</div><div id="mk_tokens" style="overflow:auto">${wait('Reading history…')}</div>
      <div class="row" style="margin-top:.8rem;gap:.5rem;flex-wrap:wrap"><input id="mk_cur" placeholder="Currency (USD, or a longer name)" style="width:13rem"><input id="mk_iss" class="grow" placeholder="Issuer (r… or L…/T…)"><input id="mk_lim" value="1000000000" style="width:9rem" title="Trust limit"><button class="pri acc" onclick="window.mk.addCustom(this)">Set trust line</button></div>
      <div id="mk_msg" class="mut" style="font-size:.8rem;margin-top:.4rem"></div></div>
    <div class="card" style="margin-top:1rem"><div class="k">AMM pools</div><div id="mk_pools" style="overflow:auto">${wait('Reading history…')}</div></div>
    <div class="card" style="margin-top:1rem"><div class="k">Your portfolio</div><div id="mk_port">${wait('')}</div></div>
    <div class="card" style="margin-top:1rem"><div class="k">Top holders of the native coin</div><div id="mk_hold" style="overflow:auto">${wait('')}</div></div></div>`;
}
export function marketsMount() {
  clearInterval(MK.timer);
  MK.timer = setInterval(() => {
    if (!$('mk')) return clearInterval(MK.timer);
    if (ctx.online() && !(document.activeElement && (document.activeElement as any).tagName === 'INPUT')) marketsLoad();
  }, 20000);
  if (keep.mk && $('mk')) ($('mk') as HTMLElement).innerHTML = keep.mk;
  marketsLoad();
}
export function marketsUnmount() {
  clearInterval(MK.timer);
}
async function loadLines() {
  const acc = ctx.account();
  if (!acc) return (MK.bal = null);
  const [ai, al] = await Promise.all([tryReq('account_info', { account: acc, ledger_index: 'validated' }), tryReq('account_lines', { account: acc, ledger_index: 'validated', limit: 400 })]);
  MK.bal = { native: ai && ai.account_data ? Number(ai.account_data.Balance) / 1e6 : 0, funded: !!(ai && ai.account_data), lines: ((al && al.lines) || []).filter((l: any) => !M.isOldUsd({ c: l.currency, i: l.account })) };
}
const tvlOf = (s: M.Snap): number => s.pools.reduce((t, p) => { const pa = s.px.get(akey(p.a)); const pb = s.px.get(akey(p.b)); return t + (pa != null ? p.ra * pa : pb != null ? p.rb * pb : 0) * 2; }, 0);
const money = (v: number | null, s: M.Snap | null) => (v == null || !isFinite(v) ? '–' : s && s.usdPerNative != null ? usd(v * s.usdPerNative) : fmt(v) + ' ' + ctx.native());
const chgPct = (now: number | null, then: number | null) => (now == null || then == null || !(then > 0) ? null : (now / then - 1) * 100);
interface Act {
  vol: number | null;
  swaps: number;
  fees: number | null;
  apr: number | null;
  lp: number | null;
  capped: boolean;
}
async function poolActivity(p: M.PoolRef, snap: M.Snap, tvlN: number | null): Promise<Act> {
  return cached('act' + p.account, 25000, async () => {
    const m = M.marketsFrom([p])[0];
    const tr = (await M.trades(m, 200).catch(() => [])) as M.Trade[];
    const day = tr.filter(x => (x.kind === 'buy' || x.kind === 'sell') && Date.now() - x.ms < 86400e3);
    const qpx = isNative(m.quote) ? 1 : snap.px.get(akey(m.quote));
    const vq = day.reduce((s, x) => s + x.quote, 0);
    const vol = qpx != null ? vq * qpx : null;
    const fees = vol != null ? (vol * p.fee) / 100 : null;
    const al: any = await tryReq('account_lines', { account: p.account, ledger_index: 'validated', limit: 400 }, 30000);
    const lp = al ? (al.lines || []).filter((l: any) => l.currency === p.lpCur).length : null;
    return { vol, swaps: day.length, fees, apr: fees != null && tvlN ? (fees * 365 * 100) / tvlN : null, lp, capped: tr.length >= 200 };
  });
}
let mkBusy = false;
export async function marketsLoad() {
  if (mkBusy) return;
  mkBusy = true;
  const g = ++gen;
  try {
    if (!ctx.online()) return setHtml('mk_tiles', wait('Not connected to a node. Check the node address in Settings.'));
    await loadLines();
    const lineAssets: Asset[] = (MK.bal ? MK.bal.lines : []).map((l: any) => ({ c: l.currency, i: l.account }));
    const regList = await TK.registry().catch(() => [] as TK.TokenMeta[]);
    const bl: Asset[] = await import('./bridge.ts').then(m => m.laneAssets()).catch(() => [] as Asset[]);
    const found: Asset[] = await M.discoverTokens().catch(() => [] as Asset[]);
    const t = await M.tokenTable([...lineAssets, ...regList.map(x => x.a), ...bl, ...found]);
    const pooled = new Set<string>();
    for (const p of t.now.pools) { pooled.add(akey(p.a)); pooled.add(akey(p.b)); }
    MK.other = new Set<string>([...regList.map(x => akey(x.a)), ...bl.map(x => akey(x)), ...found.map(x => akey(x)).filter(k => !pooled.has(k))]);
    if (!alive(g, 'mk')) return;
    MK.tokens = t;
    const refs = await M.poolRefs();
    const nat = ctx.native();
    const native = t.rows.find(r => r.key === 'native');
    const acts = new Map<string, Act>();
    await poolMap(refs, 4, async (p: M.PoolRef) => {
      const s = t.now.pools.find(x => x.account === p.account);
      const pa = s ? t.now.px.get(akey(p.a)) : null;
      acts.set(p.account, await poolActivity(p, t.now, s && pa != null ? s.ra * pa * 2 : null));
    });
    if (!alive(g, 'mk')) return;
    const tvlNow = tvlOf(t.now);
    const wByK = (k: string) => t.ws.find(w => w.w.k === k);
    const tvlCh = (k: string) => { const w = wByK(k); return w ? chgPct(tvlNow, tvlOf(w.snap)) : null; };
    const vol24 = [...acts.values()].reduce((s, a) => s + (a.vol || 0), 0);
    const swaps24 = [...acts.values()].reduce((s, a) => s + a.swaps, 0);
    const fees24 = [...acts.values()].reduce((s, a) => s + (a.fees || 0), 0);
    const tile = (k: string, v: string, sub: string) => `<div class="tile kvt"><div class="k">${k}</div><div class="big2">${v}</div><div class="mut" style="font-size:.78rem">${sub}</div></div>`;
    setHtml(
      'mk_tiles',
      [
        tile(`${esc(nat)} price`, native && native.usdPx != null ? usd(native.usdPx) : '–', `1h ${pctHtml(native ? native.chg['1h'] : null)} · 24h ${pctHtml(native ? native.chg['24h'] : null)} · 7d ${pctHtml(native ? native.chg['7d'] : null)}`),
        tile(`${esc(nat)} market cap`, native && native.mcapUsd != null ? usd(native.mcapUsd) : '–', `supply ${native && native.supply != null ? fmt(native.supply, 0) : '–'} × pool price`),
        tile('Total value in pools', money(tvlNow, t.now), `1h ${pctHtml(tvlCh('1h'))} · 24h ${pctHtml(tvlCh('24h'))} · 7d ${pctHtml(tvlCh('7d'))} · ${refs.length} pools`),
        tile('24h volume', money(vol24, t.now), `${swaps24} swaps (read from each pool’s transactions)`),
        tile('24h fees to liquidity providers', money(fees24, t.now), 'estimated from volume × pool fee'),
      ].join('')
    );
    setHtml('mk_meta', `history from ledger #${(await info()).minSeq}${t.ws.some(w => w.clamped) ? ' · this node keeps less history than the longest windows' : ''}`);
    renderTokens(t, refs, acts);
    renderPools(t, refs, acts);
    renderPortfolio(g, t);
    renderGrowth(g);
    renderHolders(g, t);
    setTimeout(() => ($('mk') ? (keep.mk = ($('mk') as HTMLElement).innerHTML) : 0), 3000);
  } catch (e: any) {
    if (alive(g, 'mk')) setHtml('mk_tiles', wait('Could not read the node: ' + esc(e?.message || e)));
  } finally {
    mkBusy = false;
  }
}
async function renderGrowth(g: number) {
  const sec = MK.range === '1h' ? 3600 : MK.range === '7d' ? 7 * 86400 : MK.range === 'all' ? Infinity : 86400;
  const series = await M.growth(sec, 24);
  if (!alive(g, 'mk')) return;
  const line = (label: string, key: 'price' | 'tvl', fm: (v: number) => string) => {
    const pts = series.filter(p => p[key] != null) as any[];
    if (pts.length < 2) return `<div class="tile kvt"><div class="k">${label}</div><div class="mut">Not enough history on this node yet.</div></div>`;
    const v = pts.map(p => p[key] as number),
      lo = Math.min(...v),
      hi = Math.max(...v),
      sp = hi - lo || Math.abs(hi) || 1,
      W = 320,
      H = 90,
      t0 = pts[0].ms,
      t1 = pts[pts.length - 1].ms;
    const d = pts.map((p, i) => (i ? 'L' : 'M') + (((p.ms - t0) / (t1 - t0 || 1)) * W).toFixed(1) + ' ' + (H - 4 - (((p[key] as number) - lo) / sp) * (H - 12)).toFixed(1)).join(' ');
    const up = v[v.length - 1] >= v[0];
    const col = up ? '#00ff8c' : '#ff453a';
    return `<div class="tile kvt"><div class="k">${label}</div><div class="big2" style="font-size:1.1rem">${fm(v[v.length - 1])} ${pctHtml((v[v.length - 1] / v[0] - 1) * 100)}</div><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none"><path d="${d} L${W} ${H} L0 ${H} Z" fill="${col}" opacity=".08"/><path d="${d}" fill="none" stroke="${col}" stroke-width="2"/></svg><div class="mut" style="display:flex;justify-content:space-between;font-size:.74rem"><span>low ${fm(lo)}</span><span>high ${fm(hi)}</span></div></div>`;
  };
  const hasUsd = series.some(p => p.usd);
  setHtml('mk_growth', line(`${ctx.native()} price`, 'price', v => (hasUsd ? usd(v) : fmt(v))) + line('Total pool value', 'tvl', v => (hasUsd ? usd(v) : fmt(v) + ' ' + ctx.native())));
}
async function renderHolders(g: number, t: { rows: M.TokenRow[]; now: M.Snap; ws: M.WinSnap[] }) {
  const native = t.rows.find(r => r.key === 'native');
  const pools = new Set<string>((await M.poolRefs()).map(p => p.account));
  const h = await M.holders(NATIVE, native ? native.supply : null, pools);
  const w = t.ws.find(x => x.w.k === '24h');
  const top = h.top.slice(0, 10);
  const then = await Promise.all(top.map(async x => { if (!w) return null; const ai: any = await tryReq('account_info', { account: x.addr, ledger_index: w.seq }); return ai && ai.account_data ? Number(ai.account_data.Balance) / 1e6 : null; }));
  if (!alive(g, 'mk')) return;
  const px = t.now.usdPerNative;
  setHtml('mk_hold', `<div class="mut" style="font-size:.8rem;padding:.2rem 0">${fmt(h.count, 0)} accounts hold ${esc(ctx.native())}${h.truncated ? ' (first pages only)' : ''}</div><table class="dxt"><thead><tr><th>#</th><th>Account</th><th class="r">Balance</th><th class="r">Value</th><th class="r">Share</th><th class="r">24h change</th></tr></thead><tbody>${top.map((x, i) => `<tr><td class="mut">${i + 1}</td><td><a href="#" class="who" onclick="window.inspectAccount('${esc(x.addr)}');return false">${esc(short(ctx.show(x.addr), 8, 6))}</a> ${x.tag ? `<span class="tag">${x.tag}</span>` : ''}</td><td class="r">${fmt(x.bal)}</td><td class="r">${px != null ? usd(x.bal * px) : '–'}</td><td class="r">${x.share != null ? x.share.toFixed(2) + '%' : '–'}</td><td class="r">${then[i] != null && (then[i] as number) > 0 ? pctHtml(chgPct(x.bal, then[i])) : '<span class="mut">–</span>'}</td></tr>`).join('')}</tbody></table><div class="mut" style="font-size:.74rem;margin-top:.4rem">Changes in balance, not profit: deposits and withdrawals move the number too.</div>`);
}
function renderPools(t: any, refs: M.PoolRef[], acts: Map<string, Act>) {
  const wins = t.ws as M.WinSnap[];
  const rows = refs.map(p => {
    const s = t.now.pools.find((x: M.PoolState) => x.account === p.account) as M.PoolState | undefined;
    const pa = t.now.px.get(akey(p.a));
    const tvlN = s && pa != null ? s.ra * pa * 2 : null;
    return { p, s, tvlN, now: s ? M.poolPrice(s, p.a) : null, a: acts.get(p.account) };
  });
  const pending = poolMap(rows, 5, async r => {
    const first = await M.firstSeen(r.p);
    const ch: Record<string, { v: number | null; partial: boolean; tv: number | null }> = {};
    for (const w of wins) {
      let seq = w.w.k === 'all' ? first : w.seq,
        partial = false;
      if (seq < first) {
        seq = first;
        partial = w.w.k !== 'all';
      }
      const st = await M.poolState(r.p, seq);
      const then = st ? M.poolPrice(st, r.p.a) : null;
      const pb = st && w.snap.px.get(akey(r.p.a));
      ch[w.w.k] = { v: chgPct(r.now, then), partial, tv: st && pb != null && r.tvlN != null ? chgPct(r.tvlN, st.ra * pb * 2) : null };
    }
    return { ...r, ch };
  });
  pending.then(full => {
    if (!$('mk_pools')) return;
    const K = ['1h', '24h', '7d', 'all'];
    const star = (c: any) => (c.partial ? '<small class="mut" title="Longer than this pool has existed: change since it was created">*</small>' : '');
    setHtml(
      'mk_pools',
      `<table class="dxt"><thead><tr><th>Pool</th><th class="r">Price</th>${K.map(k => `<th class="r">${k === 'all' ? 'Since start' : k}</th>`).join('')}<th class="r">Value (TVL)</th><th class="r">TVL 24h</th><th class="r">TVL 7d</th><th class="r">24h volume</th><th class="r">Swaps</th><th class="r">Fees 24h</th><th class="r">APR est.</th><th class="r">LP holders</th><th></th></tr></thead><tbody>${full
        .map(
          ({ p, s, tvlN, now, ch, a }) =>
            `<tr><td><b>${esc(M.labelOf(p.a))}/${esc(M.labelOf(p.b))}</b><div class="mut" style="font-size:.72rem">fee ${p.fee}%</div></td><td class="r mono">${now != null ? fmt(now) : '–'} <small class="mut">${esc(M.labelOf(p.b))}</small></td>${K.map(k => `<td class="r">${pctHtml(ch[k].v)}${star(ch[k])}</td>`).join('')}<td class="r">${money(tvlN, t.now)}</td><td class="r">${pctHtml(ch['24h'].tv)}</td><td class="r">${pctHtml(ch['7d'].tv)}</td><td class="r">${a ? money(a.vol, t.now) : '…'}</td><td class="r">${a ? a.swaps : '…'}</td><td class="r">${a ? money(a.fees, t.now) : '…'}</td><td class="r">${a && a.apr != null ? a.apr.toFixed(1) + '%' : '–'}</td><td class="r">${a && a.lp != null ? a.lp : '–'}</td><td class="r"><button class="sm" onclick="window.mk.trade('${esc(akey(p.a))}','${esc(akey(p.b))}')">Trade</button> <button class="sm pri" onclick="window.lp.openDeposit('${esc(p.account)}')">Deposit</button> <button class="sm" onclick="window.lp.openWithdraw('${esc(p.account)}')">Withdraw</button></td></tr>`
        )
        .join('') || '<tr><td colspan="15" class="mut" style="padding:1rem">No pools exist on this network yet.</td></tr>'}</tbody></table><div class="mut" style="font-size:.74rem;margin-top:.4rem">Volume is what each pool received in swaps over the last 24 hours (latest 200 transactions per pool), valued at current prices. APR is fees × 365 ÷ pool value. * = longer than the pool has existed, so the change is since it was created.</div>`
    );
  });
}
const lineOf = (a: Asset) => (MK.bal ? MK.bal.lines.find((l: any) => l.currency === a.c && l.account === a.i) : null);
function renderTokens(t: { rows: M.TokenRow[]; now: M.Snap; ws: M.WinSnap[] }, refs: M.PoolRef[], acts: Map<string, Act>) {
  const nat = ctx.native();
  const poolSum = (k: string) => { let inPool = 0, vol = 0; for (const p of t.now.pools) { if (akey(p.a) === k) inPool += p.ra; else if (akey(p.b) === k) inPool += p.rb; } for (const p of refs) { if (akey(p.a) === k || akey(p.b) === k) vol += (acts.get(p.account) || ({} as Act)).vol || 0; } return { inPool, vol }; };
  const K = ['1h', '24h', '7d', 'all'];
  const tbl = (rows: M.TokenRow[]) =>
    `<table class="dxt"><thead><tr><th>Token</th><th class="r">Price</th>${K.map(k => `<th class="r">${k === 'all' ? 'Since start' : k}</th>`).join('')}<th class="r">Supply</th><th class="r">Market cap</th><th class="r">In pools</th><th class="r">% pooled</th><th class="r">24h volume</th><th class="r">Yours</th><th></th></tr></thead><tbody>${rows
      .map(r => {
        const l = isNative(r.a) ? null : lineOf(r.a);
        const bal = isNative(r.a) ? (MK.bal ? MK.bal.native : null) : l ? Number(l.balance) : null;
        const ps = poolSum(r.key);
        const act = isNative(r.a)
          ? '<span class="mut">native</span>'
          : l
            ? `<button class="sm dng" onclick="window.mk.untrust('${esc(r.key)}',this)" title="Removes the trust line (needs a zero balance)">Remove</button>`
            : `<button class="sm pri" onclick="window.mk.trust('${esc(r.key)}',this)">Add trust line</button>`;
        return `<tr><td><b>${esc(r.name)}</b><div class="mut mono" style="font-size:.7rem">${isNative(r.a) ? 'native coin' : esc(short(ctx.show(r.issuer), 8, 5))}</div></td><td class="r">${r.usdPx != null ? usd(r.usdPx) : r.nativePx != null ? fmt(r.nativePx) + ' ' + nat : '–'}</td>${K.map(k => `<td class="r">${pctHtml(r.chg[k])}${r.partial[k] ? '<small class="mut" title="Since listing">*</small>' : ''}</td>`).join('')}<td class="r">${r.supply != null ? fmt(r.supply) : '–'}</td><td class="r">${r.mcapUsd != null ? usd(r.mcapUsd) : r.mcapNative != null ? fmt(r.mcapNative) + ' ' + nat : '–'}</td><td class="r">${fmt(ps.inPool)}</td><td class="r">${r.supply ? ((ps.inPool / r.supply) * 100).toFixed(3) + '%' : '–'}</td><td class="r">${t.now.usdPerNative != null ? usd(ps.vol * t.now.usdPerNative) : fmt(ps.vol)}</td><td class="r">${bal != null ? fmt(bal) : '<span class="mut">–</span>'}</td><td class="r">${act}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  const other = t.rows.filter(r => MK.other.has(r.key)), main = t.rows.filter(r => !MK.other.has(r.key));
  setHtml(
    'mk_tokens',
    tbl(main) +
      `<div class="k" style="margin:1.2rem 0 .3rem">Other tokens <span class="mut" style="text-transform:none;letter-spacing:0">MAGIC, MINT and every token created on this network</span></div>` +
      (other.length ? tbl(other) : '<div class="mut" style="padding:.6rem 0">No other tokens are visible yet. MAGIC and MINT appear here once the operator feed reports them; new tokens appear automatically.</div>') +
      `<div class="mut" style="font-size:.74rem;margin-top:.4rem">Prices come from the deepest pools; changes are in dollars when a dollar-token pool exists, otherwise in ${esc(nat)}. * = since the token first appeared in a pool.</div>`
  );
}
async function renderPortfolio(g: number, t: { rows: M.TokenRow[]; now: M.Snap; ws: M.WinSnap[] }) {
  const acc = ctx.account();
  const el = $('mk_port');
  if (!el) return;
  if (!acc) return (el.innerHTML = wait('Select a wallet to see your portfolio.'));
  if (!MK.bal || !MK.bal.funded) return (el.innerHTML = wait('This wallet is not funded on this network yet, so there is nothing to show.'));
  const hold: { a: Asset; bal: number }[] = [{ a: NATIVE, bal: MK.bal.native }];
  for (const l of MK.bal.lines) if (Number(l.balance) > 0) hold.push({ a: { c: l.currency, i: l.account }, bal: Number(l.balance) });
  const valueAt = (snap: M.Snap, items: { a: Asset; bal: number }[]) => {
    let v = 0;
    for (const h of items) {
      const p = snap.px.get(akey(h.a));
      if (p != null) v += h.bal * p;
    }
    return v;
  };
  const nowV = valueAt(t.now, hold);
  const rate = t.now.usdPerNative;
  const out: { w: string; val: number | null; price: number | null; partial: boolean }[] = [];
  for (const w of t.ws) {
    if (w.w.k === 'all') continue;
    const [ai, al] = await Promise.all([tryReq('account_info', { account: acc, ledger_index: w.seq }), tryReq('account_lines', { account: acc, ledger_index: w.seq, limit: 400 })]);
    let val: number | null = null;
    if (ai && ai.account_data) {
      const items: { a: Asset; bal: number }[] = [{ a: NATIVE, bal: Number(ai.account_data.Balance) / 1e6 }];
      for (const l of (al && al.lines) || []) if (Number(l.balance) > 0) items.push({ a: { c: l.currency, i: l.account }, bal: Number(l.balance) });
      val = valueAt(w.snap, items);
    } else if (ai === null) val = null;
    out.push({ w: w.w.label, val, price: valueAt(w.snap, hold), partial: false });
  }
  if (!alive(g, 'mk')) return;
  const fmtV = (v: number) => (rate != null ? usd(v * rate) : fmt(v) + ' ' + ctx.native());
  el.innerHTML = `<div class="pgrid"><div class="tile"><div class="k">Value now</div><div class="big2">${fmtV(nowV)}</div><div class="mut" style="font-size:.78rem">${hold.length} assets, priced from pools${hold.some(h => t.now.px.get(akey(h.a)) == null) ? ' (assets without a pool are not counted)' : ''}</div></div>
    ${out.map(o => `<div class="tile"><div class="k">${o.w}</div><div>${o.val != null && o.val > 0 ? pctHtml((nowV / o.val - 1) * 100) : '<span class="mut">no balance then</span>'} <small class="mut">value</small></div><div>${o.price != null && o.price > 0 ? pctHtml((nowV / o.price - 1) * 100) : '–'} <small class="mut">price effect</small></div></div>`).join('')}</div>
    <div class="mut" style="font-size:.74rem;margin-top:.4rem">Value = your balances at that ledger priced from the pools at that ledger. Price effect = today’s balances at then-prices versus now, so deposits and withdrawals are excluded.</div>`;
}
async function trustTx(a: Asset, limit: string) {
  return ctx.submit({ TransactionType: 'TrustSet', Account: ctx.account(), LimitAmount: { currency: a.c, issuer: a.i, value: limit } });
}
export const mkApi = {
  range(k: string) {
    MK.range = k;
    ['1h', '24h', '7d', 'all'].forEach(x => $('mk_r_' + x)?.classList.toggle('on', x === k));
    renderGrowth(gen);
  },
  refresh() {
    marketsLoad();
  },
  trade(ka: string, kb: string) {
    (window as any).goTab('dex');
    setTimeout(() => (window as any).dx && (window as any).dx.pickPool(ka, kb), 300);
  },
  async trust(k: string, btn: HTMLButtonElement) {
    if (!ctx.account()) return ctx.toast('Select a wallet first', true);
    btn.disabled = true;
    const r = await trustTx(fromKey(k), '1000000000');
    ctx.toast(r.ok ? '✓ Trust line added' : 'Could not add: ' + r.msg, !r.ok);
    marketsLoad();
  },
  async untrust(k: string, btn: HTMLButtonElement) {
    btn.disabled = true;
    const r = await trustTx(fromKey(k), '0');
    ctx.toast(r.ok ? '✓ Trust line removed' : 'Could not remove: ' + r.msg + ' (the balance must be zero)', !r.ok);
    marketsLoad();
  },
  async addCustom(btn: HTMLButtonElement) {
    const msg = $('mk_msg');
    const say = (t: string) => msg && (msg.textContent = t);
    try {
      const cur = nameToCur((($('mk_cur') as HTMLInputElement).value || '').trim());
      const iss = ctx.toClassic((($('mk_iss') as HTMLInputElement).value || '').trim());
      const lim = (($('mk_lim') as HTMLInputElement).value || '').trim();
      if (!iss || !(Number(lim) >= 0)) throw new Error('Enter the issuer and a limit (0 removes the line)');
      btn.disabled = true;
      const r = await trustTx({ c: cur, i: iss }, lim);
      say(r.ok ? 'Done.' : 'Rejected: ' + r.msg);
      if (r.ok) marketsLoad();
    } catch (e: any) {
      say(String(e?.message || e));
    }
    btn.disabled = false;
  },
};

export { bridgeShell, bridgeMount, bridgeLoad, brApi } from './bridge.ts';

/* =============================== PORTFOLIO: assets and tokens =============================== */
const catOf = (r: M.TokenRow, reg: Map<string, TK.TokenMeta>): string => {
  if (isNative(r.a)) return '1 Native coin';
  if (reg.has(r.key)) return '4 Others';
  const n = r.name.toUpperCase();
  if (/^(USD|USDC|USDT|RLUSD|DAI|XUSD|EUR|EURO)$/.test(n) || n === ctx.usdName().toUpperCase()) return '2 Dollar tokens';
  if (/^(LUMAX|XRPZ|WBTC|WETH|WXRP)$/.test(n)) return '3 Bridged and wrapped';
  return '4 Others';
};
const PA: any = { tab: 'all', data: null, sort: { c: '', d: -1 } };
const FAVK = 'starsky.favs';
const FAV: Set<string> = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAVK) || '[]'));
  } catch {
    return new Set();
  }
})();
const isFav = (k: string) => FAV.has(k);
const star = (k: string) => `<span class="favstar" title="Favorite" style="cursor:pointer;color:${isFav(k) ? '#ffd24a' : '#667'};margin-right:.4rem;font-size:1rem" onclick="event.stopPropagation();window.pa.fav('${esc(k)}')">${isFav(k) ? '★' : '☆'}</span>`;
const sth = (label: string, c: string, cls = 'r') => `<th class="${cls}" style="cursor:pointer;user-select:none" onclick="window.pa.sort('${c}')" title="Click to sort">${label}${PA.sort.c === c ? (PA.sort.d > 0 ? ' ▲' : ' ▼') : ''}</th>`;
const srt = <T,>(a: T[], get: (x: T) => any, fav: (x: T) => boolean) => {
  const c = PA.sort.c;
  return a
    .map((x, i) => ({ x, i }))
    .sort((p, q) => {
      if (!c) return Number(fav(q.x)) - Number(fav(p.x)) || p.i - q.i;
      const u = get(p.x), v = get(q.x);
      if (u == null && v == null) return p.i - q.i;
      if (u == null) return 1;
      if (v == null) return -1;
      const r = typeof u === 'string' ? u.localeCompare(v) : u - v;
      return (r * PA.sort.d) || p.i - q.i;
    })
    .map(z => z.x);
};
const coinIcon = (key: string, name: string) => {
  const ic = TK.iconOf(key);
  return ic ? `<img class="coinimg" src="${ic}" alt="">` : `<i>${esc(name.slice(0, 2).toUpperCase())}</i>`;
};
export function assetsShell() {
  const tabs = [['all', 'All'], ['dollar', 'Dollar tokens'], ['bridged', 'Bridged'], ['others', 'Others'], ['lp', 'LP tokens'], ['pools', 'All pools'], ['fav', '★ Favorites']];
  return `<div class="card c12"><div class="row" style="align-items:center;gap:.6rem"><div class="k">Assets & tokens on the ${ctx.xrpl() ? 'XRP Ledger' : esc(ctx.native()) + ' network'}</div><span class="grow"></span><span id="pa_meta" class="mut" style="font-size:.76rem"></span><button class="sm pri acc" onclick="window.tk.openCreate()">+ Create token</button></div>
    <div class="dxtabs" id="pa_tabs" style="margin-top:.5rem">${tabs.map(([k, l]) => `<button class="${PA.tab === k ? 'on' : ''}" onclick="window.pa.tab('${k}')">${l}</button>`).join('')}</div>
    <div id="pa" style="overflow:auto">${keep.pa || wait('Reading tokens…')}</div></div>`;
}
let paBusy = false;
export function assetsMount() {
  loadAssets();
}
export async function loadAssets() {
  if (paBusy || !$('pa')) return;
  paBusy = true;
  try {
    if (!ctx.online()) return;
    if (ctx.xrpl()) { await loadXAssets(setHtml); return; }
    await loadLines();
    const lineAssets: Asset[] = (MK.bal ? MK.bal.lines : []).map((l: any) => ({ c: l.currency, i: l.account }));
    const regList = await TK.registry().catch(() => [] as TK.TokenMeta[]);
    const bl: Asset[] = await import('./bridge.ts').then(m => m.laneAssets()).catch(() => [] as Asset[]);
    const t = await M.tokenTable([...lineAssets, ...regList.map(x => x.a), ...bl]);
    if (!$('pa')) return;
    await M.poolRefs().catch(() => []);
    const lpLines = (MK.bal ? MK.bal.lines : []).filter((l: any) => +l.balance > 0 && M.lpPoolOf({ c: l.currency, i: l.account }));
    const lps = await Promise.all(
      lpLines.map(async (l: any) => {
        const ref = M.lpPoolOf({ c: l.currency, i: l.account })!;
        let st: any = await M.poolState(ref).catch(() => null);
        if (st && !(st.lp > 0)) {
          // the pool reader gave no LP supply: the LP token is issued by the pool account, so its obligations are the supply
          const sup = await M.supplyOf({ c: l.currency, i: l.account }).catch(() => null);
          if (sup && sup > 0) st = { ...st, lp: sup };
        }
        return { l, ref, st };
      })
    );
    const prefs = await M.poolRefs().catch(() => [] as M.PoolRef[]);
    const pools = await Promise.all(prefs.map(async ref => ({ ref, st: await M.poolState(ref).catch(() => null) })));
    PA.data = { t, reg: new Map(regList.map(x => [x.key, x])), lps, pools };
    renderAssets();
  } catch (e: any) {
    setHtml('pa', wait('Could not read the node: ' + esc(e?.message || e)));
  } finally {
    paBusy = false;
  }
}
export function heroShell() {
  return `<div id="hero_x" style="margin-top:.8rem;position:relative;z-index:1">${keep.hero || ''}</div>`;
}
function heroPaint(rows: any[], t: any) {
  const el = $('hero_x');
  if (!el) return;
  const un: number | null = t.now.usdPerNative;
  const nat = ctx.native();
  const w24 = (t.ws || []).find((z: any) => z.w && z.w.k === '24h');
  const then = w24 ? w24.snap : null;
  const unThen: number | null = then && then.usdPerNative != null ? then.usdPerNative : un;
  const hold = rows.filter((x: any) => x.bal > 0 && x.r.nativePx != null || (isNative(x.r.a) && x.bal > 0));
  let nowL = 0, thenL = 0, nowU = 0, thenU = 0, cnt = 0;
  const chips = hold.map((x: any) => {
    const k = x.r.key, pN = isNative(x.r.a) ? 1 : x.r.nativePx, p0 = isNative(x.r.a) ? 1 : then ? then.px.get(k) ?? null : null;
    const vL = x.bal * pN, vU = un != null ? vL * un : null;
    const l0 = p0 != null ? x.bal * p0 : null, u0 = l0 != null && unThen != null ? l0 * unThen : null;
    if (l0 != null) { nowL += vL; thenL += l0; cnt++; }
    if (vU != null && u0 != null) { nowU += vU; thenU += u0; }
    return { x, vL, vU, dL: l0 != null ? vL - l0 : null, dU: vU != null && u0 != null ? vU - u0 : null, pc: x.r.chg['24h'] };
  });
  const sg = (v: number | null, f: (n: number) => string) => (v == null ? '–' : (v >= 0 ? '+' : '−') + f(Math.abs(v)));
  const col = (v: number | null) => (v == null ? '#cfc6f0' : v >= 0.0000001 ? '#3dffa0' : v <= -0.0000001 ? '#ff6b6b' : '#cfc6f0');
  const dL = cnt ? nowL - thenL : null, dU = cnt && un != null ? nowU - thenU : null;
  const pL = cnt && thenL > 0 ? (dL! / thenL) * 100 : null, pU = cnt && thenU > 0 ? (dU! / thenU) * 100 : null;
  const tile = (lab: string, big: string, sub: string, c: string) => `<div style="flex:1;min-width:11rem;padding:.7rem .9rem;border-radius:14px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(6px)"><div style="font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;color:#d9ccff">${lab}</div><div style="font-size:clamp(1.1rem,2.4vw,1.55rem);font-weight:800;color:${c};margin:.15rem 0">${big}</div><div style="font-size:.74rem;color:#cfc6f0">${sub}</div></div>`;
  const totL = chips.reduce((s: number, z: any) => s + z.vL, 0), totU = un != null ? totL * un : null;
  const html = `<div style="display:flex;gap:.6rem;flex-wrap:wrap">
    ${tile('Portfolio value', totU != null ? usd(totU) : '–', fmt(totL, 2) + ' ' + esc(nat), '#fff')}
    ${tile('Day P&L · ' + esc(nat), sg(dL, n => fmt(n, 2)) + ' ' + esc(nat), pL == null ? 'since 24h ago' : sg(pL, n => n.toFixed(2)) + '% vs 24h ago' + (dL != null && un != null ? ' · ≈ ' + sg(dL * un, n => usd(n)) : ''), col(dL))}
    ${tile('Day P&L · USD', dU == null ? '–' : sg(dU, n => usd(n)), pU == null ? 'since 24h ago' : sg(pU, n => n.toFixed(2)) + '% vs 24h ago', col(dU))}
  </div>
`;
  el.innerHTML = html;
  keep.hero = html;
}
function renderAssets() {
  const D = PA.data;
  if (!D || !$('pa')) return;
  const t: { rows: M.TokenRow[]; now: M.Snap } = D.t;
  const reg: Map<string, TK.TokenMeta> = D.reg;
  const nat = ctx.native();
  const rows = t.rows.filter(r => isNative(r.a) || (!M.lpPoolOf({ c: r.a.c, i: r.a.i }) && !M.isOldUsd(r.a))).map(r => {
    const l = isNative(r.a) ? null : lineOf(r.a);
    const bal = isNative(r.a) ? (MK.bal ? MK.bal.native : 0) : l ? Number(l.balance) : 0;
    return { r, l, bal, cat: catOf(r, reg) };
  });
  rows.sort((x, y) => x.cat.localeCompare(y.cat) || (y.r.mcapUsd ?? y.r.mcapNative ?? -1) - (x.r.mcapUsd ?? x.r.mcapNative ?? -1));
  heroPaint(rows, t);
  // registered tokens that have no pool and no trust line yet still belong here
  const px = t.now.usdPerNative;
  let total = 0;
  for (const x of rows) if (x.r.nativePx != null) total += x.bal * x.r.nativePx;
  const show = rows.filter(x => PA.tab === 'all' || (PA.tab === 'dollar' && (x.cat[0] === '2' || x.cat[0] === '1')) || (PA.tab === 'bridged' && x.cat[0] === '3') || (PA.tab === 'others' && x.cat[0] === '4') || (PA.tab === 'fav' && isFav('t:' + x.r.key)));

  const nmA = (x: Asset) => M.labelOf(x);
  const poolRow = ({ ref, st }: any) => {
    const pa = t.now.px.get(akey(ref.a)), pb = t.now.px.get(akey(ref.b)), un = t.now.usdPerNative;
    const vN = st && pa != null && pb != null ? st.ra * pa + st.rb * pb : st && pa != null ? st.ra * pa * 2 : st && pb != null ? st.rb * pb * 2 : null;
    const vU = vN != null && un != null ? vN * un : null;
    const mine = (D.lps || []).find((z: any) => z.ref.account === ref.account);
    const sh = mine && st && st.lp > 0 ? Math.min(1, Number(mine.l.balance) / st.lp) : 0;
    return { ref, st, vU, vN, price: st ? M.poolPrice(st, ref.a) : null, mine, sh, name: nmA(ref.a) + ' / ' + nmA(ref.b), k: 'p:' + ref.account };
  };
  const poolTable = (list: any[]) => {
    const get = (x: any) => ({ pair: x.name, tvl: x.vU ?? x.vN, ra: x.st ? x.st.ra : null, rb: x.st ? x.st.rb : null, price: x.price, fee: x.ref.fee, lp: x.st ? x.st.lp : null, mine: x.sh }[PA.sort.c as string]);
    const rows2 = srt(list, get, (x: any) => isFav(x.k));
    const b = rows2
      .map(
        (x: any) =>
          `<tr ondblclick="window.pa.open('pools')" title="Double-click to open the pool"><td><div class="coin">${star(x.k)}<i>LP</i><div><b>${esc(x.name)}</b><div class="mut mono" style="font-size:.7rem">pool ${esc(short(ctx.show(x.ref.account), 8, 5))} · fee ${x.ref.fee}%</div></div></div></td><td class="r mono">${x.st ? fmt(x.st.ra, 4) : '–'} <small class="mut">${esc(nmA(x.ref.a))}</small><br>${x.st ? fmt(x.st.rb, 4) : '–'} <small class="mut">${esc(nmA(x.ref.b))}</small></td><td class="r mono">${x.price != null ? fmt(x.price, 6) : '–'}<div class="mut" style="font-size:.7rem">${esc(nmA(x.ref.b))} per ${esc(nmA(x.ref.a))}</div></td><td class="r">${x.vU != null ? usd(x.vU) : x.vN != null ? fmt(x.vN, 2) + ' ' + esc(nat) : '–'}</td><td class="r mono">${x.st && x.st.lp ? fmt(x.st.lp, 2) : '–'}</td><td class="r">${x.mine ? (x.sh * 100).toFixed(x.sh < 0.0001 ? 6 : 2) + '%<div class="mut" style="font-size:.7rem">' + fmt(Number(x.mine.l.balance), 4) + ' LP</div>' : '<span class="mut">–</span>'}</td><td class="r"><button class="sm" onclick="window.pa.open('pools')">Open</button></td></tr>`
      )
      .join('');
    return `<table class="dxt"><thead><tr>${sth('Pool (pair)', 'pair', '')}${sth('Reserves', 'ra')}${sth('Price', 'price')}${sth('Pool value', 'tvl')}${sth('LP supply', 'lp')}${sth('Your share', 'mine')}<th></th></tr></thead><tbody>${b || '<tr><td colspan="7" class="mut" style="padding:1rem">No pools.</td></tr>'}</tbody></table>`;
  };
  if (PA.tab === 'pools') {
    const list = (D.pools || []).map(poolRow);
    setHtml('pa', poolTable(list) + `<div class="mut" style="font-size:.74rem;margin-top:.4rem">${list.length} AMM pools on the ${esc(nat)} network. Click a header to sort, the star to favorite, double-click a row to open it.</div>`);
    keep.pa = ($('pa') as HTMLElement).innerHTML;
    return;
  }
  if (PA.tab === 'lp') {
    const nm = (x: Asset) => M.labelOf(x);
    const lp: any[] = (D.lps || []).filter((x: any) => !M.isOldUsd(x.ref.a) && !M.isOldUsd(x.ref.b));
    let tot = 0;
    const lpv = lp.map((z: any) => {
      const bal = Number(z.l.balance), sh = z.st && z.st.lp > 0 ? Math.min(1, bal / z.st.lp) : 0;
      return { ...z, bal, sh, name: nm(z.ref.a) + ' / ' + nm(z.ref.b) };
    });
    const lpSorted = srt(lpv, (x: any) => ({ pair: x.name, bal: x.bal, sh: x.sh, val: x.st ? x.sh * (x.st.ra + x.st.rb) : null }[PA.sort.c as string]), (x: any) => isFav('p:' + x.ref.account));
    const body = lpSorted
      .map(({ l, ref, st }: any) => {
        const bal = Number(l.balance), share = st && st.lp > 0 ? Math.min(1, bal / st.lp) : 0, qa = st ? st.ra * share : 0, qb = st ? st.rb * share : 0;
        const pa = t.now.px.get(akey(ref.a)), pb = t.now.px.get(akey(ref.b));
        const vN = pa != null && pb != null ? qa * pa + qb * pb : pa != null ? qa * pa * 2 : pb != null ? qb * pb * 2 : null;
        const vU = vN != null ? (t.now.usdPerNative != null ? vN * t.now.usdPerNative : null) : null;
        if (vU != null) tot += vU;
        return `<tr ondblclick="window.pa.open('pools')" title="Double-click to open the pool"><td><div class="coin">${star('p:' + ref.account)}<i>LP</i><div><b>${esc(nm(ref.a))} / ${esc(nm(ref.b))}</b><div class="mut mono" style="font-size:.7rem">LP token · pool ${esc(short(ctx.show(ref.account), 8, 5))} · fee ${ref.fee}%</div></div></div></td><td class="r mono">${fmt(bal, 6)}</td><td class="r">${(share * 100).toFixed(share < 0.0001 ? 6 : share < 0.01 ? 4 : 2)}%</td><td class="r mono">${fmt(qa, 4)} <small class="mut">${esc(nm(ref.a))}</small><br>${fmt(qb, 4)} <small class="mut">${esc(nm(ref.b))}</small></td><td class="r">${vU != null ? usd(vU) : vN != null ? fmt(vN, 2) + ' ' + esc(ctx.native()) : '–'}</td><td class="r"><button class="sm" onclick="window.goTab('pools')">Manage</button></td></tr>`;
      })
      .join('');
    setHtml('pa', `<table class="dxt"><thead><tr>${sth('Pool (pair)', 'pair', '')}${sth('LP balance', 'bal')}${sth('Pool share', 'sh')}<th class="r">Your amounts in the pool</th>${sth('Value', 'val')}<th></th></tr></thead><tbody>${body || '<tr><td colspan="6" class="mut" style="padding:1rem">This wallet holds no LP tokens.</td></tr>'}</tbody></table><div class="mut" style="font-size:.74rem;margin-top:.4rem">LP tokens are your share of a liquidity pool. Amounts are what you would get back by withdrawing everything now. Total LP value: <b>${usd(tot)}</b>.</div>`);
    keep.pa = ($('pa') as HTMLElement).innerHTML;
    return;
  }
  const others = PA.tab === 'others';
  let last = '';
  const acc: Record<string, (x: any) => any> = {
    name: x => x.r.name,
    price: x => (x.r.usdPx != null ? x.r.usdPx : x.r.nativePx),
    chg: x => x.r.chg['24h'],
    bal: x => x.bal,
    value: x => (x.r.nativePx != null ? x.bal * x.r.nativePx : null),
    supply: x => x.r.supply,
    mcap: x => x.r.mcapUsd ?? x.r.mcapNative,
    liq: x => x.r.tvlUsd ?? x.r.tvlNative,
  };
  const showS = PA.sort.c || PA.tab !== 'all' ? srt(show, acc[PA.sort.c] || (() => null), (x: any) => isFav('t:' + x.r.key)) : show;
  const body = showS
    .map(({ r, l, bal, cat }) => {
      const head = PA.tab === 'all' && !PA.sort.c && cat !== last ? `<tr class="cathead"><td colspan="9">${esc(cat.slice(2))}</td></tr>` : '';
      last = cat;
      const meta = reg.get(r.key);
      const val = r.nativePx != null ? bal * r.nativePx : null;
      const act = isNative(r.a)
        ? '<button class="sm pri acc" onclick="window.goTab(\'send\')">Send</button>'
        : `${l ? '<span class="tag ok" title="Trust line is set">trusted</span>' : `<button class="sm pri" onclick="window.mk.trust('${esc(r.key)}',this);setTimeout(window.pa.reload,2500)">Trust</button>`} <button class="sm" onclick="window.pa.trade('${esc(r.key)}')">Trade</button>${others ? ` <button class="sm" onclick="window.tk.openPool('${esc(r.key)}')">Pool</button>` : ''}`;
      const sub = isNative(r.a) ? 'native coin' : meta ? `by ${esc(short(ctx.show(meta.creator), 6, 4))}${meta.ms ? ' · ' + ago(Date.now() - meta.ms) : ''}` : esc(short(ctx.show(r.issuer), 8, 5));
      return `${head}<tr ondblclick="window.pa.open('trade','${esc(r.key)}')" title="Double-click to open"><td><div class="coin">${star('t:' + r.key)}${coinIcon(r.key, r.name)}<div><b>${esc(r.name)}</b><div class="mut mono" style="font-size:.7rem">${sub}</div>${others && meta && (meta.desc || meta.site) ? `<div class="mut" style="font-size:.72rem;max-width:18rem;white-space:normal">${esc(meta.desc)} ${meta.site ? `<a href="${esc(meta.site)}" target="_blank" rel="noopener noreferrer">site</a>` : ''}</div>` : ''}</div></div></td><td class="r">${r.usdPx != null ? usd(r.usdPx) : r.nativePx != null ? fmt(r.nativePx) + ' ' + esc(nat) : '<span class="mut">no pool</span>'}</td><td class="r">${pctHtml(r.chg['24h'])}${r.partial['24h'] ? '<small class="mut" title="Since listing">*</small>' : ''}</td><td class="r">${l || isNative(r.a) ? fmt(bal) : '<span class="mut">–</span>'}</td><td class="r">${val != null && (l || isNative(r.a)) ? (px != null ? usd(val * px) : fmt(val) + ' ' + esc(nat)) : '<span class="mut">–</span>'}</td><td class="r">${r.supply != null ? fmt(r.supply) : '–'}</td><td class="r">${r.mcapUsd != null ? usd(r.mcapUsd) : r.mcapNative != null ? fmt(r.mcapNative) + ' ' + esc(nat) : '–'}</td><td class="r">${r.tvlUsd != null ? usd(r.tvlUsd) : r.tvlNative ? fmt(r.tvlNative) : '–'}<div class="mut" style="font-size:.7rem">${r.pools} pool${r.pools === 1 ? '' : 's'}</div></td><td class="r" style="white-space:nowrap">${act}</td></tr>`;
    })
    .join('');
  setHtml('pa', `<table class="dxt tok9"><thead><tr>${sth('Asset', 'name', '')}${sth('Price', 'price')}${sth('24h', 'chg')}${sth('Balance', 'bal')}${sth('Value', 'value')}${sth('Supply', 'supply')}${sth('Market cap', 'mcap')}${sth('Liquidity', 'liq')}<th></th></tr></thead><tbody>${body || `<tr><td colspan="9" class="mut" style="padding:1rem">${others ? 'No tokens have been created on this network yet. Use “Create token” to make the first one.' : 'Nothing here yet.'}</td></tr>`}</tbody></table><div class="mut" style="font-size:.74rem;margin-top:.5rem">Every token with a pool on this network, every token created here, and every trust line this wallet has. Categories go by symbol; created tokens are under Others. Wallet total: <b>${px != null ? usd(total * px) : fmt(total) + ' ' + esc(nat)}</b>. * = since the token first appeared in a pool.${TK.genesisAddr() ? '' : ' Created tokens are found through the genesis wallet: set it once in the token creator.'}</div>`);
  if (PA.tab === 'fav') {
    const fp = (D.pools || []).map(poolRow).filter((x: any) => isFav(x.k));
    const el = $('pa') as HTMLElement;
    el.insertAdjacentHTML('beforeend', `<div class="k" style="margin:.8rem 0 .3rem">Favorite pools</div>${fp.length ? poolTable(fp) : '<div class="mut">No favorite pools. Star pools on the All pools tab.</div>'}`);
  }
  keep.pa = ($('pa') as HTMLElement).innerHTML;
}
export const paApi = {
  reload() {
    loadAssets();
  },
  tab(k: string) {
    PA.tab = k;
    document.querySelectorAll('#pa_tabs button').forEach((b, i) => b.classList.toggle('on', ['all', 'dollar', 'bridged', 'others', 'lp', 'pools', 'fav'][i] === k));
    renderAssets();
  },
  fav(k: string) {
    FAV.has(k) ? FAV.delete(k) : FAV.add(k);
    try {
      localStorage.setItem(FAVK, JSON.stringify([...FAV]));
    } catch {}
    renderAssets();
  },
  sort(c: string) {
    PA.sort = PA.sort.c === c ? (PA.sort.d < 0 ? { c, d: 1 } : { c: '', d: -1 }) : { c, d: c === 'name' || c === 'pair' ? 1 : -1 };
    renderAssets();
  },
  open(w: string, k?: string) {
    if (w === 'trade' && k) (window as any).pa.trade(k);
    else (window as any).goTab('pools');
  },
  trade(k: string) {
    const w = window as any;
    w.dx.want(k);
    w.goTab('dex');
  },
};
