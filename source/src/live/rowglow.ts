// Gradient rows on Portfolio, Markets, Tokens and Pools: each row fades from green (up) or red (down) by its biggest % move.
let raf = 0;
function paint() {
  raf = 0;
  document.querySelectorAll('table.dxt tbody tr').forEach(tr => {
    if (tr.classList.contains('trw') || tr.classList.contains('cathead') || tr.closest('#dx_table,#dx_hist')) return;
    let best = 0;
    tr.querySelectorAll('span.up,span.dn,b.up,b.dn').forEach(s => {
      const m = /([+-]?\d+(?:\.\d+)?)\s*%/.exec(s.textContent || '');
      if (!m) return;
      const v = Math.abs(parseFloat(m[1])) * (s.classList.contains('dn') ? -1 : 1);
      if (Math.abs(v) > Math.abs(best)) best = v;
    });
    const el = tr as HTMLElement, dir = best > 0.005 ? 'up' : best < -0.005 ? 'dn' : '';
    if (el.dataset.glow === dir && el.dataset.gv === String(Math.round(best))) return;
    el.dataset.glow = dir;
    el.dataset.gv = String(Math.round(best));
    el.style.setProperty('--gi', (0.08 + 0.26 * Math.min(1, Math.abs(best) / 15)).toFixed(2));
  });
}
export function startRowGlow() {
  new MutationObserver(() => {
    if (!raf) raf = requestAnimationFrame(paint);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  paint();
}
