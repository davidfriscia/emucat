import { CaptureCoordinator } from './execution/captures.js';
import { randomUUID } from 'node:crypto';
import websocket from '@fastify/websocket';
import { AGENT_MAX_MESSAGE_BYTES, API_PREFIX } from '@emucat/contracts';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AgentHub, NO_PRESENCE } from './agents/hub.js';
import type { AgentAuthenticator } from './auth/agent-auth.js';
import { registerErrorHandling } from './errors.js';
import { LocalCopyRemovalCoordinator } from './cleanup/local-removals.js';
import { VersionDeletionCoordinator } from './cleanup/version-deletions.js';
import { RemasterCoordinator } from './versions/remaster.js';
import { ExecutionCoordinator } from './execution/coordinator.js';
import { RegistrationCoordinator } from './registration/coordinator.js';
import { RestoreCoordinator } from './restore/coordinator.js';
import { VirtualBoxCoordinator } from './virtualbox/coordinator.js';
import { VirtualBoxManagement } from './virtualbox/management.js';
import { WorkspaceCoordinator } from './workspaces/coordinator.js';
import type { ReadinessCheck } from './readiness.js';
import { registerAgentWebSocket } from './routes/agent-ws.js';
import { registerBrowserRoutes, type BrowserDependencies } from './routes/browser.js';
import { RequestLogController } from './request-logging.js';
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
    // Keeps routine reads out of an `info` log.
    logController: new RequestLogController(),
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
            isVirtualBoxCapable: (agentId) => hub.isVirtualBoxCapable(agentId),
            isCloneCapable: (agentId) => hub.isCloneCapable(agentId),
            activeConnectionId: (agentId) => hub.activeConnectionId(agentId),
            latestDiscovery: (agentId) => hub.discovery.get(agentId),
            send: (agentId, message) => hub.sendToAgent(agentId, message),
          },
          app.log,
          browser.registrationPolicy,
        );
        hub.setOperations(registrations);
        const virtualbox = new VirtualBoxCoordinator(
          browser.pool,
          {
            isOnline: (agentId) => hub.isOnline(agentId),
            isVirtualBoxCapable: (agentId) => hub.isVirtualBoxCapable(agentId),
            send: (agentId, message) => hub.sendToAgent(agentId, message),
          },
          app.log,
        );
        const virtualboxManagement = new VirtualBoxManagement(
          browser.pool,
          {
            isOnline: (agentId) => hub.isOnline(agentId),
            isVirtualBoxCapable: (agentId) => hub.isVirtualBoxCapable(agentId),
            isVirtualBoxManagementCapable: (agentId) => hub.isVirtualBoxManagementCapable(agentId),
            activeConnectionId: (agentId) => hub.activeConnectionId(agentId),
            latestDiscovery: (agentId) => hub.discovery.get(agentId),
            send: (agentId, message) => hub.sendToAgent(agentId, message),
          },
          virtualbox,
          app.log,
          browser.registrationPolicy,
        );
        hub.setVirtualBox({
          watch: (agentId) => virtualbox.watch(agentId),
          states: (agentId, payload) => virtualbox.states(agentId, payload),
          controlResult: (agentId, payload) => virtualbox.controlResult(agentId, payload),
          operationsSynced: (agentId, entries) => virtualboxManagement.synced(agentId, entries),
          operationProgress: (agentId, payload) => virtualboxManagement.progress(agentId, payload),
          operationResult: (agentId, payload) => virtualboxManagement.result(agentId, payload),
        });
        // A new master is a machine to watch: the agent's list is replaced at once.
        registrations.onVirtualBoxRegistered = (agentId) => {
          virtualbox.watch(agentId).catch((error: unknown) => {
            app.log.error({ agentId, err: error }, 'Cannot send the VirtualBox watch list');
          });
        };
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
            isVirtualBoxCapable: (agentId) => hub.isVirtualBoxCapable(agentId),
            send: (agentId, message) => hub.sendToAgent(agentId, message),
          },
          app.log,
          {},
          virtualbox,
        );
        hub.setExecution(execution);
        const captures = new CaptureCoordinator(browser.pool, hub);
        hub.setCaptures(captures);
        captures.start();
        app.addHook('onClose', () => captures.close());
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
        // Remastering a VM (decision 0048): its commits happen inside registrations' and its cleanups are
        // version deletions. The sweep settles exports that ended, and cleanups that finished.
        const remasters = new RemasterCoordinator(
          browser.pool,
          {
            isOnline: (agentId) => hub.isOnline(agentId),
            isRegistrationCapable: (agentId) => hub.isRegistrationCapable(agentId),
            isVirtualBoxCapable: (agentId) => hub.isVirtualBoxCapable(agentId),
          },
          app.log,
          deletions,
          registrations,
        );
        registrations.remasters = remasters;
        remasters.start();
        app.addHook('onClose', () => remasters.close());
        await api.register(async (scope) =>
          registerBrowserRoutes(
            scope,
            browser,
            hub,
            registrations,
            restores,
            execution,
            captures,
            workspaces,
            virtualboxManagement,
            { removals, deletions, remasters },
            dependencies.authenticateAgent,
          ),
        );
      }
    },
    { prefix: API_PREFIX },
  );

  return app;
}
