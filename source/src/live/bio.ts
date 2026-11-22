// Face ID / Touch ID / device-PIN unlock (WebAuthn passkey with the PRF extension).
// The password stays the real key. After the password is typed once, it is sealed with a secret that only this device's
// passkey (unlocked by Face ID) can produce, and stored in this browser. The password always keeps working.
const K = 'starsky.bio';
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const rec = (): { cid: string; salt: string; iv: string; ct: string; host: string } | null => { try { const j = JSON.parse(localStorage.getItem(K) || 'null'); return j && j.cid && j.host === location.hostname ? j : null; } catch { return null; } };

export const enabled = () => !!rec();
export async function supported(): Promise<boolean> {
  try { return !!(window.PublicKeyCredential && (window.isSecureContext) && (await (PublicKeyCredential as any).isUserVerifyingPlatformAuthenticatorAvailable())); } catch { return false; }
}
async function prf(cid: Uint8Array | null, salt: Uint8Array): Promise<Uint8Array> {
  const ext: any = { prf: { eval: { first: salt } } };
  const cred: any = await navigator.credentials.get({ publicKey: { challenge: rnd(32), rpId: location.hostname, userVerification: 'required', timeout: 60000, allowCredentials: cid ? [{ id: cid as BufferSource, type: 'public-key' }] : [], extensions: ext } as any });
  const r = cred && cred.getClientExtensionResults && cred.getClientExtensionResults().prf;
  if (!r || !r.results || !r.results.first) throw new Error('This phone or browser cannot unlock with Face ID here. Use the password.');
  return new Uint8Array(r.results.first);
}
const aes = (raw: Uint8Array) => crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);

// password must already be verified by the caller
export async function enable(password: string): Promise<void> {
  if (!(await supported())) throw new Error('Face ID is not available on this device or browser.');
  const salt = rnd(32);
  const created: any = await navigator.credentials.create({ publicKey: {
    challenge: rnd(32), rp: { name: 'Starsky wallet', id: location.hostname }, user: { id: rnd(16), name: 'starsky', displayName: 'Starsky wallet' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' }, timeout: 60000,
    extensions: { prf: {} } as any } as any });
  if (!created) throw new Error('Face ID setup was cancelled.');
  const cid = new Uint8Array(created.rawId);
  const sec = await prf(cid, salt);   // a second Face ID prompt: proves it works before anything is saved
  const iv = rnd(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(sec), enc.encode(password)));
  localStorage.setItem(K, JSON.stringify({ cid: b64(cid), salt: b64(salt), iv: b64(iv), ct: b64(ct), host: location.hostname }));
}
export async function unlockPassword(): Promise<string> {
  const r = rec(); if (!r) throw new Error('Face ID is not set up on this device.');
  const sec = await prf(unb64(r.cid), unb64(r.salt));
  try { return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(r.iv) }, await aes(sec), unb64(r.ct))); }
  catch { throw new Error('Face ID could not open the wallet. Use the password.'); }
}
export function disable() { try { localStorage.removeItem(K); } catch {} }
