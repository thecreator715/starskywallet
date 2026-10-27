// LUMA address layer. The ledger itself uses standard XRPL account IDs (20 bytes). LUMA wallet addresses are the
// same 20 bytes encoded with version byte 48, which always yields a 34-char address starting with "L".
// The panel translates L <-> r at its edge, so rippled and standard XRPL tooling keep working unchanged.
'use strict';
const ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
const L_VERSION = 48, T_VERSION = 65, R_VERSION = 0;
// Two LUMA networks, two address families over the same 20-byte account IDs: Mainnet "L…" (version 48), Testnet "T…" (version 65).
// A Testnet address can never pass as a Mainnet one (different checksum payload), so funds cannot be sent to the wrong network by typo or paste.
const VERS = { L: L_VERSION, T: T_VERSION }; let ACTIVE = 'L';
function use(prefix) { if (!VERS[prefix]) throw new Error('unknown address prefix'); ACTIVE = prefix; }
const active = () => ACTIVE;

// pure-JS SHA-256 (no dependencies)
const primes = []; for (let n = 2; primes.length < 64; n++) if (primes.every(p => n % p)) primes.push(n);
const frac = x => Math.floor((x % 1) * 4294967296);
const K = primes.map(p => frac(Math.cbrt(p))), H0 = primes.slice(0, 8).map(p => frac(Math.sqrt(p)));
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
function sha256(bytes) {
  const l = bytes.length, pl = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(pl);
  m.set(bytes); m[l] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(pl - 8, Math.floor(l * 8 / 4294967296)); dv.setUint32(pl - 4, (l * 8) >>> 0);
  const h = H0.slice(), w = new Array(64);
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
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  h.forEach((v, i) => ov.setUint32(i * 4, v >>> 0)); return out;
}

function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = ''; while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = ALPHABET[0] + s; else break; }
  return s;
}
function b58decode(str) {
  let n = 0n;
  for (const ch of str) { const i = ALPHABET.indexOf(ch); if (i < 0) throw new Error('invalid character in address'); n = n * 58n + BigInt(i); }
  const hex = n.toString(16); const body = hex === '0' ? [] : hex.padStart(hex.length + (hex.length % 2), '0').match(/../g).map(h => parseInt(h, 16));
  let lead = 0; for (const ch of str) { if (ch === ALPHABET[0]) lead++; else break; }
  return Uint8Array.from([...new Array(lead).fill(0), ...body]);
}
function encodeAccount(id, version) {
  const payload = Uint8Array.from([version, ...id]);
  const chk = sha256(sha256(payload)).slice(0, 4);
  return b58encode(Uint8Array.from([...payload, ...chk]));
}
function decodeAccount(addr) {
  const raw = b58decode(String(addr));
  if (raw.length !== 25) throw new Error('invalid address length');
  const payload = raw.slice(0, 21), chk = sha256(sha256(payload)).slice(0, 4);
  for (let i = 0; i < 4; i++) if (chk[i] !== raw[21 + i]) throw new Error('invalid address checksum');
  return { version: payload[0], id: payload.slice(1) };
}
const R_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, LT_RE = /^[LT][1-9A-HJ-NP-Za-km-z]{33}$/;
// 'r' | 'L' | 'T' | null for a well-formed, checksum-valid address
function kind(a) { try { a = String(a); const v = decodeAccount(a).version; if (v === R_VERSION && R_RE.test(a)) return 'r'; if (LT_RE.test(a)) return v === L_VERSION ? 'L' : v === T_VERSION ? 'T' : null; return null; } catch { return null; } }
const NETNAME = { L: 'LUMA Mainnet (L…)', T: 'LUMA Testnet (T…)' };
function isL(a) { return kind(a) === ACTIVE; }          // "is a LUMA address of the ACTIVE network"
function wrongNet(a) { const k = kind(a); return (k === 'L' || k === 'T') && k !== ACTIVE ? `That is a ${NETNAME[k]} address, but this is ${NETNAME[ACTIVE]}. Funds sent to it would not arrive.` : ''; }
function isR(a) { try { return R_RE.test(a) && decodeAccount(a).version === R_VERSION; } catch { return false; } }
function toL(a) { if (isL(a)) return a; if (!isR(a)) throw new Error('not a valid address'); return encodeAccount(decodeAccount(a).id, VERS[ACTIVE]); }
function toR(a) { if (isR(a)) return a; const w = wrongNet(a); if (w) throw new Error(w); if (!isL(a)) throw new Error('not a valid address'); return encodeAccount(decodeAccount(a).id, R_VERSION); }
// accepts an L or r address, returns the r form the ledger uses; throws a clear error otherwise
function normalize(a) {
  a = String(a || '').trim();
  if (isL(a) || isR(a)) return toR(a);
  const w = wrongNet(a); if (w) throw new Error(w);
  throw new Error(a ? `invalid address (expected a ${ACTIVE}… ${NETNAME[ACTIVE]} address; bad character or checksum)` : 'address required');
}
// convert every r-address string inside a JSON value to its L form (hashes/hex never match)
function deepToL(v) {
  if (typeof v === 'string') return R_RE.test(v) && isR(v) ? toL(v) : v;
  if (Array.isArray(v)) return v.map(deepToL);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = deepToL(v[k]); return o; }
  return v;
}
const api = { sha256, encodeAccount, decodeAccount, isL, isR, toL, toR, normalize, deepToL, L_VERSION, T_VERSION, use, active, kind, wrongNet, NETNAME };
if (typeof module === 'object') module.exports = api; else globalThis.LumaAddr = api;
