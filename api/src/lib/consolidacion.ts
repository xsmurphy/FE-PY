/**
 * Consolidación de ítems: reemplaza el detalle de la venta por una línea
 * genérica ("Servicios prestados") en el Documento Electrónico.
 *
 * Por qué existe: hay ventas de 30 ítems cuyo detalle ya viaja en el
 * comprobante impreso del comercio, y exponerlo en la FE (que ve el
 * comprador y queda en SIFEN) no siempre es deseable.
 *
 * Por qué NO es una sola línea siempre: SIFEN liquida el IVA por ítem
 * (gCamIVA) y los totales salen de ahí. Si una venta mezcla 10%, 5% y
 * exentas y la aplastáramos a una línea con una sola tasa, el IVA
 * declarado sería FALSO. Entonces agrupamos por (tipo de IVA, tasa, base):
 * una venta con una sola tasa —el caso común— queda en una única línea,
 * y una mixta queda en una línea por tasa. El total y el IVA no cambian.
 *
 * El detalle original NO se pierde: queda en documents.request_json.
 */
import { BadRequestError } from './errors.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Item = Record<string, any>;

export interface OpcionesConsolidacion {
  /** Texto que ve el comprador, ej. "Servicios prestados". */
  descripcion: string;
  /** Código del ítem consolidado (default "000"). */
  codigo?: string;
  /** Unidad de medida SIFEN (default 77 = unidad). */
  unidadMedida?: number;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Importe bruto de un ítem, ya con descuento y anticipo aplicados — la
 * misma cuenta que hace xmlgen para dTotOpeItem.
 */
const totalItem = (item: Item): number => {
  const cantidad = num(item.cantidad);
  const bruto = cantidad * num(item.precioUnitario);
  const descuento = num(item.descuento) * cantidad;
  const anticipo = num(item.anticipo) * cantidad;
  return bruto - descuento - anticipo;
};

export const consolidarItems = (items: Item[], opciones: OpcionesConsolidacion): Item[] => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new BadRequestError('No hay ítems para consolidar');
  }
  const descripcion = String(opciones.descripcion ?? '').trim();
  if (descripcion.length < 1 || descripcion.length > 120) {
    throw new BadRequestError(
      'consolidacion.descripcion es obligatoria y debe tener entre 1 y 120 caracteres',
    );
  }

  // Agrupadas por tratamiento de IVA; se preserva el orden de aparición.
  const grupos = new Map<string, { item: Item; total: number }>();
  for (const item of items) {
    const ivaTipo = item.ivaTipo ?? 1;
    const iva = item.iva ?? 10;
    const ivaBase = item.ivaBase ?? 100;
    const clave = `${ivaTipo}|${iva}|${ivaBase}`;
    const existente = grupos.get(clave);
    if (existente) {
      existente.total += totalItem(item);
    } else {
      grupos.set(clave, { item, total: totalItem(item) });
    }
  }

  return [...grupos.values()].map(({ item, total }) => ({
    codigo: opciones.codigo ?? '000',
    descripcion,
    unidadMedida: opciones.unidadMedida ?? 77,
    cantidad: 1,
    precioUnitario: total,
    cambio: item.cambio ?? 0,
    descuento: 0,
    anticipo: 0,
    pais: item.pais ?? 'PRY',
    paisDescripcion: item.paisDescripcion ?? 'Paraguay',
    ivaTipo: item.ivaTipo ?? 1,
    ivaBase: item.ivaBase ?? 100,
    iva: item.iva ?? 10,
  }));
};
