import {
  archiveListingQuerySchema,
  versionPathParamsSchema,
  type ArchiveListingQuery,
  type ArchiveListingResponse,
  type ArchiveSummary,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import { noStore, requireAdmin, requireSameOrigin, requireSession } from '../auth/guards.js';
import type { ArchiveInspection } from '../archives/inspection.js';
import type { BrowserDependencies } from './browser.js';

/**
 * View Archive Contents (decision 0055). Administrators only: a listing names every file of a VM, which may be
 * private. Read-only, from the archive's structure; a request names a VM and a version, never a key or a path on the
 * server, and the `path` and `q` of a listing are only compared with what the archive holds.
 */
export function registerAdminArchiveRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
  inspection: ArchiveInspection,
): void {
  const { pool, session, cookie, publicOrigin } = dependencies;

  void parent.register(
    async (api) => {
      api.addHook('onRequest', requireSameOrigin(publicOrigin));
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', requireSession({ pool, session, cookie }));
      api.addHook('onRequest', requireAdmin);

      api.get(
        '/vms/:emulatorType/:vmName/versions/:versionId/archive',
        { schema: { params: versionPathParamsSchema } },
        async (request): Promise<ArchiveSummary> => {
          const { versionId, ...vm } = request.params as VmIdentity & { versionId: string };
          return inspection.summary(vm, versionId);
        },
      );

      api.get(
        '/vms/:emulatorType/:vmName/versions/:versionId/archive/entries',
        { schema: { params: versionPathParamsSchema, querystring: archiveListingQuerySchema } },
        async (request): Promise<ArchiveListingResponse> => {
          const { versionId, ...vm } = request.params as VmIdentity & { versionId: string };
          return inspection.list(vm, versionId, request.query as ArchiveListingQuery);
        },
      );
    },
    { prefix: '/admin' },
  );
}
