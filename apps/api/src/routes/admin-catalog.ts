import {
  adminCatalogQuerySchema,
  adminMediaVariantSchema,
  selectMainMediaRequestSchema,
  updateVmMetadataRequestSchema,
  updateVmVisibilityRequestSchema,
  vmPathParamsSchema,
  type AdminCatalogQuery,
  type AdminCatalogResponse,
  type AdminMediaDetail,
  type AdminMediaListResponse,
  type AdminMediaSyncResponse,
  type AdminSummaryResponse,
  type AdminVmDetail,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import type { AgentHub } from '../agents/hub.js';
import { noStore, requireAdmin, requireSameOrigin, requireSession } from '../auth/guards.js';
import {
  adminMediaFile,
  adminSummary,
  agentsHoldingVm,
  CatalogNotFoundError,
  clearMainMedia,
  deleteMedia,
  getAdminMedia,
  getAdminVm,
  listAdminMedia,
  listAdminVms,
  selectMainMedia,
  setVmVisibility,
  updateVmMetadata,
  vmExists,
} from '../catalog/repository.js';
import { ApiError } from '../errors.js';
import type { BrowserDependencies } from './browser.js';
import { sendMediaFile } from './media-file.js';

const vmNotFound = () => new ApiError(404, 'vm_not_found', 'Virtual machine not found');
const mediaNotFound = () => new ApiError(404, 'media_not_found', 'Media not found');

const mediaParams = vmPathParamsSchema.extend({ mediaId: z.uuid() });
const mediaFileParams = mediaParams.extend({ variant: adminMediaVariantSchema });

async function adminVmOr404(pool: Pool, vm: VmIdentity): Promise<AdminVmDetail> {
  const detail = await getAdminVm(pool, vm);
  if (!detail) throw vmNotFound();
  return detail;
}

async function mediaListOr404(pool: Pool, vm: VmIdentity): Promise<AdminMediaListResponse> {
  if (!(await vmExists(pool, vm))) throw vmNotFound();
  return { media: await listAdminMedia(pool, vm) };
}

/** Translates "not found" raised inside a transaction, after it has rolled back. */
async function mapNotFound<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof CatalogNotFoundError) {
      throw error.entity === 'vm' ? vmNotFound() : mediaNotFound();
    }
    throw error;
  }
}

/**
 * Administration of VMs that already exist. There is deliberately no route here that creates a VM:
 * the only way into the catalog is agent discovery followed by user confirmation. The VM's identity
 * comes only from the URL and is only ever used to find the row.
 */
export function registerAdminCatalogRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
  hub: AgentHub,
): void {
  const { pool, storage, session, cookie, publicOrigin } = dependencies;

  void parent.register(
    async (api) => {
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', requireSameOrigin(publicOrigin));
      api.addHook('onRequest', requireSession({ pool, session, cookie }));
      api.addHook('onRequest', requireAdmin);

      api.get('/summary', (): Promise<AdminSummaryResponse> => adminSummary(pool));

      api.get(
        '/vms',
        { schema: { querystring: adminCatalogQuerySchema } },
        (request): Promise<AdminCatalogResponse> =>
          listAdminVms(pool, request.query as AdminCatalogQuery),
      );

      api.get(
        '/vms/:emulatorType/:vmName',
        { schema: { params: vmPathParamsSchema } },
        (request): Promise<AdminVmDetail> => adminVmOr404(pool, request.params as VmIdentity),
      );

      api.patch(
        '/vms/:emulatorType/:vmName',
        { schema: { params: vmPathParamsSchema, body: updateVmMetadataRequestSchema } },
        async (request): Promise<AdminVmDetail> => {
          const vm = request.params as VmIdentity;
          const body = request.body as z.infer<typeof updateVmMetadataRequestSchema>;
          if (!(await updateVmMetadata(pool, vm, body))) throw vmNotFound();
          return adminVmOr404(pool, vm);
        },
      );

      api.put(
        '/vms/:emulatorType/:vmName/visibility',
        { schema: { params: vmPathParamsSchema, body: updateVmVisibilityRequestSchema } },
        async (request): Promise<AdminVmDetail> => {
          const vm = request.params as VmIdentity;
          const { visibility } = request.body as z.infer<typeof updateVmVisibilityRequestSchema>;
          if (!(await setVmVisibility(pool, vm, visibility))) throw vmNotFound();
          return adminVmOr404(pool, vm);
        },
      );

      api.get(
        '/vms/:emulatorType/:vmName/media',
        { schema: { params: vmPathParamsSchema } },
        (request): Promise<AdminMediaListResponse> =>
          mediaListOr404(pool, request.params as VmIdentity),
      );

      // What each agent holding this VM last said about its screenshots. In memory, like presence.
      api.get(
        '/vms/:emulatorType/:vmName/media-sync',
        { schema: { params: vmPathParamsSchema } },
        async (request): Promise<AdminMediaSyncResponse> => {
          const vm = request.params as VmIdentity;
          if (!(await vmExists(pool, vm))) throw vmNotFound();
          const agents = await agentsHoldingVm(pool, vm);
          return {
            agents: agents.map((agent) => ({
              agentId: agent.id,
              agentName: agent.name,
              online: hub.isOnline(agent.id),
              status: hub.mediaStatus(agent.id, vm),
            })),
          };
        },
      );

      api.get(
        '/vms/:emulatorType/:vmName/media/:mediaId',
        { schema: { params: mediaParams } },
        async (request): Promise<AdminMediaDetail> => {
          const { mediaId, ...vm } = request.params as z.infer<typeof mediaParams>;
          const media = await getAdminMedia(pool, vm, mediaId);
          if (!media) throw mediaNotFound();
          return media;
        },
      );

      api.put(
        '/vms/:emulatorType/:vmName/main-media',
        { schema: { params: vmPathParamsSchema, body: selectMainMediaRequestSchema } },
        async (request): Promise<AdminMediaListResponse> => {
          const vm = request.params as VmIdentity;
          const { mediaId } = request.body as z.infer<typeof selectMainMediaRequestSchema>;
          await mapNotFound(selectMainMedia(pool, vm, mediaId));
          return mediaListOr404(pool, vm);
        },
      );

      api.delete(
        '/vms/:emulatorType/:vmName/main-media',
        { schema: { params: vmPathParamsSchema } },
        async (request): Promise<AdminMediaListResponse> => {
          const vm = request.params as VmIdentity;
          await mapNotFound(clearMainMedia(pool, vm));
          return mediaListOr404(pool, vm);
        },
      );

      api.delete(
        '/vms/:emulatorType/:vmName/media/:mediaId',
        { schema: { params: mediaParams } },
        async (request): Promise<AdminMediaListResponse> => {
          const { mediaId, ...vm } = request.params as z.infer<typeof mediaParams>;
          await mapNotFound(deleteMedia(pool, vm, mediaId, (key) => storage.remove(key)));
          return mediaListOr404(pool, vm);
        },
      );

      api.get(
        '/vms/:emulatorType/:vmName/media/:mediaId/:variant',
        { schema: { params: mediaFileParams } },
        async (request, reply) => {
          const { mediaId, variant, ...vm } = request.params as z.infer<typeof mediaFileParams>;
          const file = await adminMediaFile(pool, vm, mediaId, variant);
          return sendMediaFile(
            request,
            reply,
            storage,
            file.key,
            'private, no-store',
            file.original,
          );
        },
      );
    },
    { prefix: '/admin' },
  );
}
