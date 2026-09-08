/**
 * Rutas de batch submission.
 *
 * POST /v1/tenants/:id/de/batch
 *   Acepta un array de documentos, los encola en BullMQ (sifen-batch),
 *   y devuelve un batch_id. Cada documento se procesa en paralelo
 *   (limitado por la concurrency del worker) con reintentos automáticos.
 *
 * GET /v1/tenants/:id/de/batch/:batch_id
 *   Agrega los documentos del batch leyendo WHERE idempotency_key LIKE
 *   'batch-{batch_id}-%'. Devuelve totales por estado y lista resumida.
 *
 * Nota arquitectónica: no hay tabla `batches` — reusamos la columna
 * idempotency_key de documents para agrupar. Ventajas: sin nueva tabla,
 * idempotencia por-documento gratis, y el cliente puede consultar un
 * documento individual del batch vía el endpoint normal GET /de/:cdc.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq, like, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenantScope, requireActiveTenant } from '../middleware/tenant-scope.js';
import { sifenBatchQueue } from '../queue/queues.js';

const batchStatusSchema = z.object({
  batchId: z.string().uuid(),
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  generando: z.number().int().nonnegative(),
  aprobado: z.number().int().nonnegative(),
  rechazado: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
  documents: z.array(
    z.object({
      txnId: z.string().uuid(),
      cdc: z.string().nullable(),
      estado: z.string(),
      numero: z.string(),
      index: z.number().int(),
      errorMessage: z.string().nullable(),
    }),
  ),
});

export const batchRoutes: FastifyPluginAsyncZod = async (app) => {
  // ─────────────────────────────────────────────────────
  // POST /v1/tenants/:tenant_id/de/batch
  // ─────────────────────────────────────────────────────
  app.post(
    '/tenants/:tenant_id/de/batch',
    {
      preHandler: [requireAuth, requireTenantScope, requireActiveTenant],
      schema: {
        tags: ['batches'],
        summary: 'Enviar un lote de documentos para emisión asíncrona',
        description:
          'Encola hasta 500 documentos para procesamiento por el worker BullMQ. ' +
          'Retorna inmediatamente con un batch_id para polling vía GET. ' +
          'Cada documento se procesa independientemente con reintentos automáticos ' +
          'ante errores transitorios de SIFEN.',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        body: z.object({
          documents: z
            .array(z.object({}).passthrough())
            .min(1, 'el batch debe tener al menos 1 documento')
            .max(500, 'máximo 500 documentos por batch'),
        }),
        response: {
          202: z.object({
            batchId: z.string().uuid(),
            total: z.number().int(),
            accepted: z.number().int(),
            statusUrl: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const batchId = randomUUID();
      const { documents: docsBody } = request.body;

      const jobs = docsBody.map((body, index) => ({
        name: `batch-${batchId}-${index}`,
        data: {
          batchId,
          companyId: request.company!.id,
          tenantId: request.tenant!.id,
          index,
          body: body as Record<string, unknown>,
        },
        opts: {
          jobId: `batch-${batchId}-${index}`, // idempotente en Redis
        },
      }));

      await sifenBatchQueue.addBulk(jobs);

      request.log.info(
        { batchId, total: docsBody.length, tenantId: request.tenant!.id },
        'Batch enqueued',
      );

      return reply.status(202).send({
        batchId,
        total: docsBody.length,
        accepted: jobs.length,
        statusUrl: `/v1/tenants/${request.tenant!.id}/de/batch/${batchId}`,
      });
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id/de/batch/:batch_id
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id/de/batch/:batch_id',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['batches'],
        summary: 'Consultar estado agregado de un batch',
        security: [{ bearerAuth: [] }],
        params: z.object({
          tenant_id: z.string().uuid(),
          batch_id: z.string().uuid(),
        }),
        response: {
          200: batchStatusSchema,
        },
      },
    },
    async (request) => {
      const { batch_id } = request.params;
      const idempotencyPattern = `batch-${batch_id}-%`;

      const rows = await db
        .select({
          id: documents.id,
          cdc: documents.cdc,
          estado: documents.estado,
          numero: documents.numero,
          errorMessage: documents.errorMessage,
          idempotencyKey: documents.idempotencyKey,
        })
        .from(documents)
        .where(
          and(
            eq(documents.companyId, request.company!.id),
            eq(documents.tenantId, request.tenant!.id),
            like(documents.idempotencyKey, idempotencyPattern),
          ),
        )
        .orderBy(desc(documents.createdAt));

      // Contadores por estado
      const counts = {
        pending: 0,
        generando: 0,
        aprobado: 0,
        rechazado: 0,
        error: 0,
      };

      const docsOut = rows.map((r) => {
        // Extraer índice del idempotency key: "batch-{uuid}-{index}"
        const idxMatch = r.idempotencyKey?.match(/-(\d+)$/);
        const index = idxMatch ? Number(idxMatch[1]) : -1;

        switch (r.estado) {
          case 'pendiente':
            counts.pending++;
            break;
          case 'generando':
          case 'firmando':
          case 'enviando':
            counts.generando++;
            break;
          case 'aprobado':
            counts.aprobado++;
            break;
          case 'rechazado':
            counts.rechazado++;
            break;
          case 'error':
            counts.error++;
            break;
        }

        return {
          txnId: r.id,
          cdc: r.cdc,
          estado: r.estado,
          numero: r.numero,
          index,
          errorMessage: r.errorMessage,
        };
      });

      return {
        batchId: batch_id,
        total: rows.length,
        ...counts,
        documents: docsOut,
      };
    },
  );
};
