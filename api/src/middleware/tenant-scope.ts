/**
 * Tenant scope middleware.
 *
 * Se usa en rutas que tienen :tenant_id en el path. Carga el tenant y verifica
 * que pertenezca a la company autenticada. Si no, 404 (nunca 403 — no revelar
 * la existencia del recurso).
 *
 * Adjunta `request.tenant` para que el handler lo use directamente sin
 * hacer otra query.
 */
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { findTenantByIdForCompany } from '../services/tenant.service.js';
import { NotFoundError, UnauthorizedError } from '../lib/errors.js';
import type { Tenant } from '../db/schema.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: Tenant;
  }
}

export const requireTenantScope: preHandlerHookHandler = async (request: FastifyRequest) => {
  if (!request.company) {
    throw new UnauthorizedError('Missing company context — did you register requireAuth first?');
  }

  const params = request.params as { tenant_id?: string } | undefined;
  const tenantId = params?.tenant_id;
  if (!tenantId) {
    throw new NotFoundError('Tenant');
  }

  // Validación mínima de formato UUID para fallar rápido y evitar query innecesaria
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new NotFoundError('Tenant');
  }

  const tenant = await findTenantByIdForCompany(request.company.id, tenantId);
  if (!tenant) {
    // Puede no existir O pertenecer a otra company — ambos casos devuelven 404
    throw new NotFoundError('Tenant');
  }

  request.tenant = tenant;
};
