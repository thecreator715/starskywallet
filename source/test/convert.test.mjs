// Unit tests for src/live/convert.ts planning logic.
import assert from 'assert';
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({}) }; globalThis.window = globalThis; globalThis.location = { hash: '' };
const C = await import(process.argv[2] || '/tmp/convert.mjs'); let n = 0;
const t = async (name, f) => { try { await f(); n++; console.log('  ok  ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } };
const h = (k, bal) => ({ key: k, name: k, bal, a: { c: k, i: 'r' } });
const q = (out, impact) => ({ out, impact, src: 'AMM pool' });
await t('good quotes are selected and totalled', () => { const p = C.planConvert([h('A', 10), h('B', 5)], { A: q(20, 0.001), B: q(7, 0.002) }); assert.strictEqual(p.count, 2); assert.strictEqual(p.total, 27); });
await t('no quote or zero output: greyed out with a reason, never selected', () => { const p = C.planConvert([h('A', 10), h('B', 5)], { A: null, B: q(0, 0) }); assert.strictEqual(p.count, 0); assert(p.rows.every(r => r.state === 'none' && r.reason && !r.run)); });
await t('impact over the limit is skipped until overridden', () => { const hs = [h('A', 10)], qs = { A: q(5, 0.03) }; let p = C.planConvert(hs, qs, 1); assert.strictEqual(p.rows[0].state, 'impact'); assert.strictEqual(p.count, 0); p = C.planConvert(hs, qs, 1, new Set(['A'])); assert.strictEqual(p.count, 1); p = C.planConvert(hs, qs, 5); assert.strictEqual(p.count, 1); });
await t('unticked tokens are left out of the total', () => { const p = C.planConvert([h('A', 1), h('B', 1)], { A: q(3, 0), B: q(4, 0) }, 1, new Set(), new Set(['B'])); assert.strictEqual(p.total, 3); assert.strictEqual(p.count, 1); });
await t('zero balance is dust, nothing to convert', () => { const p = C.planConvert([h('A', 0)], { A: q(1, 0) }); assert.strictEqual(p.rows[0].state, 'dust'); assert.strictEqual(p.count, 0); });
await t('minOut applies the slippage and never reaches zero', () => { assert.strictEqual(C.minOut(100, 1), 99); assert(C.minOut(0, 1) > 0); });
await t('fees count swaps plus removals; typing is required only at or over the threshold', () => { assert.strictEqual(C.feeTotal(3, 0.00001, 3), 0.00006); assert(C.needsTyping(500, 500)); assert(!C.needsTyping(499, 500)); assert(!C.needsTyping(1e9, 0)); });
console.log(n + ' passed');
