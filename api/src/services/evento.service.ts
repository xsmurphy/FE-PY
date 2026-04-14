/**
 * Evento service: gestiona eventos SIFEN sobre documentos emitidos.
 *
 * MVP: solo cancelación. Los demás eventos (inutilización, conformidad,
 * disconformidad, desconocimiento, notificación, nominación, actualización
 * de transporte) quedan para Fase 3 — usan el mismo patrón y se agregan
 * como métodos adicionales de este módulo cuando haga falta.
 *
 * Pipeline de cancelación (idéntico al de emisión salvo el motor):
 *   1. Validar que el documento exista, sea del tenant, y esté aprobado
 *   2. Validar que no haya sido cancelado previamente
 *   3. Insertar evento row con estado='pendiente'
 *   4. xmlgen.generateXMLEventoCancelacion(id, params, data)
 *   5. Si ENABLE_SIFEN:
 *      - descifrar cert
 *      - xmlsign.signXMLEvento(xml, path, password)
 *      - setapi.evento(id, xmlSigned, env, path, password)
 *      - parsear respuesta y actualizar estado
 *   6. Subir XML del evento a S3
 *   7. Actualizar evento row
 */
import { createRequire } from 'node:module';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, eventos, tenantCerts, type Tenant, type EventoRow } from '../db/schema.js';
import { decryptCertBundle, type EncryptedCertBundle } from './cert.service.js';
import { uploadObject, storageKey } from '../storage/s3.js';
import { env } from '../config/env.js';
import {
  NotFoundError,
  BadRequestError,
  ConflictError,
  SifenError,
  InternalError,
} from '../lib/errors.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const xmlgen = require('facturacionelectronicapy-xmlgen').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const xmlsign = require('facturacionelectronicapy-xmlsign').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const setapi = require('facturacionelectronicapy-setapi').default;

// ═════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════

export interface CancelacionInput {
  companyId: string;
  tenant: Tenant;
  cdc: string;
  motivo: string;
}

export interface EventoResult {
  id: string;
  cdc: string;
  tipoEvento: 'cancelacion';
  estado: 'pendiente' | 'enviado' | 'aprobado' | 'rechazado' | 'error';
  xmlStorageKey: string | null;
  sifenCodigoRespuesta?: string;
  sifenMensaje?: string;
  signed: boolean;
  sentToSifen: boolean;
  createdAt: Date;
}

// ═════════════════════════════════════════════════════════════════
// Helpers privados
// ═════════════════════════════════════════════════════════════════

const buildParamsFromTenant = (tenant: Tenant) => ({
  version: 150,
  ruc: tenant.ruc,
  razonSocial: tenant.razonSocial,
  nombreFantasia: tenant.nombreFantasia ?? tenant.razonSocial,
  actividadesEconomicas: tenant.actividadesEconomicas,
  timbradoNumero: tenant.timbradoNumero,
  timbradoFecha:
    typeof tenant.timbradoFecha === 'string'
      ? tenant.timbradoFecha
      : (tenant.timbradoFecha as unknown as Date).toISOString().slice(0, 10),
  tipoContribuyente: tenant.tipoContribuyente,
  tipoRegimen: tenant.tipoRegimen,
  establecimientos: tenant.establecimientos,
});

const loadTenantCertBundle = async (
  tenantId: string,
  companyId: string,
): Promise<EncryptedCertBundle> => {
  const [row] = await db
    .select()
    .from(tenantCerts)
    .where(and(eq(tenantCerts.tenantId, tenantId), eq(tenantCerts.companyId, companyId)))
    .limit(1);
  if (!row) throw new NotFoundError('Certificate for tenant');
  if (row.revokedAt) throw new BadRequestError('Certificate is revoked');
  if (row.notAfter < new Date()) throw new BadRequestError('Certificate is expired');

  return {
    p12: {
      ciphertext: row.encryptedP12,
      iv: row.ivP12,
      tag: row.tagP12,
      encryptedDek: row.encryptedDek,
      ivDek: row.ivDek,
      tagDek: row.tagDek,
    },
    password: {
      ciphertext: row.encryptedPassword,
      iv: row.ivPassword,
      tag: row.tagPassword,
      encryptedDek: row.encryptedDek,
      ivDek: row.ivDek,
      tagDek: row.tagDek,
    },
  };
};

