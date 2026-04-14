/**
 * GC periódico de idempotency_keys expirados.
 *
 * Usa setInterval — sin BullMQ porque es una tarea interna del server que
 * no necesita persistencia ni reintentos: si se salta un ciclo, el próximo
 * borra tanto los viejos como los nuevos.
 *
 * Ejecuta cada IDEMPOTENCY_GC_INTERVAL_MS (default 1h) y elimina entries
 * con expires_at < now.
 */
import { lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { idempotencyKeys } from '../db/schema.js';
import { env } from '../config/env.js';

let timer: NodeJS.Timeout | null = null;

const gcOnce = async (): Promise<number> => {
  const result = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, new Date()))
    .returning({ key: idempotencyKeys.key });
  return result.length;
};

export const startIdempotencyGc = (
  log: (msg: string, extra?: Record<string, unknown>) => void,
): void => {
  if (timer) return;

  // Primera ejecución demorada 30s para no bloquear el startup
  setTimeout(() => {
    void gcOnce()
      .then((n) => log(`[gc-idempotency] initial run deleted ${n} entries`))
      .catch((err) => log('[gc-idempotency] error', { err }));
  }, 30_000);

  timer = setInterval(() => {
    void gcOnce()
      .then((n) => {
        if (n > 0) log(`[gc-idempotency] deleted ${n} expired entries`);
      })
      .catch((err) => log('[gc-idempotency] error', { err }));
  }, env.IDEMPOTENCY_GC_INTERVAL_MS);

  // No impedir que el proceso termine por este timer
  timer.unref();
};

export const stopIdempotencyGc = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
