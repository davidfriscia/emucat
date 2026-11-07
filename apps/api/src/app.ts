import { randomUUID } from 'node:crypto';
import websocket from '@fastify/websocket';
import { AGENT_MAX_MESSAGE_BYTES, API_PREFIX } from '@emucat/contracts';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AgentHub, NO_PRESENCE } from './agents/hub.js';
import type { AgentAuthenticator } from './auth/agent-auth.js';
import { registerErrorHandling } from './errors.js';
import { ExecutionCoordinator } from './execution/coordinator.js';
import { RegistrationCoordinator } from './registration/coordinator.js';
import { RestoreCoordinator } from './restore/coordinator.js';
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
  /** Connected agents. Defaults to a hub with no persistence, for tests of the protocol alone. */
  agentHub?: AgentHub;
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

  const hub = dependencies.agentHub ?? new AgentHub({ presence: NO_PRESENCE });
  app.addHook('preClose', () => hub.shutdown());

  await app.register(websocket, {
    options: { maxPayload: AGENT_MAX_MESSAGE_BYTES },
  });

  await app.register(
    async (api) => {
      registerSystemRoutes(api, dependencies.readiness);
      registerAgentWebSocket(api, dependencies.authenticateAgent, hub);
      dependencies.extraRoutes?.(api);
      if (dependencies.browser) {
        const { browser } = dependencies;
        const registrations = new RegistrationCoordinator(
          browser.pool,
          {
            isOnline: (agentId) => hub.isOnline(agentId),
            isRegistrationCapable: (agentId) => hub.isRegistrationCapable(agentId),
            activeConnectionId: (agentId) => hub.activeConnectionId(agentId),
            latestDiscovery: (agentId) => hub.discovery.get(agentId),
            send: (agentId, message) => hub.sendToAgent(agentId, message),
          },
          app.log,
          browser.registrationPolicy,
        );
        hub.setOperations(registrations);
        const restores = new RestoreCoordinator(
          browser.pool,
          {
            isOnline: (agentId) => hub.isOnline(agentId),
            restoreCapabilities: (agentId) => hub.restoreCapabilities(agentId),
            send: (agentId, message) => hub.sendToAgent(agentId, message),
          },
          app.log,
        );
        hub.setRestores(restores);
        const execution = new ExecutionCoordinator(
          browser.pool,
          {
            isOnline: (agentId) => hub.isOnline(agentId),
            executionCapabilities: (agentId) => hub.executionCapabilities(agentId),
            send: (agentId, message) => hub.sendToAgent(agentId, message),
          },
          app.log,
        );
        hub.setExecution(execution);
        await api.register(async (scope) =>
          registerBrowserRoutes(
            scope,
            browser,
            hub,
            registrations,
            restores,
            execution,
            dependencies.authenticateAgent,
          ),
        );
      }
    },
    { prefix: API_PREFIX },
  );

  return app;
}
