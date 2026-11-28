// Currencies, metals and ANTX: readable labels and groups for the tokens the Genesis wallet mints from the control panel catalog.
export const CURRENCIES: Record<string, string> = { EUR: 'Euro', GBP: 'British pound', JPY: 'Japanese yen', CAD: 'Canadian dollar', AUD: 'Australian dollar', CHF: 'Swiss franc', CNY: 'Chinese yuan', HKD: 'Hong Kong dollar', SGD: 'Singapore dollar', NZD: 'New Zealand dollar', MXN: 'Mexican peso', BRL: 'Brazilian real', INR: 'Indian rupee', KRW: 'South Korean won', ZAR: 'South African rand', AED: 'UAE dirham', SAR: 'Saudi riyal', TRY: 'Turkish lira', PHP: 'Philippine peso', THB: 'Thai baht' };
export const METALS: Record<string, string> = { GOLD: 'Gold', SILVER: 'Silver', COPPER: 'Copper', PLATINUM: 'Platinum' };
export const OTHERS: Record<string, string> = { ANTX: 'Anthropic' };
const up = (n: string) => String(n || '').toUpperCase();
export const isCurrency = (n: string) => Object.prototype.hasOwnProperty.call(CURRENCIES, up(n));
export const isMetal = (n: string) => Object.prototype.hasOwnProperty.call(METALS, up(n));
/** readable name of a catalog token, or '' for any other token */
export const labelOf = (n: string): string => CURRENCIES[up(n)] || METALS[up(n)] || OTHERS[up(n)] || '';
/** the group a catalog token belongs to, or '' */
export const groupOf = (n: string): '' | 'currencies' | 'metals' => (isCurrency(n) ? 'currencies' : isMetal(n) ? 'metals' : '');
