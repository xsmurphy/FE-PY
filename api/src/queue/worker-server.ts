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
import { startCertExpirationCheck, stopCertExpirationCheck } from './cert-expiration-check.js';
import { initSentry } from '../lib/sentry.js';
import { createServer } from 'node:http';
import { env } from '../config/env.js';

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
  startCertExpirationCheck(log);

  log('workers ready: sifen-batch, sifen-retry, gc-idempotency, cert-expiration');

  // Liveness HTTP: el worker no sirve tráfico, pero el HEALTHCHECK de la
  // imagen (compartida con el API) consulta /v1/health — sin esto Docker
  // marca el contenedor unhealthy y Coolify hace rollback del deploy.
  const health = createServer((req, res) => {
    if (req.url === '/v1/health' || req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', role: 'worker' }));
      return;
    }
    res.writeHead(404).end();
  });
  health.listen(env.PORT, () => log(`liveness endpoint en :${env.PORT}/v1/health`));

  const shutdown = async (signal: string) => {
    log(`received ${signal}, shutting down...`);
    try {
      stopIdempotencyGc();
      stopCertExpirationCheck();
      health.close();
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
