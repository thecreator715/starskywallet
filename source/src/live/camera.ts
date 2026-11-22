// Camera capture, photo editor and image compression for Starsky Social.
// Everything runs in the browser; the result is a File handed to the normal upload path (IPFS).
export const MAXBYTES = 5 * 1024 * 1024;
const TARGET = Math.floor(MAXBYTES * 0.94);

async function decode(b: Blob): Promise<{ w: number; h: number; draw: (c: CanvasRenderingContext2D, w: number, h: number) => void; done: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try { const bm = await createImageBitmap(b, { imageOrientation: 'from-image' } as any); return { w: bm.width, h: bm.height, draw: (c, w, h) => c.drawImage(bm, 0, 0, w, h), done: () => bm.close() }; } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(b);
  const img: HTMLImageElement = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('This picture format cannot be read by your browser.')); i.src = url; });
  return { w: img.naturalWidth, h: img.naturalHeight, draw: (c, w, h) => c.drawImage(img, 0, 0, w, h), done: () => URL.revokeObjectURL(url) };
}
const toBlob = (c: HTMLCanvasElement, type: string, q: number): Promise<Blob | null> => new Promise(r => c.toBlob(r, type, q));
const renamed = (n: string, ext: string) => (n.replace(/\.[^.]+$/, '') || 'photo') + '.' + ext;

/** Shrinks a picture until it is under 5 MB (JPEG/WebP/PNG). GIFs cannot be re-encoded and are returned unchanged. */
export async function compressImage(f: File, max = TARGET, onStep?: (m: string) => void): Promise<File> {
  if (f.size <= max && !(f.size > 0 && /^image\/(png|jpe?g|webp)$/i.test(f.type) && f.size > max)) return f;
  if (/gif$/i.test(f.type)) throw new Error(`${f.name} is a GIF of ${(f.size / 1048576).toFixed(1)} MB and GIFs cannot be shrunk. Choose a smaller GIF or a still picture.`);
  const d = await decode(f);
  try {
    let scale = Math.min(1, 3000 / Math.max(d.w, d.h)), q = 0.9;
    for (let n = 0; n < 12; n++) {
      const w = Math.max(1, Math.round(d.w * scale)), h = Math.max(1, Math.round(d.h * scale));
      const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d')!; x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); d.draw(x, w, h);
      const b = await toBlob(c, 'image/jpeg', q);
      if (b && b.size <= max) return new File([b], renamed(f.name, 'jpg'), { type: 'image/jpeg' });
      onStep?.(`Shrinking picture… ${(((b?.size) || 0) / 1048576).toFixed(1)} MB`);
      if (q > 0.62) q -= 0.1; else scale *= 0.82;
    }
    throw new Error('Could not shrink that picture under 5 MB.');
  } finally { d.done(); }
}

