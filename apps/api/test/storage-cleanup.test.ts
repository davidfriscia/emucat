/**
 * Storage cleanup (decision 0041) through the real API, on a real database, over a real WebSocket:
 * removing one agent's persistent copy of a VM, and permanently deleting a leaf snapshot. The agent is a
 * script, so that every answer a real agent could give, repeat, lose or get wrong can be arranged.
 */
import { randomUUID } from 'node:crypto';
import {
  archiveObjectKey,
  executionOptionsResponseSchema,
  localCopyRemovalSchema,
  restoreOptionsResponseSchema,
  versionDeletionSchema,
  type LocalCopyRemoval,
  type VersionDeletion,
} from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import { afterEach, describe, expect, it } from 'vitest';
import { envelope, TestAgent, waitFor, wsUrl } from './agent-helpers.js';
import {
  closeWorlds,
  complete,
  errorCode,
  restoreVersion,
  resync,
  snapshot,
  snapshotRequest,
  tree,
  world,
  type Capabilities,
  type World,
} from './version-world.js';

afterEach(closeWorlds);

const CLEANUP: Capabilities = { removeLocal: true, deleteArchives: true };

async function cleanupWorld(capabilities: Capabilities = CLEANUP, retryBaseMs = 60_000) {
  return world(
    capabilities,
    {},
    { versionDeletions: { retryBaseMs, retryMaxMs: retryBaseMs * 4, sweepIntervalMs: 50 } },
  );
}

function removalRequest(w: World, overrides: object = {}) {
  return w.admin.request({
    method: 'POST',
    url: '/admin/local-copy-removals',
    payload: {
      agentId: w.paired.agentId,
      emulatorType: 'qemu',
      vmName: 'Win98',
      expectedVersionId: w.masterId,
      discardLocalChanges: false,
      requestId: randomUUID(),
      ...overrides,
    },
  });
}

async function requestRemoval(w: World, overrides: object = {}): Promise<LocalCopyRemoval> {
  const response = await removalRequest(w, overrides);
  expect(response.statusCode, response.body).toBe(202);
  return localCopyRemovalSchema.parse(response.json());
}

