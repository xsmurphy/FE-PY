import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenantScope } from '../middleware/tenant-scope.js';
import { idempotencyCheck, idempotencyPersist } from '../middleware/idempotency.js';
import { createDeDocument } from '../services/de.service.js';
import { NotFoundError } from '../lib/errors.js';
import { getPresignedDownloadUrl } from '../storage/s3.js';

// ═════════════════════════════════════════════════════════════════
// Schemas zod — validación del body del DE
//
// Usamos .passthrough() en muchas partes porque el motor xmlgen tiene
// ~200 campos posibles. Validar cada uno acá sería duplicar la lógica.
// El motor ya valida todo internamente con reglas de negocio — nosotros
// solo validamos lo mínimo para poder persistir correctamente.
// ═════════════════════════════════════════════════════════════════

const createDeBodySchema = z
  .object({
    tipoDocumento: z
      .union([z.literal(1), z.literal(5)])
      .default(1)
      .describe('1=Factura Electrónica, 5=Nota de Crédito'),
    establecimiento: z.string().regex(/^\d{1,3}$/),
    punto: z.string().regex(/^\d{1,3}$/),
    numero: z.string().regex(/^\d{1,7}$/).optional(),
    codigoSeguridadAleatorio: z.string().regex(/^\d{1,9}$/).optional(),
    fecha: z.string().optional(),
    tipoEmision: z.number().int().min(1).max(2).default(1),
    tipoTransaccion: z.number().int().min(1).max(15),
    tipoImpuesto: z.number().int().min(1).max(5).default(1),
    moneda: z.string().length(3).default('PYG'),
    descripcion: z.string().optional(),
    observacion: z.string().optional(),
    cliente: z.object({}).passthrough(),
    usuario: z.object({}).passthrough().optional(),
    factura: z.object({}).passthrough().optional(),
    condicion: z.object({}).passthrough().optional(),
    items: z.array(z.object({}).passthrough()).min(1),
  })
  .passthrough();

const deResponseSchema = z.object({
  txnId: z.string().uuid(),
  cdc: z.string().length(44),
  estado: z.enum(['pendiente', 'aprobado', 'rechazado', 'error']),
  tipo: z.number(),
  numero: z.string(),
  establecimiento: z.string(),
  punto: z.string(),
  moneda: z.string(),
  montoTotal: z.string(),
  fechaEmision: z.string(),
  xmlUrl: z.string().nullable(),
  signed: z.boolean(),
  sentToSifen: z.boolean(),
  sifen: z
    .object({
      codigoRespuesta: z.string().optional(),
      mensaje: z.string().optional(),
    })
    .optional(),
  createdAt: z.string(),
});

const documentListItemSchema = z.object({
  txnId: z.string().uuid(),
  cdc: z.string(),
  tipo: z.number(),
  numero: z.string(),
  establecimiento: z.string(),
  punto: z.string(),
  estado: z.string(),
  montoTotal: z.string(),
  moneda: z.string(),
  fechaEmision: z.string(),
  createdAt: z.string(),
});

// Helper: serializa un document row a la shape pública
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const serializeDocument = async (row: any, withPresignedUrl: boolean) => {
  let xmlUrl: string | null = null;
  if (row.xmlStorageKey && withPresignedUrl) {
    try {
      xmlUrl = await getPresignedDownloadUrl(row.xmlStorageKey, 900);
    } catch {
      xmlUrl = null;
    }
  }
  return {
    txnId: row.id,
    cdc: row.cdc,
    estado: row.estado,
    tipo: row.tipo,
    numero: row.numero,
    establecimiento: row.establecimiento,
    punto: row.punto,
    moneda: row.moneda,
    montoTotal: row.montoTotal,
    fechaEmision: row.fechaEmision.toISOString(),
    xmlUrl,
    signed: !!row.sifenResponseRaw || row.estado === 'aprobado',
    sentToSifen: !!row.sifenResponseRaw,
    sifen: row.sifenCodigoRespuesta
      ? {
          codigoRespuesta: row.sifenCodigoRespuesta,
          mensaje: row.sifenMensaje ?? undefined,
        }
      : undefined,
    createdAt: row.createdAt.toISOString(),
  };
};

export const documentRoutes: FastifyPluginAsyncZod = async (app) => {
  // ─────────────────────────────────────────────────────
  // POST /v1/tenants/:tenant_id/de — emitir DE síncrono
  // ─────────────────────────────────────────────────────
  app.post(
    '/tenants/:tenant_id/de',
    {
      preHandler: [requireAuth, requireTenantScope, idempotencyCheck],
      onSend: [idempotencyPersist],
      schema: {
        tags: ['documents'],
        summary: 'Emitir un documento electrónico (Factura o Nota de Crédito)',
        description:
          'Genera XML, valida contra XSD, firma y envía a SIFEN (si ENABLE_SIFEN=true). ' +
          'Requiere header `Idempotency-Key` para evitar duplicados en reintentos.',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        headers: z.object({
          'idempotency-key': z.string().min(8).max(256).optional(),
        }),
        body: createDeBodySchema,
        response: {
          201: deResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await createDeDocument({
        companyId: request.company!.id,
        tenant: request.tenant!,
        body: request.body as Record<string, unknown>,
        idempotencyKey: request.idempotency?.key,
      });

      // Recuperamos la fila completa para la respuesta
      const [row] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, result.txnId))
        .limit(1);

      const serialized = await serializeDocument(row, true);
      return reply.status(201).send(serialized);
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id/de — listar documentos
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id/de',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['documents'],
        summary: 'Listar documentos emitidos del tenant',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(200).default(50),
          offset: z.coerce.number().int().nonnegative().default(0),
        }),
        response: {
          200: z.object({
            data: z.array(documentListItemSchema),
            pagination: z.object({ limit: z.number(), offset: z.number() }),
          }),
        },
      },
    },
    async (request) => {
      const { limit, offset } = request.query;

      const rows = await db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.companyId, request.company!.id),
            eq(documents.tenantId, request.tenant!.id),
          ),
        )
        .orderBy(desc(documents.createdAt))
        .limit(limit)
        .offset(offset);

      return {
        data: rows.map((r) => ({
          txnId: r.id,
          cdc: r.cdc,
          tipo: r.tipo,
          numero: r.numero,
          establecimiento: r.establecimiento,
          punto: r.punto,
          estado: r.estado,
          montoTotal: r.montoTotal,
          moneda: r.moneda,
          fechaEmision: r.fechaEmision.toISOString(),
          createdAt: r.createdAt.toISOString(),
        })),
        pagination: { limit, offset },
      };
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id/de/:cdc — detalle por CDC
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id/de/:cdc',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['documents'],
        summary: 'Obtener detalle de un documento por CDC',
        security: [{ bearerAuth: [] }],
        params: z.object({
          tenant_id: z.string().uuid(),
          cdc: z.string().length(44),
        }),
        response: {
          200: deResponseSchema,
        },
      },
    },
    async (request) => {
      const [row] = await db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.companyId, request.company!.id),
            eq(documents.tenantId, request.tenant!.id),
            eq(documents.cdc, request.params.cdc),
          ),
        )
        .limit(1);

      if (!row) throw new NotFoundError('Document');
      return serializeDocument(row, true);
    },
  );
};
