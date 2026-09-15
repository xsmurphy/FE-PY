/**
 * Acceso al certificado .p12 de un tenant para llamadas a SIFEN.
 *
 * setapi exige el .p12 como PATH en disco. Este helper concentra lo que
 * cada consulta repetía a mano: cargar la fila, rechazar revocado/vencido,
 * descifrar (envelope AES-GCM), escribir con permisos 0600, y garantizar
 * que el archivo se borra y el buffer se pone en cero pase lo que pase.
 */
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenantCerts } from '../db/schema.js';
import { decryptCertBundle } from './cert.service.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';

export const withTenantCertFile = async <T>(
  input: { companyId: string; tenantId: string; proposito: string },
  fn: (certPath: string, password: string) => Promise<T>,
): Promise<T> => {
  const [row] = await db
    .select()
    .from(tenantCerts)
    .where(and(eq(tenantCerts.tenantId, input.tenantId), eq(tenantCerts.companyId, input.companyId)))
    .limit(1);

  if (!row) throw new NotFoundError('Certificate for tenant');
  if (row.revokedAt) throw new BadRequestError('El certificado del tenant está revocado');
  if (row.notAfter < new Date()) throw new BadRequestError('El certificado del tenant está vencido');

  const decrypted = decryptCertBundle({
    p12: { ciphertext: row.encryptedP12, iv: row.ivP12, tag: row.tagP12 },
    password: { ciphertext: row.encryptedPassword, iv: row.ivPassword, tag: row.tagPassword },
    dek: { ciphertext: row.encryptedDek, iv: row.ivDek, tag: row.tagDek },
  });

  const certPath = join(tmpdir(), `${input.proposito}-${randomUUID()}.p12`);
  try {
    await writeFile(certPath, decrypted.p12, { mode: 0o600 });
    return await fn(certPath, decrypted.password);
  } finally {
    decrypted.p12.fill(0);
    await unlink(certPath).catch(() => {});
  }
};
