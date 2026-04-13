/**
 * Idempotency middleware.
 *
 * Protege endpoints no-idempotentes (POST /de, eventos, etc) contra duplicados
 * cuando el cliente reintenta por timeout de red. Es la garantía de que una
 * factura nunca se emite dos veces aunque el POS reintente 3 veces.
 *
 * Flujo:
 *   1. Cliente envía header `Idempotency-Key: <uuid o string único>`
 *   2. Middleware computa SHA256 del body
 *   3. Busca (company_id, key) en idempotency_keys
 *      - Si existe Y el hash coincide → devuelve la respuesta cacheada
 *      - Si existe Y el hash NO coincide → 422 "key reusada con body distinto"
 *      - Si no existe → continúa al handler, y el handler persiste la respuesta
 *
 * Los registros expiran a las 24h (garbage collection con cron job en Fase 3).
 *
 * La persistencia de la respuesta se hace DESPUÉS de que el handler termina,
 * en el onResponse hook. Si el handler lanza, no se guarda nada y el cliente
 * puede reintentar limpio.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler, onSendHookHandler } from 'fastify';
import { createHash } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { idempotencyKeys } from '../db/schema.js';
import { ConflictError, UnauthorizedError } from '../lib/errors.js';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Augment del request para compartir estado entre preHandler y onSend
declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: {
      key: string;
      hash: string;
      shouldPersist: boolean;
    };
  }
}

const hashBody = (body: unknown): string => {
  const canonical = JSON.stringify(body);
  return createHash('sha256').update(canonical).digest('hex');
};

/**
 * preHandler: si hay header, chequea cache y devuelve respuesta previa si existe.
 */
export const idempotencyCheck: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const key = request.headers['idempotency-key'];
  if (!key || typeof key !== 'string') return;
  if (key.length < 8 || key.length > 256) {
    throw new ConflictError('Idempotency-Key must be 8-256 characters');
  }
  if (!request.company) {
    throw new UnauthorizedError('Idempotency requires auth');
  }

  const bodyHash = hashBody(request.body);

  // Buscar entry válida (no expirada)
  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.companyId, request.company.id),
        eq(idempotencyKeys.key, key),
        gt(idempotencyKeys.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (existing) {
    // Key ya usada: verificar que el body sea idéntico
    if (existing.requestHash !== bodyHash) {
      throw new ConflictError(
        'Idempotency-Key was reused with a different request body',
        { key },
      );
    }
    // Body idéntico → devolver respuesta cacheada
    if (existing.responseJson && existing.statusCode) {
      return reply.status(existing.statusCode).send(existing.responseJson);
    }
    // Si no hay responseJson (raro: handler falló antes de guardar), dejar pasar
  }

  request.idempotency = {
    key,
    hash: bodyHash,
    shouldPersist: true,
  };
};

/**
 * onSend hook: después de que el handler produjo la respuesta, la persistimos
 * para que el próximo reintento con la misma key la devuelva.
 *
 * Solo guardamos respuestas 2xx (no cachear errores — el cliente debería
 * poder reintentar un 500 sin quedarse atascado).
 */
export const idempotencyPersist: onSendHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
  payload,
) => {
  if (!request.idempotency?.shouldPersist) return payload;
  if (!request.company || !request.tenant) return payload;
  if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;

  try {
    const parsedPayload =
      typeof payload === 'string' ? JSON.parse(payload) : (payload as unknown);

    await db
      .insert(idempotencyKeys)
      .values({
        companyId: request.company.id,
        key: request.idempotency.key,
        tenantId: request.tenant.id,
        requestHash: request.idempotency.hash,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        responseJson: parsedPayload as Record<string, any>,
        statusCode: reply.statusCode,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      })
      .onConflictDoNothing();
  } catch (err) {
    // No reventamos la respuesta por un error de persistencia del idempotency
    request.log.warn({ err }, 'Failed to persist idempotency record');
  }

  return payload;
};
