import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { eventos } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenantScope } from '../middleware/tenant-scope.js';
import { idempotencyCheck, idempotencyPersist } from '../middleware/idempotency.js';
import { cancelarDocumento } from '../services/evento.service.js';

const eventoResponseSchema = z.object({
  id: z.string().uuid(),
  cdc: z.string().length(44),
  tipoEvento: z.enum([
    'cancelacion',
    'inutilizacion',
    'conformidad',
    'disconformidad',
    'desconocimiento',
    'notificacion',
    'nominacion',
    'actualizacion_transporte',
  ]),
  estado: z.enum(['pendiente', 'enviado', 'aprobado', 'rechazado', 'error']),
  xmlStorageKey: z.string().nullable(),
  sifenCodigoRespuesta: z.string().optional(),
  sifenMensaje: z.string().optional(),
  signed: z.boolean(),
  sentToSifen: z.boolean(),
  createdAt: z.string(),
});

const eventoListItemSchema = z.object({
  id: z.string().uuid(),
  cdc: z.string().nullable(),
  tipoEvento: z.string(),
  estado: z.string(),
  createdAt: z.string(),
});

export const eventoRoutes: FastifyPluginAsyncZod = async (app) => {
  // ─────────────────────────────────────────────────────
  // POST /v1/tenants/:tenant_id/eventos/cancelacion
  //
  // Cancela un documento emitido. El motivo debe tener entre 10 y 500 chars
  // (requisito SIFEN). Soporta idempotency key para reintentos seguros.
  // ─────────────────────────────────────────────────────
  app.post(
    '/tenants/:tenant_id/eventos/cancelacion',
    {
      preHandler: [requireAuth, requireTenantScope, idempotencyCheck],
      onSend: [idempotencyPersist],
      schema: {
        tags: ['eventos'],
        summary: 'Cancelar un documento electrónico emitido',
        description:
          'Genera y envía el evento de cancelación a SIFEN. El motivo debe tener ' +
          'entre 10 y 500 caracteres. Un documento solo puede cancelarse una vez.',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        headers: z.object({
          'idempotency-key': z.string().min(8).max(256).optional(),
        }),
        body: z.object({
          cdc: z.string().length(44),
          motivo: z.string().min(10).max(500),
        }),
        response: {
          201: eventoResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await cancelarDocumento({
        companyId: request.company!.id,
        tenant: request.tenant!,
        cdc: request.body.cdc,
        motivo: request.body.motivo,
      });

      return reply.status(201).send({
        id: result.id,
        cdc: result.cdc,
        tipoEvento: result.tipoEvento,
        estado: result.estado,
        xmlStorageKey: result.xmlStorageKey,
        sifenCodigoRespuesta: result.sifenCodigoRespuesta,
        sifenMensaje: result.sifenMensaje,
        signed: result.signed,
        sentToSifen: result.sentToSifen,
        createdAt: result.createdAt.toISOString(),
      });
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id/eventos — listar eventos del tenant
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id/eventos',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['eventos'],
        summary: 'Listar eventos del tenant (todos los tipos)',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(200).default(50),
          offset: z.coerce.number().int().nonnegative().default(0),
          cdc: z.string().length(44).optional(),
        }),
        response: {
          200: z.object({
            data: z.array(eventoListItemSchema),
            pagination: z.object({ limit: z.number(), offset: z.number() }),
          }),
        },
      },
    },
    async (request) => {
      const { limit, offset, cdc } = request.query;

      const whereClauses = [
        eq(eventos.companyId, request.company!.id),
        eq(eventos.tenantId, request.tenant!.id),
      ];
      if (cdc) whereClauses.push(eq(eventos.documentCdc, cdc));

      const rows = await db
        .select()
        .from(eventos)
        .where(and(...whereClauses))
        .orderBy(desc(eventos.createdAt))
        .limit(limit)
        .offset(offset);

      return {
        data: rows.map((r) => ({
          id: r.id,
          cdc: r.documentCdc,
          tipoEvento: r.tipoEvento,
          estado: r.estado,
          createdAt: r.createdAt.toISOString(),
        })),
        pagination: { limit, offset },
      };
    },
  );
};
