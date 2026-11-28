// Spam detection for tokens that show up in a wallet and for incoming payments. Pure scoring (testable) plus a per-wallet hide list.
export interface TokenFacts { name: string; key: string; balance: number; hasLiquidity: boolean; registered: boolean; genuineKeys: Map<string, string> /* normalized name -> genuine asset key */ }
export interface Verdict { score: number; spam: boolean; reasons: string[] }
export const norm = (n: string) => String(n || '').toLowerCase().replace(/[0]/g, 'o').replace(/[1|!]/g, 'l').replace(/[5$]/g, 's').replace(/[^a-z]/g, '');
const BAIT = /(https?:|www\.|\.com|\.io|\.xyz|\.net|t\.me|claim|airdrop|reward|bonus|visit|giveaway|free|winner|voucher|\bgift\b)/i;
export function scoreToken(f: TokenFacts): Verdict {
  const r: string[] = []; let s = 0;
  const g = f.genuineKeys.get(norm(f.name));
  if (g && g !== f.key) { s += 6; r.push('copies the name of a real token but comes from a different issuer'); }
  if (BAIT.test(f.name)) { s += 5; r.push('the name is a link or a sales pitch'); }
  if (f.balance > 0 && !f.hasLiquidity) { s += 2; r.push('no pool to trade it in'); }
  if (!f.registered) { s += 2; r.push('not created through the network token creator'); }
  if (f.balance > 0 && f.balance < 1 && !f.hasLiquidity) { s += 1; r.push('a tiny balance you did not ask for'); }
  return { score: s, spam: s >= 5, reasons: r };
}
export interface PayFacts { amount: number; assetName: string; memo: string; fromKnown: boolean; fromSelf: boolean; asset: TokenFacts | null }
export function scorePayment(p: PayFacts): Verdict {
  const r: string[] = []; let s = 0;
  if (p.fromSelf) return { score: 0, spam: false, reasons: [] };
  if (p.memo && BAIT.test(p.memo)) { s += 5; r.push('the memo has a link or a sales pitch'); }
  if (!p.fromKnown && p.amount > 0 && p.amount < 0.01) { s += 3; r.push('dust from a stranger'); }
  if (p.asset) { const v = scoreToken(p.asset); if (v.spam) { s += v.score; r.push(...v.reasons); } }
  return { score: s, spam: s >= 5, reasons: r };
}
const KEY = (addr: string) => 'starsky.spamhide.' + addr;
export const hidden = (addr: string): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(KEY(addr)) || '[]')); } catch { return new Set(); } };
export const hide = (addr: string, key: string, on = true) => { const h = hidden(addr); on ? h.add(key) : h.delete(key); try { localStorage.setItem(KEY(addr), JSON.stringify([...h])); } catch {} };
