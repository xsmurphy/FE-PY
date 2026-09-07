/**
 * Envío de DE a SIFEN por el canal de LOTE — el único habilitado en
 * producción para emisores reales.
 *
 * Contexto (verificado contra SIFEN producción, 2026-09-07): el servicio
 * síncrono `recibe` responde 1264 "RUC del emisor no está habilitado para
 * utilizar este tipo de servicio" aun con el RUC perfectamente habilitado.
 * El flujo real es: recibeLote (encola, responde 0300 + número de lote) →
 * consultaLote (veredicto por documento: dEstRes + dProtAut). SIFEN procesa
 * el lote en segundos, así que el poll corto mantiene la emisión
 * efectivamente síncrona para el cliente del API.
 *
 * Compartido por de.service (emisión) y sifen-retry.worker (reintentos).
 */
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  extractLoteNumero,
  extractLoteCodigoRecepcion,
  extractLoteCodigoConsulta,
  extractLoteResultado,
  extractSifenMensaje,
} from '../lib/sifen-response.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const setapi = require('facturacionelectronicapy-setapi').default;

const LOTE_RECIBIDO_OK = '0300';
const LOTE_EN_PROCESAMIENTO = '0361';
const LOTE_CONCLUIDO = '0362';

// Backoff del poll: SIFEN suele concluir el lote en el primer intento.
// Total ~30s antes de rendirse y dejar el documento en 'enviando'.
const POLL_DELAYS_MS = [2_000, 3_000, 5_000, 8_000, 12_000];

export interface SifenSendResult {
  /** 'aprobado' | 'rechazado' → veredicto final de SIFEN.
   *  'enviando' → lote aceptado pero sin veredicto dentro del timeout
   *  (consultar después con el loteNumero).
   *  'error' → SIFEN no aceptó el lote. */
  estado: 'aprobado' | 'rechazado' | 'enviando' | 'error';
  codigo?: string;
  mensaje?: string;
  protocoloAutorizacion?: string;
  loteNumero?: string;
  /** Última respuesta cruda relevante (consulta si la hubo, si no la recepción). */
  raw: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toRecord = (response: unknown): Record<string, any> =>
  typeof response === 'string' ? { raw: response } : ((response ?? {}) as Record<string, unknown>);

const requestId = (): number => Number(Date.now() % 1_000_000);

/**
 * Consulta el veredicto de un lote YA enviado (sin reenviar — reenviar un
 * CDC ya aprobado lo haría rebotar como duplicado). Para el retry worker.
 */
export const consultarVeredictoLote = async (input: {
  loteNumero: string;
  cdc: string;
  env: 'test' | 'prod';
  certPath: string;
  certPassword: string;
}): Promise<SifenSendResult> => {
  const { loteNumero, cdc, env, certPath, certPassword } = input;
  const consulta = toRecord(
    await setapi.consultaLote(requestId(), loteNumero as unknown as number, env, certPath, certPassword),
  );

  const codigoConsulta = extractLoteCodigoConsulta(consulta);
  if (codigoConsulta === LOTE_EN_PROCESAMIENTO) {
    return {
      estado: 'enviando',
      codigo: codigoConsulta,
      mensaje: `Lote ${loteNumero} aún en procesamiento`,
      loteNumero,
      raw: consulta,
    };
  }
  if (codigoConsulta !== LOTE_CONCLUIDO) {
    return {
      estado: 'error',
      codigo: codigoConsulta,
      mensaje: extractSifenMensaje(consulta) ?? 'Respuesta de consulta de lote no reconocida',
      loteNumero,
      raw: consulta,
    };
  }

  const resultado = extractLoteResultado(consulta, cdc);
  if (resultado?.estado) {
    return {
      estado: resultado.estado,
      codigo: resultado.codigo,
      mensaje: resultado.mensaje,
      protocoloAutorizacion: resultado.protocoloAutorizacion,
      loteNumero,
      raw: consulta,
    };
  }
  return {
    estado: 'error',
    codigo: codigoConsulta,
    mensaje: 'Lote concluido sin veredicto por documento',
    loteNumero,
    raw: consulta,
  };
};

/**
 * Envía un XML firmado (con QR) a SIFEN vía lote y espera el veredicto.
 * No maneja el cert cifrado: recibe el path del .p12 temporal ya escrito
 * por el caller (que es quien controla el ciclo de vida del archivo).
 */
export const sendDeViaLote = async (input: {
  xml: string;
  cdc: string;
  env: 'test' | 'prod';
  certPath: string;
  certPassword: string;
}): Promise<SifenSendResult> => {
  const { xml, cdc, env, certPath, certPassword } = input;

  // 1. Enviar el lote (array de 1 documento)
  const recepcion = toRecord(await setapi.recibeLote(requestId(), [xml], env, certPath, certPassword));
  const codigoRecepcion = extractLoteCodigoRecepcion(recepcion);
  const loteNumero = extractLoteNumero(recepcion);

  if (codigoRecepcion !== LOTE_RECIBIDO_OK || !loteNumero) {
    return {
      estado: 'error',
      codigo: codigoRecepcion,
      mensaje: extractSifenMensaje(recepcion) ?? 'SIFEN no aceptó el lote',
      raw: recepcion,
    };
  }

  // 2. Poll de consultaLote hasta veredicto o timeout
  let ultima: SifenSendResult | undefined;
  for (const delay of POLL_DELAYS_MS) {
    await sleep(delay);
    ultima = await consultarVeredictoLote({ loteNumero, cdc, env, certPath, certPassword });
    if (ultima.estado !== 'enviando') return ultima;
  }

  // 3. Timeout: el lote quedó aceptado, el veredicto se consulta después
  return {
    estado: 'enviando',
    mensaje: `Lote ${loteNumero} aceptado por SIFEN, veredicto pendiente`,
    loteNumero,
    raw: ultima?.raw ?? recepcion,
  };
};
