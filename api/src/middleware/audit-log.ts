/**
 * Audit logging middleware.
 *
 * Registra cada request que pasó por auth (tiene company_id) en la tabla
 * api_logs para trazabilidad y auditoría posterior.
 *
 * Reglas:
 *   - Fire-and-forget: el insert no bloquea la respuesta
 *   - No loguea bodies (ya están en pino redacted + S3)
 *   - Skip rutas de /health (demasiado ruidosas)
 *   - Skip requests sin company (preflight, 401, rutas públicas)
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { apiLogs } from '../db/schema.js';

const SKIP_PATHS = /^\/(v1\/)?health/;

export const registerAuditLog = (app: FastifyInstance): void => {
  app.addHook('onResponse', async (request, reply) => {
    if (SKIP_PATHS.test(request.url)) return;

    // Solo loguear requests con company identificada (post-auth)
    const companyId = request.company?.id;
    if (!companyId) return;

    // Fire-and-forget — no awaitar
    void db
      .insert(apiLogs)
      .values({
        companyId,
        tenantId: request.tenant?.id ?? null,
        method: request.method,
        path: request.url.split('?')[0].slice(0, 500),
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        userAgent: (request.headers['user-agent'] ?? '').slice(0, 500),
        ip: request.ip,
        requestId: request.id,
      })
      .catch((err) => {
        // No romper la respuesta por un error de audit log
        request.log.warn({ err }, 'audit log insert failed');
      });
  });
};
