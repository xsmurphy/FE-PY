import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireTenantScope } from '../middleware/tenant-scope.js';
import {
  createTenant,
  listTenantsByCompany,
  updateTenant,
  suspendTenant,
} from '../services/tenant.service.js';
import { setNumeracion, listNumeracion } from '../services/numeracion.service.js';
import { validarRuc } from '../lib/ruc.js';
import { BadRequestError } from '../lib/errors.js';
import { db } from '../db/index.js';
import { tenantCerts, tenantCsc } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';

// ─────────────────────────────────────────────────────
// Zod schemas compartidos
// ─────────────────────────────────────────────────────
const establecimientoSchema = z.object({
  codigo: z.string().min(1).max(3),
  direccion: z.string().min(1).max(255),
  numeroCasa: z.string().optional(),
  complementoDireccion1: z.string().optional(),
  complementoDireccion2: z.string().optional(),
  departamento: z.number().int().positive(),
  departamentoDescripcion: z.string(),
  distrito: z.number().int().positive(),
  distritoDescripcion: z.string(),
  ciudad: z.number().int().positive(),
  ciudadDescripcion: z.string(),
  telefono: z.string().optional(),
  email: z.string().email().optional(),
  denominacion: z.string().optional(),
});

const actividadEconomicaSchema = z.object({
  codigo: z.string().min(1),
  descripcion: z.string().min(1),
});

