// Share card for a closed leveraged trade: a 1200x675 PNG (the size X shows in full), shared to X or posted on LUMA Social.
import { ctx } from './ctx.ts';
import { ipfsAdd } from './nft.ts';
import { esc, fmt } from './util.ts';
import QRCode from 'qrcode';

export interface PnlData { market: string; long: boolean; lev: number; entry: string; exit: string; size: number; margin: number; pnl: number; roe: number; held: string; result: string; when: number; unit: string }
const rr = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); };
export async function drawPnl(d: PnlData): Promise<Blob> {
  const W = 1200, H = 675, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d') as CanvasRenderingContext2D, win = d.pnl >= 0, ac = win ? '#34f5a4' : '#ff5c6c', ac2 = win ? '#7c6cff' : '#ff9a4d';
  const F = '-apple-system, "SF Pro Display", Inter, "Segoe UI", Helvetica, Arial, sans-serif';
  let g: CanvasGradient = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#080b1a'); g.addColorStop(1, '#1b1244'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  for (const [x, y, r, col] of [[1050, 80, 520, ac2 + '55'], [120, 640, 480, ac + '33'], [980, 600, 380, ac + '22']] as const) { const rg = c.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, col); rg.addColorStop(1, 'transparent'); c.fillStyle = rg; c.fillRect(0, 0, W, H); }
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 90; i++) { c.fillStyle = `rgba(255,255,255,${(0.1 + rnd() * 0.4).toFixed(2)})`; c.beginPath(); c.arc(rnd() * W, rnd() * H, rnd() * 1.6 + 0.3, 0, 7); c.fill(); }
  // glass panel
  rr(c, 40, 40, W - 80, H - 80, 36); c.fillStyle = 'rgba(14,18,44,0.62)'; c.fill(); c.lineWidth = 2; g = c.createLinearGradient(40, 40, W, H); g.addColorStop(0, ac + 'aa'); g.addColorStop(1, ac2 + 'aa'); c.strokeStyle = g; c.stroke();
  // brand
  c.beginPath(); c.arc(100, 106, 15, 0, 7); c.fillStyle = '#62f2b4'; c.fill(); c.beginPath(); c.arc(100, 106, 27, 0, 7); c.lineWidth = 4; c.strokeStyle = '#8b7cff'; c.stroke();
  c.fillStyle = '#f2f4ff'; c.font = `800 30px ${F}`; c.textBaseline = 'middle'; c.fillText('STARSKY', 142, 98); c.fillStyle = '#9aa3d0'; c.font = `500 18px ${F}`; c.fillText('LUMA leverage trading', 142, 128);
  // result tag (right)
  const tag = d.result.toUpperCase(); c.font = `800 22px ${F}`; const tw = c.measureText(tag).width + 44; rr(c, W - 80 - tw, 78, tw, 48, 24); c.fillStyle = ac + '26'; c.fill(); c.strokeStyle = ac; c.lineWidth = 2; c.stroke(); c.fillStyle = ac; c.textAlign = 'center'; c.fillText(tag, W - 80 - tw / 2, 103); c.textAlign = 'left';
  // market + side
  c.fillStyle = '#ffffff'; c.font = `800 64px ${F}`; c.fillText(d.market, 80, 215);
  const side = `${d.long ? 'LONG' : 'SHORT'} ${d.lev}x`; c.font = `800 26px ${F}`; const sw = c.measureText(side).width + 36, mx = 80 + c.measureText('').width;
  c.font = `800 64px ${F}`; const mw = c.measureText(d.market).width; rr(c, 80 + mw + 24, 178, sw, 46, 23); c.fillStyle = d.long ? 'rgba(52,245,164,.2)' : 'rgba(255,92,108,.2)'; c.fill(); c.fillStyle = d.long ? '#34f5a4' : '#ff7a88'; c.font = `800 26px ${F}`; c.fillText(side, 80 + mw + 24 + 18, 202); void mx;
  // big ROE
  const roeTxt = (d.roe >= 0 ? '+' : '') + (d.roe * 100).toFixed(2) + '%'; g = c.createLinearGradient(80, 250, 700, 400); g.addColorStop(0, ac); g.addColorStop(1, win ? '#a99bff' : '#ffc27a'); c.fillStyle = g; c.font = `900 150px ${F}`; c.fillText(roeTxt, 74, 340);
  c.fillStyle = '#c9d0f5'; c.font = `700 34px ${F}`; c.fillText(`${d.pnl >= 0 ? '+' : ''}${fmt(d.pnl, 4)} ${d.unit}`, 80, 428); c.fillStyle = '#8f98c9'; c.font = `500 20px ${F}`; c.fillText('return on margin', 80, 462);
  // details grid
  const items: [string, string][] = [['Entry', d.entry], ['Exit', d.exit], ['Size', fmt(d.size) + ' ' + d.unit], ['Margin', fmt(d.margin) + ' ' + d.unit], ['Held', d.held]];
  let x = 80; const y = 525, cw = (W - 160) / items.length;
  for (const [k, v] of items) { c.fillStyle = '#8f98c9'; c.font = `600 18px ${F}`; c.fillText(k, x, y); c.fillStyle = '#ffffff'; c.font = `700 28px ${F}`; c.fillText(v, x, y + 38); x += cw; }
  // QR code to the site (top right)
  try {
    const qc = document.createElement('canvas');
    await QRCode.toCanvas(qc, 'https://www.starsky-luma.org', { margin: 1, width: 150, color: { dark: '#0b0f26', light: '#ffffff' } });
    rr(c, W - 80 - 170, 150, 170, 196, 18); c.fillStyle = '#ffffff'; c.fill();
    c.drawImage(qc, W - 80 - 160, 160, 150, 150);
    c.fillStyle = '#0b0f26'; c.font = `700 16px ${F}`; c.textAlign = 'center'; c.fillText('Scan to open Starsky', W - 80 - 85, 332); c.textAlign = 'left';
  } catch {}
  // footer
  c.fillStyle = '#7f89bd'; c.font = `500 18px ${F}`; c.fillText(new Date(d.when).toLocaleString(), 80, 626); c.textAlign = 'right'; c.fillStyle = '#62f2b4'; c.font = `700 20px ${F}`; c.fillText('starsky-luma.org', W - 80, 626); c.textAlign = 'left';
  return await new Promise<Blob>((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('Could not draw the image.'))), 'image/png'));
}
let CUR: { d: PnlData; blob: Blob; url: string } | null = null;
const text = (d: PnlData) => `${d.pnl >= 0 ? '🟢' : '🔴'} ${d.market} ${d.long ? 'LONG' : 'SHORT'} ${d.lev}x closed ${d.roe >= 0 ? '+' : ''}${(d.roe * 100).toFixed(2)}% (${d.pnl >= 0 ? '+' : ''}${fmt(d.pnl, 4)} ${d.unit}) on Starsky, the LUMA wallet. #LUMA #Starsky https://starsky-luma.org`;
export async function openShare(d: PnlData) {
  ctx.modal(`<h2>Share your trade</h2><div class="mut" style="padding:1rem">Drawing the card…</div>`);
  try {
    const blob = await drawPnl(d); if (CUR) URL.revokeObjectURL(CUR.url); CUR = { d, blob, url: URL.createObjectURL(blob) };
    ctx.modal(`<h2>Share your trade</h2><img src="${CUR.url}" style="width:100%;border-radius:14px;display:block;margin:.5rem 0" alt="PnL card">
      <div class="row" style="gap:.5rem;flex-wrap:wrap"><button class="pri acc grow" onclick="window.pnlShare.x(this)">Share to X</button><button class="pri grow" onclick="window.pnlShare.social(this)">Post to LUMA Social</button><button class="grow" onclick="window.pnlShare.save()">Save PNG</button></div>
      <div id="pnl_msg" class="mut" style="font-size:.78rem;margin-top:.5rem;min-height:1.2rem">On a phone, Share to X opens your share sheet with the picture attached. On a computer it saves the picture and opens X with the text ready: attach the saved picture to your post.</div>
      <div class="row" style="margin-top:.5rem"><button class="grow" onclick="window.closeModal()">Close</button></div>`);
  } catch (e: any) { ctx.modal(`<h2>Share your trade</h2><div class="crit">${esc(String(e?.message || e))}</div><button class="grow" onclick="window.closeModal()">Close</button>`); }
}
const say = (m: string) => { const e = document.getElementById('pnl_msg'); if (e) e.textContent = m; };
const save = () => { if (!CUR) return; const a = document.createElement('a'); a.href = CUR.url; a.download = `starsky-pnl-${CUR.d.market.replace(/\W+/g, '-')}.png`; a.click(); };
(window as any).pnlShare = {
  save,
  async x(b: HTMLButtonElement) {
    if (!CUR) return; const f = new File([CUR.blob], 'starsky-pnl.png', { type: 'image/png' }), n: any = navigator;
    try { if (n.canShare && n.canShare({ files: [f] })) { await n.share({ files: [f], text: text(CUR.d) }); return; } } catch (e: any) { if (e && e.name === 'AbortError') return; }
    save(); window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text(CUR.d)), '_blank', 'noopener'); say('Picture saved. Attach it to your post on X.'); void b;
  },
  async social(b: HTMLButtonElement) {
    if (!CUR) return; b.disabled = true; say('Uploading the picture…');
    try {
      const cid = await ipfsAdd(CUR.blob, 'starsky-pnl.png'), sc = await import('./social.ts');
      await sc.postExternal(text(CUR.d).replace(' https://starsky-luma.org', ''), 'ipfs://' + cid); say('Posted to LUMA Social.');
    } catch (e: any) { say(String(e?.message || e)); b.disabled = false; }
  },
};
