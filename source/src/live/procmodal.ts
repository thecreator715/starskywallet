// Order review + progress pop-ups shared by the DEX (spot, limit), Leverage and one-click tips.
import { ctx } from './ctx.ts';

const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
export interface PRow { k: string; v: string; hint?: string; cls?: string }
export interface Review {
  title: string; tone: 'buy' | 'sell' | 'lev' | 'tip'; pay?: { label: string; sub?: string }; get?: { label: string; sub?: string }; hero?: string;
  rows: PRow[]; warns?: string[]; confirm: string; note?: string; extra?: string;
}
const TONE: Record<string, string> = { buy: '#4ade80', sell: '#f87171', lev: '#c084fc', tip: '#fcd34d' };
let resolve: ((ok: boolean) => void) | null = null, watch: any = 0;
function finish(ok: boolean) { const r = resolve; resolve = null; clearInterval(watch); if (r) r(ok); }
export function review(o: Review): Promise<boolean> {
  finish(false);
  const c = TONE[o.tone] || '#a78bfa';
  const warn = (o.warns || []).map(w => `<div class="pm-warn">⚠ ${esc(w)}</div>`).join('');
  ctx.modal(`<div class="pm" style="--pm:${c}"><div class="pm-h"><span class="pm-dot"></span>${esc(o.title)}</div>
    ${o.hero ? `<div class="pm-hero">${o.hero}</div>` : `<div class="pm-flow"><div class="pm-leg"><small>You pay</small><b>${esc(o.pay?.label || '')}</b><span>${esc(o.pay?.sub || '')}</span></div><div class="pm-arrow">→</div><div class="pm-leg r"><small>You receive</small><b>${esc(o.get?.label || '')}</b><span>${esc(o.get?.sub || '')}</span></div></div>`}
    <div class="pm-grid">${o.rows.map(r => `<div class="pm-r"><span>${esc(r.k)}${r.hint ? `<i title="${esc(r.hint)}">?</i>` : ''}</span><b class="${r.cls || ''}">${r.v}</b></div>`).join('')}</div>
    ${o.extra || ''}${warn}${o.note ? `<div class="pm-note">${esc(o.note)}</div>` : ''}
    <div class="pm-btns"><button class="grow" onclick="window.pm.no()">Cancel</button><button class="pri grow pm-go" onclick="window.pm.yes()">${esc(o.confirm)}</button></div></div>`);
  return new Promise<boolean>(res => { resolve = res; watch = setInterval(() => { if (!document.querySelector('.pm .pm-go')) finish(false); }, 400); });
}
export interface Prog { set(i: number, st: 'run' | 'ok' | 'bad', note?: string): void; done(html: string, link?: string): void; fail(msg: string): void; close(): void }
export function progress(title: string, steps: string[], tone = 'buy'): Prog {
  const c = TONE[tone] || '#a78bfa', S = steps.map(s => ({ s, st: 'wait' as string, note: '' }));
  const draw = (foot = '') => ctx.modal(`<div class="pm" style="--pm:${c}"><div class="pm-h"><span class="pm-dot"></span>${esc(title)}</div><div class="pm-steps">${S.map(x => `<div class="pm-s ${x.st}"><i>${x.st === 'ok' ? '✓' : x.st === 'bad' ? '✕' : x.st === 'run' ? '<u></u>' : '•'}</i><span>${esc(x.s)}${x.note ? `<small>${esc(x.note)}</small>` : ''}</span></div>`).join('')}</div>${foot}</div>`);
  draw();
  return {
    set(i, st, note = '') { if (!S[i]) return; S[i].st = st; S[i].note = note; draw(); },
    done(html) { S.forEach(x => { if (x.st !== 'bad') x.st = 'ok'; }); draw(`<div class="pm-done">${html}</div><div class="pm-btns"><button class="pri grow" onclick="window.closeModal()">Done</button></div>`); },
    fail(msg) { const i = S.findIndex(x => x.st === 'run'); if (i >= 0) { S[i].st = 'bad'; } draw(`<div class="pm-warn" style="margin-top:.7rem">${esc(msg)}</div><div class="pm-btns"><button class="grow" onclick="window.closeModal()">Close</button></div>`); },
    close() { ctx.closeModal(); },
  };
}
(window as any).pm = { yes: () => { ctx.closeModal(); finish(true); }, no: () => { ctx.closeModal(); finish(false); } };
export const CSS = `.pm{--pm:#a78bfa}.pm-h{display:flex;align-items:center;gap:.5rem;font-weight:800;font-size:1.05rem;margin-bottom:.8rem}.pm-dot{width:.7rem;height:.7rem;border-radius:50%;background:var(--pm);box-shadow:0 0 14px var(--pm)}
.pm-flow{display:flex;align-items:center;gap:.6rem;padding:.9rem;border-radius:1rem;background:linear-gradient(135deg,color-mix(in srgb,var(--pm) 14%,transparent),rgba(255,255,255,.02));border:1px solid color-mix(in srgb,var(--pm) 35%,transparent)}.pm-leg{flex:1;display:flex;flex-direction:column;gap:.15rem}.pm-leg.r{text-align:right}.pm-leg small{opacity:.6;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}.pm-leg b{font-size:1.25rem}.pm-leg span{font-size:.78rem;opacity:.6}.pm-arrow{font-size:1.4rem;color:var(--pm)}
.pm-hero{padding:.9rem;border-radius:1rem;background:linear-gradient(135deg,color-mix(in srgb,var(--pm) 16%,transparent),rgba(255,255,255,.02));border:1px solid color-mix(in srgb,var(--pm) 35%,transparent);font-size:1.05rem}
.pm-grid{margin:.8rem 0;border-radius:.9rem;border:1px solid rgba(255,255,255,.08);overflow:hidden}.pm-r{display:flex;justify-content:space-between;gap:1rem;padding:.5rem .8rem;font-size:.86rem}.pm-r:nth-child(odd){background:rgba(255,255,255,.03)}.pm-r span{opacity:.65}.pm-r i{display:inline-block;width:1rem;height:1rem;line-height:1rem;text-align:center;border-radius:50%;background:rgba(255,255,255,.1);font-size:.65rem;margin-left:.35rem;font-style:normal;cursor:help}.pm-r b{text-align:right}.pm-r b.up{color:#4ade80}.pm-r b.dn{color:#f87171}
.pm-warn{margin:.5rem 0;padding:.55rem .75rem;border-radius:.7rem;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.35);color:#fcd34d;font-size:.82rem}.pm-note{opacity:.6;font-size:.76rem;margin:.4rem 0}.pm-btns{display:flex;gap:.6rem;margin-top:.9rem}.pm-go{background:linear-gradient(135deg,var(--pm),color-mix(in srgb,var(--pm) 55%,#5b7cff))!important;color:#071012!important;font-weight:800}
.pm-steps{display:flex;flex-direction:column;gap:.55rem;margin:.4rem 0}.pm-s{display:flex;gap:.7rem;align-items:flex-start;opacity:.5}.pm-s.run,.pm-s.ok,.pm-s.bad{opacity:1}.pm-s i{width:1.5rem;height:1.5rem;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.08);font-style:normal;font-size:.8rem;flex:none}.pm-s.ok i{background:var(--pm);color:#071012;font-weight:800}.pm-s.bad i{background:#f87171;color:#fff}.pm-s small{display:block;opacity:.6;font-size:.74rem}.pm-s u{width:.8rem;height:.8rem;border-radius:50%;border:2px solid var(--pm);border-top-color:transparent;animation:pmspin .8s linear infinite}@keyframes pmspin{to{transform:rotate(360deg)}}
.pm-done{margin-top:.8rem;padding:.8rem;border-radius:.9rem;background:color-mix(in srgb,var(--pm) 12%,transparent);border:1px solid color-mix(in srgb,var(--pm) 35%,transparent);font-size:.88rem}`;
