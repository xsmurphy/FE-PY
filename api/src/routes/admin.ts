/**
 * Panel de operador — v1 SOLO LECTURA.
 *
 * Es la vista que hoy no existe: cruza TODAS las companies para que el
 * operador de la plataforma (nosotros) pueda responder "¿qué pasó con este
 * documento?" sin abrir una sesión SSH y escribir SQL contra producción.
 *
 * Dos reglas que no se negocian:
 *   1. Ninguna ruta de acá responde datos si ADMIN_TOKEN no está seteado o
 *      no coincide — el gate vive en requireAdmin y es el primer preHandler
 *      de todas.
 *   2. NO hay mutaciones. Ni un UPDATE, ni un DELETE, ni un POST. Dar de
 *      alta companies o revocar keys ajenas exige auditoría de quién hizo
 *      qué, y eso todavía no existe: hasta entonces el panel solo mira.
 *
 * Las rutas van con `hide: true` en el schema para no listarlas en el
 * OpenAPI público de /docs: el panel no es parte del contrato con los
 * integradores y no hace falta anunciarle a nadie que existe.
 */
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, documents, eventos, tenants } from '../db/schema.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { NotFoundError } from '../lib/errors.js';
import { getPresignedDownloadUrl } from '../storage/s3.js';
import { env } from '../config/env.js';
import { ADMIN_HTML } from './admin-ui.js';

// ─────────────────────────────────────────────────────────────
// Estados de documento: los 7 del enum, no solo los 4 finales.
// 'generando' / 'firmando' / 'enviando' son justamente los que dejan un
// documento colgado, así que esconderlos del panel sería esconder el
// problema que el panel viene a diagnosticar.
// ─────────────────────────────────────────────────────────────
const DOCUMENT_ESTADOS = [
  'pendiente',
  'generando',
  'firmando',
  'enviando',
  'aprobado',
  'rechazado',
  'error',
] as const;

type DocumentEstado = (typeof DOCUMENT_ESTADOS)[number];

type EstadoCount = Record<DocumentEstado, number> & { total: number };

const emptyEstadoCount = (): EstadoCount => ({
  total: 0,
  pendiente: 0,
  generando: 0,
  firmando: 0,
  enviando: 0,
  aprobado: 0,
  rechazado: 0,
  error: 0,
});

const estadoCountSchema = z.object({
  total: z.number(),
  pendiente: z.number(),
  generando: z.number(),
  firmando: z.number(),
  enviando: z.number(),
  aprobado: z.number(),
  rechazado: z.number(),
  error: z.number(),
});

const countStar = sql<number>`count(*)::int`;

