import { createHash, randomUUID } from 'node:crypto';
import {
  archiveObjectKey,
  MEDIA_PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  restoreListResponseSchema,
  restoreOperationSchema,
  restoreOptionsResponseSchema,
  type RestoreOperation,
  type RestoreRequestPayload,
  type RepositorySummary,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, describe, expect, it } from 'vitest';
import {
  envelope,
  GENEROUS_RATE_LIMITS,
  HELLO,
  pairAgent,
  TestAgent,
  waitFor,
  wsUrl,
  type PairedAgent,
} from './agent-helpers.js';
import {
  insertVm,
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from './browser-app.js';

const worlds: BrowserTestContext[] = [];
afterAll(async () => {
  await Promise.all(worlds.map((world) => world.close()));
});

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const ARCHIVE_SHA256 = hash('the archive');
const MANIFEST_SHA256 = hash('the manifest');
const ARCHIVE_SIZE = 4096;

interface World {
  context: BrowserTestContext;
  admin: TestClient;
  agent: TestAgent;
  paired: PairedAgent;
  repository: RepositorySummary;
  versionId: string;
}

async function connect(app: FastifyInstance, credential: string): Promise<TestAgent> {
  const agent = await TestAgent.connect(wsUrl(app), credential);
  agent.send(envelope('agent.hello', HELLO));
  await agent.next('server.welcome');
  return agent;
}

function capabilities(repositoryId: string, overrides: object = {}) {
  return {
    emulators: [{ emulatorType: 'qemu', basePath: 'C:\\vms\\qemu' }],
    repositoryIds: [repositoryId],
    cacheMaxBytes: 1000,
    cacheUsedBytes: 10,
    ...overrides,
  };
}

async function barrier(agent: TestAgent): Promise<void> {
  agent.send(envelope('agent.heartbeat', {}));
  await agent.next('server.heartbeat_ack');
}

async function sync(agent: TestAgent, repositoryId: string, overrides: object = {}): Promise<void> {
  agent.send(
    envelope('agent.restore_sync', {
      operations: [],
      capabilities: capabilities(repositoryId),
      localCopies: [],
      ...overrides,
    }),
  );
  await barrier(agent);
}

/** A registered VM with a committed master, as a registration would leave it, but no local copy. */
async function insertMaster(
  context: BrowserTestContext,
  repositoryId: string,
  agentId: string,
  vmName = 'Win98',
): Promise<string> {
  const { pool } = context;
  await insertVm(pool, { vmName });
  const versionId = randomUUID();
  await pool.execute(
    `INSERT INTO vm_versions
       (id, emulator_type, vm_name, kind, repository_id, archive_key, archive_sha256,
        archive_size_bytes, created_by_agent_id)
     VALUES (?, 'qemu', ?, 'master', ?, ?, ?, ?, ?)`,
    [
      versionId,
      vmName,
      repositoryId,
      archiveObjectKey({ emulatorType: 'qemu', vmName }, versionId),
      ARCHIVE_SHA256,
      ARCHIVE_SIZE,
      agentId,
    ],
  );
  return versionId;
}

async function world(): Promise<World> {
  const context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
  worlds.push(context);
  await context.app.listen({ host: '127.0.0.1', port: 0 });
  const admin = await signedInAdmin(context);
  const paired = await pairAgent(context.app, admin);
  const agent = await connect(context.app, paired.credential);
  const created = await admin.request({
    method: 'POST',
    url: '/admin/repositories',
    payload: {
      name: 'NAS',
      host: 'nas.example',
      port: 22,
      username: 'emucat',
      remoteRoot: '/srv/emucat',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const repository = created.json<RepositorySummary>();
  const associated = await admin.request({
    method: 'PUT',
    url: `/admin/repositories/${repository.id}/agents/${paired.agentId}`,
  });
  expect(associated.statusCode, associated.body).toBe(200);
  await sync(agent, repository.id);
  const versionId = await insertMaster(context, repository.id, paired.agentId);
  return { context, admin, agent, paired, repository, versionId };
}

function restoreBody(w: World, overrides: object = {}) {
  return {
    agentId: w.paired.agentId,
    emulatorType: 'qemu',
    vmName: 'Win98',
    versionId: w.versionId,
    ...overrides,
  };
}

async function start(w: World, overrides: object = {}): Promise<RestoreOperation> {
  const response = await w.admin.request({
    method: 'POST',
    url: '/admin/restores',
    payload: restoreBody(w, overrides),
  });
  expect(response.statusCode, response.body).toBe(202);
  return restoreOperationSchema.parse(response.json());
}

async function read(w: World, operationId: string): Promise<RestoreOperation> {
  const response = await w.admin.get(`/admin/restores/${operationId}`);
  expect(response.statusCode, response.body).toBe(200);
  return restoreOperationSchema.parse(response.json());
}

function resultFor(operation: RestoreOperation, overrides: object = {}) {
  return {
    operationId: operation.id,
    versionId: operation.versionId,
    archiveSizeBytes: ARCHIVE_SIZE,
    archiveSha256: ARCHIVE_SHA256,
    manifestVersion: 1,
    manifestSha256: MANIFEST_SHA256,
    fileCount: 3,
    totalUncompressedBytes: 8192,
    localDirectory: 'C:\\vms\\qemu\\Win98',
    cache: {
      hit: false,
      downloadedBytes: ARCHIVE_SIZE,
      archiveCached: true,
      totalBytes: ARCHIVE_SIZE,
    },
    ...overrides,
  };
}

async function vmState(w: World, vmName = 'Win98') {
  const [rows] = await w.context.pool.execute<RowDataPacket[]>(
    `SELECT local_source_version_id, execution_state, content_status, last_verified_sha256
     FROM agent_vm_state WHERE agent_id = ? AND emulator_type = 'qemu' AND vm_name = ?`,
    [w.paired.agentId, vmName],
  );
  return rows[0];
}

describe('authorization', () => {
  it('refuses anyone but an authenticated administrator', async () => {
    const w = await world();
    const anonymous = new TestClient(w.context.app);
    for (const [method, url] of [
      ['POST', '/admin/restores'],
      ['GET', '/admin/restores'],
      ['GET', '/admin/vms/qemu/Win98/restore-options'],
      ['POST', `/admin/restores/${randomUUID()}/cancel`],
    ] as const) {
      const response = await anonymous.request({
        method,
        url,
        ...(method === 'POST' ? { payload: restoreBody(w) } : {}),
      });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('refuses a cross-site request', async () => {
    const w = await world();
    const response = await w.admin.request({
      method: 'POST',
      url: '/admin/restores',
      payload: restoreBody(w),
      headers: { origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('does not accept a path, a host or anything else it did not ask for', async () => {
    const w = await world();
    for (const extra of [
      { destination: 'C:\\Windows' },
      { localDirectory: '..\\..' },
      { archiveKey: '../../etc/passwd' },
      { repositoryId: randomUUID() },
    ]) {
      const response = await w.admin.request({
        method: 'POST',
        url: '/admin/restores',
        payload: restoreBody(w, extra),
      });
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
    }
  });

  it('has no route that receives or returns an archive', async () => {
    const w = await world();
    const routes = w.context.app.printRoutes();
    expect(routes).not.toMatch(/upload|download|archive/i);
  });
});

describe('validation', () => {
  it('sends the immutable identities to the authorized agent, and no path', async () => {
    const w = await world();
    const operation = await start(w);
    expect(operation.state).toBe('queued');
    expect(operation.archive).toEqual({ sizeBytes: ARCHIVE_SIZE, sha256: ARCHIVE_SHA256 });
    const request = await w.agent.next('server.restore_request');
    const payload = request.payload as RestoreRequestPayload;
    expect(payload).toEqual({
      operationId: operation.id,
      emulatorType: 'qemu',
      vmName: 'Win98',
      repositoryId: w.repository.id,
      versionId: w.versionId,
      archiveKey: archiveObjectKey({ emulatorType: 'qemu', vmName: 'Win98' }, w.versionId),
      archiveSizeBytes: ARCHIVE_SIZE,
      archiveSha256: ARCHIVE_SHA256,
      manifestSha256: null,
      expectedUncompressedBytes: null,
    });
  });

  it('uses the stored spelling of the name, whatever the request says', async () => {
    const w = await world();
    const operation = await start(w, { vmName: 'WIN98' });
    expect(operation.vmName).toBe('Win98');
    const request = await w.agent.next('server.restore_request');
    expect((request.payload as RestoreRequestPayload).vmName).toBe('Win98');
  });

  it('refuses a version that is unknown, or belongs to another VM', async () => {
    const w = await world();
    const unknown = await w.admin.request({
      method: 'POST',
      url: '/admin/restores',
      payload: restoreBody(w, { versionId: randomUUID() }),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe('version_not_found');

    const other = await insertMaster(w.context, w.repository.id, w.paired.agentId, 'Other');
    const crossed = await w.admin.request({
      method: 'POST',
      url: '/admin/restores',
      payload: restoreBody(w, { versionId: other }),
    });
    expect(crossed.statusCode).toBe(404);
  });

  it('refuses each condition that makes an agent ineligible', async () => {
    const refused = async (w: World, code: string) => {
      const response = await w.admin.request({
        method: 'POST',
        url: '/admin/restores',
        payload: restoreBody(w),
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(code);
    };

    const noEmulator = await world();
    await sync(noEmulator.agent, noEmulator.repository.id, {
      capabilities: capabilities(noEmulator.repository.id, { emulators: [] }),
    });
    await refused(noEmulator, 'emulator_not_configured');

    const noSettings = await world();
    await sync(noSettings.agent, noSettings.repository.id, {
      capabilities: capabilities(noSettings.repository.id, { repositoryIds: [] }),
    });
    await refused(noSettings, 'repository_not_configured');

    const unassociated = await world();
    await unassociated.admin.request({
      method: 'DELETE',
      url: `/admin/repositories/${unassociated.repository.id}/agents/${unassociated.paired.agentId}`,
    });
    await refused(unassociated, 'repository_not_authorized');

    const holding = await world();
    await holding.context.pool.execute(
      `INSERT INTO agent_vm_state (agent_id, emulator_type, vm_name, execution_state)
       VALUES (?, 'qemu', 'Win98', 'idle')`,
      [holding.paired.agentId],
    );
    await refused(holding, 'local_copy_exists');

    const offline = await world();
    offline.agent.close();
    await waitFor(async () => {
      const options = await offline.admin.get('/admin/vms/qemu/Win98/restore-options');
      return restoreOptionsResponseSchema.parse(options.json()).agents[0]?.online === false;
    }, 'the agent to go offline');
    await refused(offline, 'agent_offline');

    const old = await world();
    old.agent.close();
    await waitFor(async () => {
      const options = await old.admin.get('/admin/vms/qemu/Win98/restore-options');
      return restoreOptionsResponseSchema.parse(options.json()).agents[0]?.online === false;
    }, 'the agent to go offline');
    // An agent that says hello and nothing else is an older one.
    old.agent = await connect(old.context.app, old.paired.credential);
    await barrier(old.agent);
    await refused(old, 'agent_cannot_restore');
  }, 180_000);

  it('allows a restore where a transfer removed the local copy', async () => {
    const w = await world();
    await w.context.pool.execute(
      `INSERT INTO agent_vm_state (agent_id, emulator_type, vm_name, execution_state)
       VALUES (?, 'qemu', 'Win98', 'absent')`,
      [w.paired.agentId],
    );
    const operation = await start(w);
    expect(operation.state).toBe('queued');
  });

  it('allows one operation at a time on an agent, of either kind', async () => {
    const w = await world();
    await start(w);
    await w.agent.next('server.restore_request');
    const other = await insertMaster(w.context, w.repository.id, w.paired.agentId, 'Other');
    const second = await w.admin.request({
      method: 'POST',
      url: '/admin/restores',
      payload: restoreBody(w, { vmName: 'Other', versionId: other }),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('operation_in_progress');

    // The database says the same, whatever the application does.
    await expect(
      w.context.pool.execute(
        `INSERT INTO restore_operations
           (id, agent_id, repository_id, emulator_type, vm_name, version_id, archive_key,
            archive_sha256, archive_size_bytes)
         VALUES (?, ?, ?, 'qemu', 'Other', ?, 'k', ?, 1)`,
        [randomUUID(), w.paired.agentId, w.repository.id, other, ARCHIVE_SHA256],
      ),
    ).rejects.toThrow(/Duplicate entry/);

    const options = restoreOptionsResponseSchema.parse(
      (await w.admin.get('/admin/vms/qemu/Other/restore-options')).json(),
    );
    expect(options.agents[0]?.ineligibleReason).toBe('operation_in_progress');
  });

  it('survives concurrent requests: exactly one wins', async () => {
    const w = await world();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        w.admin.request({ method: 'POST', url: '/admin/restores', payload: restoreBody(w) }),
      ),
    );
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses.filter((status) => status === 202)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(5);
  });
});

describe('the options an administrator sees', () => {
  it('describes the master, the agent and where the agent would put it', async () => {
    const w = await world();
    const response = await w.admin.get('/admin/vms/qemu/win98/restore-options');
    expect(response.statusCode, response.body).toBe(200);
    const options = restoreOptionsResponseSchema.parse(response.json());
    expect(options.master).toMatchObject({
      versionId: w.versionId,
      repositoryId: w.repository.id,
      archiveSizeBytes: ARCHIVE_SIZE,
      archiveSha256: ARCHIVE_SHA256,
    });
    expect(options.agents).toHaveLength(1);
    expect(options.agents[0]).toMatchObject({
      agentId: w.paired.agentId,
      online: true,
      eligible: true,
      ineligibleReason: null,
      destination: 'C:\\vms\\qemu\\Win98',
      local: { availability: 'none' },
      cacheUsedBytes: 10,
      cacheMaxBytes: 1000,
    });
  });

  it('answers 404 for a VM that does not exist', async () => {
    const w = await world();
    const response = await w.admin.get('/admin/vms/qemu/Nothing/restore-options');
    expect(response.statusCode).toBe(404);
  });
});

describe('the lifecycle', () => {
  it('goes through its states, and records a verified local copy', async () => {
    const w = await world();
    const operation = await start(w);
    await w.agent.next('server.restore_request');

    for (const [stage, state] of [
      ['validating', 'validating'],
      ['downloading', 'downloading'],
      ['verifying', 'verifying'],
      ['extracting', 'extracting'],
      ['publishing_local', 'publishing_local'],
    ] as const) {
      w.agent.send(
        envelope('agent.restore_progress', {
          operationId: operation.id,
          stage,
          doneBytes: 10,
          totalBytes: 100,
          cacheHit: stage === 'validating' ? null : false,
        }),
      );
      await barrier(w.agent);
      const current = await read(w, operation.id);
      expect(current.state).toBe(state);
      expect(current.progress).toEqual({ doneBytes: 10, totalBytes: 100 });
    }

    w.agent.send(envelope('agent.restore_result', resultFor(operation)));
    const ack = await w.agent.next('server.restore_ack');
    expect(ack.payload).toEqual({ operationId: operation.id, outcome: 'closed' });

    const done = await read(w, operation.id);
    expect(done.state).toBe('succeeded');
    expect(done.finishedAt).not.toBeNull();
    expect(done.localDirectory).toBe('C:\\vms\\qemu\\Win98');
    expect(done.verified).toMatchObject({
      manifestSha256: MANIFEST_SHA256,
      fileCount: 3,
      verifiedBy: 'agent',
    });
    expect(done.cache).toEqual({
      hit: false,
      downloadedBytes: ARCHIVE_SIZE,
      archiveCached: true,
      totalBytes: ARCHIVE_SIZE,
    });
    expect(await vmState(w)).toMatchObject({
      local_source_version_id: w.versionId,
      execution_state: 'idle',
      content_status: 'verified',
      last_verified_sha256: MANIFEST_SHA256,
    });
    const options = restoreOptionsResponseSchema.parse(
      (await w.admin.get('/admin/vms/qemu/Win98/restore-options')).json(),
    );
    expect(options.agents[0]).toMatchObject({
      eligible: false,
      ineligibleReason: 'local_copy_exists',
      local: { availability: 'present', contentStatus: 'verified', sourceVersionId: w.versionId },
    });
  });

  it('does not let a stage go backwards, or touch another agent’s operation', async () => {
    const w = await world();
    const operation = await start(w);
    await w.agent.next('server.restore_request');
    const report = (stage: string) =>
      envelope('agent.restore_progress', {
        operationId: operation.id,
        stage,
        doneBytes: null,
        totalBytes: null,
        cacheHit: null,
      });
    w.agent.send(report('extracting'));
    await barrier(w.agent);
    w.agent.send(report('downloading'));
    await barrier(w.agent);
    expect((await read(w, operation.id)).state).toBe('extracting');

    const stranger = await pairAgent(w.context.app, w.admin);
    const other = await connect(w.context.app, stranger.credential);
    other.send(report('publishing_local'));
    other.send(envelope('agent.restore_result', resultFor(operation)));
    await other.next('server.restore_ack');
    expect((await read(w, operation.id)).state).toBe('extracting');
    expect(await vmState(w)).toBeUndefined();
  });

  it('answers a repeated result the same way, with one local copy', async () => {
    const w = await world();
    const operation = await start(w);
    await w.agent.next('server.restore_request');
    w.agent.send(envelope('agent.restore_result', resultFor(operation)));
    await w.agent.next('server.restore_ack');
    // The acknowledgement was lost, so the agent says it again.
    w.agent.send(envelope('agent.restore_result', resultFor(operation)));
    const ack = await w.agent.next('server.restore_ack');
    expect(ack.payload).toEqual({ operationId: operation.id, outcome: 'closed' });
    expect((await read(w, operation.id)).state).toBe('succeeded');
    const [rows] = await w.context.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM agent_vm_state WHERE vm_name = ?',
      ['Win98'],
    );
    expect(Number(rows[0]?.total)).toBe(1);
  });

  it('refuses a result with identities it did not issue, and records no copy', async () => {
    for (const overrides of [
      { versionId: randomUUID() },
      { archiveSha256: hash('another archive') },
      { archiveSizeBytes: ARCHIVE_SIZE + 1 },
    ]) {
      const w = await world();
      const operation = await start(w);
      await w.agent.next('server.restore_request');
      w.agent.send(envelope('agent.restore_result', resultFor(operation, overrides)));
      const ack = await w.agent.next('server.restore_ack');
      expect(ack.payload).toEqual({ operationId: operation.id, outcome: 'rejected' });
      const failed = await read(w, operation.id);
      expect(failed.state).toBe('failed');
      expect(failed.error?.code).toBe('invalid_result');
      expect(await vmState(w)).toBeUndefined();
    }
  });

  it('refuses a result for an operation it never issued', async () => {
    const w = await world();
    const operation = await start(w);
    await w.agent.next('server.restore_request');
    const unknown = randomUUID();
    w.agent.send(envelope('agent.restore_result', resultFor({ ...operation, id: unknown }, {})));
    const ack = await w.agent.next('server.restore_ack');
    expect(ack.payload).toEqual({ operationId: unknown, outcome: 'rejected' });
  });

  it('records a failure with its recovery advice, and keeps no local copy', async () => {
    const w = await world();
    const operation = await start(w);
    await w.agent.next('server.restore_request');
    w.agent.send(
      envelope('agent.restore_error', {
        operationId: operation.id,
        code: 'restore_integrity_failed',
        message: 'The archive does not match',
      }),
    );
    const ack = await w.agent.next('server.restore_ack');
    expect(ack.payload).toEqual({ operationId: operation.id, outcome: 'closed' });
    const failed = await read(w, operation.id);
    expect(failed.state).toBe('failed');
    expect(failed.error).toEqual({
      code: 'restore_integrity_failed',
      message: 'The archive does not match',
    });
    expect(failed.recovery).toMatch(/not changed/);
    expect(await vmState(w)).toBeUndefined();
    // A failed operation does not stand in the way of trying again.
    const again = await start(w);
    expect(again.id).not.toBe(operation.id);
  });
});

describe('cancelling', () => {
  it('takes effect at once when nothing has started', async () => {
    const w = await world();
    w.agent.close();
    await waitFor(async () => {
      const options = await w.admin.get('/admin/vms/qemu/Win98/restore-options');
      return restoreOptionsResponseSchema.parse(options.json()).agents[0]?.online === false;
    }, 'the agent to go offline');
    w.agent = await connect(w.context.app, w.paired.credential);
    await sync(w.agent, w.repository.id);
    const operation = await start(w);
    await w.agent.next('server.restore_request');
    const response = await w.admin.request({
      method: 'POST',
      url: `/admin/restores/${operation.id}/cancel`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const cancelled = restoreOperationSchema.parse(response.json());
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.cancelRequested).toBe(true);
  });

  it('asks a connected agent, and ends when it reports back', async () => {
    const w = await world();
    const operation = await start(w);
    await w.agent.next('server.restore_request');
    w.agent.send(
      envelope('agent.restore_progress', {
        operationId: operation.id,
        stage: 'downloading',
        doneBytes: 1,
        totalBytes: 2,
        cacheHit: false,
      }),
    );
    await barrier(w.agent);
    const response = await w.admin.request({
      method: 'POST',
      url: `/admin/restores/${operation.id}/cancel`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(restoreOperationSchema.parse(response.json()).state).toBe('downloading');
    const asked = await w.agent.next('server.restore_cancel');
    expect(asked.payload).toEqual({ operationId: operation.id });

    w.agent.send(
      envelope('agent.restore_error', {
        operationId: operation.id,
        code: 'cancelled',
        message: 'Cancelled',
      }),
    );
    await w.agent.next('server.restore_ack');
    expect((await read(w, operation.id)).state).toBe('cancelled');
  });

  it('is too late once the VM is being published', async () => {
    const w = await world();
    const operation = await start(w);
    await w.agent.next('server.restore_request');
    w.agent.send(
      envelope('agent.restore_progress', {
        operationId: operation.id,
        stage: 'publishing_local',
        doneBytes: null,
        totalBytes: null,
        cacheHit: null,
      }),
    );
    await barrier(w.agent);
    const response = await w.admin.request({
      method: 'POST',
      url: `/admin/restores/${operation.id}/cancel`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('restore_too_late');
  });

  it('tells the truth when the VM was published before the cancellation arrived', async () => {
    const w = await world();
    const operation = await start(w);
    await w.agent.next('server.restore_request');
    w.agent.send(
      envelope('agent.restore_progress', {
        operationId: operation.id,
        stage: 'downloading',
        doneBytes: null,
        totalBytes: null,
        cacheHit: null,
      }),
    );
    await barrier(w.agent);
    await w.admin.request({ method: 'POST', url: `/admin/restores/${operation.id}/cancel` });
    w.agent.send(envelope('agent.restore_result', resultFor(operation)));
    await w.agent.next('server.restore_ack');
    const done = await read(w, operation.id);
    expect(done.state).toBe('partial_success');
    expect(done.error?.code).toBe('restore_cancel_too_late');
    expect(await vmState(w)).toMatchObject({ execution_state: 'idle', content_status: 'verified' });
  });
});

describe('recovery', () => {
  it('sends a queued operation when the agent comes back', async () => {
    const w = await world();
    w.agent.close();
    await waitFor(async () => {
      const options = await w.admin.get('/admin/vms/qemu/Win98/restore-options');
      return restoreOptionsResponseSchema.parse(options.json()).agents[0]?.online === false;
    }, 'the agent to go offline');
    // Created while it was connected, by a coordinator that could not deliver it.
    const operationId = randomUUID();
    await w.context.pool.execute(
      `INSERT INTO restore_operations
         (id, agent_id, repository_id, emulator_type, vm_name, version_id, archive_key,
          archive_sha256, archive_size_bytes)
       VALUES (?, ?, ?, 'qemu', 'Win98', ?, ?, ?, ?)`,
      [
        operationId,
        w.paired.agentId,
        w.repository.id,
        w.versionId,
        archiveObjectKey({ emulatorType: 'qemu', vmName: 'Win98' }, w.versionId),
        ARCHIVE_SHA256,
        ARCHIVE_SIZE,
      ],
    );
    w.agent = await connect(w.context.app, w.paired.credential);
    await sync(w.agent, w.repository.id);
    const request = await w.agent.next('server.restore_request');
    expect((request.payload as RestoreRequestPayload).operationId).toBe(operationId);
  });

  it('fails an operation the agent has forgotten, once it has started', async () => {
    const w = await world();
    const operation = await start(w);
    await w.agent.next('server.restore_request');
    w.agent.send(
      envelope('agent.restore_progress', {
        operationId: operation.id,
        stage: 'downloading',
        doneBytes: null,
        totalBytes: null,
        cacheHit: null,
      }),
    );
    await barrier(w.agent);
    await sync(w.agent, w.repository.id);
    const failed = await read(w, operation.id);
    expect(failed.state).toBe('failed');
    expect(failed.error?.code).toBe('agent_lost_operation');
  });

  it('keeps an operation going while the agent says it is running', async () => {
    const w = await world();
    const operation = await start(w);
    await w.agent.next('server.restore_request');
    await sync(w.agent, w.repository.id, {
      operations: [{ operationId: operation.id, phase: 'running' }],
    });
    expect((await read(w, operation.id)).state).toBe('queued');
  });

  it('tells an agent to stop work that ended here while it was away', async () => {
    const w = await world();
    const operation = await start(w);
    await w.agent.next('server.restore_request');
    await w.context.pool.execute(
      `UPDATE restore_operations SET state = 'cancelled', finished_at = UTC_TIMESTAMP(3)
       WHERE id = ?`,
      [operation.id],
    );
    await sync(w.agent, w.repository.id, {
      operations: [{ operationId: operation.id, phase: 'running' }],
    });
    const asked = await w.agent.next('server.restore_cancel');
    expect(asked.payload).toEqual({ operationId: operation.id });
  });

  it('survives an API restart: a new server carries on from the database', async () => {
    const w = await world();
    const operation = await start(w);
    await w.agent.next('server.restore_request');
    const restarted = await w.context.buildAnother();
    await restarted.listen({ host: '127.0.0.1', port: 0 });
    const client = await signedInAdminOn(w, restarted);
    const agent = await connect(restarted, w.paired.credential);
    agent.send(
      envelope('agent.restore_sync', {
        operations: [{ operationId: operation.id, phase: 'published' }],
        capabilities: capabilities(w.repository.id),
        localCopies: [],
      }),
    );
    agent.send(envelope('agent.restore_result', resultFor(operation)));
    const ack = await agent.next('server.restore_ack');
    expect(ack.payload).toEqual({ operationId: operation.id, outcome: 'closed' });
    const response = await client.get(`/admin/restores/${operation.id}`);
    expect(restoreOperationSchema.parse(response.json()).state).toBe('succeeded');
  });

  it('marks what a revoked agent was doing as failed', async () => {
    const w = await world();
    const operation = await start(w);
    await w.agent.next('server.restore_request');
    const revoked = await w.admin.request({
      method: 'POST',
      url: `/admin/agents/${w.paired.agentId}/revoke`,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    await waitFor(
      async () => (await read(w, operation.id)).state === 'failed',
      'the operation to fail',
    );
    expect((await read(w, operation.id)).error?.code).toBe('agent_revoked');
  });
});

describe('local state', () => {
  async function restored(w: World): Promise<void> {
    const operation = await start(w);
    await w.agent.next('server.restore_request');
    w.agent.send(envelope('agent.restore_result', resultFor(operation)));
    await w.agent.next('server.restore_ack');
  }

  const copy = (w: World, status: string) => ({
    localCopies: [{ emulatorType: 'qemu', vmName: 'Win98', versionId: w.versionId, status }],
  });

  it('lowers "verified" on a new connection, and never raises it', async () => {
    const w = await world();
    await restored(w);
    await sync(w.agent, w.repository.id, copy(w, 'unverified'));
    expect(await vmState(w)).toMatchObject({ content_status: 'unverified' });
  });

  it('records a copy that differs, and one that is gone', async () => {
    const w = await world();
    await restored(w);
    await sync(w.agent, w.repository.id, copy(w, 'modified'));
    expect(await vmState(w)).toMatchObject({ content_status: 'modified' });
    await sync(w.agent, w.repository.id, copy(w, 'unverified'));
    expect(await vmState(w)).toMatchObject({ content_status: 'modified' });
    await sync(w.agent, w.repository.id, copy(w, 'absent'));
    expect(await vmState(w)).toMatchObject({
      execution_state: 'absent',
      content_status: 'unverified',
    });
    // Gone, so it can be restored again.
    const again = await start(w);
    expect(again.state).toBe('queued');
  });

  it('ignores a report about a version this copy did not come from', async () => {
    const w = await world();
    await restored(w);
    await sync(w.agent, w.repository.id, {
      localCopies: [
        { emulatorType: 'qemu', vmName: 'Win98', versionId: randomUUID(), status: 'absent' },
      ],
    });
    expect(await vmState(w)).toMatchObject({ execution_state: 'idle' });
  });

  async function discover(
    w: World,
    vms: { emulatorType: string; vmName: string }[],
    status = 'ok',
  ) {
    const started = await w.admin.request({
      method: 'POST',
      url: `/admin/agents/${w.paired.agentId}/discovery`,
    });
    expect(started.statusCode, started.body).toBe(202);
    const request = await w.agent.next('server.discovery_request');
    w.agent.send(
      envelope('agent.discovery_result', {
        operationId: request.payload.operationId,
        hostPlatform: 'windows',
        emulators: [{ emulatorType: 'qemu', status, truncated: false }],
        vms: vms.map((vm) => ({ ...vm, markers: ['run.bat'], hostCompatible: true })),
        skipped: [],
      }),
    );
    await barrier(w.agent);
    return waitFor(async () => {
      const state = await w.admin.get(`/admin/agents/${w.paired.agentId}/discovery`);
      const body = state.json<{ operation: { status: string; vms: { registered: boolean }[] } }>();
      return body.operation.status === 'completed' ? body.operation : undefined;
    }, 'the discovery to complete');
  }

  it('recognizes a restored VM in discovery as registered, and not as a new candidate', async () => {
    const w = await world();
    await restored(w);
    const operation = await discover(w, [{ emulatorType: 'qemu', vmName: 'Win98' }]);
    expect(operation.vms[0]?.registered).toBe(true);
    expect(await vmState(w)).toMatchObject({ execution_state: 'idle' });
  });

  it('notices in discovery that a copy is gone, and that it came back', async () => {
    const w = await world();
    await restored(w);
    await discover(w, []);
    expect(await vmState(w)).toMatchObject({
      execution_state: 'absent',
      content_status: 'unverified',
    });
    await discover(w, [{ emulatorType: 'qemu', vmName: 'WIN98' }]);
    expect(await vmState(w)).toMatchObject({
      execution_state: 'unknown',
      content_status: 'unverified',
    });
  });

  it('concludes nothing from a scan that could not run', async () => {
    const w = await world();
    await restored(w);
    await discover(w, [], 'base_path_missing');
    expect(await vmState(w)).toMatchObject({ execution_state: 'idle' });
  });

  it('lets a restored VM upload screenshots, since it now holds a copy', async () => {
    const w = await world();
    await restored(w);
    const response = await w.context.app.inject({
      method: 'GET',
      url: '/api/v1/agent/media/vms',
      headers: {
        authorization: `Bearer ${w.paired.credential}`,
        [MEDIA_PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.stringify(response.json())).toContain('Win98');
  });
});

describe('listing', () => {
  it('filters by VM and by agent', async () => {
    const w = await world();
    const operation = await start(w);
    const list = async (query: string) =>
      restoreListResponseSchema.parse((await w.admin.get(`/admin/restores${query}`)).json())
        .operations;
    expect((await list('?emulatorType=qemu&vmName=Win98')).map((item) => item.id)).toEqual([
      operation.id,
    ]);
    expect(await list('?emulatorType=qemu&vmName=Other')).toEqual([]);
    expect((await list(`?agentId=${w.paired.agentId}`)).map((item) => item.id)).toEqual([
      operation.id,
    ]);
    expect(await list(`?agentId=${randomUUID()}`)).toEqual([]);
  });
});

async function signedInAdminOn(w: World, app: FastifyInstance): Promise<TestClient> {
  const client = new TestClient(app);
  client.cookie = w.admin.cookie;
  client.csrfToken = w.admin.csrfToken;
  return client;
}
