/**
 * Snapshots, the version tree, historical restores and Milestone 7 working copies, through the real API,
 * on a real database, over a real WebSocket. The agent is a script, so that every message a real agent
 * could send, repeat, lose or get wrong can be arranged exactly. See decisions 0037 to 0040; remote
 * sessions have their own file.
 */
import { randomUUID } from 'node:crypto';
import {
  archiveObjectKey,
  buildVersionTree,
  registrationOperationSchema,
  restoreOptionsResponseSchema,
  vmWorkspaceSchema,
  type VmWorkspace,
} from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import { afterEach, describe, expect, it } from 'vitest';
import { envelope, TestAgent, waitFor, wsUrl } from './agent-helpers.js';
import { TestClient } from './browser-app.js';
import {
  barrier,
  closeWorlds,
  complete,
  errorCode,
  localSource,
  resultFor,
  restoreVersion,
  resync,
  runningStatus,
  snapshot,
  snapshotRequest,
  stopSession,
  tree,
  versionCount,
  world,
  type World,
} from './version-world.js';

// Each test's world is closed after it, so that a file never holds many databases' connections at once.
afterEach(closeWorlds);

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

  it('lets a published but uncommitted snapshot be cancelled, and only then deletes the archive', async () => {
    const w = await world();
    const operation = await snapshot(w);
    await w.agent.next('server.registration_request');
    await w.context.pool.query(
      `CREATE TRIGGER fail_snapshot_commit BEFORE INSERT ON vm_versions FOR EACH ROW
       SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'simulated commit failure'`,
    );
    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    await barrier(w.agent);
    await w.context.pool.query('DROP TRIGGER fail_snapshot_commit');
    // Published, verified, waiting in committing: an administrator decides against it.
    const cancelled = await w.admin.request({
      method: 'POST',
      url: `/admin/registrations/${operation.id}/cancel`,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(registrationOperationSchema.parse(cancelled.json()).state).toBe('cancelled');
    // The agent repeats its report, and is told that nothing refers to what it published.
    w.agent.send(envelope('agent.registration_result', resultFor(operation)));
    const ack = await w.agent.next('server.registration_ack');
    expect(ack.payload).toMatchObject({ outcome: 'rejected', deletePublished: true });
    expect(await versionCount(w)).toBe(1);
    expect(await localSource(w)).toBe(w.masterId);
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

describe('lineage', () => {
  it('refuses a copy that disappeared and came back, until a verification proves what it is', async () => {
    const w = await world();
    const a = await snapshot(w);
    await complete(w, a);
    // Discovery saw the directory go and come back: it may be another VM with the same name.
    await w.context.pool.execute(
      "UPDATE agent_vm_state SET execution_state = 'unknown', content_status = 'unverified' WHERE agent_id = ?",
      [w.paired.agentId],
    );
    const refused = await snapshotRequest(w, { parentVersionId: a.versionId });
    expect(refused.statusCode).toBe(409);
    expect(await errorCode(refused)).toBe('snapshot_lineage_unverified');

    // Verification checks the copy against the version it is recorded as coming from, the snapshot.
    const started = await w.admin.request({
      method: 'POST',
      url: '/admin/verifications',
      payload: { agentId: w.paired.agentId, emulatorType: 'qemu', vmName: 'Win98' },
    });
    expect(started.statusCode, started.body).toBe(202);
    const request = await w.agent.next('server.vm_verify');
    expect(request.payload).toMatchObject({
      versionId: a.versionId,
      archiveKey: a.archiveKey,
      manifestSha256: 'd'.repeat(64),
    });
    const none = { count: 0, paths: [] };
    w.agent.send(
      envelope('agent.vm_verify_result', {
        operationId: request.payload.operationId,
        versionId: a.versionId,
        status: 'verified',
        filesVerified: 4,
        bytesHashed: 8192,
        durationMs: 1,
        missing: none,
        modified: none,
        unexpected: none,
        manifestSha256: 'd'.repeat(64),
        manifestSource: 'local',
        code: null,
        message: null,
      }),
    );
    await w.agent.next('server.vm_verify_ack');
    const [rows] = await w.context.pool.execute<RowDataPacket[]>(
      'SELECT execution_state, content_status, local_source_version_id FROM agent_vm_state WHERE agent_id = ?',
      [w.paired.agentId],
    );
    expect(rows[0]).toMatchObject({
      execution_state: 'idle',
      content_status: 'verified',
      local_source_version_id: a.versionId,
    });
    expect((await snapshotRequest(w, { parentVersionId: a.versionId })).statusCode).toBe(202);
  });

  it('records the agent’s lineage refusal as a failure that owns nothing', async () => {
    const w = await world();
    const operation = await snapshot(w);
    await w.agent.next('server.registration_request');
    w.agent.send(
      envelope('agent.registration_error', {
        operationId: operation.id,
        code: 'snapshot_lineage_unverified',
        message: 'This agent has no record of which version its local copy came from',
      }),
    );
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
    const failed = registrationOperationSchema.parse(
      (await w.admin.get(`/admin/registrations/${operation.id}`)).json(),
    );
    expect(failed).toMatchObject({
      state: 'failed',
      error: { code: 'snapshot_lineage_unverified' },
    });
    expect(failed.recovery).toMatch(/verify the local copy/);
    expect(await versionCount(w)).toBe(1);
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

describe('Milestone 7 working copies', () => {
  // Rows that existed before decision 0040 became manual working copies, with their old lifecycle. No
  // new one can be created, so these tests make them as the migration leaves them.
  async function legacyWorkspace(w: World): Promise<string> {
    const id = randomUUID();
    await w.context.pool.execute(
      `INSERT INTO vm_workspaces
         (id, agent_id, request_id, emulator_type, vm_name, state, base_version_id,
          source_version_id, local_directory)
       VALUES (?, ?, ?, 'qemu', 'Win98', 'ready', ?, ?, ?)`,
      [
        id,
        w.paired.agentId,
        randomUUID(),
        w.masterId,
        w.masterId,
        `C:\\state\\workspaces\\${id}\\Win98`,
      ],
    );
    return id;
  }

  async function readWorkspace(w: World, id: string): Promise<VmWorkspace> {
    const response = await w.admin.get(`/admin/workspaces/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return vmWorkspaceSchema.parse(response.json());
  }

  /** A legacy working copy launched by hand, as far as the agent's first running report. */
  async function launched(w: World) {
    const workspaceId = await legacyWorkspace(w);
    const response = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspaceId}/launch`,
      payload: { requestId: randomUUID() },
    });
    expect(response.statusCode, response.body).toBe(202);
    const launch = await w.agent.next('server.vm_launch');
    expect(launch.payload).toMatchObject({
      mode: 'remote_snapshot',
      workspaceId,
      versionId: w.masterId,
    });
    const status = runningStatus(launch.payload.sessionId as string);
    w.agent.send(envelope('agent.vm_execution_status', status));
    await barrier(w.agent);
    return { workspaceId, sessionId: launch.payload.sessionId as string, status };
  }

  it('keeps their purpose, and are never advanced on their own', async () => {
    const w = await world();
    const { workspaceId, status } = await launched(w);
    const current = await readWorkspace(w, workspaceId);
    expect(current).toMatchObject({ purpose: 'manual', state: 'ready', mayHaveChanges: true });
    await stopSession(w, status);
    // Stopping publishes nothing and removes nothing.
    await resync(w, { workspaces: [workspaceId] });
    expect(await readWorkspace(w, workspaceId)).toMatchObject({ state: 'ready' });
    expect(await versionCount(w)).toBe(1);
    expect(
      w.agent.received.filter((m) =>
        ['server.registration_request', 'server.workspace_discard'].includes(m.type),
      ),
    ).toEqual([]);
  });

  it('are preserved, relaunched and discarded by hand, as before', async () => {
    const w = await world();
    const { workspaceId, status } = await launched(w);
    // Running: nothing can be preserved or discarded.
    const early = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspaceId}/snapshot`,
      payload: { requestId: randomUUID() },
    });
    expect(await errorCode(early)).toBe('vm_running');
    const discardEarly = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspaceId}/discard`,
      payload: { confirmVmName: 'Win98' },
    });
    expect(await errorCode(discardEarly)).toBe('vm_running');
    await stopSession(w, status);

    const preserved = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspaceId}/snapshot`,
      payload: { requestId: randomUUID() },
    });
    expect(preserved.statusCode, preserved.body).toBe(202);
    const operation = registrationOperationSchema.parse(preserved.json());
    expect(operation).toMatchObject({ parentVersionId: w.masterId, workspaceId });
    await complete(w, operation);
    expect(await readWorkspace(w, workspaceId)).toMatchObject({
      sourceVersionId: operation.versionId,
      mayHaveChanges: false,
    });
    expect(await localSource(w), 'still the persistent copy’s own').toBe(w.masterId);
    const versions = await tree(w);
    expect(versions.versions.find((v) => v.id === operation.versionId)?.holders).toEqual([
      expect.objectContaining({ kind: 'workspace', workspaceId }),
    ]);

    // A second session branches from the snapshot just made.
    const relaunched = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspaceId}/launch`,
      payload: { requestId: randomUUID() },
    });
    expect(relaunched.statusCode, relaunched.body).toBe(202);
    const second = await w.agent.next('server.vm_launch');
    expect(second.payload).toMatchObject({ versionId: operation.versionId });
    await stopSession(w, { ...status, sessionId: second.payload.sessionId });
    expect((await readWorkspace(w, workspaceId)).mayHaveChanges).toBe(true);

    // Unpreserved changes need the name typed to be thrown away.
    const unconfirmed = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspaceId}/discard`,
      payload: {},
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(await errorCode(unconfirmed)).toBe('confirmation_required');
    const discarding = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspaceId}/discard`,
      payload: { confirmVmName: 'win98' },
    });
    expect(discarding.statusCode, discarding.body).toBe(200);
    expect(vmWorkspaceSchema.parse(discarding.json()).state).toBe('discarding');
    const discard = await w.agent.next('server.workspace_discard');
    expect(discard.payload).toEqual({ workspaceId, emulatorType: 'qemu', vmName: 'Win98' });
    // A refusal puts it back, to be discarded again by hand.
    w.agent.send(
      envelope('agent.workspace_discard_result', {
        workspaceId,
        removed: false,
        code: 'vm_running',
        message: 'The VM is running.',
      }),
    );
    await barrier(w.agent);
    expect(await readWorkspace(w, workspaceId)).toMatchObject({
      state: 'ready',
      error: { code: 'vm_running' },
    });
    await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspaceId}/discard`,
      payload: { confirmVmName: 'Win98' },
    });
    await w.agent.next('server.workspace_discard');
    w.agent.send(
      envelope('agent.workspace_discard_result', {
        workspaceId,
        removed: true,
        code: null,
        message: null,
      }),
    );
    await barrier(w.agent);
    expect((await readWorkspace(w, workspaceId)).state).toBe('discarded');
    // The snapshots it produced stay.
    expect(await versionCount(w)).toBe(2);
  });

  it('cannot be created any more, and cannot run in another mode', async () => {
    const w = await world({ modes: ['local', 'remote_volatile', 'remote_snapshot'] });
    const legacy = await w.admin.request({
      method: 'POST',
      url: '/admin/vms/qemu/Win98/workspaces',
      payload: {
        agentId: w.paired.agentId,
        versionId: w.masterId,
        requestId: randomUUID(),
        launch: true,
      },
    });
    expect(legacy.statusCode).toBe(400);
    const workspaceId = await legacyWorkspace(w);
    const volatile = await w.admin.request({
      method: 'POST',
      url: '/admin/sessions',
      payload: {
        agentId: w.paired.agentId,
        emulatorType: 'qemu',
        vmName: 'Win98',
        mode: 'remote_volatile',
        requestId: randomUUID(),
        workspaceId,
      },
    });
    expect(volatile.statusCode, volatile.body).toBe(409);
    expect(await errorCode(volatile)).toBe('workspace_purpose_mismatch');
  });

  it('reconcile with what the agent holds after it reconnects', async () => {
    const w = await world();
    const { workspaceId, status } = await launched(w);
    await stopSession(w, status);
    const discarding = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspaceId}/discard`,
      payload: { confirmVmName: 'Win98' },
    });
    expect(discarding.statusCode).toBe(200);
    await w.agent.next('server.workspace_discard');
    // The answer is lost. Still held: asked again.
    await resync(w, { workspaces: [workspaceId] });
    await w.agent.next('server.workspace_discard');
    // Gone: recorded as discarded.
    await resync(w, { workspaces: [] });
    expect((await readWorkspace(w, workspaceId)).state).toBe('discarded');

    // A ready one the agent no longer has is lost, and says so.
    const second = await legacyWorkspace(w);
    await resync(w, { workspaces: [] });
    expect(await readWorkspace(w, second)).toMatchObject({
      state: 'lost',
      error: { code: 'workspace_missing' },
    });
    // One wrongly recorded as missing comes back, rather than being abandoned.
    await resync(w, { workspaces: [second] });
    expect(await readWorkspace(w, second)).toMatchObject({
      state: 'ready',
      error: null,
      finishedAt: null,
    });
  });

  it('make a discard wait for a launch holding the agent, and then see its session', async () => {
    const w = await world();
    const workspaceId = await legacyWorkspace(w);
    // A launch in flight: it holds the agent's row, as the real one does, and creates its session.
    const launch = await w.context.pool.getConnection();
    await launch.beginTransaction();
    await launch.execute('SELECT id FROM agents WHERE id = ? FOR UPDATE', [w.paired.agentId]);
    await launch.execute(
      `INSERT INTO vm_sessions (id, agent_id, emulator_type, vm_name, mode, workspace_id,
         execution_state)
       VALUES (?, ?, 'qemu', 'Win98', 'remote_snapshot', ?, 'requested')`,
      [randomUUID(), w.paired.agentId, workspaceId],
    );
    const discarding = w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspaceId}/discard`,
      payload: { confirmVmName: 'Win98' },
    });
    // Without waiting for the lock, the discard would find no session and go ahead.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await launch.commit();
    launch.release();
    const response = await discarding;
    expect(response.statusCode, response.body).toBe(409);
    expect(await errorCode(response)).toBe('vm_running');
    expect((await readWorkspace(w, workspaceId)).state).toBe('ready');
    await barrier(w.agent);
    expect(w.agent.received.filter((m) => m.type === 'server.workspace_discard')).toEqual([]);
  });

  it('refuse to discard while the agent is busy with any operation', async () => {
    const w = await world();
    const workspaceId = await legacyWorkspace(w);
    // A snapshot of the persistent copy is under way on the same agent.
    await snapshot(w);
    const discarding = await w.admin.request({
      method: 'POST',
      url: `/admin/workspaces/${workspaceId}/discard`,
      payload: { confirmVmName: 'Win98' },
    });
    expect(discarding.statusCode).toBe(409);
    expect(await errorCode(discarding)).toBe('operation_in_progress');
    expect((await readWorkspace(w, workspaceId)).state).toBe('ready');
  });

  it('protect the persistent copy while one of them runs', async () => {
    const w = await world();
    await launched(w);
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
