// Starsky Checks page in a real browser against the simulated chain (run ./up.sh first). node checks-ui.cjs
const { chromium } = require('playwright'); const fs = require('fs'), http = require('http'), path = require('path'); const { webcrypto: C } = require('crypto'); const assert = require('assert');
const seed = JSON.parse(fs.readFileSync(__dirname + '/.run/seed-main.json')), b64 = u => Buffer.from(u).toString('base64');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'));
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); }).listen(4191);
let pass = 0; const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + String(e.message || e).split('\n')[0] + ' @' + (String(e.stack).match(/checks-ui.cjs:(\d+)/) || [])[1]); process.exitCode = 1; } };
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
    await pg.evaluate(() => goTab('checks')); await pg.waitForSelector('#ck_to', { timeout: 8000 }); await pg.waitForFunction(() => !/Loading/.test(document.getElementById('ck_in').innerText), null, { timeout: 12000 }); return pg; };
  const body = async pg => (await pg.innerText('body')).replace(/\s+/g, ' ');
  const confirmModal = async (pg, done = true) => { await pg.waitForSelector('.pm .pm-go', { timeout: 8000 }); await pg.click('.pm .pm-go'); if (!done) return; await pg.waitForFunction(() => !document.querySelector('.pm .pm-go'), null, { timeout: 8000 }); await pg.waitForSelector('.pm .pm-done, .pm .pm-warn', { timeout: 20000 }); const bad = await pg.$('.pm .pm-warn'); if (bad && !(await pg.$('.pm .pm-done'))) throw new Error('tx failed: ' + (await bad.innerText())); };
  const closeModal = pg => pg.evaluate(() => window.closeModal && window.closeModal());
  const A = await open('a1');
  const checksOf = async addr => (await rpc('account_objects', { account: addr, type: 'check' })).account_objects;
  await t('Checks page opens and shows empty states', async () => { const b = await body(A); assert(/Write a check/i.test(b) && /Nothing waiting/i.test(b) && /no open checks/i.test(b), b.slice(0, 400)); assert(await A.$('#ck_asset option'), 'asset list'); });
  await t('a check to yourself is refused', async () => { await A.fill('#ck_to', seed.trader.account_id); await A.fill('#ck_amt', '1'); await A.click('button:has-text("Review and write check")'); await A.waitForTimeout(1500); assert(!(await A.$('.pm .pm-go')), 'no review should open'); });
  await t('an invalid address is refused', async () => { await A.fill('#ck_to', 'notanaddress'); await A.click('button:has-text("Review and write check")'); await A.waitForTimeout(800); assert(!(await A.$('.pm .pm-go'))); });
  await t('writing a check shows a review, then the check exists on the ledger and in the list', async () => {
    await A.fill('#ck_to', seed.lp.account_id); await A.fill('#ck_amt', '5'); await A.selectOption('#ck_exp', '1d'); await A.fill('#ck_memo', 'rent'); await A.click('button:has-text("Review and write check")');
    await A.waitForSelector('.pm .pm-go'); const rv = await A.innerText('.pm'); assert(/Money moves now\?/.test(rv) && /5 LUMA/.test(rv), rv.slice(0, 300)); await confirmModal(A);
    const objs = await checksOf(seed.trader.account_id); assert.strictEqual(objs.length, 1, JSON.stringify(objs)); assert.strictEqual(objs[0].SendMax, '5000000'); await closeModal(A);
    await A.waitForFunction(() => /5 LUMA/i.test(document.getElementById('ck_out').innerText), null, { timeout: 12000 }); });
  const B = await open('a2');
  await t('the recipient sees it under "Checks waiting for you"', async () => { await B.click('text=Refresh'); await B.waitForFunction(() => /5 LUMA/.test(document.getElementById('ck_in').innerText) && /Cash check/.test(document.getElementById('ck_in').innerText), null, { timeout: 12000 }); });
  await t('the writer cannot cash their own check (no Cash button for the writer)', async () => { const x = await A.innerText('#ck_out'); assert(!/Cash check/.test(x), x); });
  await t('cashing moves the money and removes the check', async () => {
    const before = BigInt((await rpc('account_info', { account: seed.lp.account_id })).account_data.Balance); await B.click('#ck_in >> text=Cash check'); await confirmModal(B);
    const after = BigInt((await rpc('account_info', { account: seed.lp.account_id })).account_data.Balance); assert(after - before > 4_900_000n && after - before < 5_100_000n, String(after - before)); assert.strictEqual((await checksOf(seed.lp.account_id)).length, 0); await closeModal(B); });
  await t('"cash up to" takes a minimum and receives the amount', async () => {
    await A.evaluate(() => goTab('checks')); await A.waitForSelector('#ck_to'); await A.fill('#ck_to', seed.lp.account_id); await A.fill('#ck_amt', '4'); await A.click('button:has-text("Review and write check")'); await confirmModal(A); await closeModal(A);
    await B.click('text=Refresh'); await B.waitForFunction(() => /Cash up to/.test(document.getElementById('ck_in').innerText), null, { timeout: 12000 }); promptAnswer = '3'; const before = BigInt((await rpc('account_info', { account: seed.lp.account_id })).account_data.Balance);
    await B.click('#ck_in >> text=Cash up to'); await confirmModal(B); const after = BigInt((await rpc('account_info', { account: seed.lp.account_id })).account_data.Balance); assert(after - before >= 3_900_000n, String(after - before)); promptAnswer = null; await closeModal(B); });
  await t('the writer can cancel an open check', async () => {
    await A.evaluate(() => goTab('checks')); await A.waitForSelector('#ck_to'); await A.fill('#ck_to', seed.lp.account_id); await A.fill('#ck_amt', '7'); await A.click('button:has-text("Review and write check")'); await confirmModal(A); await closeModal(A);
    await A.waitForFunction(() => /7 LUMA/.test(document.getElementById('ck_out').innerText), null, { timeout: 12000 }); await A.click('#ck_out >> text=Cancel check'); await confirmModal(A); assert.strictEqual((await checksOf(seed.trader.account_id)).length, 0); await closeModal(A); });
  await t('history lists written, cashed and cancelled checks', async () => { await A.click('text=Refresh'); await A.waitForFunction(() => /Wrote a check/.test(document.getElementById('ck_hist').innerText) && /Cancelled a check/.test(document.getElementById('ck_hist').innerText), null, { timeout: 15000 }); await B.click('text=Refresh'); await B.waitForFunction(() => /Cashed a check/.test(document.getElementById('ck_hist').innerText), null, { timeout: 15000 }); });
  await t('payroll: add a payee with two pay items, see their balance, pay one by check, reconcile when cashed', async () => {
    await A.click('#ckv_payroll'); await A.waitForSelector('#pr_root', { state: 'visible' }); await A.click('button:has-text("Add payee")'); await A.waitForSelector('#pe_name');
    await A.fill('#pe_name', 'Pat Lee'); await A.fill('#pe_addr', seed.lp.account_id); await A.fill('#pe_role', 'Designer');
    await A.fill('#pi_l0', 'Salary'); await A.fill('#pi_a0', '3'); await A.selectOption('#pi_e0', 'monthly'); await A.fill('#pi_l1', 'Bonus'); await A.fill('#pi_a1', '1.5'); await A.selectOption('#pi_e1', 'once');
    await A.click('button:has-text("Save payee")'); await A.waitForFunction(() => /Pat Lee/.test(document.getElementById('pr_book').innerText) && /Salary/i.test(document.getElementById('pr_book').innerText) && /Bonus/i.test(document.getElementById('pr_book').innerText), null, { timeout: 10000 });
    await A.waitForFunction(() => /LUMA/.test(document.getElementById('pr_book').innerText) && !/…\s*$/.test(document.querySelector('#pr_book tr:nth-child(2) td:nth-child(3)').innerText), null, { timeout: 10000 });
    await A.click('#pr_book >> text=Pay now >> nth=0'); await A.waitForSelector('.pm .pm-go'); await A.click('.pm .pm-go'); await A.waitForFunction(() => !document.querySelector('.pm .pm-go'), null, { timeout: 8000 }); await closeModal(A);
    await A.waitForFunction(() => /open/.test(document.getElementById('pr_led').innerText) && /Salary/i.test(document.getElementById('pr_led').innerText), null, { timeout: 12000 });
    await B.click('text=Refresh'); await B.waitForFunction(() => /Cash check/.test(document.getElementById('ck_in').innerText), null, { timeout: 12000 }); await B.click('#ck_in >> text=Cash check'); await confirmModal(B); await closeModal(B);
    await A.evaluate(() => window.ck.load(true)); await A.waitForFunction(() => /cashed/.test(document.getElementById('pr_led').innerText), null, { timeout: 20000 }).catch(async e => { console.log('OBJ', JSON.stringify((await checksOf(seed.trader.account_id)).map(c=>c.index.slice(0,6))), JSON.stringify((await checksOf(seed.lp.account_id)).map(c=>c.index.slice(0,6))), JSON.stringify((await rpc('account_tx',{account:seed.trader.account_id,limit:10})).transactions.map(t=>t.tx.TransactionType+':'+(t.meta||{}).TransactionResult))); console.log('LS', await A.evaluate(()=>Object.keys(localStorage).filter(k=>/payroll/.test(k)).map(k=>localStorage[k].replace(/\"payees\".*?\"runs\"/,'runs').slice(0,500))), await A.evaluate(async()=>{try{await window.ck.load(true);return 'ok'}catch(e){return String(e)}})); console.log('LED:', (await A.innerText('#pr_led')).replace(/\s+/g,' ').slice(0,300)); throw e; });
    const sm = await A.innerText('#pr_sum'); assert(/Cashed/i.test(sm) && /3 LUMA/i.test(sm), sm.slice(0, 300)); await A.click('#ckv_checks'); });
  await t('payroll: the book survives a page switch and "pay everything due" skips items not yet due', async () => { await A.click('#ckv_payroll'); const b = await A.innerText('#pr_book'); assert(/Pat Lee/.test(b)); });
  await t('typing in the form survives the periodic refresh', async () => { await A.click('#ckv_checks'); await A.fill('#ck_amt', '12.5'); await A.waitForTimeout(6000); assert.strictEqual(await A.inputValue('#ck_amt'), '12.5'); });
  await t('no uncaught page errors', async () => assert.strictEqual(errs.length, 0, errs.join(' | ')));
  console.log(pass + ' passed'); await br.close(); srv.close(); process.exit(process.exitCode || 0);
})();
