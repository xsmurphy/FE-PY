import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { createRequire } from 'node:module';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, tenantCerts } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenantScope, requireActiveTenant } from '../middleware/tenant-scope.js';
import {
  extractSifenCodigo,
  extractSifenMensaje,
  extractSifenEstado,
} from '../lib/sifen-response.js';
import { idempotencyCheck, idempotencyPersist } from '../middleware/idempotency.js';
import { createDeDocument } from '../services/de.service.js';
import { isDocumentCancelled } from '../services/evento.service.js';
import { decryptCertBundle } from '../services/cert.service.js';
import { NotFoundError, BadRequestError, SifenError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { getPresignedDownloadUrl, getObject } from '../storage/s3.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const setapi = require('facturacionelectronicapy-setapi').default;

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
      .union([
        z.literal(1), // Factura Electrónica
        z.literal(4), // Autofactura
        z.literal(5), // Nota de Crédito Electrónica
        z.literal(6), // Nota de Débito Electrónica
        z.literal(7), // Nota de Remisión Electrónica
      ])
      .default(1)
      .describe('1=FE, 4=Autofactura, 5=NC, 6=ND, 7=NR'),
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
  cdc: z.string().length(44).nullable(),
  estado: z.enum(['pendiente', 'aprobado', 'rechazado', 'error']),
  tipo: z.number(),
  numero: z.string(),
  establecimiento: z.string(),
  punto: z.string(),
  moneda: z.string(),
  montoTotal: z.string(),
  fechaEmision: z.string(),
  xmlUrl: z.string().nullable(),
  kudeUrl: z.string().nullable(),
  signed: z.boolean(),
  sentToSifen: z.boolean(),
  cancelled: z.boolean(),
  errorMessage: z.string().nullable().optional(),
  sifen: z
    .object({
      codigoRespuesta: z.string().optional(),
      mensaje: z.string().optional(),
      protocoloAutorizacion: z.string().optional(),
      loteNumero: z.string().optional(),
    })
    .optional(),
  createdAt: z.string(),
});

