// Minimal simulated rippled JSON-RPC (ports 5005 & 5006) for testing the panel WITHOUT a real chain.
// Models: genesis supply, reserves, fees, trust lines, DefaultRipple, IOU issue/transfer/burn, ledger closes every 1s.
// It validates the PANEL's logic only. It does not prove anything about real rippled behaviour.
const http = require('http'), crypto = require('crypto');
const A = require('./addr');
let X = null; try { X = require('xrpl'); } catch {}   // with xrpl installed the mock uses REAL XRPL keys, so offline-signed blobs can be verified
const sha = b => crypto.createHash('sha256').update(b).digest();
const NETID = +process.env.MOCK_NETWORK_ID || 4242;   // MOCK_NETWORK_ID=1 simulates XRPL itself (no NetworkID field allowed)
const GEN_PASS = process.env.GENESIS_PASSPHRASE || 'test-genesis-secret-xyz';
const RESERVE = 100_000n, OWNER = 20_000n, FEE = 1n, MICRO = 1_000_000n;
const toMicro = s => { const [i, f = ''] = String(s).split('.'); return BigInt(i) * MICRO + BigInt(f.padEnd(6, '0').slice(0, 6)); };
const fromMicro = m => { const neg = m < 0n; if (neg) m = -m; const i = m / MICRO, f = (m % MICRO).toString().padStart(6, '0').replace(/0+$/, ''); return (neg ? '-' : '') + i + (f ? '.' + f : ''); };

const S = { issuances: new Map(), feats: null, accounts: new Map(), seeds: new Map(), ledgers: new Map(), pending: [], txs: new Map(), burned: 0n, start: Date.now() };
function mkWallet(passphrase) {
  if (X) {
    const w = passphrase ? X.Wallet.fromEntropy(crypto.createHash('sha512').update(passphrase).digest().subarray(0, 16), { algorithm: X.ECDSA.secp256k1 }) : X.Wallet.generate(X.ECDSA.secp256k1);
    S.seeds.set(w.seed, w.classicAddress); return { account_id: w.classicAddress, master_seed: w.seed, key_type: 'secp256k1' };
  }
  const id = passphrase ? sha('pass:' + passphrase).slice(0, 20) : crypto.randomBytes(20);
  const seed = passphrase ? 's' + sha('seed:' + passphrase).toString('hex').slice(0, 28) : 's' + crypto.randomBytes(14).toString('hex');
  const addr = A.encodeAccount(id, 0); S.seeds.set(seed, addr);
  return { account_id: addr, master_seed: seed, key_type: 'secp256k1' };
}
const genesis = mkWallet(GEN_PASS);
S.nftOffers = S.nftOffers || [];
S.accounts.set(genesis.account_id, { bal: 10_000_000_000n * MICRO, seq: 1, owner: 0, flags: 0, lines: new Map(), mpts: new Map(), nfts: [] });
const closeTime = ms => Math.floor((ms - 946684800000) / 1000);
function closeLedger() {
  const seq = S.ledgers.size + 1, parent = S.ledgers.get(seq - 1);
  const txs = S.pending.splice(0); const hash = sha(`L${seq}${Math.random()}`).toString('hex').toUpperCase();
  const l = { seq, hash, parent: parent ? parent.hash : '0'.repeat(64), close: Date.now(), txs };
  txs.forEach(h => { S.txs.get(h).ledger = seq; }); l.snap = { accounts: structuredClone(S.accounts), amms: structuredClone(S.amms) }; S.ledgers.set(seq, l); const old = S.ledgers.get(seq - 800); if (old) delete old.snap;
}
for (let i = 0; i < 3; i++) closeLedger(); setInterval(closeLedger, 1000);

