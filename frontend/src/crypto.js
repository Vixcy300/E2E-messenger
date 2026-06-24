export async function generateRSAKeyPair() {
  return await window.crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function exportPublicKey(key) {
  const exported = await window.crypto.subtle.exportKey("spki", key);
  return btoa(String.fromCharCode(...new Uint8Array(exported)));
}

export async function importPublicKey(b64) {
  const binaryDer = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return await window.crypto.subtle.importKey(
    "spki", binaryDer, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]
  );
}

export async function generateAESKey() {
  return await window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
  );
}

export async function encryptTextAES(text, aesKey) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv }, aesKey, enc.encode(text)
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptTextAES(b64Combined, aesKey) {
  const combined = Uint8Array.from(atob(b64Combined), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv }, aesKey, ciphertext
  );
  return new TextDecoder().decode(decrypted);
}

export async function encryptAESKeyWithRSA(aesKey, rsaPubKey) {
  const rawAes = await window.crypto.subtle.exportKey("raw", aesKey);
  const encAes = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaPubKey, rawAes);
  return btoa(String.fromCharCode(...new Uint8Array(encAes)));
}

export async function decryptAESKeyWithRSA(b64EncAes, rsaPrivKey) {
  const encAes = Uint8Array.from(atob(b64EncAes), c => c.charCodeAt(0));
  const rawAes = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, rsaPrivKey, encAes);
  return await window.crypto.subtle.importKey(
    "raw", rawAes, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]
  );
}

// ── Persistent Encrypted Session ──────────────────────────────────────────────

async function deriveKeyFromPasscode(passcode, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw", enc.encode(passcode), "PBKDF2", false, ["deriveKey"]
  );
  return await window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function saveSession(callsign, rsaKeys, passcode, expiresAt) {
  try {
    const rawPub = await window.crypto.subtle.exportKey("spki", rsaKeys.publicKey);
    const rawPriv = await window.crypto.subtle.exportKey("pkcs8", rsaKeys.privateKey);
    
    const payload = JSON.stringify({
      callsign,
      expiresAt,
      pub: btoa(String.fromCharCode(...new Uint8Array(rawPub))),
      priv: btoa(String.fromCharCode(...new Uint8Array(rawPriv)))
    });
    
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const aesKey = await deriveKeyFromPasscode(passcode, salt);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    
    const encPayload = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv }, aesKey, new TextEncoder().encode(payload)
    );
    
    const sessionData = {
      salt: btoa(String.fromCharCode(...salt)),
      iv: btoa(String.fromCharCode(...iv)),
      data: btoa(String.fromCharCode(...new Uint8Array(encPayload)))
    };
    
    localStorage.setItem("sdcms_session", JSON.stringify(sessionData));
    return true;
  } catch (e) {
    console.error("Session save failed", e);
    return false;
  }
}

export async function loadSession(passcode) {
  const stored = localStorage.getItem("sdcms_session");
  if (!stored) throw new Error("No session found");
  
  const { salt, iv, data } = JSON.parse(stored);
  const aesKey = await deriveKeyFromPasscode(
    passcode, 
    Uint8Array.from(atob(salt), c => c.charCodeAt(0))
  );
  
  try {
    const decPayload = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Uint8Array.from(atob(iv), c => c.charCodeAt(0)) },
      aesKey,
      Uint8Array.from(atob(data), c => c.charCodeAt(0))
    );
    
    const parsed = JSON.parse(new TextDecoder().decode(decPayload));
    
    const publicKey = await window.crypto.subtle.importKey(
      "spki",
      Uint8Array.from(atob(parsed.pub), c => c.charCodeAt(0)),
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["encrypt"]
    );
    
    const privateKey = await window.crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(atob(parsed.priv), c => c.charCodeAt(0)),
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["decrypt"]
    );
    
    return { callsign: parsed.callsign, expiresAt: parsed.expiresAt, keys: { publicKey, privateKey } };
  } catch (e) {
    throw new Error("Invalid passcode or corrupted session");
  }
}

export function clearSession() {
  localStorage.removeItem("sdcms_session");
}
