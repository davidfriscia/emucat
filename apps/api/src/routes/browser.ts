import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import type { AgentHub } from '../agents/hub.js';
import type { AgentAuthenticator } from '../auth/agent-auth.js';
import type { PairingPolicy } from '../agents/pairing.js';
import type { SessionCookiePolicy } from '../auth/guards.js';
import type { PasswordHasher } from '../auth/passwords.js';
import type { RateLimiter } from '../auth/rate-limiter.js';
import type { SessionPolicy } from '../auth/sessions.js';
import type { SetupToken } from '../auth/setup.js';
import type { LocalCopyRemovalCoordinator } from '../cleanup/local-removals.js';
import type {
  VersionDeletionCoordinator,
  VersionDeletionOptions,
} from '../cleanup/version-deletions.js';
import type { ExecutionCoordinator } from '../execution/coordinator.js';
import type { MediaPolicy } from '../media/uploads.js';
import type { RegistrationCoordinator, RegistrationPolicy } from '../registration/coordinator.js';
import type { RestoreCoordinator } from '../restore/coordinator.js';
import type { RemasterCoordinator } from '../versions/remaster.js';
import type { MediaStorage } from '../storage/media-storage.js';
import type { RemoteSessionOptions, WorkspaceCoordinator } from '../workspaces/coordinator.js';
import { registerAdminAgentRoutes } from './admin-agents.js';
import { registerAdminCatalogRoutes } from './admin-catalog.js';
import { registerAdminCloneRoutes } from './admin-clones.js';
import { registerAdminArchiveRoutes } from './admin-archives.js';
import { registerAgentRepositoryRelayRoutes } from './agent-repository-relay.js';
import type { ArchiveExplorer } from '../archives/explorer.js';
import type { ArchiveInspection } from '../archives/inspection.js';
import type { ArchivePolicy } from '../archives/policy.js';
import type { ServerCloneRunner } from '../clones/server-runner.js';
import type { RepositoryAccess } from '../repository-access/ssh.js';
import type { TransferPolicy } from '../transfers/policy.js';
import type { TransferService } from '../transfers/service.js';
import { registerAdminNotesRoutes } from './admin-notes.js';
import { CloneCoordinator } from '../clones/coordinator.js';
import type { NotesStorage } from '../notes/storage.js';
import { registerAdminTagRoutes } from './admin-tags.js';
import { registerAdminCleanupRoutes } from './admin-cleanup.js';
import { registerAdminExecutionRoutes } from './admin-execution.js';
import { registerAdminRegistrationRoutes } from './admin-registrations.js';
import { registerAdminRestoreRoutes } from './admin-restores.js';
import { registerAdminSystemRoutes, type DeploymentDependencies } from './admin-system.js';
import { registerAdminVersionRoutes } from './admin-versions.js';
import { registerAdminVirtualBoxRoutes } from './admin-virtualbox.js';
import type { VirtualBoxManagement } from '../virtualbox/management.js';
import { registerAgentMediaRoutes } from './agent-media.js';
import { registerAgentOvaImportRoutes } from './agent-ova-imports.js';
import { OvaImportCoordinator } from '../registration/ova-imports.js';
import { registerAgentPairingRoutes, type PairingRateLimits } from './agent-pairing.js';
import { registerAuthRoutes, type AuthRateLimits } from './auth.js';
import { registerPublicCatalogRoutes } from './public-catalog.js';

