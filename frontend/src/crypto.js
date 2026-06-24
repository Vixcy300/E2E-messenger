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
