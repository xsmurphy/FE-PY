import { describe, it, expect } from 'vitest';
import {
  extractSifenCodigo,
  extractSifenMensaje,
  extractSifenEstado,
  extractLoteNumero,
  extractLoteCodigoRecepcion,
  extractLoteCodigoConsulta,
  extractLoteResultado,
  stripNsKeys,
} from '../../src/lib/sifen-response.js';

/**
 * Respuesta REAL de SIFEN producción capturada el 2026-09-07 (servicio
 * recibe DE síncrono, rechazo 1264). Fixture de regresión: si el parser
 * deja de leer esta estructura, la calibración se rompió.
 */
const realProdResponse = {
  id: 408860,
  'ns2:rRetEnviDe': {
    $: { 'xmlns:ns2': 'http://ekuatia.set.gov.py/sifen/xsd' },
    'ns2:rProtDe': {
      'ns2:Id': '01035951931001002000061212026090714995477705',
      'ns2:dDigVal': 'qW9kuSR4PpkCs8dotovlVk4aEiinC2wlUs4f4xMoojg=',
      'ns2:dEstRes': 'Rechazado',
      'ns2:dFecProc': '2026-09-07T19:16:50-03:00',
      'ns2:gResProc': {
        'ns2:dCodRes': '1264',
        'ns2:dMsgRes': 'RUC del emisor no está habilitado para utilizar este tipo de servicio [3595193]',
      },
    },
  },
};

describe('sifen-response (calibrado con respuesta real de producción)', () => {
  it('extrae dCodRes del envelope real', () => {
    expect(extractSifenCodigo(realProdResponse)).toBe('1264');
  });

  it('extrae dMsgRes del envelope real', () => {
    expect(extractSifenMensaje(realProdResponse)).toBe(
      'RUC del emisor no está habilitado para utilizar este tipo de servicio [3595193]',
    );
  });

  it('extrae dEstRes=Rechazado como veredicto', () => {
    expect(extractSifenEstado(realProdResponse)).toBe('rechazado');
  });

  it('mapea dEstRes=Aprobado', () => {
    const aprobado = structuredClone(realProdResponse);
    (aprobado['ns2:rRetEnviDe']['ns2:rProtDe'] as Record<string, unknown>)['ns2:dEstRes'] =
      'Aprobado';
    expect(extractSifenEstado(aprobado)).toBe('aprobado');
  });

  it('tolera gResProc como array (múltiples observaciones)', () => {
    const multi = {
      'ns2:rRetEnviDe': {
        'ns2:rProtDe': {
          'ns2:dEstRes': 'Rechazado',
          'ns2:gResProc': [
            { 'ns2:dCodRes': '0160', 'ns2:dMsgRes': 'primera observación' },
            { 'ns2:dCodRes': '0161', 'ns2:dMsgRes': 'segunda observación' },
          ],
        },
      },
    };
    expect(extractSifenCodigo(multi)).toBe('0160');
    expect(extractSifenMensaje(multi)).toBe('primera observación');
  });

  it('tolera claves sin prefijo de namespace', () => {
    const sinNs = {
      rRetEnviDe: {
        rProtDe: {
          dEstRes: 'Aprobado',
          gResProc: { dCodRes: '0260', dMsgRes: 'Autorizado el DE' },
        },
      },
    };
    expect(extractSifenCodigo(sinNs)).toBe('0260');
    expect(extractSifenEstado(sinNs)).toBe('aprobado');
  });

  it('devuelve undefined en respuestas irreconocibles sin romper', () => {
    expect(extractSifenCodigo({ raw: 'soap crudo' })).toBeUndefined();
    expect(extractSifenMensaje({})).toBeUndefined();
    expect(extractSifenEstado({ dEstRes: 'Algo raro' })).toBeUndefined();
  });

  it('stripNsKeys normaliza recursivamente y preserva arrays', () => {
    const out = stripNsKeys({ 'a:b': [{ 'c:d': 1 }], e: 2 });
    expect(out).toEqual({ b: [{ d: 1 }], e: 2 });
  });
});

