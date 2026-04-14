import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies } from '../db/schema.js';
import { generateApiKey } from '../lib/api-keys.js';
import { ConflictError } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';

export const companyRoutes: FastifyPluginAsyncZod = async (app) => {
  // ─────────────────────────────────────────────────────
  // POST /v1/companies — signup (PÚBLICO, no auth)
  // ─────────────────────────────────────────────────────
  app.post(
    '/companies',
    {
      schema: {
        tags: ['companies'],
        summary: 'Registrar nueva company (plataforma cliente)',
        body: z.object({
          name: z.string().min(2).max(200),
          email: z.string().email(),
          billingEmail: z.string().email().optional(),
        }),
        response: {
          201: z.object({
            id: z.string().uuid(),
            name: z.string(),
            email: z.string(),
            apiKey: z.string().describe('SOLO se muestra una vez. Guardarla inmediatamente.'),
            apiKeyPrefix: z.string(),
            createdAt: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { name, email, billingEmail } = request.body;

      // chequear email único
      const existing = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.email, email))
        .limit(1);
      if (existing.length > 0) {
        throw new ConflictError('A company with this email already exists');
      }

      const key = generateApiKey();
      const [inserted] = await db
        .insert(companies)
        .values({
          name,
          email,
          billingEmail,
          apiKeyHash: key.hash,
          apiKeyPrefix: key.prefix,
          status: 'active',
        })
        .returning({
          id: companies.id,
          name: companies.name,
          email: companies.email,
          apiKeyPrefix: companies.apiKeyPrefix,
          createdAt: companies.createdAt,
        });

      request.log.info(
        { companyId: inserted.id, apiKeyPrefix: inserted.apiKeyPrefix },
        'Company registered',
      );

      return reply.status(201).send({
        id: inserted.id,
        name: inserted.name,
        email: inserted.email,
        apiKey: key.plaintext, // ⚠ única vez que se devuelve en claro
        apiKeyPrefix: inserted.apiKeyPrefix,
        createdAt: inserted.createdAt.toISOString(),
      });
    },
  );

  // ─────────────────────────────────────────────────────
  // POST /v1/companies/me/keys/rotate — rotar API key
  //
  // Genera una nueva API key y la devuelve en plaintext UNA sola vez.
  // La key vieja deja de funcionar inmediatamente — si el cliente tiene
  // requests en vuelo con la vieja, van a fallar con 401. Coordinar
  // con el cliente antes de rotar.
  // ─────────────────────────────────────────────────────
  app.post(
    '/companies/me/keys/rotate',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['companies'],
        summary: 'Rotar el API key master de la company',
        description:
          'Genera una nueva API key. La respuesta incluye la key en plaintext — ' +
          'guardarla inmediatamente. La key anterior queda invalidada al instante.',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            id: z.string().uuid(),
            apiKey: z.string().describe('Nueva key en plaintext — SOLO visible una vez'),
            apiKeyPrefix: z.string(),
            rotatedAt: z.string(),
          }),
        },
      },
    },
    async (request) => {
      const companyId = request.company!.id;
      const newKey = generateApiKey();

      const [updated] = await db
        .update(companies)
        .set({
          apiKeyHash: newKey.hash,
          apiKeyPrefix: newKey.prefix,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId))
        .returning({
          id: companies.id,
          apiKeyPrefix: companies.apiKeyPrefix,
          updatedAt: companies.updatedAt,
        });

      request.log.warn(
        { companyId, newKeyPrefix: newKey.prefix },
        'API key rotated — old key invalidated',
      );

      return {
        id: updated.id,
        apiKey: newKey.plaintext,
        apiKeyPrefix: updated.apiKeyPrefix,
        rotatedAt: updated.updatedAt.toISOString(),
      };
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/companies/me — perfil (REQUIERE AUTH)
  // ─────────────────────────────────────────────────────
  app.get(
    '/companies/me',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['companies'],
        summary: 'Perfil de la company autenticada',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            id: z.string().uuid(),
            name: z.string(),
            email: z.string(),
            status: z.enum(['active', 'suspended', 'deleted']),
            apiKeyPrefix: z.string(),
            createdAt: z.string(),
          }),
        },
      },
    },
    async (request) => {
      // requireAuth ya garantizó que existe
      const companyId = request.company!.id;

      const [row] = await db
        .select({
          id: companies.id,
          name: companies.name,
          email: companies.email,
          status: companies.status,
          apiKeyPrefix: companies.apiKeyPrefix,
          createdAt: companies.createdAt,
        })
        .from(companies)
        .where(eq(companies.id, companyId));

      return {
        id: row.id,
        name: row.name,
        email: row.email,
        status: row.status,
        apiKeyPrefix: row.apiKeyPrefix,
        createdAt: row.createdAt.toISOString(),
      };
    },
  );
};
