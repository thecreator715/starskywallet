const { chromium } = require('playwright');
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const pg = await br.newPage({ viewport: { width: 1500, height: 1000 } }); pg.on('pageerror', e => console.log('PAGEERR', String(e).slice(0, 300))); pg.on('dialog', d => d.accept('REVEAL'));
  await pg.goto('http://127.0.0.1:8099/'); await pg.waitForTimeout(800);
  await pg.waitForTimeout(1500);
  for (const t of ['amm', 'tokens', 'wallets']) { await pg.evaluate(t => window.go(t), t); await pg.waitForTimeout(7000); await pg.screenshot({ path: __dirname + `/s_p_${t}.png`, fullPage: true }); }
  await pg.evaluate(() => window.go('amm')); await pg.waitForTimeout(5000);
  console.log('amx cards', await pg.evaluate(() => document.querySelectorAll('#amx .card').length));
  await pg.evaluate(() => { const b = [...document.querySelectorAll('#amx button')].find(x => x.textContent === 'Swap'); b && b.click(); }); await pg.waitForTimeout(600);
  await pg.fill('#ax_a', '5'); await pg.waitForTimeout(300); console.log('swap preview', await pg.evaluate(() => document.getElementById('ax_pv').innerText));
  await pg.screenshot({ path: __dirname + '/s_p_swap.png' });
  await br.close();
})();
