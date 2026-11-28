import assert from 'node:assert';
const store = {}; globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } }; globalThis.window = globalThis; globalThis.document = { getElementById: () => null };
const T = await import('/tmp/toolkit3.mjs'); let n = 0; const t = (name, f) => { f(); n++; };
t('goalPct clamps', () => { assert.equal(T.goalPct(50, 200), 25); assert.equal(T.goalPct(500, 200), 100); assert.equal(T.goalPct(5, 0), 0); });
t('projectEarn', () => assert.equal(Math.round(T.projectEarn(1000, 0.073, 365)), 73));
t('bestMarket', () => assert.equal(T.bestMarket([{ asset: 'a', apy: 0.02 }, { asset: 'b', apy: 0.07 }]).asset, 'b'));
t('hfAlert fires only with debt, under threshold, and not too often', () => { assert(T.hfAlert(1.2, 100, 1.4, 0, 1e9)); assert(!T.hfAlert(1.6, 100, 1.4, 0, 1e9)); assert(!T.hfAlert(1.2, 0, 1.4, 0, 1e9)); assert(!T.hfAlert(1.2, 100, 1.4, 1e9 - 1000, 1e9)); assert(!T.hfAlert(1.2, 100, 0, 0, 1e9)); });
t('achievements and score', () => { const s = { txs: 120, sent: 5, received: 2, trades: 1, lines: 3, nfts: 1, activated: true }; assert(T.achievements(s).every(a => a.done)); assert(T.walletScore(s) > 70); assert.equal(T.walletScore({ ...s, activated: false }), 0); assert(T.walletScore({ txs: 0, sent: 0, received: 0, trades: 0, lines: 0, nfts: 0, activated: true }) === 20); });
console.log(n + ' passed');
