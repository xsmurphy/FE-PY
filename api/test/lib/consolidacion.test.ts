/**
 * Consolidación de ítems — el DE lleva "Servicios prestados" en vez del
 * detalle de la venta.
 *
 * Lo que se protege acá: el total y el IVA declarados tienen que ser
 * EXACTAMENTE los de la venta real. Consolidar es ocultar el detalle al
 * comprador, no alterar el documento fiscal.
 */
import { describe, it, expect } from 'vitest';
import { consolidarItems } from '../../src/lib/consolidacion.js';

const item = (over: Record<string, unknown> = {}) => ({
  codigo: 'P-1', descripcion: 'Producto', unidadMedida: 77,
  cantidad: 2, precioUnitario: 50_000, ivaTipo: 1, ivaBase: 100, iva: 10,
  ...over,
});

describe('consolidarItems', () => {
  it('una sola tasa: una línea, cantidad 1, precio = total de la venta', () => {
    const res = consolidarItems(
      [item(), item({ cantidad: 1, precioUnitario: 30_000 })],
      { descripcion: 'Servicios prestados' },
    );
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      codigo: '000', descripcion: 'Servicios prestados', cantidad: 1,
      precioUnitario: 130_000, unidadMedida: 77, ivaTipo: 1, iva: 10, ivaBase: 100,
    });
  });

  it('tasas mezcladas: una línea por tasa — aplastar todo falsearía el IVA', () => {
    const res = consolidarItems(
      [
        item(),                                              // 100.000 al 10%
        item({ iva: 5, cantidad: 1, precioUnitario: 40_000 }), // 40.000 al 5%
        item({ ivaTipo: 3, iva: 0, ivaBase: 0, cantidad: 1, precioUnitario: 10_000 }), // exenta
      ],
      { descripcion: 'Servicios prestados' },
    );
    expect(res).toHaveLength(3);
    expect(res.map((r) => [r.iva, r.precioUnitario])).toEqual([
      [10, 100_000],
      [5, 40_000],
      [0, 10_000],
    ]);
    // Todas las líneas muestran el mismo texto al comprador.
    expect(new Set(res.map((r) => r.descripcion))).toEqual(new Set(['Servicios prestados']));
  });

  it('el total consolidado conserva descuentos y anticipos por ítem', () => {
    const res = consolidarItems(
      [item({ cantidad: 2, precioUnitario: 50_000, descuento: 5_000 })],
      { descripcion: 'Servicios prestados' },
    );
    // 2 × 50.000 − 2 × 5.000
    expect(res[0].precioUnitario).toBe(90_000);
  });

  it('respeta codigo y unidadMedida propios', () => {
    const [linea] = consolidarItems([item()], {
      descripcion: 'Honorarios', codigo: 'SRV', unidadMedida: 83,
    });
    expect(linea).toMatchObject({ codigo: 'SRV', unidadMedida: 83, descripcion: 'Honorarios' });
  });

  it('exige descripción usable', () => {
    expect(() => consolidarItems([item()], { descripcion: '  ' })).toThrow(/descripcion/);
    expect(() => consolidarItems([item()], { descripcion: 'x'.repeat(121) })).toThrow(/120/);
    expect(() => consolidarItems([], { descripcion: 'Servicios' })).toThrow(/ítems/);
  });
});
