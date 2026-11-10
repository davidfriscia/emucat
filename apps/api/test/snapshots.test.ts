/**
 * Snapshots, the version tree, historical restores and Remote Snapshot working copies, through the real
 * API, on a real database, over a real WebSocket. The agent is a script, so that every message a real
 * agent could send, repeat, lose or get wrong can be arranged exactly. See decisions 0037 to 0039.
 */
import { randomUUID } from 'node:crypto';
import {
  archiveObjectKey,
  buildVersionTree,
  registrationOperationSchema,
  restoreOptionsResponseSchema,
  versionTreeResponseSchema,
  vmWorkspaceSchema,
  type RegistrationOperation,
  type RepositorySummary,
  type VersionTreeResponse,
  type VmWorkspace,
} from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, describe, expect, it } from 'vitest';
import {
  envelope,
  GENEROUS_RATE_LIMITS,
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

const SHA = 'a'.repeat(64);
const MANIFEST_SHA = 'b'.repeat(64);

const worlds: BrowserTestContext[] = [];
afterAll(async () => {
  await Promise.all(worlds.map((world) => world.close()));
});

interface World {
  context: BrowserTestContext;
  admin: TestClient;
  agent: TestAgent;
  paired: PairedAgent;
  repository: RepositorySummary;
  masterId: string;
}

interface Capabilities {
  snapshots?: boolean;
  workspaces?: string[] | null;
  modes?: string[];
}

async function barrier(agent: TestAgent): Promise<void> {
  agent.send(envelope('agent.heartbeat', {}));
  await agent.next('server.heartbeat_ack');
}

async function world(capabilities: Capabilities = {}): Promise<World> {
  const context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
  worlds.push(context);
  await context.app.listen({ host: '127.0.0.1', port: 0 });
  const admin = await signedInAdmin(context);
  const paired = await pairAgent(context.app, admin);
  const created = await admin.request({
    method: 'POST',
    url: '/admin/repositories',
    payload: { name: 'NAS', host: 'nas.example', port: 22, username: 'emucat', remoteRoot: '/r' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const repository = created.json<RepositorySummary>();
  const associated = await admin.request({
    method: 'PUT',
    url: `/admin/repositories/${repository.id}/agents/${paired.agentId}`,
  });
  expect(associated.statusCode, associated.body).toBe(200);
  // The restore capabilities must name the repository for a restore to be possible.
  const agent = await TestAgent.connect(wsUrl(context.app), paired.credential);
  await agent.hello();
  const { pool } = context;
  await insertVm(pool, { vmName: 'Win98', visibility: 'public' });
  await insertVm(pool, { vmName: 'Other' });
  const masterId = await insertMaster(context, 'Win98', repository.id, paired.agentId);
  await insertMaster(context, 'Other', repository.id, paired.agentId);
  await pool.execute(
    `INSERT INTO agent_vm_state
       (agent_id, emulator_type, vm_name, local_source_version_id, execution_state, content_status,
        last_verified_at, last_verified_sha256)
     VALUES (?, 'qemu', 'Win98', ?, 'idle', 'verified', UTC_TIMESTAMP(3), ?)`,
    [paired.agentId, masterId, MANIFEST_SHA],
  );
  const w = { context, admin, agent, paired, repository, masterId };
  await resync(w, capabilities);
  return w;
}

/** Sends the three syncs an agent sends after each welcome, naming the repository it has settings for. */
async function resync(w: World, capabilities: Capabilities = {}): Promise<void> {
  const { agent } = w;
  agent.send(
    envelope('agent.registration_sync', {
      operations: [],
      ...(capabilities.snapshots === false ? {} : { snapshots: true }),
    }),
  );
  agent.send(
    envelope('agent.restore_sync', {
      operations: [],
      capabilities: {
        emulators: [{ emulatorType: 'qemu', basePath: 'C:\\vms\\qemu' }],
        repositoryIds: [w.repository.id],
        cacheMaxBytes: 1_000_000,
        cacheUsedBytes: 0,
      },
      localCopies: [],
      ...(capabilities.workspaces === null ? {} : { workspaces: capabilities.workspaces ?? [] }),
    }),
  );
  agent.send(
    envelope('agent.execution_sync', {
      sessions: [],
      capabilities: {
        emulators: [{ emulatorType: 'qemu', launchable: true, problem: null }],
        modes: capabilities.modes ?? ['local', 'remote_snapshot'],
      },
      verifications: [],
    }),
  );
  await barrier(agent);
}

async function insertMaster(
  context: BrowserTestContext,
  vmName: string,
  repositoryId: string,
  agentId: string,
): Promise<string> {
  const id = randomUUID();
  await context.pool.execute(
    `INSERT INTO vm_versions
       (id, emulator_type, vm_name, kind, repository_id, archive_key, archive_sha256,
        archive_size_bytes, created_by_agent_id)
     VALUES (?, 'qemu', ?, 'master', ?, ?, ?, 2048, ?)`,
    [
      id,
      vmName,
      repositoryId,
      archiveObjectKey({ emulatorType: 'qemu', vmName }, id),
      SHA,
      agentId,
    ],
  );
  return id;
}

async function errorCode(response: { json: <T>() => T }): Promise<string> {
  return response.json<{ error: { code: string } }>().error.code;
}

function snapshotRequest(w: World, overrides: object = {}, vmName = 'Win98') {
  return w.admin.request({
    method: 'POST',
    url: `/admin/vms/qemu/${vmName}/snapshots`,
    payload: {
      agentId: w.paired.agentId,
      parentVersionId: w.masterId,
      requestId: randomUUID(),
      ...overrides,
    },
  });
}

async function snapshot(w: World, overrides: object = {}): Promise<RegistrationOperation> {
  const response = await snapshotRequest(w, overrides);
  expect(response.statusCode, response.body).toBe(202);
  return registrationOperationSchema.parse(response.json());
}

function resultFor(operation: RegistrationOperation, overrides: object = {}) {
  return {
    operationId: operation.id,
    versionId: operation.versionId,
    archiveKey: operation.archiveKey,
    archiveSizeBytes: 4096,
    archiveSha256: 'c'.repeat(64),
    manifestVersion: 1,
    manifestSha256: 'd'.repeat(64),
    fileCount: 4,
    totalUncompressedBytes: 8192,
    ...overrides,
  };
}

/** The agent's side of a successful snapshot: result, committed answer, cleanup report, closed. */
async function complete(w: World, operation: RegistrationOperation): Promise<void> {
  const request = await w.agent.next('server.registration_request');
  expect(request.payload.operationId).toBe(operation.id);
  w.agent.send(envelope('agent.registration_result', resultFor(operation)));
  const ack = await w.agent.next('server.registration_ack');
  expect(ack.payload).toEqual({
    operationId: operation.id,
    outcome: 'committed',
    versionId: operation.versionId,
    removeLocal: false,
  });
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
}

async function tree(w: World, vmName = 'Win98'): Promise<VersionTreeResponse> {
  const response = await w.admin.get(`/admin/vms/qemu/${vmName}/versions`);
  expect(response.statusCode, response.body).toBe(200);
  return versionTreeResponseSchema.parse(response.json());
}

async function localSource(w: World): Promise<string | null> {
  const [rows] = await w.context.pool.execute<RowDataPacket[]>(
    `SELECT local_source_version_id FROM agent_vm_state
     WHERE agent_id = ? AND emulator_type = 'qemu' AND vm_name = 'Win98'`,
    [w.paired.agentId],
  );
  return (rows[0]?.local_source_version_id as string | null | undefined) ?? null;
}

async function versionCount(w: World): Promise<number> {
  const [rows] = await w.context.pool.execute<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM vm_versions WHERE vm_name = 'Win98'",
  );
  return Number(rows[0]?.n);
}

/** Restores a version onto the persistent copy, as an administrator and the agent would. */
async function restoreVersion(w: World, versionId: string): Promise<void> {
  // A restore never overwrites: the copy has to be gone first, as a discovery would report.
  await w.context.pool.execute(
    `UPDATE agent_vm_state SET execution_state = 'absent', content_status = 'unverified',
       last_verified_at = NULL, last_verified_sha256 = NULL
     WHERE agent_id = ? AND vm_name = 'Win98'`,
    [w.paired.agentId],
  );
  const created = await w.admin.request({
    method: 'POST',
    url: '/admin/restores',
    payload: { agentId: w.paired.agentId, emulatorType: 'qemu', vmName: 'Win98', versionId },
  });
  expect(created.statusCode, created.body).toBe(202);
  const operation = created.json<{ id: string; archive: { sizeBytes: number; sha256: string } }>();
  const request = await w.agent.next('server.restore_request');
  expect(request.payload).toMatchObject({ versionId });
  expect(request.payload).not.toHaveProperty('workspaceId');
  w.agent.send(
    envelope(
      'agent.restore_result',
      restoreResult(operation.id, versionId, operation, undefined, request.payload.manifestSha256),
    ),
  );
  expect((await w.agent.next('server.restore_ack')).payload.outcome).toBe('closed');
}

function restoreResult(
  operationId: string,
  versionId: string,
  archive: { archive: { sizeBytes: number; sha256: string } },
  directory = 'C:\\vms\\qemu\\Win98',
  manifestSha256: string | null = null,
) {
  return {
    operationId,
    versionId,
    archiveSizeBytes: archive.archive.sizeBytes,
    archiveSha256: archive.archive.sha256,
    manifestVersion: 1,
    manifestSha256: manifestSha256 ?? 'e'.repeat(64),
    fileCount: 3,
    totalUncompressedBytes: 4096,
    localDirectory: directory,
    cache: { hit: false, downloadedBytes: 1, archiveCached: true, totalBytes: 1 },
  };
}

describe('creating a snapshot', () => {
  it('publishes an immutable child of the local copy’s version, and moves the copy to it', async () => {
    const w = await world();
    const operation = await snapshot(w);
    expect(operation).toMatchObject({
      mode: 'snapshot',
      state: 'queued',
      parentVersionId: w.masterId,
      workspaceId: null,
      repositoryId: w.repository.id,
    });
    expect(operation.snapshotName).toMatch(/^Win98_\d{12}$/);
    expect(operation.archiveKey).toBe(
      archiveObjectKey({ emulatorType: 'qemu', vmName: 'Win98' }, operation.versionId),
    );

    const request = await w.agent.next('server.registration_request');
    expect(request.payload).toEqual({
      operationId: operation.id,
      emulatorType: 'qemu',
      vmName: 'Win98',
      mode: 'snapshot',
      repositoryId: w.repository.id,
      versionId: operation.versionId,
      archiveKey: operation.archiveKey,
      parentVersionId: w.masterId,
    });
    // Nothing is in the catalog until the agent reports a verified, published archive.
    expect(await versionCount(w)).toBe(1);
    w.agent.received.unshift(request);
    await complete(w, operation);

    const [rows] = await w.context.pool.execute<RowDataPacket[]>(
      'SELECT * FROM vm_versions WHERE id = ?',
      [operation.versionId],
    );
    expect(rows[0]).toMatchObject({
      kind: 'snapshot',
      parent_version_id: w.masterId,
      snapshot_name: operation.snapshotName,
      archive_sha256: 'c'.repeat(64),
      created_by_agent_id: w.paired.agentId,
    });
    expect(await localSource(w)).toBe(operation.versionId);
    const done = registrationOperationSchema.parse(
      (await w.admin.get(`/admin/registrations/${operation.id}`)).json(),
    );
    expect(done).toMatchObject({ state: 'succeeded', localCopy: 'preserved' });

    // The archive cannot be changed afterwards, by anything.
    await expect(
      w.context.pool.execute('UPDATE vm_versions SET archive_sha256 = ? WHERE id = ?', [
        'f'.repeat(64),
        operation.versionId,
      ]),
    ).rejects.toThrow(/immutable/);

    const versions = await tree(w);
    expect(versions.rootVersionId).toBe(w.masterId);
    expect(versions.versions.map((version) => [version.id, version.parentVersionId])).toEqual([
      [w.masterId, null],
      [operation.versionId, w.masterId],
    ]);
    const child = versions.versions[1];
    expect(child).toMatchObject({
      kind: 'snapshot',
      snapshotName: operation.snapshotName,
      archiveSizeBytes: 4096,
      manifest: { sha256: 'd'.repeat(64), fileCount: 4, verifiedBy: 'agent' },
      available: true,
      holders: [{ agentId: w.paired.agentId, kind: 'local', contentStatus: 'verified' }],
    });
    expect(versions.versions[0]?.childVersionIds).toEqual([operation.versionId]);
    expect(buildVersionTree(versions.versions).ok).toBe(true);
    // No location or credential, even for an administrator.
    expect(JSON.stringify(versions)).not.toMatch(/archives\/|nas\.example|C:\\\\|remoteRoot/);
  });

  it('branches from a restored older version, never from the newest one', async () => {
    const w = await world();
    const a = await snapshot(w);
    await complete(w, a);
    expect(await localSource(w)).toBe(a.versionId);

    // The master is restored again, so the local files are the master's.
    await restoreVersion(w, w.masterId);
    expect(await localSource(w)).toBe(w.masterId);

    // Asking for a child of the newest version is refused: that is not where these files came from.
    const wrong = await snapshotRequest(w, { parentVersionId: a.versionId });
    expect(wrong.statusCode).toBe(409);
    expect(await errorCode(wrong)).toBe('snapshot_parent_mismatch');

    const b = await snapshot(w, { parentVersionId: w.masterId });
    await complete(w, b);

    // And from the restored historical snapshot, a third branch level.
    await restoreVersion(w, a.versionId);
    const c = await snapshot(w, { parentVersionId: a.versionId });
    await complete(w, c);

    const versions = await tree(w);
    const built = buildVersionTree(versions.versions);
    if (!built.ok || !built.root) throw new Error('not a tree');
    expect(built.root.children.map((entry) => entry.node.id)).toEqual([a.versionId, b.versionId]);
    expect(built.root.children[0]?.children.map((entry) => entry.node.id)).toEqual([c.versionId]);
    expect(await versionCount(w)).toBe(4);
  });

  it('refuses parents that are not this VM’s, or not where the local files came from', async () => {
    const w = await world();
    const [other] = await w.context.pool.execute<RowDataPacket[]>(
      "SELECT id FROM vm_versions WHERE vm_name = 'Other'",
    );
    const crossVm = await snapshotRequest(w, { parentVersionId: other[0]?.id as string });
    expect(crossVm.statusCode).toBe(404);
    expect(await errorCode(crossVm)).toBe('version_not_found');

    const unknown = await snapshotRequest(w, { parentVersionId: randomUUID() });
    expect(unknown.statusCode).toBe(404);

    const otherVm = await snapshotRequest(w, {}, 'Other');
    expect(otherVm.statusCode, 'a version of Win98 named under Other').toBe(404);

    await w.context.pool.execute(
      'UPDATE agent_vm_state SET local_source_version_id = NULL WHERE agent_id = ?',
      [w.paired.agentId],
    );
    const lineage = await snapshotRequest(w);
    expect(await errorCode(lineage)).toBe('snapshot_parent_unknown');

    await w.context.pool.execute(
      "UPDATE agent_vm_state SET execution_state = 'absent' WHERE agent_id = ?",
      [w.paired.agentId],
    );
    expect(await errorCode(await snapshotRequest(w))).toBe('local_copy_missing');

    expect(w.agent.received.filter((m) => m.type === 'server.registration_request')).toEqual([]);
    expect(await versionCount(w)).toBe(1);
  });

  it('refuses while the VM runs, or may be running', async () => {
    const w = await world();
    for (const state of ['running', 'unknown', 'requested']) {
      const id = randomUUID();
      await w.context.pool.execute(
        `INSERT INTO vm_sessions (id, agent_id, emulator_type, vm_name, mode, execution_state)
         VALUES (?, ?, 'qemu', 'Win98', 'local', ?)`,
        [id, w.paired.agentId, state],
      );
      const response = await snapshotRequest(w);
      expect(response.statusCode).toBe(409);
      expect(await errorCode(response), state).toBe('vm_running');
      await w.context.pool.execute(
        "UPDATE vm_sessions SET execution_state = 'stopped', ended_at = UTC_TIMESTAMP(3) WHERE id = ?",
        [id],
      );
    }
    expect((await snapshotRequest(w)).statusCode).toBe(202);
  });

  it('refuses an agent that cannot snapshot, and an agent that is away', async () => {
    const w = await world({ snapshots: false });
    expect(await errorCode(await snapshotRequest(w))).toBe('agent_cannot_snapshot');
    w.agent.close();
    await waitFor(async () => {
      const response = await snapshotRequest(w);
      return (await errorCode(response)) === 'agent_offline' ? true : undefined;
    }, 'the agent to be offline');
  });

  it('creates one snapshot for a repeated request, and refuses a reused request ID', async () => {
    const w = await world();
    const requestId = randomUUID();
    const first = await snapshot(w, { requestId });
    const again = await snapshot(w, { requestId });
    expect(again.id).toBe(first.id);
    expect(again.versionId).toBe(first.versionId);

    const reused = await snapshotRequest(w, { requestId, agentId: randomUUID() });
    expect(reused.statusCode).toBe(409);
    expect(await errorCode(reused)).toBe('request_id_reused');

    await barrier(w.agent);
    expect(w.agent.received.filter((m) => m.type === 'server.registration_request')).toHaveLength(
      1,
    );
    const [rows] = await w.context.pool.execute<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM registration_operations WHERE mode = 'snapshot'",
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('lets one of two concurrent requests through', async () => {
    const w = await world();
    const responses = await Promise.all([snapshotRequest(w), snapshotRequest(w)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
    const refused = responses.find((response) => response.statusCode === 409);
    expect(await errorCode(refused as never)).toBe('operation_in_progress');
  });

  it('answers a repeated result with the same commit, and no second version', async () => {
    const w = await world();
    const operation = await snapshot(w);
    await w.agent.next('server.registration_request');
    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    await w.agent.next('server.registration_ack');
    // The answer was lost: the agent repeats its report on the next heartbeat.
    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    const again = await w.agent.next('server.registration_ack');
    expect(again.payload).toMatchObject({ outcome: 'committed', removeLocal: false });
    expect(await versionCount(w)).toBe(2);
  });

  it('survives a failed database commit, keeping the published archive for the next report', async () => {
    const w = await world();
    const operation = await snapshot(w);
    await w.agent.next('server.registration_request');
    await w.context.pool.query(
      `CREATE TRIGGER fail_snapshot BEFORE INSERT ON vm_versions FOR EACH ROW
       SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'simulated commit failure'`,
    );
    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    await barrier(w.agent);
    // No answer: the agent keeps its archive and its journal, and reports again.
    expect(w.agent.received.filter((m) => m.type === 'server.registration_ack')).toEqual([]);
    const stuck = registrationOperationSchema.parse(
      (await w.admin.get(`/admin/registrations/${operation.id}`)).json(),
    );
    expect(stuck.state).toBe('committing');
    expect(await versionCount(w)).toBe(1);
    expect(await localSource(w), 'the local copy is still the master’s').toBe(w.masterId);

    await w.context.pool.query('DROP TRIGGER fail_snapshot');
    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('committed');
    expect(await versionCount(w)).toBe(2);
    expect(await localSource(w)).toBe(operation.versionId);
  });

  it('tells the agent to delete what it published when the snapshot was cancelled first', async () => {
    const w = await world();
    const operation = await snapshot(w);
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
    const cancelled = await w.admin.request({
      method: 'POST',
      url: `/admin/registrations/${operation.id}/cancel`,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    await w.agent.next('server.registration_cancel');
    // The result got there first on the agent, but after the cancellation here.
    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    const ack = await w.agent.next('server.registration_ack');
    expect(ack.payload).toMatchObject({ outcome: 'rejected', deletePublished: true });
    expect(await versionCount(w)).toBe(1);
  });

  it('refuses a result with identities it did not issue', async () => {
    const w = await world();
    const operation = await snapshot(w);
    await w.agent.next('server.registration_request');
    w.agent.send(
      envelope('agent.registration_result', resultFor(operation, { versionId: randomUUID() })),
    );
    const ack = await w.agent.next('server.registration_ack');
    expect(ack.payload.outcome).toBe('rejected');
    expect(ack.payload).not.toHaveProperty('deletePublished', true);
    expect(await versionCount(w)).toBe(1);
  });

  it('sends a queued snapshot again, with its parent, when the agent reconnects', async () => {
    const w = await world();
    const operation = await snapshot(w);
    await w.agent.next('server.registration_request');
    // The request was lost with the connection: the agent never started it.
    w.agent.close();
    const back = await TestAgent.connect(wsUrl(w.context.app), w.paired.credential);
    await back.hello();
    w.agent = back;
    await resync(w);
    const again = await w.agent.next('server.registration_request');
    expect(again.payload).toMatchObject({
      operationId: operation.id,
      versionId: operation.versionId,
      mode: 'snapshot',
      parentVersionId: w.masterId,
    });
    w.agent.received.unshift(again);
    await complete(w, operation);
    expect(await versionCount(w)).toBe(2);
  });
});

describe('restoring historical versions', () => {
  it('offers every version, and restores a snapshot like a master', async () => {
    const w = await world();
    const a = await snapshot(w);
    await complete(w, a);
    const options = restoreOptionsResponseSchema.parse(
      (await w.admin.get('/admin/vms/qemu/Win98/restore-options')).json(),
    );
    expect(options.master?.versionId).toBe(w.masterId);
    expect(options.versions.map((version) => [version.versionId, version.kind])).toEqual([
      [w.masterId, 'master'],
      [a.versionId, 'snapshot'],
    ]);
    expect(options.versions[1]).toMatchObject({
      parentVersionId: w.masterId,
      snapshotName: a.snapshotName,
      manifestSha256: 'd'.repeat(64),
    });
    await restoreVersion(w, a.versionId);
    expect(await localSource(w)).toBe(a.versionId);
  });

  it('still never restores over a local copy', async () => {
    const w = await world();
    const refused = await w.admin.request({
      method: 'POST',
      url: '/admin/restores',
      payload: {
        agentId: w.paired.agentId,
        emulatorType: 'qemu',
        vmName: 'Win98',
        versionId: w.masterId,
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(await errorCode(refused)).toBe('local_copy_exists');
  });
});

describe('Remote Snapshot', () => {
  function createWorkspace(w: World, overrides: object = {}) {
    return w.admin.request({
      method: 'POST',
      url: '/admin/vms/qemu/Win98/workspaces',
      payload: {
        agentId: w.paired.agentId,
        versionId: w.masterId,
        requestId: randomUUID(),
        launch: true,
        ...overrides,
      },
    });
  }

  async function readWorkspace(w: World, id: string): Promise<VmWorkspace> {
    const response = await w.admin.get(`/admin/workspaces/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return vmWorkspaceSchema.parse(response.json());
  }

  /** A working copy restored and launched, as far as the agent's first running report. */
  async function readyAndRunning(w: World) {
    const created = await createWorkspace(w);
    expect(created.statusCode, created.body).toBe(202);
    const workspace = vmWorkspaceSchema.parse(created.json());
    const restore = await w.agent.next('server.restore_request');
    expect(restore.payload).toMatchObject({ workspaceId: workspace.id, versionId: w.masterId });
    w.agent.send(
      envelope(
        'agent.restore_result',
        restoreResult(
          restore.payload.operationId,
          w.masterId,
          { archive: { sizeBytes: 2048, sha256: SHA } },
          `C:\\state\\workspaces\\${workspace.id}\\Win98`,
        ),
      ),
    );
    await w.agent.next('server.restore_ack');
    const launch = await w.agent.next('server.vm_launch');
    expect(launch.payload).toMatchObject({
      mode: 'remote_snapshot',
      workspaceId: workspace.id,
      versionId: w.masterId,
    });
    const status = {
      sessionId: launch.payload.sessionId,
      emulatorType: 'qemu',
      vmName: 'Win98',
      state: 'running',
      pid: 4242,
      processStartedAt: '2026-11-07T10:00:00.000Z',
      startedAt: '2026-11-07T10:00:00.100Z',
      endedAt: null,
      exitCode: null,
      stopRequested: false,
      gracefulStopAvailable: true,
      code: null,
      message: null,
    };
    w.agent.send(envelope('agent.vm_execution_status', status));
    await barrier(w.agent);
    return { workspace, sessionId: launch.payload.sessionId, status };
  }

  async function stop(w: World, status: object): Promise<void> {
    w.agent.send(
      envelope('agent.vm_execution_status', {
        ...status,
        state: 'exited',
        endedAt: '2026-11-07T10:05:00.000Z',
        exitCode: 0,
      }),
    );
    await w.agent.next('server.vm_execution_ack');
  }

  it('prepares a working copy, launches it, and preserves it only when asked', async () => {
    const w = await world();
    const { workspace, sessionId, status } = await readyAndRunning(w);
    let current = await readWorkspace(w, workspace.id);
    expect(current).toMatchObject({
      state: 'ready',
      baseVersionId: w.masterId,
      sourceVersionId: w.masterId,
      mayHaveChanges: true,
      localDirectory: `C:\\state\\workspaces\\${workspace.id}\\Win98`,
    });
    // The persistent copy is untouched by any of this.
    expect(await localSource(w)).toBe(w.masterId);

    // Running: nothing can be preserved or discarded.
    const early = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspace.id}/snapshot`,
      payload: { requestId: randomUUID() },
    });
    expect(await errorCode(early)).toBe('vm_running');
    const discardEarly = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspace.id}/discard`,
      payload: { confirmVmName: 'Win98' },
    });
    expect(await errorCode(discardEarly)).toBe('vm_running');

    await stop(w, status);
    const [sessions] = await w.context.pool.execute<RowDataPacket[]>(
      'SELECT workspace_id, mode FROM vm_sessions WHERE id = ?',
      [sessionId],
    );
    expect(sessions[0]).toMatchObject({ workspace_id: workspace.id, mode: 'remote_snapshot' });
    // Stopping publishes nothing.
    expect(await versionCount(w)).toBe(1);
    expect(w.agent.received.filter((m) => m.type === 'server.registration_request')).toEqual([]);

    const preserved = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspace.id}/snapshot`,
      payload: { requestId: randomUUID() },
    });
    expect(preserved.statusCode, preserved.body).toBe(202);
    const operation = registrationOperationSchema.parse(preserved.json());
    expect(operation).toMatchObject({ parentVersionId: w.masterId, workspaceId: workspace.id });
    const request = await w.agent.next('server.registration_request');
    expect(request.payload).toMatchObject({
      workspaceId: workspace.id,
      parentVersionId: w.masterId,
    });
    w.agent.received.unshift(request);
    await complete(w, operation);

    current = await readWorkspace(w, workspace.id);
    expect(current).toMatchObject({ sourceVersionId: operation.versionId, mayHaveChanges: false });
    expect(await localSource(w), 'still the persistent copy’s own').toBe(w.masterId);
    const versions = await tree(w);
    expect(versions.versions.find((v) => v.id === operation.versionId)?.holders).toEqual([
      expect.objectContaining({ kind: 'workspace', workspaceId: workspace.id }),
    ]);

    // A second session and preservation branch from the snapshot just made.
    const relaunched = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspace.id}/launch`,
      payload: { requestId: randomUUID() },
    });
    expect(relaunched.statusCode, relaunched.body).toBe(202);
    const second = await w.agent.next('server.vm_launch');
    expect(second.payload).toMatchObject({ versionId: operation.versionId });
    await stop(w, { ...status, sessionId: second.payload.sessionId });
    expect((await readWorkspace(w, workspace.id)).mayHaveChanges).toBe(true);

    // Unpreserved changes need the name typed to be thrown away.
    const unconfirmed = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspace.id}/discard`,
      payload: {},
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(await errorCode(unconfirmed)).toBe('confirmation_required');
    const discarding = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspace.id}/discard`,
      payload: { confirmVmName: 'win98' },
    });
    expect(discarding.statusCode, discarding.body).toBe(200);
    expect(vmWorkspaceSchema.parse(discarding.json()).state).toBe('discarding');
    const discard = await w.agent.next('server.workspace_discard');
    expect(discard.payload).toEqual({
      workspaceId: workspace.id,
      emulatorType: 'qemu',
      vmName: 'Win98',
    });
    w.agent.send(
      envelope('agent.workspace_discard_result', {
        workspaceId: workspace.id,
        removed: true,
        code: null,
        message: null,
      }),
    );
    await barrier(w.agent);
    expect((await readWorkspace(w, workspace.id)).state).toBe('discarded');
    // The snapshots it produced stay.
    expect(await versionCount(w)).toBe(2);
  });

  it('is refused, never replaced, when the agent cannot run it', async () => {
    for (const capabilities of [{ modes: ['local'] }, { workspaces: null }]) {
      const w = await world(capabilities);
      const response = await createWorkspace(w);
      expect(response.statusCode).toBe(409);
      expect(await errorCode(response)).toBe('execution_mode_unavailable');
      await barrier(w.agent);
      expect(
        w.agent.received.filter((m) =>
          ['server.restore_request', 'server.vm_launch'].includes(m.type),
        ),
      ).toEqual([]);
    }
  });

  it('prepares one working copy per request, and one per VM and agent', async () => {
    const w = await world();
    const requestId = randomUUID();
    const first = await createWorkspace(w, { requestId, launch: false });
    const again = await createWorkspace(w, { requestId, launch: false });
    expect(first.statusCode, first.body).toBe(202);
    expect(again.json<VmWorkspace>().id).toBe(first.json<VmWorkspace>().id);
    const another = await createWorkspace(w);
    expect(another.statusCode).toBe(409);
  });

  it('does not launch a working copy that is not ready, and fails it with its restore', async () => {
    const w = await world();
    const created = await createWorkspace(w);
    const workspace = vmWorkspaceSchema.parse(created.json());
    const launch = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspace.id}/launch`,
      payload: { requestId: randomUUID() },
    });
    expect(await errorCode(launch)).toBe('workspace_unavailable');
    const restore = await w.agent.next('server.restore_request');
    w.agent.send(
      envelope('agent.restore_error', {
        operationId: restore.payload.operationId,
        code: 'restore_integrity_failed',
        message: 'The archive does not match',
      }),
    );
    await w.agent.next('server.restore_ack');
    expect(await readWorkspace(w, workspace.id)).toMatchObject({
      state: 'failed',
      error: { code: 'restore_integrity_failed' },
    });
    expect(w.agent.received.filter((m) => m.type === 'server.vm_launch')).toEqual([]);
  });

  it('reconciles with what the agent holds after it reconnects', async () => {
    const w = await world();
    const { workspace, status } = await readyAndRunning(w);
    await stop(w, status);
    const discarding = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspace.id}/discard`,
      payload: { confirmVmName: 'Win98' },
    });
    expect(discarding.statusCode).toBe(200);
    await w.agent.next('server.workspace_discard');
    // The answer is lost. Still held: asked again.
    await resync(w, { workspaces: [workspace.id] });
    await w.agent.next('server.workspace_discard');
    // Gone: recorded as discarded.
    await resync(w, { workspaces: [] });
    expect((await readWorkspace(w, workspace.id)).state).toBe('discarded');

    // A ready one the agent no longer has is lost, and says so.
    const next = await createWorkspace(w, { launch: false });
    const second = vmWorkspaceSchema.parse(next.json());
    const restore = await w.agent.next('server.restore_request');
    w.agent.send(
      envelope(
        'agent.restore_result',
        restoreResult(restore.payload.operationId, w.masterId, {
          archive: { sizeBytes: 2048, sha256: SHA },
        }),
      ),
    );
    await w.agent.next('server.restore_ack');
    expect((await readWorkspace(w, second.id)).state).toBe('ready');
    await resync(w, { workspaces: [] });
    expect(await readWorkspace(w, second.id)).toMatchObject({
      state: 'lost',
      error: { code: 'workspace_missing' },
    });
  });

  it('protects the persistent copy while a working copy of the VM runs', async () => {
    const w = await world();
    await readyAndRunning(w);
    const response = await snapshotRequest(w);
    expect(await errorCode(response)).toBe('vm_running');
  });
});

describe('authorization and privacy', () => {
  it('keeps every version route to administrators', async () => {
    const w = await world();
    const anonymous = new TestClient(w.context.app);
    for (const [method, url] of [
      ['GET', '/admin/vms/qemu/Win98/versions'],
      ['POST', '/admin/vms/qemu/Win98/snapshots'],
      ['GET', '/admin/vms/qemu/Win98/workspaces'],
      ['POST', '/admin/vms/qemu/Win98/workspaces'],
      ['POST', `/admin/workspaces/${randomUUID()}/discard`],
    ] as const) {
      const response = await anonymous.request({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('shows no version data publicly, even for a public VM', async () => {
    const w = await world();
    const operation = await snapshot(w);
    await complete(w, operation);
    const anonymous = new TestClient(w.context.app);
    const detail = await anonymous.get('/catalog/vms/qemu/Win98');
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.body;
    for (const secret of [
      w.masterId,
      operation.versionId,
      operation.snapshotName ?? '',
      'archive',
    ]) {
      expect(body).not.toContain(secret);
    }
    const privateVm = await anonymous.get('/catalog/vms/qemu/Other');
    expect(privateVm.statusCode).toBe(404);
  });
});
