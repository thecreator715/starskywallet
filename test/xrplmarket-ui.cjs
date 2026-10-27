// Browser test: Starsky XRPL wallet tab: tokens, NFT mint with the 0.05 XRP fee, free listing, buying with no sale fee. Against simulated chains.
// usage: node xrplmarket-ui.cjs <panelPort> <token> <xrplRpc> <lumaRpc> <xrplWs> <lumaWs>
const [PORT, TOKEN, XPORT, LPORT, XWS, LWS] = process.argv.slice(2); const X = require('xrpl'); const { chromium } = require('playwright'); const { webcrypto: C } = require('crypto');
const sleep = ms => new Promise(r => setTimeout(r, ms)), b64 = u => Buffer.from(u).toString('base64');
let pass = 0, fail = 0; const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  -> ' + String(d).slice(0, 500)}`); };
const rpcAt = port => async (m, p = {}) => { const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ method: m, params: [p] }) }); return (await r.json()).result; };
const xr = rpcAt(XPORT), lr = rpcAt(LPORT); const FEE = 'rphatRpwXcPAo7CVm46dC78JAQ6kLMqb2M';
const call = async (path, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { 'content-type': 'application/json', 'x-panel-token': TOKEN }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const bal = async a => { const r = await xr('account_info', { account: a }); return r.account_data ? +r.account_data.Balance / 1e6 : 0; };
(async () => {
  const gen = await xr('wallet_propose', { passphrase: 'xrpl-genesis-pass' }); const fundX = async (d, n) => xr('submit', { secret: gen.master_seed, tx_json: { TransactionType: 'Payment', Account: gen.account_id, Destination: d, Amount: String(n * 1e6) } });
  const minter = X.Wallet.generate(), buyer = X.Wallet.generate(); await fundX(FEE, 20); await fundX(minter.classicAddress, 300); await fundX(buyer.classicAddress, 300); await sleep(2800);
  await call('/api/bridge/config', 'POST', { url: `http://127.0.0.1:${XPORT}` });
  const fee0 = await bal(FEE);
  const salt = C.getRandomValues(new Uint8Array(16)), iv = C.getRandomValues(new Uint8Array(12)); const km = await C.subtle.importKey('raw', Buffer.from('testpass123'), 'PBKDF2', false, ['deriveKey']);
  const key = await C.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const lum = X.Wallet.generate();
  const data = { accounts: [{ id: 'a1', label: 'Luma', seed: lum.seed, address: lum.classicAddress, type: 'luma' }, { id: 'x1', label: 'Minter', seed: minter.seed, address: minter.classicAddress, type: 'xrpl' }, { id: 'x2', label: 'Buyer', seed: buyer.seed, address: buyer.classicAddress, type: 'xrpl' }] };
  const ct = new Uint8Array(await C.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(JSON.stringify(data)))); const vault = JSON.stringify({ v: 1, iter: 250000, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
  const bcfg = { lumaVault: '', xrplVault: '', xrplUrl: XWS, xrplIssuer: '', opUrl: `http://127.0.0.1:${PORT}` };
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] }); const pg = await br.newPage({ viewport: { width: 1500, height: 1100 } }); const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 300))); pg.on('dialog', d => d.accept());
  await pg.addInitScript(([v, cfg, bc]) => { if (!localStorage.getItem('starsky.vault')) { localStorage.setItem('starsky.vault', v); localStorage.setItem('starsky.cfg', cfg); localStorage.setItem('starsky.bridge.main', bc); } }, [vault, JSON.stringify({ net: 'main', urls: { main: LWS, test: LWS } }), JSON.stringify(bcfg)]);
  await pg.goto('http://127.0.0.1:4173/'); await pg.fill('#pw', 'testpass123'); await pg.press('#pw', 'Enter'); await pg.waitForTimeout(3500);
  const txt = id => pg.evaluate(i => (document.getElementById(i) || { innerText: '' }).innerText, id);
  await pg.evaluate(() => window.setWalletMode('xrpl')); await pg.waitForTimeout(500); await pg.evaluate(() => window.switchAcct('x1')); await pg.waitForTimeout(3500);
  await pg.evaluate(() => window.goTab('home')); await pg.waitForTimeout(5000);
  const home = await pg.evaluate(() => document.body.innerText); const pa = await txt('pa'); require('fs').writeFileSync('/tmp/claude-0/xm_home.txt', home);
  check('XRPL tab: balance is the XRPL wallet\'s XRP (not LUMA)', /300(\.0+)?\s*XRP|299\.\d+\s*XRP/.test(home), home.slice(0, 300));
  check('XRPL tab: tokens list XRP, RLUSD, MINT and MAGIC', /XRP/.test(pa) && /RLUSD/.test(pa) && /MINT/.test(pa) && /MAGIC/.test(pa) && /add trust line/i.test(pa), pa.slice(0, 400));
  await pg.screenshot({ path: __dirname + '/s_xrpl_tokens.png', fullPage: true });
  // --- mint two NFTs through the studio
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), require('crypto').randomBytes(600)]);
  await pg.evaluate(() => window.goTab('nfts')); await pg.waitForTimeout(3000); await pg.evaluate(() => window.nm.mint()); await pg.waitForTimeout(600);
  if (!(await pg.$('#ns_f'))) { console.log('NO STUDIO', errs.join(' | '), (await pg.evaluate(() => (document.getElementById('modal') || {}).innerText || 'nomodal')).slice(0, 300)); }
  await pg.setInputFiles('#ns_f', [{ name: 'a.png', mimeType: 'image/png', buffer: png }, { name: 'b.png', mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.from('x')]) }]);
  await pg.fill('#ns_c', 'XRPL Cards'); await pg.click('#ns_go');
  let owned = []; for (let i = 0; i < 40 && owned.length < 2; i++) { await pg.waitForTimeout(1500); owned = ((await xr('account_nfts', { account: minter.classicAddress })).account_nfts || []); }
  check('two NFTs were minted on the XRPL ledger', owned.length === 2, JSON.stringify(owned.length) + ' ' + (await txt('ns_msg')));
  await sleep(1500); const fee1 = await bal(FEE);
  check('the fee wallet received exactly 0.05 XRP per mint (0.10 XRP)', Math.abs(fee1 - fee0 - 0.1) < 1e-6, `${fee0} -> ${fee1}`);
  const ftx = ((await xr('account_tx', { account: FEE, limit: 50 })).transactions || []).filter(t => (t.tx || t.tx_json).Memos); check('each fee payment carries the marketplace memo', ftx.length >= 2 && ftx.every(t => Buffer.from((t.tx || t.tx_json).Memos[0].Memo.MemoType, 'hex').toString() === 'starsky/mint'), ftx.length);
  await pg.evaluate(() => window.goTab('nfts')); await pg.waitForTimeout(6000);
  const ids = await pg.evaluate(() => [...document.querySelectorAll('#mn_owned .nfcard')].map(e => e.getAttribute('onclick'))); check('My NFTs shows both (read from the XRPL node)', ids.length === 2, ids.length);
  await pg.screenshot({ path: __dirname + '/s_xrpl_mynfts.png', fullPage: true });
  // --- list one for 3 XRP (free), switch to the buyer and buy it
  const id = /'(.+)'/.exec(ids[0])[1]; const sellerBefore = await bal(minter.classicAddress); const buyerBefore = await bal(buyer.classicAddress);
  await pg.evaluate(id => window.nm.list(id), id); await pg.waitForTimeout(400); await pg.fill('#nl_p', '3'); await pg.click('#modal button.pri.acc'); await pg.waitForTimeout(6000);
  const so = await xr('nft_sell_offers', { nft_id: id }); check('listing created a sell offer for 3 XRP', so.offers && so.offers[0] && so.offers[0].amount === '3000000', JSON.stringify(so));
  await pg.evaluate(() => window.switchAcct('x2')); await pg.waitForTimeout(2500); await pg.evaluate(() => window.goTab('nftmarket')); await pg.waitForTimeout(9000);
  const mk = await pg.evaluate(() => document.body.innerText); require('fs').writeFileSync('/tmp/claude-0/xm_market.txt', mk);
  check('marketplace shows the minted NFT with its price in XRP', /XRPL Card/.test(mk) && /3\s*XRP/.test(mk), mk.slice(0, 400)); await pg.screenshot({ path: __dirname + '/s_xrpl_market.png', fullPage: true });
  await pg.click('#nm_list button:has-text("Buy")'); await pg.waitForTimeout(9000);
  const nowOwned = ((await xr('account_nfts', { account: buyer.classicAddress })).account_nfts || []); check('the buyer owns the NFT after Buy now', nowOwned.some(n => n.NFTokenID === id), JSON.stringify(nowOwned.map(n => n.NFTokenID.slice(0, 8))));
  const sellerAfter = await bal(minter.classicAddress); check('the seller received the full 3 XRP (no sale fee)', Math.abs(sellerAfter - sellerBefore - 3) < 0.01, `${sellerBefore} -> ${sellerAfter}`);
  check('minted with no royalty (no sale fee of any kind)', ((await xr('account_nfts', { account: buyer.classicAddress })).account_nfts || []).every(n => n.TransferFee === 0 || n.TransferFee == null), JSON.stringify(nowOwned.map(n => n.TransferFee)));
  await sleep(1200); check('the fee wallet earned nothing from the sale', Math.abs(await bal(FEE) - fee1) < 1e-6, `${fee1} -> ${await bal(FEE)}`);
  await pg.evaluate(() => window.setWalletMode('luma')); await pg.waitForTimeout(3000); await pg.evaluate(() => window.goTab('home')); await pg.waitForTimeout(3000);
  const lh = await pg.evaluate(() => document.body.innerText); check('switching back to the LUMA tab shows the LUMA network again', /LUMA Network/i.test(lh), lh.slice(0, 200));
  // --- the control panel's XRPL tab for the same NFTs
  const pp = await br.newPage({ viewport: { width: 1500, height: 1300 } }); const perrs = []; pp.on('pageerror', e => perrs.push(String(e).slice(0, 300))); pp.on('dialog', d => d.accept());
  await pp.goto(`http://127.0.0.1:${PORT}/#token=${TOKEN}`); await pp.waitForTimeout(2500); await pp.evaluate(() => { try { sessionStorage.setItem('lumaWizDismiss', '1') } catch {} }); await pp.evaluate(() => go('ipfs')); await pp.waitForTimeout(3500);
  check('panel NFT view has LUMA and XRPL tabs', await pp.evaluate(() => !!document.querySelector('#xntabs button[data-k=xrpl]')));
  await pp.evaluate(() => xnTab('xrpl')); await pp.waitForTimeout(9000); const xt = await pp.evaluate(() => (document.getElementById('xnbody') || {}).innerText || '');
  require('fs').writeFileSync('/tmp/claude-0/xm_panel.txt', xt);
  check('panel XRPL tab lists both Starsky-minted NFTs and the 0.05 XRP fee rule', /XRPL NFTs\s*2/i.test(xt) && /XRPL Card/.test(xt) && /0\.05 XRP/.test(xt) && /no sale fee/i.test(xt), xt.slice(0, 400));
  await pp.evaluate(a => { document.getElementById('xna').value = a; return xnAcct(); }, buyer.classicAddress); await pp.waitForTimeout(3500); const xa = await pp.evaluate(() => (document.getElementById('xnbody') || {}).innerText || '');
  check('panel XRPL tab shows any address\'s NFTs (the buyer now holds one)', /held by/i.test(xa) && /XRPL Card/.test(xa), xa.slice(0, 300));
  { await pg.evaluate(() => { window.setWalletMode('xrpl'); window.goTab('nftmarket'); }); await pg.waitForTimeout(4000); await pg.evaluate(() => window.nm.view('list')); await pg.waitForTimeout(800);
    const m0 = await pg.evaluate(() => { const t = document.querySelector('#nm_list table.nmtab'); return t ? { rows: t.querySelectorAll('tbody tr').length, th: t.querySelectorAll('thead th').length, td: t.querySelector('tbody tr') ? t.querySelector('tbody tr').children.length : 0, fixed: getComputedStyle(t).tableLayout } : null; });
    await pg.dblclick('#nm_list th.srt >> text=Name'); await pg.waitForTimeout(500); const m1 = await pg.evaluate(() => document.querySelector('#nm_list th.srt').parentElement.innerText);
    await pg.fill('#nm_q', 'zzzz-no-such'); await pg.waitForTimeout(500); const none = await pg.evaluate(() => document.querySelectorAll('#nm_list table.nmtab tbody tr.clk').length); await pg.fill('#nm_q', ''); await pg.waitForTimeout(400);
    await pg.selectOption('select[title="Status"]', 'listed'); await pg.waitForTimeout(500); const listed = await pg.evaluate(() => document.querySelectorAll('#nm_list table.nmtab tbody tr.clk').length); await pg.evaluate(() => window.nm.reset());
    check('NFT marketplace list view: aligned fixed columns, search, status filter, double-click heading to sort', m0 && m0.fixed === 'fixed' && m0.th === m0.td && m0.rows >= 1 && /▲|▼/.test(m1) && none === 0 && listed <= m0.rows, JSON.stringify([m0, m1.slice(0, 80), none, listed])); await pg.evaluate(() => window.setWalletMode('luma')); await pg.waitForTimeout(800); }
  { await pg.evaluate(() => { window.setWalletMode('xrpl'); window.goTab('dex'); }); await pg.waitForTimeout(1500);
    const dx = await pg.evaluate(() => ({ pill: (document.querySelector('.pill') || {}).textContent || '', body: document.body.innerText })); await pg.evaluate(() => { window.setWalletMode('xrpl'); window.goTab('home'); }); await pg.waitForTimeout(1200); const hp = await pg.evaluate(() => (document.querySelector('.pill') || {}).textContent || '');
    check('XRPL wallet mode: header says XRP Ledger and LUMA-only pages do not show LUMA data', /XRP Ledger/.test(hp) && /LUMA network only/i.test(dx.body), JSON.stringify([hp, dx.pill, dx.body.slice(0, 120)])); await pg.evaluate(() => window.setWalletMode('luma')); await pg.waitForTimeout(800); }
  { const fm = await pg.evaluate(async () => { const f = window.__flowModal({ title: 'Bridging MINT → MINT', rows: [['You send', '5 MINT on XRP Ledger'], ['You receive about', '4.99 MINT on LUMA']], steps: ['Sign', 'Validated', 'Bridge pays out', 'Arrives'] }); f.step(0, 'ok'); f.step(1, 'run', 'abc'); await new Promise(r => setTimeout(r, 1300)); const m = document.getElementById('brflow'); const t1 = document.getElementById('brf_t').textContent; f.done('Done'); const r = { has: !!m, text: m && m.innerText, t1, ok: document.getElementById('brf_i0').textContent }; document.getElementById('brf_x').click(); r.gone = !document.getElementById('brflow'); return r; });
    check('bridge progress popup shows timer, steps, amounts and networks, then closes', fm.has && /Bridging MINT/.test(fm.text) && /4\.99 MINT on LUMA/.test(fm.text) && fm.ok === '✓' && fm.t1 !== '0:00' && fm.gone, JSON.stringify(fm).slice(0, 300)); }
  await pp.screenshot({ path: __dirname + '/s_panel_xrplnfts.png', fullPage: true }); check('no panel page errors', perrs.length === 0, perrs.join(' | '));
  check('no page errors', errs.length === 0, errs.join(' | ')); await br.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL  crashed: ' + e.stack); process.exit(1); });
