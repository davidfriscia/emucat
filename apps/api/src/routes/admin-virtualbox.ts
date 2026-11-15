import {
  versionPathParamsSchema,
  virtualBoxDeleteRequestSchema,
  virtualBoxImportRequestSchema,
  virtualBoxLinkRequestSchema,
  virtualBoxUnlinkRequestSchema,
  vmPathParamsSchema,
  type VirtualBoxDeleteRequest,
  type VirtualBoxImportRequest,
  type VirtualBoxLinkRequest,
  type VirtualBoxManagementResponse,
  type VirtualBoxOperation,
  type VirtualBoxUnlinkRequest,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  noStore,
  requireAdmin,
  requireSameOrigin,
  requireSession,
  sessionOf,
} from '../auth/guards.js';
import type { VirtualBoxManagement } from '../virtualbox/management.js';
import type { BrowserDependencies } from './browser.js';

const operationPathParamsSchema = vmPathParamsSchema.extend({ operationId: z.uuid() });

/**
 * A VirtualBox VM's machine: its link, imports into VirtualBox and deletions from it (decision 0046).
 * Administrators only. A request names a VM, an agent, a machine UUID and a request ID; never a path, and never a
 * machine by its name. A machine's name is only typed again, to confirm a deletion.
 */
export function registerAdminVirtualBoxRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
  management: VirtualBoxManagement,
): void {
  const { pool, session, cookie, publicOrigin } = dependencies;

  void parent.register(
    async (api) => {
      api.addHook('onRequest', requireSameOrigin(publicOrigin));
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', requireSession({ pool, session, cookie }));
      api.addHook('onRequest', requireAdmin);

      api.get(
        '/vms/:emulatorType/:vmName/virtualbox',
        { schema: { params: vmPathParamsSchema } },
        async (request): Promise<VirtualBoxManagementResponse> =>
          management.overview(request.params as VmIdentity),
      );

      api.get(
        '/vms/:emulatorType/:vmName/virtualbox/operations/:operationId',
        { schema: { params: operationPathParamsSchema } },
        async (request): Promise<VirtualBoxOperation> => {
          const { operationId, ...vm } = request.params as z.infer<
            typeof operationPathParamsSchema
          >;
          return management.get(vm, operationId);
        },
      );

      api.post(
        '/vms/:emulatorType/:vmName/virtualbox/link',
        { schema: { params: vmPathParamsSchema, body: virtualBoxLinkRequestSchema } },
        async (request): Promise<VirtualBoxOperation> =>
          management.linkMachine(
            request.params as VmIdentity,
            request.body as VirtualBoxLinkRequest,
            sessionOf(request).user.id,
          ),
      );

      api.post(
        '/vms/:emulatorType/:vmName/virtualbox/unlink',
        { schema: { params: vmPathParamsSchema, body: virtualBoxUnlinkRequestSchema } },
        async (request): Promise<VirtualBoxOperation> =>
          management.unlinkMachine(
            request.params as VmIdentity,
            request.body as VirtualBoxUnlinkRequest,
            sessionOf(request).user.id,
          ),
      );

      api.post(
        '/vms/:emulatorType/:vmName/versions/:versionId/virtualbox-import',
        { schema: { params: versionPathParamsSchema, body: virtualBoxImportRequestSchema } },
        async (request, reply): Promise<VirtualBoxOperation> => {
          const { versionId, ...vm } = request.params as z.infer<typeof versionPathParamsSchema>;
          const operation = await management.importVersion(
            vm,
            versionId,
            request.body as VirtualBoxImportRequest,
            sessionOf(request).user.id,
          );
          reply.status(202);
          return operation;
        },
      );

      api.post(
        '/vms/:emulatorType/:vmName/virtualbox/delete',
        { schema: { params: vmPathParamsSchema, body: virtualBoxDeleteRequestSchema } },
        async (request, reply): Promise<VirtualBoxOperation> => {
          const operation = await management.deleteMachine(
            request.params as VmIdentity,
            request.body as VirtualBoxDeleteRequest,
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
