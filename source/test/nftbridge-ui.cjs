// Browser test: Starsky NFT bridge page against the REAL panel (nftbridge-api.js) + simulated chains. usage: node nftbridge-ui.cjs <panelPort> <token> <xrplRpc> <lumaRpc> <xrplWs> <lumaWs> <kuboPort> <webPort>
const [PORT, TOKEN, XPORT, LPORT, XWS, LWS, KPORT] = process.argv.slice(2); const X = require('xrpl'); const A = require('/tmp/nbui/lumanet/panel/addr'); const { chromium } = require('playwright'); const { webcrypto: C } = require('crypto'); const http = require('http'), crypto = require('crypto');
const sleep = ms => new Promise(r => setTimeout(r, ms)), b64 = u => Buffer.from(u).toString('base64');
let pass = 0, fail = 0; const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  -> ' + String(d).slice(0, 400)}`); };
const call = async (path, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { 'content-type': 'application/json', 'x-panel-token': TOKEN }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); return r.ok ? j : { ...j, status: r.status }; };
const rpcAt = port => async (m, p = {}) => { const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ method: m, params: [p] }) }); return (await r.json()).result; };
const xr = rpcAt(XPORT), lr = rpcAt(LPORT); const hexs = s => Buffer.from(s).toString('hex').toUpperCase();
async function userSend(rp, wallet, tx, netId) { const i = await rp('account_info', { account: wallet.classicAddress }); const full = { ...tx, Account: wallet.classicAddress, Sequence: i.account_data.Sequence, Fee: '10', ...(netId ? { NetworkID: netId } : {}) }; const s = wallet.sign(full), r = await rp('submit', { tx_blob: s.tx_blob }); if (r.engine_result !== 'tesSUCCESS') return { err: r.engine_result }; for (let k = 0; k < 20; k++) { await sleep(500); const t = await rp('tx', { transaction: s.hash }); if (t.validated) return { hash: s.hash, meta: t.meta }; } return { err: 'timeout' }; }
(async () => {
  const IMG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(4000)]);
  const web = http.createServer((q, s) => { if (q.url === '/n.png') { s.setHeader('content-type', 'image/png'); return s.end(IMG); } if (q.url === '/n.json') { s.setHeader('content-type', 'application/json'); return s.end(JSON.stringify({ name: 'Browser Star', description: 'from XRPL', image: `http://127.0.0.1:${web.address().port}/n.png`, attributes: [{ trait_type: 'Element', value: 'Water' }], collection: { name: 'Browser Set' } })); } s.statusCode = 404; s.end('x'); });
  await new Promise(r => web.listen(0, '127.0.0.1', r)); const W = `http://127.0.0.1:${web.address().port}`;
  // --- operator side
  const alice = (await call('/api/wallets/create', 'POST', { label: 'Alice' })).result, aliceSeed = (await call('/api/wallets/reveal', 'POST', { id: alice.id, confirm: 'REVEAL' })).seed, aliceR = A.toR(alice.address);
  await call('/api/token/create', 'POST', { name: 'XRPZ', supply: '1000000' });
  await call('/api/bridge/config', 'POST', { url: `http://127.0.0.1:${XPORT}` });
  const su = await call('/api/bridge/setup', 'POST', { confirm: 'SETUP', net: 'testnet' }); check('operator: bridge vaults set up', su.ok, JSON.stringify(su).slice(0, 200));
  const gen = await xr('wallet_propose', { passphrase: 'xrpl-genesis-pass' }); const fundX = async (d, n) => xr('submit', { secret: gen.master_seed, tx_json: { TransactionType: 'Payment', Account: gen.account_id, Destination: d, Amount: String(n * 1e6) } });
  await fundX(su.cfg.xrplVault, 500); await fundX(su.cfg.xrplIssuer, 50); const user = X.Wallet.generate(); await fundX(user.classicAddress, 300); await sleep(2500);
  await call('/api/bridge/prepare', 'POST', {}); const en = await call('/api/bridge/enable', 'POST', {}); check('operator: bridge enabled', en.ok);
  check('operator: NFT bridge on', (await call('/api/nftbridge/config', 'POST', { on: true, scanSec: 5 })).ok);
  const mint = await userSend(xr, user, { TransactionType: 'NFTokenMint', NFTokenTaxon: 3, Flags: 8, URI: hexs(W + '/n.json') }); const NID = mint.meta.nftoken_id;
  // --- Starsky vault: a LUMA wallet (Alice) and an XRPL wallet (the NFT's owner)
  const salt = C.getRandomValues(new Uint8Array(16)), iv = C.getRandomValues(new Uint8Array(12)); const km = await C.subtle.importKey('raw', Buffer.from('testpass123'), 'PBKDF2', false, ['deriveKey']);
  const key = await C.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const data = { accounts: [{ id: 'a1', label: 'Alice', seed: aliceSeed, address: aliceR, type: 'luma' }, { id: 'x1', label: 'XRPL Main', seed: user.seed, address: user.classicAddress, type: 'xrpl' }] };
  const ct = new Uint8Array(await C.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(JSON.stringify(data)))); const vault = JSON.stringify({ v: 1, iter: 250000, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
  const bcfg = { lumaVault: su.cfg.lumaVault ? A.toR(su.cfg.lumaVault) : '', xrplVault: su.cfg.xrplVault, xrplUrl: XWS, xrplIssuer: su.cfg.xrplIssuer, opUrl: `http://127.0.0.1:${PORT}` };
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] }); const pg = await br.newPage({ viewport: { width: 1500, height: 1100 } }); const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 300))); pg.on('dialog', d => d.accept());
  await pg.addInitScript(([v, cfg, bc]) => { if (!localStorage.getItem('starsky.vault')) { localStorage.setItem('starsky.vault', v); localStorage.setItem('starsky.cfg', cfg); localStorage.setItem('starsky.bridge.main', bc); } }, [vault, JSON.stringify({ net: 'main', urls: { main: LWS, test: LWS } }), JSON.stringify(bcfg)]);
  await pg.goto('http://127.0.0.1:4173/'); await pg.fill('#pw', 'testpass123'); await pg.press('#pw', 'Enter'); await pg.waitForTimeout(3500);
  await pg.evaluate(() => window.switchAcct('a1')); await pg.waitForTimeout(1500); await pg.evaluate(() => window.goTab('bridge')); await pg.waitForTimeout(6000);
  const txt = id => pg.evaluate(i => (document.getElementById(i) || { innerText: '' }).innerText, id);
  const val = await txt('br_val'); check('validator card shows the linked relayer', /LINKED/.test(val), val.slice(0, 200));
  { await pg.evaluate(() => window.brw.start()); await pg.waitForTimeout(400); const w0 = await txt('brwiz');
    await pg.evaluate(() => { window.brw.set('dir', 'out'); }); await pg.evaluate(() => window.brw.next()); await pg.waitForTimeout(300); const w1 = await txt('brwiz');
    await pg.evaluate(() => { window.brw.amt('5'); }); await pg.evaluate(() => window.brw.next()); await pg.waitForTimeout(300); const w2 = await txt('brwiz');
    await pg.evaluate(() => { window.brw.set('dst', 'rphatRpwXcPAo7CVm46dC78JAQ6kLMqb2M'); }); await pg.evaluate(() => window.brw.next()); await pg.waitForTimeout(300); await pg.evaluate(() => window.brw.next()); await pg.waitForTimeout(2500); const w4 = await txt('brwiz');
    check('bridge wizard walks through 5 steps and ends on a review with the estimate', /STEP 1 OF 5/i.test(w0) && /STEP 2 OF 5/i.test(w1) && /STEP 3 OF 5/i.test(w2) && /STEP 5 OF 5/i.test(w4) && /You receive about/i.test(w4), JSON.stringify([w0.slice(0, 80), w4.slice(0, 200)])); await pg.evaluate(() => window.brw.close()); }
  { await pg.evaluate(() => window.nbw.start()); await pg.waitForSelector('#nbwiz', { timeout: 8000 }).catch(() => {}); const n0 = await txt('nbwiz');
    await pg.evaluate(() => window.nbw.next()); await pg.waitForTimeout(400); const first = await pg.evaluate(() => { const r = document.querySelector('#nbwiz input[name=nwn]'); return r ? r.getAttribute('onchange').match(/'id','([^']+)'/)[1] : ''; }); const n1 = await txt('nbwiz');
    if (first) await pg.evaluate(i => window.nbw.set('id', i), first); await pg.evaluate(() => window.nbw.next()); await pg.waitForTimeout(300); const n2 = await txt('nbwiz'); await pg.evaluate(() => window.nbw.next()); await pg.waitForTimeout(2500); const n3 = await txt('nbwiz');
    check('NFT bridge wizard: direction, NFT, destination, check (5 steps)', /STEP 1 OF 5/i.test(n0) && /STEP 2 OF 5/i.test(n1) && !!first && /STEP 3 OF 5/i.test(n2) && /STEP 4 OF 5/i.test(n3) && /Ready to send|✗|NFT/i.test(n3), JSON.stringify([n0.slice(0, 60), n1.slice(0, 80), n3.slice(0, 160)])); await pg.evaluate(() => window.nbw.close()); }
  const nft = await txt('br_nft'); check('NFT card lists the XRPL wallet\'s NFT', nft.includes(NID.slice(0, 8)) || /Bridge to LUMA/.test(nft), nft.slice(0, 300));
  await pg.evaluate(id => window.br.nbEst('in', id), NID); await pg.waitForTimeout(2500); const est = await txt('br_nft'); require('fs').writeFileSync('/tmp/claude-0/nbui_est.txt', est);
  check('estimate shows name, collection, image copy and time', /browser star/i.test(est) && /browser set/i.test(est) && /copied/.test(est) && /Time: about/.test(est), est.slice(0, 500));
  await pg.screenshot({ path: __dirname + '/s_nftbridge_est.png', fullPage: true });
  await pg.evaluate(id => window.br.nbSend('in', id), NID); await pg.waitForTimeout(4000); console.log('MSG:', await txt('nb_msg'));
  let item = null; for (let i = 0; i < 40 && !(item && item.state === 'offered'); i++) { await sleep(1500); item = ((await call('/api/nftbridge/overview')).items || []).find(x => x.xrplId === NID); if (item && ['failed', 'needs-attention', 'rejected'].includes(item.state)) break; }
  check('the browser made the offer and the validator copied + minted it', item && item.state === 'offered', JSON.stringify(item && { s: item.state, e: item.err, ev: item.events.slice(-2) }));
  await pg.evaluate(() => window.br.nbLoad()); await pg.waitForTimeout(3000); await pg.screenshot({ path: __dirname + '/s_nftbridge_offered.png', fullPage: true });
  check('the activity list shows an Accept button', /Accept the copy/.test(await txt('br_nft')));
  await pg.evaluate(o => window.br.nbAccept(o), item.lumaOffer); await pg.waitForTimeout(4000);
  check('Alice holds the wrapped NFT after accepting in the browser', ((await lr('account_nfts', { account: aliceR })).account_nfts || []).some(n => n.NFTokenID === item.lumaId));
  await pg.evaluate(() => window.br.nbLoad()); await pg.waitForTimeout(3500); const lt = await txt('br_nft'); check('wrapped NFT shows in the LUMA → XRPL list with its name', /browser star/i.test(lt) && /Send back to XRPL/.test(lt), lt.slice(0, 400));
  await pg.evaluate(id => window.br.nbSend('out', id), item.lumaId); await pg.waitForTimeout(3000);
  let back = null; for (let i = 0; i < 40 && !(back && back.state === 'done'); i++) { await sleep(1500); back = ((await call('/api/nftbridge/overview')).items || []).find(x => x.dir === 'out'); if (back && back.state === 'failed') break; }
  check('the browser sent it back and the validator released the original', back && back.state === 'done', JSON.stringify(back && { s: back.state, e: back.err }));
  await pg.evaluate(() => window.br.nbLoad()); await pg.waitForTimeout(3000); check('the activity list shows Accept the original', /Accept the original/.test(await txt('br_nft')));
  await pg.evaluate(([o, a]) => window.br.nbAcceptX(o, a), [back.xrplOffer, user.classicAddress]); await pg.waitForTimeout(5000);
  check('the original is back with its owner on XRPL', ((await xr('account_nfts', { account: user.classicAddress })).account_nfts || []).some(n => n.NFTokenID === NID));
  await pg.evaluate(() => window.br.nbLoad()); await pg.waitForTimeout(2500); await pg.screenshot({ path: __dirname + '/s_nftbridge_done.png', fullPage: true });
  check('no page errors', errs.length === 0, errs.join(' | '));
  // --- the control panel's own Bridge page
  const pp = await br.newPage({ viewport: { width: 1500, height: 1200 } }); const perrs = []; pp.on('pageerror', e => perrs.push(String(e).slice(0, 300))); pp.on('dialog', d => d.accept());
  await pp.goto(`http://127.0.0.1:${PORT}/#token=${TOKEN}`); await pp.waitForTimeout(2500); await pp.evaluate(() => { try { sessionStorage.setItem('lumaWizDismiss', '1') } catch {} }); await pp.evaluate(() => go('bridge')); await pp.waitForTimeout(8000);
  const ptxt = await pp.evaluate(() => document.getElementById('main').innerText);
  require('fs').writeFileSync('/tmp/claude-0/ptxt.txt', ptxt); check('panel Bridge page shows the Starsky link card with vaults and MINT/MAGIC issuers, no LUMAX', /link starsky to this bridge/i.test(ptxt) && /MINT issuer on XRPL/.test(ptxt) && /rwCsCz93A1svS6Yv8hFqUeKLdTLhBpvqGD/.test(ptxt) && !/LUMAX/.test(ptxt), ptxt.slice(0, 300));
  check('panel Bridge page shows the NFT bridge card with the finished transfers', /NFT bridge/i.test(ptxt) && /Browser Star/.test(ptxt) && /XRPL → LUMA/.test(ptxt) && /LUMA → XRPL/.test(ptxt));
  await pp.screenshot({ path: __dirname + '/s_panel_nftbridge.png', fullPage: true }); check('no panel page errors', perrs.length === 0, perrs.join(' | '));
  { const xw0 = X.Wallet.generate(); const got = await pg.evaluate(async sd => { try { return await window.importXrplSeed(sd); } catch (e) { return 'ERR ' + e.message; } }, xw0.seed); const bad = await pg.evaluate(async () => { try { return await window.importXrplSeed('nope'); } catch (e) { return 'ERR'; } });
    check('an XRPL wallet can be added from the NFT bridge card by seed (bad seeds refused)', got === xw0.classicAddress && bad === 'ERR', JSON.stringify([got, bad])); }
  await br.close(); web.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL  crashed: ' + e.stack); process.exit(1); });
