import { randomUUID } from 'node:crypto';
import websocket from '@fastify/websocket';
import { AGENT_MAX_MESSAGE_BYTES, API_PREFIX } from '@emucat/contracts';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { AgentAuthenticator } from './auth/agent-auth.js';
import { registerErrorHandling } from './errors.js';
import type { ReadinessCheck } from './readiness.js';
import { registerAgentWebSocket } from './routes/agent-ws.js';
import { registerBrowserRoutes, type BrowserDependencies } from './routes/browser.js';
import { registerSystemRoutes } from './routes/system.js';
import { zodValidatorCompiler } from './validation.js';

export interface AppDependencies {
  readiness: ReadinessCheck;
  authenticateAgent: AgentAuthenticator;
  logger?: FastifyServerOptions['logger'];
  /** Adds routes under the API prefix. Tests use it to exercise shared behavior. */
  extraRoutes?: (app: FastifyInstance) => void;
  /** Authentication and catalog routes for the web application. */
  browser?: BrowserDependencies;
  /** Reverse proxies whose `X-Forwarded-For` is believed. Empty means none. */
  trustProxy?: string[];
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: dependencies.logger ?? false,
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
    ...(dependencies.trustProxy?.length ? { trustProxy: dependencies.trustProxy } : {}),
  });
  app.setValidatorCompiler(zodValidatorCompiler);
  registerErrorHandling(app);

  await app.register(websocket, {
    options: { maxPayload: AGENT_MAX_MESSAGE_BYTES },
  });

  await app.register(
    async (api) => {
      registerSystemRoutes(api, dependencies.readiness);
      registerAgentWebSocket(api, dependencies.authenticateAgent);
      dependencies.extraRoutes?.(api);
      if (dependencies.browser) {
        const { browser } = dependencies;
        await api.register(async (scope) => registerBrowserRoutes(scope, browser));
      }
    },
    { prefix: API_PREFIX },
  );

  return app;
}
