import {
  createRegistrationRequestSchema,
  registrationListQuerySchema,
  registrationPathParamsSchema,
  repositoryAgentPathParamsSchema,
  repositoryPathParamsSchema,
  saveRepositoryRequestSchema,
  type CreateRegistrationRequest,
  type RegistrationListResponse,
  type RegistrationOperation,
  type RepositoryListResponse,
  type RepositorySummary,
  type SaveRepositoryRequest,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentHub } from '../agents/hub.js';
import {
  noStore,
  requireAdmin,
  requireSameOrigin,
  requireSession,
  sessionOf,
} from '../auth/guards.js';
import { ApiError } from '../errors.js';
import type { RegistrationCoordinator } from '../registration/coordinator.js';
import {
  associateAgent,
  createRepository,
  dissociateAgent,
  getRepository,
  isAgentAssociated,
  listRepositories,
  updateRepository,
  type RepositoryPresence,
} from '../registration/repositories.js';
import type { BrowserDependencies } from './browser.js';

/**
 * Registering VMs and administering repositories. None of these routes ever accepts or returns archive
 * bytes, a filesystem path or a private key: archives travel directly between agent and repository.
 */
export function registerAdminRegistrationRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
  hub: AgentHub,
  registrations: RegistrationCoordinator,
): void {
  const { pool, session, cookie, publicOrigin } = dependencies;
  const presence: RepositoryPresence = {
    isOnline: (agentId) => hub.isOnline(agentId),
    isHealthCheckRunning: (repositoryId, agentId) =>
      registrations.isHealthCheckRunning(repositoryId, agentId),
  };

  void parent.register(
    async (api) => {
      api.addHook('onRequest', requireSameOrigin(publicOrigin));
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', requireSession({ pool, session, cookie }));
      api.addHook('onRequest', requireAdmin);

      api.get(
        '/registrations',
        { schema: { querystring: registrationListQuerySchema } },
        async (request): Promise<RegistrationListResponse> => {
          const { agentId } = request.query as z.infer<typeof registrationListQuerySchema>;
          return { operations: await registrations.list(agentId) };
        },
      );

      api.post(
        '/registrations',
        { schema: { body: createRegistrationRequestSchema } },
        async (request, reply): Promise<RegistrationOperation> => {
          const body = request.body as CreateRegistrationRequest;
          const operation = await registrations.create(body, sessionOf(request).user.id);
          request.log.info(
            { operationId: operation.id, vmName: body.vmName, mode: body.mode },
            'Registration requested',
          );
          reply.status(202);
          return operation;
        },
      );

      api.get(
        '/registrations/:operationId',
        { schema: { params: registrationPathParamsSchema } },
        async (request): Promise<RegistrationOperation> => {
          const { operationId } = request.params as z.infer<typeof registrationPathParamsSchema>;
          const operation = await registrations.get(operationId);
          if (!operation) {
            throw new ApiError(404, 'registration_not_found', 'Registration not found');
          }
          return operation;
        },
      );

      api.post(
        '/registrations/:operationId/cancel',
        { schema: { params: registrationPathParamsSchema } },
        async (request): Promise<RegistrationOperation> => {
          const { operationId } = request.params as z.infer<typeof registrationPathParamsSchema>;
          return registrations.cancel(operationId);
        },
      );

      api.post(
        '/registrations/:operationId/reconcile',
        { schema: { params: registrationPathParamsSchema } },
        async (request): Promise<RegistrationOperation> => {
          const { operationId } = request.params as z.infer<typeof registrationPathParamsSchema>;
          return registrations.reconcile(operationId);
        },
      );

      api.get('/repositories', async (): Promise<RepositoryListResponse> => {
        return { repositories: await listRepositories(pool, presence) };
      });

      api.post(
        '/repositories',
        { schema: { body: saveRepositoryRequestSchema } },
        async (request, reply): Promise<RepositorySummary> => {
          const id = await createRepository(pool, request.body as SaveRepositoryRequest);
          reply.status(201);
          return getRepository(pool, id, presence);
        },
      );

      api.put(
        '/repositories/:repositoryId',
        { schema: { params: repositoryPathParamsSchema, body: saveRepositoryRequestSchema } },
        async (request): Promise<RepositorySummary> => {
          const { repositoryId } = request.params as z.infer<typeof repositoryPathParamsSchema>;
          await updateRepository(pool, repositoryId, request.body as SaveRepositoryRequest);
          return getRepository(pool, repositoryId, presence);
        },
      );

      api.put(
        '/repositories/:repositoryId/agents/:agentId',
        { schema: { params: repositoryAgentPathParamsSchema } },
        async (request): Promise<RepositorySummary> => {
          const { repositoryId, agentId } = request.params as z.infer<
            typeof repositoryAgentPathParamsSchema
          >;
          await associateAgent(pool, repositoryId, agentId);
          return getRepository(pool, repositoryId, presence);
        },
      );

      api.delete(
        '/repositories/:repositoryId/agents/:agentId',
        { schema: { params: repositoryAgentPathParamsSchema } },
        async (request): Promise<RepositorySummary> => {
          const { repositoryId, agentId } = request.params as z.infer<
            typeof repositoryAgentPathParamsSchema
          >;
          await dissociateAgent(pool, repositoryId, agentId);
          return getRepository(pool, repositoryId, presence);
        },
      );

      api.post(
        '/repositories/:repositoryId/agents/:agentId/health-check',
        { schema: { params: repositoryAgentPathParamsSchema } },
        async (request, reply): Promise<RepositorySummary> => {
          const { repositoryId, agentId } = request.params as z.infer<
            typeof repositoryAgentPathParamsSchema
          >;
          if (!(await isAgentAssociated(pool, repositoryId, agentId))) {
            throw new ApiError(
              409,
              'repository_not_authorized',
              'This agent is not associated with this repository.',
            );
          }
          registrations.startHealthCheck(repositoryId, agentId);
          reply.status(202);
          return getRepository(pool, repositoryId, presence);
        },
      );
    },
    { prefix: '/admin' },
  );
}