const tenantResponseSchema = z.object({
  id: z.string().uuid(),
  externalId: z.string().nullable(),
  ruc: z.string(),
  razonSocial: z.string(),
  nombreFantasia: z.string().nullable(),
  timbradoNumero: z.string(),
  timbradoFecha: z.string(),
  timbradoVencimiento: z.string().nullable(),
  tipoContribuyente: z.number(),
  tipoRegimen: z.number(),
  env: z.enum(['test', 'prod']),
  status: z.enum(['active', 'suspended']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// Helper: serializa un Tenant row a la shape pública (evita exponer campos internos)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const serializeTenant = (t: any) => ({
  id: t.id,
  externalId: t.externalId,
  ruc: t.ruc,
  razonSocial: t.razonSocial,
  nombreFantasia: t.nombreFantasia,
  timbradoNumero: t.timbradoNumero,
  timbradoFecha: typeof t.timbradoFecha === 'string' ? t.timbradoFecha : t.timbradoFecha.toISOString().slice(0, 10),
  timbradoVencimiento: t.timbradoVencimiento
    ? typeof t.timbradoVencimiento === 'string'
      ? t.timbradoVencimiento
      : t.timbradoVencimiento.toISOString().slice(0, 10)
    : null,
  tipoContribuyente: t.tipoContribuyente,
  tipoRegimen: t.tipoRegimen,
  env: t.env,
  status: t.status,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

export const tenantRoutes: FastifyPluginAsyncZod = async (app) => {
  // ─────────────────────────────────────────────────────
  // POST /v1/tenants — crear tenant
  // ─────────────────────────────────────────────────────
  app.post(
    '/tenants',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['tenants'],
        summary: 'Crear un tenant (contribuyente emisor)',
        security: [{ bearerAuth: [] }],
        body: z.object({
          externalId: z.string().optional(),
          ruc: z.string().min(6),
          razonSocial: z.string().min(1),
          nombreFantasia: z.string().optional(),
          timbradoNumero: z.string().min(1),
          timbradoFecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          timbradoVencimiento: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          tipoContribuyente: z.number().int().min(1).max(2),
          tipoRegimen: z.number().int().min(1).max(15),
          establecimientos: z.array(establecimientoSchema).min(1),
          actividadesEconomicas: z.array(actividadEconomicaSchema).min(1),
          env: z.enum(['test', 'prod']).default('test'),
        }),
        response: {
          201: tenantResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Validación del RUC (formato + dígito verificador módulo 11) — un
      // tenant con RUC inválido es rechazado por SIFEN recién al emitir;
      // acá lo atajamos en el alta con error accionable.
      const rucCheck = validarRuc(request.body.ruc);
      if (!rucCheck.valid) {
        throw new BadRequestError(rucCheck.error!);
      }
      const tenant = await createTenant({
        companyId: request.company!.id,
        ...request.body,
      });
      return reply.status(201).send(serializeTenant(tenant));
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/tenants — listar
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['tenants'],
        summary: 'Listar tenants de la company',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(200).default(50),
          offset: z.coerce.number().int().nonnegative().default(0),
        }),
        response: {
          200: z.object({
            data: z.array(tenantResponseSchema),
            pagination: z.object({
              limit: z.number(),
              offset: z.number(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const { limit, offset } = request.query;
      const rows = await listTenantsByCompany(request.company!.id, { limit, offset });
      return {
        data: rows.map(serializeTenant),
        pagination: { limit, offset },
      };
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id — detalle
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['tenants'],
        summary: 'Obtener detalle de un tenant',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        response: {
          200: tenantResponseSchema,
        },
      },
    },
    async (request) => {
      return serializeTenant(request.tenant!);
    },
  );

  // ─────────────────────────────────────────────────────
  // PATCH /v1/tenants/:tenant_id — actualizar
  // ─────────────────────────────────────────────────────
  app.patch(
    '/tenants/:tenant_id',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['tenants'],
        summary: 'Actualizar campos de un tenant',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        body: z.object({
          externalId: z.string().optional(),
          razonSocial: z.string().min(1).optional(),
          nombreFantasia: z.string().optional(),
          timbradoNumero: z.string().min(1).optional(),
          timbradoFecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          timbradoVencimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          tipoContribuyente: z.number().int().min(1).max(2).optional(),
          tipoRegimen: z.number().int().min(1).max(15).optional(),
          establecimientos: z.array(establecimientoSchema).optional(),
          actividadesEconomicas: z.array(actividadEconomicaSchema).optional(),
          env: z.enum(['test', 'prod']).optional(),
          status: z.enum(['active', 'suspended']).optional(),
        }),
        response: {
          200: tenantResponseSchema,
        },
      },
    },
    async (request) => {
      const updated = await updateTenant(
        request.company!.id,
        request.tenant!.id,
        request.body,
      );
      return serializeTenant(updated);
    },
  );

  // ─────────────────────────────────────────────────────
  // DELETE /v1/tenants/:tenant_id — suspender (soft delete)
  // ─────────────────────────────────────────────────────
  app.delete(
    '/tenants/:tenant_id',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['tenants'],
        summary: 'Suspender un tenant (soft delete)',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      await suspendTenant(request.company!.id, request.tenant!.id);
      reply.status(204);
      return;
    },
  );

  // ─────────────────────────────────────────────────────
  // PUT /v1/tenants/:tenant_id/numeracion — setear correlativo
  //
  // Onboarding de clientes que migran con numeración avanzada: setea el
  // último número usado; la próxima emisión sale con +1. Rechaza (409)
  // retroceder por debajo del mayor número activo ya emitido.
  // ─────────────────────────────────────────────────────
  app.put(
    '/tenants/:tenant_id/numeracion',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['tenants'],
        summary: 'Setear el correlativo de numeración (onboarding/migración)',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        body: z.object({
          tipoDocumento: z.number().int().min(1).max(8),
          establecimiento: z.string().regex(/^\d{3}$/),
          punto: z.string().regex(/^\d{3}$/),
          ultimoNumero: z.number().int().min(0).max(9_999_999),
        }),
        response: {
          200: z.object({
            tipoDocumento: z.number(),
            establecimiento: z.string(),
            punto: z.string(),
            ultimoNumero: z.number(),
            proximoNumero: z.number(),
          }),
        },
      },
    },
    async (request) => {
      const { tipoDocumento, establecimiento, punto, ultimoNumero } = request.body;
      const result = await setNumeracion({
        tenantId: request.tenant!.id,
        tipo: tipoDocumento,
        establecimiento,
        punto,
        ultimoNumero,
      });
      return { tipoDocumento, establecimiento, punto, ...result };
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id/numeracion — secuencias vigentes
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id/numeracion',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['tenants'],
        summary: 'Listar las secuencias de numeración del tenant',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        response: {
          200: z.object({
            data: z.array(
              z.object({
                tipoDocumento: z.number(),
                establecimiento: z.string(),
                punto: z.string(),
                ultimoNumero: z.number(),
                proximoNumero: z.number(),
                updatedAt: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => ({ data: await listNumeracion(request.tenant!.id) }),
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id/readiness — ¿listo para emitir?
  //
  // Checklist de provisioning para integradores (Punto): valida que todo
  // lo cargado esté completo y utilizable ANTES de la primera emisión.
  // El integrador lo llama al final de su wizard de alta y muestra el
  // resultado al usuario. Lo que NO se puede verificar sin emitir
  // (timbradoFecha exacta vs Marangatú, habilitación del RUC en SIFEN)
  // queda declarado en `unverifiable`.
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id/readiness',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['tenants'],
        summary: 'Checklist de provisioning — ¿el tenant está listo para emitir?',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        response: {
          200: z.object({
            ready: z.boolean(),
            checks: z.array(
              z.object({
                check: z.string(),
                ok: z.boolean(),
                detail: z.string(),
              }),
            ),
            unverifiable: z.array(z.string()),
          }),
        },
      },
    },
    async (request) => {
      const tenant = request.tenant!;
      const checks: { check: string; ok: boolean; detail: string }[] = [];

      // 1. Tenant activo
      checks.push({
        check: 'tenant_activo',
        ok: tenant.status === 'active',
        detail: `status=${tenant.status}`,
      });

      // 2. RUC con dígito verificador válido
      const rucCheck = validarRuc(tenant.ruc);
      checks.push({
        check: 'ruc_valido',
        ok: rucCheck.valid,
        detail: rucCheck.valid ? tenant.ruc : rucCheck.error!,
      });

      // 3. Certificado cargado, no revocado, vigente
      const [cert] = await db
        .select({ revokedAt: tenantCerts.revokedAt, notAfter: tenantCerts.notAfter })
        .from(tenantCerts)
        .where(and(eq(tenantCerts.tenantId, tenant.id), eq(tenantCerts.companyId, request.company!.id)))
        .limit(1);
      if (!cert) {
        checks.push({ check: 'certificado', ok: false, detail: 'No hay certificado cargado' });
      } else if (cert.revokedAt) {
        checks.push({ check: 'certificado', ok: false, detail: 'El certificado está revocado' });
      } else if (cert.notAfter < new Date()) {
        checks.push({ check: 'certificado', ok: false, detail: `Vencido el ${cert.notAfter.toISOString().slice(0, 10)}` });
      } else {
        const dias = Math.floor((cert.notAfter.getTime() - Date.now()) / 86_400_000);
        checks.push({
          check: 'certificado',
          ok: true,
          detail: `Vigente, vence en ${dias} días (${cert.notAfter.toISOString().slice(0, 10)})`,
        });
      }

      // 4. CSC configurado (obligatorio para el QR — sin él SIFEN rechaza)
      const [csc] = await db
        .select({ cscId: tenantCsc.cscId })
        .from(tenantCsc)
        .where(and(eq(tenantCsc.tenantId, tenant.id), eq(tenantCsc.companyId, request.company!.id)))
        .limit(1);
      checks.push({
        check: 'csc',
        ok: !!csc,
        detail: csc ? `Configurado (id ${csc.cscId})` : 'Sin CSC — el QR no se puede generar y SIFEN rechaza',
      });

      // 5. Numeración (informativo: si el integrador manda `numero` explícito
      //    en cada emisión, no necesita secuencia pre-configurada)
      const numeraciones = await listNumeracion(tenant.id);
      checks.push({
        check: 'numeracion',
        ok: true,
        detail:
          numeraciones.length > 0
            ? numeraciones.map((n) => `tipo ${n.tipoDocumento} ${n.establecimiento}-${n.punto} → próximo ${n.proximoNumero}`).join('; ')
            : 'Sin secuencias — ok solo si el integrador manda `numero` explícito en cada emisión',
      });

      // ready = todos los checks críticos ok (numeración es informativa)
      const ready = checks.filter((c) => c.check !== 'numeracion').every((c) => c.ok);

      return {
        ready,
        checks,
        unverifiable: [
          'timbradoFecha exacta vs Marangatú — SIFEN la valida recién al emitir (rechazo 1107 si difiere); sacarla de un KUDE ya emitido o de Marangatú, nunca estimarla',
          'habilitación del RUC como facturador electrónico — se confirma con la primera emisión real',
          'razonSocial vs padrón — verificable con GET /consulta/ruc/:ruc (requiere cert ya cargado)',
        ],
      };
    },
  );
};
