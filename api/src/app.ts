import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { env } from './config/env.js';
import { initSentry, captureException } from './lib/sentry.js';
import { AppError } from './lib/errors.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerAuditLog } from './middleware/audit-log.js';
import { healthRoutes } from './routes/health.js';
import { companyRoutes } from './routes/companies.js';
import { tenantRoutes } from './routes/tenants.js';
import { tenantCertRoutes } from './routes/tenant-certs.js';
import { tenantCscRoutes } from './routes/tenant-csc.js';
import { documentRoutes } from './routes/documents.js';
import { eventoRoutes } from './routes/eventos.js';
import { batchRoutes } from './routes/batches.js';
import { consultaRoutes } from './routes/consultas.js';
import { registerPlayground } from './routes/playground.js';

const parseCorsOrigins = (raw: string): string[] | boolean => {
  const trimmed = raw.trim();
  if (trimmed === '*' || trimmed === '') return true;
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
};

export const buildApp = async () => {
  // Sentry antes que nada — si algo revienta en el bootstrap queremos saberlo
  initSentry();

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
          : undefined,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          '*.apiKey',
          '*.api_key',
          '*.password',
          '*.p12',
          '*.encryptedP12',
          '*.encrypted_p12',
          '*.encryptedPassword',
          '*.encryptedDek',
          '*.csc',
          '*.encryptedCsc',
          '*.MASTER_KEY_BASE64',
          '*.masterKey',
        ],
        censor: '[REDACTED]',
      },
      base: { env: env.NODE_ENV },
    },
    genReqId: () => crypto.randomUUID(),
    disableRequestLogging: false,
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // ────────────────────────────────────────────
  // Plugins de seguridad
  // ────────────────────────────────────────────
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: parseCorsOrigins(env.CORS_ORIGINS) });

  // Rate limiting — clave por API key prefix (sin tocar DB) o por IP.
  //
  // Nota importante: rate-limit se registra globalmente y su keyGenerator
  // corre ANTES de cualquier preHandler de ruta (requireAuth). Por eso NO
  // podemos leer `req.company` — todavía no existe. En vez de eso, extraemos
  // el prefijo del Bearer token directo del header: da el mismo efecto
  // (rate-limit por tenant/cliente) sin hacer un lookup a la DB en el hot path.
  //
  // Requests sin auth → rate-limit por IP como fallback.
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      if (typeof auth === 'string' && auth.startsWith('Bearer cmp_')) {
        // Primeros 20 chars del bearer → suficiente entropía para distinguir
        // companies sin exponer la clave completa en logs del rate limiter
        return auth.slice(7, 27);
      }
      return req.ip;
    },
    errorResponseBuilder: (_req, context) => ({
      error: {
        code: 'rate_limit_exceeded',
        message: `Too many requests — limit ${context.max} per ${context.after}`,
        details: { retryAfter: context.ttl },
      },
    }),
  });

  // Multipart para upload de certs .p12
  await app.register(multipart, {
    limits: {
      fileSize: 1024 * 1024 * 5, // 5 MB
      files: 1,
      fields: 10,
    },
  });

  // ────────────────────────────────────────────
  // OpenAPI / Swagger UI
  // ────────────────────────────────────────────
  if (env.ENABLE_API_DOCS) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Facturación Electrónica Paraguay API',
          description:
            'API comercial multi-tenant para emisión de Documentos Electrónicos SIFEN. ' +
            'Todos los endpoints bajo /v1 requieren header `Authorization: Bearer cmp_*` ' +
            'excepto POST /v1/companies (signup) y /v1/health.',
          version: '0.1.0',
          contact: { name: 'Soporte' },
        },
        servers: [{ url: '/', description: 'Current server' }],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'cmp_<hex>',
              description: 'API key master de la company. Se genera en POST /v1/companies.',
            },
          },
        },
        tags: [
          { name: 'health', description: 'Health checks' },
          { name: 'companies', description: 'Plataformas clientes del servicio' },
          { name: 'tenants', description: 'Contribuyentes emisores (RUCs)' },
          { name: 'tenant-certs', description: 'Certificados PKCS#12' },
          { name: 'tenant-csc', description: 'Códigos CSC' },
          { name: 'documents', description: 'Documentos electrónicos' },
          { name: 'batches', description: 'Emisión por lotes asíncrona' },
          { name: 'eventos', description: 'Eventos SIFEN (cancelación, etc.)' },
          { name: 'consultas', description: 'Consultas read-only a SIFEN' },
        ],
      },
      transform: jsonSchemaTransform,
    });

    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
      },
    });
  }

  // ────────────────────────────────────────────
  // Error handler + audit log
  // ────────────────────────────────────────────
  registerErrorHandler(app);
  registerAuditLog(app);

  // Hook para reportar errores 5xx a Sentry (los 4xx son errores de cliente).
  //
  // Tres tipos de errores distintos a filtrar:
  //   - AppError: nuestras clases propias en lib/errors.ts (usan statusCode como
  //     propiedad de clase, no de instancia plana)
  //   - FastifyError: errores nativos de Fastify con statusCode como prop
  //   - Error genérico: sin statusCode → asumimos 500
  app.addHook('onError', async (request, _reply, error) => {
    // AppError de la app — filtramos 4xx
    if (error instanceof AppError) {
      if (error.statusCode < 500) return;
      captureException(error, {
        companyId: request.company?.id,
        tenantId: request.tenant?.id,
        requestId: request.id,
      });
      return;
    }

    // Fastify error con statusCode
    const status =
      'statusCode' in error && typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? ((error as { statusCode: number }).statusCode as number)
        : 500;
    if (status < 500) return;

    captureException(error, {
      companyId: request.company?.id,
      tenantId: request.tenant?.id,
      requestId: request.id,
    });
  });

  // ────────────────────────────────────────────
  // Rutas bajo /v1
  // ────────────────────────────────────────────
  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(companyRoutes);
      await api.register(tenantRoutes);
      await api.register(tenantCertRoutes);
      await api.register(tenantCscRoutes);
      await api.register(documentRoutes);
      await api.register(eventoRoutes);
      await api.register(batchRoutes);
      await api.register(consultaRoutes);
    },
    { prefix: '/v1' },
  );

  // Raíz informativa
  app.get('/', async () => ({
    service: 'facturacion-api',
    version: '0.1.0',
    docs: env.ENABLE_API_DOCS ? '/docs' : null,
    playground: env.ENABLE_PLAYGROUND ? '/playground' : null,
    health: '/v1/health',
    env: env.NODE_ENV,
  }));

  // Playground UI — HTML interactivo para probar la API sin Postman/curl.
  // Sirve en el mismo origen para evitar CORS. Gated: SOLO dev/staging
  // (permite provisionar companies/tenants desde el browser).
  if (env.ENABLE_PLAYGROUND) {
    registerPlayground(app);
  }

  return app;
};
