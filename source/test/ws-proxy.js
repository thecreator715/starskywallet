// WebSocket front for the simulated rippled (so a browser app using xrpl.js can talk to it).
// usage: node ws-proxy.js <wsPort> <rpcPort>
const { WebSocketServer } = require('ws');
const [WS, RPC] = process.argv.slice(2).map(Number);
const rpc = async (method, params = {}) => { const r = await fetch(`http://127.0.0.1:${RPC}`, { method: 'POST', body: JSON.stringify({ method, params: [params] }) }); return (await r.json()).result; };
const wss = new WebSocketServer({ port: WS, host: '127.0.0.1' }); const socks = new Set(); let last = 0;
wss.on('connection', s => {
  const sub = { ledger: false, tx: false }; s._sub = sub; socks.add(s); s.on('close', () => socks.delete(s));
  s.on('message', async raw => {
    let q; try { q = JSON.parse(String(raw)); } catch { return; } const { id, command, ...params } = q;
    if (command === 'subscribe') { for (const st of params.streams || []) { if (st === 'ledger') sub.ledger = true; if (st === 'transactions') sub.tx = true; } return s.send(JSON.stringify({ id, type: 'response', status: 'success', result: {} })); }
    if (command === 'unsubscribe') return s.send(JSON.stringify({ id, type: 'response', status: 'success', result: {} }));
    let r; try { r = await rpc(command, params); } catch (e) { r = { error: 'internal', error_message: String(e) }; }
    if (r.error) s.send(JSON.stringify({ id, type: 'response', status: 'error', error: r.error, error_message: r.error_message, request: q }));
    else { const { status, ...rest } = r; s.send(JSON.stringify({ id, type: 'response', status: 'success', result: rest, validated: true })); }
  });
});
setInterval(async () => {
  try {
    const cur = (await rpc('ledger_current')).ledger_current_index - 1; if (!last) last = cur - 1;
    for (let i = last + 1; i <= cur; i++) {
      const l = (await rpc('ledger', { ledger_index: i, transactions: true, expand: true })).ledger; if (!l) continue;
      const ev = { type: 'ledgerClosed', ledger_index: i, ledger_hash: l.ledger_hash, ledger_time: l.close_time, txn_count: (l.transactions || []).length, fee_base: 10, fee_ref: 10, reserve_base: 100000, reserve_inc: 20000, validated_ledgers: `1-${i}`, total_coins: l.total_coins };
      for (const s of socks) if (s._sub.ledger) s.send(JSON.stringify(ev));
      for (const t of l.transactions || []) { const { metaData, ...tx } = t; for (const s of socks) if (s._sub.tx) s.send(JSON.stringify({ type: 'transaction', engine_result: (metaData || {}).TransactionResult, status: 'closed', validated: true, ledger_index: i, transaction: tx, meta: metaData })); }
    }
    last = cur;
  } catch {}
}, 1000);
console.log('ws proxy on', WS, '->', RPC);
