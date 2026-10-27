// SVG candlestick chart: candles, pool-flow bars, moving averages, last-price tag, log / percent / auto scale.
import { Candle } from './market.ts';
import { fmt } from './util.ts';

export interface ChartOpts {
  scale: 'auto' | 'log' | 'pct';
  sma: boolean;
  style?: 'candle' | 'hollow' | 'ohlc' | 'line' | 'area' | 'step';
  ema?: boolean;
  boll?: boolean;
  w?: number;
  h?: number;
  rangeSec: number;
  lines?: ChartLine[];
  volUnit?: string;
}
export interface ChartLine {
  id: string;
  price: number;
  color: string;
  label: string;
  drag?: boolean;
  dash?: string;
}
export interface ChartGeom {
  x0: number;
  x1: number;
  n: number;
  w: number;
  h: number;
  lo?: number;
  hi?: number;
  log?: boolean;
  PT?: number;
  plotH?: number;
}
const W = 1000,
  H0 = 430,
  PR = 74,
  PL = 6,
  PT = 12,
  PB = 26,
  VOLH = 120;
const sma = (xs: number[], n: number) => xs.map((_, i) => (i + 1 < n ? null : xs.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n));
function tlabel(ms: number, span: number) {
  const d = new Date(ms);
  if (span <= 2 * 86400e3) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (span <= 120 * 86400e3) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
}
let H = H0;
export function chartSvg(list: Candle[], o: ChartOpts, liveClose?: number | null): { svg: string; geom: ChartGeom } {
  const geom: ChartGeom = { x0: PL, x1: W - PR, n: list.length, w: W, h: H };
  H = o.h && o.h > 200 ? o.h : H0;
  if (list.length < 2) return { svg: `<svg viewBox="0 0 ${W} ${H}" class="dxsvg"><text x="${W / 2}" y="${H / 2}" fill="#9a92b8" text-anchor="middle" font-size="15">Not enough price history yet for this market.</text></svg>`, geom };
  const cs = list.map(c => ({ ...c }));
  if (liveClose != null && liveClose > 0) {
    const l = cs[cs.length - 1];
    l.c = liveClose;
    l.h = Math.max(l.h, liveClose);
    l.l = Math.min(l.l, liveClose);
  }
  const base = cs[0].o;
  const f = (v: number) => (o.scale === 'pct' ? (v / base - 1) * 100 : v);
  let lo = Math.min(...cs.map(c => f(c.l))),
    hi = Math.max(...cs.map(c => f(c.h)));
  const lastC = cs[cs.length - 1].c;
  const lns = o.scale === 'pct' ? [] : (o.lines || []).filter(l => l.price > 0 && Math.abs(l.price / lastC - 1) <= 0.45);
  for (const l of lns) {
    lo = Math.min(lo, l.price);
    hi = Math.max(hi, l.price);
  }
  if (hi === lo) {
    hi += Math.abs(hi) * 0.01 || 0.01;
    lo -= Math.abs(lo) * 0.01 || 0.01;
  }
  const pad = (hi - lo) * 0.07;
  if (o.scale !== 'log' || lo - pad <= 0) {
    lo -= pad;
    hi += pad;
  }
  const useLog = o.scale === 'log' && lo > 0;
  const plotH = H - PT - PB - VOLH;
  const ty = (v: number) => {
    const t = useLog ? (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) : (v - lo) / (hi - lo);
    return PT + (1 - t) * plotH;
  };
  geom.lo = lo;
  geom.hi = hi;
  geom.log = useLog;
  geom.PT = PT;
  geom.plotH = plotH;
  geom.h = H;
  const px0 = PL,
    pw = W - PL - PR,
    n = cs.length,
    cw = pw / n,
    bw = Math.max(1.5, Math.min(18, cw * 0.62));
  const X = (i: number) => px0 + cw * (i + 0.5);
  let out = `<svg viewBox="0 0 ${W} ${H}" class="dxsvg" id="dx_svg" preserveAspectRatio="none">`;
  // grid + y labels
  const ticks = 6;
  for (let k = 0; k <= ticks; k++) {
    const v = useLog ? Math.exp(Math.log(lo) + ((Math.log(hi) - Math.log(lo)) * k) / ticks) : lo + ((hi - lo) * k) / ticks;
    const y = ty(v);
    out += `<line x1="${px0}" x2="${W - PR}" y1="${y}" y2="${y}" stroke="rgba(155,92,255,.13)"/><text x="${W - PR + 6}" y="${y + 4}" fill="#9a92b8" font-size="11.5" class="mono">${o.scale === 'pct' ? (v >= 0 ? '+' : '') + v.toFixed(1) + '%' : fmt(v)}</text>`;
  }
  const span = cs[n - 1].t - cs[0].t;
  const xt = 6;
  for (let k = 0; k < xt; k++) {
    const i = Math.round(((n - 1) * k) / (xt - 1));
    out += `<text x="${X(i)}" y="${H - 8}" fill="#9a92b8" font-size="11.5" text-anchor="${k === 0 ? 'start' : k === xt - 1 ? 'end' : 'middle'}">${tlabel(cs[i].t, span)}</text>`;
  }
  // volume pane: real traded volume per candle (falls back to pool flow), solid bars coloured by candle direction, scale on the right, latest value tag
  const hasVol = cs.some(c => (c.vol || 0) > 0);
  const vals = cs.map(c => (hasVol ? c.vol || 0 : c.flow));
  const vmax = Math.max(...vals, 0);
  const vy0 = H - PB,
    vTop = vy0 - (VOLH - 14);
  out += `<line x1="${px0}" x2="${W - PR}" y1="${vTop - 8}" y2="${vTop - 8}" stroke="rgba(155,92,255,.22)"/>`;
  if (vmax > 0) {
    for (const fr of [0.5, 1]) {
      const y = vy0 - fr * (VOLH - 14);
      out += `<line x1="${px0}" x2="${W - PR}" y1="${y}" y2="${y}" stroke="rgba(155,92,255,.10)" stroke-dasharray="3 4"/><text x="${W - PR + 6}" y="${y + 4}" fill="#9a92b8" font-size="11" class="mono">${fmt(vmax * fr)}</text>`;
    }
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const ya = vy0 - (avg / vmax) * (VOLH - 14);
    cs.forEach((c, i) => {
      const hh = Math.max(1, (vals[i] / vmax) * (VOLH - 14)),
        up = c.c >= c.o;
      out += `<rect x="${X(i) - bw / 2}" y="${vy0 - hh}" width="${bw}" height="${hh}" fill="${up ? 'rgba(0,224,126,.62)' : 'rgba(255,69,58,.62)'}"${hasVol ? '' : ' opacity=".55"'}><title>${tlabel(c.t, cs[n - 1].t - cs[0].t)} · volume ${fmt(vals[i])} ${o.volUnit || ''}${hasVol && c.n ? ` · ${c.n} swaps · buys ${fmt(c.buyVol || 0)} / sells ${fmt(c.sellVol || 0)}` : ''}</title></rect>`;
    });
    out += `<line x1="${px0}" x2="${W - PR}" y1="${ya}" y2="${ya}" stroke="rgba(255,255,255,.35)" stroke-dasharray="2 3"/>`;
    const lastV = vals[n - 1],
      lastUp = cs[n - 1].c >= cs[n - 1].o,
      ly = vy0 - (lastV / vmax) * (VOLH - 14);
    out += `<rect x="${W - PR + 2}" y="${Math.min(vy0 - 8, Math.max(vTop - 4, ly - 8))}" width="${PR - 4}" height="16" rx="3" fill="${lastUp ? '#00a85c' : '#d93a30'}"/><text x="${W - PR + 6}" y="${Math.min(vy0 - 8, Math.max(vTop - 4, ly - 8)) + 12}" fill="#fff" font-size="11" class="mono">${fmt(lastV)}</text>`;
  }
  out += `<text x="${px0 + 6}" y="${vTop - 12 + 2}" fill="#9a92b8" font-size="11.5">Volume${o.volUnit ? ' (' + o.volUnit + ')' : ''}${hasVol ? '' : ' · pool flow'} <tspan fill="${cs[n - 1].c >= cs[n - 1].o ? '#00e07e' : '#ff6a60'}" font-weight="600">${fmt(vals[n - 1])}</tspan></text>`;
  // price body: candles, hollow candles, OHLC bars, line, step line or area
  const style = o.style || 'candle';
  const closesAll = cs.map(c => f(c.c));
  if (style === 'line' || style === 'area' || style === 'step') {
    const pts = closesAll.map((v, i) => [X(i), ty(v)]);
    let d = '';
    pts.forEach((p, i) => {
      d += i === 0 ? `M${p[0]} ${p[1]}` : style === 'step' ? ` H${p[0]} V${p[1]}` : ` L${p[0]} ${p[1]}`;
    });
    const up = closesAll[closesAll.length - 1] >= closesAll[0];
    const col = up ? '#00e07e' : '#ff453a';
    if (style === 'area') out += `<defs><linearGradient id="dxg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".35"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs><path d="${d} L${pts[pts.length - 1][0]} ${PT + plotH} L${pts[0][0]} ${PT + plotH} Z" fill="url(#dxg)"/>`;
    out += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`;
  } else
    cs.forEach((c, i) => {
      const up = c.c >= c.o,
        col = up ? '#00e07e' : '#ff453a',
        x = X(i);
      const yO = ty(f(c.o)),
        yC = ty(f(c.c));
      if (style === 'ohlc') {
        out += `<line x1="${x}" x2="${x}" y1="${ty(f(c.h))}" y2="${ty(f(c.l))}" stroke="${col}" stroke-width="1.5"/><line x1="${x - bw / 2}" x2="${x}" y1="${yO}" y2="${yO}" stroke="${col}" stroke-width="1.5"/><line x1="${x}" x2="${x + bw / 2}" y1="${yC}" y2="${yC}" stroke="${col}" stroke-width="1.5"/>`;
      } else {
        out += `<line x1="${x}" x2="${x}" y1="${ty(f(c.h))}" y2="${ty(f(c.l))}" stroke="${col}" stroke-width="1.2"/><rect x="${x - bw / 2}" y="${Math.min(yO, yC)}" width="${bw}" height="${Math.max(1.2, Math.abs(yO - yC))}" fill="${style === 'hollow' && up ? '#06020d' : col}" stroke="${col}" stroke-width="1.2"/>`;
      }
    });
  // moving averages
  if (o.sma) {
    const closes = cs.map(c => f(c.c));
    for (const [len, col] of [
      [7, '#ffb020'],
      [25, '#9b5cff'],
    ] as const) {
      const s = sma(closes, len);
      const pts = s.map((v, i) => (v == null ? null : `${X(i)},${ty(v)}`)).filter(Boolean);
      if (pts.length > 1) out += `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="1.4" opacity=".9"/>`;
    }
  }
  if (o.ema || o.boll) {
    const closes = cs.map(c => f(c.c));
    if (o.ema) {
      const k = 2 / 21;
      let e = closes[0];
      const pts = closes.map((v, i) => `${X(i)},${ty((e = i ? v * k + e * (1 - k) : v))}`);
      out += `<polyline points="${pts.join(' ')}" fill="none" stroke="#38e8ff" stroke-width="1.4" opacity=".9"/>`;
    }
    if (o.boll) {
      const N = 20,
        up: string[] = [],
        lo: string[] = [],
        mid: string[] = [];
      closes.forEach((_, i) => {
        if (i + 1 < N) return;
        const w = closes.slice(i + 1 - N, i + 1),
          m = w.reduce((a, b) => a + b, 0) / N,
          sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / N);
        up.push(`${X(i)},${ty(m + 2 * sd)}`);
        lo.push(`${X(i)},${ty(m - 2 * sd)}`);
        mid.push(`${X(i)},${ty(m)}`);
      });
      if (up.length > 1) out += `<polygon points="${up.join(' ')} ${lo.slice().reverse().join(' ')}" fill="rgba(155,92,255,.08)" stroke="none"/><polyline points="${up.join(' ')}" fill="none" stroke="#9b5cff" stroke-width="1" opacity=".8"/><polyline points="${lo.join(' ')}" fill="none" stroke="#9b5cff" stroke-width="1" opacity=".8"/><polyline points="${mid.join(' ')}" fill="none" stroke="#9b5cff" stroke-width="1" stroke-dasharray="3 3" opacity=".6"/>`;
    }
  }
  // order lines: entry, liquidation, stop loss, take profit (draggable ones carry a hit area)
  for (const l of lns) {
    const y = ty(l.price);
    const dash = l.dash || '6 4';
    out += `<g class="dxln" data-id="${l.id}" data-y="${y}"><line x1="${px0}" x2="${W - PR}" y1="${y}" y2="${y}" stroke="${l.color}" stroke-width="1.6" stroke-dasharray="${dash}"/><rect x="${W - PR}" y="${y - 10}" width="${PR - 2}" height="20" fill="${l.color}" rx="3"/><text class="dxlt" x="${W - PR + 5}" y="${y + 4}" fill="#06020d" font-size="11" font-weight="700">${fmt(l.price)}</text><text x="${px0 + 8}" y="${y - 5}" fill="${l.color}" font-size="11.5" font-weight="700">${l.label}${l.drag ? ' ⇅' : ''}</text>${l.drag ? `<rect class="dxhit" data-id="${l.id}" x="${px0}" y="${y - 8}" width="${W - PL - PR + PR}" height="16" fill="transparent" style="cursor:ns-resize"/>` : ''}</g>`;
  }
  // last price
  const last = cs[n - 1].c,
    yl = ty(f(last)),
    upc = last >= cs[0].o ? '#00e07e' : '#ff453a';
  out += `<line x1="${px0}" x2="${W - PR}" y1="${yl}" y2="${yl}" stroke="${upc}" stroke-dasharray="3 4" opacity=".8"/><rect x="${W - PR}" y="${yl - 10}" width="${PR - 2}" height="20" fill="${upc}" rx="3"/><text x="${W - PR + 5}" y="${yl + 4}" fill="#06020d" font-size="11.5" font-weight="700" class="mono">${o.scale === 'pct' ? ((f(last) >= 0 ? '+' : '') + f(last).toFixed(1) + '%') : fmt(last)}</text>`;
  out += `<line id="dx_xh" x1="0" x2="0" y1="${PT}" y2="${H - PB}" stroke="rgba(244,241,255,.45)" stroke-dasharray="2 3" style="display:none"/></svg>`;
  return { svg: out, geom };
}
