import { setCtx } from '../src/live/ctx.ts';
import * as M from '../src/live/market.ts';
import * as C from '../src/live/chain.ts';
const RPC = +process.argv[2] || 5006;
setCtx({ req: async (command: string, params: any = {}) => { const r = await fetch(`http://127.0.0.1:${RPC}`, { method: 'POST', body: JSON.stringify({ method: command, params: [params] }) }); const j: any = (await r.json()).result; if (j.error) throw new Error(j.error); return j; }, online: () => true });
(async () => {
  const i = await C.info(); console.log('info', i.seq, i.minSeq, 'per', await C.secPerLedger());
  const refs = await M.poolRefs(); console.log('pools', refs.length, refs.map(r => M.labelOf(r.a) + '/' + M.labelOf(r.b)).join(', '));
  const t = await M.tokenTable(); for (const r of t.rows) console.log(r.name.padEnd(6), 'usd', r.usdPx?.toFixed(4), 'chg', JSON.stringify(r.chg), 'supply', r.supply, 'tvlUsd', r.tvlUsd?.toFixed(0), 'mcap', r.mcapUsd?.toFixed(0));
  const mk = M.marketsFrom(refs); console.log('markets', mk.map(m => m.label).join(', '));
  const m = mk[0]; const cd = await M.candles(m, M.RANGES[0]); console.log('candles', m.label, cd.list.length, JSON.stringify(cd.list[cd.list.length - 1]), cd.note);
  const tr = await M.trades(m, 50); console.log('trades', tr.length, JSON.stringify(tr.slice(0, 3)));
})().catch(e => { console.error('FAIL', e); process.exit(1); });
