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
 *   4. Si el documento ya tiene lote aceptado (sifen_lote_numero):
 *      SOLO consultar el veredicto — reenviar un CDC ya aprobado rebota
 *      como duplicado. Si no, enviar por recibeLote (sifen-sender).
 *   5. Actualizar document row con el veredicto
 *
 * Cada intento tiene timeout corto — BullMQ maneja los reintentos del job
 * con backoff exponencial.
 */
import { Worker, type Job } from 'bullmq';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { documents, tenants, tenantCerts } from '../../db/schema.js';
import { decryptCertBundle } from '../../services/cert.service.js';
import { sendDeViaLote, consultarVeredictoLote } from '../../services/sifen-sender.js';
import { getObject } from '../../storage/s3.js';
import { getRedisConnection } from '../connection.js';
import type { SifenRetryJobData } from '../queues.js';
import { env } from '../../config/env.js';

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
        },
        password: {
          ciphertext: certRow.encryptedPassword,
          iv: certRow.ivPassword,
          tag: certRow.tagPassword,
        },
        dek: {
          ciphertext: certRow.encryptedDek,
          iv: certRow.ivDek,
          tag: certRow.tagDek,
        },
      });

      const tmpCertPath = join(tmpdir(), `sifen-retry-${randomUUID()}.p12`);

      try {
        await writeFile(tmpCertPath, decrypted.p12, { mode: 0o600 });

        // Lote ya aceptado en un intento previo → solo consultar veredicto.
        // Sin lote previo → enviar por recibeLote (canal de producción).
        const sendResult = doc.sifenLoteNumero
          ? await consultarVeredictoLote({
              loteNumero: doc.sifenLoteNumero,
              cdc,
              env: tenant.env,
              certPath: tmpCertPath,
              certPassword: decrypted.password,
            })
          : await sendDeViaLote({
              xml,
              cdc,
              env: tenant.env,
              certPath: tmpCertPath,
              certPassword: decrypted.password,
            });

        if (sendResult.estado === 'error') {
          // SIFEN no aceptó / respuesta irreconocible — dejar que BullMQ
          // reintente con backoff (el estado del doc no cambia)
          throw new Error(
            `SIFEN lote error (${sendResult.codigo ?? 'sin código'}): ${sendResult.mensaje ?? ''}`,
          );
        }

        // 'enviando' = veredicto aún pendiente → mantener estado, persistir
        // el número de lote para que el próximo intento solo consulte
        const nuevoEstado = sendResult.estado === 'enviando' ? doc.estado : sendResult.estado;

        await db
          .update(documents)
          .set({
            estado: nuevoEstado,
            sifenResponseRaw: sendResult.raw,
            sifenCodigoRespuesta: sendResult.codigo ?? doc.sifenCodigoRespuesta,
            sifenMensaje: sendResult.mensaje ?? doc.sifenMensaje,
            sifenProtocoloAutorizacion:
              sendResult.protocoloAutorizacion ?? doc.sifenProtocoloAutorizacion,
            sifenLoteNumero: sendResult.loteNumero ?? doc.sifenLoteNumero,
            retries: (doc.retries ?? 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, documentId));

        job.log(`[retry ${documentId}] estado=${nuevoEstado} codigo=${sendResult.codigo ?? '-'}`);

        if (sendResult.estado === 'enviando') {
          // Forzar reintento del job para consultar el veredicto más tarde
          throw new Error(`Lote ${sendResult.loteNumero} aún sin veredicto`);
        }
        return { estado: nuevoEstado, codigo: sendResult.codigo };
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
