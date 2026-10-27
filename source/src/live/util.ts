export interface Asset {
  c: string; // 'native' or currency code (3 chars or 40 hex)
  i: string; // issuer (classic) or ''
}
export const NATIVE: Asset = { c: 'native', i: '' };
export const isNative = (a: Asset) => a.c === 'native';
export const akey = (a: Asset) => (isNative(a) ? 'native' : `${a.c}|${a.i}`);
export const fromKey = (k: string): Asset => (k === 'native' ? NATIVE : { c: k.split('|')[0], i: k.split('|')[1] || '' });
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));

/** 40-hex currency -> readable name; 3-letter codes pass through */
export const hexName = (c: string) => {
  if (!c || c.length !== 40) return c;
  const b = (c.match(/../g) || []).map(h => parseInt(h, 16));
  while (b.length && b[b.length - 1] === 0) b.pop();
  return b.length && b.every(x => x >= 32 && x < 127) ? String.fromCharCode(...b) : c.slice(0, 6) + '…';
};
/** readable name -> on-ledger currency code */
export const nameToCur = (n: string) => {
  n = n.trim();
  if (/^[0-9A-Fa-f]{40}$/.test(n)) return n.toUpperCase();
  if (/^[A-Za-z0-9?!@#$%^&*(){}\[\]|]{3}$/.test(n) && n !== 'XRP') return n;
  if (!n || n.length > 20 || !/^[\x21-\x7e]+$/.test(n)) throw new Error('Currency: 3 characters, or up to 20 letters/digits (stored as a 40-digit code)');
  return Buffer40(n);
};
const Buffer40 = (s: string) =>
  Array.from(s)
    .map(ch => ch.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
    .padEnd(40, '0');

export const amtNum = (x: any) => (x == null ? 0 : typeof x === 'string' ? Number(x) / 1e6 : Number(x.value));
export const assetOf = (x: any): Asset =>
  typeof x === 'string' || !x || x.currency === 'XRP' || x.currency === 'LUMA' ? (x && x.issuer ? { c: x.currency, i: x.issuer } : NATIVE) : { c: x.currency, i: x.issuer };
export const issueOf = (a: Asset) => (isNative(a) ? { currency: 'XRP' } : { currency: a.c, issuer: a.i });
export const decN = (n: number) => {
  let s = String(Number(Number(n).toPrecision(15)));
  if (/e/i.test(s)) s = Number(s).toFixed(18).replace(/0+$/, '').replace(/\.$/, '');
  return s;
};
export const amtTx = (a: Asset, n: number) => {
  if (!(n > 0) || !isFinite(n)) throw new Error('Amount must be greater than zero');
  if (isNative(a)) {
    const d = Math.round(n * 1e6);
    if (d < 1) throw new Error('Below the smallest unit (1 drop)');
    return String(d);
  }
  return { currency: a.c, issuer: a.i, value: decN(n) };
};

/** compact, readable numbers */
export const fmt = (n: number | null | undefined, d?: number) => {
  if (n == null || !isFinite(n as number)) return '–';
  const v = Number(n);
  const a = Math.abs(v);
  if (d != null) return v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K';
  if (a >= 100) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (a >= 1) return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (a === 0) return '0';
  if (a >= 0.0001) return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return v.toExponential(2);
};
export const usd = (n: number | null | undefined) => (n == null || !isFinite(n as number) ? '–' : '$' + fmt(n, Math.abs(n as number) < 1 ? 4 : 2));
export const pct = (v: number | null | undefined) => (v == null || !isFinite(v as number) ? null : v);
export const pctHtml = (v: number | null | undefined, cls = '') => {
  if (v == null || !isFinite(v as number)) return `<span class="mut ${cls}">–</span>`;
  const c = v > 0.005 ? 'up' : v < -0.005 ? 'dn' : 'mut';
  return `<span class="${c} ${cls}">${v > 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 10 ? 2 : 1)}%</span>`;
};
export const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};
export const dur = (sec: number) => {
  if (sec < 90) return Math.round(sec) + ' s';
  if (sec < 5400) return Math.round(sec / 60) + ' min';
  if (sec < 172800) return (sec / 3600).toFixed(1) + ' h';
  return (sec / 86400).toFixed(1) + ' d';
};
export const short = (s: string, a = 6, b = 4) => (s && s.length > a + b + 1 ? s.slice(0, a) + '…' + s.slice(-b) : s || '');
export const RIPPLE_EPOCH = 946684800;
export const rippleToMs = (t: number) => (t + RIPPLE_EPOCH) * 1000;
