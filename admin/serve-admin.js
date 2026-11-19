// Starsky, admin edition: serves ../index.html on this machine with the LOCAL LUMA nodes and control panels preset
// (Mainnet ws 6006 / panel 8090, Testnet ws 6106 / panel 8091). Plain Node, no packages. Listens on 127.0.0.1 only.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = +process.env.STARSKY_PORT || 8096;
const CFG = { default: process.env.STARSKY_NET || 'main',
  main: { url: 'ws://127.0.0.1:6006', rpc: 'http://127.0.0.1:5006', panel: 'http://127.0.0.1:8090' },
  test: { url: 'ws://127.0.0.1:6106', rpc: 'http://127.0.0.1:5106', panel: 'http://127.0.0.1:8091' } };
const FILE = [path.join(__dirname, '..', 'index.html'), path.join(__dirname, 'index.html')].find(f => fs.existsSync(f));
http.createServer((req, res) => {
  if (!FILE || !/^\/(index\.html)?(\?.*)?$/.test(req.url)) { res.writeHead(404); return res.end('not found'); }
  const h = fs.readFileSync(FILE, 'utf8').replace(/window\.STARSKY_CONFIG\s*=\s*\{[\s\S]*?\n\s*\};/, () => 'window.STARSKY_CONFIG = ' + JSON.stringify(CFG) + ';');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(h);
}).listen(PORT, '127.0.0.1', () => console.log('Starsky (admin) on http://127.0.0.1:' + PORT));
