/**
 * Tests del cert service. Generamos certificados .p12 sintéticos con node-forge
 * en cada test para no depender de archivos externos.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import forge from 'node-forge';
const { pki, asn1, pkcs12 } = forge;

// Setup env antes de importar cualquier módulo que use config
process.env.MASTER_KEY_BASE64 = randomBytes(32).toString('base64');
process.env.DATABASE_URL = 'postgres://x:x@localhost:5432/x';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_BUCKET = 'test';
process.env.S3_ACCESS_KEY = 'x';
process.env.S3_SECRET_KEY = 'x';

const {
  parseP12,
  assertCertNotExpired,
  assertRucMatches,
  normalizeRuc,
  encryptCertBundle,
  decryptCertBundle,
} = await import('../../src/services/cert.service.js');

// ─────────────────────────────────────────────────────
// Helper: genera un .p12 sintético con un RUC en el CN
// ─────────────────────────────────────────────────────
interface GenCertOptions {
  ruc: string;
  cn?: string;
  password: string;
  notBefore?: Date;
  notAfter?: Date;
}

const generateTestP12 = (opts: GenCertOptions): Buffer => {
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = opts.notBefore ?? new Date(Date.now() - 86400000);
  cert.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 86400000 * 365);

  const cn = opts.cn ?? `TEST USER ${opts.ruc}`;
  const attrs = [
    { name: 'commonName', value: cn },
    { name: 'countryName', value: 'PY' },
    { name: 'organizationName', value: 'Test Org' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);

  // Construir el pkcs12
  const p12Asn1 = pkcs12.toPkcs12Asn1(keys.privateKey, [cert], opts.password, {
    algorithm: '3des',
  });
  const p12Der = asn1.toDer(p12Asn1).getBytes();
  return Buffer.from(p12Der, 'binary');
};

describe('cert service', () => {
  describe('normalizeRuc', () => {
    it('elimina el dígito verificador', () => {
      expect(normalizeRuc('80012345-1')).toBe('80012345');
      expect(normalizeRuc('80012345')).toBe('80012345');
      expect(normalizeRuc(' 80012345-1 ')).toBe('80012345');
    });
  });

  describe('parseP12', () => {
    let p12Buffer: Buffer;
    const password = 'test-pwd-123';

    beforeAll(() => {
      p12Buffer = generateTestP12({ ruc: '80012345-1', password });
    });

    it('parsea un p12 válido y extrae fingerprint + RUC', () => {
      const parsed = parseP12(p12Buffer, password);
      expect(parsed.metadata.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(parsed.metadata.subjectRuc).toBe('80012345');
      expect(parsed.metadata.subjectCn).toContain('80012345');
      expect(parsed.metadata.notBefore).toBeInstanceOf(Date);
      expect(parsed.metadata.notAfter).toBeInstanceOf(Date);
      expect(parsed.metadata.notAfter.getTime()).toBeGreaterThan(parsed.metadata.notBefore.getTime());
    });

    it('rechaza password incorrecta con BadRequestError', () => {
      expect(() => parseP12(p12Buffer, 'wrong-password')).toThrowError(
        /Contraseña del certificado incorrecta/,
      );
    });

    it('rechaza archivo corrupto', () => {
      const junk = Buffer.from('no soy un p12');
      expect(() => parseP12(junk, password)).toThrowError(/PKCS#12 válido/);
    });

    it('rechaza cert sin RUC extraíble en CN', () => {
      const noRucP12 = generateTestP12({
        ruc: '80012345',
        cn: 'Sin Numero',
        password,
      });
      expect(() => parseP12(noRucP12, password)).toThrowError(/extraer el RUC/);
    });

    it('genera mismo fingerprint para mismo cert', () => {
      const p1 = parseP12(p12Buffer, password);
      const p2 = parseP12(p12Buffer, password);
      expect(p1.metadata.fingerprint).toBe(p2.metadata.fingerprint);
    });
  });

  describe('assertCertNotExpired', () => {
    it('acepta cert vigente', () => {
      expect(() =>
        assertCertNotExpired({
          fingerprint: 'x',
          subjectCn: 'x',
          subjectRuc: '80012345',
          notBefore: new Date(Date.now() - 86400000),
          notAfter: new Date(Date.now() + 86400000),
        }),
      ).not.toThrow();
    });

    it('rechaza cert vencido', () => {
      expect(() =>
        assertCertNotExpired({
          fingerprint: 'x',
          subjectCn: 'x',
          subjectRuc: '80012345',
          notBefore: new Date(Date.now() - 86400000 * 30),
          notAfter: new Date(Date.now() - 86400000),
        }),
      ).toThrowError(/vencido/);
    });

    it('rechaza cert con notBefore en el futuro', () => {
      expect(() =>
        assertCertNotExpired({
          fingerprint: 'x',
          subjectCn: 'x',
          subjectRuc: '80012345',
          notBefore: new Date(Date.now() + 86400000),
          notAfter: new Date(Date.now() + 86400000 * 30),
        }),
      ).toThrowError(/aún no es válido/);
    });
  });

  describe('assertRucMatches', () => {
    it('acepta RUCs iguales con o sin DV', () => {
      expect(() => assertRucMatches('80012345', '80012345-1')).not.toThrow();
      expect(() => assertRucMatches('80012345-1', '80012345')).not.toThrow();
      expect(() => assertRucMatches('80012345-1', '80012345-1')).not.toThrow();
    });

    it('rechaza RUCs distintos', () => {
      expect(() => assertRucMatches('80012345', '80099999-1')).toThrowError(/no coincide/);
    });
  });

  describe('encryptCertBundle / decryptCertBundle', () => {
    it('cifra y descifra un p12 + password round trip', () => {
      const p12 = generateTestP12({ ruc: '80012345-1', password: 'abc123' });
      const bundle = encryptCertBundle(p12, 'abc123');

      const decrypted = decryptCertBundle(bundle);
      expect(decrypted.p12.equals(p12)).toBe(true);
      expect(decrypted.password).toBe('abc123');
    });

    it('detecta tampering del ciphertext del p12', () => {
      const p12 = generateTestP12({ ruc: '80012345-1', password: 'abc' });
      const bundle = encryptCertBundle(p12, 'abc');
      bundle.p12.ciphertext[0] ^= 0xff;
      expect(() => decryptCertBundle(bundle)).toThrow();
    });

    it('detecta tampering del ciphertext del password', () => {
      const p12 = generateTestP12({ ruc: '80012345-1', password: 'abc' });
      const bundle = encryptCertBundle(p12, 'abc');
      bundle.password.ciphertext[0] ^= 0xff;
      expect(() => decryptCertBundle(bundle)).toThrow();
    });

    it('detecta tampering de la DEK cifrada', () => {
      const p12 = generateTestP12({ ruc: '80012345-1', password: 'abc' });
      const bundle = encryptCertBundle(p12, 'abc');
      bundle.dek.ciphertext[0] ^= 0xff;
      expect(() => decryptCertBundle(bundle)).toThrow();
    });

    /**
     * Regression test: hasta batch 8 el cert bundle tenía DOS DEKs distintas
     * (una por cada envelope independiente) pero solo se guardaba UNA en DB.
     * Al reconstruir el bundle leyendo de DB, el password se descifraba con
     * la DEK del p12 → falla criptográfica.
     *
     * Este test simula el round trip DB: serializa los campos como columnas,
     * los reconstruye, y verifica que decryptCertBundle funciona.
     */
    it('round trip DB: serializar a columnas y reconstruir', () => {
      const originalP12 = generateTestP12({ ruc: '80012345-1', password: 'top-secret' });
      const bundle = encryptCertBundle(originalP12, 'top-secret');

      // Simular INSERT en tenant_certs → serializamos cada campo
      const dbRow = {
        encryptedP12: bundle.p12.ciphertext,
        ivP12: bundle.p12.iv,
        tagP12: bundle.p12.tag,

        encryptedPassword: bundle.password.ciphertext,
        ivPassword: bundle.password.iv,
        tagPassword: bundle.password.tag,

        encryptedDek: bundle.dek.ciphertext,
        ivDek: bundle.dek.iv,
        tagDek: bundle.dek.tag,
      };

      // Simular SELECT y reconstruir bundle desde row
      const reconstructed = {
        p12: {
          ciphertext: dbRow.encryptedP12,
          iv: dbRow.ivP12,
          tag: dbRow.tagP12,
        },
        password: {
          ciphertext: dbRow.encryptedPassword,
          iv: dbRow.ivPassword,
          tag: dbRow.tagPassword,
        },
        dek: {
          ciphertext: dbRow.encryptedDek,
          iv: dbRow.ivDek,
          tag: dbRow.tagDek,
        },
      };

      const decrypted = decryptCertBundle(reconstructed);
      expect(decrypted.p12.equals(originalP12)).toBe(true);
      expect(decrypted.password).toBe('top-secret');
    });
  });

  describe('end-to-end: parse + validate + encrypt + decrypt + reparse', () => {
    it('flujo completo del upload de cert', () => {
      const password = 'top-secret-123';
      const p12 = generateTestP12({ ruc: '80055555-7', password });

      // 1. Parsear para validar
      const parsed = parseP12(p12, password);
      expect(parsed.metadata.subjectRuc).toBe('80055555');

      // 2. Validar vigencia
      expect(() => assertCertNotExpired(parsed.metadata)).not.toThrow();

      // 3. Validar RUC del tenant
      expect(() => assertRucMatches(parsed.metadata.subjectRuc, '80055555-7')).not.toThrow();

      // 4. Cifrar
      const bundle = encryptCertBundle(p12, password);
      expect(bundle.p12.ciphertext.length).toBeGreaterThan(0);
      expect(bundle.password.ciphertext.length).toBeGreaterThan(0);

      // 5. Descifrar y reparsear — debe funcionar igual que el original
      const decrypted = decryptCertBundle(bundle);
      const reparsed = parseP12(decrypted.p12, decrypted.password);
      expect(reparsed.metadata.fingerprint).toBe(parsed.metadata.fingerprint);
      expect(reparsed.metadata.subjectRuc).toBe(parsed.metadata.subjectRuc);
    });
  });
});
