import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  // Liveness: el proceso responde
  app.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness probe',
        response: {
          200: z.object({ status: z.literal('ok') }),
        },
      },
    },
    async () => {
      return { status: 'ok' as const };
    },
  );

  // Readiness: dependencias OK
  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness probe (DB + deps)',
        response: {
          200: z.object({
            status: z.literal('ok'),
            checks: z.object({
              database: z.enum(['ok', 'fail']),
            }),
          }),
          503: z.object({
            status: z.literal('degraded'),
            checks: z.object({
              database: z.enum(['ok', 'fail']),
            }),
          }),
        },
      },
    },
    async (_request, reply) => {
      let dbOk: 'ok' | 'fail' = 'ok';
      try {
        await db.execute(sql`SELECT 1`);
      } catch (err) {
        app.log.error({ err }, 'DB health check failed');
        dbOk = 'fail';
      }

      const allOk = dbOk === 'ok';
      return reply.status(allOk ? 200 : 503).send({
        status: allOk ? ('ok' as const) : ('degraded' as const),
        checks: { database: dbOk },
      });
    },
  );
};
