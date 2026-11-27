import {
  createSnapshotRequestSchema,
  createWorkspaceRequestSchema,
  localRemasterPreviewQuerySchema,
  localRemasterRequestSchema,
  promoteSnapshotRequestSchema,
  remasterPathParamsSchema,
  setEntityTagsRequestSchema,
  updateVersionDetailsRequestSchema,
  versionPathParamsSchema,
  type LocalRemasterRequest,
  type PromoteSnapshotRequest,
  type RemasterListResponse,
  type RemasterOperation,
  type RemasterPreview,
  type VersionDetails,
  type EntityTagsResponse,
  type SetEntityTagsRequest,
  discardWorkspaceRequestSchema,
  launchWorkspaceRequestSchema,
  preserveWorkspaceRequestSchema,
  resumeWorkspaceRequestSchema,
  retryPublicationRequestSchema,
  vmPathParamsSchema,
  workspacePathParamsSchema,
  type CreateSnapshotRequest,
  type CreateWorkspaceRequest,
  type DiscardWorkspaceRequest,
  type LaunchWorkspaceRequest,
  type PreserveWorkspaceRequest,
  type RegistrationOperation,
  type RemoteSession,
  type RemoteSessionListResponse,
  type ResumeWorkspaceRequest,
  type VersionTreeResponse,
  type VmIdentity,
  type VmOperationListResponse,
  type VmSession,
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
import { getVersionTags, setVersionTags } from '../catalog/tags.js';
import { ApiError } from '../errors.js';
import type { VersionDeletionCoordinator } from '../cleanup/version-deletions.js';
import type { RegistrationCoordinator } from '../registration/coordinator.js';
import { updateVersionDetails } from '../versions/details.js';
import type { RemasterCoordinator } from '../versions/remaster.js';
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
  deletions: VersionDeletionCoordinator | null = null,
  remasters: RemasterCoordinator | null = null,
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
          return versionTree(pool, vm, deletions);
        },
      );

      // The operations that concern this VM's versions, while they run and for a while after (decision 0060).
      api.get(
        '/vms/:emulatorType/:vmName/operations',
        { schema: { params: vmPathParamsSchema } },
        async (request): Promise<VmOperationListResponse> => {
          const vm = request.params as VmIdentity;
          await requireVm(vm);
          return registrations.listForVm(vm);
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

      // A version's title and description: nothing else about it changes (decision 0048).
      api.patch(
        '/vms/:emulatorType/:vmName/versions/:versionId',
        { schema: { params: versionPathParamsSchema, body: updateVersionDetailsRequestSchema } },
        async (request): Promise<VersionDetails> => {
          const { versionId, ...vm } = request.params as z.infer<typeof versionPathParamsSchema>;
          await requireVm(vm);
          const body = request.body as z.output<typeof updateVersionDetailsRequestSchema>;
          const details = await updateVersionDetails(pool, vm, versionId, body);
          request.log.info({ versionId, vmName: vm.vmName }, 'Version details edited');
          return details;
        },
      );

      // A master's or snapshot's own tags (decision 0050). Never its parent's, children's or VM's.
      api.get(
        '/vms/:emulatorType/:vmName/versions/:versionId/tags',
        { schema: { params: versionPathParamsSchema } },
        async (request): Promise<EntityTagsResponse> => {
          const { versionId, ...vm } = request.params as z.infer<typeof versionPathParamsSchema>;
          return { tags: await getVersionTags(pool, vm, versionId) };
        },
      );

      api.put(
        '/vms/:emulatorType/:vmName/versions/:versionId/tags',
        { schema: { params: versionPathParamsSchema, body: setEntityTagsRequestSchema } },
        async (request): Promise<EntityTagsResponse> => {
          const { versionId, ...vm } = request.params as z.infer<typeof versionPathParamsSchema>;
          await requireVm(vm);
          const { tagIds } = request.body as SetEntityTagsRequest;
          return { tags: await setVersionTags(pool, vm, versionId, tagIds) };
        },
      );

      if (remasters) {
        const requireRemasters = (): RemasterCoordinator => remasters;

        api.get(
          '/vms/:emulatorType/:vmName/versions/:versionId/promotion',
          { schema: { params: versionPathParamsSchema } },
          async (request): Promise<RemasterPreview> => {
            const { versionId, ...vm } = request.params as z.infer<typeof versionPathParamsSchema>;
            await requireVm(vm);
            return requireRemasters().previewPromotion(vm, versionId);
          },
        );

        api.post(
          '/vms/:emulatorType/:vmName/versions/:versionId/promotion',
          { schema: { params: versionPathParamsSchema, body: promoteSnapshotRequestSchema } },
          async (request, reply): Promise<RemasterOperation> => {
            const { versionId, ...vm } = request.params as z.infer<typeof versionPathParamsSchema>;
            await requireVm(vm);
            const operation = await requireRemasters().promote(
              vm,
              versionId,
              request.body as PromoteSnapshotRequest,
              sessionOf(request).user.id,
            );
            request.log.info(
              { remasterId: operation.id, vmName: vm.vmName, versionId },
              'Snapshot promotion requested',
            );
            reply.status(202);
            return operation;
          },
        );

        api.get(
          '/vms/:emulatorType/:vmName/remaster/local',
          { schema: { params: vmPathParamsSchema, querystring: localRemasterPreviewQuerySchema } },
          async (request): Promise<RemasterPreview> => {
            const vm = request.params as VmIdentity;
            await requireVm(vm);
            const { agentId } = request.query as z.infer<typeof localRemasterPreviewQuerySchema>;
            return requireRemasters().previewLocal(vm, agentId);
          },
        );

        api.post(
          '/vms/:emulatorType/:vmName/remaster/local',
          { schema: { params: vmPathParamsSchema, body: localRemasterRequestSchema } },
          async (request, reply): Promise<RemasterOperation> => {
            const vm = request.params as VmIdentity;
            await requireVm(vm);
            const body = request.body as LocalRemasterRequest;
            const operation = await requireRemasters().createLocal(
              vm,
              body,
              sessionOf(request).user.id,
            );
            request.log.info(
              { remasterId: operation.id, vmName: vm.vmName, agentId: body.agentId },
              'Remaster from a local copy requested',
            );
            reply.status(202);
            return operation;
          },
        );

        api.get(
          '/vms/:emulatorType/:vmName/remasters',
          { schema: { params: vmPathParamsSchema } },
          async (request): Promise<RemasterListResponse> => {
            const vm = request.params as VmIdentity;
            await requireVm(vm);
            return { remasters: await requireRemasters().list(vm) };
          },
        );

        api.get(
          '/remasters/:remasterId',
          { schema: { params: remasterPathParamsSchema } },
          async (request): Promise<RemasterOperation> => {
            const { remasterId } = request.params as z.infer<typeof remasterPathParamsSchema>;
            const operation = await requireRemasters().get(remasterId);
            if (!operation) throw new ApiError(404, 'remaster_not_found', 'Remaster not found');
            return operation;
          },
        );

        api.post(
          '/remasters/:remasterId/cleanup/retry',
          { schema: { params: remasterPathParamsSchema } },
          async (request, reply): Promise<RemasterOperation> => {
            const { remasterId } = request.params as z.infer<typeof remasterPathParamsSchema>;
            const operation = await requireRemasters().retryCleanup(remasterId);
            request.log.info({ remasterId }, 'Remaster cleanup retried');
            reply.status(202);
            return operation;
          },
        );
      }

      api.get(
        '/vms/:emulatorType/:vmName/workspaces',
        { schema: { params: vmPathParamsSchema } },
        async (request): Promise<RemoteSessionListResponse> => {
          const vm = request.params as VmIdentity;
          await requireVm(vm);
          return { workspaces: await workspaces.list(vm) };
        },
      );

      api.post(
        '/vms/:emulatorType/:vmName/workspaces',
        { schema: { params: vmPathParamsSchema, body: createWorkspaceRequestSchema } },
        async (request, reply): Promise<RemoteSession> => {
          const vm = request.params as VmIdentity;
          await requireVm(vm);
          const body = request.body as CreateWorkspaceRequest;
          const workspace = await workspaces.create(vm, body, sessionOf(request).user.id);
          request.log.info(
            {
              workspaceId: workspace.id,
              vmName: workspace.vmName,
              agentId: body.agentId,
              versionId: body.versionId,
              mode: body.mode,
            },
            'Remote session requested',
          );
          reply.status(202);
          return workspace;
        },
      );

      api.get(
        '/workspaces/:workspaceId',
        { schema: { params: workspacePathParamsSchema } },
        async (request): Promise<RemoteSession> => {
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
        async (request): Promise<RemoteSession> => {
          const { workspaceId } = request.params as z.infer<typeof workspacePathParamsSchema>;
          const { confirmVmName } = request.body as DiscardWorkspaceRequest;
          const workspace = await workspaces.discard(workspaceId, confirmVmName);
          request.log.info(
            { workspaceId, abandoned: workspace.abandonedAt !== null },
            'Working copy discard requested',
          );
          return workspace;
        },
      );

      api.post(
        '/workspaces/:workspaceId/retry-publication',
        { schema: { params: workspacePathParamsSchema, body: retryPublicationRequestSchema } },
        async (request, reply): Promise<RemoteSession> => {
          const { workspaceId } = request.params as z.infer<typeof workspacePathParamsSchema>;
          const workspace = await workspaces.retryPublication(workspaceId);
          request.log.info({ workspaceId }, 'Remote snapshot publication retried');
          reply.status(202);
          return workspace;
        },
      );

      api.post(
        '/workspaces/:workspaceId/resume',
        { schema: { params: workspacePathParamsSchema, body: resumeWorkspaceRequestSchema } },
        async (request, reply): Promise<RemoteSession> => {
          const { workspaceId } = request.params as z.infer<typeof workspacePathParamsSchema>;
          const { confirmVmName } = request.body as ResumeWorkspaceRequest;
          const workspace = await workspaces.resume(workspaceId, confirmVmName);
          request.log.info({ workspaceId }, 'Held remote session resumed');
          reply.status(202);
          return workspace;
        },
      );
    },
    { prefix: '/admin' },
  );
}
