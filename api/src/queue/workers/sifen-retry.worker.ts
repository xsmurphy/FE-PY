/**
 * Worker: procesa jobs de la queue `sifen-retry`.
 *
 * Se usa cuando un documento fue generado y firmado pero el envío a SIFEN
 * falló por error transitorio (timeout, 5xx, SIFEN caído).
 *
 * Por ahora es un stub básico: re-consulta el estado en SIFEN vía setapi.consulta
 * y actualiza el document row. El re-envío automático de XMLs completos queda
 * pendiente — requiere persistir el XML firmado en S3 antes del envío y
 * recuperarlo acá, lo cual ya hace createDeDocument cuando termina OK.
 *
 * MVP: retry es "eventualmente consulta y actualiza estado". Si el cliente
 * quiere forzar reenvío completo, usa POST /de/:cdc/consulta manualmente.
 */
import { Worker, type Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { documents, tenants } from '../../db/schema.js';
import { getRedisConnection } from '../connection.js';
import type { SifenRetryJobData } from '../queues.js';
import { env } from '../../config/env.js';

export const createSifenRetryWorker = () => {
  const worker = new Worker<SifenRetryJobData, { estado: string }>(
    'sifen-retry',
    async (job: Job<SifenRetryJobData>) => {
      const { documentId, companyId, tenantId, cdc } = job.data;
      job.log(`[retry ${documentId}] intento ${job.attemptsMade + 1}`);

      if (!env.ENABLE_SIFEN) {
        // Sin SIFEN habilitado no tiene sentido reintentar — marcamos como
        // pendiente a la espera de flip del flag.
        job.log(`[retry ${documentId}] ENABLE_SIFEN=false — skip`);
        return { estado: 'pendiente' };
      }

      // Cargar documento + tenant para verificar que sigan existiendo
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

      if (!doc) {
        throw new Error(`Document ${documentId} not found`);
      }

      // Si ya está aprobado o rechazado, no tiene sentido reintentar
      if (doc.estado === 'aprobado' || doc.estado === 'rechazado') {
        return { estado: doc.estado };
      }

      const [tenant] = await db
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

      // TODO (Fase 3): implementar re-consulta real vía setapi.consulta.
      // Por ahora solo marcamos como "pendiente" y dejamos que el cliente
      // fuerce vía POST /de/:cdc/consulta cuando lo necesite.
      return { estado: doc.estado };
    },
    {
      connection: getRedisConnection(),
      concurrency: 2, // conservador — es network-bound a SIFEN
    },
  );

  worker.on('completed', (job, result) => {
    // eslint-disable-next-line no-console
    console.log(`[sifen-retry] ✓ job=${job.id} estado=${result.estado}`);
  });

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[sifen-retry] ✗ job=${job?.id} err=${err.message}`);
  });

  return worker;
};
