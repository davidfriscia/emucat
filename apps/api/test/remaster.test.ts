/**
 * Master and snapshot lifecycle (decision 0048) through the real API, on a real database, over a real WebSocket:
 * promoting a snapshot to master, replacing a VM's history with a new master exported from a local copy, and
 * snapshot titles and descriptions. The agent is a script, so that every answer a real agent could give, repeat,
 * lose or get wrong can be arranged. Nothing here touches a real repository or a real VM.
 */
import { randomUUID } from 'node:crypto';
import {
  archiveObjectKey,
  buildVersionTree,
  remasterOperationSchema,
  remasterPreviewSchema,
  type RemasterOperation,
  type RemasterPreview,
} from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import { afterEach, describe, expect, it } from 'vitest';
import { envelope, TestAgent, waitFor, wsUrl } from './agent-helpers.js';
import { insertMedia } from './browser-app.js';
import {
  barrier,
  closeWorlds,
  complete,
  errorCode,
  localSource,
  MANIFEST_SHA,
  resultFor,
  resync,
  SHA,
  snapshot,
  snapshotRequest,
  tree,
  world,
  type Capabilities,
  type World,
} from './version-world.js';

afterEach(closeWorlds);

const CLEANUP: Capabilities = { removeLocal: true, deleteArchives: true };

async function remasterWorld(capabilities: Capabilities = CLEANUP) {
  return world(
    capabilities,
    {},
    { versionDeletions: { retryBaseMs: 60_000, retryMaxMs: 240_000, sweepIntervalMs: 50 } },
  );
}

/** A snapshot row, as a committed snapshot leaves it, made directly so that any graph can be arranged. */
async function insertSnapshot(
  w: World,
  parent: string,
  minute: number,
  vmName = 'Win98',
): Promise<string> {
  const id = randomUUID();
  await w.context.pool.execute(
    `INSERT INTO vm_versions
       (id, emulator_type, vm_name, kind, parent_version_id, snapshot_name, repository_id, archive_key,
        archive_sha256, archive_size_bytes, created_by_agent_id, created_at)
     VALUES (?, 'qemu', ?, 'snapshot', ?, ?, ?, ?, ?, 4096, ?,
             TIMESTAMPADD(MINUTE, ?, UTC_TIMESTAMP(3)))`,
    [
      id,
      vmName,
      parent,
      `${vmName}_2026010100${String(minute).padStart(2, '0')}`,
      w.repository.id,
      archiveObjectKey({ emulatorType: 'qemu', vmName }, id),
      'c'.repeat(64),
      w.paired.agentId,
      minute,
    ],
  );
  return id;
}

/** M0 ─ S1 ─ S2 ─ S3 ─ S4 */
async function linear(w: World): Promise<string[]> {
  const ids = [w.masterId];
  for (let n = 1; n <= 4; n += 1) ids.push(await insertSnapshot(w, ids[n - 1] as string, n));
  return ids;
}

async function promotionPreview(w: World, versionId: string): Promise<RemasterPreview> {
  const response = await w.admin.get(`/admin/vms/qemu/Win98/versions/${versionId}/promotion`);
  expect(response.statusCode, response.body).toBe(200);
  return remasterPreviewSchema.parse(response.json());
}

function promotionRequest(w: World, versionId: string, body: object) {
  return w.admin.request({
    method: 'POST',
    url: `/admin/vms/qemu/Win98/versions/${versionId}/promotion`,
    payload: { requestId: randomUUID(), ...body },
  });
}

async function promote(w: World, versionId: string, body: object = {}): Promise<RemasterOperation> {
  const preview = await promotionPreview(w, versionId);
  const response = await promotionRequest(w, versionId, {
    expectedRevision: preview.revision,
    ...body,
  });
  expect(response.statusCode, response.body).toBe(202);
  return remasterOperationSchema.parse(response.json());
}

