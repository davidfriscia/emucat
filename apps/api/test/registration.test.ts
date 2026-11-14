/**
 * Registration through the real API, on a real database, over a real WebSocket. The agent here is a
 * script, so that each thing a real agent could do, including lose a message or say something false,
 * can be arranged exactly. `e2e/registration.e2e.test.ts` runs the real agent and a real SFTP server.
 */
import { randomUUID } from 'node:crypto';
import {
  discoveryOperationSchema,
  registrationOperationSchema,
  repositorySummarySchema,
  type RegistrationOperation,
  type RepositorySummary,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GENEROUS_RATE_LIMITS,
  TestAgent,
  envelope,
  pairAgent,
  waitFor,
  wsUrl,
  type PairedAgent,
} from './agent-helpers.js';
import {
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from './browser-app.js';

const SHA = 'a'.repeat(64);
const MANIFEST_SHA = 'b'.repeat(64);

interface World {
  context: BrowserTestContext;
  admin: TestClient;
  agent: TestAgent;
  paired: PairedAgent;
  repository: RepositorySummary;
}

let worlds: BrowserTestContext[] = [];

afterEach(async () => {
  for (const context of worlds) await context.close();
  worlds = [];
});

async function connectAgent(app: FastifyInstance, credential: string): Promise<TestAgent> {
  const agent = await TestAgent.connect(wsUrl(app), credential);
  await agent.hello();
  await sync(agent, []);
  return agent;
}

/** Reports the agent's journals, and waits until the server has handled that. */
async function sync(
  agent: TestAgent,
  operations: { operationId: string; phase: string }[],
): Promise<void> {
  agent.send(envelope('agent.registration_sync', { operations }));
  await barrier(agent);
}

/** Messages are handled in order, so an answered heartbeat means that all earlier ones are done. */
async function barrier(agent: TestAgent): Promise<void> {
  agent.send(envelope('agent.heartbeat', {}));
  await agent.next('server.heartbeat_ack');
}

async function createRepository(
  admin: TestClient,
  overrides: object = {},
): Promise<RepositorySummary> {
  const response = await admin.request({
    method: 'POST',
    url: '/admin/repositories',
    payload: {
      name: 'NAS',
      host: 'nas.example',
      port: 22,
      username: 'emucat',
      remoteRoot: '/srv/emucat',
      ...overrides,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return repositorySummarySchema.parse(response.json());
}

async function associate(admin: TestClient, repositoryId: string, agentId: string): Promise<void> {
  const response = await admin.request({
    method: 'PUT',
    url: `/admin/repositories/${repositoryId}/agents/${agentId}`,
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function world(): Promise<World> {
  const context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
  worlds.push(context);
  await context.app.listen({ host: '127.0.0.1', port: 0 });
  const admin = await signedInAdmin(context);
  const paired = await pairAgent(context.app, admin);
  const agent = await connectAgent(context.app, paired.credential);
  const repository = await createRepository(admin);
  await associate(admin, repository.id, paired.agentId);
  return { context, admin, agent, paired, repository };
}

/** A real discovery, whose report this script supplies. */
async function discover(
  admin: TestClient,
  agent: TestAgent,
  agentId: string,
  vms: { emulatorType: string; vmName: string; markers: string[] }[],
): Promise<string> {
  const started = await admin.request({
    method: 'POST',
    url: `/admin/agents/${agentId}/discovery`,
  });
  expect(started.statusCode, started.body).toBe(202);
  const request = await agent.next('server.discovery_request');
  agent.send(
    envelope('agent.discovery_result', {
      operationId: request.payload.operationId,
      hostPlatform: 'windows',
      emulators: [{ emulatorType: 'qemu', status: 'ok', truncated: false }],
      vms: vms.map((vm) => ({ ...vm, hostCompatible: true })),
      skipped: [],
    }),
  );
  return waitFor(async () => {
    const state = await admin.get(`/admin/agents/${agentId}/discovery`);
    const operation = discoveryOperationSchema.parse(
      state.json<{ operation: unknown }>().operation,
    );
    return operation.status === 'completed' ? operation.id : undefined;
  }, 'the discovery to finish');
}

const WIN98 = { emulatorType: 'qemu', vmName: 'Win98', markers: ['run.bat'] };

function registerRequest(world: World, discoveryOperationId: string, overrides: object = {}) {
  return world.admin.request({
    method: 'POST',
    url: '/admin/registrations',
    payload: {
      agentId: world.paired.agentId,
      repositoryId: world.repository.id,
      emulatorType: 'qemu',
      vmName: 'Win98',
      mode: 'copy',
      discoveryOperationId,
      ...overrides,
    },
  });
}

async function register(world: World, overrides: object = {}): Promise<RegistrationOperation> {
  const discoveryId = await discover(world.admin, world.agent, world.paired.agentId, [WIN98]);
  const response = await registerRequest(world, discoveryId, overrides);
  expect(response.statusCode, response.body).toBe(202);
  return registrationOperationSchema.parse(response.json());
}

function resultFor(operation: RegistrationOperation, overrides: object = {}) {
  return {
    operationId: operation.id,
    versionId: operation.versionId,
    archiveKey: operation.archiveKey,
    archiveSizeBytes: 2048,
    archiveSha256: SHA,
    manifestVersion: 1,
    manifestSha256: MANIFEST_SHA,
    fileCount: 3,
    totalUncompressedBytes: 4096,
    ...overrides,
  };
}

async function read(world: World, operationId: string): Promise<RegistrationOperation> {
  const response = await world.admin.get(`/admin/registrations/${operationId}`);
  expect(response.statusCode, response.body).toBe(200);
  return registrationOperationSchema.parse(response.json());
}

async function versionsOf(context: BrowserTestContext, vmName: string) {
  const [rows] = await context.pool.execute<RowDataPacket[]>(
    'SELECT * FROM vm_versions WHERE vm_name = ?',
    [vmName],
  );
  return rows;
}

async function vmRow(context: BrowserTestContext, vmName: string) {
  const [rows] = await context.pool.execute<RowDataPacket[]>(
    'SELECT * FROM virtual_machines WHERE vm_name = ?',
    [vmName],
  );
  return rows[0];
}

async function vmState(context: BrowserTestContext, vmName: string) {
  const [rows] = await context.pool.execute<RowDataPacket[]>(
    'SELECT * FROM agent_vm_state WHERE vm_name = ?',
    [vmName],
  );
  return rows[0];
}

/** Takes an operation as far as a committed master. */
async function commitOperation(world: World, overrides: object = {}) {
  const operation = await register(world, overrides);
  await world.agent.next('server.registration_request');
  world.agent.send(envelope('agent.registration_result', resultFor(operation)));
  const ack = await world.agent.next('server.registration_ack');
  expect(ack.payload.outcome).toBe('committed');
  return { operation, ack };
}

describe('a copy', () => {
  it('commits one private master only after the agent reports a verified archive', async () => {
    const w = await world();
    const operation = await register(w);
    expect(operation.state).toBe('queued');
    expect(operation.archive).toBeNull();
    expect(operation.archiveKey).toBe(`archives/qemu/win98/${operation.versionId}.zip`);

    const request = await w.agent.next('server.registration_request');
    expect(request.payload).toEqual({
      operationId: operation.id,
      emulatorType: 'qemu',
      vmName: 'Win98',
      mode: 'copy',
      repositoryId: w.repository.id,
      versionId: operation.versionId,
      archiveKey: operation.archiveKey,
    });

    // Progress is stored as reported, and creates nothing.
    w.agent.send(
      envelope('agent.registration_progress', {
        operationId: operation.id,
        stage: 'uploading',
        doneBytes: 10,
        totalBytes: 100,
      }),
    );
    await barrier(w.agent);
    const uploading = await read(w, operation.id);
    expect(uploading.state).toBe('uploading');
    expect(uploading.progress).toEqual({ doneBytes: 10, totalBytes: 100 });
    expect(await vmRow(w.context, 'Win98')).toBeUndefined();
    expect((await w.admin.get('/admin/vms')).json<{ items: unknown[] }>().items).toEqual([]);

    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    const ack = await w.agent.next('server.registration_ack');
    expect(ack.payload).toMatchObject({
      outcome: 'committed',
      versionId: operation.versionId,
      removeLocal: false,
    });

    const vm = await vmRow(w.context, 'Win98');
    expect(vm?.visibility).toBe('private');
    expect(vm?.registered_by_user_id).not.toBeNull();
    expect(vm?.discovered_by_agent_id).toBe(w.paired.agentId);
    const versions = await versionsOf(w.context, 'Win98');
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: operation.versionId,
      kind: 'master',
      parent_version_id: null,
      snapshot_name: null,
      repository_id: w.repository.id,
      archive_key: operation.archiveKey,
      archive_sha256: SHA,
      created_by_agent_id: w.paired.agentId,
    });
    expect(await vmState(w.context, 'Win98')).toMatchObject({
      local_source_version_id: operation.versionId,
      execution_state: 'idle',
      content_status: 'verified',
    });

    // Private by default: nothing appears publicly.
    const publicCatalog = await w.context.app.inject({
      url: '/api/v1/catalog/vms',
      headers: { host: 'emucat.test' },
    });
    expect(publicCatalog.json<{ items: unknown[] }>().items).toEqual([]);

    const cleaning = await read(w, operation.id);
    expect(cleaning.state).toBe('cleaning_local');
    expect(cleaning.archive).toMatchObject({ sha256: SHA, verifiedBy: 'agent', fileCount: 3 });

    w.agent.send(
      envelope('agent.registration_cleanup', {
        operationId: operation.id,
        versionId: operation.versionId,
        localCopy: 'preserved',
        code: null,
        message: null,
      }),
    );
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
    const done = await read(w, operation.id);
    expect(done.state).toBe('succeeded');
    expect(done.localCopy).toBe('preserved');
    expect(done.finishedAt).not.toBeNull();

    // A private entry that the administration catalog shows, with its one version.
    const catalog = await w.admin.get('/admin/vms');
    expect(catalog.json<{ items: { vmName: string; visibility: string }[] }>().items).toMatchObject(
      [{ vmName: 'Win98', visibility: 'private' }],
    );
  });
});

describe('a transfer', () => {
  it('must be confirmed explicitly', async () => {
    const w = await world();
    const discoveryId = await discover(w.admin, w.agent, w.paired.agentId, [WIN98]);
    const unconfirmed = await registerRequest(w, discoveryId, { mode: 'transfer' });
    expect(unconfirmed.statusCode).toBe(400);
    const refused = await registerRequest(w, discoveryId, {
      mode: 'transfer',
      confirmDestructive: false,
    });
    expect(refused.statusCode).toBe(400);
    const accepted = await registerRequest(w, discoveryId, {
      mode: 'transfer',
      confirmDestructive: true,
    });
    expect(accepted.statusCode).toBe(202);
  });

  it('allows removal only after the commit, and records what happened', async () => {
    const w = await world();
    const { operation, ack } = await commitOperation(w, {
      mode: 'transfer',
      confirmDestructive: true,
    });
    expect(ack.payload).toMatchObject({ removeLocal: true, versionId: operation.versionId });

    w.agent.send(
      envelope('agent.registration_cleanup', {
        operationId: operation.id,
        versionId: operation.versionId,
        localCopy: 'removed',
        code: null,
        message: null,
      }),
    );
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
    const done = await read(w, operation.id);
    expect(done).toMatchObject({ state: 'succeeded', localCopy: 'removed' });
    expect(await vmState(w.context, 'Win98')).toMatchObject({
      execution_state: 'absent',
      local_source_version_id: null,
    });
    expect(await versionsOf(w.context, 'Win98')).toHaveLength(1);
  });

  it('keeps the master when local cleanup fails, and says how to recover', async () => {
    const w = await world();
    const { operation } = await commitOperation(w, { mode: 'transfer', confirmDestructive: true });
    w.agent.send(
      envelope('agent.registration_cleanup', {
        operationId: operation.id,
        versionId: operation.versionId,
        localCopy: 'cleanup_failed',
        code: 'cleanup_content_changed',
        message: 'disk.qcow2 differs from the archive',
      }),
    );
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
    const done = await read(w, operation.id);
    expect(done.state).toBe('partial_success');
    expect(done.localCopy).toBe('cleanup_failed');
    expect(done.error?.code).toBe('cleanup_content_changed');
    expect(done.recovery).toMatch(/registered and safe/);
    expect(await versionsOf(w.context, 'Win98')).toHaveLength(1);
  });

  describe('a removal blocked by a screenshot', () => {
    async function blocked(w: Awaited<ReturnType<typeof world>>) {
      const { operation } = await commitOperation(w, {
        mode: 'transfer',
        confirmDestructive: true,
      });
      w.agent.send(
        envelope('agent.registration_cleanup', {
          operationId: operation.id,
          versionId: operation.versionId,
          localCopy: 'cleanup_failed',
          code: 'transfer_blocked_media',
          message: 'capture.ppm has not reached the server',
        }),
      );
      expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
      return operation;
    }
    const retry = (w: Awaited<ReturnType<typeof world>>, id: string) =>
      w.admin.request({ method: 'POST', url: `/admin/registrations/${id}/retry-cleanup` });

    it('reports a partial success, keeps the master, and says what to do', async () => {
      const w = await world();
      const operation = await blocked(w);
      const done = await read(w, operation.id);
      expect(done).toMatchObject({ state: 'partial_success', localCopy: 'cleanup_failed' });
      expect(done.error?.message).toContain('capture.ppm');
      expect(done.recovery).toMatch(/Retry removal/);
      expect(await versionsOf(w.context, 'Win98')).toHaveLength(1);
    });

    it('can be retried, which only asks the agent to check everything again', async () => {
      const w = await world();
      const operation = await blocked(w);
      const response = await retry(w, operation.id);
      expect(response.statusCode, response.body).toBe(202);
      const message = await w.agent.next('server.registration_retry_cleanup');
      expect(message.payload).toEqual({
        operationId: operation.id,
        versionId: operation.versionId,
      });
      expect(await read(w, operation.id)).toMatchObject({
        state: 'cleaning_local',
        error: null,
        finishedAt: null,
      });

      w.agent.send(
        envelope('agent.registration_cleanup', {
          operationId: operation.id,
          versionId: operation.versionId,
          localCopy: 'removed',
          code: null,
          message: null,
        }),
      );
      expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
      expect(await read(w, operation.id)).toMatchObject({
        state: 'succeeded',
        localCopy: 'removed',
      });
      expect(await versionsOf(w.context, 'Win98')).toHaveLength(1);
    });

    it('asks again after a reconnection if the first request was lost', async () => {
      const w = await world();
      const operation = await blocked(w);
      expect((await retry(w, operation.id)).statusCode).toBe(202);
      await w.agent.next('server.registration_retry_cleanup');
      await sync(w.agent, [{ operationId: operation.id, phase: 'media_blocked' }]);
      const again = await w.agent.next('server.registration_retry_cleanup');
      expect(again.payload.operationId).toBe(operation.id);
    });

    it('does not ask again for one that nobody retried', async () => {
      const w = await world();
      const operation = await blocked(w);
      await sync(w.agent, [{ operationId: operation.id, phase: 'media_blocked' }]);
      await barrier(w.agent);
      expect(w.agent.received.map((message) => message.type)).not.toContain(
        'server.registration_retry_cleanup',
      );
      expect((await read(w, operation.id)).state).toBe('partial_success');
    });

    it('cannot be retried twice at once, or with the agent away', async () => {
      const w = await world();
      const operation = await blocked(w);
      expect((await retry(w, operation.id)).statusCode).toBe(202);
      expect((await retry(w, operation.id)).statusCode).toBe(409);

      const x = await world();
      const other = await blocked(x);
      x.agent.close();
      await waitFor(async () => (await read(x, other.id)).agentOnline === false);
      const response = await retry(x, other.id);
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('agent_offline');
      expect((await read(x, other.id)).state).toBe('partial_success');
    });

    it('is only for what a screenshot blocked', async () => {
      const w = await world();
      const { operation } = await commitOperation(w, {
        mode: 'transfer',
        confirmDestructive: true,
      });
      w.agent.send(
        envelope('agent.registration_cleanup', {
          operationId: operation.id,
          versionId: operation.versionId,
          localCopy: 'cleanup_failed',
          code: 'cleanup_content_changed',
          message: 'changed',
        }),
      );
      await w.agent.next('server.registration_ack');
      const response = await retry(w, operation.id);
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        'registration_not_retryable',
      );
    });
  });

  it('never lets a late result restart removal once the operation has ended', async () => {
    const w = await world();
    const { operation } = await commitOperation(w, { mode: 'transfer', confirmDestructive: true });
    w.agent.send(
      envelope('agent.registration_cleanup', {
        operationId: operation.id,
        versionId: operation.versionId,
        localCopy: 'cleanup_failed',
        code: 'cleanup_in_use',
        message: 'in use',
      }),
    );
    await w.agent.next('server.registration_ack');
    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    const again = await w.agent.next('server.registration_ack');
    expect(again.payload).toMatchObject({ outcome: 'committed', removeLocal: false });
  });
});

describe('what cannot be registered', () => {
  it('needs an administrator, the CSRF token, and accepts no paths', async () => {
    const w = await world();
    const discoveryId = await discover(w.admin, w.agent, w.paired.agentId, [WIN98]);
    const payload = {
      agentId: w.paired.agentId,
      repositoryId: w.repository.id,
      emulatorType: 'qemu',
      vmName: 'Win98',
      mode: 'copy',
      discoveryOperationId: discoveryId,
    };
    const anonymous = await w.context.app.inject({
      method: 'POST',
      url: '/api/v1/admin/registrations',
      headers: { host: 'emucat.test' },
      payload,
    });
    expect(anonymous.statusCode).toBe(401);
    const noCsrf = await w.admin.request({
      method: 'POST',
      url: '/admin/registrations',
      payload,
      headers: { 'x-csrf-token': 'wrong' },
    });
    expect(noCsrf.statusCode).toBe(403);

    for (const extra of [
      { path: 'C:\\Windows' },
      { host: 'evil.example' },
      { remoteRoot: '/etc' },
      { archiveKey: '../../x' },
    ]) {
      const refused = await registerRequest(w, discoveryId, extra);
      expect(refused.statusCode, JSON.stringify(extra)).toBe(400);
    }
    for (const vmName of ['../evil', 'a/b', 'C:', '.hidden']) {
      const refused = await registerRequest(w, discoveryId, { vmName });
      expect(refused.statusCode, vmName).toBe(400);
    }
    expect(w.agent.received.filter((m) => m.type === 'server.registration_request')).toEqual([]);
  });

  it('refuses an offline agent', async () => {
    const w = await world();
    const discoveryId = await discover(w.admin, w.agent, w.paired.agentId, [WIN98]);
    w.agent.close();
    await waitFor(async () => {
      const response = await registerRequest(w, discoveryId);
      return (
        response.statusCode === 409 &&
        response.json<{ error: { code: string } }>().error.code === 'agent_offline'
      );
    }, 'the agent to be offline');
  });

  it('refuses an agent that has not said it can register', async () => {
    const w = await world();
    const older = await TestAgent.connect(wsUrl(w.context.app), w.paired.credential);
    await older.hello();
    await w.agent.closed();
    const started = await w.admin.request({
      method: 'POST',
      url: `/admin/agents/${w.paired.agentId}/discovery`,
    });
    expect(started.statusCode).toBe(202);
    const response = await registerRequest(w, randomUUID());
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('agent_cannot_register');
    older.close();
  });

  it('refuses a discovery that is not the latest, or that does not list the VM', async () => {
    const w = await world();
    const first = await discover(w.admin, w.agent, w.paired.agentId, [WIN98]);
    const code = async (id: string, overrides: object = {}) => {
      const response = await registerRequest(w, id, overrides);
      return response.json<{ error: { code: string } }>().error.code;
    };

    expect(await code(randomUUID())).toBe('discovery_stale');
    expect(await code(first, { vmName: 'NotDiscovered' })).toBe('discovery_stale');
    expect(await code(first, { vmName: 'WIN98' }), 'exact spelling').toBe('discovery_stale');
    expect(await code(first, { emulatorType: '86box' })).toBe('discovery_stale');

    const second = await discover(w.admin, w.agent, w.paired.agentId, []);
    expect(await code(first), 'a newer report exists').toBe('discovery_stale');
    expect(await code(second), 'and it does not list the VM').toBe('discovery_stale');
  });

  it('refuses a discovery from before the agent reconnected, or that is too old', async () => {
    const context = await startBrowserApp({
      pairingRateLimits: GENEROUS_RATE_LIMITS,
      registrationPolicy: { discoveryMaxAgeMs: 300, healthCheckTimeoutMs: 5000 },
    });
    worlds.push(context);
    await context.app.listen({ host: '127.0.0.1', port: 0 });
    const admin = await signedInAdmin(context);
    const paired = await pairAgent(context.app, admin);
    const agent = await connectAgent(context.app, paired.credential);
    const repository = await createRepository(admin);
    await associate(admin, repository.id, paired.agentId);
    const w = { context, admin, agent, paired, repository };

    const old = await discover(admin, agent, paired.agentId, [WIN98]);
    const report = async () =>
      discoveryOperationSchema.parse(
        (await admin.get(`/admin/agents/${paired.agentId}/discovery`)).json<{
          operation: unknown;
        }>().operation,
      );
    // The page is told the same limits the server checks, so it never offers a stale registration.
    const reported = await report();
    expect(reported.fromCurrentConnection).toBe(true);
    expect(Date.parse(reported.expiresAt ?? '') - Date.parse(reported.finishedAt ?? '')).toBe(300);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect((await registerRequest(w, old)).json<{ error: { code: string } }>().error.code).toBe(
      'discovery_stale',
    );

    const fresh = await discover(admin, agent, paired.agentId, [WIN98]);
    const replacement = await connectAgent(context.app, paired.credential);
    await agent.closed();
    expect((await report()).fromCurrentConnection).toBe(false);
    expect(
      (await registerRequest({ ...w, agent: replacement }, fresh)).json<{
        error: { code: string };
      }>().error.code,
    ).toBe('discovery_stale');
    replacement.close();
  });

  it('refuses a repository the agent is not associated with, or that does not exist', async () => {
    const w = await world();
    const discoveryId = await discover(w.admin, w.agent, w.paired.agentId, [WIN98]);
    await w.admin.request({
      method: 'DELETE',
      url: `/admin/repositories/${w.repository.id}/agents/${w.paired.agentId}`,
    });
    const refused = await registerRequest(w, discoveryId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe(
      'repository_not_authorized',
    );

    const unknown = await registerRequest(w, discoveryId, { repositoryId: randomUUID() });
    expect(unknown.statusCode).toBe(404);
  });

  it('refuses a VM that is already registered, whatever its capitalization', async () => {
    const w = await world();
    const { operation } = await commitOperation(w);
    w.agent.send(
      envelope('agent.registration_cleanup', {
        operationId: operation.id,
        versionId: operation.versionId,
        localCopy: 'preserved',
        code: null,
        message: null,
      }),
    );
    await w.agent.next('server.registration_ack');

    const discoveryId = await discover(w.admin, w.agent, w.paired.agentId, [
      { emulatorType: 'qemu', vmName: 'WIN98', markers: ['run.bat'] },
    ]);
    const duplicate = await registerRequest(w, discoveryId, { vmName: 'WIN98' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ error: { code: string } }>().error.code).toBe('vm_already_registered');
    expect(await versionsOf(w.context, 'Win98')).toHaveLength(1);
  });

  it('allows one of several simultaneous requests', async () => {
    const w = await world();
    const discoveryId = await discover(w.admin, w.agent, w.paired.agentId, [WIN98]);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => registerRequest(w, discoveryId)),
    );
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([202, 409, 409, 409, 409, 409]);
    for (const response of responses.filter((r) => r.statusCode === 409)) {
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        'registration_in_progress',
      );
    }
  });

  it('allows one operation per VM across agents, and one per agent', async () => {
    const w = await world();
    const second = await pairAgent(w.context.app, w.admin);
    const secondAgent = await connectAgent(w.context.app, second.credential);
    await associate(w.admin, w.repository.id, second.agentId);

    const first = await register(w);
    expect(first.state).toBe('queued');
    const discoveryId = await discover(w.admin, secondAgent, second.agentId, [WIN98]);
    const sameVm = await registerRequest(w, discoveryId, { agentId: second.agentId });
    expect(sameVm.statusCode).toBe(409);
    expect(sameVm.json<{ error: { code: string } }>().error.code).toBe('registration_in_progress');

    const another = await discover(w.admin, w.agent, w.paired.agentId, [
      WIN98,
      { emulatorType: 'qemu', vmName: 'Other', markers: ['run.bat'] },
    ]);
    const sameAgent = await registerRequest(w, another, { vmName: 'Other' });
    expect(sameAgent.statusCode).toBe(409);
    secondAgent.close();
  });

  it('is also enforced by the schema, whatever the application does', async () => {
    const w = await world();
    const operation = await register(w);
    const insert = (agentId: string, vmName: string) =>
      w.context.pool.execute(
        `INSERT INTO registration_operations
           (id, agent_id, repository_id, emulator_type, vm_name, mode, version_id, archive_key)
         VALUES (?, ?, ?, 'qemu', ?, 'copy', ?, 'x')`,
        [randomUUID(), agentId, w.repository.id, vmName, randomUUID()],
      );
    await expect(insert(w.paired.agentId, 'Unrelated')).rejects.toMatchObject({
      code: 'ER_DUP_ENTRY',
    });
    const second = await pairAgent(w.context.app, w.admin);
    await expect(insert(second.agentId, 'win98')).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await expect(
      w.context.pool.execute(
        "UPDATE registration_operations SET state = 'succeeded' WHERE id = ?",
        [operation.id],
      ),
      'a master cannot be claimed without its archive',
    ).rejects.toThrow();
  });
});

describe('an agent’s reports', () => {
  it('authorize nothing without an operation', async () => {
    const w = await world();
    const stranger = randomUUID();
    const version = randomUUID();
    w.agent.send(
      envelope('agent.registration_result', {
        operationId: stranger,
        versionId: version,
        archiveKey: `archives/qemu/win98/${version}.zip`,
        archiveSizeBytes: 1,
        archiveSha256: SHA,
        manifestVersion: 1,
        manifestSha256: MANIFEST_SHA,
        fileCount: 1,
        totalUncompressedBytes: 1,
      }),
    );
    const ack = await w.agent.next('server.registration_ack');
    expect(ack.payload).toMatchObject({ outcome: 'rejected', operationId: stranger });
    expect(ack.payload.deletePublished).toBeFalsy();
    expect(await vmRow(w.context, 'Win98')).toBeUndefined();
  });

  it('count only from the agent the operation was created for', async () => {
    const w = await world();
    const operation = await register(w);
    await w.agent.next('server.registration_request');
    const intruder = await pairAgent(w.context.app, w.admin);
    const intruderAgent = await connectAgent(w.context.app, intruder.credential);
    intruderAgent.send(envelope('agent.registration_result', resultFor(operation)));
    const ack = await intruderAgent.next('server.registration_ack');
    expect(ack.payload.outcome).toBe('rejected');
    expect(await vmRow(w.context, 'Win98')).toBeUndefined();
    expect((await read(w, operation.id)).state).toBe('queued');

    intruderAgent.send(
      envelope('agent.registration_error', { operationId: operation.id, code: 'x', message: 'x' }),
    );
    await barrier(intruderAgent);
    expect((await read(w, operation.id)).state).toBe('queued');
    intruderAgent.close();
  });

  it('must carry the identities that were issued', async () => {
    const w = await world();
    const operation = await register(w);
    await w.agent.next('server.registration_request');
    const otherVersion = randomUUID();
    w.agent.send(
      envelope(
        'agent.registration_result',
        resultFor(operation, {
          versionId: otherVersion,
          archiveKey: `archives/qemu/win98/${otherVersion}.zip`,
        }),
      ),
    );
    const ack = await w.agent.next('server.registration_ack');
    expect(ack.payload.outcome).toBe('rejected');
    expect(ack.payload.deletePublished).toBeFalsy();
    const failed = await read(w, operation.id);
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'invalid_result' } });
    expect(await vmRow(w.context, 'Win98')).toBeUndefined();
  });

  it('cannot move an operation backwards or past the server’s own decisions', async () => {
    const w = await world();
    const operation = await register(w);
    await w.agent.next('server.registration_request');
    const progress = (stage: string) =>
      w.agent.send(
        envelope('agent.registration_progress', {
          operationId: operation.id,
          stage,
          doneBytes: null,
          totalBytes: null,
        }),
      );
    progress('uploading');
    progress('archiving');
    await barrier(w.agent);
    expect((await read(w, operation.id)).state).toBe('uploading');

    w.agent.send(
      envelope('agent.registration_progress', {
        operationId: operation.id,
        stage: 'succeeded',
        doneBytes: null,
        totalBytes: null,
      }),
    );
    expect((await w.agent.next('server.error')).payload.code).toBe('unsupported_message');
    expect((await read(w, operation.id)).state).toBe('uploading');

    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    await w.agent.next('server.registration_ack');
    progress('uploading');
    await barrier(w.agent);
    expect((await read(w, operation.id)).state).toBe('cleaning_local');
  });

  it('that a failure happened are kept, along with what to do about it', async () => {
    const w = await world();
    const operation = await register(w);
    await w.agent.next('server.registration_request');
    w.agent.send(
      envelope('agent.registration_error', {
        operationId: operation.id,
        code: 'host_key_changed',
        message: 'The server’s host key differs from the trusted one.',
      }),
    );
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
    const failed = await read(w, operation.id);
    expect(failed.state).toBe('failed');
    expect(failed.localCopy).toBe('preserved');
    expect(failed.error?.code).toBe('host_key_changed');
    expect(failed.recovery).toMatch(/fingerprint/);
    expect(await vmRow(w.context, 'Win98')).toBeUndefined();

    // A repeated report changes nothing. It is only answered again.
    w.agent.send(
      envelope('agent.registration_error', {
        operationId: operation.id,
        code: 'other',
        message: 'other',
      }),
    );
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
    expect((await read(w, operation.id)).error?.code).toBe('host_key_changed');

    // It is not in the way of trying again, as a new operation with new identities.
    const retry = await register(w);
    expect(retry.id).not.toBe(operation.id);
    expect(retry.versionId).not.toBe(operation.versionId);
  });
});

