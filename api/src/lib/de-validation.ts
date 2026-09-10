/**
 * Validación semántica por tipo de documento, previa a xmlgen.
 *
 * Por qué existe (y por qué NO vive en el schema zod de la ruta):
 * `POST /de` no es el único camino de emisión — el batch (`POST /de/batch`)
 * encola bodies crudos que el worker pasa directo a `createDeDocument`.
 * Si estas reglas vivieran en el schema de la ruta, un lote de remisiones
 * mal armadas no daría error de campo sino un stack de xmlgen. Vive acá,
 * y `de.service` la invoca ANTES de reservar el número — así un documento
 * inválido no consume correlativo.
 *
 * Alcance: solo las reglas condicionales por `tipoDocumento` que xmlgen o
 * el XSD exigen pero que el schema de la ruta no puede expresar (o que
 * xmlgen directamente NO chequea, ver `detalleTransporte.tipoResponsable`).
 * El resto de la validación de campos la sigue haciendo xmlgen.
 */
import { ValidationError } from './errors.js';

// Tablas del manual técnico (E-de-la-SET). Duplicadas acá a propósito:
// son parte del contrato de NUESTRA API, y queremos que el mensaje de
// error liste los valores válidos sin depender de internals de xmlgen.
export const MOTIVOS_REMISION: Record<number, string> = {
  1: 'Traslado por ventas',
  2: 'Traslado por consignación',
  3: 'Exportación',
  4: 'Traslado por compra',
  5: 'Importación',
  6: 'Traslado por devolución',
  7: 'Traslado entre locales de la empresa',
  8: 'Traslado de bienes por transformación',
  9: 'Traslado de bienes por reparación',
  10: 'Traslado por emisor móvil',
  11: 'Exhibición o demostración',
  12: 'Participación en ferias',
  13: 'Traslado de encomienda',
  14: 'Decomiso',
  99: 'Otro',
};

export const RESPONSABLES_REMISION: Record<number, string> = {
  1: 'Emisor de la factura',
  2: 'Poseedor de la factura y bienes',
  3: 'Empresa transportista',
  4: 'Despachante de Aduanas',
  5: 'Agente de transporte o intermediario',
};

export const TIPOS_TRANSPORTE: Record<number, string> = {
  1: 'Propio',
  2: 'Tercero',
};

export const MODALIDADES_TRANSPORTE: Record<number, string> = {
  1: 'Terrestre',
  2: 'Fluvial',
  3: 'Aéreo',
  4: 'Multimodal',
};

/** iRespFlete (E903) — responsable por el COSTO DEL FLETE. */
export const RESPONSABLES_FLETE: Record<number, string> = {
  1: 'Emisor de la factura electrónica',
  2: 'Receptor de la factura electrónica',
  3: 'Tercero',
  4: 'Agente intermediario del transporte',
  5: 'Transporte propio',
};

const listar = (tabla: Record<number, string>): string =>
  Object.entries(tabla)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

/**
 * Nota de Remisión Electrónica (iTiDE=7).
 *
 * Diferencias con una FE que sorprenden al integrador:
 *   - NO lleva gOpeCom: `tipoTransaccion`, `moneda` y `condicion` se ignoran.
 *   - NO lleva totales ni IVA por ítem: los ítems son cantidad + unidad, sin precio.
 *   - `cliente.direccion` + `cliente.numeroCasa` son obligatorios (a dónde va la mercadería).
 *   - `detalleTransporte.tipoResponsable` (iRespFlete) es obligatorio por XSD
 *     pero xmlgen NO lo valida: sin él el documento explota recién en la
 *     validación XSD con un error ilegible. Por eso lo exigimos acá.
 */
