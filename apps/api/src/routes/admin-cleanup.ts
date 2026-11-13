import {
  createLocalCopyRemovalRequestSchema,
  deleteSnapshotRequestSchema,
  localCopyRemovalListQuerySchema,
  localCopyRemovalPathParamsSchema,
  versionPathParamsSchema,
  vmPathParamsSchema,
  type CreateLocalCopyRemovalRequest,
  type DeleteSnapshotRequest,
  type LocalCopyRemoval,
  type LocalCopyRemovalListResponse,
  type VersionDeletion,
  type VersionDeletionListResponse,
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
import type { LocalCopyRemovalCoordinator } from '../cleanup/local-removals.js';
import type { VersionDeletionCoordinator } from '../cleanup/version-deletions.js';
import { ApiError } from '../errors.js';
import type { BrowserDependencies } from './browser.js';

/**
 * Storage cleanup (decision 0041): removing one agent's persistent copy of a VM, and permanently deleting
 * a leaf snapshot. Administrators only. Nothing here accepts a path, an archive key or a repository: a
 * request names an agent, a VM, a version and a request ID, and the server decides everything else.
 */
export function registerAdminCleanupRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
  removals: LocalCopyRemovalCoordinator,
  deletions: VersionDeletionCoordinator,
): void {
  const { pool, session, cookie, publicOrigin } = dependencies;

  const requireVm = async (vm: VmIdentity) => {
    if (!(await vmExists(pool, vm))) {
      throw new ApiError(404, 'vm_not_found', 'Virtual machine not found');
    }
  };

  void parent.register(
    async (api) => {
      api.addHook('onRequest', requireSameOrigin(publicOrigin));
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', requireSession({ pool, session, cookie }));
      api.addHook('onRequest', requireAdmin);

      api.post(
        '/local-copy-removals',
        { schema: { body: createLocalCopyRemovalRequestSchema } },
        async (request, reply): Promise<LocalCopyRemoval> => {
          const body = request.body as CreateLocalCopyRemovalRequest;
          const removal = await removals.create(body, sessionOf(request).user.id);
          request.log.info(
            {
              operationId: removal.id,
              agentId: body.agentId,
              vmName: removal.vmName,
              discardLocalChanges: body.discardLocalChanges,
            },
            'Local copy removal requested',
          );
          reply.status(202);
          return removal;
        },
      );

      api.get(
        '/local-copy-removals',
        { schema: { querystring: localCopyRemovalListQuerySchema } },
        async (request): Promise<LocalCopyRemovalListResponse> => ({
          removals: await removals.list(
            request.query as z.infer<typeof localCopyRemovalListQuerySchema>,
          ),
        }),
      );

      api.get(
        '/local-copy-removals/:operationId',
        { schema: { params: localCopyRemovalPathParamsSchema } },
        async (request): Promise<LocalCopyRemoval> => {
          const { operationId } = request.params as z.infer<
            typeof localCopyRemovalPathParamsSchema
          >;
          const removal = await removals.get(operationId);
          if (!removal) throw new ApiError(404, 'removal_not_found', 'Removal not found');
          return removal;
        },
      );

      api.get(
        '/vms/:emulatorType/:vmName/version-deletions',
        { schema: { params: vmPathParamsSchema } },
        async (request): Promise<VersionDeletionListResponse> => {
          const vm = request.params as VmIdentity;
          await requireVm(vm);
          return { deletions: await deletions.list(vm) };
        },
      );

      api.post(
        '/vms/:emulatorType/:vmName/versions/:versionId/deletion',
        { schema: { params: versionPathParamsSchema, body: deleteSnapshotRequestSchema } },
        async (request, reply): Promise<VersionDeletion> => {
          const { versionId, ...vm } = request.params as z.infer<typeof versionPathParamsSchema>;
          const body = request.body as DeleteSnapshotRequest;
          // The confirmation names the exact version; a mismatch is a stale or forged page.
          if (body.versionId !== versionId) {
            throw new ApiError(
              400,
              'version_mismatch',
              'The confirmation names another version than the address.',
            );
          }
          await requireVm(vm);
          const deletion = await deletions.create(vm, body, sessionOf(request).user.id);
          request.log.info(
            { versionId, vmName: vm.vmName, state: deletion.state },
            'Snapshot deletion requested',
          );
          reply.status(202);
          return deletion;
        },
      );

      api.post(
        '/vms/:emulatorType/:vmName/versions/:versionId/deletion/retry',
        { schema: { params: versionPathParamsSchema } },
        async (request, reply): Promise<VersionDeletion> => {
          const { versionId, ...vm } = request.params as z.infer<typeof versionPathParamsSchema>;
          await requireVm(vm);
          const deletion = await deletions.retry(vm, versionId);
          request.log.info({ versionId, vmName: vm.vmName }, 'Snapshot deletion retried');
          reply.status(202);
          return deletion;
        },
      );
    },
    { prefix: '/admin' },
  );
}
