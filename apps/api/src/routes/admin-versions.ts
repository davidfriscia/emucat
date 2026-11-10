import {
  createSnapshotRequestSchema,
  createWorkspaceRequestSchema,
  discardWorkspaceRequestSchema,
  launchWorkspaceRequestSchema,
  preserveWorkspaceRequestSchema,
  vmPathParamsSchema,
  workspacePathParamsSchema,
  type CreateSnapshotRequest,
  type CreateWorkspaceRequest,
  type DiscardWorkspaceRequest,
  type LaunchWorkspaceRequest,
  type PreserveWorkspaceRequest,
  type RegistrationOperation,
  type VersionTreeResponse,
  type VmIdentity,
  type VmSession,
  type VmWorkspace,
  type WorkspaceListResponse,
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
import type { RegistrationCoordinator } from '../registration/coordinator.js';
import { versionTree } from '../versions/tree.js';
import type { WorkspaceCoordinator } from '../workspaces/coordinator.js';
import type { BrowserDependencies } from './browser.js';

/**
 * The version tree, snapshots and Remote Snapshot working copies. Administrators only, like every route
 * that knows about versions (decision 0039). Nothing here accepts a path, an archive key or a repository:
 * a request names a VM, a version, an agent and a request ID.
 */
export function registerAdminVersionRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
  registrations: RegistrationCoordinator,
  workspaces: WorkspaceCoordinator,
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

      api.get(
        '/vms/:emulatorType/:vmName/versions',
        { schema: { params: vmPathParamsSchema } },
        async (request): Promise<VersionTreeResponse> => {
          const vm = request.params as VmIdentity;
          await requireVm(vm);
          return versionTree(pool, vm);
        },
      );

      api.post(
        '/vms/:emulatorType/:vmName/snapshots',
        { schema: { params: vmPathParamsSchema, body: createSnapshotRequestSchema } },
        async (request, reply): Promise<RegistrationOperation> => {
          const vm = request.params as VmIdentity;
          await requireVm(vm);
          const body = request.body as CreateSnapshotRequest;
          const operation = await registrations.createSnapshot(
            vm,
            body,
            sessionOf(request).user.id,
          );
          request.log.info(
            { operationId: operation.id, vmName: operation.vmName, agentId: body.agentId },
            'Snapshot requested',
          );
          reply.status(202);
          return operation;
        },
      );

      api.get(
        '/vms/:emulatorType/:vmName/workspaces',
        { schema: { params: vmPathParamsSchema } },
        async (request): Promise<WorkspaceListResponse> => {
          const vm = request.params as VmIdentity;
          await requireVm(vm);
          return { workspaces: await workspaces.list(vm) };
        },
      );

      api.post(
        '/vms/:emulatorType/:vmName/workspaces',
        { schema: { params: vmPathParamsSchema, body: createWorkspaceRequestSchema } },
        async (request, reply): Promise<VmWorkspace> => {
          const vm = request.params as VmIdentity;
          await requireVm(vm);
          const body = request.body as CreateWorkspaceRequest;
          const workspace = await workspaces.create(vm, body, sessionOf(request).user.id);
          request.log.info(
            { workspaceId: workspace.id, vmName: workspace.vmName, agentId: body.agentId },
            'Remote Snapshot working copy requested',
          );
          reply.status(202);
          return workspace;
        },
      );

      api.get(
        '/workspaces/:workspaceId',
        { schema: { params: workspacePathParamsSchema } },
        async (request): Promise<VmWorkspace> => {
          const { workspaceId } = request.params as z.infer<typeof workspacePathParamsSchema>;
          const workspace = await workspaces.get(workspaceId);
          if (!workspace) throw new ApiError(404, 'workspace_not_found', 'Working copy not found');
          return workspace;
        },
      );

      api.post(
        '/workspaces/:workspaceId/launch',
        { schema: { params: workspacePathParamsSchema, body: launchWorkspaceRequestSchema } },
        async (request, reply): Promise<VmSession> => {
          const { workspaceId } = request.params as z.infer<typeof workspacePathParamsSchema>;
          const { requestId } = request.body as LaunchWorkspaceRequest;
          const session = await workspaces.launch(
            workspaceId,
            requestId,
            sessionOf(request).user.id,
          );
          reply.status(202);
          return session;
        },
      );

      api.post(
        '/workspaces/:workspaceId/snapshot',
        { schema: { params: workspacePathParamsSchema, body: preserveWorkspaceRequestSchema } },
        async (request, reply): Promise<RegistrationOperation> => {
          const { workspaceId } = request.params as z.infer<typeof workspacePathParamsSchema>;
          const { requestId } = request.body as PreserveWorkspaceRequest;
          const operation = await workspaces.preserve(
            workspaceId,
            requestId,
            sessionOf(request).user.id,
          );
          request.log.info({ operationId: operation.id, workspaceId }, 'Working copy preserved');
          reply.status(202);
          return operation;
        },
      );

      api.post(
        '/workspaces/:workspaceId/discard',
        { schema: { params: workspacePathParamsSchema, body: discardWorkspaceRequestSchema } },
        async (request): Promise<VmWorkspace> => {
          const { workspaceId } = request.params as z.infer<typeof workspacePathParamsSchema>;
          const { confirmVmName } = request.body as DiscardWorkspaceRequest;
          const workspace = await workspaces.discard(workspaceId, confirmVmName);
          request.log.info({ workspaceId }, 'Working copy discard requested');
          return workspace;
        },
      );
    },
    { prefix: '/admin' },
  );
}
