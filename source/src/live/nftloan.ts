// NFT-backed loans: the rules engine. Pure and tested. The NFT is locked in a per-loan escrow wallet that the borrower funds;
// the lender sends the principal; on time repayment returns the NFT, a missed deadline lets the lender claim it.
// This module decides and explains; moving the NFT needs the escrow step, which is testnet-first (see state 'needs-escrow').
export interface Terms { principal: number; aprPct: number; days: number; valuation: number; maxLtvPct?: number; graceDays?: number }
export type LoanState = 'draft' | 'offered' | 'funded' | 'repaid' | 'overdue' | 'claimable' | 'defaulted' | 'cancelled';
export const MAX_LTV = 50;
/** loan to value in percent */
export const ltv = (principal: number, valuation: number) => valuation > 0 ? +(principal / valuation * 100).toFixed(2) : Infinity;
export const maxPrincipal = (valuation: number, maxLtvPct = MAX_LTV) => +(Math.max(0, valuation) * maxLtvPct / 100).toFixed(6);
/** simple interest for the term; no compounding, no hidden fee */
export const interest = (t: Pick<Terms, 'principal' | 'aprPct' | 'days'>) => +(t.principal * t.aprPct / 100 * t.days / 365).toFixed(6);
export const repayAmount = (t: Pick<Terms, 'principal' | 'aprPct' | 'days'>) => +(t.principal + interest(t)).toFixed(6);
/** valuation guard: the lowest of floor, last sale and an owner estimate, so one high number cannot inflate the loan */
export const safeValuation = (floor: number | null, lastSale: number | null, estimate: number | null) => { const v = [floor, lastSale, estimate].filter((x): x is number => x != null && x > 0); return v.length ? Math.min(...v) : null; };
export function validate(t: Terms): { ok: boolean; problems: string[]; warnings: string[] } {
  const p: string[] = [], w: string[] = [], cap = t.maxLtvPct ?? MAX_LTV;
  if (!(t.principal > 0)) p.push('The loan amount must be above 0.'); if (!(t.valuation > 0)) p.push('There is no valuation for this NFT yet.');
  if (!(t.days >= 1 && t.days <= 365)) p.push('The term must be 1 to 365 days.'); if (!(t.aprPct >= 0 && t.aprPct <= 200)) p.push('Interest must be between 0% and 200% a year.');
  if (t.valuation > 0 && ltv(t.principal, t.valuation) > cap) p.push(`Loan to value ${ltv(t.principal, t.valuation)}% is above the ${cap}% limit. The most for this NFT is ${maxPrincipal(t.valuation, cap)}.`);
  if (t.valuation > 0 && ltv(t.principal, t.valuation) > cap * 0.8 && !p.length) w.push('Close to the limit: a small fall in the NFT price leaves the lender under-covered.');
  if (t.aprPct > 60) w.push('A very high rate. Check it is per year, not per month.');
  return { ok: !p.length, problems: p, warnings: w };
}
/** where a loan stands at a time. dueAt = fundedAt + days. */
export function stateAt(l: { state: LoanState; fundedAt?: number; days: number; graceDays?: number }, now: number): LoanState {
  if (l.state !== 'funded' && l.state !== 'overdue' && l.state !== 'claimable') return l.state;
  const due = (l.fundedAt ?? now) + l.days * 864e5, grace = due + (l.graceDays ?? 1) * 864e5;
  return now <= due ? 'funded' : now <= grace ? 'overdue' : 'claimable';
}
export const dueAt = (fundedAt: number, days: number) => fundedAt + days * 864e5;
/** what the borrower can do now, in plain words */
export function actions(state: LoanState, role: 'borrower' | 'lender'): string[] {
  const a: Record<string, string[]> = {
    'borrower:offered': ['Cancel the request'], 'lender:offered': ['Fund the loan', 'Decline'],
    'borrower:funded': ['Repay now'], 'lender:funded': ['Wait for repayment'],
    'borrower:overdue': ['Repay now (in the grace period)'], 'lender:overdue': ['Wait: grace period'],
    'borrower:claimable': ['Repay now if the lender has not claimed yet'], 'lender:claimable': ['Claim the NFT']
  };
  return a[role + ':' + state] || [];
}
/** health: how far the NFT price can fall before the lender is under-covered (positive = safe room) */
export const cushionPct = (principalOwed: number, valuationNow: number) => valuationNow > 0 ? +((1 - principalOwed / valuationNow) * 100).toFixed(2) : -100;
export const risk = (cushion: number) => cushion >= 40 ? 'low' : cushion >= 15 ? 'medium' : 'high';
/** lender's view: return if repaid, and if defaulted what the NFT must be worth to break even */
export function lenderView(t: Terms) { const r = repayAmount(t); return { ifRepaid: +(r - t.principal).toFixed(6), breakEvenValue: t.principal, apr: t.aprPct, coverage: +(t.valuation / t.principal).toFixed(2) }; }
/** plain-words summary shown before either side signs */
export function summary(t: Terms, nftName: string, native = 'LUMA') { const v = validate(t); return `${v.ok ? '' : 'NOT ALLOWED: ' + v.problems.join(' ') + '\n'}Borrow ${t.principal} ${native} against ${nftName} for ${t.days} days at ${t.aprPct}% a year. Repay ${repayAmount(t)} ${native} (interest ${interest(t)}). Loan to value ${ltv(t.principal, t.valuation)}%. If it is not repaid by the deadline plus ${t.graceDays ?? 1} day${(t.graceDays ?? 1) === 1 ? '' : 's'} grace, the lender may take the NFT and keeps the ${t.principal} ${native}. There is no other claim on you.`; }
