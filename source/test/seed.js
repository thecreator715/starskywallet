// Seeds a simulated LUMA network: issuer, USD + XRPZ tokens, three AMM pools, a funded user. usage: node seed.js <rpcPort> <out.json>
const fs = require('fs'); const [RPC, OUT] = process.argv.slice(2);
const rpc = async (method, params = {}) => { const r = await fetch(`http://127.0.0.1:${RPC}`, { method: 'POST', body: JSON.stringify({ method, params: [params] }) }); return (await r.json()).result; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hexCur = s => Buffer.from(s).toString('hex').toUpperCase().padEnd(40, '0');
let NID = 0; const tx = async (w, t) => { if (!NID) NID = (await rpc('server_info')).info.network_id; const r = await rpc('submit', { secret: w.master_seed, tx_json: { Account: w.account_id, ...(NID > 1024 ? { NetworkID: NID } : {}), ...t } }); if (r.engine_result !== 'tesSUCCESS') throw new Error(t.TransactionType + ': ' + (r.engine_result || r.error)); await sleep(1100); return r; };
(async () => {
  const gen = await rpc('wallet_propose', { passphrase: process.env.GENESIS_PASSPHRASE || 'test-genesis-secret-xyz' });
  const [issuer, user, lp, trader] = await Promise.all([1, 2, 3, 4].map(() => rpc('wallet_propose')));
  for (const w of [issuer, user, lp, trader]) await tx(gen, { TransactionType: 'Payment', Destination: w.account_id, Amount: String(60000 * 1e6) });
  await tx(issuer, { TransactionType: 'AccountSet', SetFlag: 8 });
  const USD = hexCur('USD'), XRPZ = hexCur('XRPZ'), toks = { USD, XRPZ };
  for (const w of [user, lp, trader]) for (const c of [USD, XRPZ]) await tx(w, { TransactionType: 'TrustSet', LimitAmount: { currency: c, issuer: issuer.account_id, value: '100000000' } });
  const pay = (w, c, v) => tx(issuer, { TransactionType: 'Payment', Destination: w.account_id, Amount: { currency: c, issuer: issuer.account_id, value: String(v) } });
  await pay(lp, USD, 60000); await pay(lp, XRPZ, 90000); await pay(trader, USD, 20000); await pay(trader, XRPZ, 20000); await pay(user, USD, 1000); await pay(user, XRPZ, 500);
  const I = (c, v) => ({ currency: c, issuer: issuer.account_id, value: String(v) });
  await tx(lp, { TransactionType: 'AMMCreate', Amount: String(20000 * 1e6), Amount2: I(USD, 10000), TradingFee: 500 });
  await tx(lp, { TransactionType: 'AMMCreate', Amount: String(20000 * 1e6), Amount2: I(XRPZ, 40000), TradingFee: 300 });
  await tx(lp, { TransactionType: 'AMMCreate', Amount: I(XRPZ, 40000), Amount2: I(USD, 20000), TradingFee: 300 });
  fs.writeFileSync(OUT, JSON.stringify({ rpc: +RPC, genesis: gen, issuer, user, lp, trader, toks }, null, 1)); console.log('seeded', OUT);
})().catch(e => { console.error('SEED FAILED', e.message); process.exit(1); });
