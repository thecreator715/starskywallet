// Pure text -> intent parser for the Starsky AI page. No DOM, no network: everything here is unit-tested in Node.
// It understands number words, typos, synonyms and short follow-ups, and reports what is still missing so the chat can ask.
export type Kind = 'swap' | 'send' | 'balance' | 'price' | 'history' | 'lend' | 'check' | 'bridge' | 'nav' | 'api' | 'help' | 'cancel' | 'yes' | 'unknown';
export interface Intent {
  kind: Kind;
  amount?: number | 'all' | 'half';
  from?: string;          // asset name the user pays (raw text, upper-cased)
  to?: string;            // asset name the user wants
  amountIsTarget?: boolean; // "buy 100 LUMA with XRP": the amount is of `to`
  dest?: string;          // address or contact name for send
  action?: string;        // lend: supply|withdraw|borrow|repay|collateral ; nav: tab ; check: write|cash
  asset?: string;
  slip?: number;
  missing: string[];
}
const ONES: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, a: 1, an: 1, couple: 2, few: 3, dozen: 12 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const MULT: Record<string, number> = { hundred: 100, thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, mil: 1e6 };

/** "five", "twenty five", "1.5k", "2,500", "ten thousand" -> number, or null */
export function parseNumber(words: string[], i: number): { n: number; used: number } | null {
  const w = words[i]; if (w == null) return null;
  const m = /^(\d[\d,]*\.?\d*|\.\d+)(k|m|mil)?$/i.exec(w);
  if (m) { let n = Number(m[1].replace(/,/g, '')); if (m[2]) n *= MULT[m[2].toLowerCase()]; if (!isFinite(n)) return null; let used = 1; const nx = words[i + 1]; if (!m[2] && nx && MULT[nx] && nx.length > 1) { n *= MULT[nx]; used++; } return { n, used }; }
  let n = 0, used = 0, seen = false, cur = 0;
  for (let j = i; j < words.length; j++) {
    const x = words[j];
    if (x === 'and' && seen && j + 1 < words.length && (ONES[words[j + 1]] != null || TENS[words[j + 1]] != null)) { used++; continue; }
    if (x === 'a' && !(MULT[words[j + 1]] || TENS[words[j + 1]] != null)) { if (j === i) return null; break; }
    if (ONES[x] != null && !(x === 'a' || x === 'an') || ((x === 'a' || x === 'an') && j === i && MULT[words[j + 1]] > 1)) { cur += ONES[x] ?? 1; seen = true; used++; continue; }
    if (TENS[x] != null) { cur += TENS[x]; seen = true; used++; continue; }
    if (MULT[x] && x.length > 1 && seen) { if (x === 'hundred') cur = (cur || 1) * 100; else { n += (cur || 1) * MULT[x]; cur = 0; } used++; continue; }
    break;
  }
  if (!seen) return null; return { n: n + cur, used };
}
const SYN: Record<string, string> = { dollar: 'USD', dollars: 'USD', usd: 'USD', usdc: 'USD', usdt: 'USD', bucks: 'USD', buck: 'USD', ripple: 'XRP', xrp: 'XRP', xrpz: 'XRP', luma: 'LUMA', lumas: 'LUMA', lum: 'LUMA' };
export const normAsset = (s: string): string => { const t = s.toLowerCase().replace(/[^a-z0-9]/g, ''); return SYN[t] || s.toUpperCase().replace(/[^A-Z0-9]/g, ''); };
const STOP = new Set(['please', 'pls', 'plz', 'now', 'the', 'my', 'of', 'to', 'for', 'into', 'in', 'with', 'using', 'from', 'by', 'at', 'on', 'me', 'i', 'want', 'wanna', 'would', 'like', 'can', 'you', 'could', 'help', 'need', 'lets', "let's", 'just', 'some', 'worth', 'tokens', 'token', 'coins', 'coin', 'and', 'then', 'it', 'that']);
const ADDR = /\b(r[1-9A-HJ-NP-Za-km-z]{24,34}|X[1-9A-HJ-NP-Za-km-z]{30,})\b/;

