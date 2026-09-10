/**
 * Nota de Remisión end-to-end hasta el XSD (sin firma, sin SIFEN).
 *
 * Esta es la prueba que faltaba: la NR estaba "implementada" pero nunca se
 * había generado un XML de remisión ni una sola vez, así que nadie sabía si
 * el cuerpo que documentamos producía un documento válido. Acá generamos el
 * XML real con xmlgen y lo validamos contra el XSD oficial con xmllint —
 * el mismo validador que corre en el pipeline de emisión.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

process.env.MASTER_KEY_BASE64 = Buffer.alloc(32).toString('base64');
process.env.DATABASE_URL = 'postgres://x:x@localhost:5432/x';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const xmlgen = require('facturacionelectronicapy-xmlgen').default;

// Emisor ficticio con la forma exacta que `buildParamsFromTenant` arma
// desde la fila de `tenants`.
const params = {
  version: 150,
  ruc: '80069563-1',
  razonSocial: 'EMPRESA DE PRUEBA SA',
  nombreFantasia: 'PRUEBA',
  actividadesEconomicas: [{ codigo: '47733', descripcion: 'VENTA AL POR MENOR' }],
  timbradoNumero: '12558946',
  timbradoFecha: '2025-08-26',
  tipoContribuyente: 2,
  tipoRegimen: 8,
  establecimientos: [
    {
      codigo: '001',
      denominacion: 'CASA MATRIZ',
      direccion: 'AVDA ESPANA',
      numeroCasa: '1234',
      departamento: 11,
      departamentoDescripcion: 'ALTO PARANA',
      distrito: 145,
      distritoDescripcion: 'CIUDAD DEL ESTE',
      ciudad: 3432,
      ciudadDescripcion: 'CIUDAD DEL ESTE',
      telefono: '021123456',
      email: 'test@example.com',
    },
  ],
};

const remisionData = () => ({
  tipoDocumento: 7,
  establecimiento: '001',
  punto: '001',
  numero: '0000001',
  fecha: '2026-09-10T10:00:00',
  tipoEmision: 1,
  codigoSeguridadAleatorio: '123456789',
  descripcion: 'Traslado de mercadería',
  cliente: {
    contribuyente: true,
    ruc: '7659394-0',
    razonSocial: 'MURPHY CHRISTIAN',
    tipoOperacion: 1,
    tipoContribuyente: 1,
    direccion: 'Calle Falsa 123',
    numeroCasa: '123',
    departamento: 11,
    distrito: 145,
    ciudad: 3432,
    pais: 'PRY',
    telefono: '021555444',
  },
  remision: { motivo: 1, tipoResponsable: 1, kms: 25 },
  detalleTransporte: {
    tipo: 1,
    modalidad: 1,
    tipoResponsable: 1,
    inicioEstimadoTranslado: '2026-09-10',
    finEstimadoTranslado: '2026-09-11',
    salida: { direccion: 'AVDA ESPANA', numeroCasa: '1234', ciudad: 3432 },
    entrega: { direccion: 'Calle Falsa 123', numeroCasa: '123', ciudad: 3432 },
    vehiculo: {
      tipo: 'CAMION',
      marca: 'TOYOTA',
      documentoTipo: 1,
      documentoNumero: 'ABC123',
      numeroMatricula: 'ABC123',
    },
  },
  // Los ítems de una NR van SIN precio ni IVA — solo qué y cuánto se traslada.
  items: [{ codigo: '001', descripcion: 'Globos metalizados', unidadMedida: 77, cantidad: 10 }],
});

describe('Nota de Remisión — XML contra XSD oficial', () => {
  it('genera un XML que valida contra el XSD pre-firma', async () => {
    const xml: string = await xmlgen.generateXMLDE(params, remisionData());
    const { validatePreSigning } = await import('../../src/lib/xsd-validator.js');
    const res = await validatePreSigning(xml);
    expect(res.errors ?? []).toEqual([]);
    expect(res.valid).toBe(true);
  }, 30_000);

  it('el CDC arranca con 07 (tipo de documento remisión)', async () => {
    const xml: string = await xmlgen.generateXMLDE(params, remisionData());
    const { extractCdc } = await import('../../src/lib/cdc.js');
    const cdc = extractCdc(xml);
    expect(cdc).toHaveLength(44);
    expect(cdc!.slice(0, 2)).toBe('07');
  }, 30_000);

  it('omite gOpeCom y gTotSub, e incluye gCamNRE y gTransp', async () => {
    const xml: string = await xmlgen.generateXMLDE(params, remisionData());
    // Sin datos de operación comercial ni totales: la remisión no vende nada.
    expect(xml).not.toContain('<gOpeCom>');
    expect(xml).not.toContain('<gTotSub>');
    expect(xml).toContain('<gCamNRE>');
    expect(xml).toContain('<iMotEmiNR>1</iMotEmiNR>');
    expect(xml).toContain('<dKmR>25</dKmR>');
    expect(xml).toContain('<gTransp>');
    expect(xml).toContain('<iRespFlete>1</iRespFlete>');
  }, 30_000);

  it('sin detalleTransporte.tipoResponsable el XSD falla — el motivo de validarlo nosotros', async () => {
    const data = remisionData();
    delete (data.detalleTransporte as Record<string, unknown>).tipoResponsable;
    const xml: string = await xmlgen.generateXMLDE(params, data);
    // xmlgen lo deja pasar y emite <iRespFlete/> vacío.
    const { validatePreSigning } = await import('../../src/lib/xsd-validator.js');
    const res = await validatePreSigning(xml);
    expect(res.valid).toBe(false);
    expect(res.errors!.join(' ')).toContain('iRespFlete');
  }, 30_000);
});
