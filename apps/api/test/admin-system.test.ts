import {
  applicationUpdatesResponseSchema,
  errorResponseSchema,
  systemVersionResponseSchema,
  updateOperationSchema,
  type DeploymentStatus,
  type UpdateOperation,
} from '@emucat/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeploymentServiceError, type DeploymentClient } from '../src/deployment/client.js';
import {
  ADMIN_PASSWORD,
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from './browser-app.js';

const CURRENT = 'a'.repeat(40);
const LATEST = 'b'.repeat(40);
const OPERATION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7101';
const BUILD = { version: '0.1.0', commit: CURRENT, builtAt: '2026-11-01T09:00:00.000Z' };

function deploymentStatus(overrides: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    environment: 'test',
    branch: 'develop',
    updatesEnabled: true,
    current: { commit: CURRENT, deployedAt: '2026-11-01T10:00:00.000Z', operationId: null },
    latest: {
      commit: LATEST,
      subject: 'Next change',
      committedAt: null,
      checkedAt: '2026-11-01T11:00:00.000Z',
    },
    updateAvailable: true,
    activeOperation: null,
    lastOperation: null,
    lastSuccess: null,
    lastFailure: null,
    ...overrides,
  };
}

function operation(overrides: Partial<UpdateOperation> = {}): UpdateOperation {
  return {
    id: OPERATION_ID,
    status: 'running',
    stage: 'queued',
    stages: [],
    fromCommit: CURRENT,
    targetCommit: null,
    requestedBy: 'admin',
    requestedAt: '2026-11-01T11:00:00.000Z',
    finishedAt: null,
    outcome: null,
    error: null,
    rollback: null,
    backup: null,
    ...overrides,
  };
}

/** Stands in for the socket client, recording exactly what the API asks the service for. */
class FakeDeploymentClient implements DeploymentClient {
  calls: { method: string; args: unknown[] }[] = [];
  failWith: DeploymentServiceError | null = null;

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
    if (this.failWith) throw this.failWith;
  }

  async status() {
    this.record('status');
    return deploymentStatus();
  }
  async check() {
    this.record('check');
    return deploymentStatus();
  }
  async start(request: { expectedCommit: string; requestedBy: string }) {
    this.record('start', request);
    return operation();
  }
  async operation(id: string) {
    this.record('operation', id);
    return id === OPERATION_ID ? operation() : null;
  }
  async log(id: string) {
    this.record('log', id);
    return id === OPERATION_ID
      ? { operationId: id, lines: ['==> building'], truncated: false }
      : null;
  }
}

const fake = new FakeDeploymentClient();
let context: BrowserTestContext;
let unconfigured: BrowserTestContext;
let admin: TestClient;
let regularUser: TestClient;

beforeAll(async () => {
  context = await startBrowserApp({
    deployment: { client: fake, environment: 'test', build: BUILD },
  });
  unconfigured = await startBrowserApp();
  admin = await signedInAdmin(context);
  await context.pool.execute(
    `INSERT INTO users (id, username, display_name, password_hash, role)
     VALUES (UUID(), 'regular', 'Regular', ?, 'user')`,
    [await context.dependencies.passwords.hash(ADMIN_PASSWORD)],
  );
  regularUser = new TestClient(context.app);
  expect((await regularUser.login('regular', ADMIN_PASSWORD)).statusCode).toBe(200);
});

afterAll(async () => {
  await context?.close();
  await unconfigured?.close();
});

const ROUTES: [string, string, object?][] = [
  ['GET', '/admin/system/version'],
  ['GET', '/admin/system/updates'],
  ['POST', '/admin/system/updates/check'],
  ['POST', '/admin/system/updates', { expectedCommit: LATEST }],
  ['GET', `/admin/system/updates/${OPERATION_ID}`],
  ['GET', `/admin/system/updates/${OPERATION_ID}/log`],
];

