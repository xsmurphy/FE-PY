/**
 * Conexión compartida a Redis para BullMQ.
 *
 * BullMQ espera un ioredis client con configuración específica:
 *   - maxRetriesPerRequest: null (NO reintentar, BullMQ maneja los retries)
 *   - enableReadyCheck: false
 *
 * Una sola instancia se reutiliza para todas las queues y workers — abrir
 * múltiples conexiones desperdicia recursos y sube la latencia.
 */
import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env.js';

let connection: Redis | undefined;

const BULLMQ_REDIS_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

export const getRedisConnection = (): Redis => {
  if (!connection) {
    const conn = new Redis(env.REDIS_URL, BULLMQ_REDIS_OPTIONS);
    conn.on('error', (err: Error) => {
      // No crash — los errores se logean, BullMQ reintenta
      // eslint-disable-next-line no-console
      console.error('[redis] connection error:', err.message);
    });
    connection = conn;
  }
  return connection;
};

export const closeRedisConnection = async (): Promise<void> => {
  if (connection) {
    await connection.quit();
    connection = undefined;
  }
};
