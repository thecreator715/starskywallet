// Starsky Lending page in a real browser against the simulated chain (run ./up.sh first). node newpages-ui.cjs
const { chromium } = require('playwright'); const fs = require('fs'), http = require('http'), path = require('path'); const { webcrypto: C } = require('crypto'); const assert = require('assert');
const seed = JSON.parse(fs.readFileSync(__dirname + '/.run/seed-main.json')), b64 = u => Buffer.from(u).toString('base64');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'));

const VAULT = seed.lp.account_id; let claimed = false, KEY = 'lk_' + 'a'.repeat(40); const J = (r, o, c = 200) => { r.writeHead(c, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };
const hrs = Array.from({ length: 6 }, (_, i) => [Date.now() - (6 - i) * 36e5, 10 + i, i % 2, 40 + i, 0.001 * (10 + i)]);
const srv = http.createServer(async (q, r) => { const u = new URL(q.url, 'http://x');
  if (u.pathname === '/api/public/devapi') return J(r, { ok: true, set: true, enabled: true, payTo: VAULT, payToClassic: VAULT, memoType: 'luma-api', pricePerCallLUMA: 0.0001, minTopupLUMA: 0.001, defaults: { rps: 10, burst: 20, daily: 0 }, stats: { calls24h: 120, p50: 40, p95: 90, errorRate: 0.01 }, endpoints: [['GET /price', 'Current price'], ['POST /rpc', 'Read-only node calls']] });
  if (u.pathname === '/api/public/devapi/claim' && q.method === 'POST') { if (!claimed) { claimed = true; return J(r, { ok: true, key: KEY }); } return J(r, { error: 'nothing to claim' }, 404); }
  if (u.pathname === '/api/public/v1/usage') { if (q.headers['x-luma-key'] !== KEY) return J(r, { error: 'bad key' }, 401); return J(r, { ok: true, account: { creditsLUMA: 0.5, callsLeft: 5000, spentLUMA: 0.01, depositedLUMA: 0.51, grantedLUMA: 0 }, last24h: { calls: 100, errors: 2, limited: 1, spentLUMA: 0.01, p50: 40, p95: 90 }, key: { id: 'k1' }, keys: [{ id: 'k1', label: 'Starsky', prefix: 'lk_aaaaaaa', calls: 100, spentLUMA: 0.01, lastUsed: Date.now(), revoked: false }], hourly: hrs, endpoints: [{ ep: 'GET /price', n: 90, err: 0, p50: 30, p95: 70, spentLUMA: 0.009 }], recent: [{ t: Date.now(), ep: 'GET /price', status: 200, ms: 33, cost: 0.0001 }] }); }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); }).listen(4192);
let pass = 0; const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + String(e.message || e).split('\n')[0] + ' @' + (String(e.stack).match(/newpages-ui.cjs:(\d+)/) || [])[1]); process.exitCode = 1; } };
var rpc; rpc = async (m, p) => (await (await fetch('http://127.0.0.1:5006', { method: 'POST', body: JSON.stringify({ method: m, params: [p] }) })).json()).result;
(async () => {
  const salt = C.getRandomValues(new Uint8Array(16)), iv = C.getRandomValues(new Uint8Array(12)), km = await C.subtle.importKey('raw', Buffer.from('testpass123'), 'PBKDF2', false, ['deriveKey']);
  const key = await C.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const mk = async active => { const data = { accounts: [{ id: 'a1', label: 'Trader', seed: seed.trader.master_seed, address: seed.trader.account_id, type: 'luma' }, { id: 'a2', label: 'LP', seed: seed.lp.master_seed, address: seed.lp.account_id, type: 'luma' }], active };
    return JSON.stringify({ v: 1, iter: 250000, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(await C.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(JSON.stringify(data))))) }); };
  const br = await chromium.launch(), errs = [], prompts = []; let promptAnswer = null;
  const open = async active => { const vault = await mk(active), pg = await br.newPage({ viewport: { width: 1300, height: 1000 } });
    pg.on('pageerror', e => errs.push(String(e).slice(0, 200))); pg.on('dialog', d => { prompts.push(d.message()); d.accept(d.type() === 'prompt' ? (promptAnswer != null ? String(promptAnswer) : d.defaultValue()) : undefined); });
    await pg.addInitScript(([v]) => { if (!localStorage.getItem('starsky.vault')) { localStorage.setItem('starsky.vault', v); localStorage.setItem('starsky.cfg', JSON.stringify({ net: 'main', urls: { main: 'ws://127.0.0.1:6006' }, usd: {}, book: [], lockMin: 15 })); } }, [vault]);
    await pg.goto('http://127.0.0.1:4192/?luma=ws://127.0.0.1:6006'); await pg.fill('#pw', 'testpass123'); await pg.press('#pw', 'Enter'); await pg.waitForTimeout(4000);
    return pg; };
  const body = async pg => (await pg.innerText('body')).replace(/\s+/g, ' ');
  const pg = await open('a1');
  const t0 = Date.now();
  await pg.evaluate(() => window.goTab('pools')); await pg.waitForSelector('#pl_body table.dxt tbody tr', { timeout: 15000 });
  const first = Date.now() - t0;
  await pg.waitForTimeout(5000);
  const rows = await pg.evaluate(() => document.querySelectorAll('#pl_body table.dxt tbody tr').length);
  console.log('  first rows after', first, 'ms; rows', rows);
  await t('pools appear', async () => assert(rows >= 1));
  await t('prices fill in after the first paint', async () => assert(/\$|LUMA/.test(await pg.innerText('#pl_body'))));
  await t('no page errors', async () => assert(!errs.length, errs.join('|')));
  console.log(pass + ' passed'); await br.close(); process.exit(pass === 3 ? 0 : 1);
})();
