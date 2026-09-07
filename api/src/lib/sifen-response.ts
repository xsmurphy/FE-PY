/**
 * Parsing de respuestas SIFEN (via facturacionelectronicapy-setapi).
 *
 * Calibrado contra una respuesta real de SIFEN PRODUCCIÓN (2026-09-07,
 * servicio recibe DE síncrono):
 *
 * {
 *   "id": 408860,
 *   "ns2:rRetEnviDe": {
 *     "$": { "xmlns:ns2": "http://ekuatia.set.gov.py/sifen/xsd" },
 *     "ns2:rProtDe": {
 *       "ns2:Id": "<CDC de 44 dígitos>",
 *       "ns2:dDigVal": "<hash>",
 *       "ns2:dEstRes": "Aprobado" | "Rechazado",
 *       "ns2:dFecProc": "2026-09-07T19:16:50-03:00",
 *       "ns2:gResProc": { "ns2:dCodRes": "1264", "ns2:dMsgRes": "RUC del emisor no está habilitado..." }
 *     }
 *   }
 * }
 *
 * Claves con prefijo de namespace variable (ns2:, ns3:, o ninguno según el
 * parser SOAP del setapi) — se normalizan recursivamente. gResProc puede ser
 * objeto o array (SIFEN puede devolver múltiples observaciones); tomamos la
 * primera para código/mensaje principal.
 *
 * Los eventos (rRetEnviEvento/rProtEve) comparten los mismos campos hoja
 * (dEstRes, dCodRes, dMsgRes) con otro envelope — por eso la extracción es
 * una búsqueda profunda por clave y no un path fijo.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const stripNsKeys = (value: any): any => {
  if (Array.isArray(value)) return value.map(stripNsKeys);
  if (value !== null && typeof value === 'object') {
    const out: AnyRecord = {};
    for (const [k, v] of Object.entries(value)) {
      out[k.includes(':') ? k.slice(k.indexOf(':') + 1) : k] = stripNsKeys(v);
    }
    return out;
  }
  return value;
};

/**
 * BFS por la primera aparición de `key` en el árbol (claves ya normalizadas).
 * BFS y no DFS: el campo del protocolo principal está más arriba que el de
 * observaciones anidadas.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findDeep = (root: any, key: string): any => {
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (Array.isArray(node)) {
      queue.push(...node);
    } else if (node !== null && typeof node === 'object') {
      if (key in node) return node[key];
      queue.push(...Object.values(node));
    }
  }
  return undefined;
};

const asString = (v: unknown): string | undefined => (v == null ? undefined : String(v));

export const extractSifenCodigo = (resp: AnyRecord): string | undefined =>
  asString(findDeep(stripNsKeys(resp), 'dCodRes'));

export const extractSifenMensaje = (resp: AnyRecord): string | undefined =>
  asString(findDeep(stripNsKeys(resp), 'dMsgRes'));

/**
 * dEstRes ("Aprobado"/"Rechazado") es el veredicto oficial de SIFEN — fuente
 * de verdad observada en producción. Devuelve undefined si no está presente
 * (el caller decide el fallback por código).
 */
export const extractSifenEstado = (resp: AnyRecord): 'aprobado' | 'rechazado' | undefined => {
  const dEstRes = findDeep(stripNsKeys(resp), 'dEstRes');
  if (typeof dEstRes !== 'string') return undefined;
  const normalized = dEstRes.trim().toLowerCase();
  if (normalized === 'aprobado') return 'aprobado';
  if (normalized === 'rechazado') return 'rechazado';
  return undefined;
};

// ═════════════════════════════════════════════════════════════════
// Envío por lote (recibeLote / consultaLote) — canal real de producción
// ═════════════════════════════════════════════════════════════════
//
// Respuestas REALES observadas en producción (2026-09-07):
//
// recibeLote → { "ns2:rResEnviLoteDe": { dFecProc, dCodRes: "0300",
//                dMsgRes: "Lote recibido con éxito",
//                dProtConsLote: "4104242862567045944", dTpoProces: "0" } }
//
// consultaLote → { "ns2:rResEnviConsLoteDe": { dFecProc,
//                  dCodResLot: "0362", dMsgResLot: "Procesamiento de lote {...} concluido",
//                  gResProcLote: { id: "<CDC>", dEstRes: "Aprobado",
//                    dProtAut: "3549197037",
//                    gResProc: { dCodRes: "0260", dMsgRes: "Aprobado" } } } }

/** Número de lote (dProtConsLote) devuelto por recibeLote. Puede exceder
 *  Number.MAX_SAFE_INTEGER (19 dígitos) — SIEMPRE tratarlo como string. */
export const extractLoteNumero = (resp: AnyRecord): string | undefined =>
  asString(findDeep(stripNsKeys(resp), 'dProtConsLote'));

/** Código de recepción del lote: "0300" = recibido con éxito. */
export const extractLoteCodigoRecepcion = (resp: AnyRecord): string | undefined =>
  asString(findDeep(stripNsKeys(resp), 'dCodRes'));

/** Código del estado de procesamiento del lote en consultaLote:
 *  "0361" = en procesamiento (reintentar), "0362" = concluido. */
export const extractLoteCodigoConsulta = (resp: AnyRecord): string | undefined =>
  asString(findDeep(stripNsKeys(resp), 'dCodResLot'));

export interface LoteDeResultado {
  cdc?: string;
  estado?: 'aprobado' | 'rechazado';
  codigo?: string;
  mensaje?: string;
  protocoloAutorizacion?: string;
}

/**
 * Resultado por-documento dentro de la consulta de lote. gResProcLote puede
 * ser objeto (lote de 1) o array (lote de N) — si se pasa `cdc`, devuelve la
 * entrada de ese documento; si no, la primera.
 */
export const extractLoteResultado = (resp: AnyRecord, cdc?: string): LoteDeResultado | undefined => {
  const g = findDeep(stripNsKeys(resp), 'gResProcLote');
  if (g == null) return undefined;
  const entries: AnyRecord[] = Array.isArray(g) ? g : [g];
  const entry = (cdc ? entries.find((e) => asString(e?.id ?? e?.Id) === cdc) : undefined) ?? entries[0];
  if (entry == null) return undefined;
  return {
    cdc: asString(entry.id ?? entry.Id),
    estado: extractSifenEstado(entry),
    codigo: extractSifenCodigo(entry),
    mensaje: extractSifenMensaje(entry),
    protocoloAutorizacion: asString(findDeep(entry, 'dProtAut')),
  };
};
