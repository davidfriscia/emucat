/**
 * Remote Volatile and Remote Snapshot as temporary sessions, and replacing a persistent local copy, through
 * the real API, on a real database, over a real WebSocket. The agent is a script, so that every message a
 * real agent could send, repeat, lose or get wrong can be arranged exactly. See decision 0040.
 */
import { randomUUID } from 'node:crypto';
import {
  createWorkspaceRequestSchema,
  executionOptionsResponseSchema,
  registrationOperationSchema,
  remoteSessionSchema,
  restoreOperationSchema,
  restoreOptionsResponseSchema,
  type RegistrationOperation,
  type RemoteSession,
  type WorkspaceState,
} from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import { afterEach, describe, expect, it } from 'vitest';
import { publicationRequestId, type RemoteSessionOptions } from '../src/workspaces/coordinator.js';
import { envelope, waitFor } from './agent-helpers.js';
import { TestClient } from './browser-app.js';
import {
  barrier,
  closeWorlds,
  complete,
  errorCode,
  localSource,
  restoreResult,
  resync,
  runningStatus,
  snapshot,
  stopSession,
  tree,
  versionCount,
  world,
  type Capabilities,
  type World,
} from './version-world.js';

// Each test's world is closed after it, so that a file never holds many databases' connections at once.
afterEach(closeWorlds);

const ALL_MODES = ['local', 'remote_volatile', 'remote_snapshot'];
type Mode = 'remote_volatile' | 'remote_snapshot';

/** Nothing retries by itself during a test unless the test says so, and nothing runs on a timer. */
function remoteWorld(
  options: Partial<RemoteSessionOptions> = {},
  capabilities: Capabilities = {},
): Promise<World> {
  return world(
    { modes: ALL_MODES, ...capabilities },
    {
      sweepIntervalMs: 0,
      publishRetryDelaysMs: [60_000],
      discardRetryMs: 60_000,
      ...options,
    },
  );
}

/** A reconnection of the agent, holding these working copies, which also sweeps its remote sessions. */
function reconnect(w: World, workspaces: string[], capabilities: Capabilities = {}): Promise<void> {
  return resync(w, { modes: ALL_MODES, workspaces, ...capabilities });
}

function start(w: World, mode: Mode, overrides: object = {}) {
  return w.admin.request({
    method: 'POST',
    url: '/admin/vms/qemu/Win98/workspaces',
    payload: {
      agentId: w.paired.agentId,
      versionId: w.masterId,
      requestId: randomUUID(),
      mode,
      ...overrides,
    },
  });
}

