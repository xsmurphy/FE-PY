/**
 * El KUDE nunca puede recortar el CDC (incidente 2026-09-15).
 *
 * Los templates del paquete cortaban los últimos 8 dígitos. Este test pasa un
 * XML real por el servicio de producción (generateKudePdf, templates de
 * api/kude-templates) y exige los 44 dígitos en el texto del PDF.
 *
 * Necesita Java y pdftotext; si faltan se saltea (la auditoría completa con
 * las fuentes de producción está en kude-patch/README.md).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

process.env.MASTER_KEY_BASE64 = Buffer.alloc(32).toString('base64');
process.env.DATABASE_URL = 'postgres://x:x@localhost:5432/x';
process.env.ENABLE_KUDE = 'true';
// El config valida todo el entorno al importar; el KUDE no usa ninguno de estos.
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_BUCKET = 'x';
process.env.S3_ACCESS_KEY = 'x';
process.env.S3_SECRET_KEY = 'x';

const has = (cmd: string, args: string[]): boolean => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const javaPath = (() => {
  try {
    return execFileSync('which', ['java']).toString().trim();
  } catch {
    return '';
  }
})();
const disponible = javaPath !== '' && has('pdftotext', ['-v']);
if (javaPath) process.env.JAVA_PATH = javaPath;

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const xmlgen = require('facturacionelectronicapy-xmlgen').default;

const params = {
  version: 150,
  ruc: '3595193-1',
  razonSocial: 'GONZALEZ QUEVEDO, CINTIA ESTEFANIA',
  nombreFantasia: 'BALLOON PARTY',
  actividadesEconomicas: [{ codigo: '47733', descripcion: 'VENTA AL POR MENOR' }],
  timbradoNumero: '18260177',
  timbradoFecha: '2025-08-26',
  tipoContribuyente: 1,
  tipoRegimen: 8,
  establecimientos: [
    {
      codigo: '001', denominacion: 'CASA MATRIZ', direccion: 'AVDA ESPANA', numeroCasa: '1234',
      departamento: 11, departamentoDescripcion: 'ALTO PARANA', distrito: 145,
      distritoDescripcion: 'CIUDAD DEL ESTE', ciudad: 3383, ciudadDescripcion: 'CIUDAD DEL ESTE',
      telefono: '021123456', email: 'x@example.com',
    },
  ],
};

const factura = {
  tipoDocumento: 1, establecimiento: '001', punto: '002', numero: '0000615',
  fecha: '2026-09-09T11:01:44', tipoEmision: 1, tipoTransaccion: 1, tipoImpuesto: 1, moneda: 'PYG',
  codigoSeguridadAleatorio: '423631000',
  cliente: {
    contribuyente: true, ruc: '7659394-0', razonSocial: 'MURPHY, CHRISTIAN', tipoOperacion: 1,
    tipoContribuyente: 1, direccion: 'Asuncion', numeroCasa: '0', departamento: 1, distrito: 1,
    ciudad: 1, pais: 'PRY', telefono: '021555444',
  },
  factura: { presencia: 1 },
  condicion: { tipo: 1, entregas: [{ tipo: 1, monto: '500', moneda: 'PYG' }] },
  items: [{ codigo: '001', descripcion: 'Prueba', unidadMedida: 77, cantidad: 1, precioUnitario: 500, ivaTipo: 1, ivaBase: 100, iva: 10 }],
};

describe.skipIf(!disponible)('KUDE — CDC completo en el PDF', () => {
  it('imprime los 44 dígitos del CDC', async () => {
    const xml: string = await xmlgen.generateXMLDE(params, factura);
    const cdc = /Id="(\d{44})"/.exec(xml)![1];

    const { generateKudePdf } = await import('../../src/services/kude.service.js');
    const res = await generateKudePdf(xml, { env: 'prod' });
    expect(res.ok, (res as { reason?: string }).reason).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'kude-test-'));
    const pdfPath = join(dir, 'kude.pdf');
    writeFileSync(pdfPath, res.pdfBuffer!);
    const texto = execFileSync('pdftotext', [pdfPath, '-']).toString();

    // El template agrupa de a 4; comparamos sin espacios.
    expect(texto.replace(/\s+/g, '')).toContain(cdc);
  }, 60_000);
});
