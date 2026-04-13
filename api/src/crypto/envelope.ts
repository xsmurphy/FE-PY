/**
 * Envelope encryption para certificados PKCS#12 y secretos sensibles.
 *
 * Esquema:
 *   - KEK (Key Encryption Key): 32 bytes en env var MASTER_KEY_BASE64.
 *     Nunca sale del proceso. Backup offline separado.
 *   - DEK (Data Encryption Key): 32 bytes random generados por cada secret.
 *     Se cifra con la KEK y se guarda junto al ciphertext.
 *   - Algoritmo: AES-256-GCM (authenticated encryption — detecta tampering).
 *
 * Cada operación produce: { ciphertext, iv, tag }
 *   - iv: 12 bytes random (NIST recomendado para GCM)
 *   - tag: 16 bytes auth tag generado por GCM
 *
 * Garantías:
 *   - Confidencialidad: sin la KEK nadie puede descifrar los secrets
 *   - Integridad: cualquier modificación del ciphertext hace que la
 *     desencriptación falle (tag verification error)
 *   - Rotación de KEK: al rotarla hay que re-cifrar las DEKs (no los secrets
 *     grandes), lo cual es barato.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;
const TAG_LEN = 16;

// KEK master cargada una sola vez del env
let kekCache: Buffer | null = null;
const getKek = (): Buffer => {
  if (kekCache) return kekCache;
  const kek = Buffer.from(env.MASTER_KEY_BASE64, 'base64');
  if (kek.length !== KEY_LEN) {
    throw new Error(`MASTER_KEY_BASE64 must decode to ${KEY_LEN} bytes, got ${kek.length}`);
  }
  kekCache = kek;
  return kek;
};

export interface EncryptedBlob {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/**
 * Cifra `plaintext` con una clave simétrica dada (o genera una DEK nueva).
 * Devuelve ciphertext + iv + tag. El caller guarda los 3.
 */
export const encryptWithKey = (plaintext: Buffer, key: Buffer): EncryptedBlob => {
  if (key.length !== KEY_LEN) {
    throw new Error(`Key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_LEN) {
    throw new Error(`Unexpected auth tag length: ${tag.length}`);
  }
  return { ciphertext, iv, tag };
};

/**
 * Descifra un EncryptedBlob. Lanza si el tag no valida (tampering detectado).
 */
export const decryptWithKey = (blob: EncryptedBlob, key: Buffer): Buffer => {
  if (key.length !== KEY_LEN) {
    throw new Error(`Key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  const decipher = createDecipheriv(ALGO, key, blob.iv);
  decipher.setAuthTag(blob.tag);
  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
};

// ═════════════════════════════════════════════════════════════════
// Envelope API: cifra un secret grande generando una DEK nueva
// ═════════════════════════════════════════════════════════════════

export interface EnvelopeEncrypted {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  encryptedDek: Buffer;
  ivDek: Buffer;
  tagDek: Buffer;
}

/**
 * Cifra `plaintext` con una DEK random (generada aquí), y cifra la DEK con
 * la KEK master. Devuelve todo lo que hay que persistir.
 *
 * La DEK se zera en memoria antes de retornar.
 */
export const envelopeEncrypt = (plaintext: Buffer): EnvelopeEncrypted => {
  const dek = randomBytes(KEY_LEN);
  try {
    const dataBlob = encryptWithKey(plaintext, dek);
    const dekBlob = encryptWithKey(dek, getKek());
    return {
      ciphertext: dataBlob.ciphertext,
      iv: dataBlob.iv,
      tag: dataBlob.tag,
      encryptedDek: dekBlob.ciphertext,
      ivDek: dekBlob.iv,
      tagDek: dekBlob.tag,
    };
  } finally {
    dek.fill(0);
  }
};

/**
 * Descifra un EnvelopeEncrypted: primero la DEK con la KEK, luego el data.
 * La DEK descifrada se zera en memoria al final.
 */
export const envelopeDecrypt = (blob: EnvelopeEncrypted): Buffer => {
  const dek = decryptWithKey(
    { ciphertext: blob.encryptedDek, iv: blob.ivDek, tag: blob.tagDek },
    getKek(),
  );
  try {
    return decryptWithKey(
      { ciphertext: blob.ciphertext, iv: blob.iv, tag: blob.tag },
      dek,
    );
  } finally {
    dek.fill(0);
  }
};

/**
 * Helper para borrar explícitamente un Buffer sensible de memoria.
 * Node no garantiza que el GC limpie inmediatamente, pero esto reduce la
 * ventana en la que el secret existe en heap.
 */
export const wipe = (...buffers: Buffer[]): void => {
  for (const b of buffers) b.fill(0);
};

// Export para testing (permite inyectar KEK distinta en tests)
export const __testing__ = {
  resetKekCache: () => {
    kekCache = null;
  },
  setKek: (kek: Buffer) => {
    kekCache = kek;
  },
};