const documentListItemSchema = z.object({
  txnId: z.string().uuid(),
  cdc: z.string().nullable(),
  tipo: z.number(),
  numero: z.string(),
  establecimiento: z.string(),
  punto: z.string(),
  estado: z.string(),
  montoTotal: z.string(),
  moneda: z.string(),
  fechaEmision: z.string(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
});

// Helper: serializa un document row a la shape pública
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const serializeDocument = async (row: any, withPresignedUrl: boolean) => {
  let xmlUrl: string | null = null;
  let kudeUrl: string | null = null;
  if (withPresignedUrl) {
    if (row.xmlStorageKey) {
      try {
        xmlUrl = await getPresignedDownloadUrl(row.xmlStorageKey, 900);
      } catch {
        xmlUrl = null;
      }
    }
    if (row.kudeStorageKey) {
      try {
        kudeUrl = await getPresignedDownloadUrl(row.kudeStorageKey, 900);
      } catch {
        kudeUrl = null;
      }
    }
  }
  const cancelled = row.cdc ? await isDocumentCancelled(row.tenantId, row.cdc) : false;
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
    kudeUrl,
    signed: !!row.sifenResponseRaw || row.estado === 'aprobado',
    sentToSifen: !!row.sifenResponseRaw,
    errorMessage: row.errorMessage ?? null,
    cancelled,
    sifen: row.sifenCodigoRespuesta
      ? {
          codigoRespuesta: row.sifenCodigoRespuesta,
          mensaje: row.sifenMensaje ?? undefined,
          protocoloAutorizacion: row.sifenProtocoloAutorizacion ?? undefined,
          loteNumero: row.sifenLoteNumero ?? undefined,
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
      preHandler: [requireAuth, requireTenantScope, requireActiveTenant, idempotencyCheck],
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
          errorMessage: r.errorMessage ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
        pagination: { limit, offset },
      };
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id/de/txn/:txn_id — detalle por txnId
  //
  // Un documento que falló ANTES de generar el CDC (estado "error") no es
  // consultable por CDC — sin esta ruta el integrador no puede recuperar
  // el motivo del fallo. El txnId siempre existe, se devuelve en el POST.
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id/de/txn/:txn_id',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['documents'],
        summary: 'Detalle de un documento por txnId (sirve aunque no tenga CDC)',
        security: [{ bearerAuth: [] }],
        params: z.object({
          tenant_id: z.string().uuid(),
          txn_id: z.string().uuid(),
        }),
        response: { 200: deResponseSchema },
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
            eq(documents.id, request.params.txn_id),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundError('Document');
      return serializeDocument(row, true);
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

  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id/de/:cdc/kude — descarga PDF KUDE
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id/de/:cdc/kude',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['documents'],
        summary: 'Descargar el PDF KUDE de un documento',
        description:
          'Devuelve el PDF visual (KUDE) del documento. Requiere que KUDE haya ' +
          'sido generado al emitir (ENABLE_KUDE=true). Si no existe, 404.',
        security: [{ bearerAuth: [] }],
        params: z.object({
          tenant_id: z.string().uuid(),
          cdc: z.string().length(44),
        }),
      },
    },
    async (request, reply) => {
      const [row] = await db
        .select({ kudeKey: documents.kudeStorageKey })
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
      if (!row.kudeKey) {
        throw new NotFoundError(
          'KUDE not available for this document — was it generated with ENABLE_KUDE=true?',
        );
      }

      const pdfBuffer = await getObject(row.kudeKey);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="${request.params.cdc}.pdf"`)
        .send(pdfBuffer);
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id/de/:cdc/xml — descarga directa
  //
  // Devuelve el XML firmado con Content-Type application/xml y
  // Content-Disposition attachment. Útil para clientes que no quieren
  // usar presigned URLs.
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id/de/:cdc/xml',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['documents'],
        summary: 'Descargar el XML firmado de un documento',
        security: [{ bearerAuth: [] }],
        params: z.object({
          tenant_id: z.string().uuid(),
          cdc: z.string().length(44),
        }),
      },
    },
    async (request, reply) => {
      const [row] = await db
        .select({ xmlKey: documents.xmlStorageKey })
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
      if (!row.xmlKey) {
        throw new NotFoundError('XML not available for this document');
      }

      const xmlBuffer = await getObject(row.xmlKey);
      return reply
        .header('content-type', 'application/xml; charset=utf-8')
        .header('content-disposition', `attachment; filename="${request.params.cdc}.xml"`)
        .send(xmlBuffer);
    },
  );

  // ─────────────────────────────────────────────────────
  // POST /v1/tenants/:tenant_id/de/:cdc/consulta — re-query SIFEN
  //
  // Consulta el estado del DE en SIFEN usando setapi.consulta.
  // Útil cuando el estado quedó en "pendiente" o "error" y el cliente
  // quiere saber si SIFEN ya procesó el documento (p. ej. después de
  // un timeout de red en el envío original).
  //
  // Actualiza el document row con la nueva respuesta de SIFEN.
  // ─────────────────────────────────────────────────────
  app.post(
    '/tenants/:tenant_id/de/:cdc/consulta',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['documents'],
        summary: 'Re-consultar el estado de un DE en SIFEN',
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
      if (!env.ENABLE_SIFEN) {
        throw new BadRequestError(
          'SIFEN integration is disabled (ENABLE_SIFEN=false). Set ENABLE_SIFEN=true and configure certificates to use this endpoint.',
        );
      }

      const [docRow] = await db
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
      if (!docRow) throw new NotFoundError('Document');

      // Cargar cert del tenant para autenticar con SIFEN
      const [certRow] = await db
        .select()
        .from(tenantCerts)
        .where(
          and(
            eq(tenantCerts.tenantId, request.tenant!.id),
            eq(tenantCerts.companyId, request.company!.id),
          ),
        )
        .limit(1);
      if (!certRow) throw new NotFoundError('Certificate for tenant');
      if (certRow.revokedAt) {
        throw new BadRequestError('Certificate is revoked');
      }

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

      const tmpCertPath = join(tmpdir(), `cert-query-${randomUUID()}.p12`);

      try {
        await writeFile(tmpCertPath, decrypted.p12, { mode: 0o600 });
        const requestId = Number(Date.now() % 1_000_000);

        let sifenResponseRaw: Record<string, unknown>;
        try {
          const response = await setapi.consulta(
            requestId,
            request.params.cdc,
            request.tenant!.env,
            tmpCertPath,
            decrypted.password,
          );
          sifenResponseRaw =
            typeof response === 'string' ? { raw: response } : (response as Record<string, unknown>);
        } catch (sifenErr) {
          const msg = sifenErr instanceof Error ? sifenErr.message : String(sifenErr);
          throw new SifenError(`Error al consultar SIFEN: ${msg}`);
        }

        // Parser calibrado con producción — ver lib/sifen-response.ts
        const codigo = extractSifenCodigo(sifenResponseRaw);
        const mensaje = extractSifenMensaje(sifenResponseRaw);
        const veredicto = extractSifenEstado(sifenResponseRaw);

        let newEstado: typeof docRow.estado = docRow.estado;
        if (veredicto) {
          newEstado = veredicto;
        } else if (codigo === '0260' || codigo === '0261' || codigo === '0262') {
          newEstado = 'aprobado';
        } else if (codigo === '0422') {
          // 0422 = "CDC encontrado" (verificado en producción 2026-09-07):
          // el documento existe en SIFEN; sin dEstRes en la respuesta,
          // mantener el estado local
          newEstado = docRow.estado;
        } else if (codigo === '0420' || codigo === '0421') {
          // CDC inexistente / no procesado — mantener estado local
          newEstado = docRow.estado;
        } else if (codigo) {
          newEstado = 'rechazado';
        }

        const [updatedRow] = await db
          .update(documents)
          .set({
            estado: newEstado,
            sifenResponseRaw,
            sifenCodigoRespuesta: codigo ?? docRow.sifenCodigoRespuesta,
            sifenMensaje: mensaje ?? docRow.sifenMensaje,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, docRow.id))
          .returning();

        return serializeDocument(updatedRow, true);
      } finally {
        decrypted.p12.fill(0);
        await unlink(tmpCertPath).catch(() => {});
      }
    },
  );
};
