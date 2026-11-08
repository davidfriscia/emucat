import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { DeploymentService, ServiceError } from './service.ts';

/**
 * The control channel, served on a Unix socket only. Every request needs the bearer token. The routes are
 * a fixed allowlist: there is no way to name a command, script, repository, branch or file.
 */

const MAX_BODY_BYTES = 4096;
const OPERATION_PATH = /^\/v1\/operations\/([0-9a-f-]{36})(\/log)?$/;

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function fail(response: ServerResponse, status: number, code: string, message: string): void {
  send(response, status, { error: { code, message } });
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ServiceError(413, 'body_too_large', 'Request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ServiceError(400, 'invalid_request', 'Body must be JSON'));
      }
    });
    request.on('error', reject);
  });
}

const digest = (value: string) => createHash('sha256').update(value).digest();

export function tokenMatches(expected: string, header: string | undefined): boolean {
  if (expected.length < 32 || !header?.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(expected), digest(header.slice('Bearer '.length)));
}

export function createControlServer(
  service: DeploymentService,
  token: () => string,
  log: (message: string) => void = () => undefined,
): Server {
  return createServer((request, response) => {
    void (async () => {
      try {
        if (!tokenMatches(token(), request.headers.authorization)) {
          return fail(response, 401, 'unauthorized', 'Authentication required');
        }
        const path = new URL(request.url ?? '/', 'http://deployer').pathname;
        const method = request.method ?? 'GET';

        if (path === '/v1/status') {
          if (method !== 'GET') return fail(response, 405, 'method_not_allowed', 'Use GET');
          return send(response, 200, service.status());
        }
        if (path === '/v1/check') {
          if (method !== 'POST') return fail(response, 405, 'method_not_allowed', 'Use POST');
          await readBody(request);
          return send(response, 200, await service.check());
        }
        if (path === '/v1/updates') {
          if (method !== 'POST') return fail(response, 405, 'method_not_allowed', 'Use POST');
          const body = await readBody(request);
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            throw new ServiceError(400, 'invalid_request', 'Body must be an object');
          }
          const keys = Object.keys(body);
          if (keys.some((key) => key !== 'expectedCommit' && key !== 'requestedBy')) {
            throw new ServiceError(400, 'invalid_request', 'Unexpected field');
          }
          const fields = body as { expectedCommit?: unknown; requestedBy?: unknown };
          const operation = await service.start({
            expectedCommit: fields.expectedCommit,
            requestedBy: fields.requestedBy,
          });
          log(`Update ${operation.id} requested by ${operation.requestedBy}`);
          return send(response, 202, operation);
        }
        const match = OPERATION_PATH.exec(path);
        if (match) {
          if (method !== 'GET') return fail(response, 405, 'method_not_allowed', 'Use GET');
          const id = match[1] as string;
          const result = match[2] ? service.log(id) : service.operation(id);
          if (!result) return fail(response, 404, 'operation_not_found', 'No such operation');
          return send(response, 200, result);
        }
        return fail(response, 404, 'not_found', 'No such endpoint');
      } catch (error) {
        if (error instanceof ServiceError) {
          return fail(response, error.status, error.code, error.message);
        }
        log(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
        return fail(response, 500, 'internal_error', 'The deployment service failed');
      }
    })();
  });
}
