import {
  AGENT_REPOSITORY_RELAY_PATH,
  CHUNK_SHA256_HEADER,
  downloadInitRequestSchema,
  objectKeyRequestSchema,
  publishRequestSchema,
  relayVerifyRequestSchema,
  uploadInitRequestSchema,
  type ChunkAck,
  type FreeSpaceResponse,
  type ObjectKeyRequest,
  type ObjectStatResponse,
  type PublishRequest,
  type RelayHealthResponse,
  type RelayInfoResponse,
  type RelayVerifyRequest,
  type RelayVerifyStatus,
  type TransferStatus,
  type UploadInitRequest,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { AgentAuthenticator } from '../auth/agent-auth.js';
import { agentHttpGuard, agentIdOf } from '../auth/agent-http.js';
import { noStore } from '../auth/guards.js';
import type { TransferService } from '../transfers/service.js';

const repositoryParams = z.object({ repositoryId: z.uuid() });
const transferParams = repositoryParams.extend({ transferId: z.uuid() });
const chunkParams = transferParams.extend({ index: z.coerce.number().int().nonnegative() });

/**
 * The HTTPS relay (decision 0055), for an agent that cannot reach a repository over SFTP itself. Only the agent's
 * bearer credential gets in; everything an agent may name is checked against its own operations and the catalog
 * (`RelayAuthorization`). There is no unauthenticated route, no listing, and no way to name a server path.
 */
export function registerAgentRepositoryRelayRoutes(
  parent: FastifyInstance,
  transfers: TransferService,
  authenticate: AgentAuthenticator,
  chunkBytes: number,
): void {
  void parent.register(
    async (api) => {
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', agentHttpGuard(authenticate));
      // Chunks are streamed to the handler, which bounds them itself.
      api.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
        done(null, payload);
      });

      const ids = (params: unknown) => params as z.infer<typeof transferParams>;
      const repository = (params: unknown) =>
        (params as z.infer<typeof repositoryParams>).repositoryId;

      api.get(
        '/:repositoryId/relay',
        { schema: { params: repositoryParams } },
        async (request): Promise<RelayInfoResponse> =>
          transfers.info(agentIdOf(request), repository(request.params)),
      );

      api.post(
        '/:repositoryId/stat',
        { schema: { params: repositoryParams, body: objectKeyRequestSchema } },
        async (request): Promise<ObjectStatResponse> =>
          transfers.statObject(
            agentIdOf(request),
            repository(request.params),
            (request.body as ObjectKeyRequest).key,
          ),
      );

      api.get(
        '/:repositoryId/free-space',
        { schema: { params: repositoryParams } },
        async (request): Promise<FreeSpaceResponse> =>
          transfers.freeSpace(agentIdOf(request), repository(request.params)),
      );

      api.post(
        '/:repositoryId/health',
        { schema: { params: repositoryParams } },
        async (request): Promise<RelayHealthResponse> =>
          transfers.health(agentIdOf(request), repository(request.params)),
      );

      api.post(
        '/:repositoryId/verify',
        { schema: { params: repositoryParams, body: relayVerifyRequestSchema } },
        async (request): Promise<RelayVerifyStatus> =>
          transfers.verify(
            agentIdOf(request),
            repository(request.params),
            request.body as RelayVerifyRequest,
          ),
      );

      api.post(
        '/:repositoryId/publish',
        { schema: { params: repositoryParams, body: publishRequestSchema } },
        async (request, reply) => {
          const { stagingKey, finalKey } = request.body as PublishRequest;
          await transfers.publish(
            agentIdOf(request),
            repository(request.params),
            stagingKey,
            finalKey,
          );
          reply.status(204);
        },
      );

      api.post(
        '/:repositoryId/delete',
        { schema: { params: repositoryParams, body: objectKeyRequestSchema } },
        async (request, reply) => {
          await transfers.remove(
            agentIdOf(request),
            repository(request.params),
            (request.body as ObjectKeyRequest).key,
          );
          reply.status(204);
        },
      );

      api.post(
        '/:repositoryId/uploads',
        { schema: { params: repositoryParams, body: uploadInitRequestSchema } },
        async (request): Promise<TransferStatus> =>
          transfers.startUpload(
            agentIdOf(request),
            repository(request.params),
            request.body as UploadInitRequest,
          ),
      );

      api.get(
        '/:repositoryId/uploads/:transferId',
        { schema: { params: transferParams } },
        async (request): Promise<TransferStatus> => {
          const { repositoryId, transferId } = ids(request.params);
          return transfers.uploadStatus(agentIdOf(request), repositoryId, transferId);
        },
      );

      api.put(
        '/:repositoryId/uploads/:transferId/chunks/:index',
        // The body is read by the handler, bounded to one chunk; this only refuses an oversized declaration early.
        { schema: { params: chunkParams }, bodyLimit: chunkBytes + 1 },
        async (request): Promise<ChunkAck> => {
          const { repositoryId, transferId, index } = request.params as z.infer<typeof chunkParams>;
          const header = request.headers[CHUNK_SHA256_HEADER];
          const length = request.headers['content-length'];
          return transfers.putChunk(
            agentIdOf(request),
            repositoryId,
            transferId,
            index,
            typeof header === 'string' ? header.toLowerCase() : undefined,
            length === undefined ? undefined : Number(length),
            request.body as Readable,
          );
        },
      );

      api.post(
        '/:repositoryId/uploads/:transferId/complete',
        { schema: { params: transferParams } },
        async (request): Promise<TransferStatus> => {
          const { repositoryId, transferId } = ids(request.params);
          return transfers.completeUpload(agentIdOf(request), repositoryId, transferId);
        },
      );

      api.delete(
        '/:repositoryId/uploads/:transferId',
        { schema: { params: transferParams } },
        async (request): Promise<TransferStatus> => {
          const { repositoryId, transferId } = ids(request.params);
          return transfers.cancelUpload(agentIdOf(request), repositoryId, transferId);
        },
      );

      api.post(
        '/:repositoryId/downloads',
        { schema: { params: repositoryParams, body: downloadInitRequestSchema } },
        async (request): Promise<TransferStatus> =>
          transfers.startDownload(
            agentIdOf(request),
            repository(request.params),
            (request.body as ObjectKeyRequest).key,
          ),
      );

      api.get(
        '/:repositoryId/downloads/:transferId',
        { schema: { params: transferParams } },
        async (request): Promise<TransferStatus> => {
          const { repositoryId, transferId } = ids(request.params);
          return transfers.downloadStatus(agentIdOf(request), repositoryId, transferId);
        },
      );

      api.get(
        '/:repositoryId/downloads/:transferId/content',
        { schema: { params: transferParams } },
        async (request, reply) => {
          const { repositoryId, transferId } = ids(request.params);
          const range = request.headers.range;
          const content = await transfers.openContent(
            agentIdOf(request),
            repositoryId,
            transferId,
            typeof range === 'string' ? range : undefined,
          );
          reply
            .header('content-type', 'application/octet-stream')
            .header('accept-ranges', 'bytes')
            .header('x-emucat-sha256', content.sha256)
            .header('x-emucat-size', String(content.sizeBytes))
            .header(
              'content-length',
              String(content.sizeBytes === 0 ? 0 : content.end - content.start + 1),
            );
          if (content.partial) {
            reply
              .status(206)
              .header(
                'content-range',
                `bytes ${content.start}-${content.end}/${content.sizeBytes}`,
              );
          }
          return reply.send(content.stream);
        },
      );
    },
    { prefix: AGENT_REPOSITORY_RELAY_PATH.replace(/^\/api\/v1/u, '') },
  );
}
