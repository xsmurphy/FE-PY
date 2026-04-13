/**
 * Clases de error custom. Todas heredan de AppError para que el error
 * handler central pueda detectarlas y devolver el código HTTP correcto.
 *
 * Convención: los mensajes son legibles por humanos. `code` es un identificador
 * estable que los clientes pueden parsear. `details` es info extra opcional
 * (ej. lista de errores de validación).
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super('bad_request', message, 400, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Missing or invalid credentials') {
    super('unauthorized', message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super('forbidden', message, 403);
  }
}

/**
 * NotFoundError: se usa también para tenants de otras companies.
 * Nunca devolvemos 403 ahí — eso revelaría la existencia del recurso.
 * Siempre 404, como si no existiera.
 */
export class NotFoundError extends AppError {
  constructor(resource: string) {
    super('not_found', `${resource} not found`, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super('conflict', message, 409, details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('validation_error', message, 422, details);
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfter?: number) {
    super('rate_limit_exceeded', 'Too many requests', 429, { retryAfter });
  }
}

export class SifenError extends AppError {
  constructor(message: string, details?: unknown) {
    super('sifen_error', message, 502, details);
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error') {
    super('internal_error', message, 500);
  }
}
