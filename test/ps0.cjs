const { chromium } = require('playwright');
(async () => { const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
 const pg = await br.newPage({ viewport: { width: 1300, height: 800 } }); pg.on('pageerror', e => console.log('PAGEERR', String(e).slice(0, 200)));
 await pg.goto('http://127.0.0.1:8099/'); await pg.waitForTimeout(2500); await pg.screenshot({ path: __dirname + '/s_p0.png' }); console.log((await pg.evaluate(() => document.body.innerText)).slice(0, 300)); await br.close(); })();
