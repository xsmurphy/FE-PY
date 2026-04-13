import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { env } from './config/env.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { healthRoutes } from './routes/health.js';
import { companyRoutes } from './routes/companies.js';
import { tenantRoutes } from './routes/tenants.js';
import { tenantCertRoutes } from './routes/tenant-certs.js';

export const buildApp = async () => {
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

  // Zod compilers para schemas de request/response
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Plugins de seguridad
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: true });

  // Multipart para upload de certs .p12
  await app.register(multipart, {
    limits: {
      fileSize: 1024 * 1024 * 5, // 5 MB por archivo (un .p12 típico es ~4 KB)
      files: 1,
      fields: 5,
    },
  });

  // Error handler central
  registerErrorHandler(app);

  // Rutas bajo /v1
  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(companyRoutes);
      await api.register(tenantRoutes);
      await api.register(tenantCertRoutes);
    },
    { prefix: '/v1' },
  );

  // Raíz informativa
  app.get('/', async () => ({
    service: 'facturacion-api',
    version: '0.1.0',
    docs: '/v1/health',
    env: env.NODE_ENV,
  }));

  return app;
};
