/**
 * Script standalone para correr migraciones pendientes.
 *
 * Desarrollo:
 *   npm run db:migrate
 *
 * Docker (automático al arrancar el contenedor api):
 *   El entrypoint ejecuta `node dist/db/migrate.js` antes de `node dist/server.js`
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { env } from '../config/env.js';

// Resolver path de migrations de forma robusta:
//  - En dev (tsx): __dirname = api/src/db → ./migrations
//  - En build:     __dirname = api/dist/db → ./migrations (copiadas en Dockerfile)
const __dirname = dirname(fileURLToPath(import.meta.url));
const localMigrations = resolve(__dirname, './migrations');
const srcMigrations = resolve(__dirname, '../../src/db/migrations');
const migrationsFolder = existsSync(localMigrations) ? localMigrations : srcMigrations;

const run = async () => {
  console.log(`[migrate] folder: ${migrationsFolder}`);
  const client = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);
  try {
    await migrate(db, { migrationsFolder });
    console.log('[migrate] done');
  } finally {
    await client.end();
  }
};

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migrate] failed:', err);
    process.exit(1);
  });
