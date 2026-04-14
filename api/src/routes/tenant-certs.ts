import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenantCerts } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenantScope } from '../middleware/tenant-scope.js';
import {
  parseP12,
  assertCertNotExpired,
  assertRucMatches,
  encryptCertBundle,
} from '../services/cert.service.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';

const certMetadataResponse = z.object({
  fingerprint: z.string(),
  subjectCn: z.string(),
  subjectRuc: z.string(),
  notBefore: z.string(),
  notAfter: z.string(),
  uploadedAt: z.string(),
  revokedAt: z.string().nullable(),
  daysUntilExpiration: z.number().int(),
});

export const tenantCertRoutes: FastifyPluginAsyncZod = async (app) => {
  // ─────────────────────────────────────────────────────
  // POST /v1/tenants/:tenant_id/cert — upload .p12
  //
  // Body: multipart/form-data con dos partes:
  //   - file: el .p12 binario
  //   - password: la contraseña del cert (text field)
  // ─────────────────────────────────────────────────────
  app.post(
    '/tenants/:tenant_id/cert',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['tenant-certs'],
        summary: 'Subir certificado .p12 para un tenant',
        description:
          'Multipart con campos `file` (archivo .p12) y `password` (texto). ' +
          'El RUC extraído del certificado debe coincidir con el del tenant.',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        response: {
          201: certMetadataResponse,
        },
      },
    },
    async (request, reply) => {
      const parts = request.parts();

      let p12Buffer: Buffer | null = null;
      let password: string | null = null;

      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'file') {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk as Buffer);
          }
          p12Buffer = Buffer.concat(chunks);
        } else if (part.type === 'field' && part.fieldname === 'password') {
          password = String(part.value);
        }
      }

      if (!p12Buffer || p12Buffer.length === 0) {
        throw new BadRequestError('Falta el archivo `file` en el multipart');
      }
      if (!password) {
        throw new BadRequestError('Falta el campo `password` en el multipart');
      }

      // Parsear y validar
      const parsed = parseP12(p12Buffer, password);
      assertCertNotExpired(parsed.metadata);
      assertRucMatches(parsed.metadata.subjectRuc, request.tenant!.ruc);

      // Envelope encrypt
      const bundle = encryptCertBundle(p12Buffer, password);

      // Wipe buffers sensibles tan pronto como se puedan
      p12Buffer.fill(0);
      p12Buffer = null;
      password = null;

      // Upsert: un cert activo por tenant (reemplaza el anterior)
      await db
        .delete(tenantCerts)
        .where(eq(tenantCerts.tenantId, request.tenant!.id));

      const [inserted] = await db
        .insert(tenantCerts)
        .values({
          tenantId: request.tenant!.id,
          companyId: request.company!.id,

          encryptedP12: bundle.p12.ciphertext,
          ivP12: bundle.p12.iv,
          tagP12: bundle.p12.tag,

          encryptedPassword: bundle.password.ciphertext,
          ivPassword: bundle.password.iv,
          tagPassword: bundle.password.tag,

          // DEK única compartida para p12 + password
          encryptedDek: bundle.dek.ciphertext,
          ivDek: bundle.dek.iv,
          tagDek: bundle.dek.tag,

          fingerprint: parsed.metadata.fingerprint,
          subjectCn: parsed.metadata.subjectCn,
          subjectRuc: parsed.metadata.subjectRuc,
          notBefore: parsed.metadata.notBefore,
          notAfter: parsed.metadata.notAfter,
        })
        .returning();

      request.log.info(
        {
          tenantId: request.tenant!.id,
          fingerprint: inserted.fingerprint,
          notAfter: inserted.notAfter,
        },
        'Certificate uploaded',
      );

      const daysUntilExpiration = Math.floor(
        (inserted.notAfter.getTime() - Date.now()) / 86400000,
      );

      return reply.status(201).send({
        fingerprint: inserted.fingerprint,
        subjectCn: inserted.subjectCn,
        subjectRuc: inserted.subjectRuc,
        notBefore: inserted.notBefore.toISOString(),
        notAfter: inserted.notAfter.toISOString(),
        uploadedAt: inserted.uploadedAt.toISOString(),
        revokedAt: inserted.revokedAt ? inserted.revokedAt.toISOString() : null,
        daysUntilExpiration,
      });
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id/cert — metadata (nunca el .p12 en sí)
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id/cert',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['tenant-certs'],
        summary: 'Obtener metadata del certificado del tenant',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        response: {
          200: certMetadataResponse,
        },
      },
    },
    async (request) => {
      const [row] = await db
        .select({
          fingerprint: tenantCerts.fingerprint,
          subjectCn: tenantCerts.subjectCn,
          subjectRuc: tenantCerts.subjectRuc,
          notBefore: tenantCerts.notBefore,
          notAfter: tenantCerts.notAfter,
          uploadedAt: tenantCerts.uploadedAt,
          revokedAt: tenantCerts.revokedAt,
        })
        .from(tenantCerts)
        .where(
          and(
            eq(tenantCerts.tenantId, request.tenant!.id),
            eq(tenantCerts.companyId, request.company!.id),
          ),
        )
        .limit(1);

      if (!row) throw new NotFoundError('Certificate');

      return {
        fingerprint: row.fingerprint,
        subjectCn: row.subjectCn,
        subjectRuc: row.subjectRuc,
        notBefore: row.notBefore.toISOString(),
        notAfter: row.notAfter.toISOString(),
        uploadedAt: row.uploadedAt.toISOString(),
        revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
        daysUntilExpiration: Math.floor((row.notAfter.getTime() - Date.now()) / 86400000),
      };
    },
  );

  // ─────────────────────────────────────────────────────
  // DELETE /v1/tenants/:tenant_id/cert — revocar
  // ─────────────────────────────────────────────────────
  app.delete(
    '/tenants/:tenant_id/cert',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['tenant-certs'],
        summary: 'Revocar el certificado del tenant',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        response: {
          204: z.null(),
        },
      },
    },
    async (request, reply) => {
      await db
        .delete(tenantCerts)
        .where(
          and(
            eq(tenantCerts.tenantId, request.tenant!.id),
            eq(tenantCerts.companyId, request.company!.id),
          ),
        );
      return reply.status(204).send(null);
    },
  );
};