function applyTx(addr, tx) {
  const a = S.accounts.get(addr); if (!a) return 'terNO_ACCOUNT';
  if (a.bal < FEE) return 'terINSUF_FEE_B';
  const reserve = RESERVE + OWNER * BigInt(a.owner);
  const line = (acct, issuer, cur) => acct.lines.get(issuer + '|' + cur);
  if (tx.TransactionType === 'AccountSet') { if (tx.SetFlag === 8) a.flags |= 8; }
  else if (tx.TransactionType === 'TrustSet') {
    const { currency, issuer, value } = tx.LimitAmount, k = issuer + '|' + currency;
    if (!a.lines.has(k)) { if (a.bal - FEE < reserve + OWNER) return 'tecINSUF_RESERVE_LINE'; a.lines.set(k, { bal: 0n, limit: 0n }); a.owner++; }
    a.lines.get(k).limit = toMicro(value);
  } else if (tx.TransactionType === 'Payment') {
    const dest = S.accounts.get(tx.Destination);
    if (tx.Amount && tx.Amount.mpt_issuance_id) {
      const i = S.issuances.get(tx.Amount.mpt_issuance_id), v = BigInt(tx.Amount.value); if (!i) return 'tecOBJECT_NOT_FOUND'; if (!dest || !dest.mpts.has(tx.Amount.mpt_issuance_id)) return 'tecNO_AUTH';
      if (addr === i.issuer) { if (i.out + v > i.max) return 'tecPATH_PARTIAL'; i.out += v; dest.mpts.set(tx.Amount.mpt_issuance_id, dest.mpts.get(tx.Amount.mpt_issuance_id) + v); }
      else return 'tecNO_PERMISSION';
    } else if (typeof tx.Amount === 'string') {
      const amt = BigInt(tx.Amount);
      if (!dest && amt < RESERVE) return 'tecNO_DST_INSUF_XRP';
      if (a.bal - FEE - amt < reserve) return 'tecUNFUNDED_PAYMENT';
      a.bal -= amt; if (dest) dest.bal += amt; else S.accounts.set(tx.Destination, { bal: amt, seq: 1, owner: 0, flags: 0, lines: new Map(), mpts: new Map(), nfts: [] });
    } else {
      const { currency, issuer, value } = tx.Amount, v = toMicro(value), k = issuer + '|' + currency;
      if (!dest) return 'tecNO_DST';
      if (addr === issuer) {                                   // issue
        const dl = line(dest, issuer, currency); if (!dl) return 'tecPATH_DRY'; if (dl.bal + v > dl.limit) return 'tecPATH_PARTIAL'; dl.bal += v;
      } else {
        const sl = a.lines.get(k); if (!sl) return 'tecPATH_DRY'; if (sl.bal < v) return 'tecPATH_PARTIAL';
        if (tx.Destination === issuer) sl.bal -= v;            // burn
        else {
          const iss = S.accounts.get(issuer); if (!iss || !(iss.flags & 8)) return 'tecPATH_DRY';   // needs DefaultRipple
          const dl = line(dest, issuer, currency); if (!dl) return 'tecPATH_DRY'; if (dl.bal + v > dl.limit) return 'tecPATH_PARTIAL';
          sl.bal -= v; dl.bal += v;
        }
      }
    }
  } else if (tx.TransactionType === 'MPTokenIssuanceCreate') {
    if (!S.feats[featHash('MPTokensV1')].enabled) return 'temDISABLED';
    const id = mptIdOf(a.seq, addr); if (a.bal - FEE < reserve + OWNER) return 'tecINSUFFICIENT_RESERVE';
    S.issuances.set(id, { issuer: addr, max: BigInt(tx.MaximumAmount), out: 0n, scale: tx.AssetScale || 0, flags: tx.Flags || 0, meta: tx.MPTokenMetadata || '' }); a.owner++; tx._mptId = id;
  } else if (tx.TransactionType === 'MPTokenAuthorize') {
    const i = S.issuances.get(tx.MPTokenIssuanceID); if (!i) return 'tecOBJECT_NOT_FOUND'; if (a.mpts.has(tx.MPTokenIssuanceID)) return 'tecDUPLICATE'; a.mpts.set(tx.MPTokenIssuanceID, 0n); a.owner++;
  } else if (tx.TransactionType === 'NFTokenMint') {
    if (!S.feats[featHash('NonFungibleTokensV1_1')].enabled) return 'temDISABLED';
    const id = (((tx.Flags || 0) & 0xffff).toString(16).padStart(4, '0') + (tx.TransferFee || 0).toString(16).padStart(4, '0') + Buffer.from(A.decodeAccount(addr).id).toString('hex') + (tx.NFTokenTaxon >>> 0).toString(16).padStart(8, '0') + (a.nfts.length + a.seq).toString(16).padStart(8, '0')).toUpperCase();
    a.nfts.push({ NFTokenID: id, Flags: tx.Flags || 0, Issuer: addr, NFTokenTaxon: tx.NFTokenTaxon, URI: tx.URI, nft_serial: a.nfts.length + a.seq, TransferFee: tx.TransferFee || 0 });
  } else if (tx.TransactionType === 'NFTokenCreateOffer') {
    const sell = !!((tx.Flags || 0) & 1); if (a.bal - FEE < reserve + OWNER) return 'tecINSUFFICIENT_RESERVE';
    if (sell && !a.nfts.find(n => n.NFTokenID === tx.NFTokenID)) return 'tecNO_ENTRY';
    S.nftOffers.push({ index: crypto.randomBytes(32).toString('hex').toUpperCase(), NFTokenID: tx.NFTokenID, Owner: addr, Amount: tx.Amount, Flags: tx.Flags || 0, Destination: tx.Destination, Expiration: tx.Expiration, Holder: tx.Owner }); a.owner++;
  } else if (tx.TransactionType === 'NFTokenCancelOffer') {
    for (const id of tx.NFTokenOffers || []) { const i = S.nftOffers.findIndex(o => o.index === id); if (i >= 0) { const o = S.nftOffers[i]; S.nftOffers.splice(i, 1); const oa = S.accounts.get(o.Owner); if (oa) oa.owner--; } }
  } else if (tx.TransactionType === 'NFTokenAcceptOffer') {
    const id = tx.NFTokenSellOffer || tx.NFTokenBuyOffer, i = S.nftOffers.findIndex(o => o.index === id); if (i < 0) return 'tecOBJECT_NOT_FOUND';
    const o = S.nftOffers[i], sellSide = !!tx.NFTokenSellOffer; const buyer = sellSide ? a : S.accounts.get(o.Owner), seller = sellSide ? S.accounts.get(o.Owner) : a;
    if (o.Destination && o.Destination !== addr) return 'tecNO_PERMISSION';
    const k = seller.nfts.findIndex(n => n.NFTokenID === o.NFTokenID); if (k < 0) return 'tecNO_ENTRY';
    if (typeof o.Amount === 'string') { const amt = BigInt(o.Amount); if (buyer.bal - amt < reserve) return 'tecINSUFFICIENT_FUNDS'; buyer.bal -= amt; seller.bal += amt; }
    buyer.nfts.push(seller.nfts.splice(k, 1)[0]); S.nftOffers.splice(i, 1); const oa = S.accounts.get(o.Owner); if (oa) oa.owner--; tx._nftSale = { id: o.NFTokenID, amount: o.Amount, offer: o.index, from: sellSide ? o.Owner : addr, to: sellSide ? addr : o.Owner };
  } else if (tx.TransactionType === 'OfferCreate') {
    if (a.bal - FEE < reserve + OWNER) return 'tecINSUF_RESERVE_OFFER';
    if (!((tx.Flags || 0) & 0x00020000)) { S.offers.push({ Account: addr, Sequence: tx.Sequence, TakerGets: tx.TakerGets, TakerPays: tx.TakerPays, Flags: tx.Flags || 0 }); a.owner++; }   // IOC never rests
  } else if (tx.TransactionType === 'OfferCancel') {
    const i = S.offers.findIndex(o => o.Account === addr && o.Sequence === tx.OfferSequence); if (i >= 0) { S.offers.splice(i, 1); a.owner--; }
  } else if (tx.TransactionType === 'EscrowCreate') {
    const amt = BigInt(tx.Amount); if (a.bal - FEE - amt < reserve + OWNER) return 'tecUNFUNDED';
    a.bal -= amt; a.owner++; S.escrows.push({ owner: addr, seq: a.seq, dest: tx.Destination, amount: amt, cond: tx.Condition, fa: tx.FinishAfter, ca: tx.CancelAfter });
  } else if (tx.TransactionType === 'EscrowFinish') {
    const i = S.escrows.findIndex(e => e.owner === tx.Owner && e.seq === tx.OfferSequence); if (i < 0) return 'tecNO_TARGET'; const e = S.escrows[i];
    if (e.fa && rNowS() < e.fa) return 'tecNO_PERMISSION'; if (e.ca && rNowS() >= e.ca) return 'tecNO_PERMISSION';
    if (e.cond) { const f = (tx.Fulfillment || '').toUpperCase(); if (!/^A0228020[0-9A-F]{64}$/.test(f) || 'A0258020' + crypto.createHash('sha256').update(Buffer.from(f.slice(8), 'hex')).digest('hex').toUpperCase() + '810120' !== e.cond) return 'tecCRYPTOCONDITION_ERROR'; }
    S.escrows.splice(i, 1); S.accounts.get(e.owner).owner--; S.accounts.get(e.dest).bal += e.amount;
  } else if (tx.TransactionType === 'EscrowCancel') {
    const i = S.escrows.findIndex(e => e.owner === tx.Owner && e.seq === tx.OfferSequence); if (i < 0) return 'tecNO_TARGET'; const e = S.escrows[i];
    if (!e.ca || rNowS() <= e.ca) return 'tecNO_PERMISSION'; S.escrows.splice(i, 1); const o = S.accounts.get(e.owner); o.owner--; o.bal += e.amount;
  } else if (tx.TransactionType === 'CheckCreate') {
    S.checks.push({ index: crypto.randomBytes(32).toString('hex').toUpperCase(), Account: addr, Destination: tx.Destination, SendMax: BigInt(tx.SendMax), Sequence: a.seq, exp: tx.Expiration }); a.owner++;
  } else if (tx.TransactionType === 'CheckCash') {
    const i = S.checks.findIndex(c => c.index === tx.CheckID); if (i < 0) return 'tecNO_ENTRY'; const c = S.checks[i]; if (c.Destination !== addr) return 'tecNO_PERMISSION';
    if (c.exp && rNowS() > c.exp) return 'tecEXPIRED'; const amt = BigInt(tx.Amount); if (amt > c.SendMax) return 'tecPATH_PARTIAL'; const src = S.accounts.get(c.Account);
    if (src.bal - amt < RESERVE) return 'tecPATH_PARTIAL'; src.bal -= amt; a.bal += amt; S.checks.splice(i, 1); src.owner--;
  } else if (/^AMM(Create|Deposit|Withdraw|Vote|Bid|Delete)$/.test(tx.TransactionType)) {
    const t = tx.TransactionType, fee = t === 'AMMCreate' ? OWNER : FEE; if (a.bal < fee) return 'terINSUF_FEE_B';
    const r = ammApply(addr, a, tx, reserve); if (r !== 'tesSUCCESS') return r;
    a.bal -= fee; S.burned += fee; a.seq++; return 'tesSUCCESS';
  } else return 'temUNKNOWN';
  if (tx.TransactionType === 'OfferCreate' && ((tx.Flags || 0) & 0x00020000)) ammCross(addr, a, tx);
  a.bal -= FEE; S.burned += FEE; a.seq++; return 'tesSUCCESS';
}
// ---- AMM (constant product, test only: models pools, LP tokens, deposits, withdrawals, votes, IOC swaps) ----
S.amms = new Map();
const assetOf = x => typeof x === 'string' ? { native: true } : { currency: x.currency, issuer: x.issuer };
const aKey = x => sideKey(typeof x === 'string' ? x : x.value !== undefined ? x : x);
const pairKey = (x, y) => [sideKey(x), sideKey(y)].sort().join('~');
const ammAcct = k => A.encodeAccount(sha('amm' + k).slice(0, 20), 0);
const lpCur = k => '03' + sha('lp' + k).toString('hex').slice(0, 38).toUpperCase();
const isNat = x => typeof x === 'string' || ((x.currency === 'XRP' || x.currency === 'LUMA') && !x.issuer);
const avail = (a, x, reserve) => isNat(x) ? a.bal - reserve : (a.lines.get(x.issuer + '|' + x.currency)?.bal ?? -1n);
function take(a, x, v) { if (isNat(x)) a.bal -= v; else a.lines.get(x.issuer + '|' + x.currency).bal -= v; }
function give(a, x, v) { if (isNat(x)) a.bal += v; else { const k = x.issuer + '|' + x.currency; if (!a.lines.has(k)) { a.lines.set(k, { bal: 0n, limit: 1_000_000_000_000n * MICRO }); a.owner++; } a.lines.get(k).bal += v; } }
const vOf = x => typeof x === 'string' ? BigInt(x) : toMicro(x.value);
const isqrt = n => { if (n < 2n) return n; let x = BigInt(Math.floor(Math.sqrt(Number(n)))); while (x * x > n) x--; while ((x + 1n) * (x + 1n) <= n) x++; return x; };
const protoAsset = x => isNat(x) ? { currency: 'XRP' } : { currency: x.currency, issuer: x.issuer };
const findAmm = (x, y) => S.amms.get(pairKey(x, y));
function ammApply(addr, a, tx, reserve) {
  if (!S.feats[featHash('AMM')].enabled) return 'temDISABLED';
  const t = tx.TransactionType;
  if (t === 'AMMCreate') {
    const A1 = tx.Amount, A2 = tx.Amount2, k = pairKey(A1, A2); if (sideKey(A1) === sideKey(A2)) return 'temBAD_AMM_TOKENS'; if (S.amms.has(k)) return 'tecDUPLICATE';
    if ((tx.TradingFee || 0) > 1000) return 'temBAD_FEE'; const v1 = vOf(A1), v2 = vOf(A2); if (v1 <= 0n || v2 <= 0n) return 'temBAD_AMOUNT';
    for (const [x, v] of [[A1, v1], [A2, v2]]) if (avail(a, x, reserve + OWNER * 2n + OWNER) < v) return 'tecUNFUNDED_AMM';
    take(a, A1, v1); take(a, A2, v2); const acct = ammAcct(k), cur = lpCur(k), lp = isqrt(v1 * v2);
    S.amms.set(k, { key: k, account: acct, a1: protoAsset(A1), a2: protoAsset(A2), r1: v1, r2: v2, lp, cur, fee: tx.TradingFee || 0, holders: new Map([[addr, lp]]), votes: new Map([[addr, tx.TradingFee || 0]]), auction: null, created: Date.now() });
    a.lines.set(acct + '|' + cur, { bal: lp, limit: lp * 1000n }); a.owner++;
  } else {
    const A1 = tx.Asset, A2 = tx.Asset2, p = findAmm(A1, A2); if (!p) return 'terNO_AMM'; const first = sideKey(A1) === sideKey(p.a1);
    const lpl = p.holders.get(addr) || 0n;
    if (t === 'AMMDeposit') {
      let d1 = 0n, d2 = 0n; const am = tx.Amount, am2 = tx.Amount2;
      const mine = (x) => x && (sideKey(x) === sideKey(p.a1) ? 1 : 2);
      if (am && am2) { const x1 = mine(am) === 1 ? vOf(am) : vOf(am2), x2 = mine(am) === 1 ? vOf(am2) : vOf(am); const m = (x1 * p.lp < x2 * p.lp * p.r1 / p.r2 ? x1 * p.lp / p.r1 : x2 * p.lp / p.r2); d1 = m * p.r1 / p.lp; d2 = m * p.r2 / p.lp; var minted = m; }
      else if (am) { const one = mine(am), dx = vOf(am), f = BigInt(Math.round((1 - p.fee / 200000) * 1e6)); const r = one === 1 ? p.r1 : p.r2, eff = dx * f / 1000000n; minted = p.lp * (isqrt((r + eff) * r * 1000000n * 1000000n / (r * r)) - 1000000n) / 1000000n; if (one === 1) d1 = dx; else d2 = dx; }
      else return 'temMALFORMED';
      if (minted <= 0n) return 'tecAMM_INVALID_TOKENS';
      const x1a = p.a1, x2a = p.a2; if (d1 > 0n && avail(a, x1a.currency === 'XRP' && !x1a.issuer ? '0' : x1a, reserve + OWNER * 2n) < d1) return 'tecUNFUNDED_AMM'; if (d2 > 0n && avail(a, x2a.currency === 'XRP' && !x2a.issuer ? '0' : x2a, reserve + OWNER * 2n) < d2) return 'tecUNFUNDED_AMM';
      if (d1 > 0n) take(a, x1a.currency === 'XRP' && !x1a.issuer ? '0' : x1a, d1); if (d2 > 0n) take(a, x2a.currency === 'XRP' && !x2a.issuer ? '0' : x2a, d2);
      p.r1 += d1; p.r2 += d2; p.lp += minted; p.holders.set(addr, lpl + minted);
      const k = p.account + '|' + p.cur; if (!a.lines.has(k)) { a.lines.set(k, { bal: 0n, limit: p.lp * 1000n }); a.owner++; } a.lines.get(k).bal = p.holders.get(addr);
    } else if (t === 'AMMWithdraw') {
      let burn = tx.LPTokenIn ? toMicro(tx.LPTokenIn.value) : 0n; if ((tx.Flags || 0) & 0x00020000) burn = lpl; if (tx.Amount && !tx.LPTokenIn && !((tx.Flags || 0) & 0x00020000)) { const one = sideKey(tx.Amount) === sideKey(p.a1) ? 1 : 2, dx = vOf(tx.Amount), r = one === 1 ? p.r1 : p.r2; if (dx >= r) return 'tecAMM_BALANCE'; burn = p.lp * (1000000n - isqrt((r - dx) * 1000000n * 1000000n / r)) / 1000000n; const rem = one === 1 ? 'r1' : 'r2'; p[rem] -= dx; give(a, one === 1 ? (p.a1.currency === 'XRP' && !p.a1.issuer ? '0' : p.a1) : (p.a2.currency === 'XRP' && !p.a2.issuer ? '0' : p.a2), dx); if (burn > lpl) { p[rem] += dx; take(a, one === 1 ? (p.a1.currency === 'XRP' && !p.a1.issuer ? '0' : p.a1) : (p.a2.currency === 'XRP' && !p.a2.issuer ? '0' : p.a2), dx); return 'tecAMM_INVALID_TOKENS'; } p.lp -= burn; p.holders.set(addr, lpl - burn); a.lines.get(p.account + '|' + p.cur).bal = lpl - burn; return 'tesSUCCESS'; }
      if (burn <= 0n || burn > lpl) return 'tecAMM_INVALID_TOKENS'; const w1 = p.r1 * burn / p.lp, w2 = p.r2 * burn / p.lp;
      give(a, p.a1.currency === 'XRP' && !p.a1.issuer ? '0' : p.a1, w1); give(a, p.a2.currency === 'XRP' && !p.a2.issuer ? '0' : p.a2, w2); p.r1 -= w1; p.r2 -= w2; p.lp -= burn; p.holders.set(addr, lpl - burn);
      const L = a.lines.get(p.account + '|' + p.cur); L.bal = lpl - burn; if (L.bal === 0n) { a.lines.delete(p.account + '|' + p.cur); a.owner--; p.holders.delete(addr); p.votes.delete(addr); }
      if (p.lp === 0n) S.amms.delete(p.key);
    } else if (t === 'AMMVote') {
      if (lpl <= 0n) return 'tecAMM_INVALID_TOKENS'; if ((tx.TradingFee || 0) > 1000) return 'temBAD_FEE'; p.votes.set(addr, tx.TradingFee);
      let tot = 0n, w = 0n; for (const [h, f] of p.votes) { const b = p.holders.get(h) || 0n; tot += b; w += b * BigInt(f); } p.fee = tot ? Number(w / tot) : p.fee;
    } else if (t === 'AMMBid') { if (lpl <= 0n) return 'tecAMM_INVALID_TOKENS'; p.auction = { account: addr, price: tx.BidMax || tx.BidMin || '0', time: Date.now() }; }
    else if (t === 'AMMDelete') { if (p.lp !== 0n) return 'tecAMM_NOT_EMPTY'; S.amms.delete(p.key); }
  }
  return 'tesSUCCESS';
}
function ammCross(addr, a, tx) {   // IOC offer against the pool: fill as much as the limit price allows
  const G = tx.TakerGets, P = tx.TakerPays, p = findAmm(G, P); if (!p) return; const gIs1 = sideKey(G) === sideKey(p.a1), x = gIs1 ? p.r1 : p.r2, y = gIs1 ? p.r2 : p.r1;
  const f = BigInt(Math.round((1 - p.fee / 100000) * 1e6)), g = vOf(G), pp = vOf(P); if (pp <= 0n || g <= 0n) return;
  const lim = (y * f * g / pp - x * 1000000n) / f; let dx = lim < g ? lim : g; if (dx <= 0n) return; const eff = dx * f / 1000000n, out = y * eff / (x + eff); if (out <= 0n) return;
  const gA = isNat(G) ? '0' : G, pA = isNat(P) ? '0' : P; if (avail(a, gA, RESERVE) < dx) return;
  take(a, gA, dx); give(a, pA, out); if (gIs1) { p.r1 += dx; p.r2 -= out; } else { p.r2 += dx; p.r1 -= out; }
}
const ammInfo = p => { const nat = x => x.currency === 'XRP' && !x.issuer; const am = (x, v) => nat(x) ? String(v) : { currency: x.currency, issuer: x.issuer, value: fromMicro(v) };
  return { account: p.account, amount: am(p.a1, p.r1), amount2: am(p.a2, p.r2), asset_frozen: false, lp_token: { currency: p.cur, issuer: p.account, value: fromMicro(p.lp) }, trading_fee: Math.round(p.fee),
    vote_slots: [...p.votes].map(([account, f]) => ({ account, trading_fee: f, vote_weight: Number((p.holders.get(account) || 0n) * 100000n / (p.lp || 1n)) })), ...(p.auction ? { auction_slot: { account: p.auction.account, price: { currency: p.cur, issuer: p.account, value: String(p.auction.price) } } } : {}) }; };
