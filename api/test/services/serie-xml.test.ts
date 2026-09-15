/**
 * dSerieNum — serie del punto de expedición.
 *
 * Incidente 2026-09-15: Balloon Party emitía en 001-001 con Factomate, que
 * mandaba serie "AA". FE-PY emitía ese punto sin serie y SIFEN rechazaba con
 * 1110 "Serie informada incorrecta". Verificamos que la serie llega al XML
 * y que el documento sigue validando contra el XSD oficial.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { validarDocumentoPorTipo } from '../../src/lib/de-validation.js';

process.env.MASTER_KEY_BASE64 = Buffer.alloc(32).toString('base64');
process.env.DATABASE_URL = 'postgres://x:x@localhost:5432/x';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const xmlgen = require('facturacionelectronicapy-xmlgen').default;

const params = {
  version: 150, ruc: '3595193-1', razonSocial: 'GONZALEZ QUEVEDO, CINTIA ESTEFANIA',
  nombreFantasia: 'BALLOON PARTY',
  actividadesEconomicas: [{ codigo: '47733', descripcion: 'VENTA AL POR MENOR' }],
  timbradoNumero: '18260177', timbradoFecha: '2025-08-26', tipoContribuyente: 1, tipoRegimen: 8,
  establecimientos: [{
    codigo: '001', denominacion: 'CASA MATRIZ', direccion: 'DR CAMACHO DURE', numeroCasa: '576',
    departamento: 1, departamentoDescripcion: 'CAPITAL', distrito: 1, distritoDescripcion: 'ASUNCION (DISTRITO)',
    ciudad: 1, ciudadDescripcion: 'ASUNCION (DISTRITO)', telefono: '0994285744', email: 'x@example.com',
  }],
};

const factura = (extra: Record<string, unknown> = {}) => ({
  tipoDocumento: 1, establecimiento: '001', punto: '001', numero: '0000841',
  fecha: '2026-09-15T10:00:00', tipoEmision: 1, tipoTransaccion: 1, tipoImpuesto: 1, moneda: 'PYG',
  codigoSeguridadAleatorio: '123456789',
  cliente: {
    contribuyente: true, ruc: '80005668-0', razonSocial: 'VILLANDRY SA', tipoOperacion: 1,
    tipoContribuyente: 2, direccion: 'Asuncion', numeroCasa: '0', departamento: 1, distrito: 1,
    ciudad: 1, pais: 'PRY', telefono: '021555444',
  },
  factura: { presencia: 1 },
  condicion: { tipo: 1, entregas: [{ tipo: 1, monto: '72000', moneda: 'PYG' }] },
  items: [{ codigo: 'LAH', descripcion: 'Globo de latex', unidadMedida: 77, cantidad: 4, precioUnitario: 18000, ivaTipo: 1, ivaBase: 100, iva: 10 }],
  ...extra,
});

describe('dSerieNum en el XML', () => {
  it('con serie: la informa en gTimb y valida contra el XSD', async () => {
    const xml: string = await xmlgen.generateXMLDE(params, factura({ serie: 'AA' }));
    expect(xml).toContain('<dSerieNum>AA</dSerieNum>');
    const { validatePreSigning } = await import('../../src/lib/xsd-validator.js');
    const res = await validatePreSigning(xml);
    expect(res.errors ?? []).toEqual([]);
  }, 30_000);

  it('sin serie: no emite dSerieNum (001-002 aprobado así en producción)', async () => {
    const xml: string = await xmlgen.generateXMLDE(params, factura());
    expect(xml).not.toContain('dSerieNum');
  }, 30_000);
});

describe('validación de serie', () => {
  const base = { tipoDocumento: 1, tipoTransaccion: 1 };
  const errores = (body: Record<string, unknown>): string[] => {
    try {
      validarDocumentoPorTipo(body);
      return [];
    } catch (e) {
      return ((e as { details?: { errores?: string[] } }).details?.errores ?? []) as string[];
    }
  };

  it('acepta dos letras mayúsculas', () => {
    expect(errores({ ...base, serie: 'AA' })).toEqual([]);
  });

  it('rechaza formatos que SIFEN no acepta', () => {
    for (const serie of ['aa', 'A', 'AAA', 'A1', '']) {
      expect(errores({ ...base, serie }).some((m) => m.includes('serie='))).toBe(true);
    }
  });

  it('rechaza serie y numeroSerie contradictorias', () => {
    expect(errores({ ...base, serie: 'AA', numeroSerie: 'AB' }).some((m) => m.includes('no coinciden'))).toBe(true);
  });
});
