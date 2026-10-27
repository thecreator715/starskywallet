const { chromium } = require('playwright'); const fs = require('fs'); const { webcrypto: C } = require('crypto');
const seed = JSON.parse(fs.readFileSync(__dirname + '/.run/seed-main.json')); const b64 = u => Buffer.from(u).toString('base64');
(async () => {
  const salt = C.getRandomValues(new Uint8Array(16)), iv = C.getRandomValues(new Uint8Array(12));
  const km = await C.subtle.importKey('raw', Buffer.from('testpass123'), 'PBKDF2', false, ['deriveKey']);
  const key = await C.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const data = { accounts: [{ id: 'a1', label: 'Trader', seed: seed.user.master_seed, address: seed.user.account_id, type: 'luma' }], active: 'a1' };
  const ct = new Uint8Array(await C.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(JSON.stringify(data))));
  const vault = JSON.stringify({ v: 1, iter: 250000, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const pg = await br.newPage({ viewport: { width: 1500, height: 1000 } }); pg.on('pageerror', e => console.log('PAGEERR', String(e).slice(0, 300))); pg.on('dialog', d => d.accept());
  await pg.addInitScript(([v]) => { if (!localStorage.getItem('starsky.vault')) { localStorage.setItem('starsky.vault', v); localStorage.setItem('starsky.cfg', JSON.stringify({ net: 'main', urls: { main: 'ws://127.0.0.1:6006' }, usd: {}, book: [], lockMin: 15 })); } }, [vault]);
  await pg.goto('http://127.0.0.1:4173/'); await pg.fill('#pw', 'testpass123'); await pg.press('#pw', 'Enter'); await pg.waitForTimeout(3500);
  await pg.evaluate(() => window.goTab('dex')); await pg.waitForTimeout(6000);
  await pg.evaluate(() => window.dx.setMode('margin')); await pg.waitForTimeout(2500);
  await pg.fill('#mg_coll', '20'); await pg.evaluate(() => window.mg.lev(10, true)); await pg.evaluate(() => window.mg.slp(3)); await pg.evaluate(() => window.mg.tpp(5)); await pg.waitForTimeout(800);
  console.log('lines', await pg.evaluate(() => [...document.querySelectorAll('.dxln')].map(g => g.getAttribute('data-id'))));
  await pg.screenshot({ path: __dirname + '/s_ln1.png' });
  // drag the stop-loss line down
  const hit = await pg.$('.dxhit[data-id="d:sl"]'); const bb = await hit.boundingBox();
  await pg.mouse.move(bb.x + 300, bb.y + bb.height / 2); await pg.mouse.down(); await pg.mouse.move(bb.x + 300, bb.y + bb.height / 2 + 25, { steps: 6 }); await pg.mouse.up(); await pg.waitForTimeout(600);
  console.log('SL after drag', await pg.inputValue('#mg_sl'));
  const hl = await pg.$('.dxhit[data-id="d:liq"]'); const lb = await hl.boundingBox();
  await pg.mouse.move(lb.x + 400, lb.y + lb.height / 2); await pg.mouse.down(); await pg.mouse.move(lb.x + 400, lb.y + lb.height / 2 - 40, { steps: 6 }); await pg.mouse.up(); await pg.waitForTimeout(600);
  console.log('lev after liq drag', await pg.evaluate(() => document.getElementById('mg_lv').textContent));
  await pg.screenshot({ path: __dirname + '/s_ln2.png' });
  // open and see lines for the position + drag TP
  await pg.click('#dx_trade .dxgo'); await pg.waitForTimeout(9000);
  await pg.evaluate(() => window.dx.setTab('positions')); await pg.waitForTimeout(2000);
  console.log('lines2', await pg.evaluate(() => [...document.querySelectorAll('.dxln')].map(g => g.getAttribute('data-id').slice(0, 8))));
  await pg.screenshot({ path: __dirname + '/s_ln3.png' });
  await br.close();
})();