const txObj = r => ({ ...r.tx, hash: r.hash });
const ledgerBody = (l, p) => ({ ledger_index: String(l.seq), ledger_hash: l.hash, parent_hash: l.parent, close_time: closeTime(l.close),
  close_time_human: new Date(l.close).toISOString().replace('T', ' ').slice(0, 19) + ' UTC', close_time_resolution: 10,
  total_coins: String(10_000_000_000n * MICRO - S.burned), account_hash: l.hash.split('').reverse().join(''), transaction_hash: sha(l.hash).toString('hex').toUpperCase(),
  transactions: p.transactions ? l.txs.map(h => p.expand ? { ...txObj(S.txs.get(h)), metaData: S.txs.get(h).meta } : h) : undefined });

const FEAT_LIST = { NonFungibleTokensV1_1: [true, true], MPTokensV1: [true, true], AMM: [true, true], Clawback: [false, true], DID: [false, true], PriceOracle: [false, true], fixNFTokenRemint: [false, true], DynamicNFT: [false, true], LendingProtocol: [false, false] };
const featHash = n => crypto.createHash('sha512').update(n).digest().subarray(0, 32).toString('hex').toUpperCase();
S.feats = Object.fromEntries(Object.entries(FEAT_LIST).map(([n, [en, sup]]) => [featHash(n), { name: n, enabled: en, supported: sup, vetoed: !en }]));
const mptIdOf = (seq, addr) => { const b = Buffer.alloc(4); b.writeUInt32BE(seq); return Buffer.concat([b, A.decodeAccount(addr).id]).toString('hex').toUpperCase(); };
S.offers = []; S.escrows = []; S.checks = [];
const rNowS = () => Math.floor(Date.now() / 1000) - 946684800;
const sideKey = x => typeof x === 'string' ? 'native' : (x.currency === 'LUMA' || x.currency === 'XRP') && !x.issuer ? 'native' : x.currency + '|' + x.issuer;
const amtN = x => typeof x === 'string' ? Number(x) / 1e6 : Number(x.value);
const methods = {
  // TEST ONLY: synthetic trade history for every native/token pair that has an AMM pool, so chart rendering can be exercised
  book_changes: p => { const seq = +p.ledger_index || S.ledgers.size, ch = []; for (const a of S.amms.values()) { const side = x => typeof x === 'string' || (x && !x.issuer) ? 'XRP_drops' : (x.issuer + '/' + x.currency); const A1 = side(a.a1), A2 = side(a.a2); if (A1 === A2) continue;
      const w = n => 1 + 0.04 * Math.sin(n / 7) + 0.02 * Math.sin(n / 3); const pr = x => (w(x) * 1e-6).toFixed(10); const o = pr(seq - 1), c = pr(seq), hi = Math.max(+o, +c) * 1.01, lo = Math.min(+o, +c) * 0.99;
      if (seq % 3) ch.push({ currency_a: A1, currency_b: A2, volume_a: String(1e6 * (1 + seq % 5)), volume_b: String(1 + seq % 5), high: hi.toFixed(10), low: lo.toFixed(10), open: o, close: c }); }
    return { type: 'bookChanges', ledger_index: seq, ledger_hash: 'AA'.repeat(32), ledger_time: 780000000 + seq * 4, changes: ch }; },
  amm_info: p => { const asset = p.asset, asset2 = p.asset2; let pool; if (p.amm_account) pool = [...S.amms.values()].find(x => x.account === p.amm_account); else pool = findAmm(asset, asset2); return pool ? { amm: ammInfo(pool), validated: true } : { error: 'actNotFound', error_message: 'Account not found.' }; },
  ledger_data: p => { if (p.type === 'nft_page') return { state: [...S.accounts].filter(([, a]) => a.nfts.length).map(([k, a]) => ({ LedgerEntryType: 'NFTokenPage', index: Buffer.from(A.decodeAccount(k).id).toString('hex').toUpperCase() + 'F'.repeat(24), NFTokens: a.nfts.map(n => ({ NFToken: { NFTokenID: n.NFTokenID, URI: n.URI } })) })) };
    if (p.type === 'nft_offer') return { state: S.nftOffers.map(o => ({ LedgerEntryType: 'NFTokenOffer', index: o.index, NFTokenID: o.NFTokenID, Owner: o.Owner, Amount: o.Amount, Flags: o.Flags, Destination: o.Destination, Expiration: o.Expiration })) };
    if (p.type === 'account') return { state: [...S.accounts].map(([k, a]) => ({ LedgerEntryType: 'AccountRoot', Account: k, Balance: a.bal.toString(), Sequence: a.seq, OwnerCount: a.owner })) }; if (p.type === 'amm') return { state: [...S.amms.values()].map(x => ({ LedgerEntryType: 'AMM', Account: x.account, Asset: protoAsset(x.a1), Asset2: protoAsset(x.a2), TradingFee: Math.round(x.fee), LPTokenBalance: { currency: x.cur, issuer: x.account, value: fromMicro(x.lp) } })) }; return { state: [] }; },
  book_offers: p => ({ offers: S.offers.filter(o => sideKey(o.TakerGets) === sideKey(p.taker_gets) && sideKey(o.TakerPays) === sideKey(p.taker_pays))
    .map(o => ({ ...o, LedgerEntryType: 'Offer', quality: String(amtN(o.TakerPays) / amtN(o.TakerGets)), owner_funds: '1000000' })).sort((x, y) => x.quality - y.quality).slice(0, p.limit || 40) }),
  server_info: () => ({ info: { server_state: 'proposing', peers: 3, build_version: '2.3.0-mock', uptime: Math.floor((Date.now() - S.start) / 1000), load_factor: 1,
    validated_ledger: { seq: S.ledgers.size, hash: S.ledgers.get(S.ledgers.size).hash, age: 1, base_fee_xrp: 0.000001, reserve_base_xrp: 0.1, reserve_inc_xrp: 0.02 }, validation_quorum: 4, complete_ledgers: `1-${S.ledgers.size}`, network_id: NETID, pubkey_validator: 'n9mock' } }),
  peers: () => ({ peers: [{ address: '172.18.0.3:51235', public_key: 'n9MockPeerA', version: 'rippled-2.3.0', uptime: 4000, complete_ledgers: '1-' + S.ledgers.size, inbound: false, latency: 4 }, { address: '172.18.0.4:51235', public_key: 'n9MockPeerB', version: 'rippled-2.3.0', uptime: 3900, complete_ledgers: '1-' + S.ledgers.size, inbound: true, latency: 7 }] }),
  consensus_info: () => ({ info: { phase: 'open', ledger_seq: S.ledgers.size + 1, proposers: 0, synched: true, close_granularity: 10, previous_mseconds: 3000, previous_proposers: 3 } }),
  validators: () => ({ validation_quorum: 4, trusted_validator_keys: ['n9mock', 'n9TestVal1', 'n9MockVal2', 'n9MockVal3', 'n9MockVal4', 'n9MockVal5'], local_static_keys: [] }),
  validator_list_sites: () => ({ validator_sites: [] }),
  get_counts: () => ({ uptime: '1 hour', dbKBTotal: 5120, node_writes: 4000, node_reads_total: 1200, Ledger: 30, Transaction: 120, cache_hit_rate: 0.97 }),
  account_currencies: p => ({ send_currencies: [], receive_currencies: [] }),
  fee: () => ({ drops: { base_fee: '1' }, current_queue_size: '0' }),
  feature: p => { if (!p.feature) return { features: S.feats };
    const h = S.feats[p.feature] ? p.feature : Object.keys(S.feats).find(k => S.feats[k].name === p.feature); if (!h) return { error: 'badFeature', error_message: 'Feature unknown or invalid.' };
    if (p.vetoed !== undefined) { if (!S.feats[h].supported) return { error: 'noPermission', error_message: 'unsupported' }; S.feats[h].vetoed = !!p.vetoed; } return { [h]: S.feats[h] }; },
  ledger_current: () => ({ ledger_current_index: S.ledgers.size + 1 }),
  ledger_entry: p => { if (p.mpt_issuance) { const i = S.issuances.get(p.mpt_issuance); return i ? { node: { OutstandingAmount: String(i.out), MaximumAmount: String(i.max), Issuer: i.issuer, AssetScale: i.scale, Flags: i.flags, MPTokenMetadata: i.meta } } : { error: 'entryNotFound' }; }
    if (p.index === '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4') return { node: { Amendments: Object.entries(S.feats).filter(([, f]) => f.enabled).map(([h]) => h) } }; return { error: 'entryNotFound' }; },
  account_nfts: p => { const a = S.accounts.get(p.account); return a ? { account_nfts: a.nfts } : { error: 'actNotFound' }; },
  account_objects: p => { const a = S.accounts.get(p.account); if (!a) return { error: 'actNotFound' };
    if (p.type === 'mpt_issuance') return { account_objects: [...S.issuances].filter(([, i]) => i.issuer === p.account).map(([id, i]) => ({ LedgerEntryType: 'MPTokenIssuance', Issuer: i.issuer, Sequence: parseInt(id.slice(0, 8), 16) })) };
    if (p.type === 'check') return { account_objects: S.checks.filter(c => c.Account === p.account).map(c => ({ LedgerEntryType: 'Check', index: c.index, Sequence: c.Sequence, Destination: c.Destination })) };
    if (p.type === 'mptoken') return { account_objects: [...a.mpts].map(([id, v]) => ({ LedgerEntryType: 'MPToken', MPTokenIssuanceID: id, MPTAmount: String(v) })) }; return { account_objects: [] }; },
  wallet_propose: p => mkWallet(p.passphrase),
  ledger: p => { const i = ['validated', 'closed', 'current'].includes(p.ledger_index) ? S.ledgers.size : +p.ledger_index; const l = S.ledgers.get(i);
    return l ? { ledger: ledgerBody(l, p), ledger_index: l.seq, ledger_hash: l.hash, validated: true } : { error: 'lgrNotFound', error_message: 'ledger not found' }; },
  account_info: p => { const a = S.accounts.get(p.account); return a ? { account_data: { Account: p.account, Balance: a.bal.toString(), Sequence: a.seq, OwnerCount: a.owner, Flags: a.flags } } : { error: 'actNotFound', error_message: 'Account not found.' }; },
  account_lines: p => { const a = S.accounts.get(p.account); if (!a) return { error: 'actNotFound' };
    const own = [...a.lines].map(([k, v]) => { const [issuer, currency] = k.split('|'); return { account: issuer, currency, balance: fromMicro(v.bal), limit: fromMicro(v.limit) }; });
    const rev = []; for (const [addr, h] of S.accounts) if (addr !== p.account) for (const [k, v] of h.lines) { const [iss, cur] = k.split('|'); if (iss === p.account && v.bal !== 0n) rev.push({ account: addr, currency: cur, balance: '-' + fromMicro(v.bal), limit: '0' }); }
    return { lines: own.concat(rev) }; },
  account_offers: p => ({ offers: S.offers.filter(o => o.Account === p.account).map(o => ({ seq: o.Sequence, flags: o.Flags, taker_gets: o.TakerGets, taker_pays: o.TakerPays })) }),
  account_tx: p => ({ transactions: [...S.txs.values()].filter(r => r.ledger && ([r.tx.Account, r.tx.Destination, r.tx.LimitAmount?.issuer].includes(p.account) || (r.amm || []).includes(p.account))).reverse().slice(0, p.limit || 25)
    .map(r => ({ tx: { ...txObj(r), date: r.date, ledger_index: r.ledger }, meta: { ...r.meta, ...(r.tx.TransactionType === 'Payment' ? { delivered_amount: r.tx.Amount } : {}) }, validated: true, ledger_index: r.ledger })) }),
  gateway_balances: p => { const ob = {}; for (const a of S.accounts.values()) for (const [k, v] of a.lines) { const [iss, cur] = k.split('|'); if (iss === p.account) ob[cur] = (ob[cur] || 0n) + v.bal; }
    return { obligations: Object.fromEntries(Object.entries(ob).map(([k, v]) => [k, fromMicro(v)])) }; },
  tx: p => { const r = S.txs.get(String(p.transaction).toUpperCase()); return r ? { ...txObj(r), validated: !!r.ledger, ledger_index: r.ledger, meta: r.meta } : { error: 'txnNotFound', error_message: 'Transaction not found.' }; },
  submit: p => {
    if (p.tx_blob) {
      if (!X) return { error: 'noXrpl', error_message: 'mock needs xrpl installed for tx_blob' };
      let tx; try { tx = X.decode(p.tx_blob); if (!X.verifySignature(p.tx_blob)) return { engine_result: 'temBAD_SIGNATURE', engine_result_message: 'bad signature' }; } catch { return { error: 'invalidParams', error_message: 'bad blob' }; }
      const hash = X.hashes.hashSignedTx(p.tx_blob);
      if (S.txs.has(hash)) return { engine_result: 'tefALREADY', engine_result_message: 'already applied' };
      if (NETID > 1024 ? tx.NetworkID !== NETID : tx.NetworkID != null) return { engine_result: 'telWRONG_NETWORK', engine_result_message: 'wrong network' };
      const a = S.accounts.get(tx.Account); if (!a) return { engine_result: 'terNO_ACCOUNT', engine_result_message: 'no account' };
      if (tx.LastLedgerSequence && tx.LastLedgerSequence < S.ledgers.size) return { engine_result: 'tefMAX_LEDGER', engine_result_message: 'expired' };
      if (tx.Sequence < a.seq) return { engine_result: 'tefPAST_SEQ', engine_result_message: 'past sequence' };
      if (tx.Sequence > a.seq) return { engine_result: 'terPRE_SEQ', engine_result_message: 'missing earlier sequence' };
      const res = applyTracked(tx.Account, { ...tx });
      if (/^te[sc]/.test(res)) { { const mid = tx._mptId; delete tx._mptId; S.txs.set(hash, { hash, tx: { ...tx }, meta: metaOf(res, mid), amm: LASTNODES ? LASTNODES.accts : [], date: closeTime(Date.now()) }); } S.pending.push(hash); }
      return { engine_result: res, engine_result_message: res, tx_json: { ...tx, hash } };
    }
    const addr = S.seeds.get(p.secret); if (!addr) return { error: 'badSecret', error_message: 'Secret does not match any account.' };
    if (NETID > 1024 && p.tx_json && p.tx_json.NetworkID == null) return { engine_result: 'telREQUIRES_NETWORK_ID', engine_result_message: 'Transactions submitted to this node/network must include a correct NetworkID field.' };   // like a real node with network_id > 1024
    if (NETID > 1024 && p.tx_json && +p.tx_json.NetworkID !== NETID) return { engine_result: 'telWRONG_NETWORK_ID', engine_result_message: 'wrong NetworkID' };
    const tx = { ...p.tx_json }; if (tx.Account !== addr) return { error: 'srcActMalformed', error_message: 'Account/secret mismatch' };
    const seq0 = S.accounts.get(addr) ? S.accounts.get(addr).seq : 0; const res = applyTracked(addr, tx); const a = S.accounts.get(addr);
    tx.Fee = String(FEE); tx.Sequence = seq0; if (NETID > 1024) tx.NetworkID = NETID;
    const hash = sha(JSON.stringify(tx) + Math.random()).toString('hex').toUpperCase();
    if (/^te[sc]/.test(res)) { { const mid = tx._mptId; delete tx._mptId; S.txs.set(hash, { hash, tx, meta: metaOf(res, mid), amm: LASTNODES ? LASTNODES.accts : [], date: closeTime(Date.now()) }); } S.pending.push(hash); }
    return { engine_result: res, engine_result_message: res, tx_json: { ...tx, hash } };
  },
};
// metadata: AffectedNodes for every AMM pool whose reserves changed (so clients can read trades from the pool account's history)
let LASTNODES = null;
function applyTracked(addr, tx) {
  const before = new Map([...S.amms.values()].map(p => [p.key, { r1: p.r1, r2: p.r2 }])); const res = applyTx(addr, tx); const nodes = [], accts = [];
  if (res === 'tesSUCCESS') for (const p of S.amms.values()) { const b = before.get(p.key); if (!b || (b.r1 === p.r1 && b.r2 === p.r2)) continue; accts.push(p.account);
    for (const [asset, was, now] of [[p.a1, b.r1, p.r1], [p.a2, b.r2, p.r2]]) { if (was === now) continue;
      if (asset.currency === 'XRP' && !asset.issuer) nodes.push({ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: p.account, Balance: String(now) }, PreviousFields: { Balance: String(was) } } });
      else nodes.push({ ModifiedNode: { LedgerEntryType: 'RippleState', FinalFields: { Balance: { currency: asset.currency, issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: fromMicro(now) }, LowLimit: { issuer: p.account, currency: asset.currency, value: '0' }, HighLimit: { issuer: asset.issuer, currency: asset.currency, value: '0' } }, PreviousFields: { Balance: { value: fromMicro(was) } } } }); } }
  LASTNODES = nodes.length ? { nodes, accts } : null; return res;
}
const metaOf = (res, mid) => ({ TransactionResult: res, ...(mid ? { mpt_issuance_id: mid } : {}), ...(LASTNODES ? { AffectedNodes: LASTNODES.nodes } : {}) });
const servers = {};
const MOCK_PORTS = (process.env.MOCK_PORTS || '5005,5006').split(',').map(Number);
for (const port of MOCK_PORTS) {
  servers[port] = http.createServer((req, res) => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => {
      if (req.url.startsWith('/__down')) { res.end('ok'); servers[+req.url.split('=')[1]].close(); servers[+req.url.split('=')[1]].closeAllConnections?.(); return; }
      let out; try { const j = JSON.parse(d), p = (j.params || [{}])[0] || {}; const li = /^\d+$/.test(String(p.ledger_index)) ? +p.ledger_index : 0, hl = li && li < S.ledgers.size ? S.ledgers.get(li) : null;   // history: serve old state for numeric ledger_index
        if (hl && hl.snap && ['amm_info', 'account_info', 'account_lines', 'gateway_balances', 'ledger_data'].includes(j.method)) { const sv = { accounts: S.accounts, amms: S.amms }; S.accounts = hl.snap.accounts; S.amms = hl.snap.amms; try { out = methods[j.method](p); } finally { S.accounts = sv.accounts; S.amms = sv.amms; } }
        else if (li && li > S.ledgers.size + 1 && !['ledger_current'].includes(j.method)) out = { error: 'lgrNotFound', error_message: 'ledgerNotFound' };
        else if (li && !S.ledgers.get(li) && j.method !== 'ledger_current') out = { error: 'lgrNotFound', error_message: 'ledgerNotFound' };
        else out = methods[j.method] ? methods[j.method](p) : { error: 'unknownCmd' }; } catch (e) { out = { error: 'internal', error_message: String(e) }; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: { status: out.error ? 'error' : 'success', ...out } }));
    });
  }).listen(port, '127.0.0.1');
}
console.log('mock rippled on', MOCK_PORTS.join(','), '; genesis', genesis.account_id);
