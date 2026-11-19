import {
  completeOvaImportRequestSchema,
  createOvaImportRequestSchema,
  failOvaImportRequestSchema,
  OVA_IMPORT_API_PATH,
  ovaImportPathParamsSchema,
  ovaImportPreflightRequestSchema,
  ovaImportProgressRequestSchema,
  type CompleteOvaImportRequest,
  type CompleteOvaImportResponse,
  type CreateOvaImportRequest,
  type FailOvaImportRequest,
  type OvaImportPreflightRequest,
  type OvaImportPreflightResponse,
  type OvaImportProgressRequest,
  type RegistrationOperation,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import type { AgentAuthenticator } from '../auth/agent-auth.js';
import { agentHttpGuard, agentIdOf } from '../auth/agent-http.js';
import { noStore } from '../auth/guards.js';
import type { OvaImportCoordinator } from '../registration/ova-imports.js';

type Params = { operationId: string };

/**
 * Importing an OVA from the agent's command line (decision 0049). Only the agent's bearer credential gets in, and
 * the agent is always the one it names: an operation of another agent is not found. These routes carry control
 * messages only. No route accepts or returns archive bytes, which go straight to the repository (decision 0012).
 */
export function registerAgentOvaImportRoutes(
  parent: FastifyInstance,
  imports: OvaImportCoordinator,
  authenticate: AgentAuthenticator,
): void {
  void parent.register(
    async (api) => {
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', agentHttpGuard(authenticate));

      api.post(
        '/preflight',
        { schema: { body: ovaImportPreflightRequestSchema } },
        async (request): Promise<OvaImportPreflightResponse> =>
          imports.preflight(agentIdOf(request), request.body as OvaImportPreflightRequest),
      );

      api.post(
        '/',
        { schema: { body: createOvaImportRequestSchema } },
        async (request, reply): Promise<RegistrationOperation> => {
          const operation = await imports.create(
            agentIdOf(request),
            request.body as CreateOvaImportRequest,
          );
          reply.status(201);
          return operation;
        },
      );

      api.get(
        '/:operationId',
        { schema: { params: ovaImportPathParamsSchema } },
        async (request): Promise<RegistrationOperation> =>
          imports.get(agentIdOf(request), (request.params as Params).operationId),
      );

      api.post(
        '/:operationId/progress',
        { schema: { params: ovaImportPathParamsSchema, body: ovaImportProgressRequestSchema } },
        async (request): Promise<RegistrationOperation> =>
          imports.progress(
            agentIdOf(request),
            (request.params as Params).operationId,
            request.body as OvaImportProgressRequest,
          ),
      );

      api.post(
        '/:operationId/complete',
        { schema: { params: ovaImportPathParamsSchema, body: completeOvaImportRequestSchema } },
        async (request): Promise<CompleteOvaImportResponse> =>
          imports.complete(
            agentIdOf(request),
            (request.params as Params).operationId,
            request.body as CompleteOvaImportRequest,
          ),
      );

      api.post(
        '/:operationId/fail',
        { schema: { params: ovaImportPathParamsSchema, body: failOvaImportRequestSchema } },
        async (request): Promise<RegistrationOperation> =>
          imports.fail(
            agentIdOf(request),
            (request.params as Params).operationId,
            request.body as FailOvaImportRequest,
          ),
      );
    },
    { prefix: OVA_IMPORT_API_PATH },
  );
}