const signEventoWithBundle = async (
  xml: string,
  bundle: EncryptedCertBundle,
): Promise<string> => {
  const decrypted = decryptCertBundle(bundle);
  const tmpPath = join(tmpdir(), `cert-evt-${randomUUID()}.p12`);

  try {
    await writeFile(tmpPath, decrypted.p12, { mode: 0o600 });
    const xmlSigned = await xmlsign.signXMLEvento(xml, tmpPath, decrypted.password);
    if (typeof xmlSigned !== 'string') {
      throw new InternalError('xmlsign.signXMLEvento returned non-string');
    }
    return xmlSigned;
  } finally {
    decrypted.p12.fill(0);
    await unlink(tmpPath).catch(() => {});
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractSifenCodigo = (resp: Record<string, any>): string | undefined =>
  resp?.dCodRes ?? resp?.gResProcEvento?.dCodRes ?? undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractSifenMensaje = (resp: Record<string, any>): string | undefined =>
  resp?.dMsgRes ?? resp?.gResProcEvento?.dMsgRes ?? undefined;

/**
 * Verifica si un documento ya fue cancelado con éxito previamente.
 * Busca en la tabla eventos una entry tipo=cancelacion con estado=aprobado.
 */
export const isDocumentCancelled = async (
  tenantId: string,
  cdc: string,
): Promise<boolean> => {
  const rows = await db
    .select({ id: eventos.id, estado: eventos.estado })
    .from(eventos)
    .where(
      and(
        eq(eventos.tenantId, tenantId),
        eq(eventos.documentCdc, cdc),
        eq(eventos.tipoEvento, 'cancelacion'),
      ),
    );
  return rows.some((r) => r.estado === 'aprobado' || r.estado === 'enviado');
};

// ═════════════════════════════════════════════════════════════════
// Pipeline de cancelación
// ═════════════════════════════════════════════════════════════════

export const cancelarDocumento = async (input: CancelacionInput): Promise<EventoResult> => {
  const { companyId, tenant, cdc, motivo } = input;

  // 1. Validar longitud del motivo (SIFEN requiere 10-500 chars)
  if (motivo.length < 10 || motivo.length > 500) {
    throw new BadRequestError('El motivo debe tener entre 10 y 500 caracteres');
  }

  // 2. Buscar el documento y verificar que sea cancelable
  const [docRow] = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.companyId, companyId),
        eq(documents.tenantId, tenant.id),
        eq(documents.cdc, cdc),
      ),
    )
    .limit(1);

  if (!docRow) throw new NotFoundError('Document');

  // Si ENABLE_SIFEN=false el documento puede estar en estado "pendiente" porque
  // nunca fue enviado. Permitimos cancelar en ambos casos para poder testear el
  // flujo sin SIFEN real. Con SIFEN activo, solo documentos aprobados son
  // cancelables.
  if (env.ENABLE_SIFEN && docRow.estado !== 'aprobado') {
    throw new ConflictError(
      `El documento no se puede cancelar — estado actual: ${docRow.estado}. Solo documentos aprobados son cancelables.`,
    );
  }

  // 3. Verificar que no esté cancelado ya
  const alreadyCancelled = await isDocumentCancelled(tenant.id, cdc);
  if (alreadyCancelled) {
    throw new ConflictError('El documento ya fue cancelado previamente');
  }

  // 4. Insertar evento row con estado pendiente
  const [eventoRow] = await db
    .insert(eventos)
    .values({
      companyId,
      tenantId: tenant.id,
      documentCdc: cdc,
      tipoEvento: 'cancelacion',
      requestJson: { cdc, motivo },
      estado: 'pendiente',
    })
    .returning();

  try {
    // 5. Generar XML del evento con el motor
    const params = buildParamsFromTenant(tenant);
    const eventoData = { cdc, motivo };

    // SIFEN usa el campo `id` como índice del evento dentro de una submission.
    // Para envíos single-evento (nuestro MVP), siempre 1.
    const sifenEventoId = 1;

    const xml: string = await xmlgen.generateXMLEventoCancelacion(
      sifenEventoId,
      params,
      eventoData,
    );

    let xmlFinal = xml;
    let signed = false;
    let sentToSifen = false;
    let estado: EventoRow['estado'] = 'pendiente';
    let sifenCodigoRespuesta: string | undefined;
    let sifenMensaje: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sifenResponseRaw: Record<string, any> | undefined;

    // 6. Firmar + enviar (gated por ENABLE_SIFEN)
    if (env.ENABLE_SIFEN) {
      const certBundle = await loadTenantCertBundle(tenant.id, companyId);
      xmlFinal = await signEventoWithBundle(xml, certBundle);
      signed = true;

      // Enviar a SIFEN
      try {
        const decrypted = decryptCertBundle(certBundle);
        const tmpCertPath = join(tmpdir(), `sifen-evt-${randomUUID()}.p12`);
        await writeFile(tmpCertPath, decrypted.p12, { mode: 0o600 });

        try {
          const response = await setapi.evento(
            sifenEventoId,
            xmlFinal,
            tenant.env,
            tmpCertPath,
            decrypted.password,
          );
          sifenResponseRaw =
            typeof response === 'string' ? { raw: response } : (response as Record<string, unknown>);
          sentToSifen = true;

          sifenCodigoRespuesta = extractSifenCodigo(sifenResponseRaw);
          sifenMensaje = extractSifenMensaje(sifenResponseRaw);

          // Códigos SIFEN de aprobación de cancelación (placeholder — calibrar con
          // respuestas reales en Fase 1)
          if (
            sifenCodigoRespuesta === '0260' ||
            sifenCodigoRespuesta === '1001' ||
            sifenCodigoRespuesta === '1002'
          ) {
            estado = 'aprobado';
          } else {
            estado = 'rechazado';
          }
        } finally {
          decrypted.p12.fill(0);
          await unlink(tmpCertPath).catch(() => {});
        }
      } catch (sifenErr) {
        const msg = sifenErr instanceof Error ? sifenErr.message : String(sifenErr);
        throw new SifenError(`Error al enviar evento a SIFEN: ${msg}`);
      }
    } else {
      // Sin SIFEN, consideramos el evento registrado localmente.
      estado = 'pendiente';
    }

    // 7. Subir XML del evento a S3
    const xmlKey = storageKey.evento(companyId, tenant.id, eventoRow.id);
    await uploadObject(xmlKey, xmlFinal, { contentType: 'application/xml' });

    // 8. Actualizar evento row
    const [updated] = await db
      .update(eventos)
      .set({
        xmlStorageKey: xmlKey,
        estado,
        sifenResponseRaw,
      })
      .where(eq(eventos.id, eventoRow.id))
      .returning();

    return {
      id: updated.id,
      cdc,
      tipoEvento: 'cancelacion',
      estado: updated.estado,
      xmlStorageKey: updated.xmlStorageKey,
      sifenCodigoRespuesta,
      sifenMensaje,
      signed,
      sentToSifen,
      createdAt: updated.createdAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(eventos)
      .set({ estado: 'error', errorMessage: msg })
      .where(eq(eventos.id, eventoRow.id));
    throw err;
  }
};
