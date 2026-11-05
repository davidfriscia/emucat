import { AgentHub } from './agents/hub.js';
import { DEFAULT_PAIRING_POLICY } from './agents/pairing.js';
import { databaseAgentPresence } from './agents/repository.js';
import { databaseAgentAuthenticator } from './auth/agent-auth.js';
import { createPasswordHasher } from './auth/passwords.js';
import { RateLimiter } from './auth/rate-limiter.js';
import { createSetupToken, isSetupRequired } from './auth/setup.js';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { loadMigrations } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { loadDotEnv } from './env.js';
import { databaseReadiness } from './readiness.js';
import { DEFAULT_PAIRING_RATE_LIMITS } from './routes/agent-pairing.js';
import { announceSetupToken, DEFAULT_AUTH_RATE_LIMITS } from './routes/auth.js';
import type { BrowserDependencies } from './routes/browser.js';
import { fileMediaStorage } from './storage/media-storage.js';

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
  const browser: BrowserDependencies = {
    pool,
    storage: fileMediaStorage(config.storagePath),
    passwords: createPasswordHasher(),
    setupToken: createSetupToken(config.setupToken),
    limiter: new RateLimiter(),
    rateLimits: DEFAULT_AUTH_RATE_LIMITS,
    session: {
      idleTtlSeconds: config.sessionIdleTtlSeconds,
      absoluteTtlSeconds: config.sessionAbsoluteTtlSeconds,
    },
    cookie: { secure: config.cookieSecure, maxAgeSeconds: config.sessionAbsoluteTtlSeconds },
    publicOrigin: config.publicOrigin,
    pairing: DEFAULT_PAIRING_POLICY,
    pairingRateLimits: DEFAULT_PAIRING_RATE_LIMITS,
  };

  const app = await buildApp({
    logger: loggerOptions(config),
    readiness: databaseReadiness(pool, migrations, (error) => {
      app.log.warn({ err: error }, 'Readiness check failed');
    }),
    authenticateAgent: databaseAgentAuthenticator(pool),
    agentHub: new AgentHub({ presence: databaseAgentPresence(pool) }),
    trustProxy: config.trustProxy,
    browser,
  });
  // The status route also announces the token, in case the database is not up yet at this point.
  const pending = await isSetupRequired(pool).catch(() => false);
  if (pending) announceSetupToken({ log: app.log }, browser);
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
