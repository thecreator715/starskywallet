// NFT loan escrow: builds the exact transactions for each step and checks them. Pure and tested; nothing is signed or sent here.
// Design: each loan gets its own escrow account. Its master key is disabled and it is controlled only by a signer list of
// borrower, lender and a neutral operator (quorum 2): nobody can move the NFT alone. Repayment is released by borrower + lender
// (or operator after proof of payment); a missed deadline is released to the lender by lender + operator.
// The XRP Ledger cannot enforce a deadline by itself, so the operator co-signature after the deadline is the one trusted step.
// The operator co-signing service is not part of this wallet yet: the plan and checks below are what it will use.
export const TF_TRANSFERABLE = 8, ASF_DISABLE_MASTER = 4, ASF_DEPOSIT_AUTH = 9;
export interface Agreement { id: string; nft: string; borrower: string; lender: string; operator: string; escrow: string; principal: number; repay: number; dueAt: number; graceUntil: number; native: string }
const sorted = (a: Array<{ SignerEntry: { Account: string; SignerWeight: number } }>) => [...a].sort((x, y) => x.SignerEntry.Account.localeCompare(y.SignerEntry.Account));
/** step 1: make the escrow account safe. Order matters: set the signer list first, then disable the master key. */
export function setupTxs(a: Pick<Agreement, 'escrow' | 'borrower' | 'lender' | 'operator'>) {
  return [
    { TransactionType: 'SignerListSet', Account: a.escrow, SignerQuorum: 2, SignerEntries: sorted([a.borrower, a.lender, a.operator].map(x => ({ SignerEntry: { Account: x, SignerWeight: 1 } }))) },
    { TransactionType: 'AccountSet', Account: a.escrow, SetFlag: ASF_DEPOSIT_AUTH },
    { TransactionType: 'AccountSet', Account: a.escrow, SetFlag: ASF_DISABLE_MASTER }
  ];
}
/** step 2: the borrower hands the NFT to the escrow with a zero-price offer only the escrow can accept (then the escrow accepts) */
export const lockOffer = (a: Pick<Agreement, 'nft' | 'borrower' | 'escrow'>) => ({ TransactionType: 'NFTokenCreateOffer', Account: a.borrower, NFTokenID: a.nft, Amount: '0', Destination: a.escrow, Flags: 1 });
/** step 3: the lender sends the principal to the borrower */
export const fundTx = (a: Pick<Agreement, 'lender' | 'borrower' | 'principal'>, drops: (n: number) => string) => ({ TransactionType: 'Payment', Account: a.lender, Destination: a.borrower, Amount: drops(a.principal) });
/** repayment: borrower pays the lender the full amount */
export const repayTx = (a: Pick<Agreement, 'lender' | 'borrower' | 'repay'>, drops: (n: number) => string) => ({ TransactionType: 'Payment', Account: a.borrower, Destination: a.lender, Amount: drops(a.repay) });
/** release to someone: the escrow offers the NFT at zero price to that wallet (needs two signatures) */
export const releaseOffer = (a: Pick<Agreement, 'nft' | 'escrow'>, to: string) => ({ TransactionType: 'NFTokenCreateOffer', Account: a.escrow, NFTokenID: a.nft, Amount: '0', Destination: to, Flags: 1 });
export type Release = 'to-borrower' | 'to-lender';
/** who must co-sign a release, and whether it is allowed at this time */
export function releaseRule(a: Pick<Agreement, 'dueAt' | 'graceUntil' | 'borrower' | 'lender' | 'operator'>, kind: Release, now: number, repaid: boolean): { allowed: boolean; signers: string[]; why: string } {
  if (kind === 'to-borrower') return repaid ? { allowed: true, signers: [a.borrower, a.lender], why: 'Repaid: the lender agrees to return the NFT (or the operator, on proof of payment).' } : { allowed: false, signers: [], why: 'Not repaid yet. The NFT stays locked until the lender is paid.' };
  if (repaid) return { allowed: false, signers: [], why: 'The loan was repaid. The NFT goes back to the borrower.' };
  return now > a.graceUntil ? { allowed: true, signers: [a.lender, a.operator], why: 'The deadline and grace period have passed without repayment.' } : { allowed: false, signers: [], why: `The lender cannot claim before the deadline plus grace (${new Date(a.graceUntil).toISOString().slice(0, 10)}).` };
}
/** check that an escrow account really is locked down the way the agreement says; run this on its account_info and signer list */
export function verifyEscrow(info: { flags?: number; regularKey?: string | null; signers?: Array<{ account: string; weight: number }>; quorum?: number; depositAuth?: boolean }, a: Pick<Agreement, 'borrower' | 'lender' | 'operator'>): { ok: boolean; problems: string[] } {
  const p: string[] = [], want = new Set([a.borrower, a.lender, a.operator]);
  if (!((info.flags || 0) & 0x00100000)) p.push('The escrow account\'s own key is still enabled: its creator could move the NFT alone.');
  if (info.regularKey) p.push('The escrow account has a regular key set: that key could move the NFT alone.');
  if (info.quorum !== 2) p.push('The signer quorum must be 2.');
  const s = info.signers || []; if (s.length !== 3 || !s.every(x => want.has(x.account) && x.weight === 1)) p.push('The signer list must be exactly the borrower, the lender and the operator with weight 1 each.');
  if (!info.depositAuth) p.push('Deposit authorization is off: strangers could send things to the escrow.');
  return { ok: !p.length, problems: p };
}
/** a fingerprint of the agreement both sides sign off-chain (and the operator checks), so nobody can change a term later */
export async function agreementHash(a: Agreement): Promise<string> {
  const o: any = {}; for (const k of Object.keys(a).sort()) o[k] = (a as any)[k];
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(o)));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
/** the order a loan goes through, for the progress list */
export const STEPS = ['Create and lock down the escrow account', 'Borrower locks the NFT in the escrow', 'Lender sends the loan', 'Borrower repays, or the deadline passes', 'The NFT is released'];
export const stepNow = (s: { setup: boolean; locked: boolean; funded: boolean; repaid: boolean; released: boolean }) => s.released ? 5 : s.repaid ? 4 : s.funded ? 3 : s.locked ? 2 : s.setup ? 1 : 0;