async function removal(w: World, id: string): Promise<LocalCopyRemoval> {
  const response = await w.admin.get(`/admin/local-copy-removals/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return localCopyRemovalSchema.parse(response.json());
}

function removed(operationId: string, overrides: object = {}) {
  return envelope('agent.local_copy_remove_result', {
    operationId,
    removed: true,
    cleanupPending: false,
    localDirectory: 'C:\\vms\\qemu\\Win98',
    code: null,
    message: null,
    ...overrides,
  });
}

async function stateRow(w: World): Promise<RowDataPacket | undefined> {
  const [rows] = await w.context.pool.execute<RowDataPacket[]>(
    "SELECT * FROM agent_vm_state WHERE agent_id = ? AND vm_name = 'Win98'",
    [w.paired.agentId],
  );
  return rows[0];
}

async function restoreOptions(w: World) {
  const response = await w.admin.get('/admin/vms/qemu/Win98/restore-options');
  expect(response.statusCode, response.body).toBe(200);
  return restoreOptionsResponseSchema.parse(response.json());
}

/** Nothing of this type arrives for a while. */
async function nothing(agent: TestAgent, type: Parameters<TestAgent['next']>[0]): Promise<void> {
  await expect(agent.next(type, 300)).rejects.toThrow(/Timed out/);
}

async function insertSession(w: World, versionId: string | null = null): Promise<string> {
  const id = randomUUID();
  await w.context.pool.execute(
    `INSERT INTO vm_sessions
       (id, agent_id, request_id, emulator_type, vm_name, mode, execution_state, source_version_id)
     VALUES (?, ?, ?, 'qemu', 'Win98', 'local', 'unknown', ?)`,
    [id, w.paired.agentId, randomUUID(), versionId],
  );
  return id;
}

describe('removing a persistent local copy', () => {
  it('is offered only for a present copy on an agent that can remove it', async () => {
    const w = await cleanupWorld({ removeLocal: false });
    let agent = (await restoreOptions(w)).agents[0];
    expect(agent).toMatchObject({
      running: false,
      remove: { eligible: false, reason: 'agent_cannot_remove' },
    });
    expect(await errorCode(await removalRequest(w))).toBe('agent_cannot_remove');

    await resync(w, CLEANUP);
    agent = (await restoreOptions(w)).agents[0];
    expect(agent?.remove).toEqual({ eligible: true, reason: null });

    await w.context.pool.execute(
      "UPDATE agent_vm_state SET execution_state = 'absent' WHERE agent_id = ?",
      [w.paired.agentId],
    );
    agent = (await restoreOptions(w)).agents[0];
    expect(agent?.remove).toEqual({ eligible: false, reason: 'no_local_copy' });
    expect(await errorCode(await removalRequest(w))).toBe('no_local_copy');
  });

  it('is refused while the VM runs, or may be running', async () => {
    const w = await cleanupWorld();
    await insertSession(w);
    const agent = (await restoreOptions(w)).agents[0];
    expect(agent).toMatchObject({ running: true, remove: { reason: 'vm_running' } });
    expect(await errorCode(await removalRequest(w))).toBe('vm_running');
  });

  it('removes the copy, forgets it on that agent only, and keeps remote modes', async () => {
    const w = await cleanupWorld();
    // A second agent's copy of the same VM, which nothing here may touch.
    const otherAgent = randomUUID();
    await w.context.pool.execute(
      "INSERT INTO agents (id, name, paired_at) VALUES (?, 'B', NOW())",
      [otherAgent],
    );
    await w.context.pool.execute(
      `INSERT INTO agent_vm_state (agent_id, emulator_type, vm_name, local_source_version_id,
         execution_state, content_status) VALUES (?, 'qemu', 'Win98', ?, 'idle', 'unverified')`,
      [otherAgent, w.masterId],
    );

    const operation = await requestRemoval(w);
    expect(operation).toMatchObject({ state: 'requested', cleanupPending: false, error: null });
    const command = await w.agent.next('server.local_copy_remove');
    // An identity and what the administrator saw. Never a path.
    expect(command.payload).toEqual({
      operationId: operation.id,
      emulatorType: 'qemu',
      vmName: 'Win98',
      expectedVersionId: w.masterId,
      discardLocalChanges: false,
    });

    // While it runs, nothing else may start on that agent.
    expect(await errorCode(await removalRequest(w))).toBe('operation_in_progress');
    expect(await errorCode(await snapshotRequest(w))).toBe('operation_in_progress');
    const launch = executionOptionsResponseSchema.parse(
      (await w.admin.get('/admin/vms/qemu/Win98/execution-options')).json(),
    );
    const busy = launch.agents.find((item) => item.agentId === w.paired.agentId);
    expect(busy?.launch.reason).toBe('operation_in_progress');

    w.agent.send(removed(operation.id));
    expect((await w.agent.next('server.local_copy_remove_ack')).payload).toEqual({
      operationId: operation.id,
      outcome: 'closed',
    });
    const done = await removal(w, operation.id);
    expect(done).toMatchObject({
      state: 'succeeded',
      localDirectory: 'C:\\vms\\qemu\\Win98',
      error: null,
    });
    expect(done.finishedAt).not.toBeNull();
    expect(await stateRow(w)).toBeUndefined();
    const [others] = await w.context.pool.execute<RowDataPacket[]>(
      'SELECT local_source_version_id FROM agent_vm_state WHERE agent_id = ?',
      [otherAgent],
    );
    expect(others).toEqual([{ local_source_version_id: w.masterId }]);

    const options = await restoreOptions(w);
    const mine = options.agents.find((agent) => agent.agentId === w.paired.agentId);
    expect(mine).toMatchObject({
      eligible: true,
      local: { availability: 'none' },
      remove: { reason: 'no_local_copy' },
    });
    expect(options.versions.map((version) => version.versionId)).toContain(w.masterId);
    const execution = executionOptionsResponseSchema.parse(
      (await w.admin.get('/admin/vms/qemu/Win98/execution-options')).json(),
    );
    const agent = execution.agents.find((item) => item.agentId === w.paired.agentId);
    expect(agent?.launch.reason).toBe('vm_not_on_agent');
    expect(agent?.remote.remote_snapshot.eligible).toBe(true);

    // A late or repeated report changes nothing, and a stale sync cannot bring the copy back.
    w.agent.send(removed(operation.id));
    expect((await w.agent.next('server.local_copy_remove_ack')).payload.outcome).toBe('closed');
    w.agent.send(
      envelope('agent.restore_sync', {
        operations: [],
        capabilities: {
          emulators: [{ emulatorType: 'qemu', basePath: 'C:\\vms\\qemu' }],
          repositoryIds: [w.repository.id],
          cacheMaxBytes: 1,
          cacheUsedBytes: 0,
          removeLocal: true,
          deleteArchives: true,
        },
        localCopies: [
          { emulatorType: 'qemu', vmName: 'Win98', versionId: w.masterId, status: 'unknown' },
        ],
        workspaces: [],
      }),
    );
    await waitFor(async () => (await removal(w, operation.id)).state === 'succeeded');
    expect(await stateRow(w)).toBeUndefined();
    const [history] = await w.context.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM vm_versions WHERE id = ?',
      [w.masterId],
    );
    expect(Number(history[0]?.n)).toBe(1);
  });

  it('refuses a stale page and a modified copy unless its changes may be discarded', async () => {
    const w = await cleanupWorld();
    expect(await errorCode(await removalRequest(w, { expectedVersionId: randomUUID() }))).toBe(
      'local_copy_changed',
    );
    expect(await errorCode(await removalRequest(w, { expectedVersionId: null }))).toBe(
      'local_copy_changed',
    );
    await w.context.pool.execute(
      "UPDATE agent_vm_state SET content_status = 'modified' WHERE agent_id = ?",
      [w.paired.agentId],
    );
    expect(await errorCode(await removalRequest(w))).toBe('local_copy_modified');
    const operation = await requestRemoval(w, { discardLocalChanges: true });
    const command = await w.agent.next('server.local_copy_remove');
    expect(command.payload.discardLocalChanges).toBe(true);
    expect(operation.discardLocalChanges).toBe(true);
  });

  it('records the agent’s refusal, which keeps the copy', async () => {
    const w = await cleanupWorld();
    const operation = await requestRemoval(w);
    await w.agent.next('server.local_copy_remove');
    w.agent.send(
      removed(operation.id, {
        removed: false,
        localDirectory: null,
        code: 'local_copy_unsynced_media',
        message: 'A screenshot has not reached the server',
      }),
    );
    expect((await w.agent.next('server.local_copy_remove_ack')).payload.outcome).toBe('closed');
    const failed = await removal(w, operation.id);
    expect(failed).toMatchObject({
      state: 'failed',
      error: { code: 'local_copy_unsynced_media' },
    });
    expect(failed.recovery).toMatch(/synchronize/);
    expect((await stateRow(w))?.local_source_version_id).toBe(w.masterId);
    // The agent is free again.
    await requestRemoval(w);
  });

  it('removes once for a repeated request, and refuses a reused request ID', async () => {
    const w = await cleanupWorld();
    const requestId = randomUUID();
    const first = await requestRemoval(w, { requestId });
    const again = await requestRemoval(w, { requestId });
    expect(again.id).toBe(first.id);
    const reused = await removalRequest(w, { requestId, discardLocalChanges: true });
    expect(await errorCode(reused)).toBe('request_id_reused');
    const [rows] = await w.context.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM local_copy_removals',
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('lets one of two concurrent requests through', async () => {
    const w = await cleanupWorld();
    const responses = await Promise.all([removalRequest(w), removalRequest(w)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
  });

  it('is sent again only until the agent says it holds it, and is never repeated after', async () => {
    const w = await cleanupWorld();
    const operation = await requestRemoval(w);
    await w.agent.next('server.local_copy_remove');

    // The agent never got it, and reconnects: it is sent again.
    w.agent.close();
    const agent = await TestAgent.connect(wsUrl(w.context.app), w.paired.credential);
    await agent.hello();
    w.agent = agent;
    await resync(w, CLEANUP);
    expect((await agent.next('server.local_copy_remove')).payload.operationId).toBe(operation.id);

    // It lists it: accepted, and not sent again.
    await resync(w, { ...CLEANUP, removals: [{ operationId: operation.id, phase: 'checking' }] });
    await nothing(agent, 'server.local_copy_remove');
    expect((await removal(w, operation.id)).state).toBe('requested');

    // It lost its state directory: the operation is lost, and the copy stays recorded.
    await resync(w, CLEANUP);
    await waitFor(async () => (await removal(w, operation.id)).state === 'failed');
    expect((await removal(w, operation.id)).error?.code).toBe('agent_lost_operation');
    await nothing(agent, 'server.local_copy_remove');
    expect((await stateRow(w))?.local_source_version_id).toBe(w.masterId);
  });

  it('ends what is pending when the agent can no longer remove, or is revoked', async () => {
    const w = await cleanupWorld();
    const first = await requestRemoval(w);
    await resync(w, { removeLocal: false });
    await waitFor(async () => (await removal(w, first.id)).state === 'failed');

    await resync(w, CLEANUP);
    const second = await requestRemoval(w);
    const revoked = await w.admin.request({
      method: 'POST',
      url: `/admin/agents/${w.paired.agentId}/revoke`,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    await waitFor(async () => (await removal(w, second.id)).error?.code === 'agent_revoked');
  });

  it('shows leftovers until the agent says they are gone', async () => {
    const w = await cleanupWorld();
    const operation = await requestRemoval(w);
    await w.agent.next('server.local_copy_remove');
    w.agent.send(removed(operation.id, { cleanupPending: true, message: 'Some files remain' }));
    await w.agent.next('server.local_copy_remove_ack');
    expect(await removal(w, operation.id)).toMatchObject({
      state: 'succeeded',
      cleanupPending: true,
    });
    expect(await stateRow(w)).toBeUndefined();
    w.agent.send(removed(operation.id));
    await w.agent.next('server.local_copy_remove_ack');
    expect((await removal(w, operation.id)).cleanupPending).toBe(false);
  });

  it('rejects a result for an operation it never sent, and lists history by VM', async () => {
    const w = await cleanupWorld();
    const stray = randomUUID();
    w.agent.send(removed(stray));
    expect((await w.agent.next('server.local_copy_remove_ack')).payload).toEqual({
      operationId: stray,
      outcome: 'rejected',
    });
    expect(await stateRow(w)).toBeDefined();
    const operation = await requestRemoval(w);
    const list = await w.admin.get('/admin/local-copy-removals?vmName=Win98');
    expect(list.json<{ removals: { id: string }[] }>().removals.map((item) => item.id)).toEqual([
      operation.id,
    ]);
  });

  it('accepts no path and nothing but an identity', async () => {
    const w = await cleanupWorld();
    const response = await removalRequest(w, { localDirectory: 'C:\\Windows' });
    expect(response.statusCode).toBe(400);
    expect(await errorCode(await removalRequest(w, { vmName: '..\\Windows' }))).toBe(
      'validation_failed',
    );
  });
});

// Deleting a snapshot.

function deletionRequest(w: World, versionId: string, overrides: object = {}) {
  return w.admin.request({
    method: 'POST',
    url: `/admin/vms/qemu/Win98/versions/${versionId}/deletion`,
    payload: { versionId, requestId: randomUUID(), ...overrides },
  });
}

async function requestDeletion(w: World, versionId: string): Promise<VersionDeletion> {
  const response = await deletionRequest(w, versionId);
  expect(response.statusCode, response.body).toBe(202);
  return versionDeletionSchema.parse(response.json());
}

/** A published snapshot of the master that nothing holds: the local copy goes back to the master. */
async function leaf(w: World, parent?: string): Promise<string> {
  // A snapshot's parent is where the local copy came from.
  if (parent) await restoreVersion(w, parent);
  const operation = await snapshot(w, parent ? { parentVersionId: parent } : {});
  await complete(w, operation);
  await restoreVersion(w, w.masterId);
  return operation.versionId as string;
}

async function deletionOf(w: World, versionId: string): Promise<VersionDeletion | undefined> {
  const response = await w.admin.get('/admin/vms/qemu/Win98/version-deletions');
  expect(response.statusCode, response.body).toBe(200);
  return response
    .json<{ deletions: VersionDeletion[] }>()
    .deletions.map((item) => versionDeletionSchema.parse(item))
    .find((item) => item.versionId === versionId);
}

function archiveResult(
  attempt: { payload: { operationId: string; versionId: string } },
  outcome: 'deleted' | 'absent' | 'failed',
  code: string | null = null,
) {
  return envelope('agent.archive_delete_result', {
    operationId: attempt.payload.operationId,
    versionId: attempt.payload.versionId,
    outcome,
    code,
    message: code ? 'The repository is unreachable' : null,
  });
}

describe('deleting a snapshot', () => {
  it('offers only leaves nothing uses, and never the master', async () => {
    const w = await cleanupWorld();
    const a = await leaf(w);
    let nodes = new Map((await tree(w)).versions.map((node) => [node.id, node]));
    expect(nodes.get(w.masterId)?.deletable).toEqual({
      eligible: false,
      reason: 'master_cannot_be_deleted',
    });
    expect(nodes.get(a)?.deletable).toEqual({ eligible: true, reason: null });
    expect(await errorCode(await deletionRequest(w, w.masterId))).toBe('master_cannot_be_deleted');

    // A child makes it a branch; the child is the leaf.
    const b = await leaf(w, a);
    nodes = new Map((await tree(w)).versions.map((node) => [node.id, node]));
    expect(nodes.get(a)?.deletable.reason).toBe('snapshot_has_descendants');
    expect(nodes.get(b)?.deletable.eligible).toBe(true);
    expect(await errorCode(await deletionRequest(w, a))).toBe('snapshot_has_descendants');

    // Installed somewhere: replace or remove that copy first.
    await restoreVersion(w, b);
    expect(await errorCode(await deletionRequest(w, b))).toBe('snapshot_installed');
    await restoreVersion(w, w.masterId);

    // Used by a running session.
    const session = await insertSession(w, b);
    expect(await errorCode(await deletionRequest(w, b))).toBe('snapshot_in_use');
    await w.context.pool.execute(
      "UPDATE vm_sessions SET execution_state = 'stopped', ended_at = UTC_TIMESTAMP(3) WHERE id = ?",
      [session],
    );

    // No agent can reach the repository.
    await resync(w, { removeLocal: true, deleteArchives: false });
    nodes = new Map((await tree(w)).versions.map((node) => [node.id, node]));
    expect(nodes.get(b)?.deletable.reason).toBe('repository_unavailable');
    expect(await errorCode(await deletionRequest(w, b))).toBe('repository_unavailable');
  });

  it('records a tombstone, deletes the archive through an agent, and keeps history', async () => {
    const w = await cleanupWorld();
    const a = await leaf(w);
    const deletion = await requestDeletion(w, a);
    expect(deletion).toMatchObject({
      versionId: a,
      state: 'deleting',
      attempts: 1,
      archiveOutcome: null,
      parentVersionId: w.masterId,
      repositoryName: 'NAS',
    });
    const attempt = await w.agent.next('server.archive_delete');
    expect(attempt.payload).toMatchObject({
      versionId: a,
      emulatorType: 'qemu',
      vmName: 'Win98',
      repositoryId: w.repository.id,
      archiveKey: archiveObjectKey({ emulatorType: 'qemu', vmName: 'Win98' }, a),
      archiveSizeBytes: 4096,
    });

    // From the tombstone on, the version is unusable, however it is asked for.
    const node = (await tree(w)).versions.find((item) => item.id === a);
    expect(node?.deletion).toMatchObject({ attempts: 1, error: null });
    expect(node?.deletable).toEqual({ eligible: false, reason: null });
    expect((await restoreOptions(w)).versions.map((item) => item.versionId)).not.toContain(a);
    await w.context.pool.execute(
      "UPDATE agent_vm_state SET execution_state = 'absent' WHERE agent_id = ?",
      [w.paired.agentId],
    );
    const restore = await w.admin.request({
      method: 'POST',
      url: '/admin/restores',
      payload: { agentId: w.paired.agentId, emulatorType: 'qemu', vmName: 'Win98', versionId: a },
    });
    expect(await errorCode(restore)).toBe('version_deleted');
    await w.context.pool.execute(
      "UPDATE agent_vm_state SET execution_state = 'idle' WHERE agent_id = ?",
      [w.paired.agentId],
    );
    expect(await errorCode(await snapshotRequest(w, { parentVersionId: a }))).toBe(
      'version_deleted',
    );

    // Asked again, with another request ID: the same tombstone.
    const again = await requestDeletion(w, a);
    expect(again.requestedAt).toBe(deletion.requestedAt);
    await expect(w.agent.next('server.archive_delete', 300)).rejects.toThrow(/Timed out/);

    w.agent.send(archiveResult(attempt, 'deleted'));
    await waitFor(async () => (await deletionOf(w, a))?.state === 'deleted');
    expect(await deletionOf(w, a)).toMatchObject({ archiveOutcome: 'deleted', error: null });
    expect((await tree(w)).versions.map((item) => item.id)).not.toContain(a);
    // The version row, and the registration that created it, are history and stay.
    const [rows] = await w.context.pool.execute<RowDataPacket[]>(
      `SELECT (SELECT COUNT(*) FROM vm_versions WHERE id = ?) AS versions,
              (SELECT COUNT(*) FROM registration_operations WHERE version_id = ?) AS registrations`,
      [a, a],
    );
    expect(rows[0]).toMatchObject({ versions: 1, registrations: 1 });
    // The parent is a leaf again, and deletable in its own right.
    const parent = (await tree(w)).versions.find((item) => item.id === w.masterId);
    expect(parent?.childVersionIds).toEqual([]);
    const admin = await w.admin.get('/admin/vms/qemu/Win98');
    expect(admin.json<{ versionCount: number }>().versionCount).toBe(1);
  });

  it('says when the archive was already gone', async () => {
    const w = await cleanupWorld();
    const a = await leaf(w);
    await requestDeletion(w, a);
    const attempt = await w.agent.next('server.archive_delete');
    w.agent.send(archiveResult(attempt, 'absent'));
    await waitFor(async () => (await deletionOf(w, a))?.state === 'deleted');
    expect((await deletionOf(w, a))?.archiveOutcome).toBe('already_absent');
  });

  it('keeps a failed deletion unusable and retries it until the repository confirms', async () => {
    const w = await cleanupWorld(CLEANUP, 1000);
    const a = await leaf(w);
    await requestDeletion(w, a);
    const first = await w.agent.next('server.archive_delete');
    w.agent.send(archiveResult(first, 'failed', 'repository_unreachable'));
    await waitFor(async () => (await deletionOf(w, a))?.error?.code === 'repository_unreachable');
    expect((await deletionOf(w, a))?.state).toBe('deleting');

    // Retried by itself, as a new attempt.
    const second = await w.agent.next('server.archive_delete');
    expect(second.payload.operationId).not.toBe(first.payload.operationId);
    // A late answer to the first attempt that it failed counts for nothing.
    w.agent.send(archiveResult(first, 'failed', 'repository_unreachable'));
    // And an administrator can ask now.
    const retried = await w.admin.request({
      method: 'POST',
      url: `/admin/vms/qemu/Win98/versions/${a}/deletion/retry`,
    });
    expect(retried.statusCode, retried.body).toBe(202);
    const third = await w.agent.next('server.archive_delete');
    // The archive was deleted by an earlier attempt whose answer was lost: found absent, so deleted.
    w.agent.send(archiveResult(third, 'absent'));
    await waitFor(async () => (await deletionOf(w, a))?.state === 'deleted');
    expect(await deletionOf(w, a)).toMatchObject({ archiveOutcome: 'deleted', error: null });
    const finished = await w.admin.request({
      method: 'POST',
      url: `/admin/vms/qemu/Win98/versions/${a}/deletion/retry`,
    });
    expect(await errorCode(finished)).toBe('deletion_finished');
  });

  it('waits for an agent that can reach the repository, and sends it after its welcome', async () => {
    const w = await cleanupWorld();
    const a = await leaf(w);
    await requestDeletion(w, a);
    await w.agent.next('server.archive_delete');
    w.agent.close();
    const agent = await TestAgent.connect(wsUrl(w.context.app), w.paired.credential);
    await agent.hello();
    w.agent = agent;
    await resync(w, CLEANUP);
    const attempt = await agent.next('server.archive_delete');
    expect(attempt.payload.versionId).toBe(a);
  });

  it('accepts no confirmation for another version, and no result from a stranger', async () => {
    const w = await cleanupWorld();
    const a = await leaf(w);
    const mismatch = await deletionRequest(w, a, { versionId: w.masterId });
    expect(await errorCode(mismatch)).toBe('version_mismatch');
    const extra = await deletionRequest(w, a, { archiveKey: 'archives/other.zip' });
    expect(extra.statusCode).toBe(400);
    // A version of another VM is not found under this one.
    const [others] = await w.context.pool.execute<RowDataPacket[]>(
      "SELECT id FROM vm_versions WHERE vm_name = 'Other'",
    );
    const other = await deletionRequest(w, others[0]?.id as string);
    expect(other.statusCode).toBe(404);

    // An agent not associated with the repository cannot finish a deletion.
    await requestDeletion(w, a);
    const attempt = await w.agent.next('server.archive_delete');
    await w.context.pool.execute('DELETE FROM agent_repositories WHERE agent_id = ?', [
      w.paired.agentId,
    ]);
    w.agent.send(archiveResult(attempt, 'deleted'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await deletionOf(w, a))?.state).toBe('deleting');
  });

  it('never lets a restore and a deletion of one version both through', async () => {
    const w = await cleanupWorld();
    // Repeated, since which one wins depends on timing; neither may ever fail otherwise.
    for (let round = 0; round < 6; round += 1) {
      const a = await leaf(w);
      await w.context.pool.execute(
        "UPDATE agent_vm_state SET execution_state = 'absent' WHERE agent_id = ?",
        [w.paired.agentId],
      );
      const [restore, deletion] = await Promise.all([
        w.admin.request({
          method: 'POST',
          url: '/admin/restores',
          payload: {
            agentId: w.paired.agentId,
            emulatorType: 'qemu',
            vmName: 'Win98',
            versionId: a,
          },
        }),
        deletionRequest(w, a),
      ]);
      const outcomes = [restore.statusCode, deletion.statusCode];
      expect(
        outcomes.filter((status) => status === 202),
        restore.body + deletion.body,
      ).toHaveLength(1);
      if (restore.statusCode === 202) {
        expect(await errorCode(deletion)).toBe('snapshot_in_use');
        // Let the restore end, so that the next round starts from a free agent.
        const request = await w.agent.next('server.restore_request');
        w.agent.send(
          envelope('agent.restore_error', {
            operationId: request.payload.operationId,
            code: 'cancelled',
            message: 'Stopped by the test',
          }),
        );
        await w.agent.next('server.restore_ack');
      } else {
        expect(await errorCode(restore)).toBe('version_deleted');
        await w.agent.next('server.archive_delete');
      }
      await w.context.pool.execute(
        `UPDATE agent_vm_state SET execution_state = 'idle', local_source_version_id = ?
         WHERE agent_id = ?`,
        [w.masterId, w.paired.agentId],
      );
    }
  }, 60_000);

  it('never lets a snapshot of a version and its deletion both through', async () => {
    const w = await cleanupWorld();
    const a = await leaf(w);
    await restoreVersion(w, a);
    // Installed, so the deletion is refused; with the copy gone, only the race decides.
    await w.context.pool.execute(
      "UPDATE agent_vm_state SET execution_state = 'idle', local_source_version_id = ? WHERE agent_id = ?",
      [a, w.paired.agentId],
    );
    const [created, deleted] = await Promise.all([
      snapshotRequest(w, { parentVersionId: a }),
      deletionRequest(w, a),
    ]);
    expect([created.statusCode, deleted.statusCode].filter((s) => s === 202).length).toBeLessThan(
      2,
    );
  });

  it('keeps every cleanup route to administrators', async () => {
    const w = await cleanupWorld();
    for (const [method, url] of [
      ['GET', '/api/v1/admin/local-copy-removals'],
      ['POST', '/api/v1/admin/local-copy-removals'],
      ['GET', '/api/v1/admin/vms/qemu/Win98/version-deletions'],
      ['POST', `/api/v1/admin/vms/qemu/Win98/versions/${w.masterId}/deletion`],
    ] as const) {
      const response = await w.context.app.inject({ method, url });
      expect(response.statusCode, url).toBe(401);
    }
  });
});