async function read(w: World, id: string): Promise<RemoteSession> {
  const response = await w.admin.get(`/admin/workspaces/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return remoteSessionSchema.parse(response.json());
}

function reachState(w: World, id: string, state: WorkspaceState): Promise<RemoteSession> {
  return waitFor(async () => {
    const session = await read(w, id);
    return session.state === state && session;
  }, `the remote session to be ${state}`);
}

/** The agent's side of preparing one: the restore into the working copy, answered and acknowledged. */
async function prepare(w: World, id: string, mode: Mode, versionId: string): Promise<void> {
  const restore = await w.agent.next('server.restore_request');
  expect(restore.payload).toMatchObject({ workspaceId: id, workspacePurpose: mode, versionId });
  expect(restore.payload).not.toHaveProperty('replace');
  w.agent.send(
    envelope(
      'agent.restore_result',
      restoreResult(
        restore.payload.operationId,
        versionId,
        {
          archive: {
            sizeBytes: restore.payload.archiveSizeBytes,
            sha256: restore.payload.archiveSha256,
          },
        },
        `C:\\state\\workspaces\\${id}\\Win98`,
        restore.payload.manifestSha256,
      ),
    ),
  );
  expect((await w.agent.next('server.restore_ack')).payload.outcome).toBe('closed');
}

/** One remote session, prepared and launched by itself, as far as the agent's running report. */
async function running(w: World, mode: Mode, versionId = w.masterId) {
  const created = await start(w, mode, { versionId });
  expect(created.statusCode, created.body).toBe(202);
  const session = remoteSessionSchema.parse(created.json());
  expect(session).toMatchObject({ purpose: mode, state: 'preparing', baseVersionId: versionId });
  await prepare(w, session.id, mode, versionId);
  const launch = await w.agent.next('server.vm_launch');
  expect(launch.payload).toMatchObject({ mode, workspaceId: session.id, versionId });
  const sessionId = launch.payload.sessionId as string;
  const status = runningStatus(sessionId);
  w.agent.send(envelope('agent.vm_execution_status', status));
  await barrier(w.agent);
  return { id: session.id, sessionId, status };
}

async function removed(w: World, id: string): Promise<RemoteSession> {
  const discard = await w.agent.next('server.workspace_discard');
  expect(discard.payload).toEqual({ workspaceId: id, emulatorType: 'qemu', vmName: 'Win98' });
  w.agent.send(
    envelope('agent.workspace_discard_result', {
      workspaceId: id,
      removed: true,
      code: null,
      message: null,
    }),
  );
  return reachState(w, id, 'discarded');
}

function sent(w: World, type: string) {
  return w.agent.received.filter((message) => message.type === type);
}

async function publicationAttempts(w: World, id: string): Promise<number> {
  const [rows] = await w.context.pool.execute<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM registration_operations WHERE workspace_id = ?',
    [id],
  );
  return Number(rows[0]?.n);
}

async function publishing(w: World, id: string): Promise<RegistrationOperation> {
  const session = await waitFor(async () => {
    const current = await read(w, id);
    return current.state === 'publishing' && current.snapshot !== null && current;
  }, 'a publication attempt');
  return registrationOperationSchema.parse(session.snapshot);
}

async function failPublication(w: World, code: string): Promise<string> {
  const request = await w.agent.next('server.registration_request');
  const operationId = request.payload.operationId as string;
  w.agent.send(envelope('agent.registration_error', { operationId, code, message: 'It failed.' }));
  expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
  return operationId;
}

describe('Remote Volatile', () => {
  it('runs the chosen version from a temporary copy, and removes it when the emulator exits', async () => {
    const w = await remoteWorld();
    const { id, sessionId, status } = await running(w, 'remote_volatile');
    expect(await read(w, id)).toMatchObject({
      purpose: 'remote_volatile',
      state: 'running',
      sessionId,
      baseVersionId: w.masterId,
      session: { id: sessionId, mode: 'remote_volatile', versionId: w.masterId, state: 'running' },
      restore: { workspaceId: id, versionId: w.masterId, replacement: null },
      snapshot: null,
      recovery: null,
    });
    await stopSession(w, status);
    const done = await removed(w, id);
    expect(done).toMatchObject({ state: 'discarded', snapshotVersionId: null, error: null });
    // Nothing was published, and the persistent copy was never touched.
    expect(sent(w, 'server.registration_request')).toEqual([]);
    expect(await versionCount(w)).toBe(1);
    expect(await localSource(w)).toBe(w.masterId);
  });

  it('works on an agent with no local copy of the VM', async () => {
    const w = await remoteWorld();
    await w.context.pool.execute('DELETE FROM agent_vm_state WHERE agent_id = ?', [
      w.paired.agentId,
    ]);
    const { id, status } = await running(w, 'remote_volatile');
    await stopSession(w, status);
    await removed(w, id);
    const [rows] = await w.context.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM agent_vm_state WHERE agent_id = ?',
      [w.paired.agentId],
    );
    expect(Number(rows[0]?.n), 'a temporary copy is never a persistent one').toBe(0);
  });

  it('removes a copy whose emulator never started, and says why', async () => {
    const w = await remoteWorld();
    const created = await start(w, 'remote_volatile');
    const id = remoteSessionSchema.parse(created.json()).id;
    await prepare(w, id, 'remote_volatile', w.masterId);
    const launch = await w.agent.next('server.vm_launch');
    w.agent.send(
      envelope('agent.vm_execution_status', {
        ...runningStatus(launch.payload.sessionId as string),
        state: 'failed',
        pid: null,
        processStartedAt: null,
        startedAt: null,
        endedAt: '2026-11-07T10:00:01.000Z',
        code: 'emulator_start_failed',
        message: 'The emulator could not start.',
      }),
    );
    await w.agent.next('server.vm_execution_ack');
    const discarding = await reachState(w, id, 'discarding');
    expect(discarding.error?.code).toBe('emulator_start_failed');
    await removed(w, id);
  });

  it('asks again until the agent confirms the cleanup', async () => {
    const w = await remoteWorld();
    const { id, status } = await running(w, 'remote_volatile');
    await stopSession(w, status);
    await w.agent.next('server.workspace_discard');
    w.agent.send(
      envelope('agent.workspace_discard_result', {
        workspaceId: id,
        removed: false,
        code: 'cleanup_in_use',
        message: 'A file is in use.',
      }),
    );
    await barrier(w.agent);
    // Still being removed: nothing in it is wanted, and only the agent's confirmation ends it.
    expect(await read(w, id)).toMatchObject({
      state: 'discarding',
      error: { code: 'cleanup_in_use' },
    });
    await reconnect(w, [id]);
    await w.agent.next('server.workspace_discard');
    await reconnect(w, []);
    expect((await read(w, id)).state).toBe('discarded');
  });
});

describe('Remote Snapshot', () => {
  it('publishes a child of exactly the chosen version, then removes the temporary copy', async () => {
    const w = await remoteWorld();
    // An older snapshot A, and a newer B that the persistent copy now holds.
    const a = await snapshot(w);
    await complete(w, a);
    const b = await snapshot(w, { parentVersionId: a.versionId });
    await complete(w, b);
    expect(await localSource(w)).toBe(b.versionId);

    const { id, status } = await running(w, 'remote_snapshot', a.versionId);
    await stopSession(w, status);
    const operation = await publishing(w, id);
    expect(operation).toMatchObject({
      mode: 'snapshot',
      parentVersionId: a.versionId,
      workspaceId: id,
    });
    const request = await w.agent.next('server.registration_request');
    expect(request.payload).toMatchObject({ workspaceId: id, parentVersionId: a.versionId });
    w.agent.received.unshift(request);
    await complete(w, operation);
    const done = await removed(w, id);
    expect(done).toMatchObject({
      state: 'discarded',
      snapshotVersionId: operation.versionId,
      publishAttempts: 1,
      abandonedAt: null,
    });

    // A branch from A, never from the newest version, and the persistent copy is still B.
    const versions = await tree(w);
    expect(versions.versions.find((v) => v.id === operation.versionId)?.parentVersionId).toBe(
      a.versionId,
    );
    expect(await localSource(w)).toBe(b.versionId);
    expect(await versionCount(w)).toBe(4);
    const [sessions] = await w.context.pool.execute<RowDataPacket[]>(
      'SELECT mode, source_version_id, workspace_id FROM vm_sessions WHERE workspace_id = ?',
      [id],
    );
    expect(sessions).toEqual([
      expect.objectContaining({ mode: 'remote_snapshot', source_version_id: a.versionId }),
    ]);
  });

  it('keeps the copy when publication fails, retries by itself, and never publishes twice', async () => {
    const w = await remoteWorld({ publishRetryDelaysMs: [300] });
    const { id, status } = await running(w, 'remote_snapshot');
    await stopSession(w, status);
    const first = await failPublication(w, 'upload_interrupted');
    const failed = await reachState(w, id, 'publish_failed');
    expect(failed).toMatchObject({
      publishAttempts: 1,
      error: { code: 'upload_interrupted' },
      snapshot: { id: first, state: 'failed' },
    });
    expect(failed.recovery).toMatch(/kept/);
    expect(failed.nextRetryAt).not.toBeNull();
    expect(sent(w, 'server.workspace_discard'), 'the temporary copy is kept').toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 400));
    await reconnect(w, [id]);
    const retried = await publishing(w, id);
    expect(retried.id).not.toBe(first);
    expect(retried.parentVersionId).toBe(w.masterId);
    // Another sweep finds the attempt already under way.
    await reconnect(w, [id]);
    expect(await publicationAttempts(w, id)).toBe(2);

    const request = await w.agent.next('server.registration_request');
    expect(request.payload.operationId).toBe(retried.id);
    w.agent.received.unshift(request);
    await complete(w, retried);
    expect((await removed(w, id)).snapshotVersionId).toBe(retried.versionId);
    expect(await versionCount(w)).toBe(2);
  });

  it('stops retrying after the last automatic attempt, and waits for an administrator', async () => {
    const w = await remoteWorld({ maxAutomaticAttempts: 1, publishRetryDelaysMs: [0] });
    const { id, status } = await running(w, 'remote_snapshot');
    await stopSession(w, status);
    await failPublication(w, 'upload_interrupted');
    const failed = await reachState(w, id, 'publish_failed');
    expect(failed.nextRetryAt).toBeNull();
    await reconnect(w, [id]);
    expect(await publicationAttempts(w, id)).toBe(1);
  });

  it('does not retry by itself what another attempt cannot cure, and retries once when asked', async () => {
    const w = await remoteWorld({ publishRetryDelaysMs: [0] });
    const { id, status } = await running(w, 'remote_snapshot');
    await stopSession(w, status);
    await failPublication(w, 'snapshot_parent_mismatch');
    const failed = await reachState(w, id, 'publish_failed');
    expect(failed.nextRetryAt).toBeNull();
    await reconnect(w, [id]);
    expect(await publicationAttempts(w, id)).toBe(1);

    // Two retries at once: one attempt.
    const retries = await Promise.all(
      [0, 1].map(() =>
        w.admin.request({
          method: 'POST',
          url: `/admin/workspaces/${id}/retry-publication`,
          payload: {},
        }),
      ),
    );
    expect(retries.map((response) => response.statusCode).sort()).toContain(202);
    for (const response of retries) expect([202, 409]).toContain(response.statusCode);
    await publishing(w, id);
    expect(await publicationAttempts(w, id)).toBe(2);
    expect((await read(w, id)).publishAttempts).toBe(2);

    // Only a failed publication can be retried.
    const again = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${id}/retry-publication`,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(await errorCode(again)).toBe('workspace_unavailable');
  });

  it('is abandoned only with the VM name typed, and then nothing is published', async () => {
    const w = await remoteWorld();
    const { id, status } = await running(w, 'remote_snapshot');
    // Nothing can be abandoned while it runs: it is in progress.
    const early = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${id}/discard`,
      payload: { confirmVmName: 'Win98' },
    });
    expect(early.statusCode).toBe(409);
    expect(await errorCode(early)).toBe('workspace_unavailable');
    await stopSession(w, status);
    await failPublication(w, 'snapshot_parent_mismatch');
    await reachState(w, id, 'publish_failed');

    const unconfirmed = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${id}/discard`,
      payload: {},
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(await errorCode(unconfirmed)).toBe('confirmation_required');
    const abandoned = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${id}/discard`,
      payload: { confirmVmName: 'win98' },
    });
    expect(abandoned.statusCode, abandoned.body).toBe(200);
    expect(remoteSessionSchema.parse(abandoned.json())).toMatchObject({ state: 'discarding' });
    const done = await removed(w, id);
    expect(done.abandonedAt).not.toBeNull();
    expect(done.snapshotVersionId).toBeNull();
    expect(await versionCount(w)).toBe(1);
  });

  it('holds a session the agent cannot account for, until an administrator resumes it', async () => {
    const w = await remoteWorld();
    const { id } = await running(w, 'remote_snapshot');
    // The agent comes back without the session: its emulator may still be running there.
    await reconnect(w, [id]);
    const held = await reachState(w, id, 'held');
    expect(held.error?.code).toBe('agent_lost_session');
    expect(held.recovery).toMatch(/resume/);
    expect(sent(w, 'server.registration_request')).toEqual([]);
    expect(sent(w, 'server.workspace_discard')).toEqual([]);
    // A sweep does not move it on.
    await reconnect(w, [id]);
    expect((await read(w, id)).state).toBe('held');

    const wrong = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${id}/resume`,
      payload: { confirmVmName: 'Other' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(await errorCode(wrong)).toBe('confirmation_mismatch');
    const resumed = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${id}/resume`,
      payload: { confirmVmName: 'Win98' },
    });
    expect(resumed.statusCode, resumed.body).toBe(202);
    const operation = await publishing(w, id);
    expect(operation.parentVersionId).toBe(w.masterId);
  });

  it('goes on when a session of unknown state is dismissed, since that is the confirmation', async () => {
    const w = await remoteWorld();
    const { id, status } = await running(w, 'remote_volatile');
    w.agent.send(envelope('agent.vm_execution_status', { ...status, state: 'unknown' }));
    await barrier(w.agent);
    // Unknown is still running, as far as removing anything is concerned.
    expect((await read(w, id)).state).toBe('running');
    const dismissed = await w.admin.request({
      method: 'POST',
      url: `/admin/sessions/${status.sessionId}/dismiss`,
      payload: { confirmVmName: 'Win98' },
    });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    await removed(w, id);
  });

  it('never publishes a copy whose emulator never started', async () => {
    const w = await remoteWorld();
    const created = await start(w, 'remote_snapshot');
    const id = remoteSessionSchema.parse(created.json()).id;
    await prepare(w, id, 'remote_snapshot', w.masterId);
    const launch = await w.agent.next('server.vm_launch');
    w.agent.send(
      envelope('agent.vm_execution_status', {
        ...runningStatus(launch.payload.sessionId as string),
        state: 'failed',
        pid: null,
        processStartedAt: null,
        startedAt: null,
        endedAt: '2026-11-07T10:00:01.000Z',
        code: 'emulator_start_failed',
        message: 'The emulator could not start.',
      }),
    );
    await w.agent.next('server.vm_execution_ack');
    await removed(w, id);
    expect(sent(w, 'server.registration_request')).toEqual([]);
  });

  it('records a failed preparation, and never launches it', async () => {
    const w = await remoteWorld();
    const created = await start(w, 'remote_snapshot');
    const id = remoteSessionSchema.parse(created.json()).id;
    const restore = await w.agent.next('server.restore_request');
    w.agent.send(
      envelope('agent.restore_error', {
        operationId: restore.payload.operationId,
        code: 'restore_integrity_failed',
        message: 'The archive does not match',
      }),
    );
    await w.agent.next('server.restore_ack');
    expect(await read(w, id)).toMatchObject({
      state: 'failed',
      error: { code: 'restore_integrity_failed' },
    });
    await reconnect(w, []);
    expect(sent(w, 'server.vm_launch')).toEqual([]);
  });
});

describe('starting a remote session', () => {
  it('derives each publication attempt’s request ID, in a form the database and contracts accept', async () => {
    const w = await remoteWorld();
    const workspaceId = randomUUID();
    expect(publicationRequestId(workspaceId, 1)).toBe(publicationRequestId(workspaceId, 1));
    expect(publicationRequestId(workspaceId, 1)).not.toBe(publicationRequestId(workspaceId, 2));
    const uuid = createWorkspaceRequestSchema.shape.requestId;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const id = publicationRequestId(randomUUID(), attempt);
      expect(uuid.safeParse(id).success, id).toBe(true);
      const [rows] = await w.context.pool.execute<RowDataPacket[]>('SELECT CAST(? AS UUID) AS id', [
        id,
      ]);
      expect(rows[0]?.id, id).toBe(id);
    }
  });

  it('starts one session per request, and one per VM and agent', async () => {
    const w = await remoteWorld();
    const requestId = randomUUID();
    const first = await start(w, 'remote_volatile', { requestId });
    const again = await start(w, 'remote_volatile', { requestId });
    expect(first.statusCode, first.body).toBe(202);
    expect(again.json<RemoteSession>().id).toBe(first.json<RemoteSession>().id);
    const reused = await start(w, 'remote_snapshot', { requestId });
    expect(reused.statusCode).toBe(409);
    expect(await errorCode(reused)).toBe('request_id_reused');
    const another = await start(w, 'remote_snapshot');
    expect(another.statusCode).toBe(409);
    expect(await errorCode(another)).toBe('remote_session_pending');

    const options = executionOptionsResponseSchema.parse(
      (await w.admin.get('/admin/vms/qemu/Win98/execution-options')).json(),
    );
    expect(options.agents[0]).toMatchObject({
      activeWorkspaceId: first.json<RemoteSession>().id,
      remote: {
        remote_volatile: { eligible: false, reason: 'remote_session_pending' },
        remote_snapshot: { eligible: false, reason: 'remote_session_pending' },
      },
    });
  });

  it('says which agents can run each mode, and why the others cannot', async () => {
    const w = await remoteWorld({}, { modes: ['local', 'remote_snapshot'] });
    const options = executionOptionsResponseSchema.parse(
      (await w.admin.get('/admin/vms/qemu/Win98/execution-options')).json(),
    );
    expect(options.agents[0]).toMatchObject({
      remote: {
        remote_volatile: { eligible: false, reason: 'mode_not_supported' },
        remote_snapshot: { eligible: true, reason: null },
      },
      activeWorkspaceId: null,
    });
    const refused = await start(w, 'remote_volatile');
    expect(refused.statusCode).toBe(409);
    expect(await errorCode(refused)).toBe('execution_mode_unavailable');
    await barrier(w.agent);
    expect(sent(w, 'server.restore_request')).toEqual([]);
  });

  it('is refused for an agent that cannot keep working copies, or is not allowed the repository', async () => {
    const w = await remoteWorld({}, { workspaces: null });
    const refused = await start(w, 'remote_snapshot');
    expect(await errorCode(refused)).toBe('execution_mode_unavailable');
    await reconnect(w, []);
    await w.context.pool.execute('DELETE FROM agent_repositories WHERE agent_id = ?', [
      w.paired.agentId,
    ]);
    const unauthorized = await start(w, 'remote_snapshot');
    expect(await errorCode(unauthorized)).toBe('repository_not_authorized');
    await barrier(w.agent);
    expect(sent(w, 'server.restore_request')).toEqual([]);
  });

  it('refuses a version of another VM, and anything that names a path', async () => {
    const w = await remoteWorld();
    const [others] = await w.context.pool.execute<RowDataPacket[]>(
      "SELECT id FROM vm_versions WHERE vm_name = 'Other'",
    );
    const foreign = await start(w, 'remote_volatile', { versionId: others[0]?.id as string });
    expect(foreign.statusCode).toBe(404);
    expect(await errorCode(foreign)).toBe('version_not_found');
    const path = await start(w, 'remote_volatile', { directory: 'C:\\Windows' });
    expect(path.statusCode).toBe(400);
  });

  it('lists the sessions of a VM with the operations that carry them', async () => {
    const w = await remoteWorld();
    const { id } = await running(w, 'remote_volatile');
    const response = await w.admin.get('/admin/vms/qemu/Win98/workspaces');
    expect(response.statusCode).toBe(200);
    const listed = response
      .json<{ workspaces: unknown[] }>()
      .workspaces.map((item) => remoteSessionSchema.parse(item));
    expect(listed[0]).toMatchObject({
      id,
      session: { state: 'running' },
      restore: { state: 'succeeded' },
    });
  });

  it('keeps every route to administrators, and refuses cross-origin requests', async () => {
    const w = await remoteWorld();
    const anonymous = new TestClient(w.context.app);
    for (const url of [
      '/admin/vms/qemu/Win98/workspaces',
      `/admin/workspaces/${randomUUID()}/retry-publication`,
      `/admin/workspaces/${randomUUID()}/resume`,
    ]) {
      const response = await anonymous.request({ method: 'POST', url, payload: {} });
      expect(response.statusCode, url).toBe(401);
    }
    const crossOrigin = await w.admin.request({
      method: 'POST',
      url: '/admin/vms/qemu/Win98/workspaces',
      payload: {
        agentId: w.paired.agentId,
        versionId: w.masterId,
        requestId: randomUUID(),
        mode: 'remote_volatile',
      },
      headers: { origin: 'https://evil.example' },
    });
    expect(crossOrigin.statusCode).toBe(403);
    const withoutToken = await w.admin.request({
      method: 'POST',
      url: '/admin/vms/qemu/Win98/workspaces',
      payload: {
        agentId: w.paired.agentId,
        versionId: w.masterId,
        requestId: randomUUID(),
        mode: 'remote_volatile',
      },
      csrf: false,
    });
    expect(withoutToken.statusCode).toBe(403);
    await barrier(w.agent);
    expect(sent(w, 'server.restore_request')).toEqual([]);
  });
});

describe('replacing the persistent copy', () => {
  function replace(w: World, versionId: string, replacement: object) {
    return w.admin.request({
      method: 'POST',
      url: '/admin/restores',
      payload: {
        agentId: w.paired.agentId,
        emulatorType: 'qemu',
        vmName: 'Win98',
        versionId,
        replace: { discardLocalChanges: false, ...replacement },
      },
    });
  }

  async function answer(w: World, versionId: string) {
    const request = await w.agent.next('server.restore_request');
    w.agent.send(
      envelope(
        'agent.restore_result',
        restoreResult(
          request.payload.operationId,
          versionId,
          {
            archive: {
              sizeBytes: request.payload.archiveSizeBytes,
              sha256: request.payload.archiveSha256,
            },
          },
          'C:\\vms\\qemu\\Win98',
          request.payload.manifestSha256,
        ),
      ),
    );
    expect((await w.agent.next('server.restore_ack')).payload.outcome).toBe('closed');
    return request;
  }

  it('replaces it with any version, explicitly, and records what it replaced', async () => {
    const w = await remoteWorld({}, { replaceLocal: true });
    const a = await snapshot(w);
    await complete(w, a);
    expect(await localSource(w)).toBe(a.versionId);
    const options = restoreOptionsResponseSchema.parse(
      (await w.admin.get('/admin/vms/qemu/Win98/restore-options')).json(),
    );
    expect(options.agents[0]).toMatchObject({
      eligible: false,
      ineligibleReason: 'local_copy_exists',
      replace: { eligible: true, reason: null },
    });

    // Back to the master, from a snapshot.
    const created = await replace(w, w.masterId, { expectedVersionId: a.versionId });
    expect(created.statusCode, created.body).toBe(202);
    const request = await answer(w, w.masterId);
    expect(request.payload).toMatchObject({
      versionId: w.masterId,
      replace: { expectedVersionId: a.versionId, discardLocalChanges: false },
    });
    expect(request.payload).not.toHaveProperty('workspaceId');
    expect(await localSource(w)).toBe(w.masterId);
    const operation = restoreOperationSchema.parse(
      (await w.admin.get(`/admin/restores/${created.json<{ id: string }>().id}`)).json(),
    );
    expect(operation).toMatchObject({
      state: 'succeeded',
      replacement: { replacedVersionId: a.versionId, discardLocalChanges: false },
    });

    // And forward again, to the snapshot.
    const forward = await replace(w, a.versionId, { expectedVersionId: w.masterId });
    expect(forward.statusCode, forward.body).toBe(202);
    await answer(w, a.versionId);
    expect(await localSource(w)).toBe(a.versionId);
  });

  it('refuses a stale page, an unknown field, and changes nobody acknowledged', async () => {
    const w = await remoteWorld({}, { replaceLocal: true });
    const stale = await replace(w, w.masterId, { expectedVersionId: randomUUID() });
    expect(stale.statusCode).toBe(409);
    expect(await errorCode(stale)).toBe('local_copy_changed');
    // The replacement is confirmed by the request itself: no typed name, and nothing else either.
    const extra = await replace(w, w.masterId, {
      expectedVersionId: w.masterId,
      confirmVmName: 'Win98',
    });
    expect(extra.statusCode).toBe(400);
    const missingAcknowledgement = await w.admin.request({
      method: 'POST',
      url: '/admin/restores',
      payload: {
        agentId: w.paired.agentId,
        emulatorType: 'qemu',
        vmName: 'Win98',
        versionId: w.masterId,
        replace: { expectedVersionId: w.masterId },
      },
    });
    expect(missingAcknowledgement.statusCode).toBe(400);

    await w.context.pool.execute(
      "UPDATE agent_vm_state SET content_status = 'modified' WHERE agent_id = ?",
      [w.paired.agentId],
    );
    const modified = await replace(w, w.masterId, { expectedVersionId: w.masterId });
    expect(modified.statusCode).toBe(409);
    expect(await errorCode(modified)).toBe('local_copy_modified');
    await barrier(w.agent);
    expect(sent(w, 'server.restore_request')).toEqual([]);

    const acknowledged = await replace(w, w.masterId, {
      expectedVersionId: w.masterId,
      discardLocalChanges: true,
    });
    expect(acknowledged.statusCode, acknowledged.body).toBe(202);
    const request = await answer(w, w.masterId);
    expect(request.payload).toMatchObject({ replace: { discardLocalChanges: true } });
    const [rows] = await w.context.pool.execute<RowDataPacket[]>(
      'SELECT content_status FROM agent_vm_state WHERE agent_id = ?',
      [w.paired.agentId],
    );
    expect(rows[0]?.content_status).toBe('verified');
  });

  it('is refused while the VM runs, without a copy, or by an agent that cannot do it safely', async () => {
    const w = await remoteWorld();
    const old = await replace(w, w.masterId, { expectedVersionId: w.masterId });
    expect(old.statusCode).toBe(409);
    expect(await errorCode(old)).toBe('agent_cannot_restore');
    const options = restoreOptionsResponseSchema.parse(
      (await w.admin.get('/admin/vms/qemu/Win98/restore-options')).json(),
    );
    expect(options.agents[0]?.replace).toEqual({
      eligible: false,
      reason: 'agent_cannot_restore',
    });

    await resync(w, { modes: ALL_MODES, replaceLocal: true });
    await w.context.pool.execute(
      `INSERT INTO vm_sessions (id, agent_id, emulator_type, vm_name, mode, execution_state)
       VALUES (?, ?, 'qemu', 'Win98', 'local', 'unknown')`,
      [randomUUID(), w.paired.agentId],
    );
    const runningCopy = await replace(w, w.masterId, { expectedVersionId: w.masterId });
    expect(await errorCode(runningCopy)).toBe('vm_running');
    await w.context.pool.execute(
      "UPDATE vm_sessions SET execution_state = 'interrupted', ended_at = UTC_TIMESTAMP(3)",
    );

    await w.context.pool.execute(
      "UPDATE agent_vm_state SET execution_state = 'absent' WHERE agent_id = ?",
      [w.paired.agentId],
    );
    const missing = await replace(w, w.masterId, { expectedVersionId: w.masterId });
    expect(await errorCode(missing)).toBe('no_local_copy');
    await barrier(w.agent);
    expect(sent(w, 'server.restore_request')).toEqual([]);
  });

  it('keeps a replacement to administrators, with the CSRF token', async () => {
    const w = await remoteWorld({}, { replaceLocal: true });
    const payload = {
      agentId: w.paired.agentId,
      emulatorType: 'qemu',
      vmName: 'Win98',
      versionId: w.masterId,
      replace: { expectedVersionId: w.masterId, discardLocalChanges: true },
    };
    const anonymous = new TestClient(w.context.app);
    const unauthenticated = await anonymous.request({
      method: 'POST',
      url: '/admin/restores',
      payload,
    });
    expect(unauthenticated.statusCode).toBe(401);
    const withoutToken = await w.admin.request({
      method: 'POST',
      url: '/admin/restores',
      payload,
      csrf: false,
    });
    expect(withoutToken.statusCode).toBe(403);
    await barrier(w.agent);
    expect(sent(w, 'server.restore_request')).toEqual([]);
  });

  it('keeps the copy and the record when the agent refuses', async () => {
    const w = await remoteWorld({}, { replaceLocal: true });
    const created = await replace(w, w.masterId, { expectedVersionId: w.masterId });
    expect(created.statusCode, created.body).toBe(202);
    const request = await w.agent.next('server.restore_request');
    w.agent.send(
      envelope('agent.restore_error', {
        operationId: request.payload.operationId,
        code: 'local_copy_modified',
        message: 'The local copy differs from its version.',
      }),
    );
    await w.agent.next('server.restore_ack');
    const operation = restoreOperationSchema.parse(
      (await w.admin.get(`/admin/restores/${created.json<{ id: string }>().id}`)).json(),
    );
    expect(operation).toMatchObject({ state: 'failed', error: { code: 'local_copy_modified' } });
    expect(operation.recovery).toMatch(/kept/i);
    expect(await localSource(w)).toBe(w.masterId);
  });
});