describe('recovery', () => {
  it('survives a failed database commit, without a second master or a deletion', async () => {
    const w = await world();
    const operation = await register(w, { mode: 'transfer', confirmDestructive: true });
    await w.agent.next('server.registration_request');

    // A real failure, inside the transaction, after the VM row was already inserted.
    await w.context.pool.query(
      `CREATE TRIGGER fail_version BEFORE INSERT ON vm_versions FOR EACH ROW
       SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'simulated commit failure'`,
    );
    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    await barrier(w.agent);

    expect(w.agent.received.filter((m) => m.type === 'server.registration_ack')).toEqual([]);
    expect(await vmRow(w.context, 'Win98'), 'the transaction rolled back').toBeUndefined();
    const stuck = await read(w, operation.id);
    expect(stuck.state).toBe('committing');
    expect(stuck.archive?.sha256, 'what was verified is kept').toBe(SHA);

    // Until it can be committed, an administrator's retry changes nothing either.
    const tried = await w.admin.request({
      method: 'POST',
      url: `/admin/registrations/${operation.id}/reconcile`,
    });
    expect(tried.statusCode).toBe(500);
    expect((await read(w, operation.id)).state).toBe('committing');

    await w.context.pool.query('DROP TRIGGER fail_version');

    // The agent repeats its report, as it does on every heartbeat.
    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    const ack = await w.agent.next('server.registration_ack');
    expect(ack.payload).toMatchObject({
      outcome: 'committed',
      versionId: operation.versionId,
      removeLocal: true,
    });
    expect(await versionsOf(w.context, 'Win98')).toHaveLength(1);
  });

  it('lets an administrator reconcile from what is stored, while the agent is away', async () => {
    const w = await world();
    const operation = await register(w);
    await w.agent.next('server.registration_request');
    await w.context.pool.query(
      `CREATE TRIGGER fail_version BEFORE INSERT ON vm_versions FOR EACH ROW
       SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'simulated commit failure'`,
    );
    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    await barrier(w.agent);
    await w.context.pool.query('DROP TRIGGER fail_version');
    w.agent.close();

    const response = await w.admin.request({
      method: 'POST',
      url: `/admin/registrations/${operation.id}/reconcile`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const reconciled = registrationOperationSchema.parse(response.json());
    expect(reconciled.state).toBe('cleaning_local');
    expect(await versionsOf(w.context, 'Win98')).toHaveLength(1);

    // Doing it again is harmless.
    const again = await w.admin.request({
      method: 'POST',
      url: `/admin/registrations/${operation.id}/reconcile`,
    });
    expect(again.statusCode).toBe(200);
    expect(await versionsOf(w.context, 'Win98')).toHaveLength(1);
  });

  it('answers a repeated result with the same commit, after a lost acknowledgement', async () => {
    const w = await world();
    const { operation } = await commitOperation(w, { mode: 'transfer', confirmDestructive: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      w.agent.send(envelope('agent.registration_result', resultFor(operation)));
      const ack = await w.agent.next('server.registration_ack');
      expect(ack.payload).toMatchObject({
        outcome: 'committed',
        versionId: operation.versionId,
        removeLocal: true,
      });
    }
    expect(await versionsOf(w.context, 'Win98')).toHaveLength(1);
  });

  it('continues after an API restart, from the database alone', async () => {
    const w = await world();
    const operation = await register(w, { mode: 'transfer', confirmDestructive: true });
    await w.agent.next('server.registration_request');
    w.agent.send(
      envelope('agent.registration_progress', {
        operationId: operation.id,
        stage: 'uploading',
        doneBytes: 5,
        totalBytes: 10,
      }),
    );
    await barrier(w.agent);

    // Nothing in memory carries over to another instance, which is what a restart is.
    const restarted = await w.context.buildAnother();
    await restarted.listen({ host: '127.0.0.1', port: 0 });
    const beforeReconnect = await w.admin.get(`/admin/registrations/${operation.id}`);
    expect(beforeReconnect.json<RegistrationOperation>().state).toBe('uploading');

    const reconnected = await TestAgent.connect(wsUrl(restarted), w.paired.credential);
    await reconnected.hello();
    await sync(reconnected, [{ operationId: operation.id, phase: 'running' }]);
    const stillRunning = await read(w, operation.id);
    expect(stillRunning.state, 'never a false success').toBe('uploading');

    reconnected.send(envelope('agent.registration_result', resultFor(operation)));
    const ack = await reconnected.next('server.registration_ack');
    expect(ack.payload).toMatchObject({ outcome: 'committed', removeLocal: true });
    expect(await versionsOf(w.context, 'Win98')).toHaveLength(1);
    reconnected.close();
    w.agent.close();
  });

  it('delivers a queued operation when the agent comes back', async () => {
    const w = await world();
    const discoveryId = await discover(w.admin, w.agent, w.paired.agentId, [WIN98]);
    const response = await registerRequest(w, discoveryId);
    const operation = registrationOperationSchema.parse(response.json());
    await w.agent.next('server.registration_request');
    // The agent went away before doing anything with it. Its journal is empty when it returns.
    w.agent.close();
    await waitFor(() => !isOnline(w), 'the agent to go offline').catch(() => undefined);

    const again = await TestAgent.connect(wsUrl(w.context.app), w.paired.credential);
    await again.hello();
    await sync(again, []);
    const request = await again.next('server.registration_request');
    expect(request.payload.operationId).toBe(operation.id);
    expect(request.payload.versionId).toBe(operation.versionId);
    again.close();
  });

  it('marks work the agent has lost as failed, and never as a success', async () => {
    const w = await world();
    const operation = await register(w);
    await w.agent.next('server.registration_request');
    w.agent.send(
      envelope('agent.registration_progress', {
        operationId: operation.id,
        stage: 'archiving',
        doneBytes: null,
        totalBytes: null,
      }),
    );
    await barrier(w.agent);
    await sync(w.agent, []);
    const lost = await read(w, operation.id);
    expect(lost).toMatchObject({ state: 'failed', error: { code: 'agent_lost_operation' } });
    expect(await vmRow(w.context, 'Win98')).toBeUndefined();
  });

  it('keeps a committed master if the agent has lost track of its cleanup', async () => {
    const w = await world();
    const { operation } = await commitOperation(w, { mode: 'transfer', confirmDestructive: true });
    await sync(w.agent, []);
    const lost = await read(w, operation.id);
    expect(lost).toMatchObject({ state: 'partial_success', localCopy: 'unknown' });
    expect(await versionsOf(w.context, 'Win98')).toHaveLength(1);
  });

  it('tells an agent to stop work that ended here while it was away', async () => {
    const w = await world();
    const operation = await register(w);
    await w.agent.next('server.registration_request');
    w.agent.close();
    await waitFor(async () => {
      const response = await w.admin.get(`/admin/agents/${w.paired.agentId}`);
      return response.json<{ online: boolean }>().online === false;
    }, 'the agent to go offline');
    const cancelled = await w.admin.request({
      method: 'POST',
      url: `/admin/registrations/${operation.id}/cancel`,
    });
    expect(cancelled.json<RegistrationOperation>().state).toBe('cancelled');

    const again = await TestAgent.connect(wsUrl(w.context.app), w.paired.credential);
    await again.hello();
    await sync(again, [
      { operationId: operation.id, phase: 'running' },
      { operationId: randomUUID(), phase: 'running' },
    ]);
    expect((await again.next('server.registration_cancel')).payload.operationId).toBe(operation.id);
    await again.next('server.registration_cancel');
    again.close();
  });
});

describe('cancelling', () => {
  it('asks a connected agent, and takes effect when it reports back', async () => {
    const w = await world();
    const operation = await register(w);
    await w.agent.next('server.registration_request');
    w.agent.send(
      envelope('agent.registration_progress', {
        operationId: operation.id,
        stage: 'uploading',
        doneBytes: 1,
        totalBytes: 2,
      }),
    );
    await barrier(w.agent);
    const response = await w.admin.request({
      method: 'POST',
      url: `/admin/registrations/${operation.id}/cancel`,
    });
    expect(response.statusCode).toBe(200);
    const asked = registrationOperationSchema.parse(response.json());
    expect(asked.state).toBe('uploading');
    expect(asked.cancelRequested).toBe(true);
    expect((await w.agent.next('server.registration_cancel')).payload.operationId).toBe(
      operation.id,
    );

    w.agent.send(
      envelope('agent.registration_error', {
        operationId: operation.id,
        code: 'cancelled',
        message: 'Cancelled',
      }),
    );
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
    expect((await read(w, operation.id)).state).toBe('cancelled');
  });

  it('wins over a result that arrives afterwards, which is then discarded', async () => {
    const w = await world();
    const operation = await register(w, { mode: 'transfer', confirmDestructive: true });
    await w.agent.next('server.registration_request');
    await w.admin.request({
      method: 'POST',
      url: `/admin/registrations/${operation.id}/cancel`,
    });
    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    const ack = await w.agent.next('server.registration_ack');
    expect(ack.payload).toMatchObject({ outcome: 'rejected', deletePublished: true });
    expect(ack.payload.removeLocal).toBeFalsy();
    expect((await read(w, operation.id)).state).toBe('cancelled');
    expect(await vmRow(w.context, 'Win98')).toBeUndefined();
  });

  it('is refused once the master exists', async () => {
    const w = await world();
    const { operation } = await commitOperation(w);
    const response = await w.admin.request({
      method: 'POST',
      url: `/admin/registrations/${operation.id}/cancel`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('registration_committed');
    expect(await versionsOf(w.context, 'Win98')).toHaveLength(1);
  });
});

describe('revocation', () => {
  it('fails what was running, and a revoked agent can start nothing', async () => {
    const w = await world();
    const discoveryId = await discover(w.admin, w.agent, w.paired.agentId, [WIN98]);
    const response = await registerRequest(w, discoveryId, {
      mode: 'transfer',
      confirmDestructive: true,
    });
    const operation = registrationOperationSchema.parse(response.json());
    await w.agent.next('server.registration_request');

    await w.admin.request({ method: 'POST', url: `/admin/agents/${w.paired.agentId}/revoke` });
    await waitFor(async () => (await read(w, operation.id)).state === 'failed', 'the failure');
    const failed = await read(w, operation.id);
    expect(failed.error?.code).toBe('agent_revoked');
    expect(await vmRow(w.context, 'Win98')).toBeUndefined();

    const refused = await registerRequest(w, discoveryId);
    expect(refused.statusCode).toBe(409);
  });

  it('keeps a committed master, and does not claim to know about the local copy', async () => {
    const w = await world();
    const { operation } = await commitOperation(w, { mode: 'transfer', confirmDestructive: true });
    await w.admin.request({ method: 'POST', url: `/admin/agents/${w.paired.agentId}/revoke` });
    await waitFor(
      async () => (await read(w, operation.id)).state === 'partial_success',
      'the operation to end',
    );
    const done = await read(w, operation.id);
    expect(done.localCopy).toBe('unknown');
    expect(await versionsOf(w.context, 'Win98')).toHaveLength(1);
  });

  it('noticed at commit is enough to refuse a master', async () => {
    const w = await world();
    const operation = await register(w);
    await w.agent.next('server.registration_request');
    // Revoked directly in the database: nobody has told the hub yet.
    await w.context.pool.execute(
      'UPDATE agents SET revoked_at = UTC_TIMESTAMP(3), credential_hash = NULL WHERE id = ?',
      [w.paired.agentId],
    );
    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    const ack = await w.agent.next('server.registration_ack');
    expect(ack.payload.outcome).toBe('rejected');
    expect(await vmRow(w.context, 'Win98')).toBeUndefined();
    expect((await read(w, operation.id)).error?.code).toBe('agent_revoked');
  });
});

function isOnline(w: World): boolean {
  return w.agent.closeCode === undefined;
}

describe('repositories', () => {
  it('are one active SSH repository, with validated details and no secrets', async () => {
    const w = await world();
    expect(w.repository).toMatchObject({
      provider: 'sftp',
      host: 'nas.example',
      port: 22,
      remoteRoot: '/srv/emucat',
      status: 'unchecked',
      lastSuccessfulCheckAt: null,
    });
    const body = JSON.stringify((await w.admin.get('/admin/repositories')).json());
    expect(body).not.toMatch(/private|secret|passphrase/i);

    const second = await w.admin.request({
      method: 'POST',
      url: '/admin/repositories',
      payload: { name: 'Other', host: 'b', port: 22, username: 'u', remoteRoot: '/x' },
    });
    expect(second.statusCode).toBe(409);

    for (const bad of [
      { remoteRoot: 'relative' },
      { remoteRoot: '/a/../b' },
      { remoteRoot: '/a\\b' },
      { host: 'a b' },
      { host: 'evil;rm' },
      { port: 0 },
      { port: 70000 },
      { username: 'a b' },
      { privateKey: 'PEM' },
      { secret_ref: 'x' },
    ]) {
      const refused = await w.admin.request({
        method: 'PUT',
        url: `/admin/repositories/${w.repository.id}`,
        payload: { name: 'NAS', host: 'h', port: 22, username: 'u', remoteRoot: '/r', ...bad },
      });
      expect(refused.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('are checked by the agent, and the result is stored', async () => {
    const w = await world();
    const url = `/admin/repositories/${w.repository.id}/agents/${w.paired.agentId}/health-check`;
    expect((await w.admin.request({ method: 'POST', url })).statusCode).toBe(202);
    const request = await w.agent.next('server.repository_health_request');
    expect(request.payload.repositoryId).toBe(w.repository.id);
    const during = await w.admin.get('/admin/repositories');
    expect(
      during.json<{ repositories: RepositorySummary[] }>().repositories[0]?.agents[0]
        ?.checkInProgress,
    ).toBe(true);

    w.agent.send(
      envelope('agent.repository_health_result', {
        operationId: request.payload.operationId,
        repositoryId: w.repository.id,
        ok: true,
        code: null,
        message: null,
        configuration: {
          host: 'nas.example',
          port: 22,
          username: 'emucat',
          remoteRoot: '/srv/emucat',
        },
        hostKeyFingerprint: 'SHA256:abc',
        freeBytes: 1024,
      }),
    );
    await barrier(w.agent);
    const after = (await w.admin.get('/admin/repositories')).json<{
      repositories: RepositorySummary[];
    }>().repositories[0];
    expect(after?.status).toBe('healthy');
    expect(after?.lastSuccessfulCheckAt).not.toBeNull();
    expect(after?.agents[0]).toMatchObject({
      checkInProgress: false,
      hostKeyFingerprint: 'SHA256:abc',
      freeBytes: 1024,
      errorCode: null,
    });
  });

  it('report a failure, and local settings that point somewhere else', async () => {
    const w = await world();
    const url = `/admin/repositories/${w.repository.id}/agents/${w.paired.agentId}/health-check`;

    await w.admin.request({ method: 'POST', url });
    let request = await w.agent.next('server.repository_health_request');
    w.agent.send(
      envelope('agent.repository_health_result', {
        operationId: request.payload.operationId,
        repositoryId: w.repository.id,
        ok: false,
        code: 'host_key_changed',
        message: 'The host key differs',
        configuration: null,
        hostKeyFingerprint: null,
        freeBytes: null,
      }),
    );
    await barrier(w.agent);
    let summary = (await w.admin.get('/admin/repositories')).json<{
      repositories: RepositorySummary[];
    }>().repositories[0];
    expect(summary?.status).toBe('failing');
    expect(summary?.configurationErrors[0]).toMatch(/host key differs/);

    await w.admin.request({ method: 'POST', url });
    request = await w.agent.next('server.repository_health_request');
    w.agent.send(
      envelope('agent.repository_health_result', {
        operationId: request.payload.operationId,
        repositoryId: w.repository.id,
        ok: true,
        code: null,
        message: null,
        configuration: {
          host: 'elsewhere',
          port: 22,
          username: 'emucat',
          remoteRoot: '/srv/emucat',
        },
        hostKeyFingerprint: 'SHA256:x',
        freeBytes: null,
      }),
    );
    await barrier(w.agent);
    summary = (await w.admin.get('/admin/repositories')).json<{
      repositories: RepositorySummary[];
    }>().repositories[0];
    expect(summary?.status).toBe('failing');
    expect(summary?.agents[0]?.errorCode).toBe('repository_config_mismatch');
    expect(summary?.lastSuccessfulCheckAt).toBeNull();
  });

  it('ignore a health result nobody asked for', async () => {
    const w = await world();
    w.agent.send(
      envelope('agent.repository_health_result', {
        operationId: randomUUID(),
        repositoryId: w.repository.id,
        ok: true,
        code: null,
        message: null,
        configuration: {
          host: 'nas.example',
          port: 22,
          username: 'emucat',
          remoteRoot: '/srv/emucat',
        },
        hostKeyFingerprint: null,
        freeBytes: null,
      }),
    );
    await barrier(w.agent);
    const summary = (await w.admin.get('/admin/repositories')).json<{
      repositories: RepositorySummary[];
    }>().repositories[0];
    expect(summary?.status).toBe('unchecked');
  });

  it('need the agent to be associated before checking', async () => {
    const w = await world();
    const other = await pairAgent(w.context.app, w.admin);
    const response = await w.admin.request({
      method: 'POST',
      url: `/admin/repositories/${w.repository.id}/agents/${other.agentId}/health-check`,
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('the API', () => {
  it('has no route that receives or returns an archive', async () => {
    const w = await world();
    const routes = w.context.app.printRoutes({ commonPrefix: false });
    expect(routes).not.toMatch(/upload|download|archive/i);
  });
});
