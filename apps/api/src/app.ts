import { randomUUID } from 'node:crypto';
import websocket from '@fastify/websocket';
import { AGENT_MAX_MESSAGE_BYTES, API_PREFIX } from '@emucat/contracts';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AgentHub, NO_PRESENCE } from './agents/hub.js';
import type { AgentAuthenticator } from './auth/agent-auth.js';
import { registerErrorHandling } from './errors.js';
import { LocalCopyRemovalCoordinator } from './cleanup/local-removals.js';
import { VersionDeletionCoordinator } from './cleanup/version-deletions.js';
import { ExecutionCoordinator } from './execution/coordinator.js';
import { RegistrationCoordinator } from './registration/coordinator.js';
import { RestoreCoordinator } from './restore/coordinator.js';
import { WorkspaceCoordinator } from './workspaces/coordinator.js';
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
            isSnapshotCapable: (agentId) => hub.isSnapshotCapable(agentId),
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
            workspacesSupported: (agentId) => hub.workspacesSupported(agentId),
            restoreCapabilities: (agentId) => hub.restoreCapabilities(agentId),
            send: (agentId, message) => hub.sendToAgent(agentId, message),
          },
          app.log,
        );
        hub.setExecution(execution);
        const workspaces = new WorkspaceCoordinator(
          browser.pool,
          {
            isOnline: (agentId) => hub.isOnline(agentId),
            send: (agentId, message) => hub.sendToAgent(agentId, message),
          },
          app.log,
          restores,
          execution,
          registrations,
          browser.remoteSessions,
        );
        hub.setWorkspaces(workspaces);
        // Remote sessions move on by themselves, and the sweep is what retries what is due.
        workspaces.start();
        app.addHook('onClose', () => workspaces.close());
        const cleanupLink = {
          isOnline: (agentId: string) => hub.isOnline(agentId),
          restoreCapabilities: (agentId: string) => hub.restoreCapabilities(agentId),
          send: (agentId: string, message: Parameters<AgentHub['sendToAgent']>[1]) =>
            hub.sendToAgent(agentId, message),
        };
        const removals = new LocalCopyRemovalCoordinator(browser.pool, cleanupLink, app.log);
        const deletions = new VersionDeletionCoordinator(
          browser.pool,
          cleanupLink,
          app.log,
          browser.versionDeletions,
        );
        hub.setCleanup({
          synced: async (agentId, payload) => {
            await removals.synced(agentId, payload);
            await deletions.synced(agentId, payload);
          },
          removalResult: (agentId, payload) => removals.result(agentId, payload),
          archiveDeleteResult: (agentId, payload) => deletions.result(agentId, payload),
          agentRevoked: (agentId) => removals.agentRevoked(agentId),
        });
        // Deleting archives is retried by itself until the repository confirms.
        deletions.start();
        app.addHook('onClose', () => deletions.close());
        await api.register(async (scope) =>
          registerBrowserRoutes(
            scope,
            browser,
            hub,
            registrations,
            restores,
            execution,
            workspaces,
            { removals, deletions },
            dependencies.authenticateAgent,
          ),
        );
      }
    },
    { prefix: API_PREFIX },
  );

  return app;
}
