/**
 * Rutas de consulta a SIFEN.
 *
 * Consultas read-only que no modifican estado — usan setapi para pegarle
 * directamente a SIFEN con el cert de un tenant.
 *
 * Diseño: la ruta es tenant-scoped para que el cert a usar sea explícito.
 * Una company con múltiples tenants puede elegir con cuál autenticar la
 * consulta. Esto evita ambigüedad de "qué cert usar para una consulta
 * que no está asociada a ningún tenant en particular".
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { createRequire } from 'node:module';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenantCerts } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenantScope } from '../middleware/tenant-scope.js';
import { decryptCertBundle } from '../services/cert.service.js';
import { env } from '../config/env.js';
import { BadRequestError, NotFoundError, SifenError } from '../lib/errors.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const setapi = require('facturacionelectronicapy-setapi').default;

export const consultaRoutes: FastifyPluginAsyncZod = async (app) => {
  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id/consulta/ruc/:ruc
  //
  // Consulta información de un RUC en SIFEN. Requiere cert del tenant
  // scoper (cualquiera sirve — SIFEN solo necesita autenticar al emisor
  // que consulta, no al consultado).
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id/consulta/ruc/:ruc',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['consultas'],
        summary: 'Consultar información de un RUC en SIFEN',
        description:
          'Usa setapi.consultaRUC con el certificado del tenant. Requiere ' +
          'ENABLE_SIFEN=true porque es una llamada real a SIFEN.',
        security: [{ bearerAuth: [] }],
        params: z.object({
          tenant_id: z.string().uuid(),
          ruc: z.string().min(5).max(20),
        }),
        response: {
          200: z.object({
            ruc: z.string(),
            response: z.unknown(),
          }),
        },
      },
    },
    async (request) => {
      if (!env.ENABLE_SIFEN) {
        throw new BadRequestError(
          'SIFEN integration is disabled (ENABLE_SIFEN=false). Set ENABLE_SIFEN=true to use this endpoint.',
        );
      }

      // Cargar cert del tenant
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
      if (certRow.revokedAt) throw new BadRequestError('Certificate is revoked');
      if (certRow.notAfter < new Date()) throw new BadRequestError('Certificate is expired');

      const decrypted = decryptCertBundle({
        p12: {
          ciphertext: certRow.encryptedP12,
          iv: certRow.ivP12,
          tag: certRow.tagP12,
          encryptedDek: certRow.encryptedDek,
          ivDek: certRow.ivDek,
          tagDek: certRow.tagDek,
        },
        password: {
          ciphertext: certRow.encryptedPassword,
          iv: certRow.ivPassword,
          tag: certRow.tagPassword,
          encryptedDek: certRow.encryptedDek,
          ivDek: certRow.ivDek,
          tagDek: certRow.tagDek,
        },
      });

      const tmpCertPath = join(tmpdir(), `consulta-ruc-${randomUUID()}.p12`);

      try {
        await writeFile(tmpCertPath, decrypted.p12, { mode: 0o600 });
        const requestId = Number(Date.now() % 1_000_000);

        try {
          const response = await setapi.consultaRUC(
            requestId,
            request.params.ruc,
            request.tenant!.env,
            tmpCertPath,
            decrypted.password,
          );
          return {
            ruc: request.params.ruc,
            response: typeof response === 'string' ? { raw: response } : response,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new SifenError(`Error al consultar RUC: ${msg}`);
        }
      } finally {
        decrypted.p12.fill(0);
        await unlink(tmpCertPath).catch(() => {});
      }
    },
  );
};
