// Tiny stand-in for a Kubo node: POST /api/v0/add and GET /ipfs/<cid>, with CORS. Test only.
const http = require('http'), crypto = require('crypto'); const store = new Map();
http.createServer((q, r) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  if (q.method === 'OPTIONS') { r.writeHead(204, cors); return r.end(); }
  if (q.method === 'POST' && q.url.startsWith('/api/v0/add')) {
    const ch = []; q.on('data', c => ch.push(c)); q.on('end', () => {
      const b = Buffer.concat(ch), head = b.indexOf('\r\n\r\n') + 4, tail = b.lastIndexOf('\r\n--'); const ct = (/content-type: ([^\r\n]+)/i.exec(b.slice(0, head).toString('latin1')) || [])[1] || 'application/octet-stream';
      const body = b.slice(head, tail), cid = 'bafy' + crypto.createHash('sha256').update(body).digest('hex').slice(0, 40); store.set(cid, { body, ct });
      r.writeHead(200, { ...cors, 'content-type': 'application/json' }); r.end(JSON.stringify({ Name: 'file', Hash: cid, Size: String(body.length) }) + '\n');
    }); return;
  }
  const m = /^\/ipfs\/([^/?]+)/.exec(q.url); const f = m && store.get(m[1]);
  if (!f) { r.writeHead(404, cors); return r.end('nf'); } r.writeHead(200, { ...cors, 'content-type': f.ct }); r.end(f.body);
}).listen(5001, '127.0.0.1').on('listening', () => console.log('fake ipfs 5001'));
http.createServer((q, r) => { const m = /^\/ipfs\/([^/?]+)/.exec(q.url); require('http').get('http://127.0.0.1:5001/ipfs/' + (m ? m[1] : ''), x => { r.writeHead(x.statusCode, { ...x.headers }); x.pipe(r); }); }).listen(8081, '127.0.0.1');