const has = (t: string, ...ws: string[]) => ws.some(w => new RegExp('\\b' + w + '\\b', 'i').test(t));
const lev = (a: string, b: string) => { const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
/** fix small typos in verbs (swop, tarde, sned, balence) */
const VERBS = ['swap', 'trade', 'exchange', 'convert', 'buy', 'sell', 'send', 'pay', 'transfer', 'balance', 'price', 'history', 'supply', 'deposit', 'withdraw', 'borrow', 'repay', 'lend', 'lending', 'check', 'cheque', 'bridge', 'open', 'show', 'go', 'help', 'cancel', 'stop', 'yes', 'confirm', 'accept', 'portfolio'];
function fixVerb(w: string): string { if (w.length < 3 || VERBS.includes(w)) return w; let best = w, bd = 3; for (const v of VERBS) { if (Math.abs(v.length - w.length) > 1) continue; const d = lev(w, v); if (d < bd && d <= (v.length > 4 ? 2 : 1)) { bd = d; best = v; } } return best; }

export function tokenize(text: string): string[] {
  return text.replace(/[$€£]/g, ' usd ').replace(/(\d)([a-zA-Z]+)\b/g, (m, a, b) => (/^(k|m|mil)$/i.test(b) ? m : a + ' ' + b)).replace(/[^\w.,'@:-]+/g, ' ').trim().split(/\s+/).filter(Boolean).map(w => w.replace(/[,.]+$/, '')).filter(Boolean);
}
const TABS: Record<string, string> = { dex: 'dex', trade: 'dex', exchange: 'dex', markets: 'markets', market: 'markets', pools: 'pools', pool: 'pools', bridge: 'bridge', network: 'network', bot: 'bot', margin: 'margin', supply: 'supply', burn: 'burn', claim: 'claim', rewards: 'rewards', social: 'social', send: 'send', receive: 'receive', checks: 'checks', check: 'checks', payroll: 'checks', lending: 'lending', loans: 'lending', nfts: 'nfts', activity: 'activity', holders: 'holders', home: 'home', wallets: 'wallets', wallet: 'wallets', api: 'api' };

export function parse(text: string, prev?: Intent | null): Intent {
  const raw = String(text || '').trim();
  const words = tokenize(raw).map(w => w.toLowerCase());
  const fixed = words.map((w, i) => (i < 3 ? fixVerb(w) : w));
  const t = fixed.join(' ');
  const I = (kind: Kind, extra: Partial<Intent> = {}): Intent => ({ kind, missing: [], ...extra });
  if (!t) return I('unknown');
  if (/^(yes|yep|yeah|y|ok|okay|confirm|accept|do it|go|go ahead|sure|approve|proceed|execute|send it)$/.test(t)) return I('yes');
  if (/^(no|nope|n|cancel|stop|nevermind|never mind|abort|dont|don't|reject|decline)$/.test(t)) return I('cancel');
  if (/^(help|\?|legend|commands|what can you do|what can i say|menu|examples)$/.test(t)) return I('help');

  // amount
  let amount: number | 'all' | 'half' | undefined, ai = -1, au = 0;
  for (let i = 0; i < fixed.length; i++) {
    if (['all', 'everything', 'max', 'maximum'].includes(fixed[i]) && (i === 0 || !/^(of|a|the)$/.test(fixed[i - 1]) || true)) { if (fixed[i] !== 'all' || fixed[i + 1] !== 'of' || true) { amount = 'all'; ai = i; au = 1; break; } }
    if (fixed[i] === 'half' || (fixed[i] === 'a' && fixed[i + 1] === 'half')) { amount = 'half'; ai = i; au = fixed[i] === 'a' ? 2 : 1; break; }
    const p = parseNumber(fixed, i); if (p && p.n > 0 && !(fixed[i] === 'a' || fixed[i] === 'an') ) { amount = p.n; ai = i; au = p.used; break; }
  }
  const rest = fixed.filter((_, i) => i < ai || i >= ai + au);
  const verb = rest.find(w => VERBS.includes(w)) || '';
  const addr = ADDR.exec(raw)?.[1];

  // asset words: anything that is not a stop word, verb, number or address
  const assetWords = (ws: string[]) => ws.filter(w => !STOP.has(w) && !VERBS.includes(w) && !ADDR.test(w) && !/^\d/.test(w) && ONES[w] == null && TENS[w] == null && !MULT[w]);

  if (['swap', 'trade', 'exchange', 'convert', 'buy', 'sell'].includes(verb) || /\bfor\b|\binto\b/.test(t) && amount != null && assetWords(rest).length >= 2 && !['send', 'pay', 'transfer'].includes(verb)) {
    const out = I('swap', { amount });
    // split on for/into/to/with/using/->
    const joined = rest.join(' ');
    const m = /^(.*?)\b(for|into|to|with|using|->|=>|→)\b(.*)$/.exec(joined);
    const A = m ? assetWords(m[1].trim().split(' ')) : assetWords(rest), B = m ? assetWords(m[3].trim().split(' ')) : [];
    const first = A[A.length - 1], second = B[0];
    if (verb === 'buy') { out.to = first ? normAsset(first) : undefined; out.from = second ? normAsset(second) : undefined; out.amountIsTarget = true; if (m && m[2] === 'for' && second) { /* buy 100 luma for 5 xrp: amount belongs to target when it precedes */ } }
    else if (verb === 'sell') { out.from = first ? normAsset(first) : undefined; out.to = second ? normAsset(second) : undefined; }
    else { out.from = first ? normAsset(first) : undefined; out.to = second ? normAsset(second) : undefined; }
    const sl = /(\d+(?:\.\d+)?)\s*%\s*(?:slippage|slip)/i.exec(raw) || /slippage\s*(?:of\s*)?(\d+(?:\.\d+)?)/i.exec(raw); if (sl) out.slip = Number(sl[1]);
    if (amount == null) out.missing.push('amount'); if (!out.from) out.missing.push('from'); if (!out.to) out.missing.push('to');
    return out;
  }
  if (['send', 'pay', 'transfer'].includes(verb) || (/\b(send|pay)\b/.test(t))) {
    const out = I('send', { amount, dest: addr });
    const j = rest.join(' '); const mm = /\b(?:to|->)\s+([a-z][\w .-]*)$/.exec(j);
    if (!addr && mm) out.dest = mm[1].replace(/\b(please|now)\b/g, '').trim() || undefined;
    const aw = assetWords(rest.filter(w => !(out.dest && out.dest.toLowerCase().split(' ').includes(w)))); if (aw[0]) out.asset = normAsset(aw[0]);
    if (amount == null) out.missing.push('amount'); if (!out.dest) out.missing.push('dest'); return out;
  }
  if (verb === 'bridge' || /\bbridge\b/.test(t)) return I('bridge', { amount, asset: assetWords(rest)[0] ? normAsset(assetWords(rest)[0]) : undefined, missing: [] });
  if (['supply', 'deposit', 'withdraw', 'borrow', 'repay', 'lend'].includes(verb) || /\bcollateral\b|\bliquidat/.test(t)) {
    const act = /\bcollateral\b/.test(t) ? (/withdraw|remove/.test(t) ? 'withdrawcol' : 'collateral') : verb === 'deposit' || verb === 'lend' ? 'supply' : verb || 'supply';
    const aw = assetWords(rest); const out = I('lend', { amount, action: act, asset: aw[0] ? normAsset(aw[0]) : undefined });
    if (amount == null) out.missing.push('amount'); return out;
  }
  if (/\bcheques?\b|\bchecks?\b|\bpayroll\b/.test(t) && !/^(check)\s+(balance|price)/.test(t)) return I('check', { amount, dest: addr, action: /cash/.test(t) ? 'cash' : 'write', missing: [] });
  if (verb === 'balance' || /\bhow much\b.*\b(have|own)\b|\bholdings?\b|\bportfolio\b|\bwhat do i (have|own)\b/.test(t)) return I('balance', { asset: assetWords(rest)[0] ? normAsset(assetWords(rest)[0]) : undefined });
  if (verb === 'price' || /\bhow much is\b|\bworth\b|\brate\b|\bwhat'?s? .* (at|trading)\b/.test(t)) { const aw = assetWords(rest.filter(w => !['how', 'much', 'is', 'what', 'whats', "what's", 'rate', 'price'].includes(w))); return I('price', { asset: aw[0] ? normAsset(aw[0]) : undefined }); }
  if (verb === 'history' || /\b(recent|last|latest)\b.*\b(transactions?|activity|trades?)\b|\btransactions?\b|\bactivity\b/.test(t)) return I('history');
  if (/\bapi\b|\bdeveloper\b|\bapi key\b/.test(t)) return I('api');
  if (['open', 'show', 'go'].includes(verb) || rest.length === 1) { const tab = rest.map(w => TABS[w]).find(Boolean); if (tab) return I('nav', { action: tab }); }
  // follow-up fills: a bare number, asset or address answers the question we just asked
  if (prev && prev.missing.length) {
    const nx: Intent = { ...prev, missing: [] };
    if (prev.missing.includes('amount') && amount != null) nx.amount = amount;
    const aw = assetWords(rest);
    if (aw.length) { if (prev.missing.includes('from')) nx.from = normAsset(aw[0]); else if (prev.missing.includes('to')) nx.to = normAsset(aw[0]); else if (prev.missing.includes('asset')) nx.asset = normAsset(aw[0]); }
    if (addr && prev.missing.includes('dest')) nx.dest = addr; else if (prev.missing.includes('dest') && aw.length) nx.dest = aw.join(' ');
    nx.missing = []; if (nx.kind === 'swap') { if (nx.amount == null) nx.missing.push('amount'); if (!nx.from) nx.missing.push('from'); if (!nx.to) nx.missing.push('to'); } if (nx.kind === 'send') { if (nx.amount == null) nx.missing.push('amount'); if (!nx.dest) nx.missing.push('dest'); }
    if (nx.kind === 'lend' && nx.amount == null) nx.missing.push('amount');
    return nx;
  }
  const tab = rest.map(w => TABS[w]).find(Boolean); if (tab) return I('nav', { action: tab });
  return I('unknown');
}
/** a plain-language rendering of what was understood, shown in the chat before any estimate */
export const LEGEND: { group: string; items: [string, string][] }[] = [
  { group: 'Trade', items: [['trade 5 XRP for LUMA', 'Shows an estimate first. You press Accept to run it.'], ['swap 100 LUMA to USD', 'Same thing, any wording works'], ['buy 50 LUMA with XRP', 'You name what you want to get'], ['sell half my LUMA for USD', 'Say all, half, or an amount'], ['trade five hundred XRP for LUMA with 2% slippage', 'Numbers in words are fine']] },
  { group: 'Send and receive', items: [['send 10 LUMA to rAddress…', 'Review card before anything is sent'], ['pay 25 USD to Alice', 'Works with names from your contacts'], ['write a check for 100 LUMA to rAddress…', 'Opens the Checks form filled in']] },
  { group: 'Look things up', items: [['balance', 'Your balances and their value'], ['price of XRP', 'Current price and where it trades'], ['history', 'Your latest transactions']] },
  { group: 'Lending and bridge', items: [['supply 500 USD', 'Opens the Lending form filled in'], ['borrow 100 USD', 'Shows your limit and health first'], ['repay 50 USD / withdraw 20 LUMA', 'Same'], ['bridge 5 XRP', 'Opens the bridge with the amount filled in']] },
  { group: 'Get around', items: [['open lending', 'Also: dex, markets, pools, checks, bridge, api, activity'], ['api', 'Developer API: keys, usage and cost'], ['help', 'Show this list']] },
  { group: 'Answers', items: [['yes / accept', 'Accept the estimate on screen'], ['no / cancel', 'Dismiss it']] },
];
