/**
 * Definiciones de las queues BullMQ del sistema.
 *
 * Convención:
 *   - Cada queue tiene un nombre único (clave en Redis)
 *   - Job data es JSON serializable, sin cert ni password
 *   - Defaults conservadores: 3 reintentos con backoff exponencial
 *   - removeOnComplete: 1000 (mantenemos últimos 1000 jobs exitosos para debug)
 *   - removeOnFail: false (los fallos se quedan para análisis manual)
 */
import { Queue, type QueueOptions } from 'bullmq';
import { getRedisConnection } from './connection.js';

const defaultQueueOptions: QueueOptions = {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5s → 10s → 20s
    },
    removeOnComplete: { count: 1000, age: 24 * 3600 }, // 24h o 1000
    removeOnFail: false,
  },
};

// ═════════════════════════════════════════════════════════════════
// Queue: sifen-batch
//
// Procesa documentos de un batch enviados vía POST /de/batch.
// Cada job procesa UN documento (no el batch entero) para que los
// reintentos sean por-documento y no bloqueen al resto del batch.
// ═════════════════════════════════════════════════════════════════

export interface SifenBatchJobData {
  /** UUID del batch (agrupa varios documentos del mismo POST) */
  batchId: string;
  /** UUID de la company */
  companyId: string;
  /** UUID del tenant */
  tenantId: string;
  /** Índice del documento dentro del batch (0-based) */
  index: number;
  /** Body del DE — estructura que espera xmlgen.generateXMLDE */
  body: Record<string, unknown>;
}

export const sifenBatchQueue = new Queue<SifenBatchJobData>('sifen-batch', defaultQueueOptions);

// ═════════════════════════════════════════════════════════════════
// Queue: sifen-retry
//
// Reintentos de documentos que fallaron al enviar a SIFEN (timeout,
// 5xx, SIFEN caído). El worker re-consulta el estado y reenvía si
// hace falta.
// ═════════════════════════════════════════════════════════════════

export interface SifenRetryJobData {
  documentId: string;
  companyId: string;
  tenantId: string;
  cdc: string;
}

export const sifenRetryQueue = new Queue<SifenRetryJobData>('sifen-retry', {
  ...defaultQueueOptions,
  defaultJobOptions: {
    ...defaultQueueOptions.defaultJobOptions,
    attempts: 5, // más generoso — SIFEN puede estar caído minutos
    backoff: {
      type: 'exponential',
      delay: 30_000, // 30s → 1m → 2m → 4m → 8m
    },
  },
});

/**
 * Enqueue un documento para retry cuando SIFEN dio timeout o error temporal.
 */
export const enqueueSifenRetry = async (data: SifenRetryJobData): Promise<void> => {
  await sifenRetryQueue.add(`retry-${data.documentId}`, data, {
    jobId: `retry-${data.documentId}`, // idempotente: no duplica si ya está encolado
  });
};

/**
 * Helper: cierra todas las queues limpiamente (para graceful shutdown).
 */
export const closeAllQueues = async (): Promise<void> => {
  await Promise.allSettled([
    sifenBatchQueue.close(),
    sifenRetryQueue.close(),
  ]);
};
