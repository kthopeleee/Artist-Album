// Encryption for the Drawings vault. Everything happens in the browser; the
// password never leaves the device and is never stored.
//
// Keys:
//  - a random "vault key" (AES-256-GCM) encrypts every file and the file list;
//  - the password (PBKDF2, 600k rounds) locks a copy of the vault key, stored in vault.json;
//  - Touch ID (WebAuthn) can unlock a per-device copy, so you don't type the password every time.
//    With the PRF feature (Safari, Chrome) the fingerprint itself protects that copy.
//    Without it (Firefox), the key is kept in this browser and Touch ID guards it.

const enc = new TextEncoder();
const ITERATIONS = 600_000;
const DEVICE_PREF = 'artist-album.vault-touchid';
const random = n => crypto.getRandomValues(new Uint8Array(n));

export function toB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const gcm = (iv, aad) => (aad ? { name: 'AES-GCM', iv, additionalData: enc.encode(aad) } : { name: 'AES-GCM', iv });

// Encrypts bytes; output = 12-byte IV + ciphertext. `aad` ties the data to its
// place (e.g. "file-id:part-3") so parts can't be swapped around.
export async function seal(key, data, aad) {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt(gcm(iv, aad), key, data);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return out;
}

export async function open(key, data, aad) {
  const bytes = new Uint8Array(data);
  return crypto.subtle.decrypt(gcm(bytes.subarray(0, 12), aad), key, bytes.subarray(12));
}

export const newVaultKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

async function passwordKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// The lock stored in vault.json: the vault key, encrypted with the password.
export async function makeLock(password, vaultKey) {
  const salt = random(16);
  const raw = await crypto.subtle.exportKey('raw', vaultKey);
  const wrapped = await seal(await passwordKey(password, salt, ITERATIONS), raw, 'vault-key');
  return { kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: toB64(salt), wrappedKey: toB64(wrapped) };
}

export async function unlockWithPassword(lock, password) {
  const pk = await passwordKey(password, fromB64(lock.salt), lock.iterations);
  let raw;
  try {
    raw = await open(pk, fromB64(lock.wrappedKey), 'vault-key');
  } catch {
    throw new Error('Wrong password.');
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

// ---- Touch ID (per device) ------------------------------------------------------

let keyDb;
function deviceDb() {
  keyDb ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('artist-album-vault', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return keyDb;
}
async function dbPut(name, value) {
  const store = (await deviceDb()).transaction('keys', 'readwrite').objectStore('keys');
  await new Promise((res, rej) => { const r = store.put(value, name); r.onsuccess = res; r.onerror = () => rej(r.error); });
}
async function dbGet(name) {
  const store = (await deviceDb()).transaction('keys').objectStore('keys');
  return new Promise(res => { const r = store.get(name); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
}
async function dbDelete(name) {
  try { (await deviceDb()).transaction('keys', 'readwrite').objectStore('keys').delete(name); } catch {}
}

export async function touchIdAvailable() {
  try {
    return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export function touchIdSetup() {
  try { return JSON.parse(localStorage.getItem(DEVICE_PREF) || 'null'); } catch { return null; }
}

async function prfSecret(credId, salt) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [{ type: 'public-key', id: fromB64(credId) }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const first = assertion.getClientExtensionResults?.().prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

async function keyFromSecret(secret) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('artist-album drawings vault') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Returns 'fingerprint' (PRF: the key is protected by the fingerprint) or
// 'browser' (the key is stored in this browser and Touch ID guards it).
export async function enableTouchId(vaultKey, vaultId) {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Artist Album drawings' },
      user: { id: random(16), name: 'drawings-vault', displayName: 'Artist Album drawings' },
      challenge: random(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60_000,
      extensions: { prf: {} },
    },
  });
  const credId = toB64(cred.rawId);
  const raw = await crypto.subtle.exportKey('raw', vaultKey);
  if (cred.getClientExtensionResults?.().prf?.enabled) {
    const salt = random(32);
    const secret = await prfSecret(credId, salt);
    if (secret) {
      const wrapped = await seal(await keyFromSecret(secret), raw, 'device-key');
      localStorage.setItem(DEVICE_PREF, JSON.stringify({ credId, vaultId, mode: 'fingerprint', salt: toB64(salt), wrapped: toB64(wrapped) }));
      return 'fingerprint';
    }
  }
  // No PRF in this browser: keep a non-exportable copy of the key here.
  await dbPut('vault-key', await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  localStorage.setItem(DEVICE_PREF, JSON.stringify({ credId, vaultId, mode: 'browser' }));
  return 'browser';
}

export async function unlockWithTouchId() {
  const setup = touchIdSetup();
  if (!setup) throw new Error('Touch ID is not set up on this device.');
  if (setup.mode === 'fingerprint') {
    const secret = await prfSecret(setup.credId, fromB64(setup.salt));
    if (!secret) throw new Error('Touch ID did not unlock the vault. Use your password.');
    const raw = await open(await keyFromSecret(secret), fromB64(setup.wrapped), 'device-key');
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
  }
  await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [{ type: 'public-key', id: fromB64(setup.credId) }],
      userVerification: 'required',
      timeout: 60_000,
    },
  });
  const key = await dbGet('vault-key');
  if (!key) throw new Error('Touch ID needs to be set up again. Use your password.');
  return key;
}

export function disableTouchId() {
  try { localStorage.removeItem(DEVICE_PREF); } catch {}
  return dbDelete('vault-key');
}
