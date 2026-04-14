/**
 * Worker: procesa jobs de la queue `sifen-retry`.
 *
 * Se usa cuando un documento fue generado y firmado pero el envío a SIFEN
 * falló por error transitorio (timeout, 5xx, SIFEN caído).
 *
 * Pipeline del retry:
 *   1. Cargar el document row + cert del tenant
 *   2. Si ya está aprobado/rechazado, no reintentar
 *   3. Descargar el XML firmado desde S3 (xml_storage_key)
 *   4. Re-enviar con setapi.recibe
 *   5. Parsear respuesta y actualizar document row
 *
 * Cada intento tiene timeout corto — BullMQ maneja los reintentos del job
 * con backoff exponencial.
 */
import { Worker, type Job } from 'bullmq';
import { createRequire } from 'node:module';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { documents, tenants, tenantCerts } from '../../db/schema.js';
import { decryptCertBundle } from '../../services/cert.service.js';
import { getObject } from '../../storage/s3.js';
import { getRedisConnection } from '../connection.js';
import type { SifenRetryJobData } from '../queues.js';
import { env } from '../../config/env.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const setapi = require('facturacionelectronicapy-setapi').default;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractCodigo = (r: Record<string, any>): string | undefined =>
  r?.dCodRes ?? r?.gResProcDE?.dCodRes ?? r?.rResEnviDe?.gResProcDE?.dCodRes;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractMensaje = (r: Record<string, any>): string | undefined =>
  r?.dMsgRes ?? r?.gResProcDE?.dMsgRes ?? r?.rResEnviDe?.gResProcDE?.dMsgRes;

export const createSifenRetryWorker = () => {
  const worker = new Worker<SifenRetryJobData, { estado: string; codigo?: string }>(
    'sifen-retry',
    async (job: Job<SifenRetryJobData>) => {
      const { documentId, companyId, tenantId, cdc } = job.data;
      job.log(`[retry ${documentId}] intento ${job.attemptsMade + 1}`);

      if (!env.ENABLE_SIFEN) {
        job.log(`[retry ${documentId}] ENABLE_SIFEN=false — skip`);
        return { estado: 'pendiente' };
      }

      // Cargar documento
      const [doc] = await db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.companyId, companyId),
            eq(documents.tenantId, tenantId),
            eq(documents.cdc, cdc),
          ),
        )
        .limit(1);

      if (!doc) throw new Error(`Document ${documentId} not found`);

      // Ya está en estado terminal — nada que reintentar
      if (doc.estado === 'aprobado' || doc.estado === 'rechazado') {
        return { estado: doc.estado };
      }

      // Necesitamos el XML firmado persistido
      if (!doc.xmlStorageKey) {
        throw new Error(`Document ${documentId} has no xmlStorageKey — cannot resend`);
      }

      // Cargar tenant + cert
      const [tenant] = await db
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

      const [certRow] = await db
        .select()
        .from(tenantCerts)
        .where(and(eq(tenantCerts.tenantId, tenantId), eq(tenantCerts.companyId, companyId)))
        .limit(1);
      if (!certRow) throw new Error(`Certificate for tenant ${tenantId} not found`);
      if (certRow.revokedAt) throw new Error('Certificate is revoked');
      if (certRow.notAfter < new Date()) throw new Error('Certificate is expired');

      // Descargar XML firmado desde S3
      const xmlBuffer = await getObject(doc.xmlStorageKey);
      const xml = xmlBuffer.toString('utf8');

      // Descifrar cert para autenticar con SIFEN
      const decrypted = decryptCertBundle({
        p12: {
          ciphertext: certRow.encryptedP12,
          iv: certRow.ivP12,
          tag: certRow.tagP12,
          encryptedDek: certRow.encryptedDek,
          ivDek: certRow.ivDek,
          tagDek: certRow.tagDek,
        },
        password: {
          ciphertext: certRow.encryptedPassword,
          iv: certRow.ivPassword,
          tag: certRow.tagPassword,
          encryptedDek: certRow.encryptedDek,
          ivDek: certRow.ivDek,
          tagDek: certRow.tagDek,
        },
      });

      const tmpCertPath = join(tmpdir(), `sifen-retry-${randomUUID()}.p12`);

      try {
        await writeFile(tmpCertPath, decrypted.p12, { mode: 0o600 });
        const requestId = Number(Date.now() % 1_000_000);

        const response = await setapi.recibe(
          requestId,
          xml,
          tenant.env,
          tmpCertPath,
          decrypted.password,
        );
        const sifenResponseRaw: Record<string, unknown> =
          typeof response === 'string'
            ? { raw: response }
            : (response as Record<string, unknown>);

        const codigo = extractCodigo(sifenResponseRaw);
        const mensaje = extractMensaje(sifenResponseRaw);

        type DocumentEstado =
          | 'pendiente'
          | 'generando'
          | 'firmando'
          | 'enviando'
          | 'aprobado'
          | 'rechazado'
          | 'error';
        let nuevoEstado: DocumentEstado = doc.estado as DocumentEstado;
        if (codigo === '0260' || codigo === '0261' || codigo === '0262') {
          nuevoEstado = 'aprobado';
        } else if (codigo) {
          nuevoEstado = 'rechazado';
        }

        await db
          .update(documents)
          .set({
            estado: nuevoEstado,
            sifenResponseRaw,
            sifenCodigoRespuesta: codigo ?? doc.sifenCodigoRespuesta,
            sifenMensaje: mensaje ?? doc.sifenMensaje,
            retries: (doc.retries ?? 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, documentId));

        job.log(`[retry ${documentId}] estado=${nuevoEstado} codigo=${codigo ?? '-'}`);
        return { estado: nuevoEstado, codigo };
      } finally {
        decrypted.p12.fill(0);
        await unlink(tmpCertPath).catch(() => {});
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 2, // conservador — network-bound a SIFEN
    },
  );

  worker.on('completed', (job, result) => {
    // eslint-disable-next-line no-console
    console.log(`[sifen-retry] ✓ job=${job.id} estado=${result.estado}`);
  });

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(
      `[sifen-retry] ✗ job=${job?.id} attempt=${job?.attemptsMade} err=${err.message}`,
    );
  });

  return worker;
};
