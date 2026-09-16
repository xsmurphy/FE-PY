/**
 * Consolidar no puede cambiar el documento fiscal: mismo total, mismo IVA,
 * mismos subtotales por tasa que la venta con el detalle completo.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { consolidarItems } from '../../src/lib/consolidacion.js';

process.env.MASTER_KEY_BASE64 = Buffer.alloc(32).toString('base64');
process.env.DATABASE_URL = 'postgres://x:x@localhost:5432/x';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const xmlgen = require('facturacionelectronicapy-xmlgen').default;

const params = {
  version: 150, ruc: '80069563-1', razonSocial: 'EMPRESA DE PRUEBA SA', nombreFantasia: 'PRUEBA',
  actividadesEconomicas: [{ codigo: '47733', descripcion: 'VENTA AL POR MENOR' }],
  timbradoNumero: '12558946', timbradoFecha: '2025-08-26', tipoContribuyente: 2, tipoRegimen: 8,
  establecimientos: [{
    codigo: '001', denominacion: 'CASA MATRIZ', direccion: 'AVDA ESPANA', numeroCasa: '1234',
    departamento: 11, departamentoDescripcion: 'ALTO PARANA', distrito: 145,
    distritoDescripcion: 'CIUDAD DEL ESTE', ciudad: 3383, ciudadDescripcion: 'CIUDAD DEL ESTE',
    telefono: '021123456', email: 'x@example.com',
  }],
};

// Venta real: 30 ítems al 10% + 2 al 5%.
const detalle = [
  ...Array.from({ length: 30 }, (_, i) => ({
    codigo: `P-${i}`, descripcion: `Producto ${i}`, unidadMedida: 77,
    cantidad: 2, precioUnitario: 15_000, ivaTipo: 1, ivaBase: 100, iva: 10,
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    codigo: `C-${i}`, descripcion: `Canasta ${i}`, unidadMedida: 77,
    cantidad: 1, precioUnitario: 22_000, ivaTipo: 1, ivaBase: 100, iva: 5,
  })),
];

const doc = (items: Record<string, unknown>[]) => ({
  tipoDocumento: 1, establecimiento: '001', punto: '001', numero: '0000001',
  fecha: '2026-09-16T10:00:00', tipoEmision: 1, tipoTransaccion: 1, tipoImpuesto: 1, moneda: 'PYG',
  codigoSeguridadAleatorio: '123456789',
  cliente: {
    contribuyente: true, ruc: '7659394-0', razonSocial: 'MURPHY, CHRISTIAN', tipoOperacion: 1,
    tipoContribuyente: 1, direccion: 'Asuncion', numeroCasa: '0', departamento: 1, distrito: 1,
    ciudad: 1, pais: 'PRY', telefono: '021555444',
  },
  factura: { presencia: 1 },
  condicion: { tipo: 1, entregas: [{ tipo: 1, monto: '944000', moneda: 'PYG' }] },
  items,
});

const tag = (xml: string, t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml)?.[1];

describe('Consolidación — el documento fiscal no cambia', () => {
  it('mismos totales e IVA que con el detalle completo, y valida contra el XSD', async () => {
    const xmlDetalle: string = await xmlgen.generateXMLDE(params, doc(detalle));
    const consolidados = consolidarItems(detalle, { descripcion: 'Servicios prestados' });
    const xmlConsolidado: string = await xmlgen.generateXMLDE(params, doc(consolidados));

    for (const campo of ['dTotGralOpe', 'dTotIVA', 'dIVA10', 'dIVA5', 'dSub10', 'dSub5']) {
      expect(tag(xmlConsolidado, campo), campo).toBe(tag(xmlDetalle, campo));
    }

    const { validatePreSigning } = await import('../../src/lib/xsd-validator.js');
    const res = await validatePreSigning(xmlConsolidado);
    expect(res.errors ?? []).toEqual([]);
  }, 30_000);

  it('el comprador ve una línea por tasa, no los 32 ítems', async () => {
    const consolidados = consolidarItems(detalle, { descripcion: 'Servicios prestados' });
    const xml: string = await xmlgen.generateXMLDE(params, doc(consolidados));
    expect(xml.match(/<gCamItem>/g) ?? []).toHaveLength(2);
    expect(xml).toContain('<dDesProSer>Servicios prestados</dDesProSer>');
    expect(xml).not.toContain('Producto 0');
  }, 30_000);
});
