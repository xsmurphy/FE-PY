import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireTenantScope } from '../middleware/tenant-scope.js';
import { setCsc, getCscMetadata, deleteCsc } from '../services/csc.service.js';
import { NotFoundError } from '../lib/errors.js';

const cscMetadataResponse = z.object({
  cscId: z.string(),
  updatedAt: z.string(),
});

export const tenantCscRoutes: FastifyPluginAsyncZod = async (app) => {
  // ─────────────────────────────────────────────────────
  // PUT /v1/tenants/:tenant_id/csc — set/rotate CSC
  // ─────────────────────────────────────────────────────
  app.put(
    '/tenants/:tenant_id/csc',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['tenant-csc'],
        summary: 'Configurar CSC del tenant (upsert)',
        description:
          'El CSC (Código de Seguridad del Contribuyente) se obtiene en el portal ekuatia.set.gov.py. ' +
          'Se guarda cifrado con envelope encryption. Nunca se devuelve en claro.',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        body: z.object({
          cscId: z.string().min(1).max(10),
          // CSC real de SIFEN: exactamente 32 alfanuméricos (verificado con
          // CSC de producción) — atajamos truncados/copias con espacios acá
          csc: z.string().regex(/^[A-Za-z0-9]{32}$/, 'El CSC debe ser exactamente 32 caracteres alfanuméricos'),
        }),
        response: {
          200: cscMetadataResponse,
        },
      },
    },
    async (request) => {
      const row = await setCsc({
        tenantId: request.tenant!.id,
        companyId: request.company!.id,
        cscId: request.body.cscId,
        csc: request.body.csc,
      });
      return {
        cscId: row.cscId,
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id/csc — metadata
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id/csc',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['tenant-csc'],
        summary: 'Metadata del CSC (nunca el valor)',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        response: {
          200: cscMetadataResponse,
        },
      },
    },
    async (request) => {
      const meta = await getCscMetadata(request.tenant!.id, request.company!.id);
      if (!meta) throw new NotFoundError('CSC');
      return {
        cscId: meta.cscId,
        updatedAt: meta.updatedAt.toISOString(),
      };
    },
  );

  // ─────────────────────────────────────────────────────
  // DELETE /v1/tenants/:tenant_id/csc — remover
  // ─────────────────────────────────────────────────────
  app.delete(
    '/tenants/:tenant_id/csc',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['tenant-csc'],
        summary: 'Eliminar CSC del tenant',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      await deleteCsc(request.tenant!.id, request.company!.id);
      reply.status(204);
      return;
    },
  );
};
