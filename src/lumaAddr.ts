// LUMA address layer. The ledger itself uses standard XRPL account IDs (20 bytes).
// LUMA wallet addresses are the same 20 bytes encoded with version byte 48 (Mainnet: 'L...'),
// version byte 65 (Testnet: 'T...'), or version byte 0 (XRPL standard: 'r...').

export const ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
export const L_VERSION = 48;
export const T_VERSION = 65;
export const R_VERSION = 0;

export const VERS: Record<string, number> = { L: L_VERSION, T: T_VERSION };
let ACTIVE = 'T'; // Default to Testnet

export function use(prefix: string) {
  if (!VERS[prefix]) throw new Error('Unknown address prefix: ' + prefix);
  ACTIVE = prefix;
}
export const active = () => ACTIVE;

// Pure-JS SHA-256 for address checksums
const primes: number[] = [];
for (let n = 2; primes.length < 64; n++) {
  if (primes.every(p => n % p !== 0)) primes.push(n);
}
const frac = (x: number) => Math.floor((x % 1) * 4294967296);
const K = primes.map(p => frac(Math.cbrt(p)));
const H0 = primes.slice(0, 8).map(p => frac(Math.sqrt(p)));
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256(bytes: Uint8Array): Uint8Array {
  const l = bytes.length;
  const pl = ((l + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(pl);
  m.set(bytes);
  m[l] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(pl - 8, Math.floor(l * 8 / 4294967296));
  dv.setUint32(pl - 4, (l * 8) >>> 0);
  const h = H0.slice();
  const w = new Array(64);
  for (let o = 0; o < pl; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = (w[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  h.forEach((v, i) => ov.setUint32(i * 4, v >>> 0));
  return out;
}

export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = ALPHABET[0] + s;
    else break;
  }
  return s;
}

export function b58decode(str: string): Uint8Array {
  let n = 0n;
  for (const ch of str) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Invalid character in address');
    n = n * 58n + BigInt(i);
  }
  const hex = n.toString(16);
  const body = hex === '0' ? [] : (hex.padStart(hex.length + (hex.length % 2), '0').match(/../g) || []).map(h => parseInt(h, 16));
  let lead = 0;
  for (const ch of str) {
    if (ch === ALPHABET[0]) lead++;
    else break;
  }
  return Uint8Array.from([...new Array(lead).fill(0), ...body]);
}

export function encodeAccount(id: Uint8Array, version: number): string {
  const payload = Uint8Array.from([version, ...id]);
  const chk = sha256(sha256(payload)).slice(0, 4);
  return b58encode(Uint8Array.from([...payload, ...chk]));
}

export function decodeAccount(addr: string): { version: number; id: Uint8Array } {
  const raw = b58decode(String(addr));
  if (raw.length !== 25) throw new Error('Invalid address length');
  const payload = raw.slice(0, 21);
  const chk = sha256(sha256(payload)).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (chk[i] !== raw[21 + i]) throw new Error('Invalid address checksum');
  }
  return { version: payload[0], id: payload.slice(1) };
}

const R_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const LT_RE = /^[LT][1-9A-HJ-NP-Za-km-z]{33}$/;

export function kind(a: string): 'r' | 'L' | 'T' | null {
  try {
    a = String(a).trim();
    const v = decodeAccount(a).version;
    if (v === R_VERSION && R_RE.test(a)) return 'r';
    if (LT_RE.test(a)) return v === L_VERSION ? 'L' : v === T_VERSION ? 'T' : null;
    return null;
  } catch {
    return null;
  }
}

export const NETNAME: Record<string, string> = {
  L: 'LUMA Mainnet (L…)',
  T: 'LUMA Testnet (T…)',
};

export function isL(a: string): boolean {
  return kind(a) === ACTIVE;
}

export function wrongNet(a: string): string {
  const k = kind(a);
  return (k === 'L' || k === 'T') && k !== ACTIVE
    ? `That is a ${NETNAME[k]} address, but this is ${NETNAME[ACTIVE]}. Funds sent to it would not arrive.`
    : '';
}

export function isR(a: string): boolean {
  try {
    return R_RE.test(a) && decodeAccount(a).version === R_VERSION;
  } catch {
    return false;
  }
}

export function toL(a: string): string {
  if (isL(a)) return a;
  if (!isR(a)) throw new Error('Not a valid address');
  return encodeAccount(decodeAccount(a).id, VERS[ACTIVE] || T_VERSION);
}

export function toR(a: string): string {
  if (isR(a)) return a;
  const w = wrongNet(a);
  if (w) throw new Error(w);
  if (!isL(a)) throw new Error('Not a valid address');
  return encodeAccount(decodeAccount(a).id, R_VERSION);
}

export function normalize(a: string): string {
  a = String(a || '').trim();
  if (isL(a) || isR(a)) return toR(a);
  const w = wrongNet(a);
  if (w) throw new Error(w);
  throw new Error(a ? `Invalid address (expected a ${ACTIVE}… address, or valid r… address)` : 'Address required');
}