/* ---------- editor ---------- */
interface Adj { br: number; ct: number; sa: number; wm: number; fx: string }
const FX: Record<string, string> = { Original: '', Vivid: 'vivid', Warm: 'warm', Cool: 'cool', 'B&W': 'bw', Fade: 'fade', Noir: 'noir', Sepia: 'sepia' };
const adj0 = (): Adj => ({ br: 0, ct: 0, sa: 0, wm: 0, fx: '' });
function process(c: HTMLCanvasElement, a: Adj) {
  if (!a.br && !a.ct && !a.sa && !a.wm && !a.fx) return;
  const x = c.getContext('2d')!, im = x.getImageData(0, 0, c.width, c.height), p = im.data;
  const cf = (259 * (a.ct * 2.55 + 255)) / (255 * (259 - a.ct * 2.55)), bo = a.br * 2.55, sat = 1 + a.sa / 100;
  let sa = sat, ct2 = cf, bo2 = bo, wm2 = a.wm, bw = false, sep = false, fade = 0;
  if (a.fx === 'vivid') { sa *= 1.35; ct2 *= 1.08; } else if (a.fx === 'warm') wm2 += 28; else if (a.fx === 'cool') wm2 -= 28; else if (a.fx === 'bw') bw = true; else if (a.fx === 'noir') { bw = true; ct2 *= 1.35; bo2 -= 8; } else if (a.fx === 'fade') { fade = 28; sa *= 0.85; ct2 *= 0.9; } else if (a.fx === 'sepia') sep = true;
  for (let i = 0; i < p.length; i += 4) {
    let r = p[i], g = p[i + 1], b = p[i + 2];
    r += bo2; g += bo2; b += bo2;
    r = ct2 * (r - 128) + 128; g = ct2 * (g - 128) + 128; b = ct2 * (b - 128) + 128;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    if (bw) { r = g = b = l; } else if (sep) { r = l * 1.07 + 20; g = l * 0.95 + 8; b = l * 0.75; } else { r = l + (r - l) * sa; g = l + (g - l) * sa; b = l + (b - l) * sa; }
    r += wm2 * 0.6; b -= wm2 * 0.6; if (fade) { r += fade; g += fade; b += fade; }
    p[i] = r < 0 ? 0 : r > 255 ? 255 : r; p[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g; p[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
  x.putImageData(im, 0, 0);
}

type Stroke = { c: string; s: number; p: [number, number][] };
type Txt = { t: string; c: string; x: number; y: number; s: number };

let ov: HTMLElement | null = null, stream: MediaStream | null = null;
function css() {
  if (document.getElementById('cam-css')) return;
  const s = document.createElement('style'); s.id = 'cam-css';
  s.textContent = `.cam-ov{position:fixed;inset:0;z-index:2147483000;background:rgba(5,8,12,.94);display:flex;align-items:center;justify-content:center;padding:10px;color:#e8eef5;font:14px system-ui,sans-serif}
.cam-box{width:min(720px,100%);max-height:100%;overflow:auto;background:#0f1620;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:12px;display:flex;flex-direction:column;gap:10px}
.cam-hd{display:flex;align-items:center;justify-content:space-between;font-weight:800;font-size:1rem}
.cam-v,.cam-cv{width:100%;max-height:56vh;background:#000;border-radius:12px;object-fit:contain;display:block;touch-action:none}
.cam-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.cam-b{background:rgba(255,255,255,.08);color:inherit;border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:8px 12px;cursor:pointer;font:inherit}
.cam-b.on{background:#34d399;color:#04130c;border-color:#34d399;font-weight:700}.cam-b.pri{background:#34d399;color:#04130c;border:0;font-weight:800}
.cam-shot{width:62px;height:62px;border-radius:50%;border:4px solid #fff;background:rgba(255,255,255,.25);cursor:pointer;margin:0 auto}
.cam-sl{display:grid;grid-template-columns:90px 1fr;gap:6px;align-items:center;font-size:.8rem}.cam-sl input{width:100%}
.cam-in{background:#0a1018;color:inherit;border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:8px 10px;font:inherit;flex:1;min-width:120px}
.cam-m{opacity:.65;font-size:.8rem}`;
  document.head.appendChild(s);
}
function stop() { try { stream?.getTracks().forEach(t => t.stop()); } catch { /* */ } stream = null; }
export function closeCam() { stop(); ov?.remove(); ov = null; document.removeEventListener('keydown', esc); }
function esc(e: KeyboardEvent) { if (e.key === 'Escape') closeCam(); }
const el = (h: string) => { const d = document.createElement('div'); d.innerHTML = h; return d.firstElementChild as HTMLElement; };

/** Opens the camera. onDone receives the finished, compressed picture. */
export function openCamera(onDone: (f: File) => Promise<void> | void, toast: (m: string, bad?: boolean) => void): void {
  css(); closeCam();
  ov = el(`<div class="cam-ov"><div class="cam-box" id="cam-box"></div></div>`); document.body.appendChild(ov); document.addEventListener('keydown', esc);
  ov.addEventListener('mousedown', e => { if (e.target === ov) closeCam(); });
  void live();

  const box = () => document.getElementById('cam-box') as HTMLElement;
  const pickFile = (capture = false) => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; if (capture) i.setAttribute('capture', 'environment'); i.onchange = () => { const f = i.files && i.files[0]; if (f) void edit(f); }; i.click(); };

  async function live(facing: 'environment' | 'user' = 'environment') {
    stop();
    box().innerHTML = `<div class="cam-hd"><span>Camera</span><button class="cam-b" id="cam-x">✕</button></div><video class="cam-v" id="cam-vid" playsinline muted autoplay></video><div class="cam-m" id="cam-msg">Allow camera access when your browser asks.</div><div class="cam-row" style="justify-content:space-between"><button class="cam-b" id="cam-flip">Flip camera</button><button class="cam-shot" id="cam-snap" aria-label="Take picture"></button><button class="cam-b" id="cam-gal">Choose photo</button></div>`;
    (document.getElementById('cam-x') as HTMLElement).onclick = closeCam;
    (document.getElementById('cam-gal') as HTMLElement).onclick = () => pickFile(false);
    (document.getElementById('cam-flip') as HTMLElement).onclick = () => void live(facing === 'environment' ? 'user' : 'environment');
    const v = document.getElementById('cam-vid') as HTMLVideoElement, msg = document.getElementById('cam-msg') as HTMLElement;
    if (!navigator.mediaDevices?.getUserMedia) { msg.innerHTML = 'Live camera is not available in this browser or page. Use the button to take or choose a photo.'; (document.getElementById('cam-snap') as HTMLElement).onclick = () => pickFile(true); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 3000 }, height: { ideal: 3000 } }, audio: false });
      v.srcObject = stream; await v.play().catch(() => { /* */ }); msg.textContent = facing === 'user' ? 'Front camera' : 'Back camera';
      if (facing === 'user') v.style.transform = 'scaleX(-1)';
    } catch (e: any) { msg.innerHTML = `Could not open the camera (${String(e?.name || 'blocked')}). Allow camera access in your browser, or use the button to take or choose a photo.`; (document.getElementById('cam-snap') as HTMLElement).onclick = () => pickFile(true); return; }
    (document.getElementById('cam-snap') as HTMLElement).onclick = () => {
      const c = document.createElement('canvas'); c.width = v.videoWidth || 1280; c.height = v.videoHeight || 720; const x = c.getContext('2d')!;
      if (facing === 'user') { x.translate(c.width, 0); x.scale(-1, 1); } x.drawImage(v, 0, 0, c.width, c.height);
      c.toBlob(b => { if (b) void edit(new File([b], 'camera-' + Date.now() + '.jpg', { type: 'image/jpeg' })); }, 'image/jpeg', 0.95);
    };
  }

  async function edit(file: File) {
    stop();
    let src: HTMLCanvasElement;
    try {
      const d = await decode(file); const sc = Math.min(1, 3200 / Math.max(d.w, d.h)); src = document.createElement('canvas'); src.width = Math.round(d.w * sc); src.height = Math.round(d.h * sc); const x = src.getContext('2d')!; x.fillStyle = '#fff'; x.fillRect(0, 0, src.width, src.height); d.draw(x, src.width, src.height); d.done();
    } catch (e: any) { toast(String(e?.message || e), true); void live(); return; }
    const orig = document.createElement('canvas'); orig.width = src.width; orig.height = src.height; orig.getContext('2d')!.drawImage(src, 0, 0);
    let a = adj0(), mode: 'none' | 'draw' | 'text' = 'none', col = '#ffffff', size = 6; const strokes: Stroke[] = []; const texts: Txt[] = [];
    box().innerHTML = `<div class="cam-hd"><span>Edit photo</span><button class="cam-b" id="cam-x">✕</button></div><canvas class="cam-cv" id="cam-cv"></canvas>
<div class="cam-row" id="cam-fx">${Object.keys(FX).map(k => `<button class="cam-b ${FX[k] === '' ? 'on' : ''}" data-fx="${FX[k]}">${k}</button>`).join('')}</div>
<div class="cam-sl"><span>Brightness</span><input type="range" min="-60" max="60" value="0" data-a="br"></div><div class="cam-sl"><span>Contrast</span><input type="range" min="-60" max="60" value="0" data-a="ct"></div><div class="cam-sl"><span>Colour</span><input type="range" min="-100" max="100" value="0" data-a="sa"></div><div class="cam-sl"><span>Warmth</span><input type="range" min="-60" max="60" value="0" data-a="wm"></div>
<div class="cam-row"><button class="cam-b" data-o="rl">⟲ Rotate</button><button class="cam-b" data-o="rr">⟳ Rotate</button><button class="cam-b" data-o="fh">⇋ Mirror</button><button class="cam-b" data-o="c11">Crop 1:1</button><button class="cam-b" data-o="c43">4:3</button><button class="cam-b" data-o="c169">16:9</button><button class="cam-b" data-o="c916">9:16</button><button class="cam-b" data-o="reset">Reset</button></div>
<div class="cam-row"><button class="cam-b" id="cam-md">✏️ Draw</button><button class="cam-b" id="cam-mt">Aa Text</button><input type="color" id="cam-col" value="#ffffff" style="width:40px;height:36px;border:0;background:none"><input type="range" id="cam-sz" min="2" max="24" value="6" style="width:90px"><button class="cam-b" id="cam-undo">Undo mark</button><input class="cam-in" id="cam-txt" placeholder="Type text, then tap the picture" style="display:none"></div>
<div class="cam-m" id="cam-info"></div><div class="cam-row" style="justify-content:space-between"><button class="cam-b" id="cam-retake">Retake</button><button class="cam-b pri" id="cam-use">Use this photo</button></div>`;
    const cv = document.getElementById('cam-cv') as HTMLCanvasElement, info = document.getElementById('cam-info') as HTMLElement;
    const render = (c: HTMLCanvasElement, W: number) => {
      const H = Math.round(src.height * (W / src.width)); c.width = W; c.height = H; const x = c.getContext('2d')!; x.drawImage(src, 0, 0, W, H); process(c, a);
      x.lineCap = 'round'; x.lineJoin = 'round';
      for (const s of strokes) { x.strokeStyle = s.c; x.lineWidth = s.s * W / 1000; x.beginPath(); s.p.forEach((p, i) => i ? x.lineTo(p[0] * W, p[1] * H) : x.moveTo(p[0] * W, p[1] * H)); if (s.p.length === 1) x.lineTo(s.p[0][0] * W + 0.1, s.p[0][1] * H); x.stroke(); }
      for (const t of texts) { const fs = t.s * W / 1000; x.font = `800 ${fs}px system-ui,sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineWidth = fs / 6; x.strokeStyle = 'rgba(0,0,0,.65)'; x.strokeText(t.t, t.x * W, t.y * H); x.fillStyle = t.c; x.fillText(t.t, t.x * W, t.y * H); }
    };
    const redraw = () => { render(cv, Math.min(src.width, 960)); info.textContent = `${src.width}×${src.height} · will be saved as a JPEG under 5 MB`; };
    const xf = (fn: (c: HTMLCanvasElement, x: CanvasRenderingContext2D) => void, w: number, h: number) => { const n = document.createElement('canvas'); n.width = w; n.height = h; fn(n, n.getContext('2d')!); src.width = w; src.height = h; src.getContext('2d')!.drawImage(n, 0, 0); strokes.length = 0; texts.length = 0; redraw(); };
    const rot = (dir: number) => { const s0 = document.createElement('canvas'); s0.width = src.width; s0.height = src.height; s0.getContext('2d')!.drawImage(src, 0, 0); xf((c, x) => { x.translate(c.width / 2, c.height / 2); x.rotate(dir * Math.PI / 2); x.drawImage(s0, -s0.width / 2, -s0.height / 2); }, src.height, src.width); };
    const crop = (rw: number, rh: number) => { const r = rw / rh, W = src.width, H = src.height; let w = W, h = Math.round(W / r); if (h > H) { h = H; w = Math.round(H * r); } const s0 = document.createElement('canvas'); s0.width = W; s0.height = H; s0.getContext('2d')!.drawImage(src, 0, 0); xf((c, x) => x.drawImage(s0, (W - w) / 2, (H - h) / 2, w, h, 0, 0, w, h), w, h); };
    redraw();
    box().querySelectorAll<HTMLElement>('[data-fx]').forEach(b => b.onclick = () => { a.fx = b.dataset.fx || ''; box().querySelectorAll('[data-fx]').forEach(o => o.classList.toggle('on', o === b)); redraw(); });
    box().querySelectorAll<HTMLInputElement>('input[data-a]').forEach(i => i.oninput = () => { (a as any)[i.dataset.a!] = Number(i.value); redraw(); });
    box().querySelectorAll<HTMLElement>('[data-o]').forEach(b => b.onclick = () => { const o = b.dataset.o; if (o === 'rl') rot(-1); else if (o === 'rr') rot(1); else if (o === 'fh') { const s0 = document.createElement('canvas'); s0.width = src.width; s0.height = src.height; s0.getContext('2d')!.drawImage(src, 0, 0); xf((c, x) => { x.translate(c.width, 0); x.scale(-1, 1); x.drawImage(s0, 0, 0); }, src.width, src.height); } else if (o === 'c11') crop(1, 1); else if (o === 'c43') crop(4, 3); else if (o === 'c169') crop(16, 9); else if (o === 'c916') crop(9, 16); else if (o === 'reset') { src.width = orig.width; src.height = orig.height; src.getContext('2d')!.drawImage(orig, 0, 0); a = adj0(); strokes.length = 0; texts.length = 0; box().querySelectorAll<HTMLInputElement>('input[data-a]').forEach(i => i.value = '0'); box().querySelectorAll('[data-fx]').forEach(o2 => o2.classList.toggle('on', (o2 as HTMLElement).dataset.fx === '')); redraw(); } });
    const mdb = document.getElementById('cam-md') as HTMLElement, mtb = document.getElementById('cam-mt') as HTMLElement, ti = document.getElementById('cam-txt') as HTMLInputElement;
    const setMode = (m: typeof mode) => { mode = mode === m ? 'none' : m; mdb.classList.toggle('on', mode === 'draw'); mtb.classList.toggle('on', mode === 'text'); ti.style.display = mode === 'text' ? '' : 'none'; if (mode === 'text') ti.focus(); };
    mdb.onclick = () => setMode('draw'); mtb.onclick = () => setMode('text');
    (document.getElementById('cam-col') as HTMLInputElement).oninput = e => { col = (e.target as HTMLInputElement).value; };
    (document.getElementById('cam-sz') as HTMLInputElement).oninput = e => { size = Number((e.target as HTMLInputElement).value); };
    (document.getElementById('cam-undo') as HTMLElement).onclick = () => { if (texts.length && (mode === 'text' || !strokes.length)) texts.pop(); else strokes.pop(); redraw(); };
    const pt = (e: PointerEvent): [number, number] => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
    let cur: Stroke | null = null;
    cv.onpointerdown = e => { if (mode === 'draw') { cur = { c: col, s: size * 1.6, p: [pt(e)] }; strokes.push(cur); cv.setPointerCapture(e.pointerId); redraw(); } else if (mode === 'text') { const t = ti.value.trim(); if (!t) { ti.focus(); return; } const p = pt(e); texts.push({ t, c: col, x: p[0], y: p[1], s: size * 6 + 24 }); redraw(); } };
    cv.onpointermove = e => { if (cur) { cur.p.push(pt(e)); redraw(); } };
    cv.onpointerup = cv.onpointercancel = () => { cur = null; };
    (document.getElementById('cam-x') as HTMLElement).onclick = closeCam;
    (document.getElementById('cam-retake') as HTMLElement).onclick = () => void live();
    (document.getElementById('cam-use') as HTMLElement).onclick = async () => {
      const b = document.getElementById('cam-use') as HTMLButtonElement; b.disabled = true; b.textContent = 'Preparing…';
      try {
        const out = document.createElement('canvas'); render(out, Math.min(src.width, 3000));
        let blob = await toBlob(out, 'image/jpeg', 0.92); const f0 = new File([blob || new Blob()], 'photo-' + Date.now() + '.jpg', { type: 'image/jpeg' });
        const f = await compressImage(f0, TARGET, m => { b.textContent = m; });
        closeCam(); await onDone(f);
      } catch (e: any) { toast(String(e?.message || e), true); b.disabled = false; b.textContent = 'Use this photo'; }
    };
  }
}
/** Edit a file the user already picked (used by the gallery button). */
