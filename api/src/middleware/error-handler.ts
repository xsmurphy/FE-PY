import type { FastifyInstance, FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { AppError, InternalError } from '../lib/errors.js';

/**
 * Error handler centralizado.
 *
 * Convierte cualquier throw en una respuesta JSON consistente:
 *   { error: { code, message, details? } }
 *
 * Reglas:
 *   - AppError → usa su code/statusCode/details
 *   - ZodError → 422 con lista de issues
 *   - Fastify validation error (schema fail) → 400
 *   - Cualquier otra cosa → 500 "Internal server error" (no leak stack)
 */
export const registerErrorHandler = (app: FastifyInstance): void => {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Errores propios de la app
    if (error instanceof AppError) {
      request.log.warn(
        { err: { code: error.code, message: error.message }, requestId: request.id },
        'App error',
      );
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }

    // Zod (validación de request body/params/query)
    if (error instanceof ZodError) {
      return reply.status(422).send({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
            code: i.code,
          })),
        },
      });
    }

    // Fastify validation error (cuando usa schemas nativos)
    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: error.message,
          details: error.validation,
        },
      });
    }

    // Payload too large, content type not supported, etc
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code ?? 'bad_request',
          message: error.message,
        },
      });
    }

    // Todo lo demás es un error interno nuestro: logueamos con stack
    // pero NO lo exponemos al cliente.
    request.log.error({ err: error, requestId: request.id }, 'Unhandled error');
    const fallback = new InternalError();
    return reply.status(fallback.statusCode).send({
      error: {
        code: fallback.code,
        message: fallback.message,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: 'not_found',
        message: `Route ${request.method}:${request.url} not found`,
      },
    });
  });
};
