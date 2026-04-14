/**
 * KUDE service: genera el PDF visual del Documento Electrónico
 * usando `facturacionelectronicapy-kude` (que wrappea un JAR Java interno).
 *
 * IMPORTANTE — estado de este módulo:
 *
 * El paquete `facturacionelectronicapy-kude` tiene una API inconsistente:
 * - Firma externa declarada: generateKUDE(java8Path, xmlSigned, urlLogo, ambiente)
 * - Firma interna real:      generateKUDE(java8Path, xml, srcJasper, destFolder, jsonParam)
 *
 * El wrapper externo pasa solo 4 params a una función que espera 5, y además
 * el `xml` del inner API debe ser un PATH a un archivo XML (no contenido),
 * porque lo pasa como argumento de línea de comando a Java. Tampoco los paths
 * pueden tener espacios.
 *
 * Nuestra estrategia:
 *   1. Bypass del wrapper externo roto — llamamos a KUDEGen directamente
 *   2. Escribimos el XML firmado a un tmp file con path sin espacios
 *   3. Usamos los jasper templates bundleados en node_modules/.../dist/DE/
 *   4. Generamos el PDF en un tmp dir, leemos el buffer, borramos todo
 *   5. Todo gated por ENABLE_KUDE — si Java no está instalado, devuelve null
 *
 * Requisitos runtime:
 *   - Java 8+ instalado en el container (JAVA_PATH env var apunta a él)
 *   - Alpine: apk add openjdk17-jre-headless
 *   - El path donde corre Node NO debe tener espacios en su absolute path
 *     (limitación del wrapper Java — si hay espacios, fallan los argumentos)
 *
 * Pendiente de validar:
 *   Este módulo nunca se probó end-to-end contra un XML firmado real porque
 *   requiere cert .p12 + Java instalado. Cuando se ejecute por primera vez
 *   en Docker con ENABLE_SIFEN=true y ENABLE_KUDE=true, posiblemente haya
 *   que iterar sobre:
 *     - Encoding del XML (el JAR usa IBM850 internamente)
 *     - jsonParam format (no documentado)
 *     - Qué tiplate jasper cargar según tipoDocumento del DE
 *     - stdout parsing (stdout vs file output)
 */
import { createRequire } from 'node:module';
import { writeFile, readFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { env } from '../config/env.js';
import { extractCdc } from '../lib/cdc.js';

const require = createRequire(import.meta.url);

// Cache del path del paquete y sus templates bundleados
let kudePkgPath: string | null = null;
let jasperTemplatesDir: string | null = null;

const getKudePkgPath = (): string => {
  if (!kudePkgPath) {
    // resolve() nos da el entry point; el path del paquete es su dirname
    const entry = require.resolve('facturacionelectronicapy-kude');
    kudePkgPath = dirname(entry);
  }
  return kudePkgPath;
};

const getJasperTemplatesDir = (): string => {
  if (!jasperTemplatesDir) {
    jasperTemplatesDir = join(getKudePkgPath(), 'DE');
    if (!existsSync(jasperTemplatesDir)) {
      throw new Error(`KUDE jasper templates dir not found: ${jasperTemplatesDir}`);
    }
  }
  return jasperTemplatesDir;
};

/**
 * Resultado de la generación. `ok: false` NO es error — es señal de que
 * KUDE está deshabilitado o no se pudo generar. El pipeline de emisión
 * continúa sin bloquear.
 */
export interface KudeResult {
  ok: boolean;
  pdfBuffer?: Buffer;
  reason?: string;
}

/**
 * Genera el PDF KUDE de un XML firmado.
 *
 * Retorna {ok: false} si ENABLE_KUDE=false o si el paquete/Java no está
 * disponible — el caller debe tratar esto como opcional, no como error.
 */
export const generateKudePdf = async (xmlSigned: string): Promise<KudeResult> => {
  if (!env.ENABLE_KUDE) {
    return { ok: false, reason: 'ENABLE_KUDE=false' };
  }

  const cdc = extractCdc(xmlSigned);
  if (!cdc) {
    return { ok: false, reason: 'XML no contiene CDC válido' };
  }

  // Validar que Java exista antes de seguir
  if (!existsSync(env.JAVA_PATH)) {
    return { ok: false, reason: `Java runtime no encontrado en ${env.JAVA_PATH}` };
  }

  let tmpDir: string | null = null;
  let xmlPath: string | null = null;

  try {
    // Crear tmpdir sin espacios en el path (requisito del wrapper Java)
    tmpDir = await mkdtemp(join(tmpdir(), 'kude-'));
    xmlPath = join(tmpDir, 'de.xml');
    await writeFile(xmlPath, xmlSigned, 'utf8');

    // Importar el módulo interno que tiene la firma correcta
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const KUDEGen = require('facturacionelectronicapy-kude/dist/KUDEGen').default;

    const srcJasper = getJasperTemplatesDir() + '/';
    const destFolder = tmpDir + '/';
    const jsonParam = JSON.stringify({}); // params extra al reporte (logo, etc.)

    // Llamamos directamente al inner API (5 params) en vez del wrapper roto
    await KUDEGen.generateKUDE(env.JAVA_PATH, xmlPath, srcJasper, destFolder, jsonParam);

    // El JAR genera el PDF en destFolder con nombre basado en el CDC
    const pdfPath = join(tmpDir, `${cdc}.pdf`);
    if (!existsSync(pdfPath)) {
      return {
        ok: false,
        reason: `KUDE generation did not produce expected file at ${pdfPath}`,
      };
    }

    const pdfBuffer = await readFile(pdfPath);
    return { ok: true, pdfBuffer };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `KUDE generation error: ${msg}` };
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    if (xmlPath) {
      await unlink(xmlPath).catch(() => {});
    }
  }
};
