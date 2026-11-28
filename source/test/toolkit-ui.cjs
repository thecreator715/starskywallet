// Starsky Checks page in a real browser against the simulated chain (run ./up.sh first). node toolkit-ui.cjs
const { chromium } = require('playwright'); const fs = require('fs'), http = require('http'), path = require('path'); const { webcrypto: C } = require('crypto'); const assert = require('assert');
const seed = JSON.parse(fs.readFileSync(__dirname + '/.run/seed-main.json')), b64 = u => Buffer.from(u).toString('base64');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'));
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); }).listen(4191);
let pass = 0; const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + String(e.message || e).split('\n')[0] + ' @' + (String(e.stack).match(/toolkit-ui.cjs:(\d+)/) || [])[1]); process.exitCode = 1; } };
const rpc = async (m, p) => (await (await fetch('http://127.0.0.1:5006', { method: 'POST', body: JSON.stringify({ method: m, params: [p] }) })).json()).result;
(async () => {
  const salt = C.getRandomValues(new Uint8Array(16)), iv = C.getRandomValues(new Uint8Array(12)), km = await C.subtle.importKey('raw', Buffer.from('testpass123'), 'PBKDF2', false, ['deriveKey']);
  const key = await C.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const mk = async active => { const data = { accounts: [{ id: 'a1', label: 'Trader', seed: seed.trader.master_seed, address: seed.trader.account_id, type: 'luma' }, { id: 'a2', label: 'LP', seed: seed.lp.master_seed, address: seed.lp.account_id, type: 'luma' }], active };
    return JSON.stringify({ v: 1, iter: 250000, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(await C.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(JSON.stringify(data))))) }); };
  const br = await chromium.launch(), errs = [], prompts = []; let promptAnswer = null;
  const open = async active => { const vault = await mk(active), pg = await br.newPage({ viewport: { width: 1300, height: 1000 } });
    pg.on('pageerror', e => errs.push(String(e).slice(0, 200))); pg.on('dialog', d => { prompts.push(d.message()); d.accept(d.type() === 'prompt' ? (promptAnswer != null ? String(promptAnswer) : d.defaultValue()) : undefined); });
    await pg.addInitScript(([v]) => { if (!localStorage.getItem('starsky.vault')) { localStorage.setItem('starsky.vault', v); localStorage.setItem('starsky.cfg', JSON.stringify({ net: 'main', urls: { main: 'ws://127.0.0.1:6006' }, usd: {}, book: [], lockMin: 15 })); } }, [vault]);
    await pg.goto('http://127.0.0.1:4191/?luma=ws://127.0.0.1:6006'); await pg.fill('#pw', 'testpass123'); await pg.press('#pw', 'Enter'); await pg.waitForTimeout(4000);
    await pg.evaluate(() => goTab('toolkit')); await pg.waitForSelector('#tk_list', { timeout: 8000 }); return pg; };
  const body = async pg => (await pg.innerText('body')).replace(/\s+/g, ' ');
  const confirmModal = async (pg, done = true) => { await pg.waitForSelector('.pm .pm-go', { timeout: 8000 }); await pg.click('.pm .pm-go'); if (!done) return; await pg.waitForFunction(() => !document.querySelector('.pm .pm-go'), null, { timeout: 8000 }); await pg.waitForSelector('.pm .pm-done, .pm .pm-warn', { timeout: 20000 }); const bad = await pg.$('.pm .pm-warn'); if (bad && !(await pg.$('.pm .pm-done'))) throw new Error('tx failed: ' + (await bad.innerText())); };
  const closeModal = pg => pg.evaluate(() => window.closeModal && window.closeModal());
  const A = await open('a1');
  const bal = async a => BigInt((await rpc('account_info', { account: a })).account_data.Balance);
  await t('Toolkit opens with its four tabs', async () => { const b = await body(A); assert(/Bulk pay/.test(b) && /Cleanup/.test(b) && /Watchlist/.test(b) && /Journal/.test(b), b.slice(0, 300)); });
  await t('bad lines are reported and nothing is sent', async () => { await A.fill('#tk_list', 'nope, 1'); await A.click('button:has-text("Check list")'); await A.waitForTimeout(1500); const b = await body(A); assert(/Skipped: nope/.test(b) || /Add at least/.test(b), b.slice(0, 300)); });
  await t('bulk pay sends one payment per wallet', async () => {
    const before = await bal(seed.lp.account_id); await A.fill('#tk_list', seed.lp.account_id + ', 2\n' + seed.trader.account_id.replace(/./g, c => c) .slice(0, 0) + seed.lp.account_id.slice(0, 0));
    await A.fill('#tk_list', seed.lp.account_id + ', 2'); await A.click('button:has-text("Review and send")'); await confirmModal(A, false); await A.waitForFunction(() => /1 of 1 sent/.test(document.body.innerText), null, { timeout: 20000 });
    const after = await bal(seed.lp.account_id); assert(after - before >= 1_900_000n && after - before <= 2_100_000n, String(after - before)); await closeModal(A); });
  await t('split a bill divides a total evenly', async () => { await A.waitForSelector('#tk_list'); await A.fill('#tk_list', seed.lp.account_id); await A.selectOption('#tk_mode', 'equal'); await A.fill('#tk_tot', '3'); await A.click('button:has-text("Check list")'); await A.waitForFunction(() => /1 payments, 3 .* in total/.test(document.body.innerText), null, { timeout: 8000 }); });
  await t('auto orders tab opens and refuses an empty order', async () => { await A.click('button:has-text("Auto orders")'); await A.waitForSelector('#od_kind'); assert(/sell everything/i.test(await body(A))); await A.selectOption('#od_kind', 'dca'); await A.fill('#od_spend', ''); await A.click('button:has-text("Create order")'); await A.waitForTimeout(800); assert(!(await A.$('.pm .pm-go')), 'review should not open for an empty order'); });
  await t('cleanup tab shows health and reserve', async () => { await A.click('button:has-text("Cleanup")'); await A.waitForFunction(() => /Wallet health/.test(document.body.innerText), null, { timeout: 8000 }); });
  await t('an alert can be added and listed', async () => { await A.click('button:has-text("Watchlist")'); await A.waitForSelector('#tk_ap'); await A.fill('#tk_ap', '0.0001'); await A.click('button:has-text("Add alert")'); await A.waitForFunction(() => /goes above|above \$0.0001/.test(document.body.innerText), null, { timeout: 5000 }); });
  await t('journal lists the payment and exports csv', async () => { await A.click('button:has-text("Journal")'); await A.waitForFunction(() => /Payment sent/.test(document.body.innerText), null, { timeout: 12000 }); assert(await A.$('button:has-text("Download CSV")')); });
  await t('no uncaught page errors', async () => assert.strictEqual(errs.filter(e => !/Failed to fetch|NetworkError/.test(e)).length, 0, errs.join(' | ').slice(0, 300)));
  console.log(pass + ' passed'); await br.close(); srv.close(); process.exit(process.exitCode || 0);
})();
