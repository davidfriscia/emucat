import {
  cloneVmRequestSchema,
  versionPathParamsSchema,
  type CloneOptionsResponse,
  type CloneVmRequest,
  type RegistrationOperation,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import {
  noStore,
  requireAdmin,
  requireSameOrigin,
  requireSession,
  sessionOf,
} from '../auth/guards.js';
import { vmExists } from '../catalog/repository.js';
import type { CloneCoordinator } from '../clones/coordinator.js';
import { ApiError } from '../errors.js';
import type { BrowserDependencies } from './browser.js';

/**
 * Cloning a version into a new VM (decision 0052). Administrators only. A request names the source VM, one of its
 * versions, an agent, the new name and a request ID: never a path, a repository or an archive key.
 */
export function registerAdminCloneRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
  clones: CloneCoordinator,
): void {
  const { pool, session, cookie, publicOrigin } = dependencies;

  void parent.register(
    async (api) => {
      api.addHook('onRequest', requireSameOrigin(publicOrigin));
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', requireSession({ pool, session, cookie }));
      api.addHook('onRequest', requireAdmin);

      const requireVm = async (vm: VmIdentity) => {
        if (!(await vmExists(pool, vm))) {
          throw new ApiError(404, 'vm_not_found', 'Virtual machine not found');
        }
      };

      api.get(
        '/vms/:emulatorType/:vmName/versions/:versionId/clone-options',
        { schema: { params: versionPathParamsSchema } },
        async (request): Promise<CloneOptionsResponse> => {
          const { versionId, ...vm } = request.params as VmIdentity & { versionId: string };
          await requireVm(vm);
          return clones.options(vm, versionId);
        },
      );

      api.post(
        '/vms/:emulatorType/:vmName/versions/:versionId/clone',
        { schema: { params: versionPathParamsSchema, body: cloneVmRequestSchema } },
        async (request, reply): Promise<RegistrationOperation> => {
          const { versionId, ...vm } = request.params as VmIdentity & { versionId: string };
          await requireVm(vm);
          const operation = await clones.create(
            vm,
            versionId,
            request.body as CloneVmRequest,
            sessionOf(request).user.id,
          );
          reply.status(202);
          return operation;
        },
      );
    },
    { prefix: '/admin' },
  );
}
