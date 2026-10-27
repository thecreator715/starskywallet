// moves prices: node trade.js <seed.json> <n>  (IOC swaps by the trader through the pools)
const fs = require('fs'); const S = JSON.parse(fs.readFileSync(process.argv[2])); const n = +process.argv[3] || 3;
const rpc = async (method, params = {}) => { const r = await fetch(`http://127.0.0.1:${S.rpc}`, { method: 'POST', body: JSON.stringify({ method, params: [params] }) }); return (await r.json()).result; };
(async () => { const t = S.trader, I = (c, v) => ({ currency: c, issuer: S.issuer.account_id, value: String(v) });
  for (let i = 0; i < n; i++) { const buy = i % 2 === 0;
    const tx_json = buy ? { TransactionType: 'OfferCreate', Account: t.account_id, Flags: 0x00020000, TakerGets: I(S.toks.USD, 400 + i * 50), TakerPays: String(1 * 1e6) } : { TransactionType: 'OfferCreate', Account: t.account_id, Flags: 0x00020000, TakerGets: String(300 * 1e6), TakerPays: I(S.toks.USD, 1) };
    const nid = (await rpc('server_info')).info.network_id; if (nid > 1024) tx_json.NetworkID = nid; const r = await rpc('submit', { secret: t.master_seed, tx_json }); console.log(r.engine_result); await new Promise(r => setTimeout(r, 1500)); } })();