/**
 * Respuestas REALES del canal de lote, SIFEN producción 2026-09-07 —
 * el flujo que aprobó la primera factura (protocolo 3549197037).
 */
const realRecibeLote = {
  'ns2:rResEnviLoteDe': {
    $: { 'xmlns:ns2': 'http://ekuatia.set.gov.py/sifen/xsd' },
    'ns2:dFecProc': '2026-09-07T19:53:45-03:00',
    'ns2:dCodRes': '0300',
    'ns2:dMsgRes': 'Lote recibido con éxito',
    'ns2:dProtConsLote': '4104242862567045944',
    'ns2:dTpoProces': '0',
  },
  id: 622567,
};

const realConsultaLoteAprobado = {
  'ns2:rResEnviConsLoteDe': {
    $: { 'xmlns:ns2': 'http://ekuatia.set.gov.py/sifen/xsd' },
    'ns2:dFecProc': '2026-09-07T19:53:45-03:00',
    'ns2:dCodResLot': '0362',
    'ns2:dMsgResLot': 'Procesamiento de lote {4104242862567045944} concluido',
    'ns2:gResProcLote': {
      'ns2:id': '01035951931001002000061212026090717070521170',
      'ns2:dEstRes': 'Aprobado',
      'ns2:dProtAut': '3549197037',
      'ns2:gResProc': { 'ns2:dCodRes': '0260', 'ns2:dMsgRes': 'Aprobado' },
    },
  },
  id: 667134,
};

describe('sifen-response lote (calibrado con producción)', () => {
  it('extrae número de lote como STRING (excede MAX_SAFE_INTEGER)', () => {
    expect(extractLoteNumero(realRecibeLote)).toBe('4104242862567045944');
    expect(extractLoteCodigoRecepcion(realRecibeLote)).toBe('0300');
  });

  it('extrae código de consulta y resultado aprobado con protocolo', () => {
    expect(extractLoteCodigoConsulta(realConsultaLoteAprobado)).toBe('0362');
    expect(extractLoteResultado(realConsultaLoteAprobado)).toEqual({
      cdc: '01035951931001002000061212026090717070521170',
      estado: 'aprobado',
      codigo: '0260',
      mensaje: 'Aprobado',
      protocoloAutorizacion: '3549197037',
    });
  });

  it('extrae rechazo del lote (respuesta real 1107)', () => {
    const rechazado = {
      'ns2:rResEnviConsLoteDe': {
        'ns2:dCodResLot': '0362',
        'ns2:gResProcLote': {
          'ns2:id': '01035951931001002000061212026090714783447969',
          'ns2:dEstRes': 'Rechazado',
          'ns2:gResProc': {
            'ns2:dCodRes': '1107',
            'ns2:dMsgRes': 'Fecha de inicio de vigencia del timbrado incorrecta',
          },
        },
      },
    };
    const r = extractLoteResultado(rechazado);
    expect(r?.estado).toBe('rechazado');
    expect(r?.codigo).toBe('1107');
    expect(r?.protocoloAutorizacion).toBeUndefined();
  });

  it('selecciona el documento por CDC cuando gResProcLote es array', () => {
    const multi = {
      rResEnviConsLoteDe: {
        dCodResLot: '0362',
        gResProcLote: [
          { id: 'CDC-A', dEstRes: 'Aprobado', dProtAut: '111', gResProc: { dCodRes: '0260' } },
          { id: 'CDC-B', dEstRes: 'Rechazado', gResProc: { dCodRes: '1101' } },
        ],
      },
    };
    expect(extractLoteResultado(multi, 'CDC-B')?.estado).toBe('rechazado');
    expect(extractLoteResultado(multi, 'CDC-A')?.protocoloAutorizacion).toBe('111');
    expect(extractLoteResultado(multi)?.cdc).toBe('CDC-A');
  });
});
