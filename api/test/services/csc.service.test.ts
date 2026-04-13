/**
 * Tests del CSC service.
 *
 * No podemos testear setCsc/getCscMetadata/decryptTenantCsc sin DB real
 * (hacen queries), pero sí podemos testear el envelope encryption del
 * CSC end-to-end: encrypt → decrypt → recover original.
 *
 * Esto valida que el patrón de cifrado del CSC (distinto del .p12 porque
 * no tiene password separada) funciona correctamente.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';

process.env.MASTER_KEY_BASE64 = randomBytes(32).toString('base64');
process.env.DATABASE_URL = 'postgres://x:x@localhost:5432/x';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_BUCKET = 'test';
process.env.S3_ACCESS_KEY = 'x';
process.env.S3_SECRET_KEY = 'x';

const { envelopeEncrypt, envelopeDecrypt } = await import('../../src/crypto/envelope.js');

describe('csc service — envelope encryption del CSC', () => {
  it('cifra y descifra un CSC típico', () => {
    const csc = 'ABCD1234EFGH5678IJKL9012MNOP3456';
    const cscBuffer = Buffer.from(csc, 'utf8');
    const bundle = envelopeEncrypt(cscBuffer);

    const decrypted = envelopeDecrypt(bundle);
    expect(decrypted.toString('utf8')).toBe(csc);
  });

  it('el ciphertext del CSC no contiene el texto en claro', () => {
    const csc = 'SECRET_CSC_VALUE_12345';
    const bundle = envelopeEncrypt(Buffer.from(csc, 'utf8'));
    expect(bundle.ciphertext.toString('utf8')).not.toContain('SECRET');
    expect(bundle.ciphertext.toString('utf8')).not.toContain('CSC');
  });

  it('produce bundles distintos para el mismo CSC (IV random)', () => {
    const csc = 'CSC_FIXED_VALUE';
    const b1 = envelopeEncrypt(Buffer.from(csc));
    const b2 = envelopeEncrypt(Buffer.from(csc));
    expect(b1.ciphertext.equals(b2.ciphertext)).toBe(false);
    expect(b1.iv.equals(b2.iv)).toBe(false);
  });

  it('tampering del CSC cifrado lanza al descifrar', () => {
    const bundle = envelopeEncrypt(Buffer.from('test-csc'));
    bundle.ciphertext[0] ^= 0xff;
    expect(() => envelopeDecrypt(bundle)).toThrow();
  });

  it('CSC corto también se cifra y descifra bien', () => {
    // CSC real es típicamente 32+ chars, pero el cifrado tiene que andar para cualquier tamaño
    const bundle = envelopeEncrypt(Buffer.from('X'));
    expect(envelopeDecrypt(bundle).toString()).toBe('X');
  });
});
