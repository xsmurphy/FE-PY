import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';

process.env.MASTER_KEY_BASE64 = randomBytes(32).toString('base64');
process.env.DATABASE_URL = 'postgres://x:x@localhost:5432/x';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_BUCKET = 'test';
process.env.S3_ACCESS_KEY = 'x';
process.env.S3_SECRET_KEY = 'x';

const { extractCdc, isValidCdcFormat, generateCodigoSeguridad } = await import(
  '../../src/lib/cdc.js'
);

describe('cdc helpers', () => {
  describe('extractCdc', () => {
    it('extrae CDC del atributo Id de DE', () => {
      const xml =
        '<?xml version="1.0"?><rDE><DE Id="01800695631001001000000122025011510002983981">...</DE></rDE>';
      expect(extractCdc(xml)).toBe('01800695631001001000000122025011510002983981');
    });

    it('retorna null si no hay CDC', () => {
      expect(extractCdc('<rDE>no cdc</rDE>')).toBeNull();
    });

    it('retorna null si el Id no tiene 44 dígitos', () => {
      expect(extractCdc('<DE Id="0180069563100100100000012202501151">...</DE>')).toBeNull();
    });
  });

  describe('isValidCdcFormat', () => {
    it('acepta CDC de 44 dígitos', () => {
      expect(isValidCdcFormat('01800695631001001000000122025011510002983981')).toBe(true);
    });

    it('rechaza menos de 44 dígitos', () => {
      expect(isValidCdcFormat('018006956310010010000001220250115100029839')).toBe(false);
    });

    it('rechaza con letras', () => {
      expect(isValidCdcFormat('01800695631001001000000122025011510002983A81')).toBe(false);
    });
  });

  describe('generateCodigoSeguridad', () => {
    it('genera 9 dígitos', () => {
      const code = generateCodigoSeguridad();
      expect(code).toMatch(/^\d{9}$/);
    });

    it('genera códigos distintos en llamadas sucesivas (probabilísticamente)', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        codes.add(generateCodigoSeguridad());
      }
      // Con 10^9 posibilidades y 100 muestras, esperamos 100 únicos
      expect(codes.size).toBe(100);
    });
  });
});
