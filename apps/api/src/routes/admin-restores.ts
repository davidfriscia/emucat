import {
  createRestoreRequestSchema,
  restoreListQuerySchema,
  restorePathParamsSchema,
  vmPathParamsSchema,
  type CreateRestoreRequest,
  type RestoreListResponse,
  type RestoreOperation,
  type RestoreOptionsResponse,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  noStore,
  requireAdmin,
  requireSameOrigin,
  requireSession,
  sessionOf,
} from '../auth/guards.js';
import { vmExists } from '../catalog/repository.js';
import { ApiError } from '../errors.js';
import type { RestoreCoordinator } from '../restore/coordinator.js';
import type { BrowserDependencies } from './browser.js';

/**
 * Restoring a master onto an agent. Administrators only. None of these routes accepts or returns archive
 * bytes or a filesystem path chosen by the browser: archives travel directly from repository to agent, and
 * the agent decides where they go.
 */
export function registerAdminRestoreRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
  restores: RestoreCoordinator,
): void {
  const { pool, session, cookie, publicOrigin } = dependencies;

  void parent.register(
    async (api) => {
      api.addHook('onRequest', requireSameOrigin(publicOrigin));
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', requireSession({ pool, session, cookie }));
      api.addHook('onRequest', requireAdmin);

      api.get(
        '/vms/:emulatorType/:vmName/restore-options',
        { schema: { params: vmPathParamsSchema } },
        async (request): Promise<RestoreOptionsResponse> => {
          const vm = request.params as VmIdentity;
          if (!(await vmExists(pool, vm))) {
            throw new ApiError(404, 'vm_not_found', 'Virtual machine not found');
          }
          return restores.options(vm);
        },
      );

      api.get(
        '/restores',
        { schema: { querystring: restoreListQuerySchema } },
        async (request): Promise<RestoreListResponse> => ({
          operations: await restores.list(request.query as z.infer<typeof restoreListQuerySchema>),
        }),
      );

      api.post(
        '/restores',
        { schema: { body: createRestoreRequestSchema } },
        async (request, reply): Promise<RestoreOperation> => {
          const body = request.body as CreateRestoreRequest;
          const operation = await restores.create(body, sessionOf(request).user.id);
          request.log.info(
            { operationId: operation.id, vmName: operation.vmName, agentId: body.agentId },
            'Restore requested',
          );
          reply.status(202);
          return operation;
        },
      );

      api.get(
        '/restores/:operationId',
        { schema: { params: restorePathParamsSchema } },
        async (request): Promise<RestoreOperation> => {
          const { operationId } = request.params as z.infer<typeof restorePathParamsSchema>;
          const operation = await restores.get(operationId);
          if (!operation) throw new ApiError(404, 'restore_not_found', 'Restore not found');
          return operation;
        },
      );

      api.post(
        '/restores/:operationId/cancel',
        { schema: { params: restorePathParamsSchema } },
        async (request): Promise<RestoreOperation> => {
          const { operationId } = request.params as z.infer<typeof restorePathParamsSchema>;
          return restores.cancel(operationId);
        },
      );
    },
    { prefix: '/admin' },
  );
}
