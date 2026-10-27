export interface NetworkDef {
  id: 'main' | 'test' | 'xrpl-main' | 'xrpl-test';
  name: string;
  url: string;
  fallbacks: string[];
  prefix: string;
  native: string;
  networkId: number;
  faucet?: string;
  fund?: string;
  rpc?: string;
  isXrpl?: boolean;
}

export interface AccountData {
  id: string;
  label: string;
  seed: string;
  address: string; // r-address or L-address
  type: 'luma' | 'xrpl';
  xrplLinkedAddress?: string;
  xrplLinkedActivated?: boolean;
}

export interface VaultState {
  data: {
    accounts: AccountData[];
    active: string | null;
  };
  key: CryptoKey;
  salt: Uint8Array;
  iter: number;
}

export interface StoredVault {
  v: number;
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

export interface TradingPair {
  b: { c: string; i?: string }; // Base
  q: { c: string; i?: string }; // Quote
}

export interface AppConfig {
  net: 'main' | 'test' | 'xrpl-main' | 'xrpl-test';
  urls: Record<string, string>;
  usd: Record<string, number>;
  book: Array<{ name: string; addr: string }>;
  lockMin: number;
  pairs: Record<string, TradingPair[]>;
  pair: Record<string, string>;
}

export interface AmmPool {
  id: string;
  a1: { c: string; i?: string };
  a2: { c: string; i?: string };
  r1: number;
  r2: number;
  fee: number; // in percentage e.g. 0.3
  price: number;
  lpSupply: number;
  account: string;
  volume24h?: number;
  trades24h?: number;
  votesCount?: number;
}

export interface NetworkTx {
  hash: string;
  type: string;
  from: string;
  to?: string;
  detail: string;
  amount?: string;
  fee: string;
  result: string;
  ledger: number;
  time: string;
  isGenesis?: boolean;
  raw?: any;
}

export interface NFTItem {
  id: string;
  NFTokenID: string;
  URI?: string;
  NFTokenTaxon: number;
  Flags: number;
  TransferFee?: number;
  Issuer: string;
  nft_serial?: number;
  price?: string;
  forSale?: boolean;
}
