import { buildApp } from './app.js';
import { env } from './config/env.js';

const start = async (): Promise<void> => {
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(
      { port: env.PORT, env: env.NODE_ENV, sifen: env.ENABLE_SIFEN },
      `facturacion-api listening on :${env.PORT}`,
    );
  } catch (err) {
    app.log.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutting down...');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
};

void start();
