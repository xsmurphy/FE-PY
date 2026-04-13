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

  SENTRY_DSN: z.string().url().optional().or(z.literal('')),
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