/** Presigned URL tolerante a fallos: el panel tiene que abrir igual si S3 no responde. */
const presignOrNull = async (key: string | null): Promise<string | null> => {
  if (!key) return null;
  try {
    return await getPresignedDownloadUrl(key, 900);
  } catch {
    return null;
  }
};

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  // ─────────────────────────────────────────────────────
  // GET /v1/admin/overview — contadores globales
  // ─────────────────────────────────────────────────────
  app.get(
    '/admin/overview',
    {
      preHandler: [requireAdmin],
      schema: {
        hide: true,
        response: {
          200: z.object({
            companies: z.number(),
            tenants: z.number(),
            documentos: estadoCountSchema,
            eventos: z.number(),
          }),
        },
      },
    },
    async () => {
      const [companiesRows, tenantsRows, docRows, eventosRows] = await Promise.all([
        db.select({ n: countStar }).from(companies),
        db.select({ n: countStar }).from(tenants),
        db
          .select({ estado: documents.estado, n: countStar })
          .from(documents)
          .groupBy(documents.estado),
        db.select({ n: countStar }).from(eventos),
      ]);

      const documentos = emptyEstadoCount();
      for (const row of docRows) {
        documentos[row.estado] = row.n;
        documentos.total += row.n;
      }

      return {
        companies: companiesRows[0]?.n ?? 0,
        tenants: tenantsRows[0]?.n ?? 0,
        documentos,
        eventos: eventosRows[0]?.n ?? 0,
      };
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/admin/companies — árbol completo companies → tenants
  //
  // Tres queries planas y armado en memoria en vez de un JOIN con
  // agregaciones anidadas: la cantidad de companies/tenants es chica
  // (decenas), y así el SQL queda legible y sin GROUP BY gigante.
  // ─────────────────────────────────────────────────────
  app.get(
    '/admin/companies',
    {
      preHandler: [requireAdmin],
      schema: {
        hide: true,
        response: {
          200: z.object({
            data: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                email: z.string(),
                status: z.string(),
                apiKeyPrefix: z.string(),
                leyendaDocumento: z.string().nullable(),
                createdAt: z.string(),
                tenants: z.array(
                  z.object({
                    id: z.string(),
                    ruc: z.string(),
                    razonSocial: z.string(),
                    nombreFantasia: z.string().nullable(),
                    env: z.string(),
                    status: z.string(),
                    timbradoNumero: z.string(),
                    createdAt: z.string(),
                    documentos: estadoCountSchema,
                  }),
                ),
              }),
            ),
          }),
        },
      },
    },
    async () => {
      const [companyRows, tenantRows, docCountRows] = await Promise.all([
        db
          .select({
            id: companies.id,
            name: companies.name,
            email: companies.email,
            status: companies.status,
            apiKeyPrefix: companies.apiKeyPrefix,
            leyendaDocumento: companies.leyendaDocumento,
            createdAt: companies.createdAt,
          })
          .from(companies)
          .orderBy(companies.name),
        db
          .select({
            id: tenants.id,
            companyId: tenants.companyId,
            ruc: tenants.ruc,
            razonSocial: tenants.razonSocial,
            nombreFantasia: tenants.nombreFantasia,
            env: tenants.env,
            status: tenants.status,
            timbradoNumero: tenants.timbradoNumero,
            createdAt: tenants.createdAt,
          })
          .from(tenants)
          .orderBy(tenants.razonSocial),
        db
          .select({ tenantId: documents.tenantId, estado: documents.estado, n: countStar })
          .from(documents)
          .groupBy(documents.tenantId, documents.estado),
      ]);

      const countsByTenant = new Map<string, EstadoCount>();
      for (const row of docCountRows) {
        const bucket = countsByTenant.get(row.tenantId) ?? emptyEstadoCount();
        bucket[row.estado] = row.n;
        bucket.total += row.n;
        countsByTenant.set(row.tenantId, bucket);
      }

      const tenantsByCompany = new Map<string, typeof tenantRows>();
      for (const t of tenantRows) {
        const list = tenantsByCompany.get(t.companyId) ?? [];
        list.push(t);
        tenantsByCompany.set(t.companyId, list);
      }

      return {
        data: companyRows.map((c) => ({
          id: c.id,
          name: c.name,
          email: c.email,
          status: c.status,
          apiKeyPrefix: c.apiKeyPrefix,
          leyendaDocumento: c.leyendaDocumento ?? null,
          createdAt: c.createdAt.toISOString(),
          tenants: (tenantsByCompany.get(c.id) ?? []).map((t) => ({
            id: t.id,
            ruc: t.ruc,
            razonSocial: t.razonSocial,
            nombreFantasia: t.nombreFantasia ?? null,
            env: t.env,
            status: t.status,
            timbradoNumero: t.timbradoNumero,
            createdAt: t.createdAt.toISOString(),
            documentos: countsByTenant.get(t.id) ?? emptyEstadoCount(),
          })),
        })),
      };
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/admin/documents — tabla paginada, más nuevo primero
  // ─────────────────────────────────────────────────────
  app.get(
    '/admin/documents',
    {
      preHandler: [requireAdmin],
      schema: {
        hide: true,
        querystring: z.object({
          companyId: z.string().uuid().optional(),
          tenantId: z.string().uuid().optional(),
          estado: z.enum(DOCUMENT_ESTADOS).optional(),
          tipoDocumento: z.coerce.number().int().positive().optional(),
          q: z.string().trim().min(1).optional(),
          limit: z.coerce.number().int().positive().max(200).default(50),
          offset: z.coerce.number().int().nonnegative().default(0),
        }),
        response: {
          200: z.object({
            data: z.array(
              z.object({
                txnId: z.string(),
                companyId: z.string(),
                companyName: z.string(),
                tenantId: z.string(),
                tenantRazonSocial: z.string(),
                tipo: z.number(),
                establecimiento: z.string(),
                punto: z.string(),
                numero: z.string(),
                estado: z.string(),
                cdc: z.string().nullable(),
                montoTotal: z.string(),
                moneda: z.string(),
                fechaEmision: z.string(),
                sifenCodigoRespuesta: z.string().nullable(),
                sifenMensaje: z.string().nullable(),
                errorMessage: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
            total: z.number(),
            pagination: z.object({ limit: z.number(), offset: z.number() }),
          }),
        },
      },
    },
    async (request) => {
      const { companyId, tenantId, estado, tipoDocumento, q, limit, offset } = request.query;

      const filters = [];
      if (companyId) filters.push(eq(documents.companyId, companyId));
      if (tenantId) filters.push(eq(documents.tenantId, tenantId));
      if (estado) filters.push(eq(documents.estado, estado));
      if (tipoDocumento) filters.push(eq(documents.tipo, tipoDocumento));
      if (q) {
        // El operador pega lo que tiene a mano: el CDC entero que le mandó el
        // cliente, o el número de factura suelto. Un CDC completo son 44
        // dígitos exactos; hasta 7 dígitos es número de documento (se guarda
        // con padding a 7). Cualquier otra cosa cae a búsqueda parcial de CDC.
        if (/^\d{44}$/.test(q)) {
          filters.push(eq(documents.cdc, q));
        } else if (/^\d{1,7}$/.test(q)) {
          filters.push(eq(documents.numero, q.padStart(7, '0')));
        } else {
          filters.push(ilike(documents.cdc, `%${q}%`));
        }
      }
      const where = filters.length > 0 ? and(...filters) : undefined;

      // El count va contra `documents` sin los joins porque TODOS los filtros
      // son columnas de documents — sumar los joins solo costaría tiempo.
      const [rows, totalRows] = await Promise.all([
        db
          .select({
            txnId: documents.id,
            companyId: documents.companyId,
            companyName: companies.name,
            tenantId: documents.tenantId,
            tenantRazonSocial: tenants.razonSocial,
            tipo: documents.tipo,
            establecimiento: documents.establecimiento,
            punto: documents.punto,
            numero: documents.numero,
            estado: documents.estado,
            cdc: documents.cdc,
            montoTotal: documents.montoTotal,
            moneda: documents.moneda,
            fechaEmision: documents.fechaEmision,
            sifenCodigoRespuesta: documents.sifenCodigoRespuesta,
            sifenMensaje: documents.sifenMensaje,
            errorMessage: documents.errorMessage,
            createdAt: documents.createdAt,
          })
          .from(documents)
          .innerJoin(tenants, eq(documents.tenantId, tenants.id))
          .innerJoin(companies, eq(documents.companyId, companies.id))
          .where(where)
          .orderBy(desc(documents.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ n: countStar }).from(documents).where(where),
      ]);

      return {
        data: rows.map((r) => ({
          ...r,
          cdc: r.cdc ?? null,
          sifenCodigoRespuesta: r.sifenCodigoRespuesta ?? null,
          sifenMensaje: r.sifenMensaje ?? null,
          errorMessage: r.errorMessage ?? null,
          fechaEmision: r.fechaEmision.toISOString(),
          createdAt: r.createdAt.toISOString(),
        })),
        total: totalRows[0]?.n ?? 0,
        pagination: { limit, offset },
      };
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/admin/documents/:id — detalle completo
  //
  // Devuelve el payload original y la respuesta cruda de SIFEN: cuando un DE
  // sale rechazado, el mensaje resumido casi nunca alcanza para saber qué
  // campo lo rompió.
  // ─────────────────────────────────────────────────────
  app.get(
    '/admin/documents/:id',
    {
      preHandler: [requireAdmin],
      schema: {
        hide: true,
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            txnId: z.string(),
            companyId: z.string(),
            companyName: z.string(),
            tenantId: z.string(),
            tenantRazonSocial: z.string(),
            tenantRuc: z.string(),
            tenantEnv: z.string(),
            tipo: z.number(),
            establecimiento: z.string(),
            punto: z.string(),
            numero: z.string(),
            estado: z.string(),
            cdc: z.string().nullable(),
            montoTotal: z.string(),
            moneda: z.string(),
            fechaEmision: z.string(),
            sifenCodigoRespuesta: z.string().nullable(),
            sifenMensaje: z.string().nullable(),
            sifenProtocoloAutorizacion: z.string().nullable(),
            sifenLoteNumero: z.string().nullable(),
            sifenResponseRaw: z.unknown().nullable(),
            requestJson: z.unknown().nullable(),
            qrUrl: z.string().nullable(),
            xmlStorageKey: z.string().nullable(),
            kudeStorageKey: z.string().nullable(),
            xmlUrl: z.string().nullable(),
            kudeUrl: z.string().nullable(),
            idempotencyKey: z.string().nullable(),
            retries: z.number(),
            errorMessage: z.string().nullable(),
            createdAt: z.string(),
            updatedAt: z.string(),
            eventos: z.array(
              z.object({
                id: z.string(),
                tipoEvento: z.string(),
                estado: z.string(),
                errorMessage: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const [row] = await db
        .select({
          txnId: documents.id,
          companyId: documents.companyId,
          companyName: companies.name,
          tenantId: documents.tenantId,
          tenantRazonSocial: tenants.razonSocial,
          tenantRuc: tenants.ruc,
          tenantEnv: tenants.env,
          tipo: documents.tipo,
          establecimiento: documents.establecimiento,
          punto: documents.punto,
          numero: documents.numero,
          estado: documents.estado,
          cdc: documents.cdc,
          montoTotal: documents.montoTotal,
          moneda: documents.moneda,
          fechaEmision: documents.fechaEmision,
          sifenCodigoRespuesta: documents.sifenCodigoRespuesta,
          sifenMensaje: documents.sifenMensaje,
          sifenProtocoloAutorizacion: documents.sifenProtocoloAutorizacion,
          sifenLoteNumero: documents.sifenLoteNumero,
          sifenResponseRaw: documents.sifenResponseRaw,
          requestJson: documents.requestJson,
          qrUrl: documents.qrUrl,
          xmlStorageKey: documents.xmlStorageKey,
          kudeStorageKey: documents.kudeStorageKey,
          idempotencyKey: documents.idempotencyKey,
          retries: documents.retries,
          errorMessage: documents.errorMessage,
          createdAt: documents.createdAt,
          updatedAt: documents.updatedAt,
        })
        .from(documents)
        .innerJoin(tenants, eq(documents.tenantId, tenants.id))
        .innerJoin(companies, eq(documents.companyId, companies.id))
        .where(eq(documents.id, request.params.id))
        .limit(1);

      if (!row) {
        throw new NotFoundError('Document');
      }

      const [xmlUrl, kudeUrl] = await Promise.all([
        presignOrNull(row.xmlStorageKey),
        presignOrNull(row.kudeStorageKey),
      ]);

      // Los eventos se atan al documento por CDC, no por id: una cancelación
      // puede haberse emitido desde otro sistema y referenciar el mismo CDC.
      const eventoRows = row.cdc
        ? await db
            .select({
              id: eventos.id,
              tipoEvento: eventos.tipoEvento,
              estado: eventos.estado,
              errorMessage: eventos.errorMessage,
              createdAt: eventos.createdAt,
            })
            .from(eventos)
            .where(eq(eventos.documentCdc, row.cdc))
            .orderBy(desc(eventos.createdAt))
        : [];

      return {
        ...row,
        cdc: row.cdc ?? null,
        sifenCodigoRespuesta: row.sifenCodigoRespuesta ?? null,
        sifenMensaje: row.sifenMensaje ?? null,
        sifenProtocoloAutorizacion: row.sifenProtocoloAutorizacion ?? null,
        sifenLoteNumero: row.sifenLoteNumero ?? null,
        sifenResponseRaw: row.sifenResponseRaw ?? null,
        requestJson: row.requestJson ?? null,
        qrUrl: row.qrUrl ?? null,
        xmlStorageKey: row.xmlStorageKey ?? null,
        kudeStorageKey: row.kudeStorageKey ?? null,
        idempotencyKey: row.idempotencyKey ?? null,
        errorMessage: row.errorMessage ?? null,
        xmlUrl,
        kudeUrl,
        fechaEmision: row.fechaEmision.toISOString(),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        eventos: eventoRows.map((e) => ({
          id: e.id,
          tipoEvento: e.tipoEvento,
          estado: e.estado,
          errorMessage: e.errorMessage ?? null,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/admin/eventos — últimos eventos de todas las companies
  // ─────────────────────────────────────────────────────
  app.get(
    '/admin/eventos',
    {
      preHandler: [requireAdmin],
      schema: {
        hide: true,
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(200).default(50),
          offset: z.coerce.number().int().nonnegative().default(0),
        }),
        response: {
          200: z.object({
            data: z.array(
              z.object({
                id: z.string(),
                companyId: z.string(),
                companyName: z.string(),
                tenantId: z.string(),
                tenantRazonSocial: z.string(),
                documentCdc: z.string().nullable(),
                tipoEvento: z.string(),
                estado: z.string(),
                sifenCodigoRespuesta: z.string().nullable(),
                errorMessage: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
            total: z.number(),
            pagination: z.object({ limit: z.number(), offset: z.number() }),
          }),
        },
      },
    },
    async (request) => {
      const { limit, offset } = request.query;

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            id: eventos.id,
            companyId: eventos.companyId,
            companyName: companies.name,
            tenantId: eventos.tenantId,
            tenantRazonSocial: tenants.razonSocial,
            documentCdc: eventos.documentCdc,
            tipoEvento: eventos.tipoEvento,
            estado: eventos.estado,
            sifenResponseRaw: eventos.sifenResponseRaw,
            errorMessage: eventos.errorMessage,
            createdAt: eventos.createdAt,
          })
          .from(eventos)
          .innerJoin(tenants, eq(eventos.tenantId, tenants.id))
          .innerJoin(companies, eq(eventos.companyId, companies.id))
          .orderBy(desc(eventos.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ n: countStar }).from(eventos),
      ]);

      return {
        data: rows.map((r) => ({
          id: r.id,
          companyId: r.companyId,
          companyName: r.companyName,
          tenantId: r.tenantId,
          tenantRazonSocial: r.tenantRazonSocial,
          documentCdc: r.documentCdc ?? null,
          tipoEvento: r.tipoEvento,
          estado: r.estado,
          // La tabla eventos no tiene columna propia para el código de SIFEN;
          // sale del JSON de respuesta, que es donde lo guarda el servicio.
          sifenCodigoRespuesta: extractEventoCodigo(r.sifenResponseRaw),
          errorMessage: r.errorMessage ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
        total: totalRows[0]?.n ?? 0,
        pagination: { limit, offset },
      };
    },
  );
};

/**
 * Código de respuesta de SIFEN de un evento. Vive dentro de sifen_response_raw
 * (la tabla eventos no lo desnormaliza como sí hace documents), y la forma del
 * JSON cambió entre versiones del cliente SOAP — por eso probamos varias
 * llaves en vez de asumir una sola.
 */
const extractEventoCodigo = (raw: unknown): string | null => {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const candidates = [obj.dCodRes, obj.codigo, obj.codigoRespuesta, obj.dEstRes];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
    if (typeof c === 'number') return String(c);
  }
  return null;
};

/**
 * HTML del panel, fuera del prefijo /v1 (igual que registerPlayground).
 *
 * El HTML no lleva ningún secreto adentro: pide el token en una pantalla de
 * login y lo guarda en localStorage del operador. Si ADMIN_TOKEN no está
 * seteado devolvemos 404 en texto plano — no 401 — para no confirmar
 * siquiera que este server tiene panel.
 */
export const registerAdmin = (app: FastifyInstance): void => {
  app.get('/admin', async (_req, reply) => {
    if (!env.ADMIN_TOKEN) {
      return reply.status(404).type('text/plain; charset=utf-8').send('Not Found');
    }
    return reply.type('text/html; charset=utf-8').send(ADMIN_HTML);
  });
};
