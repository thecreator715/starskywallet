// Tiny static server for the built app (no dependencies). Usage: node serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = +(process.argv[2] || process.env.PORT || 8095);
const T = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
// NFT image storage: the browser talks to the same Kubo node the control panel runs (main API 5001, test API 5101) through this server.
const KUBO = { '/kubo/main/': 5001, '/kubo/test/': 5101 };
http.createServer((q, r) => {
  const kp = Object.keys(KUBO).find(k => q.url.startsWith(k));
  if (kp) {
    const sub = q.url.slice(kp.length - 1);
    if (q.method !== 'POST' || !/^\/api\/v0\/(add|id|version)(\?|$)/.test(sub)) { r.writeHead(403); return r.end('blocked'); }
    const u = http.request({ host: '127.0.0.1', port: KUBO[kp], path: sub, method: 'POST', headers: { 'content-type': q.headers['content-type'] || '', 'content-length': q.headers['content-length'] || '' } }, x => { r.writeHead(x.statusCode, { 'content-type': x.headers['content-type'] || 'application/json', 'cache-control': 'no-store' }); x.pipe(r); });
    u.on('error', () => { r.writeHead(502); r.end('the NFT storage node is not answering'); });
    return q.pipe(u);
  }
  let p = path.normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
  r.writeHead(200, { 'content-type': T[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(r);
}).listen(port, '127.0.0.1', () => console.log('Starsky running at http://127.0.0.1:' + port));
