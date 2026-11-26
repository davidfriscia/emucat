import {
  archiveEntryQuerySchema,
  archiveListingQuerySchema,
  archivePreviewQuerySchema,
  versionPathParamsSchema,
  type ArchiveEntryDetails,
  type ArchiveEntryQuery,
  type ArchiveListingQuery,
  type ArchiveListingResponse,
  type ArchivePreviewQuery,
  type ArchiveSummary,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { noStore, requireAdmin, requireSameOrigin, requireSession } from '../auth/guards.js';
import type { ArchiveExplorer } from '../archives/explorer.js';
import type { ArchiveInspection } from '../archives/inspection.js';
import { ApiError } from '../errors.js';
import type { BrowserDependencies } from './browser.js';

/**
 * View Archive Contents (decision 0055) and Archive Explorer (decision 0056). Administrators only: a listing names
 * every file of a VM, and a preview shows one, which may be private. Read-only, through the archive's own index: a
 * request names a VM, a version, a view and a path exactly as a listing returned it, never a key, an offset or a path
 * on the server. Every request checks the session, the administrator role and the version's identity itself.
 */

/** Aborts when the browser goes away before the response is complete. */
function requestSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}

/**
 * File contents never belong to this origin's pages: whatever a response holds, opened directly it is inert. Nothing
 * runs (a sandboxed document with no sources), nothing is sniffed, nothing is cached, and nothing loads it cross-site.
 */
function inertContent(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-security-policy', "default-src 'none'; sandbox");
  reply.header('cross-origin-resource-policy', 'same-origin');
  reply.header('x-frame-options', 'DENY');
}

/** File contents are requested by this application only, never by another site, even with a plain GET. */
async function requireSameSiteFetch(request: FastifyRequest): Promise<void> {
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    throw new ApiError(403, 'cross_origin_rejected', 'Cross-origin request rejected');
  }
}

/** `filename` with ASCII only and `filename*` with the real name, both without anything a header could misread. */
export function contentDisposition(name: string): string {
  const cleaned =
    name
      .replace(/[\p{Cc}\p{Cf}"\\/:*?<>|;]/gu, '_')
      .replace(/^[\s.]+|[\s.]+$/gu, '')
      .slice(0, 200) || 'download';
  const ascii = cleaned.replace(/[^\x20-\x7e]/gu, '_').replace(/%/gu, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(cleaned)}`;
}

export function registerAdminArchiveRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
  inspection: ArchiveInspection,
  explorer: ArchiveExplorer,
): void {
  const { pool, session, cookie, publicOrigin } = dependencies;
  const base = '/vms/:emulatorType/:vmName/versions/:versionId/archive';
  const identity = (request: FastifyRequest) => {
    const { versionId, ...vm } = request.params as VmIdentity & { versionId: string };
    return { vm, versionId };
  };

  void parent.register(
    async (api) => {
      api.addHook('onRequest', requireSameOrigin(publicOrigin));
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', requireSession({ pool, session, cookie }));
      api.addHook('onRequest', requireAdmin);

      api.get(
        base,
        { schema: { params: versionPathParamsSchema } },
        async (request, reply): Promise<ArchiveSummary> => {
          const { vm, versionId } = identity(request);
          return inspection.summary(vm, versionId, requestSignal(reply));
        },
      );

      api.get(
        `${base}/entries`,
        { schema: { params: versionPathParamsSchema, querystring: archiveListingQuerySchema } },
        async (request, reply): Promise<ArchiveListingResponse> => {
          const { vm, versionId } = identity(request);
          return inspection.list(
            vm,
            versionId,
            request.query as ArchiveListingQuery,
            requestSignal(reply),
          );
        },
      );

      api.get(
        `${base}/entry`,
        {
          schema: { params: versionPathParamsSchema, querystring: archiveEntryQuerySchema },
          onRequest: requireSameSiteFetch,
        },
        async (request, reply): Promise<ArchiveEntryDetails> => {
          const { vm, versionId } = identity(request);
          return explorer.details(
            vm,
            versionId,
            request.query as ArchiveEntryQuery,
            requestSignal(reply),
          );
        },
      );

      api.get(
        `${base}/entry/preview`,
        {
          schema: { params: versionPathParamsSchema, querystring: archivePreviewQuerySchema },
          onRequest: requireSameSiteFetch,
        },
        async (request, reply) => {
          const { vm, versionId } = identity(request);
          const query = request.query as ArchivePreviewQuery;
          const preview = await explorer.preview(vm, versionId, query, requestSignal(reply));
          inertContent(reply);
          reply.header('content-disposition', contentDisposition(`preview-${query.kind}`));
          for (const [name, value] of Object.entries(preview.headers)) reply.header(name, value);
          return reply.type(preview.contentType).send(preview.body);
        },
      );

      api.get(
        `${base}/entry/download`,
        {
          schema: { params: versionPathParamsSchema, querystring: archiveEntryQuerySchema },
          onRequest: requireSameSiteFetch,
        },
        async (request, reply) => {
          const { vm, versionId } = identity(request);
          const download = await explorer.download(
            vm,
            versionId,
            request.query as ArchiveEntryQuery,
            requestSignal(reply),
          );
          inertContent(reply);
          reply.header('content-disposition', contentDisposition(download.fileName));
          reply.header('content-length', String(download.sizeBytes));
          return reply.type('application/octet-stream').send(download.stream);
        },
      );
    },
    { prefix: '/admin' },
  );
}
