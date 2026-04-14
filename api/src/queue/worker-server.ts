/**
 * Worker server: entry point que arranca todos los workers BullMQ.
 *
 * Se ejecuta como un proceso separado del API HTTP:
 *   - Dev:    npm run worker:dev
 *   - Docker: CMD ["worker"] en el mismo contenedor vía docker-entrypoint
 *
 * Graceful shutdown: al recibir SIGTERM/SIGINT, espera a que los jobs en
 * progreso terminen antes de cerrar.
 */
import { createSifenBatchWorker } from './workers/sifen-batch.worker.js';
import { createSifenRetryWorker } from './workers/sifen-retry.worker.js';
import { closeAllQueues } from './queues.js';
import { closeRedisConnection } from './connection.js';
import { startIdempotencyGc, stopIdempotencyGc } from './gc.js';
import { initSentry } from '../lib/sentry.js';

const log = (msg: string, extra?: Record<string, unknown>) => {
  // eslint-disable-next-line no-console
  console.log(`[worker-server] ${msg}`, extra ?? '');
};

const main = async () => {
  initSentry();
  log('starting workers...');

  const batchWorker = createSifenBatchWorker();
  const retryWorker = createSifenRetryWorker();

  startIdempotencyGc(log);

  log('workers ready: sifen-batch, sifen-retry, gc-idempotency');

  const shutdown = async (signal: string) => {
    log(`received ${signal}, shutting down...`);
    try {
      stopIdempotencyGc();
      await Promise.allSettled([batchWorker.close(), retryWorker.close()]);
      await closeAllQueues();
      await closeRedisConnection();
      log('shutdown complete');
      process.exit(0);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[worker-server] shutdown error:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
};

void main();