describe('authorization', () => {
  it.each(ROUTES)('%s %s is denied to anonymous clients', async (method, url, payload) => {
    fake.calls = [];
    const response = await new TestClient(context.app).request({
      method: method as 'GET',
      url,
      ...(payload ? { payload } : {}),
    });
    expect(response.statusCode).toBe(401);
    expect(fake.calls).toEqual([]);
  });

  it.each(ROUTES)('%s %s is denied to non-administrators', async (method, url, payload) => {
    fake.calls = [];
    const response = await regularUser.request({
      method: method as 'GET',
      url,
      ...(payload ? { payload } : {}),
    });
    expect(response.statusCode).toBe(403);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('forbidden');
    expect(fake.calls).toEqual([]);
  });

  it('requires the CSRF token to start an update', async () => {
    fake.calls = [];
    const response = await admin.request({
      method: 'POST',
      url: '/admin/system/updates',
      payload: { expectedCommit: LATEST },
      csrf: false,
    });
    expect(response.statusCode).toBe(403);
    expect(fake.calls).toEqual([]);
  });

  it('refuses a cross-origin request', async () => {
    fake.calls = [];
    const response = await admin.request({
      method: 'POST',
      url: '/admin/system/updates',
      payload: { expectedCommit: LATEST },
      headers: { origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(fake.calls).toEqual([]);
  });
});

describe('what the browser can ask for', () => {
  it.each([
    ['a branch', { expectedCommit: LATEST, branch: 'main' }],
    ['a ref', { expectedCommit: 'refs/heads/main' }],
    ['a short commit', { expectedCommit: LATEST.slice(0, 12) }],
    ['a command', { expectedCommit: LATEST, command: 'rm -rf /' }],
    ['a repository', { expectedCommit: LATEST, repositoryUrl: 'https://evil.example/x.git' }],
    ['nothing', {}],
  ])('rejects %s', async (_label, payload) => {
    fake.calls = [];
    const response = await admin.request({ method: 'POST', url: '/admin/system/updates', payload });
    expect(response.statusCode).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it('starts an update with the commit shown and the administrator’s name only', async () => {
    fake.calls = [];
    const response = await admin.request({
      method: 'POST',
      url: '/admin/system/updates',
      payload: { expectedCommit: LATEST },
    });
    expect(response.statusCode).toBe(202);
    expect(updateOperationSchema.parse(response.json()).id).toBe(OPERATION_ID);
    expect(fake.calls).toEqual([
      { method: 'start', args: [{ expectedCommit: LATEST, requestedBy: 'admin' }] },
    ]);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects an operation ID that is not a UUID before asking the service', async () => {
    fake.calls = [];
    const response = await admin.get('/admin/system/updates/..%2F..%2Fetc%2Fpasswd');
    expect(response.statusCode).toBe(400);
    expect(fake.calls).toEqual([]);
  });
});

describe('status and version', () => {
  it('reports the deployment, the build and the service', async () => {
    const response = await admin.get('/admin/system/updates');
    expect(response.statusCode).toBe(200);
    const body = applicationUpdatesResponseSchema.parse(response.json());
    expect(body.service).toBe('connected');
    expect(body.build).toEqual(BUILD);
    expect(body.deployment?.latest?.commit).toBe(LATEST);
  });

  it('reports the deployed commit from deployment metadata', async () => {
    const response = await admin.get('/admin/system/version');
    const body = systemVersionResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      environment: 'test',
      applicationVersion: '0.1.0',
      buildCommit: CURRENT,
      deployedCommit: CURRENT,
      deploymentStatus: 'deployed',
      service: 'connected',
    });
    // Nothing from the process environment leaks into it.
    expect(JSON.stringify(body)).not.toMatch(/password|DB_|token/i);
  });

  it('forwards operation progress and the sanitized log', async () => {
    expect((await admin.get(`/admin/system/updates/${OPERATION_ID}`)).statusCode).toBe(200);
    const log = await admin.get(`/admin/system/updates/${OPERATION_ID}/log`);
    expect(log.json()).toEqual({
      operationId: OPERATION_ID,
      lines: ['==> building'],
      truncated: false,
    });
    const unknown = await admin.get('/admin/system/updates/018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7199');
    expect(unknown.statusCode).toBe(404);
  });

  it('says when the deployment service is down, instead of failing', async () => {
    fake.failWith = new DeploymentServiceError(
      'unavailable',
      'deployment_service_unavailable',
      'The deployment service is not reachable',
    );
    try {
      const status = applicationUpdatesResponseSchema.parse(
        (await admin.get('/admin/system/updates')).json(),
      );
      expect(status).toMatchObject({ service: 'unavailable', deployment: null });
      const version = systemVersionResponseSchema.parse(
        (await admin.get('/admin/system/version')).json(),
      );
      expect(version).toMatchObject({ deployedCommit: null, deploymentStatus: 'unknown' });
      const start = await admin.request({
        method: 'POST',
        url: '/admin/system/updates',
        payload: { expectedCommit: LATEST },
      });
      expect(start.statusCode).toBe(503);
      expect(start.json().error.code).toBe('deployment_service_unavailable');
    } finally {
      fake.failWith = null;
    }
  });

  it('passes on a refusal such as updates being disabled', async () => {
    fake.failWith = new DeploymentServiceError(
      'rejected',
      'updates_disabled',
      'Application updates from the browser are disabled on this server',
      409,
    );
    try {
      const response = await admin.request({
        method: 'POST',
        url: '/admin/system/updates',
        payload: { expectedCommit: LATEST },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('updates_disabled');
    } finally {
      fake.failWith = null;
    }
  });

  it('reports a server without a deployment service as not configured', async () => {
    const other = await signedInAdmin(unconfigured);
    const status = applicationUpdatesResponseSchema.parse(
      (await other.get('/admin/system/updates')).json(),
    );
    expect(status).toMatchObject({ service: 'not_configured', deployment: null });
    expect(status.build.commit).toBeNull();
    const start = await other.request({
      method: 'POST',
      url: '/admin/system/updates',
      payload: { expectedCommit: LATEST },
    });
    expect(start.statusCode).toBe(503);
    expect(start.json().error.code).toBe('deployment_service_not_configured');
  });
});
