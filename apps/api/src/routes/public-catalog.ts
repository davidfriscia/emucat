import {
  mediaVariantSchema,
  publicCatalogQuerySchema,
  vmPathParamsSchema,
  type PublicCatalogQuery,
  type PublicCatalogResponse,
  type PublicVmDetail,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPublicVm, listPublicVms, publicMediaKey } from '../catalog/repository.js';
import { ApiError } from '../errors.js';
import type { BrowserDependencies } from './browser.js';
import { sendMediaFile } from './media-file.js';

const mediaFileParams = z.strictObject({ mediaId: z.uuid(), variant: mediaVariantSchema });

/**
 * Responses may be stored but must be revalidated, so that making something private takes effect
 * immediately rather than whenever a cache decides. A private VM and one that does not exist answer
 * identically.
 */
const REVALIDATE = 'no-cache';

export function registerPublicCatalogRoutes(
  api: FastifyInstance,
  { pool, storage }: BrowserDependencies,
): void {
  api.get(
    '/catalog/vms',
    { schema: { querystring: publicCatalogQuerySchema } },
    async (request, reply): Promise<PublicCatalogResponse> => {
      reply.header('cache-control', REVALIDATE);
      return listPublicVms(pool, request.query as PublicCatalogQuery);
    },
  );

  api.get(
    '/catalog/vms/:emulatorType/:vmName',
    { schema: { params: vmPathParamsSchema } },
    async (request, reply): Promise<PublicVmDetail> => {
      reply.header('cache-control', REVALIDATE);
      const vm = await getPublicVm(pool, request.params as VmIdentity);
      if (!vm) throw new ApiError(404, 'vm_not_found', 'Virtual machine not found');
      return vm;
    },
  );

  api.get(
    '/catalog/media/:mediaId/:variant',
    { schema: { params: mediaFileParams } },
    async (request, reply) => {
      const { mediaId, variant } = request.params as z.infer<typeof mediaFileParams>;
      const key = await publicMediaKey(pool, mediaId, variant);
      return sendMediaFile(request, reply, storage, key, REVALIDATE);
    },
  );
}
