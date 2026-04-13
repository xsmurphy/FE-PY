/**
 * Validador XSD via xmllint (libxml2 CLI).
 *
 * Se usa xmllint (preinstalado en macOS, instalado vía apk add libxml2-utils
 * en el Dockerfile) en vez de bindings Node nativos porque:
 *   - libxmljs2 no compila en Node 25+
 *   - xmllint soporta mejor `<xs:include>` anidados
 *   - Es el motor XSD más battle-tested del mundo
 *
 * Dos modos:
 *   - pre-firma → valida contra xsd-unsigned/ (Signature es opcional)
 *   - estricto  → valida contra xsd/ (Signature obligatorio, para post-firma)
 */
import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Los XSDs viven fuera del subdirectorio api/ — en el root del repo FE-PY.
// En dev: api/src/lib/xsd-validator.ts → /FE-PY/xsd-unsigned/
// En build: api/dist/lib/xsd-validator.js → /FE-PY/xsd-unsigned/
// En Docker: /app/api/dist/lib/xsd-validator.js + /app/parent/xsd-unsigned/
const resolveSchemaPath = (envVar: string | undefined, fallback: string): string => {
  if (envVar) return envVar;
  // Heurística: buscar en ../../ (desde src/lib o dist/lib)
  const candidate = resolve(__dirname, '../../..', fallback);
  return candidate;
};

export const SCHEMA_UNSIGNED = resolveSchemaPath(
  process.env.XSD_UNSIGNED_PATH,
  'xsd-unsigned/siRecepDE_v150.xsd',
);
export const SCHEMA_STRICT = resolveSchemaPath(
  process.env.XSD_STRICT_PATH,
  'xsd/siRecepDE_v150.xsd',
);

export interface XsdValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Valida un XML contra un XSD. No lanza — devuelve el resultado estructurado
 * para que el caller decida si abortar o loguear.
 */
export const validateXsd = async (
  xml: string,
  schemaPath: string,
): Promise<XsdValidationResult> => {
  const tmpPath = join(tmpdir(), `xmlgen-${randomUUID()}.xml`);
  await writeFile(tmpPath, xml, 'utf8');

  return new Promise<XsdValidationResult>((resolve) => {
    execFile('xmllint', ['--noout', '--schema', schemaPath, tmpPath], (err, stdout, stderr) => {
      unlink(tmpPath).catch(() => {});
      const output = (stderr ?? '') + (stdout ?? '');
      const lines = output
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const errors = lines
        .filter((l) => l.includes('validity error') || l.includes('Schemas validity'))
        .map((l) =>
          l
            .replace(/^.*?:\s*\d+:\s*/, '')
            .replace(/^element\s+\w+:\s*/i, '')
            .replace(/^Schemas validity error\s*:\s*/, ''),
        );
      resolve({
        valid: !err && errors.length === 0,
        errors,
      });
    });
  });
};

/** Atajo: valida contra el schema pre-firma. */
export const validatePreSigning = (xml: string) => validateXsd(xml, SCHEMA_UNSIGNED);

/** Atajo: valida contra el schema estricto (post-firma). */
export const validatePostSigning = (xml: string) => validateXsd(xml, SCHEMA_STRICT);
