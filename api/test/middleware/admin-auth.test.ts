/**
 * Tests del gate del panel de operador.
 *
 * Es el test más importante del panel: /v1/admin/* cruza datos de TODAS las
 * companies, así que el único límite entre "herramienta interna" y "fuga de
 * datos entre integradores" es este middleware. Se testea directo como
 * función sobre un request falso — no hace queries ni toca Fastify, así que
 * levantar el server solo agregaría formas de que el test falle por otra cosa.
 *
 * ADMIN_TOKEN se cambia entre casos con vi.resetModules() porque config/env.ts
 * cachea el parseo del entorno al importarse.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

process.env.MASTER_KEY_BASE64 = randomBytes(32).toString('base64');
process.env.DATABASE_URL = 'postgres://x:x@localhost:5432/x';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_BUCKET = 'test';
process.env.S3_ACCESS_KEY = 'x';
process.env.S3_SECRET_KEY = 'x';

const VALID_TOKEN = 'a'.repeat(40);

/** Carga requireAdmin con el ADMIN_TOKEN indicado (undefined = sin setear). */
const loadRequireAdmin = async (adminToken?: string): Promise<preHandlerHookHandler> => {
  vi.resetModules();
  if (adminToken === undefined) {
    delete process.env.ADMIN_TOKEN;
  } else {
    process.env.ADMIN_TOKEN = adminToken;
  }
  const mod = await import('../../src/middleware/admin-auth.js');
  return mod.requireAdmin;
};

/** Request mínimo: el middleware solo mira headers. */
const fakeRequest = (headerValue?: string | string[]): FastifyRequest =>
  ({ headers: headerValue === undefined ? {} : { 'x-admin-token': headerValue } }) as FastifyRequest;

const reply = {} as FastifyReply;

// El middleware devuelve una promesa; el error viaja como rechazo.
const run = (
  requireAdmin: preHandlerHookHandler,
  headerValue?: string | string[],
): Promise<unknown> =>
  Promise.resolve(
    (requireAdmin as (req: FastifyRequest, rep: FastifyReply) => unknown)(
      fakeRequest(headerValue),
      reply,
    ),
  );

const expectUnauthorized = async (promise: Promise<unknown>, fragment?: string) => {
  // No usamos instanceof: vi.resetModules() vuelve a evaluar lib/errors.js y
  // la clase deja de ser la misma referencia entre imports.
  const err = await promise.then(
    () => null,
    (e: unknown) => e as { statusCode?: number; code?: string; message?: string },
  );
  expect(err, 'se esperaba que el middleware rechazara').not.toBeNull();
  expect(err!.statusCode).toBe(401);
  expect(err!.code).toBe('unauthorized');
  if (fragment) expect(err!.message).toContain(fragment);
};

describe('requireAdmin — ADMIN_TOKEN sin setear: el panel está cerrado', () => {
  it('rechaza cuando no mandan header', async () => {
    const requireAdmin = await loadRequireAdmin(undefined);
    await expectUnauthorized(run(requireAdmin), 'deshabilitado');
  });

  it('rechaza cualquier token inventado', async () => {
    const requireAdmin = await loadRequireAdmin(undefined);
    await expectUnauthorized(run(requireAdmin, VALID_TOKEN), 'deshabilitado');
    await expectUnauthorized(run(requireAdmin, ''), 'deshabilitado');
    await expectUnauthorized(run(requireAdmin, 'x'.repeat(200)), 'deshabilitado');
  });
});

describe('requireAdmin — con ADMIN_TOKEN seteado', () => {
  it('acepta el token correcto', async () => {
    const requireAdmin = await loadRequireAdmin(VALID_TOKEN);
    await expect(run(requireAdmin, VALID_TOKEN)).resolves.toBeUndefined();
  });

  it('rechaza un token incorrecto de la misma longitud', async () => {
    const requireAdmin = await loadRequireAdmin(VALID_TOKEN);
    const wrong = 'b'.repeat(VALID_TOKEN.length);
    expect(wrong.length).toBe(VALID_TOKEN.length);
    await expectUnauthorized(run(requireAdmin, wrong), 'inválido');
  });

  it('rechaza un token de longitud distinta (prefijo válido incluido)', async () => {
    const requireAdmin = await loadRequireAdmin(VALID_TOKEN);
    await expectUnauthorized(run(requireAdmin, VALID_TOKEN.slice(0, -1)));
    await expectUnauthorized(run(requireAdmin, VALID_TOKEN + 'a'));
  });

  it('rechaza header ausente o vacío', async () => {
    const requireAdmin = await loadRequireAdmin(VALID_TOKEN);
    await expectUnauthorized(run(requireAdmin));
    await expectUnauthorized(run(requireAdmin, ''));
  });

  it('rechaza el header repetido (llega como array, no se concatena)', async () => {
    const requireAdmin = await loadRequireAdmin(VALID_TOKEN);
    await expectUnauthorized(run(requireAdmin, [VALID_TOKEN, VALID_TOKEN]));
    await expectUnauthorized(run(requireAdmin, [VALID_TOKEN]));
  });
});
