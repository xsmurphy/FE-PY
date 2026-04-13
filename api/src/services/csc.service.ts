/**
 * CSC service: gestión del Código de Seguridad del Contribuyente.
 *
 * El CSC es un secret por tenant que SIFEN entrega en su portal
 * (ekuatia.set.gov.py → Perfil → Ambiente de prueba → CSC). Se usa junto
 * con idCSC para generar el QR que va impreso en el KUDE.
 *
 * No es el certificado digital — es un secret string distinto, y rota
 * independientemente. Por eso vive en su propia tabla (tenant_csc).
 *
 * Se cifra con envelope encryption igual que el .p12.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenantCsc } from '../db/schema.js';
import { envelopeEncrypt, envelopeDecrypt, type EnvelopeEncrypted } from '../crypto/envelope.js';
import { NotFoundError } from '../lib/errors.js';

export interface SetCscInput {
  tenantId: string;
  companyId: string;
  cscId: string;
  csc: string;
}

export interface CscMetadata {
  cscId: string;
  updatedAt: Date;
}

/**
 * Guarda o actualiza el CSC del tenant. Upsert: un solo CSC activo por tenant.
 */
export const setCsc = async (input: SetCscInput): Promise<CscMetadata> => {
  const cscBuffer = Buffer.from(input.csc, 'utf8');
  let bundle: EnvelopeEncrypted;
  try {
    bundle = envelopeEncrypt(cscBuffer);
  } finally {
    cscBuffer.fill(0);
  }

  // Upsert manual: si existe lo reemplaza
  await db
    .delete(tenantCsc)
    .where(eq(tenantCsc.tenantId, input.tenantId));

  const [row] = await db
    .insert(tenantCsc)
    .values({
      tenantId: input.tenantId,
      companyId: input.companyId,
      cscId: input.cscId,
      encryptedCsc: bundle.ciphertext,
      ivCsc: bundle.iv,
      tagCsc: bundle.tag,
      encryptedDek: bundle.encryptedDek,
      ivDek: bundle.ivDek,
      tagDek: bundle.tagDek,
      updatedAt: new Date(),
    })
    .returning({
      cscId: tenantCsc.cscId,
      updatedAt: tenantCsc.updatedAt,
    });

  return row;
};

/**
 * Obtiene metadata del CSC (nunca el valor). Para que el cliente pueda ver
 * cuándo fue actualizado y qué cscId está vigente.
 */
export const getCscMetadata = async (
  tenantId: string,
  companyId: string,
): Promise<CscMetadata | null> => {
  const [row] = await db
    .select({
      cscId: tenantCsc.cscId,
      updatedAt: tenantCsc.updatedAt,
    })
    .from(tenantCsc)
    .where(and(eq(tenantCsc.tenantId, tenantId), eq(tenantCsc.companyId, companyId)))
    .limit(1);
  return row ?? null;
};

/**
 * Descifra el CSC del tenant en memoria. El caller es responsable de
 * limpiar el string devuelto lo antes posible.
 *
 * Este método debería llamarse SOLO desde el pipeline de emisión (en
 * de.service.ts), nunca exponerse por una ruta.
 */
export const decryptTenantCsc = async (
  tenantId: string,
  companyId: string,
): Promise<{ cscId: string; csc: string } | null> => {
  const [row] = await db
    .select()
    .from(tenantCsc)
    .where(and(eq(tenantCsc.tenantId, tenantId), eq(tenantCsc.companyId, companyId)))
    .limit(1);
  if (!row) return null;

  const cscBuf = envelopeDecrypt({
    ciphertext: row.encryptedCsc,
    iv: row.ivCsc,
    tag: row.tagCsc,
    encryptedDek: row.encryptedDek,
    ivDek: row.ivDek,
    tagDek: row.tagDek,
  });
  const csc = cscBuf.toString('utf8');
  cscBuf.fill(0);

  return { cscId: row.cscId, csc };
};

/**
 * Elimina el CSC del tenant. Sin CSC, el pipeline salta el paso de QR
 * pero la emisión sigue funcionando.
 */
export const deleteCsc = async (tenantId: string, companyId: string): Promise<void> => {
  const result = await db
    .delete(tenantCsc)
    .where(and(eq(tenantCsc.tenantId, tenantId), eq(tenantCsc.companyId, companyId)))
    .returning({ tenantId: tenantCsc.tenantId });
  if (result.length === 0) {
    throw new NotFoundError('CSC');
  }
};
