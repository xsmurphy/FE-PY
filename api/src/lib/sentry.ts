/**
 * Sentry init. Se llama solo si SENTRY_DSN está configurado.
 *
 * Tagueamos spans y errores con company_id y tenant_id (cuando existen en
 * el request) para que podamos filtrar por tenant afectado.
 *
 * La redacción de campos sensibles ya ocurre a nivel de pino — Sentry ve
 * los errores pero no el body crudo de requests (los beforeSend hook limpia
 * cualquier rastro de certs/passwords).
 */
import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';

let initialized = false;

export const initSentry = (): void => {
  if (initialized) return;
  if (!env.SENTRY_DSN) {
    // eslint-disable-next-line no-console
    console.log('[sentry] SENTRY_DSN not set — skipping init');
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    // Jamás enviamos secrets a Sentry
    beforeSend(event) {
      // Limpiar cualquier rastro de certs/passwords en el payload
      if (event.request?.data && typeof event.request.data === 'object') {
        const data = event.request.data as Record<string, unknown>;
        for (const key of Object.keys(data)) {
          if (
            /password|p12|cert|csc|api_key|authorization|secret/i.test(key)
          ) {
            data[key] = '[REDACTED]';
          }
        }
      }
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers['x-api-key'];
      }
      return event;
    },
  });

  initialized = true;
  // eslint-disable-next-line no-console
  console.log('[sentry] initialized', { environment: env.SENTRY_ENVIRONMENT });
};

export const captureException = (
  err: unknown,
  context?: { companyId?: string; tenantId?: string; requestId?: string },
): void => {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    if (context?.companyId) scope.setTag('company_id', context.companyId);
    if (context?.tenantId) scope.setTag('tenant_id', context.tenantId);
    if (context?.requestId) scope.setTag('request_id', context.requestId);
    Sentry.captureException(err);
  });
};

export { Sentry };