const validarRemision = (body: Body, errores: string[]): void => {
  const remision = body.remision;
  if (!remision || typeof remision !== 'object') {
    errores.push('remision es obligatorio para tipoDocumento=7 (motivo, tipoResponsable, kms)');
  } else {
    const motivo = Number(remision.motivo);
    if (!remision.motivo) {
      errores.push(`remision.motivo es obligatorio. Valores: ${listar(MOTIVOS_REMISION)}`);
    } else if (!(motivo in MOTIVOS_REMISION)) {
      errores.push(`remision.motivo=${remision.motivo} inválido. Valores: ${listar(MOTIVOS_REMISION)}`);
    } else if (motivo === 99 && !remision.motivoDescripcion) {
      errores.push('remision.motivoDescripcion es obligatorio cuando remision.motivo=99 (Otro)');
    }

    const responsable = Number(remision.tipoResponsable);
    if (!remision.tipoResponsable) {
      errores.push(
        `remision.tipoResponsable es obligatorio. Valores: ${listar(RESPONSABLES_REMISION)}`,
      );
    } else if (!(responsable in RESPONSABLES_REMISION)) {
      errores.push(
        `remision.tipoResponsable=${remision.tipoResponsable} inválido. Valores: ${listar(RESPONSABLES_REMISION)}`,
      );
    }

    const kms = Number(remision.kms);
    if (remision.kms == null || !Number.isFinite(kms) || kms <= 0) {
      errores.push('remision.kms es obligatorio y debe ser un número positivo (km estimados del traslado)');
    }

    if (remision.fechaFactura != null && !ISO_DATE.test(String(remision.fechaFactura))) {
      errores.push('remision.fechaFactura debe tener formato yyyy-MM-dd');
    }
  }

  const transporte = body.detalleTransporte;
  if (!transporte || typeof transporte !== 'object') {
    errores.push(
      'detalleTransporte es obligatorio para tipoDocumento=7 (tipo, modalidad, tipoResponsable, inicioEstimadoTranslado, finEstimadoTranslado)',
    );
  } else {
    if (!(Number(transporte.tipo) in TIPOS_TRANSPORTE)) {
      errores.push(
        `detalleTransporte.tipo es obligatorio. Valores: ${listar(TIPOS_TRANSPORTE)}`,
      );
    }
    if (!(Number(transporte.modalidad) in MODALIDADES_TRANSPORTE)) {
      errores.push(
        `detalleTransporte.modalidad es obligatorio. Valores: ${listar(MODALIDADES_TRANSPORTE)}`,
      );
    }
    // iRespFlete: obligatorio por XSD (tgTransp), NO validado por xmlgen.
    if (!(Number(transporte.tipoResponsable) in RESPONSABLES_FLETE)) {
      errores.push(
        `detalleTransporte.tipoResponsable (responsable del costo del flete) es obligatorio. Valores: ${listar(RESPONSABLES_FLETE)}`,
      );
    }
    for (const campo of ['inicioEstimadoTranslado', 'finEstimadoTranslado'] as const) {
      const valor = transporte[campo];
      if (!valor) {
        errores.push(`detalleTransporte.${campo} es obligatorio. Formato yyyy-MM-dd`);
      } else if (!ISO_DATE.test(String(valor))) {
        errores.push(`detalleTransporte.${campo}="${valor}" inválido. Formato yyyy-MM-dd`);
      }
    }
    if (
      ISO_DATE.test(String(transporte.inicioEstimadoTranslado)) &&
      ISO_DATE.test(String(transporte.finEstimadoTranslado)) &&
      String(transporte.finEstimadoTranslado) < String(transporte.inicioEstimadoTranslado)
    ) {
      errores.push(
        'detalleTransporte.finEstimadoTranslado no puede ser anterior a inicioEstimadoTranslado',
      );
    }
  }

  const cliente = body.cliente;
  if (cliente && typeof cliente === 'object') {
    if (!cliente.direccion) {
      errores.push('cliente.direccion es obligatorio para tipoDocumento=7 (destino de la mercadería)');
    }
    if (cliente.direccion && cliente.numeroCasa == null) {
      errores.push('cliente.numeroCasa es obligatorio cuando se informa cliente.direccion');
    }
  }

  // Motivo 7 = traslado entre locales propios: SIFEN exige que emisor y
  // receptor sean el MISMO RUC. xmlgen lo valida, pero el mensaje sale
  // sin contexto de cuál es cuál.
  if (Number(body.remision?.motivo) === 7 && body.cliente && !body.cliente.ruc) {
    errores.push(
      'remision.motivo=7 (traslado entre locales) exige cliente.ruc igual al RUC del emisor',
    );
  }
};

/**
 * Reglas que dependen del tipoDocumento y que deben correr en TODOS los
 * caminos de emisión (síncrono y batch). Lanza 422 con la lista completa
 * de problemas — no corta en el primero, así el integrador arregla todo
 * de una pasada.
 */
export const validarDocumentoPorTipo = (body: Body): void => {
  const tipo = Number(body.tipoDocumento ?? 1);
  const errores: string[] = [];

  if (tipo === 7) {
    validarRemision(body, errores);
  } else if (!body.tipoTransaccion) {
    // gOpeCom existe para todo lo que no sea remisión.
    errores.push('tipoTransaccion es obligatorio para tipoDocumento != 7');
  }

  if (errores.length > 0) {
    throw new ValidationError(
      `El documento tipo ${tipo} tiene ${errores.length} problema(s) de validación`,
      { errores },
    );
  }
};
