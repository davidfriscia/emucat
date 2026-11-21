import {
  isFilesystemEmulatorType,
  isWatchedMediaPath,
  MEDIA_CAPTURED_AT_HEADER,
  MEDIA_SOURCE_PATH_HEADER,
  mediaAcknowledgementRequestSchema,
  sha256HexSchema,
  vmPathParamsSchema,
  type AgentMediaVmListResponse,
  type MediaAcknowledgementResponse,
  type MediaUploadResponse,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { AgentAuthenticator } from '../auth/agent-auth.js';
import { agentHttpGuard, agentIdOf } from '../auth/agent-http.js';
import { noStore } from '../auth/guards.js';
import { ApiError } from '../errors.js';
import {
  acknowledgedHashes,
  agentMediaVms,
  requireAgentVm,
  requireCaptureUpload,
  storeUpload,
  UploadGate,
} from '../media/uploads.js';
import type { BrowserDependencies } from './browser.js';

const uploadParams = vmPathParamsSchema.extend({ sha256: sha256HexSchema });

const MAX_SOURCE_PATH_BYTES = 255;
const BUSY_RETRY_SECONDS = 5;

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The path is stored as a label for an administrator, and is never used as a path. It still has to look
 * like what an agent can really have found: this VM's watched locations, and nothing else.
 */
/**
 * A VirtualBox VM has no screenshots directory (decision 0045): its only screenshots are captures, whose label is
 * exactly `captureLabel`. A filesystem VM's path must be one the agent watches.
 */
function parseSourcePath(
  request: FastifyRequest,
  vm: VmIdentity,
  captureLabel: string | null = null,
): string {
  const invalid = () =>
    new ApiError(400, 'invalid_source_path', 'The source path is missing or not acceptable');
  const raw = header(request, MEDIA_SOURCE_PATH_HEADER);
  if (raw === undefined) throw invalid();
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    throw invalid();
  }
  if (
    Buffer.byteLength(path, 'utf8') > MAX_SOURCE_PATH_BYTES ||
    /\p{Cc}/u.test(path) ||
    !(isFilesystemEmulatorType(vm.emulatorType)
      ? isWatchedMediaPath(vm.emulatorType, path)
      : captureLabel !== null && path === captureLabel)
  ) {
    throw invalid();
  }
  return path.replaceAll('\\', '/');
}

function parseCapturedAt(request: FastifyRequest): Date | null {
  const raw = header(request, MEDIA_CAPTURED_AT_HEADER);
  if (raw === undefined) return null;
  const parsed = z.iso.datetime({ offset: true }).safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'invalid_captured_at', 'Not an RFC 3339 time');
  const date = new Date(parsed.data);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * How screenshots reach the server. The agent's bearer credential is the only way in: a browser session
 * means nothing here, and the identity comes from the credential and never from the request. Every route
 * authenticates before reading a byte of the body, and the upload route also refuses what is too large
 * or not this agent's before reading it.
 */
export function registerAgentMediaRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
  authenticate: AgentAuthenticator,
): void {
  const { pool, storage, media: policy } = dependencies;
  const gate = new UploadGate(policy.maxConcurrentUploads);

  void parent.register(
    async (api) => {
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', agentHttpGuard(authenticate));
      // The body is a stream here. It is measured and hashed as it is written, not parsed.
      api.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
        done(null, payload);
      });

      api.get('/vms', async (request): Promise<AgentMediaVmListResponse> => {
        return {
          vms: await agentMediaVms(pool, agentIdOf(request)),
          maxUploadBytes: policy.maxUploadBytes,
        };
      });

      api.post(
        '/vms/:emulatorType/:vmName/acknowledgements',
        { schema: { params: vmPathParamsSchema, body: mediaAcknowledgementRequestSchema } },
        async (request): Promise<MediaAcknowledgementResponse> => {
          const vm = request.params as VmIdentity;
          await requireAgentVm(pool, agentIdOf(request), vm);
          const { sha256 } = request.body as z.infer<typeof mediaAcknowledgementRequestSchema>;
          return { acknowledged: await acknowledgedHashes(pool, vm, sha256) };
        },
      );

      api.put(
        '/vms/:emulatorType/:vmName/screenshots/:sha256',
        {
          schema: { params: uploadParams },
          // A refusal must not make a client sit sending bytes nobody will read.
          preValidation: async (_request, reply) => {
            reply.header('connection', 'close');
          },
        },
        async (request, reply): Promise<MediaUploadResponse> => {
          const { sha256: declaredSha256, ...vm } = request.params as z.infer<typeof uploadParams>;
          const agentId = agentIdOf(request);
          const started = Date.now();
          const context = { agentId, emulatorType: vm.emulatorType, vmName: vm.vmName };

          const declaredLength = Number(request.headers['content-length']);
          if (Number.isFinite(declaredLength) && declaredLength > policy.maxUploadBytes) {
            throw new ApiError(413, 'upload_too_large', 'The upload is over the size limit');
          }
          const captureHeader = header(request, 'x-emucat-capture-id');
          const captureId = captureHeader === undefined ? undefined : z.uuid().parse(captureHeader);
          if (captureId) await requireCaptureUpload(pool, agentId, vm, captureId, declaredSha256);
          else await requireAgentVm(pool, agentId, vm);
          // QEMU's capture is a PPM from QMP, VirtualBox's a PNG from VBoxManage (decision 0046).
          const captureExtension = vm.emulatorType === 'virtualbox' ? 'png' : 'ppm';
          const captureLabel = captureId ? `emucat-capture-${captureId}.${captureExtension}` : null;
          const sourcePath = parseSourcePath(request, vm, captureLabel);
          if (captureId && sourcePath !== captureLabel)
            throw new ApiError(
              400,
              'invalid_source_path',
              'Capture source label does not match its operation',
            );
          const capturedAt = parseCapturedAt(request);
          if (typeof (request.body as Readable | undefined)?.pipe !== 'function') {
            throw new ApiError(415, 'unsupported_media_type', 'Send application/octet-stream');
          }

          if (!gate.tryEnter()) {
            reply.header('retry-after', String(BUSY_RETRY_SECONDS));
            throw new ApiError(503, 'media_busy', 'Too many uploads are running');
          }
          try {
            const outcome = await storeUpload(pool, storage, policy, {
              agentId,
              vm,
              declaredSha256,
              sourcePath,
              capturedAt,
              ...(captureId ? { captureId } : {}),
              body: request.body as Readable,
            });
            request.log.info(
              {
                ...context,
                mediaId: outcome.mediaId,
                result: outcome.created
                  ? 'created'
                  : outcome.suppressed
                    ? 'suppressed'
                    : 'duplicate',
                bytes: outcome.sizeBytes,
                durationMs: Date.now() - started,
              },
              'Screenshot received',
            );
            reply.status(outcome.created ? 201 : 200);
            return {
              mediaId: outcome.mediaId,
              sha256: outcome.sha256,
              created: outcome.created,
              ...(outcome.suppressed ? { suppressed: true } : {}),
            };
          } catch (error) {
            const code = error instanceof ApiError ? error.code : 'internal_error';
            const level = error instanceof ApiError && error.statusCode < 500 ? 'warn' : 'error';
            request.log[level](
              { ...context, result: code, err: error, durationMs: Date.now() - started },
              'Screenshot refused',
            );
            throw error;
          } finally {
            gate.leave();
          }
        },
      );
    },
    { prefix: '/agent/media' },
  );
}
