// Bridge between the live-data modules and the app: the app fills this in at start-up.
export interface Ctx {
  req: (command: string, params?: any) => Promise<any>; // returns the `result` object, throws on RPC error
  online: () => boolean;
  native: () => string; // 'LUMA'
  netKey: () => string; // 'main' | 'test'
  account: () => string | undefined; // active wallet, classic r-address
  show: (r: string) => string; // classic -> L/T display address
  toClassic: (a: string) => string; // any accepted address -> classic
  usdName: () => string; // currency symbol treated as the dollar token
  submit: (tx: any) => Promise<{ ok: boolean; msg?: string; hash?: string }>;
  toast: (m: string, bad?: boolean) => void;
  rerender: () => void;
  wallets: () => Array<{ label: string; address: string; seed: string; type: 'luma' | 'xrpl' }>; // classic addresses
  nodeUrl: () => string;
  submitAs: (seed: string, tx: any) => Promise<{ ok: boolean; msg?: string; hash?: string }>;
  addWallet: (label: string, seed: string, address: string) => Promise<void>;
  modal: (html: string) => void;
  closeModal: () => void;
  showL: (r: string) => string; // classic -> L/T address of the active LUMA network
  xrpl: () => boolean; // true while the XRPL wallet tab is active: every read and write goes to the XRPL node
}
const nope = () => {
  throw new Error('not connected');
};
export const ctx: Ctx = {
  req: nope as any,
  online: () => false,
  native: () => 'LUMA',
  netKey: () => 'main',
  account: () => undefined,
  show: r => r,
  toClassic: a => a,
  usdName: () => 'USD',
  submit: nope as any,
  toast: () => {},
  rerender: () => {},
  wallets: () => [],
  nodeUrl: () => '',
  submitAs: nope as any,
  addWallet: nope as any,
  modal: () => {},
  closeModal: () => {},
  showL: r => r,
  xrpl: () => false,
};
export const setCtx = (c: Partial<Ctx>) => Object.assign(ctx, c);
