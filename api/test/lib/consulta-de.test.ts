/**
 * Parser de la consulta de DE por CDC (rEnviConsDeResponse).
 *
 * SIFEN devuelve el documento en xContenDE, a veces como texto XML escapado
 * y a veces ya parseado a objeto por el cliente SOAP. Las dos formas tienen
 * que dar el mismo bloque de timbrado — en particular la serie, que es el
 * dato por el que existe esta consulta (rechazo 1110, 2026-09-15).
 */
import { describe, it, expect } from 'vitest';
import { extractConsultaDe } from '../../src/lib/sifen-response.js';

const deXml = (serie: string | null) =>
  '<rContDe><rDE><DE Id="01035951931001001000083712026090510000000010"><gTimb>' +
  '<iTiDE>1</iTiDE><dDesTiDE>Factura electrónica</dDesTiDE><dNumTim>18260177</dNumTim>' +
  '<dEst>001</dEst><dPunExp>001</dPunExp><dNumDoc>0000837</dNumDoc>' +
  (serie ? `<dSerieNum>${serie}</dSerieNum>` : '') +
  '<dFeIniT>2025-08-26</dFeIniT></gTimb><gDatGralOpe><dFeEmiDE>2026-09-05T10:00:00</dFeEmiDE></gDatGralOpe>' +
  '</DE></rDE><dProtAut>1234567890</dProtAut></rContDe>';

const escapar = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

describe('extractConsultaDe', () => {
  it('xContenDE como texto escapado: lee serie, punto, número y protocolo', () => {
    const r = extractConsultaDe({
      'ns2:rEnviConsDeResponse': {
        'ns2:dCodRes': '0422',
        'ns2:dMsgRes': 'CDC encontrado',
        'ns2:xContenDE': escapar(deXml('AB')),
      },
    });
    expect(r.encontrado).toBe(true);
    expect(r.timbrado).toMatchObject({
      tipoDocumento: '1', timbrado: '18260177', establecimiento: '001', punto: '001',
      numero: '0000837', serie: 'AB', inicioVigencia: '2025-08-26',
    });
    expect(r.fechaEmision).toBe('2026-09-05T10:00:00');
    expect(r.protocoloAutorizacion).toBe('1234567890');
    expect(r.xml).toContain('<dSerieNum>AB</dSerieNum>');
  });

  it('documento sin serie: serie null (no undefined — "no tiene" es un dato)', () => {
    const r = extractConsultaDe({ rEnviConsDeResponse: { dCodRes: '0422', xContenDE: deXml(null) } });
    expect(r.timbrado?.serie).toBeNull();
  });

  it('xContenDE ya parseado a objeto con namespaces', () => {
    const r = extractConsultaDe({
      'ns2:rEnviConsDeResponse': {
        'ns2:dCodRes': '0422',
        'ns2:xContenDE': {
          'ns2:rContDe': {
            'ns2:rDE': { 'ns2:DE': { 'ns2:gTimb': { 'ns2:dPunExp': '001', 'ns2:dNumDoc': '0000837', 'ns2:dSerieNum': 'AA' } } },
            'ns2:dProtAut': '999',
          },
        },
      },
    });
    expect(r.timbrado?.serie).toBe('AA');
    expect(r.timbrado?.numero).toBe('0000837');
    expect(r.protocoloAutorizacion).toBe('999');
    expect(r.xml).toBeUndefined();
  });

  it('CDC inexistente: encontrado=false y sin timbrado', () => {
    const r = extractConsultaDe({ rEnviConsDeResponse: { dCodRes: '0420', dMsgRes: 'CDC inexistente' } });
    expect(r.encontrado).toBe(false);
    expect(r.timbrado).toBeUndefined();
    expect(r.mensaje).toBe('CDC inexistente');
  });
});
