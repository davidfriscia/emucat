import { databaseAgentAuthenticator } from './auth/agent-auth.js';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { loadMigrations } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { loadDotEnv } from './env.js';
import { databaseReadiness } from './readiness.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function loggerOptions(config: Config) {
  return {
    level: config.logLevel,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    ...(config.logPretty ? { transport: { target: 'pino-pretty' } } : {}),
  };
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const pool = createPool(config.database);
  const migrations = await loadMigrations();

  const app = await buildApp({
    logger: loggerOptions(config),
    readiness: databaseReadiness(pool, migrations, (error) => {
      app.log.warn({ err: error }, 'Readiness check failed');
    }),
    authenticateAgent: databaseAgentAuthenticator(pool),
  });
  app.addHook('onClose', async () => {
    await pool.end();
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');
    const forceExit = setTimeout(() => {
      app.log.error('Shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    app.close().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        app.log.error({ err: error }, 'Shutdown failed');
        process.exitCode = 1;
      },
    );
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, shutdown);
  }

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
