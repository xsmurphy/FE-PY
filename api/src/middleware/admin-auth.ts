/**
 * Auth del panel de operador (/admin y /v1/admin/*).
 *
 * Es una auth SEPARADA de las API keys de company a propósito: el panel ve
 * datos de TODAS las companies, así que ninguna key de integrador puede
 * habilitarlo. Un único token compartido (ADMIN_TOKEN) alcanza para la v1
 * porque el operador somos nosotros; cuando haya más de un operador esto
 * tiene que pasar a usuarios con rol y auditoría de quién miró qué.
 *
 * Cerrado por defecto: si ADMIN_TOKEN no está en el entorno, el middleware
 * rechaza SIEMPRE, sin importar qué header manden. Un server que no fue
 * configurado explícitamente para tener panel no tiene panel.
 *
 * El token NUNCA se loguea, ni siquiera truncado.
 */
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { UnauthorizedError } from '../lib/errors.js';

export const requireAdmin: preHandlerHookHandler = async (
  request: FastifyRequest,
  _reply: FastifyReply,
) => {
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    throw new UnauthorizedError('El panel de administración está deshabilitado en este servidor');
  }

  // Un header repetido llega como array — lo tratamos como ausente en vez de
  // concatenarlo, para que no haya forma creativa de armar el token.
  const raw = request.headers['x-admin-token'];
  const provided = typeof raw === 'string' ? raw : '';

  // Comparación constant-time. El chequeo de longitud va primero porque
  // timingSafeEqual tira si los buffers no miden lo mismo.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UnauthorizedError('x-admin-token inválido o ausente');
  }
};
