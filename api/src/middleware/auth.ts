/**
 * Auth middleware para Fastify.
 *
 * Flujo:
 *   1. Lee header `Authorization: Bearer <api_key>`
 *   2. Valida formato (cmp_<hex>)
 *   3. Hashea la key y busca en DB por apiKeyHash (vía apiKeyPrefix para no
 *      escanear la tabla entera)
 *   4. Verifica status = active
 *   5. Adjunta `request.company = {...}` para que las rutas lo usen
 *
 * IMPORTANTE: este middleware se registra como preHandler en las rutas
 * que lo necesitan, NO globalmente. Las rutas públicas (signup, health)
 * quedan fuera.
 */
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies } from '../db/schema.js';
import { UnauthorizedError } from '../lib/errors.js';
import { hashApiKey, looksLikeApiKey, extractPrefix } from '../lib/api-keys.js';

export interface AuthenticatedCompany {
  id: string;
  name: string;
  status: 'active' | 'suspended' | 'deleted';
}

// Augment del request para que TS vea `request.company`
declare module 'fastify' {
  interface FastifyRequest {
    company?: AuthenticatedCompany;
  }
}

const BEARER_PREFIX = 'Bearer ';

export const requireAuth: preHandlerHookHandler = async (
  request: FastifyRequest,
  _reply: FastifyReply,
) => {
  const header = request.headers.authorization;
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    throw new UnauthorizedError('Missing Authorization: Bearer header');
  }
  const plaintext = header.slice(BEARER_PREFIX.length).trim();
  if (!looksLikeApiKey(plaintext)) {
    throw new UnauthorizedError('Invalid API key format');
  }

  const prefix = extractPrefix(plaintext);
  const hash = hashApiKey(plaintext);

  // Buscar por prefix (índice) y comparar hash
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      status: companies.status,
      apiKeyHash: companies.apiKeyHash,
    })
    .from(companies)
    .where(eq(companies.apiKeyPrefix, prefix))
    .limit(5); // prefix colisiona muy rarísimo — 5 es margen

  const match = rows.find((r) => r.apiKeyHash === hash);
  if (!match) {
    throw new UnauthorizedError('Invalid API key');
  }

  if (match.status !== 'active') {
    throw new UnauthorizedError(`Company is ${match.status}`);
  }

  request.company = {
    id: match.id,
    name: match.name,
    status: match.status,
  };
};
