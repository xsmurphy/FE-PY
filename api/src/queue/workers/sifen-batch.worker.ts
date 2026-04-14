/**
 * Worker: procesa jobs de la queue `sifen-batch`.
 *
 * Cada job corresponde a UN documento de un batch. El worker:
 *   1. Busca el tenant en DB (siempre scoped por company_id)
 *   2. Llama createDeDocument() — exactamente el mismo pipeline del POST /de
 *   3. Si falla por error transitorio (SIFEN down), BullMQ reintenta con
 *      backoff exponencial
 *   4. Si falla por error permanente (validación, cert inválido), el job
 *      queda en failed y no se reintenta
 *
 * El worker no devuelve datos por el valor de retorno — persiste todo en
 * documents/batches tables para que el cliente consulte por GET /batches/:id.
 */
import { Worker, type Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { tenants } from '../../db/schema.js';
import { createDeDocument } from '../../services/de.service.js';
import { getRedisConnection } from '../connection.js';
import type { SifenBatchJobData } from '../queues.js';

export const createSifenBatchWorker = () => {
  const worker = new Worker<SifenBatchJobData, { documentId: string; cdc: string }>(
    'sifen-batch',
    async (job: Job<SifenBatchJobData>) => {
      const { companyId, tenantId, body, batchId, index } = job.data;
      job.log(`[batch ${batchId} #${index}] procesando`);

      // Cargar tenant
      const [tenant] = await db
        .select()
        .from(tenants)
        .where(and(eq(tenants.id, tenantId), eq(tenants.companyId, companyId)))
        .limit(1);

      if (!tenant) {
        throw new Error(`Tenant ${tenantId} not found for company ${companyId}`);
      }

      const result = await createDeDocument({
        companyId,
        tenant,
        body,
        idempotencyKey: `batch-${batchId}-${index}`,
      });

      job.log(`[batch ${batchId} #${index}] OK cdc=${result.cdc}`);
      return { documentId: result.txnId, cdc: result.cdc };
    },
    {
      connection: getRedisConnection(),
      concurrency: 5, // 5 documentos en paralelo por worker
      removeOnComplete: { count: 1000, age: 24 * 3600 },
      removeOnFail: { count: 5000, age: 7 * 24 * 3600 }, // keep fails 7 días
    },
  );

  worker.on('completed', (job, result) => {
    // eslint-disable-next-line no-console
    console.log(`[sifen-batch] ✓ job=${job.id} cdc=${result.cdc}`);
  });

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(
      `[sifen-batch] ✗ job=${job?.id} attempt=${job?.attemptsMade} err=${err.message}`,
    );
  });

  return worker;
};
