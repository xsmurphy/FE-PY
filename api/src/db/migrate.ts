// Script standalone para correr migraciones pendientes.
// Ejecutar con: npm run db:migrate
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from '../config/env.js';

const run = async () => {
  const client = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log('Migrations complete.');
  await client.end();
  process.exit(0);
};

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