async function remaster(w: World, id: string): Promise<RemasterOperation> {
  const response = await w.admin.get(`/admin/remasters/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return remasterOperationSchema.parse(response.json());
}

async function localPreview(w: World): Promise<RemasterPreview> {
  const response = await w.admin.get(
    `/admin/vms/qemu/Win98/remaster/local?agentId=${w.paired.agentId}`,
  );
  expect(response.statusCode, response.body).toBe(200);
  return remasterPreviewSchema.parse(response.json());
}

function localRequest(w: World, body: object = {}) {
  return w.admin.request({
    method: 'POST',
    url: '/admin/vms/qemu/Win98/remaster/local',
    payload: {
      agentId: w.paired.agentId,
      requestId: randomUUID(),
      confirmVmName: 'Win98',
      ...body,
    },
  });
}

async function remasterLocally(w: World, body: object = {}): Promise<RemasterOperation> {
  const preview = await localPreview(w);
  const response = await localRequest(w, { expectedRevision: preview.revision, ...body });
  expect(response.statusCode, response.body).toBe(202);
  return remasterOperationSchema.parse(response.json());
}

/** Answers each archive deletion the agent is asked for, with this outcome. Returns the versions named. */
async function answerDeletions(
  w: World,
  count: number,
  outcome: 'deleted' | 'absent' | 'failed' = 'deleted',
): Promise<{ versionId: string; archiveKey: string; emulatorType: string }[]> {
  const named = [];
  for (let n = 0; n < count; n += 1) {
    const attempt = await w.agent.next('server.archive_delete');
    named.push(attempt.payload);
    w.agent.send(
      envelope('agent.archive_delete_result', {
        operationId: attempt.payload.operationId,
        versionId: attempt.payload.versionId,
        outcome,
        code: outcome === 'failed' ? 'repository_unreachable' : null,
        message: outcome === 'failed' ? 'The repository is unreachable' : null,
      }),
    );
  }
  await barrier(w.agent);
  return named;
}

async function versionRow(w: World, id: string): Promise<RowDataPacket | undefined> {
  const [rows] = await w.context.pool.execute<RowDataPacket[]>(
    'SELECT * FROM vm_versions WHERE id = ?',
    [id],
  );
  return rows[0];
}

async function tombstones(w: World): Promise<string[]> {
  const [rows] = await w.context.pool.execute<RowDataPacket[]>(
    "SELECT version_id FROM vm_version_deletions WHERE vm_name = 'Win98' ORDER BY version_id",
  );
  return rows.map((row) => row.version_id as string);
}

/** Nothing of this type arrives for a while. */
async function nothing(agent: TestAgent, type: Parameters<TestAgent['next']>[0]): Promise<void> {
  await expect(agent.next(type, 300)).rejects.toThrow(/Timed out/);
}

const sorted = (ids: readonly string[]) => [...ids].sort();

describe('promoting a snapshot to master', () => {
  it('keeps the snapshot and its descendants, re-rooted, and removes its ancestors', async () => {
    const w = await remasterWorld();
    const [m0, s1, s2, s3, s4] = (await linear(w)) as [string, string, string, string, string];
    const before = await versionRow(w, s2);

    const preview = await promotionPreview(w, s2);
    expect(preview.currentMaster.id).toBe(m0);
    expect(preview.promoted?.id).toBe(s2);
    expect(preview.retained.map((v) => v.id)).toEqual([s2, s3, s4]);
    expect(preview.removed.map((v) => v.id)).toEqual([m0, s1]);
    expect(preview.removedBytes).toBe(2048 + 4096);
    expect(preview.refusal).toBeNull();
    expect(preview.cleanupAvailable).toBe(true);
    // The persistent copy comes from M0, which goes: it is reported, never relabelled.
    expect(preview.lineageConflicts).toEqual([
      expect.objectContaining({ agentId: w.paired.agentId, versionId: m0 }),
    ]);

    const operation = await promote(w, s2, { acknowledgeLineageConflicts: true });
    expect(operation).toMatchObject({
      kind: 'snapshot',
      state: 'cleaning',
      phase: 'cleaning',
      previousMasterVersionId: m0,
      newMasterVersionId: s2,
      retainedCount: 3,
      removedCount: 2,
      cleanup: { total: 2, deleted: 0, complete: false },
    });

    const history = await tree(w);
    expect(history.rootVersionId).toBe(s2);
    expect(history.versions.map((v) => v.id)).toEqual([s2, s3, s4]);
    const built = buildVersionTree(history.versions);
    expect(built.ok).toBe(true);
    const root = history.versions[0];
    expect(root).toMatchObject({ kind: 'master', parentVersionId: null, childVersionIds: [s3] });
    expect(root?.promotedAt).not.toBeNull();
    // The archive was not made again: same key, hash, size, label and creation time.
    const after = await versionRow(w, s2);
    for (const column of [
      'archive_key',
      'archive_sha256',
      'archive_size_bytes',
      'snapshot_name',
      'created_at',
      'repository_id',
    ]) {
      expect(after?.[column]).toEqual(before?.[column]);
    }
    expect(after?.promoted_from_parent_version_id).toBe(s1);
    expect((await versionRow(w, m0))?.retired_at).not.toBeNull();

    // The obsolete archives, and only those, are deleted by the agent; then the remaster is complete.
    const named = await answerDeletions(w, 2);
    expect(sorted(named.map((item) => item.versionId))).toEqual(sorted([m0, s1]));
    for (const item of named) {
      expect(item.archiveKey).toBe(
        archiveObjectKey({ emulatorType: 'qemu', vmName: 'Win98' }, item.versionId),
      );
    }
    const done = await waitFor(async () => {
      const current = await remaster(w, operation.id);
      return current.state === 'completed' ? current : null;
    });
    expect(done).toMatchObject({
      phase: 'completed',
      cleanup: { total: 2, deleted: 2, complete: true },
    });
    expect(sorted(await tombstones(w))).toEqual(sorted([m0, s1]));
    // The local copy is untouched: it still says where it came from.
    expect(await localSource(w)).toBe(m0);
  });

  it('keeps the promoted branch whole, and removes every other branch', async () => {
    const w = await remasterWorld();
    const m0 = w.masterId;
    // M0 ─ S1 ┬ S2 ─ S4
    //         └ S3 (newer than S2, older than S4)
    const s1 = await insertSnapshot(w, m0, 1);
    const s2 = await insertSnapshot(w, s1, 2);
    const s3 = await insertSnapshot(w, s1, 3);
    const s4 = await insertSnapshot(w, s2, 4);

    const preview = await promotionPreview(w, s2);
    expect(preview.retained.map((v) => v.id)).toEqual([s2, s4]);
    expect(preview.removed.map((v) => v.id)).toEqual([m0, s1, s3]);
    await promote(w, s2, { acknowledgeLineageConflicts: true });
    const history = await tree(w);
    expect(history.versions.map((v) => v.id)).toEqual([s2, s4]);
    expect(history.versions[1]?.parentVersionId).toBe(s2);
    expect(buildVersionTree(history.versions).ok).toBe(true);
  });

  it('promotes the earliest snapshot, removing only the master', async () => {
    const w = await remasterWorld();
    const [m0, s1, s2, s3, s4] = (await linear(w)) as [string, string, string, string, string];
    await promote(w, s1, { acknowledgeLineageConflicts: true });
    expect((await tree(w)).versions.map((v) => v.id)).toEqual([s1, s2, s3, s4]);
    expect(await tombstones(w)).toEqual([m0]);
  });

  it('promotes the latest snapshot, which then stands alone', async () => {
    const w = await remasterWorld();
    const ids = (await linear(w)) as [string, string, string, string, string];
    await promote(w, ids[4], { acknowledgeLineageConflicts: true });
    const history = await tree(w);
    expect(history.versions.map((v) => v.id)).toEqual([ids[4]]);
    expect(history.versions[0]).toMatchObject({ kind: 'master', childVersionIds: [] });
    expect(sorted(await tombstones(w))).toEqual(sorted(ids.slice(0, 4)));
  });

  it('refuses an unknown version, another VM’s, a deleted one, and the master itself', async () => {
    const w = await remasterWorld();
    const s1 = await insertSnapshot(w, w.masterId, 1);
    const revision = (await promotionPreview(w, s1)).revision;
    expect(
      (await promotionRequest(w, randomUUID(), { expectedRevision: revision })).statusCode,
    ).toBe(404);
    const [others] = await w.context.pool.execute<RowDataPacket[]>(
      "SELECT id FROM vm_versions WHERE vm_name = 'Other'",
    );
    const foreign = await insertSnapshot(w, others[0]?.id as string, 2, 'Other');
    const response = await promotionRequest(w, foreign, { expectedRevision: revision });
    expect(response.statusCode).toBe(404);
    expect(await errorCode(response)).toBe('version_not_found');
    expect(
      await errorCode(await promotionRequest(w, w.masterId, { expectedRevision: revision })),
    ).toBe('version_is_master');
    // Nothing changed.
    expect((await tree(w)).rootVersionId).toBe(w.masterId);
    expect(await tombstones(w)).toEqual([]);
  });

  it('refuses a history that changed since it was shown, and changes nothing', async () => {
    const w = await remasterWorld();
    const s1 = await insertSnapshot(w, w.masterId, 1);
    const preview = await promotionPreview(w, s1);
    // Someone else's snapshot lands in between.
    await insertSnapshot(w, s1, 2);
    const response = await promotionRequest(w, s1, {
      expectedRevision: preview.revision,
      acknowledgeLineageConflicts: true,
    });
    expect(response.statusCode).toBe(409);
    expect(await errorCode(response)).toBe('version_history_stale');
    expect((await tree(w)).rootVersionId).toBe(w.masterId);
    // Editing a title does not stale a history.
    const fresh = await promotionPreview(w, s1);
    await w.admin.request({
      method: 'PATCH',
      url: `/admin/vms/qemu/Win98/versions/${s1}`,
      payload: { title: 'Renamed', description: null },
    });
    expect((await promotionPreview(w, s1)).revision).toBe(fresh.revision);
  });

  it('refuses while another operation works on the VM, or uses a version that would go', async () => {
    const w = await remasterWorld();
    const s1 = await insertSnapshot(w, w.masterId, 1);
    const s2 = await insertSnapshot(w, s1, 2);

    // A snapshot in progress.
    const pending = await snapshot(w);
    let preview = await promotionPreview(w, s2);
    expect(preview.refusal?.code).toBe('operation_in_progress');
    let response = await promotionRequest(w, s2, {
      expectedRevision: preview.revision,
      acknowledgeLineageConflicts: true,
    });
    expect(await errorCode(response)).toBe('operation_in_progress');
    await w.context.pool.execute(
      `UPDATE registration_operations SET state = 'failed', error_code = 'cancelled',
         finished_at = UTC_TIMESTAMP(3) WHERE id = ?`,
      [pending.id],
    );

    // A session running S1, which would be removed.
    const session = randomUUID();
    await w.context.pool.execute(
      `INSERT INTO vm_sessions
         (id, agent_id, request_id, emulator_type, vm_name, mode, execution_state, source_version_id)
       VALUES (?, ?, ?, 'qemu', 'Win98', 'local', 'running', ?)`,
      [session, w.paired.agentId, randomUUID(), s1],
    );
    preview = await promotionPreview(w, s2);
    expect(preview.refusal?.code).toBe('version_in_use');
    response = await promotionRequest(w, s2, {
      expectedRevision: preview.revision,
      acknowledgeLineageConflicts: true,
    });
    expect(await errorCode(response)).toBe('version_in_use');
    // A session of a version that stays is no obstacle.
    await w.context.pool.execute('UPDATE vm_sessions SET source_version_id = ? WHERE id = ?', [
      s2,
      session,
    ]);
    expect((await promotionPreview(w, s2)).refusal).toBeNull();
  });

  it('requires an explicit acknowledgement for copies of removed versions, and keeps their lineage', async () => {
    const w = await remasterWorld();
    const s1 = await insertSnapshot(w, w.masterId, 1);
    const s2 = await insertSnapshot(w, s1, 2);
    await w.context.pool.execute(
      `UPDATE agent_vm_state SET local_source_version_id = ? WHERE agent_id = ?`,
      [s1, w.paired.agentId],
    );
    const preview = await promotionPreview(w, s2);
    expect(preview.lineageConflicts.map((c) => c.versionId)).toEqual([s1]);
    let response = await promotionRequest(w, s2, { expectedRevision: preview.revision });
    expect(response.statusCode).toBe(409);
    expect(await errorCode(response)).toBe('source_lineage_conflict');
    response = await promotionRequest(w, s2, {
      expectedRevision: preview.revision,
      acknowledgeLineageConflicts: true,
    });
    expect(response.statusCode, response.body).toBe(202);
    // Still the version its files came from, never the promoted one.
    expect(await localSource(w)).toBe(s1);
    // So it cannot be snapshotted until it is restored: its parent is gone.
    const refused = await snapshotRequest(w, { parentVersionId: s1 });
    expect(await errorCode(refused)).toBe('version_deleted');
  });

  it('keeps cleaning, and says so, while an archive cannot be deleted; a retry finishes it', async () => {
    const w = await remasterWorld();
    const s1 = await insertSnapshot(w, w.masterId, 1);
    const operation = await promote(w, s1, { acknowledgeLineageConflicts: true });
    await answerDeletions(w, 1, 'failed');
    let current = await remaster(w, operation.id);
    expect(current).toMatchObject({ state: 'cleaning', cleanup: { complete: false, deleted: 0 } });
    expect(current.cleanup.items[0]?.error?.code).toBe('repository_unreachable');
    // The new master is the master all along: nothing is rolled back.
    expect((await tree(w)).rootVersionId).toBe(s1);

    const retried = await w.admin.request({
      method: 'POST',
      url: `/admin/remasters/${operation.id}/cleanup/retry`,
    });
    expect(retried.statusCode, retried.body).toBe(202);
    // The archive was in fact already gone: absent is as good as deleted.
    await answerDeletions(w, 1, 'absent');
    current = await waitFor(async () => {
      const next = await remaster(w, operation.id);
      return next.state === 'completed' ? next : null;
    });
    expect(current.cleanup.items[0]).toMatchObject({ state: 'deleted', archiveOutcome: 'deleted' });
  });

  it('finishes its cleanup after the agent reconnects, from the durable manifest alone', async () => {
    // No agent can delete archives at first: the promotion commits and its cleanup waits.
    const w = await remasterWorld({ removeLocal: true, deleteArchives: false });
    const s1 = await insertSnapshot(w, w.masterId, 1);
    const s2 = await insertSnapshot(w, s1, 2);
    const preview = await promotionPreview(w, s2);
    expect(preview.cleanupAvailable).toBe(false);
    const operation = await promote(w, s2, { acknowledgeLineageConflicts: true });
    await nothing(w.agent, 'server.archive_delete');
    expect((await remaster(w, operation.id)).state).toBe('cleaning');

    // A new connection, as after either side restarted, that can delete.
    w.agent.close();
    const agent = await TestAgent.connect(wsUrl(w.context.app), w.paired.credential);
    await agent.hello();
    w.agent = agent;
    await resync(w, CLEANUP);
    const named = await answerDeletions(w, 2);
    expect(sorted(named.map((item) => item.versionId))).toEqual(sorted([w.masterId, s1]));
    await waitFor(async () => (await remaster(w, operation.id)).state === 'completed');
  });

  it('returns the same remaster for a repeated request, and refuses a reused request ID', async () => {
    const w = await remasterWorld();
    const s1 = await insertSnapshot(w, w.masterId, 1);
    const s2 = await insertSnapshot(w, s1, 2);
    const preview = await promotionPreview(w, s1);
    const body = {
      requestId: randomUUID(),
      expectedRevision: preview.revision,
      acknowledgeLineageConflicts: true,
    };
    const first = await promotionRequest(w, s1, body);
    const second = await promotionRequest(w, s1, body);
    expect(first.statusCode, first.body).toBe(202);
    expect(second.statusCode, second.body).toBe(202);
    expect(second.json<RemasterOperation>().id).toBe(first.json<RemasterOperation>().id);
    expect(await tombstones(w)).toEqual([w.masterId]);
    expect(await errorCode(await promotionRequest(w, s2, body))).toBe('request_id_reused');
  });

  it('keeps the database’s invariants whatever the application does', async () => {
    const w = await remasterWorld();
    const s1 = await insertSnapshot(w, w.masterId, 1);
    const { pool } = w.context;
    // An archive never changes, nor its creation time.
    await expect(
      pool.execute('UPDATE vm_versions SET archive_sha256 = ? WHERE id = ?', ['e'.repeat(64), s1]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.execute('UPDATE vm_versions SET created_at = UTC_TIMESTAMP(3) WHERE id = ?', [s1]),
    ).rejects.toThrow(/immutable/);
    // A second master cannot appear while the first is current.
    await expect(
      pool.execute(
        `UPDATE vm_versions SET kind = 'master', parent_version_id = NULL,
           promoted_at = UTC_TIMESTAMP(3), promoted_from_parent_version_id = ? WHERE id = ?`,
        [w.masterId, s1],
      ),
    ).rejects.toThrow(/Duplicate/);
    // The current master is never tombstoned.
    await expect(
      pool.execute(
        `INSERT INTO vm_version_deletions
           (version_id, emulator_type, vm_name, request_id, repository_id, archive_key,
            archive_sha256, archive_size_bytes)
         VALUES (?, 'qemu', 'Win98', ?, ?, 'k', ?, 1)`,
        [w.masterId, randomUUID(), w.repository.id, SHA],
      ),
    ).rejects.toThrow(/current master never is/);
    // A retired master stays retired.
    await promote(w, s1, { acknowledgeLineageConflicts: true });
    await expect(
      pool.execute('UPDATE vm_versions SET retired_at = NULL WHERE id = ?', [w.masterId]),
    ).rejects.toThrow(/retired/);
  });
});

describe('remastering from a local copy', () => {
  it('replaces the whole history with one new master, then deletes every old archive', async () => {
    const w = await remasterWorld();
    const [m0, s1, s2] = (await linear(w)).slice(0, 3) as [string, string, string];
    const media = await insertMedia(w.context, { vmName: 'Win98' }, { isMain: true });
    await w.context.pool.execute(
      "UPDATE virtual_machines SET display_name = 'Windows 98', description = 'Kept' WHERE vm_name = 'Win98'",
    );

    const preview = await localPreview(w);
    expect(preview).toMatchObject({
      kind: 'local_copy',
      promoted: null,
      retained: [],
      refusal: null,
      source: { agentId: w.paired.agentId, online: true, sourceName: 'Win98' },
      lineageConflicts: [],
    });
    expect(preview.removed.map((v) => v.id)).toEqual([
      m0,
      s1,
      s2,
      expect.any(String),
      expect.any(String),
    ]);

    const operation = await remasterLocally(w);
    expect(operation).toMatchObject({ kind: 'local_copy', state: 'exporting', phase: 'exporting' });

    // To the agent, it is a copy of its local VM: nothing it is asked to do removes anything.
    const request = await w.agent.next('server.registration_request');
    expect(request.payload).toMatchObject({ mode: 'copy', vmName: 'Win98', emulatorType: 'qemu' });
    expect(request.payload).not.toHaveProperty('parentVersionId');
    // Nothing in the catalog changes before the commit.
    expect((await tree(w)).rootVersionId).toBe(m0);

    const registration = {
      id: request.payload.operationId,
      versionId: request.payload.versionId,
      archiveKey: request.payload.archiveKey,
    };
    w.agent.send(
      envelope('agent.registration_progress', {
        operationId: registration.id,
        stage: 'uploading',
        doneBytes: 10,
        totalBytes: 100,
      }),
    );
    await barrier(w.agent);
    expect(await remaster(w, operation.id)).toMatchObject({
      phase: 'uploading',
      progress: { doneBytes: 10, totalBytes: 100 },
    });
    w.agent.send(envelope('agent.registration_result', resultFor(registration as never)));
    const ack = await w.agent.next('server.registration_ack');
    expect(ack.payload).toMatchObject({
      outcome: 'committed',
      versionId: registration.versionId,
      removeLocal: false,
    });

    const history = await tree(w);
    expect(history.versions.map((v) => v.id)).toEqual([registration.versionId]);
    expect(history.versions[0]).toMatchObject({ kind: 'master', parentVersionId: null });
    // The exported copy is now a copy of the new master.
    expect(await localSource(w)).toBe(registration.versionId);
    let current = await remaster(w, operation.id);
    expect(current).toMatchObject({
      state: 'cleaning',
      newMasterVersionId: registration.versionId,
      cleanup: { total: 5, complete: false },
    });

    const named = await answerDeletions(w, 5);
    expect(named.map((item) => item.versionId)).toContain(m0);
    expect(named.map((item) => item.versionId)).not.toContain(registration.versionId);
    current = await waitFor(async () => {
      const next = await remaster(w, operation.id);
      return next.state === 'completed' ? next : null;
    });
    expect(current.cleanup).toMatchObject({ total: 5, deleted: 5, complete: true });

    // The catalog entry, its screenshots and its metadata are the same.
    const [vms] = await w.context.pool.execute<RowDataPacket[]>(
      "SELECT display_name, description, visibility FROM virtual_machines WHERE vm_name = 'Win98'",
    );
    expect(vms[0]).toMatchObject({
      display_name: 'Windows 98',
      description: 'Kept',
      visibility: 'public',
    });
    const [kept] = await w.context.pool.execute<RowDataPacket[]>(
      'SELECT is_main FROM vm_media WHERE id = ?',
      [media.id],
    );
    expect(Boolean(kept[0]?.is_main)).toBe(true);

    // Future snapshots descend from the new master.
    w.agent.send(
      envelope('agent.registration_cleanup', {
        operationId: registration.id,
        versionId: registration.versionId,
        localCopy: 'preserved',
        code: null,
        message: null,
      }),
    );
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
    const next = await snapshot(w, { parentVersionId: registration.versionId });
    await complete(w, next);
    expect((await tree(w)).versions.map((v) => v.parentVersionId)).toEqual([
      null,
      registration.versionId,
    ]);
    // And no command ever asked the agent to remove its local copy.
    await nothing(w.agent, 'server.local_copy_remove');
  });

  for (const [what, code, stage] of [
    ['an export failure', 'source_in_use', 'archiving'],
    ['an upload failure', 'upload_interrupted', 'uploading'],
    ['a SHA-256 mismatch', 'hash_mismatch', 'verifying'],
  ] as const) {
    it(`keeps every version after ${what}, and fails with its reason`, async () => {
      const w = await remasterWorld();
      const s1 = await insertSnapshot(w, w.masterId, 1);
      const before = await tree(w);
      const operation = await remasterLocally(w);
      const request = await w.agent.next('server.registration_request');
      w.agent.send(
        envelope('agent.registration_progress', {
          operationId: request.payload.operationId,
          stage,
          doneBytes: 1,
          totalBytes: 2,
        }),
      );
      w.agent.send(
        envelope('agent.registration_error', {
          operationId: request.payload.operationId,
          code,
          message: `Simulated ${what}`,
        }),
      );
      await barrier(w.agent);
      const failed = await remaster(w, operation.id);
      expect(failed).toMatchObject({
        state: 'failed',
        phase: 'failed',
        error: { code },
        newMasterVersionId: null,
        cleanup: { total: 0 },
      });
      const after = await tree(w);
      expect(after.versions.map((v) => v.id)).toEqual(before.versions.map((v) => v.id));
      expect(after.rootVersionId).toBe(w.masterId);
      expect(await tombstones(w)).toEqual([]);
      expect(await localSource(w)).toBe(w.masterId);
      await nothing(w.agent, 'server.archive_delete');
      // The VM is free again: a new remaster can start.
      expect((await localPreview(w)).refusal).toBeNull();
      void s1;
    });
  }

  it('survives a failed database commit: nothing changes until a repeated report commits', async () => {
    const w = await remasterWorld();
    const operation = await remasterLocally(w);
    const request = await w.agent.next('server.registration_request');
    const registration = {
      id: request.payload.operationId,
      versionId: request.payload.versionId,
      archiveKey: request.payload.archiveKey,
    };
    const { pool } = w.context;
    await pool.query(
      `CREATE TRIGGER trg_test_fail_master BEFORE INSERT ON vm_versions FOR EACH ROW
         SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'simulated commit failure'`,
    );
    w.agent.send(envelope('agent.registration_result', resultFor(registration as never)));
    await barrier(w.agent);
    await nothing(w.agent, 'server.registration_ack');
    expect(await remaster(w, operation.id)).toMatchObject({
      state: 'exporting',
      phase: 'committing',
    });
    expect((await tree(w)).rootVersionId).toBe(w.masterId);
    expect(await tombstones(w)).toEqual([]);

    await pool.query('DROP TRIGGER trg_test_fail_master');
    // The agent repeats its report until it is answered.
    w.agent.send(envelope('agent.registration_result', resultFor(registration as never)));
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('committed');
    expect((await tree(w)).rootVersionId).toBe(registration.versionId);
    expect((await remaster(w, operation.id)).state).toBe('cleaning');
  });

  it('sends a queued export again after the agent reconnects', async () => {
    const w = await remasterWorld();
    const operation = await remasterLocally(w);
    const first = await w.agent.next('server.registration_request');
    w.agent.close();
    const agent = await TestAgent.connect(wsUrl(w.context.app), w.paired.credential);
    await agent.hello();
    w.agent = agent;
    await resync(w, CLEANUP);
    const again = await w.agent.next('server.registration_request');
    expect(again.payload.operationId).toBe(first.payload.operationId);
    expect(again.payload.versionId).toBe(first.payload.versionId);
    expect((await remaster(w, operation.id)).state).toBe('exporting');
  });

  it('refuses an offline agent, a running VM, a missing or busy copy, and a mistyped name', async () => {
    const w = await remasterWorld();
    const revision = (await localPreview(w)).revision;

    expect(
      await errorCode(
        await localRequest(w, { expectedRevision: revision, confirmVmName: 'win98' }),
      ),
    ).toBe('confirmation_mismatch');

    const session = randomUUID();
    await w.context.pool.execute(
      `INSERT INTO vm_sessions
         (id, agent_id, request_id, emulator_type, vm_name, mode, execution_state, source_version_id)
       VALUES (?, ?, ?, 'qemu', 'Win98', 'local', 'unknown', ?)`,
      [session, w.paired.agentId, randomUUID(), w.masterId],
    );
    expect((await localPreview(w)).refusal?.code).toBe('vm_running');
    expect(await errorCode(await localRequest(w, { expectedRevision: revision }))).toBe(
      'vm_running',
    );
    await w.context.pool.execute(
      "UPDATE vm_sessions SET execution_state = 'stopped', ended_at = UTC_TIMESTAMP(3) WHERE id = ?",
      [session],
    );

    await w.context.pool.execute(
      "UPDATE agent_vm_state SET execution_state = 'unknown' WHERE agent_id = ?",
      [w.paired.agentId],
    );
    expect((await localPreview(w)).refusal?.code).toBe('source_not_exportable');
    await w.context.pool.execute(
      "UPDATE agent_vm_state SET execution_state = 'absent' WHERE agent_id = ?",
      [w.paired.agentId],
    );
    expect((await localPreview(w)).refusal?.code).toBe('local_source_missing');
    await w.context.pool.execute(
      "UPDATE agent_vm_state SET execution_state = 'idle' WHERE agent_id = ?",
      [w.paired.agentId],
    );

    w.agent.close();
    await waitFor(async () => (await localPreview(w)).refusal?.code === 'agent_offline');
    expect(await errorCode(await localRequest(w, { expectedRevision: revision }))).toBe(
      'agent_offline',
    );
    expect((await tree(w)).rootVersionId).toBe(w.masterId);
  });

  it('allows one export at a time, and blocks new uses of the old versions while it runs', async () => {
    const w = await remasterWorld();
    const s1 = await insertSnapshot(w, w.masterId, 1);
    const revision = (await localPreview(w)).revision;
    await remasterLocally(w);
    await w.agent.next('server.registration_request');

    // A second remaster of either kind.
    expect(await errorCode(await localRequest(w, { expectedRevision: revision }))).toBe(
      'remaster_in_progress',
    );
    expect(
      await errorCode(
        await promotionRequest(w, s1, {
          expectedRevision: revision,
          acknowledgeLineageConflicts: true,
        }),
      ),
    ).toBe('remaster_in_progress');
    // A restore of a version the commit will remove.
    await w.context.pool.execute(
      "UPDATE agent_vm_state SET execution_state = 'absent' WHERE agent_id = ?",
      [w.paired.agentId],
    );
    const restore = await w.admin.request({
      method: 'POST',
      url: '/admin/restores',
      payload: { agentId: w.paired.agentId, emulatorType: 'qemu', vmName: 'Win98', versionId: s1 },
    });
    expect(restore.statusCode).toBe(409);
    expect(await errorCode(restore)).toBe('remaster_in_progress');
  });

  it('refuses a history that changed since it was shown', async () => {
    const w = await remasterWorld();
    const preview = await localPreview(w);
    await insertSnapshot(w, w.masterId, 1);
    const response = await localRequest(w, { expectedRevision: preview.revision });
    expect(response.statusCode).toBe(409);
    expect(await errorCode(response)).toBe('version_history_stale');
  });

  it('keeps another agent’s copy as it is, and reports it', async () => {
    const w = await remasterWorld();
    const other = randomUUID();
    await w.context.pool.execute(
      "INSERT INTO agents (id, name, paired_at) VALUES (?, 'Laptop', UTC_TIMESTAMP(3))",
      [other],
    );
    await w.context.pool.execute(
      `INSERT INTO agent_vm_state (agent_id, emulator_type, vm_name, local_source_version_id,
         execution_state, content_status)
       VALUES (?, 'qemu', 'Win98', ?, 'idle', 'unverified')`,
      [other, w.masterId],
    );
    const preview = await localPreview(w);
    expect(preview.lineageConflicts.map((c) => c.agentId)).toEqual([other]);
    expect(await errorCode(await localRequest(w, { expectedRevision: preview.revision }))).toBe(
      'source_lineage_conflict',
    );
    await remasterLocally(w, { acknowledgeLineageConflicts: true });
    const request = await w.agent.next('server.registration_request');
    w.agent.send(
      envelope(
        'agent.registration_result',
        resultFor({
          id: request.payload.operationId,
          versionId: request.payload.versionId,
          archiveKey: request.payload.archiveKey,
        } as never),
      ),
    );
    await w.agent.next('server.registration_ack');
    const [rows] = await w.context.pool.execute<RowDataPacket[]>(
      'SELECT local_source_version_id FROM agent_vm_state WHERE agent_id = ?',
      [other],
    );
    expect(rows[0]?.local_source_version_id).toBe(w.masterId);
  });
});

describe('snapshot titles and descriptions', () => {
  it('are recorded with a new snapshot, and absent without them', async () => {
    const w = await remasterWorld();
    const titled = await snapshot(w, {
      title: '  Patched to SE  ',
      description: 'Installed the update.\r\n\r\nThen DirectX 7.  ',
    });
    await complete(w, titled);
    let node = (await tree(w)).versions.find((v) => v.id === titled.versionId);
    expect(node).toMatchObject({
      title: 'Patched to SE',
      description: 'Installed the update.\n\nThen DirectX 7.',
    });

    const plain = await snapshot(w, { parentVersionId: titled.versionId });
    await complete(w, plain);
    node = (await tree(w)).versions.find((v) => v.id === plain.versionId);
    expect(node).toMatchObject({ title: null, description: null });
  });

  it('can be edited without touching the archive, the lineage or the creation time', async () => {
    const w = await remasterWorld();
    const historical = await insertSnapshot(w, w.masterId, 1);
    const before = await versionRow(w, historical);
    const edit = (title: unknown, description: unknown, id = historical) =>
      w.admin.request({
        method: 'PATCH',
        url: `/admin/vms/qemu/Win98/versions/${id}`,
        payload: { title, description },
      });

    let response = await edit('<b>Clean</b>', '<script>alert(1)</script>\nSecond line');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      versionId: historical,
      title: '<b>Clean</b>',
      description: '<script>alert(1)</script>\nSecond line',
    });
    const after = await versionRow(w, historical);
    for (const column of [
      'archive_key',
      'archive_sha256',
      'archive_size_bytes',
      'parent_version_id',
      'created_at',
      'kind',
    ]) {
      expect(after?.[column]).toEqual(before?.[column]);
    }
    await nothing(w.agent, 'server.registration_request');

    // Empty values clear.
    response = await edit('   ', '');
    expect(response.json()).toMatchObject({ title: null, description: null });

    // Limits, and what is not text.
    expect((await edit('t'.repeat(120), 'd'.repeat(2000))).statusCode).toBe(200);
    expect((await edit('t'.repeat(121), null)).statusCode).toBe(400);
    expect((await edit(null, 'd'.repeat(2001))).statusCode).toBe(400);
    expect((await edit('Line\nbreak', null)).statusCode).toBe(400);
    expect((await edit(42, null)).statusCode).toBe(400);

    // Another VM's version is not found; a deleted one cannot be edited.
    expect((await edit('x', null, randomUUID())).statusCode).toBe(404);
    await promote(w, historical, { acknowledgeLineageConflicts: true });
    response = await edit('Master now', null, w.masterId);
    expect(response.statusCode).toBe(409);
    expect(await errorCode(response)).toBe('version_deleted');
    // The promoted master keeps its title and can still be edited.
    expect((await edit('Master now', null)).statusCode).toBe(200);
    expect((await tree(w)).versions[0]).toMatchObject({ kind: 'master', title: 'Master now' });
  });

  it('are refused at creation when they are not plain text within limits', async () => {
    const w = await remasterWorld();
    const response = await snapshotRequest(w, { title: 't'.repeat(121) });
    expect(response.statusCode).toBe(400);
    void MANIFEST_SHA;
  });
});
