/**
 * Reglas condicionales por tipo de documento.
 *
 * El foco está en la Nota de Remisión (iTiDE=7): es el único tipo cuyo
 * cuerpo difiere estructuralmente de la factura, y varias de sus reglas
 * NO las chequea xmlgen (ver iRespFlete).
 */
import { describe, it, expect } from 'vitest';
import { validarDocumentoPorTipo } from '../../src/lib/de-validation.js';

const remisionValida = () => ({
  tipoDocumento: 7,
  cliente: { ruc: '7659394-0', direccion: 'Calle Falsa 123', numeroCasa: '123' },
  remision: { motivo: 1, tipoResponsable: 1, kms: 25 },
  detalleTransporte: {
    tipo: 1,
    modalidad: 1,
    tipoResponsable: 1,
    inicioEstimadoTranslado: '2026-09-10',
    finEstimadoTranslado: '2026-09-11',
  },
  items: [{ codigo: '001', descripcion: 'Globos', unidadMedida: 77, cantidad: 10 }],
});

/** Devuelve la lista de errores de un body que se espera inválido. */
const errores = (body: Record<string, unknown>): string[] => {
  try {
    validarDocumentoPorTipo(body);
  } catch (e) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((e as any).details?.errores ?? []) as string[];
  }
  throw new Error('se esperaba que el body fuera inválido');
};

describe('Nota de Remisión (tipoDocumento=7)', () => {
  it('acepta una remisión completa, sin exigir tipoTransaccion', () => {
    const body = remisionValida();
    expect(() => validarDocumentoPorTipo(body)).not.toThrow();
    expect(body).not.toHaveProperty('tipoTransaccion');
  });

  it('exige remision y detalleTransporte', () => {
    const e = errores({ tipoDocumento: 7, cliente: { direccion: 'x', numeroCasa: '1' } });
    expect(e.some((m) => m.startsWith('remision es obligatorio'))).toBe(true);
    expect(e.some((m) => m.startsWith('detalleTransporte es obligatorio'))).toBe(true);
  });

  it('exige el responsable del costo del flete — xmlgen no lo valida y el XSD revienta con un error ilegible', () => {
    const body = remisionValida();
    delete (body.detalleTransporte as Record<string, unknown>).tipoResponsable;
    expect(errores(body).some((m) => m.includes('detalleTransporte.tipoResponsable'))).toBe(true);
  });

  it('exige motivoDescripcion solo cuando motivo=99', () => {
    const body = remisionValida();
    body.remision.motivo = 99;
    expect(errores(body).some((m) => m.includes('motivoDescripcion'))).toBe(true);

    body.remision.motivoDescripcion = 'Traslado por siniestro';
    expect(() => validarDocumentoPorTipo(body)).not.toThrow();
  });

  it('rechaza motivo y tipoResponsable fuera de tabla', () => {
    const body = remisionValida();
    body.remision.motivo = 42;
    body.remision.tipoResponsable = 9;
    const e = errores(body);
    expect(e.some((m) => m.includes('remision.motivo=42 inválido'))).toBe(true);
    expect(e.some((m) => m.includes('remision.tipoResponsable=9 inválido'))).toBe(true);
  });

  it('exige kms positivo', () => {
    const body = remisionValida();
    body.remision.kms = 0;
    expect(errores(body).some((m) => m.includes('remision.kms'))).toBe(true);
  });

  it('valida formato y orden de las fechas de traslado', () => {
    const body = remisionValida();
    body.detalleTransporte.inicioEstimadoTranslado = '10/09/2026';
    expect(errores(body).some((m) => m.includes('inicioEstimadoTranslado'))).toBe(true);

    const body2 = remisionValida();
    body2.detalleTransporte.finEstimadoTranslado = '2026-09-09';
    expect(errores(body2).some((m) => m.includes('no puede ser anterior'))).toBe(true);
  });

  it('exige dirección y número de casa del receptor (destino de la mercadería)', () => {
    const body = remisionValida();
    delete (body.cliente as Record<string, unknown>).direccion;
    expect(errores(body).some((m) => m.includes('cliente.direccion'))).toBe(true);

    const body2 = remisionValida();
    delete (body2.cliente as Record<string, unknown>).numeroCasa;
    expect(errores(body2).some((m) => m.includes('cliente.numeroCasa'))).toBe(true);
  });

  it('motivo=7 (traslado entre locales) exige RUC del receptor', () => {
    const body = remisionValida();
    body.remision.motivo = 7;
    delete (body.cliente as Record<string, unknown>).ruc;
    expect(errores(body).some((m) => m.includes('motivo=7'))).toBe(true);
  });

  it('acumula todos los errores en una sola respuesta', () => {
    expect(errores({ tipoDocumento: 7 }).length).toBeGreaterThan(1);
  });
});

describe('Resto de los tipos', () => {
  it('exige tipoTransaccion en factura, NC y ND', () => {
    for (const tipo of [1, 4, 5, 6]) {
      expect(errores({ tipoDocumento: tipo }).some((m) => m.includes('tipoTransaccion'))).toBe(true);
    }
  });

  it('no toca nada más si tipoTransaccion está presente', () => {
    expect(() => validarDocumentoPorTipo({ tipoDocumento: 1, tipoTransaccion: 1 })).not.toThrow();
  });

  it('default tipoDocumento=1 cuando no se envía', () => {
    expect(errores({}).some((m) => m.includes('tipoTransaccion'))).toBe(true);
  });
});
