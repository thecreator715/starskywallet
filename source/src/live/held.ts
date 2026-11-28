// Held tokens: a token cannot be paid straight to a wallet that has no trust line for it, so it is sent as a check instead (a check is held on the
// ledger until the receiver adds the trust line and claims it). This module (1) watches for checks written to you that need a trust line and
// shows a notification that stays until you claim or reject them, and (2) lets a sender choose "send as held" when the recipient has no line.
import { ctx } from './ctx.ts';
import { esc, fmt, short, assetOf, amtNum, isNative } from './util.ts';
import * as M from './market.ts';

const SEEN = () => `starsky.held.seen.${ctx.netKey()}.${ctx.account() || ''}`;
let timer: any = 0, LIST: any[] = [], dismissed = false;
const rd = (): string[] => { try { return JSON.parse(localStorage.getItem(SEEN()) || '[]'); } catch { return []; } };
const wr = (a: string[]) => { try { localStorage.setItem(SEEN(), JSON.stringify(a.slice(-200))); } catch { /* blocked */ } };
const nowRipple = () => Math.floor(Date.now() / 1000) - 946684800;

export async function hasLine(addr: string, a: { c: string; i: string }): Promise<boolean> {
  if (isNative(a as any) || a.i === addr) return true;
  try { const r = await ctx.req('account_lines', { account: addr, peer: a.i, ledger_index: 'validated', limit: 50 }); return (r.lines || []).some((l: any) => l.currency === a.c); } catch { return true; }   // unknown: do not block
}
/** checks written to me for tokens I have no trust line for */
export async function scan() {
  const acc = ctx.account(); if (!acc || !ctx.online()) { LIST = []; paint(); return; }
  try {
    const r = await ctx.req('account_objects', { account: acc, type: 'check', ledger_index: 'validated', limit: 200 }); const out: any[] = [];
    for (const c of r.account_objects || []) {
      if (c.Destination !== acc || c.Account === acc || (c.Expiration && c.Expiration <= nowRipple())) continue; const a = assetOf(c.SendMax); if (isNative(a)) continue;
      if (!(await hasLine(acc, a))) out.push({ id: c.index, from: c.Account, a, amt: amtNum(c.SendMax), sym: M.labelOf(a) });
    }
    const seen = rd(), fresh = out.filter(x => !seen.includes(x.id)); LIST = out;
    if (fresh.length) { ctx.toast(`${fresh.length === 1 ? fresh[0].amt + ' ' + fresh[0].sym : fresh.length + ' tokens'} waiting for you. Add the trust line to claim.`); wr([...seen, ...fresh.map(x => x.id)]); }
  } catch { /* node busy: keep the last list */ }
  paint();
}
function paint() {
  let el = document.getElementById('held_banner');
  if (!LIST.length || dismissed) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'held_banner'; el.setAttribute('style', 'position:fixed;left:50%;transform:translateX(-50%);bottom:1rem;z-index:50;max-width:min(32rem,94vw);width:100%;background:#1b1633;border:1px solid #f5b84b;border-radius:14px;padding:.7rem .9rem;box-shadow:0 8px 30px rgba(0,0,0,.45);font-size:.9rem'); document.body.appendChild(el); }
  el.innerHTML = `<div style="display:flex;gap:.5rem;align-items:center"><b style="flex:1">Tokens are waiting for you</b><button class="sm" onclick="window.hd.dismiss()">Hide</button></div><div class="mut" style="margin:.2rem 0 .4rem;font-size:.82rem">Someone sent these to you, but your wallet has no trust line for them yet. They are held safely on the network until you add the line and claim.</div>${LIST.slice(0, 4).map(x => `<div style="display:flex;gap:.5rem;align-items:center;margin:.25rem 0"><span style="flex:1"><b>${esc(fmt(x.amt, 6))} ${esc(x.sym)}</b> <span class="mut">from ${esc(short(ctx.show(x.from), 6, 4))}</span></span><button class="pri sm" onclick="window.hd.claim('${esc(x.id)}')">Add trust line and claim</button></div>`).join('')}${LIST.length > 4 ? `<div class="mut" style="font-size:.8rem">and ${LIST.length - 4} more in Checks</div>` : ''}`;
}
export function dismiss() { dismissed = true; paint(); }
export async function claim(id: string) { const ck = (window as any).ck; (window as any).goTab('checks'); await ck.load(true); await ck.cash(id, 0); setTimeout(() => void scan(), 8000); }
export function start() { clearInterval(timer); dismissed = false; void scan(); timer = setInterval(() => void scan(), 20000); }

/** sender side: pay as a held check when the receiver has no trust line */
export async function offerHeld(tx: any, destShown: string, symbol: string): Promise<boolean> {
  const a = assetOf(tx.Amount); if (isNative(a)) return false; return !(await hasLine(tx.Destination, a));
}
export function heldTx(tx: any, days = 30) { const c: any = { TransactionType: 'CheckCreate', Account: tx.Account, Destination: tx.Destination, SendMax: tx.Amount, Expiration: nowRipple() + days * 86400 }; if (tx.DestinationTag != null) c.DestinationTag = tx.DestinationTag; if (tx.Memos) c.Memos = tx.Memos; return c; }
export const api = { dismiss, claim, scan };
