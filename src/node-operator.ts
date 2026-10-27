// Standalone leverage operator: runs 24/7 without the browser.
//   GENESIS_SEED=s... NODE_URL=ws://127.0.0.1:6006 NET=main npm run operator
// It settles stop losses, take profits, liquidations and close requests, paying from the genesis wallet.
import * as xrpl from 'xrpl';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setCtx } from './live/ctx.ts';
import * as Mg from './live/margin.ts';

const seed = process.env.GENESIS_SEED || '';
const url = process.env.NODE_URL || 'ws://127.0.0.1:6006';
const net = process.env.NET || 'main';
if (!seed) {
  console.error('Set GENESIS_SEED to the genesis wallet seed (starts with s). Example:\n  GENESIS_SEED=sXXXX NODE_URL=ws://127.0.0.1:6006 NET=main npm run operator');
  process.exit(1);
}
const wallet = xrpl.Wallet.fromSeed(seed);
const file = path.join(os.homedir(), `.starsky-operator-${net}.json`);
let store: Record<string, string> = {};
try {
  store = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {}
Mg.setKV({
  get: k => (k in store ? store[k] : null),
  set: (k, v) => {
    store[k] = v;
    try {
      fs.writeFileSync(file, JSON.stringify(store));
    } catch {}
  },
});
const client = new xrpl.Client(url);
let netId = 0;
async function connect() {
  if (client.isConnected()) return;
  try {
    await client.connect();
    const si: any = await client.request({ command: 'server_info' });
    netId = si.result.info.network_id || 0;
    console.log('connected to', url, 'network', netId, 'genesis', wallet.classicAddress);
  } catch (e: any) {
    console.error('cannot connect:', e?.message || e);
  }
}
setCtx({
  req: async (command: string, params: any = {}) => (await client.request({ command, ...params } as any)).result,
  online: () => client.isConnected(),
  native: () => 'LUMA',
  netKey: () => net,
  account: () => undefined,
  wallets: () => [{ label: 'Genesis', address: wallet.classicAddress, seed, type: 'luma' as const }],
  toast: m => console.log('[alert]', m),
  submitAs: async (sd: string, tx: any) => {
    try {
      const w = xrpl.Wallet.fromSeed(sd);
      const p: any = await client.autofill(tx);
      if (p.NetworkID == null && netId > 1024) p.NetworkID = netId;
      const s = w.sign(p);
      const r: any = await client.submitAndWait(s.tx_blob);
      const code = r.result.meta?.TransactionResult || r.result.engine_result;
      return code === 'tesSUCCESS' ? { ok: true, hash: s.hash } : { ok: false, msg: code };
    } catch (e: any) {
      return { ok: false, msg: String(e?.message || e) };
    }
  },
});
Mg.setGenesis(wallet.classicAddress);
(async () => {
  await connect();
  setInterval(connect, 15000);
  Mg.setOperator(true);
  setInterval(() => Mg.refresh(true).catch(() => {}), 20000);
  console.log('operator running. Press Ctrl+C to stop. State is kept in', file);
})();
