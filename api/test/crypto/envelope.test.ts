import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';

// Setup env antes de importar el módulo
process.env.MASTER_KEY_BASE64 = randomBytes(32).toString('base64');
process.env.DATABASE_URL = 'postgres://x:x@localhost:5432/x';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_BUCKET = 'test';
process.env.S3_ACCESS_KEY = 'x';
process.env.S3_SECRET_KEY = 'x';

const {
  envelopeEncrypt,
  envelopeDecrypt,
  encryptWithKey,
  decryptWithKey,
  __testing__,
} = await import('../../src/crypto/envelope.js');

describe('envelope encryption', () => {
  beforeAll(() => {
    __testing__.resetKekCache();
  });

  describe('round trip', () => {
    it('cifra y descifra un buffer pequeño', () => {
      const plaintext = Buffer.from('hola mundo');
      const blob = envelopeEncrypt(plaintext);
      const decrypted = envelopeDecrypt(blob);
      expect(decrypted.toString()).toBe('hola mundo');
    });

    it('cifra y descifra un buffer grande (simulando .p12)', () => {
      const plaintext = randomBytes(8192);
      const blob = envelopeEncrypt(plaintext);
      const decrypted = envelopeDecrypt(blob);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('genera ciphertexts distintos para el mismo plaintext (IVs random)', () => {
      const plaintext = Buffer.from('mismo texto');
      const blob1 = envelopeEncrypt(plaintext);
      const blob2 = envelopeEncrypt(plaintext);
      expect(blob1.ciphertext.equals(blob2.ciphertext)).toBe(false);
      expect(blob1.iv.equals(blob2.iv)).toBe(false);
      expect(blob1.encryptedDek.equals(blob2.encryptedDek)).toBe(false);
    });

    it('devuelve IVs de 12 bytes y tags de 16 bytes', () => {
      const blob = envelopeEncrypt(Buffer.from('x'));
      expect(blob.iv.length).toBe(12);
      expect(blob.tag.length).toBe(16);
      expect(blob.ivDek.length).toBe(12);
      expect(blob.tagDek.length).toBe(16);
    });
  });

  describe('tampering detection', () => {
    it('falla si se modifica el ciphertext', () => {
      const blob = envelopeEncrypt(Buffer.from('secret'));
      blob.ciphertext[0] ^= 0xff; // flip un bit
      expect(() => envelopeDecrypt(blob)).toThrow();
    });

    it('falla si se modifica el tag', () => {
      const blob = envelopeEncrypt(Buffer.from('secret'));
      blob.tag[0] ^= 0xff;
      expect(() => envelopeDecrypt(blob)).toThrow();
    });

    it('falla si se modifica el IV', () => {
      const blob = envelopeEncrypt(Buffer.from('secret'));
      blob.iv[0] ^= 0xff;
      expect(() => envelopeDecrypt(blob)).toThrow();
    });

    it('falla si se modifica la DEK cifrada', () => {
      const blob = envelopeEncrypt(Buffer.from('secret'));
      blob.encryptedDek[0] ^= 0xff;
      expect(() => envelopeDecrypt(blob)).toThrow();
    });
  });

  describe('KEK rotation', () => {
    it('con una KEK distinta no se puede descifrar', () => {
      const blob = envelopeEncrypt(Buffer.from('secret'));

      // Cambiar la KEK en memoria
      __testing__.setKek(randomBytes(32));

      expect(() => envelopeDecrypt(blob)).toThrow();
    });
  });

  describe('encryptWithKey / decryptWithKey (low level)', () => {
    it('round trip con clave directa', () => {
      const key = randomBytes(32);
      const plaintext = Buffer.from('direct key test');
      const blob = encryptWithKey(plaintext, key);
      expect(decryptWithKey(blob, key).toString()).toBe('direct key test');
    });

    it('rechaza clave de tamaño incorrecto', () => {
      expect(() => encryptWithKey(Buffer.from('x'), randomBytes(16))).toThrow(/32 bytes/);
    });

    it('falla al descifrar con clave distinta', () => {
      const key1 = randomBytes(32);
      const key2 = randomBytes(32);
      const blob = encryptWithKey(Buffer.from('secret'), key1);
      expect(() => decryptWithKey(blob, key2)).toThrow();
    });
  });
});
