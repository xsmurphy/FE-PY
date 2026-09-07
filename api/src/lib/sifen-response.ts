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
