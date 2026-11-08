import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import {
  deploymentStatusSchema,
  updateLogResponseSchema,
  updateOperationSchema,
  type CommitId,
  type DeploymentStatus,
  type UpdateLogResponse,
  type UpdateOperation,
} from '@emucat/contracts';
import { z } from 'zod';

/**
 * The API's only way to affect a deployment: a fixed set of requests to the local deployment service,
 * over its Unix socket, with a bearer token. There is no method that takes a command, a repository, a
 * branch or a path. The service decides everything else from its own host configuration.
 */
export interface DeploymentClient {
  status(): Promise<DeploymentStatus>;
  /** Fetches the configured branch and reports what it found. Can take a while. */
  check(): Promise<DeploymentStatus>;
  start(request: { expectedCommit: CommitId; requestedBy: string }): Promise<UpdateOperation>;
  /** `null` if the service has no such operation. */
  operation(operationId: string): Promise<UpdateOperation | null>;
  log(operationId: string): Promise<UpdateLogResponse | null>;
}

export class DeploymentServiceError extends Error {
  override readonly name = 'DeploymentServiceError';

  constructor(
    /** `unavailable`: no usable answer. `rejected`: the service answered and said no. */
    readonly kind: 'unavailable' | 'rejected',
    readonly code: string,
    message: string,
    readonly statusCode = 503,
  ) {
    super(message);
  }
}

export interface SocketClientOptions {
  socketPath: string;
  tokenFile: string;
  /** For ordinary requests. */
  timeoutMs?: number;
  /** For a repository check, which fetches from the Git remote. */
  checkTimeoutMs?: number;
}

const errorEnvelope = z.object({
  error: z.object({ code: z.string().max(64), message: z.string().max(1000) }),
});

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface RawResponse {
  status: number;
  body: unknown;
}

function exchange(
  socketPath: string,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  payload: unknown,
  timeoutMs: number,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const request = httpRequest(
      {
        socketPath,
        method,
        path,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
            : {}),
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('Deployment service response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
            });
          } catch {
            reject(new Error('Deployment service returned something other than JSON'));
          }
        });
        response.on('error', reject);
      },
    );
    request.on('timeout', () => request.destroy(new Error('Deployment service timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

export function socketDeploymentClient(options: SocketClientOptions): DeploymentClient {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const checkTimeoutMs = options.checkTimeoutMs ?? 120_000;

  const call = async <T>(
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T>,
    { payload, timeout = timeoutMs, notFound = false } = {} as {
      payload?: unknown;
      timeout?: number;
      notFound?: boolean;
    },
  ): Promise<T | null> => {
    let token: string;
    try {
      token = (await readFile(options.tokenFile, 'utf8')).trim();
    } catch {
      throw new DeploymentServiceError(
        'unavailable',
        'deployment_service_unavailable',
        'The deployment service token cannot be read',
      );
    }
    let response: RawResponse;
    try {
      response = await exchange(options.socketPath, token, method, path, payload, timeout);
    } catch {
      throw new DeploymentServiceError(
        'unavailable',
        'deployment_service_unavailable',
        'The deployment service is not reachable',
      );
    }
    if (response.status >= 200 && response.status < 300) {
      const parsed = schema.safeParse(response.body);
      if (!parsed.success) {
        throw new DeploymentServiceError(
          'unavailable',
          'deployment_service_unavailable',
          'The deployment service gave an unexpected answer',
        );
      }
      return parsed.data;
    }
    if (response.status === 404 && notFound) return null;
    const failure = errorEnvelope.safeParse(response.body);
    // A rejected token is a host misconfiguration, not something an administrator can fix in the browser.
    if (response.status === 401 || !failure.success) {
      throw new DeploymentServiceError(
        'unavailable',
        'deployment_service_unavailable',
        'The deployment service refused the API',
      );
    }
    throw new DeploymentServiceError(
      'rejected',
      failure.data.error.code,
      failure.data.error.message,
      response.status === 404 ? 404 : 409,
    );
  };

  const required = <T>(value: T | null): T => {
    if (value === null) throw new Error('unreachable');
    return value;
  };

  return {
    status: async () => required(await call('GET', '/v1/status', deploymentStatusSchema)),
    check: async () =>
      required(
        await call('POST', '/v1/check', deploymentStatusSchema, {
          payload: {},
          timeout: checkTimeoutMs,
        }),
      ),
    start: async ({ expectedCommit, requestedBy }) =>
      required(
        await call('POST', '/v1/updates', updateOperationSchema, {
          payload: { expectedCommit, requestedBy },
        }),
      ),
    operation: (operationId) =>
      call('GET', `/v1/operations/${encodeURIComponent(operationId)}`, updateOperationSchema, {
        notFound: true,
      }),
    log: (operationId) =>
      call(
        'GET',
        `/v1/operations/${encodeURIComponent(operationId)}/log`,
        updateLogResponseSchema,
        {
          notFound: true,
        },
      ),
  };
}
