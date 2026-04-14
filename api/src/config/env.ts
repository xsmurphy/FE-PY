import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  MASTER_KEY_BASE64: z
    .string()
    .min(1, 'MASTER_KEY_BASE64 is required — generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"')
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'MASTER_KEY_BASE64 must decode to exactly 32 bytes'),

  ENABLE_SIFEN: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // KUDE (PDF) gated por separado porque requiere Java runtime en el container
  // y el paquete facturacionelectronicapy-kude tiene una API inconsistente que
  // obliga a pasar por un workaround. Ver kude.service.ts.
  ENABLE_KUDE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  JAVA_PATH: z.string().default('/usr/bin/java'),

  // Cert expiration alerts cron
  CERT_EXPIRATION_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
  CERT_EXPIRATION_WARNING_DAYS: z.coerce.number().int().positive().default(30),

  // CORS: comma-separated list of allowed origins. '*' = allow all.
  CORS_ORIGINS: z.string().default('*'),

  // Rate limiting por company/IP
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600), // req
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000), // 1 min

  // Idempotency GC interval
  IDEMPOTENCY_GC_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000), // 1h

  // API documentation exposure
  ENABLE_API_DOCS: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  SENTRY_DSN: z.string().url().optional().or(z.literal('')),
  SENTRY_ENVIRONMENT: z.string().default('development'),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
});

type EnvShape = z.infer<typeof envSchema>;

let cached: EnvShape | null = null;

export const loadEnv = (): EnvShape => {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast with clear output — do not start the server with bad config
    console.error('❌ Invalid environment variables:');
    for (const issue of parsed.error.issues) {
      console.error(`  • ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
};

export const env = loadEnv();
export type Env = EnvShape;