/** Everything the routes used by the web application need. */
export interface BrowserDependencies {
  pool: Pool;
  storage: MediaStorage;
  /** Per-VM Markdown notes (decision 0053). Without it, the notes routes answer 503 notes_unavailable. */
  notes?: NotesStorage | undefined;
  /** Limits on screenshot uploads and on decoding them. */
  media: MediaPolicy;
  passwords: PasswordHasher;
  setupToken: SetupToken;
  limiter: RateLimiter;
  rateLimits: AuthRateLimits;
  session: SessionPolicy;
  cookie: SessionCookiePolicy;
  publicOrigin?: string | undefined;
  pairing: PairingPolicy;
  pairingRateLimits: PairingRateLimits;
  /** Limits on acting on discovery results. Tests shorten them. */
  registrationPolicy?: RegistrationPolicy;
  /** How remote sessions retry and sweep. Tests shorten the delays, or turn the timer off. */
  remoteSessions?: Partial<RemoteSessionOptions>;
  /** How snapshot deletions retry. Tests shorten the delays. */
  versionDeletions?: Partial<VersionDeletionOptions>;
  /** Version reporting and the deployment service. Defaults to none configured. */
  deployment?: DeploymentDependencies;
  /** The server's own repository connection (decision 0055). Without it, nothing the server does itself works. */
  repositoryAccess?: RepositoryAccess;
  /** The relay's and server-side clones' staging (decision 0055). */
  transfers?: TransferPolicy;
  /** Archive inspection and Archive Explorer limits (decision 0056). */
  archives?: ArchivePolicy;
}

/** What the server does in repositories itself (decision 0055). */
export interface RepositoryServices {
  access: RepositoryAccess;
  transfers: TransferService;
  inspection: ArchiveInspection;
  explorer: ArchiveExplorer;
  clones: ServerCloneRunner;
  chunkBytes: number;
}

export async function registerBrowserRoutes(
  api: FastifyInstance,
  dependencies: BrowserDependencies,
  hub: AgentHub,
  registrations: RegistrationCoordinator,
  restores: RestoreCoordinator,
  execution: ExecutionCoordinator,
  captures: import('../execution/captures.js').CaptureCoordinator,
  workspaces: WorkspaceCoordinator,
  virtualbox: VirtualBoxManagement,
  cleanup: {
    removals: LocalCopyRemovalCoordinator;
    deletions: VersionDeletionCoordinator;
    remasters?: RemasterCoordinator;
  },
  authenticateAgent: AgentAuthenticator,
  repositories: RepositoryServices,
): Promise<void> {
  await api.register(cookie);
  api.decorateRequest('authSession', null);
  // Every response from these routes: nothing here should ever be interpreted as another type.
  api.addHook('onRequest', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
  });
  registerAuthRoutes(api, dependencies);
  registerPublicCatalogRoutes(api, dependencies);
  registerAdminCatalogRoutes(api, dependencies, hub);
  registerAdminTagRoutes(api, dependencies);
  registerAgentMediaRoutes(api, dependencies, authenticateAgent);
  registerAgentOvaImportRoutes(
    api,
    new OvaImportCoordinator(dependencies.pool, registrations, api.log),
    authenticateAgent,
  );
  registerAgentPairingRoutes(api, dependencies);
  registerAdminAgentRoutes(api, dependencies, hub);
  registerAdminRegistrationRoutes(api, dependencies, hub, registrations, repositories.access);
  registerAgentRepositoryRelayRoutes(
    api,
    repositories.transfers,
    authenticateAgent,
    repositories.chunkBytes,
  );
  registerAdminArchiveRoutes(api, dependencies, repositories.inspection, repositories.explorer);
  registerAdminRestoreRoutes(api, dependencies, restores);
  registerAdminExecutionRoutes(api, dependencies, execution, captures);
  registerAdminVersionRoutes(
    api,
    dependencies,
    registrations,
    workspaces,
    cleanup.deletions,
    cleanup.remasters ?? null,
  );
  registerAdminCleanupRoutes(api, dependencies, cleanup.removals, cleanup.deletions);
  registerAdminCloneRoutes(
    api,
    dependencies,
    new CloneCoordinator(dependencies.pool, repositories.clones, registrations, api.log),
  );
  registerAdminNotesRoutes(api, dependencies);
  registerAdminSystemRoutes(api, dependencies);
  registerAdminVirtualBoxRoutes(api, dependencies, virtualbox);
}
