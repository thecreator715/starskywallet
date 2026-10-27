// "Run a node": ask the network's control panel (through the tunnel) to approve a supporting node, then give the person the command.
const $ = (id: string) => document.getElementById(id) as any;
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const H = { 'ngrok-skip-browser-warning': '1' };
let NET: any = null, REQ: any = null, timer: any = 0, which: 'main' | 'test' = 'main';
const KEY = 'starsky.runnode';
function base(t: 'main' | 'test'): string {
  const c = (window as any).STARSKY_CONFIG || {};
  let u = String((c[t] || c.main || {}).url || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
  if (t === 'test') u = u.replace(/\/test$/, '');
  else u = u.replace(/\/test$/, '');
  return u + '/panel/' + t;
}
async function api(path: string, body?: any) {
  const r = await fetch(base(which) + path, body ? { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: H });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || 'The control panel did not answer (' + r.status + ')');
  return j;
}
const msg = (t: string, bad = false) => { const e = $('rn_msg'); if (e) { e.textContent = t; e.style.color = bad ? '#ff6b6b' : ''; } };
export function shell() {
  return `<div id="rn"><div class="card"><div class="k">Run a node for LUMA</div>
  <p class="mut" style="font-size:.85rem;margin:.4rem 0">Set up a supporting node: it syncs and relays the ledger and serves your own RPC and WebSocket, but does not validate. Request to join here, the network operator approves it in the control panel, and then you get one command to run.</p>
  <div class="row" style="gap:.5rem;flex-wrap:wrap"><select id="rn_net" onchange="window.rn.pick()"><option value="main">Mainnet</option><option value="test">Testnet</option></select>
  <select id="rn_role" disabled><option value="api">Supporting node (partial, light)</option></select>
  <input id="rn_name" class="grow" placeholder="Name your node (e.g. Sam's laptop)"></div>
  <div class="row" style="gap:.5rem;flex-wrap:wrap;margin-top:.5rem"><input id="rn_host" class="grow" placeholder="Your public address (optional, for peers to reach you)"><input id="rn_reward" class="grow" placeholder="Address for rewards (optional, L… / T…)"></div>
  <label style="display:flex;gap:.5rem;align-items:center;margin-top:.7rem;font-size:.85rem"><input type="checkbox" id="rn_close" checked style="width:auto"> Close any previously running LUMA nodes on that computer first</label>
  <div style="margin-top:.7rem"><button class="pri acc" onclick="window.rn.request(this)">Request to join</button> <button onclick="window.rn.check()">Check approval</button></div>
  <div id="rn_msg" class="mut" style="font-size:.85rem;margin-top:.5rem"></div></div>
  <div class="card" id="rn_out" style="margin-top:1rem;display:none"></div></div>`;
}
export function mount() {
  try { REQ = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { REQ = null; }
  if (REQ) { which = REQ.net; if ($('rn_net')) $('rn_net').value = which; if ($('rn_name')) $('rn_name').value = REQ.name || ''; }
  pick(true);
  clearInterval(timer);
  timer = setInterval(() => { if (!$('rn')) return clearInterval(timer); if (REQ && REQ.status !== 'approved') check(true); }, 15000);
}
export function unmount() { clearInterval(timer); }
async function pick(keep = false) {
  which = ($('rn_net') || { value: 'main' }).value;
  NET = null;
  try { NET = await api('/api/public/network'); msg(NET.allowJoin === false ? 'This network is not accepting new nodes right now.' : 'Connected to the ' + (NET.label || 'LUMA') + ' control panel.'); }
  catch (e: any) { msg('Could not reach the control panel: ' + e.message + '. The operator\'s tunnel may need updating.', true); }
  if (REQ && REQ.net === which) check(true);
}
async function request(b: HTMLButtonElement) {
  const name = $('rn_name').value.trim(); if (!name) return msg('Give your node a name first.', true);
  b.disabled = true;
  try {
    const r = await api('/api/public/request', { label: name, role: 'api', host: $('rn_host').value.trim(), pubkey: '', rewardAddress: $('rn_reward').value.trim() });
    REQ = { id: r.id, net: which, name, role: 'api', status: r.status };
    localStorage.setItem(KEY, JSON.stringify(REQ));
    msg(r.status === 'approved' ? 'Approved.' : 'Request sent. Waiting for the operator to approve it in the control panel.');
    render();
  } catch (e: any) { msg(e.message, true); } finally { b.disabled = false; }
}
async function check(quiet = false) {
  if (!REQ) return quiet || msg('Nothing requested yet.', true);
  try {
    const s = await api('/api/public/node-status?id=' + encodeURIComponent(REQ.id));
    REQ.status = s.status; localStorage.setItem(KEY, JSON.stringify(REQ));
    if (!NET) NET = await api('/api/public/network');
    quiet || msg(s.status === 'approved' ? 'Approved.' : 'Status: ' + s.status);
    render();
  } catch (e: any) { quiet || msg(e.message, true); }
}
function script(close = true): string {
  const n = NET, hist = REQ.role === 'history', nm = 'luma-node-' + String(REQ.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const peer = (n.host || 'OPERATOR_HOST') + ' ' + n.peerPort, ws = n.wsPort || 6006, rpc = n.rpcPort || 5006;
  const cfg = `[server]\nport_rpc_admin_local\nport_rpc_public\nport_peer\nport_ws_public\n\n[port_rpc_admin_local]\nport = 5005\nip = 127.0.0.1\nadmin = 127.0.0.1\nprotocol = http\n\n[port_rpc_public]\nport = 5006\nip = 0.0.0.0\nprotocol = http\n\n[port_ws_public]\nport = 6006\nip = 0.0.0.0\nprotocol = ws\n\n[port_peer]\nport = 51235\nip = 0.0.0.0\nprotocol = peer\n\n[node_size]\n${hist ? 'huge' : 'medium'}\n\n[node_db]\ntype=NuDB\npath=/var/lib/rippled/db/nudb\n${hist ? '' : 'online_delete=2000\nadvisory_delete=0\n'}\n[database_path]\n/var/lib/rippled/db\n\n[debug_logfile]\n/var/log/rippled/debug.log\n\n[network_id]\n${n.networkId}\n\n[voting]\nreference_fee = ${n.feeDrops}\naccount_reserve = ${n.reserveDrops}\nowner_reserve = ${Math.round(n.reserveDrops / 5)}\n\n[ledger_history]\n${hist ? 'full' : '256'}\n\n[fetch_depth]\n${hist ? 'full' : '256'}\n\n[peer_private]\n0\n\n[validators_file]\n/config/validators.txt\n\n[ips_fixed]\n${peer}\n`;
  return `#!/usr/bin/env bash
set -e
command -v docker >/dev/null || { echo "Install Docker first: https://docker.com"; exit 1; }
docker image inspect "${n.image}" >/dev/null 2>&1 || { echo "Load the node image first:  docker load < luma-node-image.tar  (ask the operator for it)"; exit 1; }
mkdir -p "$HOME/${nm}" && cd "$HOME/${nm}"
cat > rippled.cfg <<'CFG_EOF'
${cfg}CFG_EOF
cat > validators.txt <<'VAL_EOF'
${(n.validators || '').trim()}
VAL_EOF
${close ? `# close previously running LUMA nodes first\nfor c in $(docker ps -aq --filter "name=luma-node-"); do docker rm -f "$c" >/dev/null 2>&1 || true; done\n` : ''}docker rm -f ${nm} 2>/dev/null || true
docker run -d --name ${nm} --restart unless-stopped -e LUMA_JOIN=1 \\
  -p ${n.peerPort}:51235 -p ${ws}:6006 -p ${rpc}:5006 \\
  -v "$PWD/rippled.cfg:/config/rippled.cfg:ro" -v "$PWD/validators.txt:/config/validators.txt:ro" \\
  -v ${nm}-data:/var/lib/rippled "${n.image}"
echo "Started. Watch it:  docker logs -f ${nm}"
`;
}
function render() {
  const o = $('rn_out'); if (!o || !REQ) return;
  o.style.display = 'block';
  if (REQ.status !== 'approved') {
    o.innerHTML = `<div class="k">Your request</div><p style="margin:.4rem 0"><b>${esc(REQ.name)}</b> · ${esc(REQ.role)} · ${esc(REQ.net)}</p><p class="mut">Status: <b>${esc(REQ.status)}</b>. This page checks again by itself. Once the operator approves it, your command appears here.</p>`;
    return;
  }
  if (!NET) { o.innerHTML = '<p class="mut">Loading network details…</p>'; return; }
  const sh = script(((($('rn_close') || {}) as any).checked) !== false); (window as any)._rnsh = sh;
  o.innerHTML = `<div class="k">Approved: run this on the computer that will host the node</div>
  <p class="mut" style="font-size:.85rem;margin:.4rem 0">Paste into a terminal (Mac, Linux, or WSL). It writes the config and starts the node in Docker. First time only, load the node image the operator gives you: <code>docker load &lt; luma-node-image.tar</code>.</p>
  <pre style="white-space:pre-wrap;word-break:break-all;max-height:18rem;overflow:auto;font-size:.72rem">${esc(sh)}</pre>
  <button class="pri acc" onclick="window.rn.copy()">Copy command</button> <button onclick="window.rn.download()">Download file</button>
  <p class="mut" style="font-size:.85rem;margin-top:.5rem">When <code>docker logs</code> shows it is synced (state full), your node is live at ws://localhost:${esc(NET.wsPort || 6006)}.</p>`;
}
(window as any).rn = {
  pick, request, check,
  copy: () => navigator.clipboard.writeText((window as any)._rnsh).then(() => msg('Copied.')),
  download: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([(window as any)._rnsh], { type: 'text/plain' })); a.download = 'start-luma-node.command'; a.click(); },
};
