import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema.js';

// Conexión postgres.js (mejor perf que node-postgres según Drizzle)
// max: pool size. Ajustar según carga esperada. 10 alcanza para MVP.
const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  // Redacción de params sensibles en logs
  debug: env.NODE_ENV === 'development',
});

export const db = drizzle(queryClient, { schema });
export { schema };
export type Database = typeof db;
