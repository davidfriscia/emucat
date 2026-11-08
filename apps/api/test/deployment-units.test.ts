import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DeploymentServiceError, socketDeploymentClient } from '../src/deployment/client.js';

const TOKEN = 'a-deployer-token-with-at-least-32-characters';
const COMMIT = 'a'.repeat(40);
const OPERATION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7001';

/** A Unix socket on Linux and macOS, a named pipe on Windows: what `socketPath` accepts on each. */
function socketPath(): string {
  const name = `emucat-deployer-test-${randomBytes(6).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

let directory: string;
let tokenFile: string;
let server: Server | undefined;
let reply: (request: IncomingMessage) => { status: number; body: unknown } = () => ({
  status: 200,
  body: {},
});
const seen: Seen[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'emucat-deployer-client-'));
  tokenFile = join(directory, 'token');
  await writeFile(tokenFile, `${TOKEN}\n`);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

afterEach(async () => {
  seen.length = 0;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function listen(): Promise<string> {
  const path = socketPath();
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      });
      const { status, body: payload } = reply(request);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server?.listen(path, resolve));
  return path;
}

function status(overrides: object = {}) {
  return {
    environment: 'test',
    branch: 'develop',
    updatesEnabled: true,
    current: { commit: COMMIT, deployedAt: '2026-11-01T10:00:00.000Z', operationId: null },
    latest: null,
    updateAvailable: null,
    activeOperation: null,
    lastOperation: null,
    lastSuccess: null,
    lastFailure: null,
    ...overrides,
  };
}

describe('deployment service client', () => {
  it('sends the bearer token and validates the answer', async () => {
    const path = await listen();
    reply = () => ({ status: 200, body: status() });
    const client = socketDeploymentClient({ socketPath: path, tokenFile });
    const result = await client.status();
    expect(result.current?.commit).toBe(COMMIT);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/v1/status' });
    expect(seen[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('starts an update with only the expected commit and the requester', async () => {
    const path = await listen();
    reply = () => ({
      status: 202,
      body: {
        id: OPERATION_ID,
        status: 'running',
        stage: 'queued',
        stages: [],
        fromCommit: COMMIT,
        targetCommit: null,
        requestedBy: 'admin',
        requestedAt: '2026-11-01T10:00:00.000Z',
        finishedAt: null,
        outcome: null,
        error: null,
        rollback: null,
        backup: null,
      },
    });
    const client = socketDeploymentClient({ socketPath: path, tokenFile });
    const operation = await client.start({ expectedCommit: COMMIT, requestedBy: 'admin' });
    expect(operation.id).toBe(OPERATION_ID);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/updates' });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      expectedCommit: COMMIT,
      requestedBy: 'admin',
    });
  });

  it('reports a refusal from the service with its code', async () => {
    const path = await listen();
    reply = () => ({
      status: 409,
      body: { error: { code: 'update_in_progress', message: 'An update is in progress' } },
    });
    const client = socketDeploymentClient({ socketPath: path, tokenFile });
    const failure = await client
      .start({ expectedCommit: COMMIT, requestedBy: 'admin' })
      .catch((e) => e);
    expect(failure).toBeInstanceOf(DeploymentServiceError);
    expect(failure).toMatchObject({
      kind: 'rejected',
      code: 'update_in_progress',
      statusCode: 409,
    });
  });

  it('treats a rejected token as the service being unavailable, not as the browser’s fault', async () => {
    const path = await listen();
    reply = () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'no' } } });
    const failure = await socketDeploymentClient({ socketPath: path, tokenFile })
      .status()
      .catch((e) => e);
    expect(failure).toMatchObject({ kind: 'unavailable', code: 'deployment_service_unavailable' });
  });

  it('refuses answers that do not match the contract', async () => {
    const path = await listen();
    reply = () => ({ status: 200, body: { environment: 'test', $where: 'injected' } });
    const failure = await socketDeploymentClient({ socketPath: path, tokenFile })
      .status()
      .catch((e) => e);
    expect(failure).toMatchObject({ kind: 'unavailable' });
    reply = () => ({ status: 200, body: 'not json' });
    expect(
      await socketDeploymentClient({ socketPath: path, tokenFile })
        .status()
        .catch((e) => e),
    ).toMatchObject({ kind: 'unavailable' });
  });

  it('reports an unreachable socket or a missing token as unavailable', async () => {
    const missing = socketDeploymentClient({ socketPath: socketPath(), tokenFile });
    expect(await missing.status().catch((e) => e)).toMatchObject({ kind: 'unavailable' });
    const path = await listen();
    const noToken = socketDeploymentClient({
      socketPath: path,
      tokenFile: join(directory, 'nope'),
    });
    expect(await noToken.status().catch((e) => e)).toMatchObject({ kind: 'unavailable' });
    expect(seen).toHaveLength(0);
  });

  it('gives up on a service that does not answer', async () => {
    const path = await listen();
    server?.removeAllListeners('request');
    server?.on('request', () => undefined);
    const client = socketDeploymentClient({ socketPath: path, tokenFile, timeoutMs: 200 });
    expect(await client.status().catch((e) => e)).toMatchObject({ kind: 'unavailable' });
    server?.closeAllConnections();
  });

  it('returns null for an unknown operation', async () => {
    const path = await listen();
    reply = () => ({
      status: 404,
      body: { error: { code: 'operation_not_found', message: 'No such operation' } },
    });
    const client = socketDeploymentClient({ socketPath: path, tokenFile });
    expect(await client.operation(OPERATION_ID)).toBeNull();
    expect(await client.log(OPERATION_ID)).toBeNull();
  });
});

describe('deployment configuration', () => {
  it('has no deployment service unless both settings are given', () => {
    expect(loadConfig({ DB_PASSWORD: 'x' }).deployer).toBeUndefined();
    expect(() => loadConfig({ DB_PASSWORD: 'x', DEPLOYER_SOCKET: '/run/x.sock' })).toThrow(
      /DEPLOYER_SOCKET and DEPLOYER_TOKEN_FILE/,
    );
    const config = loadConfig({
      DB_PASSWORD: 'x',
      DEPLOYER_SOCKET: '/run/emucat-deployer/deployer.sock',
      DEPLOYER_TOKEN_FILE: '/run/secrets/deployer_token',
    });
    expect(config.deployer).toEqual({
      socketPath: '/run/emucat-deployer/deployer.sock',
      tokenFile: '/run/secrets/deployer_token',
    });
  });

  it('reads the environment label and build metadata', () => {
    const config = loadConfig({
      DB_PASSWORD: 'x',
      EMUCAT_ENVIRONMENT: 'test',
      EMUCAT_BUILD_COMMIT: COMMIT,
      EMUCAT_BUILD_TIME: '2026-11-01T10:00:00Z',
    });
    expect(config.environment).toBe('test');
    expect(config.build).toEqual({ commit: COMMIT, builtAt: '2026-11-01T10:00:00Z' });
    expect(loadConfig({ DB_PASSWORD: 'x', EMUCAT_BUILD_COMMIT: '' }).build.commit).toBeUndefined();
    expect(() => loadConfig({ DB_PASSWORD: 'x', EMUCAT_BUILD_COMMIT: 'main' })).toThrow(
      /EMUCAT_BUILD_COMMIT/,
    );
    expect(() => loadConfig({ DB_PASSWORD: 'x', EMUCAT_ENVIRONMENT: 'Prod; rm' })).toThrow(
      /EMUCAT_ENVIRONMENT/,
    );
  });
});
