// Unit tests for src/live/toolkit.ts. Run: npx esbuild src/live/toolkit.ts --bundle --format=esm --platform=node --outfile=/tmp/toolkit.mjs && node test/toolkit.test.mjs
import assert from 'assert';
const store = {}; globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
globalThis.document = { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({}) }; globalThis.window = globalThis; globalThis.location = { hash: '' };
const T = await import(process.argv[2] || '/tmp/toolkit.mjs'); let n = 0;
const t = async (name, f) => { try { await f(); n++; console.log('  ok  ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } };
const A = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', B = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
await t('parsePay reads address and amount, any separator', () => { const r = T.parsePay(`${A}, 5\n${B} 2.5`); assert.strictEqual(r.rows.length, 2); assert.strictEqual(r.rows[1].amt, 2.5); assert.strictEqual(r.bad.length, 0); });
await t('parsePay rejects bad addresses, repeats and bad amounts', () => { const r = T.parsePay(`nope, 1\n${A}, 1\n${A}, 2\n${B}, -3`); assert.strictEqual(r.rows.length, 1); assert.strictEqual(r.bad.length, 3); });
await t('parsePay with no amounts keeps the address (for split bill)', () => { const r = T.parsePay(A + '\n' + B); assert.strictEqual(r.rows.length, 2); assert.strictEqual(r.rows[0].amt, undefined); });
await t('splitBill always adds up exactly', () => { for (const [tot, k] of [[100, 3], [10, 7], [0.000001, 3], [1, 1], [99.99, 4]]) { const s = T.splitBill(tot, k); assert.strictEqual(s.length, k); assert(Math.abs(s.reduce((a, b) => a + b, 0) - tot) < 1e-9, tot + '/' + k); } assert.deepStrictEqual(T.splitBill(0, 3), []); });
await t('health score drops with empty lines and reserve', () => { assert.strictEqual(T.healthScore({ reserveShare: 0.05, unusedLines: 0, offers: 0, lines: 3 }).score, 100); const h = T.healthScore({ reserveShare: 0.6, unusedLines: 4, offers: 12, lines: 50 }); assert(h.score < 50 && h.notes.length >= 3, JSON.stringify(h)); assert(T.healthScore({ reserveShare: 0, unusedLines: 99, offers: 0, lines: 0 }).score >= 70); });
await t('alerts fire only on the right side of the line', () => { assert(T.alertHit({ dir: 'above', price: 10 }, 10)); assert(!T.alertHit({ dir: 'above', price: 10 }, 9.9)); assert(T.alertHit({ dir: 'below', price: 10 }, 9)); assert(!T.alertHit({ dir: 'below', price: 10 }, null)); });
await t('csv escapes commas, quotes and newlines', () => { assert.strictEqual(T.csvRow(['a,b', 'c"d', 'e\nf', 5]), '"a,b","c""d","e\nf",5'); });
console.log(n + ' passed');
