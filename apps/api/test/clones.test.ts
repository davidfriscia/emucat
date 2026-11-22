/**
 * Cloning a version into a new, independent VM (decision 0052): the request, the agent's command, the commit, and
 * what the clone does and does not share with its source.
 */
import { randomUUID } from 'node:crypto';
import {
  adminVmDetailSchema,
  archiveObjectKey,
  cloneOptionsResponseSchema,
  registrationOperationSchema,
  type RegistrationOperation,
} from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import { afterEach, describe, expect, it } from 'vitest';
import { envelope, waitFor } from './agent-helpers.js';
import { insertMedia, insertVm, TestClient } from './browser-app.js';
import {
  barrier,
  closeWorlds,
  errorCode,
  resync,
  SHA,
  MANIFEST_SHA,
  world,
  type World,
} from './version-world.js';

afterEach(closeWorlds);

function cloneRequest(
  w: World,
  versionId: string,
  vmName: string,
  overrides: object = {},
  source = 'Win98',
  emulatorType = 'qemu',
) {
  return w.admin.request({
    method: 'POST',
    url: `/admin/vms/${emulatorType}/${encodeURIComponent(source)}/versions/${versionId}/clone`,
    payload: { agentId: w.paired.agentId, vmName, requestId: randomUUID(), ...overrides },
  });
}

async function clone(
  w: World,
  versionId: string,
  vmName: string,
  overrides: object = {},
): Promise<RegistrationOperation> {
  const response = await cloneRequest(w, versionId, vmName, overrides);
  expect(response.statusCode, response.body).toBe(202);
  return registrationOperationSchema.parse(response.json());
}

const NEW_SHA = 'c'.repeat(64);
const NEW_MANIFEST = 'd'.repeat(64);

function zipResult(operation: RegistrationOperation) {
  return {
    operationId: operation.id,
    versionId: operation.versionId,
    archiveKey: operation.archiveKey,
    archiveSizeBytes: 4096,
    archiveSha256: NEW_SHA,
    manifestVersion: 1,
    manifestSha256: NEW_MANIFEST,
    fileCount: 4,
    totalUncompressedBytes: 8192,
  };
}

/** The agent's side: the command, progress, the result, the committed answer, the cleanup report, closed. */
async function completeClone(w: World, operation: RegistrationOperation) {
  const request = await w.agent.next('server.clone_request');
  expect(request.payload.operationId).toBe(operation.id);
  w.agent.send(
    envelope('agent.registration_progress', {
      operationId: operation.id,
      stage: 'archiving',
      doneBytes: 10,
      totalBytes: 2048,
    }),
  );
  w.agent.send(envelope('agent.registration_result', zipResult(operation)));
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
  return request;
}

async function rows(w: World, sql: string, values: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await w.context.pool.execute<RowDataPacket[]>(sql, values as string[]);
  return result;
}

async function insertSnapshot(w: World, parentId: string, title: string | null = null) {
  const id = randomUUID();
  await w.context.pool.execute(
    `INSERT INTO vm_versions
       (id, emulator_type, vm_name, kind, parent_version_id, snapshot_name, title, repository_id,
        archive_key, archive_sha256, archive_size_bytes, created_by_agent_id)
     VALUES (?, 'qemu', 'Win98', 'snapshot', ?, 'Win98_202601311530', ?, ?, ?, ?, 3072, ?)`,
    [
      id,
      parentId,
      title,
      w.repository.id,
      archiveObjectKey({ emulatorType: 'qemu', vmName: 'Win98' }, id),
      'e'.repeat(64),
      w.paired.agentId,
    ],
  );
  return id;
}

async function operationRow(w: World, operationId: string): Promise<RegistrationOperation> {
  const response = await w.admin.get(`/admin/registrations/${operationId}`);
  expect(response.statusCode, response.body).toBe(200);
  return registrationOperationSchema.parse(response.json());
}

describe('cloning a version', () => {
  it('clones the master into a new, private, independent VM with its own archive', async () => {
    const w = await world();
    // What the source has that a clone must never inherit.
    const tagId = randomUUID();
    await w.context.pool.execute(
      "INSERT INTO tags (id, name, normalized_name) VALUES (?, 'retro', 'retro')",
      [tagId],
    );
    await w.context.pool.execute(
      "INSERT INTO vm_tags (emulator_type, vm_name, tag_id) VALUES ('qemu', 'Win98', ?)",
      [tagId],
    );
    await w.context.pool.execute(
      "UPDATE virtual_machines SET display_name = 'Windows 98', description = 'Source notes' WHERE vm_name = 'Win98'",
    );
    await insertMedia(w.context, { vmName: 'Win98' }, { isMain: true });
    const notes = await w.admin.get('/admin/vms/qemu/Win98/notes');
    const saved = await w.admin.request({
      method: 'PUT',
      url: '/admin/vms/qemu/Win98/notes',
      headers: { 'if-match': notes.json<{ etag: string }>().etag },
      payload: { markdown: '# Source only' },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const operation = await clone(w, w.masterId, 'Win98 - Office');
    expect(operation).toMatchObject({
      mode: 'clone',
      state: 'queued',
      emulatorType: 'qemu',
      vmName: 'Win98 - Office',
      cloneSource: { vmName: 'Win98', versionId: w.masterId },
    });
    expect(operation.versionId).not.toBe(w.masterId);
    expect(operation.archiveKey).toBe(
      archiveObjectKey({ emulatorType: 'qemu', vmName: 'Win98 - Office' }, operation.versionId),
    );

    const request = await completeClone(w, operation);
    expect(request.payload).toEqual({
      operationId: operation.id,
      emulatorType: 'qemu',
      repositoryId: w.repository.id,
      source: {
        vmName: 'Win98',
        versionId: w.masterId,
        archiveKey: archiveObjectKey({ emulatorType: 'qemu', vmName: 'Win98' }, w.masterId),
        archiveSizeBytes: 2048,
        archiveSha256: SHA,
        manifestSha256: null,
      },
      target: {
        vmName: 'Win98 - Office',
        versionId: operation.versionId,
        archiveKey: operation.archiveKey,
      },
    });

    const finished = await operationRow(w, operation.id);
    expect(finished.state).toBe('succeeded');
    expect(finished.localCopy).toBe('preserved');

    const detail = await w.admin.get('/admin/vms/qemu/Win98%20-%20Office');
    expect(detail.statusCode, detail.body).toBe(200);
    const vm = adminVmDetailSchema.parse(detail.json());
    expect(vm).toMatchObject({
      vmName: 'Win98 - Office',
      displayName: null,
      description: null,
      visibility: 'private',
      mainMediaId: null,
      mediaCount: 0,
      versionCount: 1,
      tags: [],
    });
    expect(vm.clonedFrom).toMatchObject({
      sourceEmulatorType: 'qemu',
      sourceVmName: 'Win98',
      sourceDisplayName: 'Windows 98',
      sourceVersionId: w.masterId,
      sourceVersionKind: 'master',
      sourceSnapshotName: null,
      clonedByDisplayName: 'The Admin',
      sourceExists: true,
    });

    // One master, at its own key, with no parent and no history from the source.
    const versions = await rows(
      w,
      "SELECT id, kind, parent_version_id, archive_key, archive_sha256 FROM vm_versions WHERE vm_name = 'Win98 - Office'",
    );
    expect(versions).toEqual([
      {
        id: operation.versionId,
        kind: 'master',
        parent_version_id: null,
        archive_key: operation.archiveKey,
        archive_sha256: NEW_SHA,
      },
    ]);
    // No agent holds it, no session, no screenshot, no notes, no tag.
    for (const table of [
      'agent_vm_state',
      'vm_sessions',
      'vm_media',
      'vm_tags',
      'vm_media_suppressions',
    ]) {
      expect(
        await rows(w, `SELECT 1 FROM ${table} WHERE vm_name = 'Win98 - Office'`),
        table,
      ).toEqual([]);
    }
    const cloneNotes = await w.admin.get('/admin/vms/qemu/Win98%20-%20Office/notes');
    expect(cloneNotes.json()).toMatchObject({ markdown: '', exists: false });

    // The source is unchanged.
    const source = adminVmDetailSchema.parse((await w.admin.get('/admin/vms/qemu/Win98')).json());
    expect(source).toMatchObject({
      displayName: 'Windows 98',
      mediaCount: 1,
      versionCount: 1,
      clonedFrom: null,
    });
    expect(source.tags.map((tag) => tag.name)).toEqual(['retro']);
    expect((await w.admin.get('/admin/vms/qemu/Win98/notes')).json()).toMatchObject({
      markdown: '# Source only',
    });

    // A restore of the clone is offered with the manifest its own registration verified.
    const options = await w.admin.get('/admin/vms/qemu/Win98%20-%20Office/restore-options');
    expect(options.statusCode, options.body).toBe(200);
    expect(options.body).toContain(NEW_MANIFEST);
  });

  it('clones a snapshot from its exact archive, and records which one', async () => {
    const w = await world();
    const snapshotId = await insertSnapshot(w, w.masterId, 'After Office Installation');
    const operation = await clone(w, snapshotId, 'Win98-Office');
    const request = await completeClone(w, operation);
    expect(request.payload.source).toEqual({
      vmName: 'Win98',
      versionId: snapshotId,
      archiveKey: archiveObjectKey({ emulatorType: 'qemu', vmName: 'Win98' }, snapshotId),
      archiveSizeBytes: 3072,
      archiveSha256: 'e'.repeat(64),
      manifestSha256: null,
    });
    const vm = adminVmDetailSchema.parse(
      (await w.admin.get('/admin/vms/qemu/Win98-Office')).json(),
    );
    expect(vm.clonedFrom).toMatchObject({
      sourceVersionId: snapshotId,
      sourceVersionKind: 'snapshot',
      sourceSnapshotName: 'Win98_202601311530',
      sourceVersionTitle: 'After Office Installation',
    });
    // The clone's master is a master: the snapshot's parent does not come along.
    const versions = await rows(
      w,
      "SELECT kind, parent_version_id FROM vm_versions WHERE vm_name = 'Win98-Office'",
    );
    expect(versions).toEqual([{ kind: 'master', parent_version_id: null }]);
  });

  it('passes on what the source registration verified, so a wrong archive is refused by the agent', async () => {
    const w = await world();
    await w.context.pool.execute(
      `INSERT INTO registration_operations
         (id, agent_id, repository_id, emulator_type, vm_name, mode, state, version_id, archive_key,
          archive_size_bytes, archive_sha256, manifest_version, manifest_sha256, committed_at, finished_at,
          local_copy)
       VALUES (?, ?, ?, 'qemu', 'Win98', 'copy', 'succeeded', ?, ?, 2048, ?, 1, ?, UTC_TIMESTAMP(3),
         UTC_TIMESTAMP(3), 'preserved')`,
      [
        randomUUID(),
        w.paired.agentId,
        w.repository.id,
        w.masterId,
        archiveObjectKey({ emulatorType: 'qemu', vmName: 'Win98' }, w.masterId),
        SHA,
        MANIFEST_SHA,
      ],
    );
    await clone(w, w.masterId, 'Copy');
    const request = await w.agent.next('server.clone_request');
    expect(request.payload.source.manifestSha256).toBe(MANIFEST_SHA);
  });

  it('validates the destination name and refuses any collision, ignoring case', async () => {
    const w = await world();
    for (const name of ['', 'a/b', '..', 'café', 'CON', 'x'.repeat(65), 'Win98_202601010000']) {
      const response = await cloneRequest(w, w.masterId, name);
      expect(response.statusCode, name).toBe(400);
    }
    const same = await cloneRequest(w, w.masterId, 'win98');
    expect(same.statusCode).toBe(409);
    expect(await errorCode(same)).toBe('vm_already_registered');
    const existing = await cloneRequest(w, w.masterId, 'OTHER');
    expect(existing.statusCode).toBe(409);
    expect(await errorCode(existing)).toBe('vm_already_registered');
    expect(existing.json<{ error: { message: string } }>().error.message).toContain('Other');
    expect(await rows(w, "SELECT 1 FROM registration_operations WHERE mode = 'clone'")).toEqual([]);
  });

  it('reserves the destination while a clone runs, and the database refuses a second creator', async () => {
    const w = await world();
    const operation = await clone(w, w.masterId, 'Copy');
    // A second agent's registration of the same name, as the unique active marker sees it, ignoring case.
    await expect(
      w.context.pool.execute(
        `INSERT INTO registration_operations
           (id, agent_id, repository_id, emulator_type, vm_name, mode, version_id, archive_key)
         VALUES (?, ?, ?, 'qemu', 'COPY', 'copy', ?, 'archives/qemu/copy/x.zip')`,
        [randomUUID(), w.paired.agentId, w.repository.id, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    // And this agent is busy with it.
    const again = await cloneRequest(w, w.masterId, 'Copy2');
    expect(again.statusCode).toBe(409);
    expect(await errorCode(again)).toBe('agent_busy');
    await completeClone(w, operation);
  });

  it('refuses a name that became taken before the commit, and asks for the published archive to go', async () => {
    const w = await world();
    const operation = await clone(w, w.masterId, 'Copy');
    await w.agent.next('server.clone_request');
    await insertVm(w.context.pool, { vmName: 'copy' });
    w.agent.send(envelope('agent.registration_result', zipResult(operation)));
    const ack = await w.agent.next('server.registration_ack');
    expect(ack.payload).toMatchObject({ outcome: 'rejected', deletePublished: true });
    const finished = await operationRow(w, operation.id);
    expect(finished).toMatchObject({ state: 'failed', error: { code: 'duplicate_registration' } });
    // The VM that was there is untouched, and nothing was added to it.
    expect(await rows(w, "SELECT 1 FROM vm_versions WHERE vm_name = 'copy'")).toEqual([]);
  });

  it('returns the same clone for a repeated request, and refuses the ID for anything else', async () => {
    const w = await world();
    const requestId = randomUUID();
    const first = await clone(w, w.masterId, 'Copy', { requestId });
    const again = await cloneRequest(w, w.masterId, 'Copy', { requestId });
    expect(again.statusCode).toBe(202);
    expect(again.json<{ id: string }>().id).toBe(first.id);
    const other = await cloneRequest(w, w.masterId, 'Elsewhere', { requestId });
    expect(other.statusCode).toBe(409);
    expect(await errorCode(other)).toBe('request_id_reused');
  });

  it('leaves nothing behind when the agent fails, and can be tried again', async () => {
    const w = await world();
    const operation = await clone(w, w.masterId, 'Copy');
    await w.agent.next('server.clone_request');
    w.agent.send(
      envelope('agent.registration_error', {
        operationId: operation.id,
        code: 'hash_mismatch',
        message: 'The downloaded archive is not the registered one',
      }),
    );
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
    expect(await operationRow(w, operation.id)).toMatchObject({ state: 'failed' });
    expect(await rows(w, "SELECT 1 FROM virtual_machines WHERE vm_name = 'Copy'")).toEqual([]);
    expect(await rows(w, 'SELECT 1 FROM vm_clone_provenance')).toEqual([]);

    const retry = await clone(w, w.masterId, 'Copy');
    expect(retry.versionId).not.toBe(operation.versionId);
    await completeClone(w, retry);
    expect(await rows(w, "SELECT 1 FROM virtual_machines WHERE vm_name = 'Copy'")).toHaveLength(1);
  });

  it('can be cancelled before it commits, which creates nothing', async () => {
    const w = await world();
    const operation = await clone(w, w.masterId, 'Copy');
    await w.agent.next('server.clone_request');
    const cancelled = await w.admin.request({
      method: 'POST',
      url: `/admin/registrations/${operation.id}/cancel`,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    await w.agent.next('server.registration_cancel');
    w.agent.send(envelope('agent.registration_result', zipResult(operation)));
    const ack = await w.agent.next('server.registration_ack');
    expect(ack.payload).toMatchObject({ outcome: 'rejected', deletePublished: true });
    expect(await rows(w, "SELECT 1 FROM virtual_machines WHERE vm_name = 'Copy'")).toEqual([]);
  });

  it('protects its source version from deletion while it runs', async () => {
    const w = await world({ deleteArchives: true });
    const snapshotId = await insertSnapshot(w, w.masterId);
    const operation = await clone(w, snapshotId, 'Copy');
    const refused = await w.admin.request({
      method: 'POST',
      url: `/admin/vms/qemu/Win98/versions/${snapshotId}/deletion`,
      payload: { requestId: randomUUID(), versionId: snapshotId },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(await errorCode(refused)).toBe('snapshot_in_use');
    expect(await rows(w, 'SELECT 1 FROM vm_version_deletions')).toEqual([]);
    await completeClone(w, operation);
  });

  it('stays usable after its source VM and every version of it are gone, and the provenance stays', async () => {
    const w = await world();
    const operation = await clone(w, w.masterId, 'Copy');
    await completeClone(w, operation);

    // Nothing in the schema ties the clone to its source.
    const foreign = await rows(
      w,
      `SELECT TABLE_NAME, REFERENCED_TABLE_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'vm_clone_provenance'`,
    );
    expect(foreign.map((row) => row.REFERENCED_TABLE_NAME).sort()).toEqual([
      'users',
      'virtual_machines',
    ]);

    // The source goes, with everything of it: there is no VM deletion in the product yet, so the rows are deleted
    // here exactly as a deletion would have to.
    await w.context.pool.execute("DELETE FROM agent_vm_state WHERE vm_name = 'Win98'");
    await w.context.pool.execute("DELETE FROM vm_versions WHERE vm_name = 'Win98'");
    await w.context.pool.execute("DELETE FROM virtual_machines WHERE vm_name = 'Win98'");

    const vm = adminVmDetailSchema.parse((await w.admin.get('/admin/vms/qemu/Copy')).json());
    expect(vm.versionCount).toBe(1);
    expect(vm.clonedFrom).toMatchObject({ sourceVmName: 'Win98', sourceExists: false });
    const versions = await w.admin.get('/admin/vms/qemu/Copy/versions');
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.body).toContain(operation.versionId);
    expect(versions.body).not.toContain(w.masterId);
    // It can itself be cloned, snapshotted from or restored as any VM can: its archive is its own.
    const options = await w.admin.get(
      `/admin/vms/qemu/Copy/versions/${operation.versionId}/clone-options`,
    );
    expect(cloneOptionsResponseSchema.parse(options.json()).refusal).toBeNull();
  });

  it('can be deleted without touching its source', async () => {
    const w = await world();
    const operation = await clone(w, w.masterId, 'Copy');
    await completeClone(w, operation);
    await w.context.pool.execute("DELETE FROM vm_versions WHERE vm_name = 'Copy'");
    await w.context.pool.execute("DELETE FROM virtual_machines WHERE vm_name = 'Copy'");
    // Its provenance goes with it, and nothing of the source does.
    expect(await rows(w, 'SELECT 1 FROM vm_clone_provenance')).toEqual([]);
    expect(await rows(w, "SELECT id FROM vm_versions WHERE vm_name = 'Win98'")).toEqual([
      { id: w.masterId },
    ]);
    expect(await rows(w, "SELECT 1 FROM agent_vm_state WHERE vm_name = 'Win98'")).toHaveLength(1);
  });

  it('lists the agents that can clone, and why the others cannot', async () => {
    const w = await world({ clones: false });
    const options = await w.admin.get(`/admin/vms/qemu/Win98/versions/${w.masterId}/clone-options`);
    expect(options.statusCode, options.body).toBe(200);
    const parsed = cloneOptionsResponseSchema.parse(options.json());
    expect(parsed.source).toMatchObject({ vmName: 'Win98', versionId: w.masterId, kind: 'master' });
    expect(parsed.agents).toEqual([
      {
        agentId: w.paired.agentId,
        agentName: expect.any(String),
        online: true,
        eligible: false,
        reason: 'agent_cannot_clone',
      },
    ]);
    const refused = await cloneRequest(w, w.masterId, 'Copy');
    expect(refused.statusCode).toBe(409);
    expect(await errorCode(refused)).toBe('agent_cannot_clone');

    await resync(w, { clones: true });
    const again = cloneOptionsResponseSchema.parse(
      (await w.admin.get(`/admin/vms/qemu/Win98/versions/${w.masterId}/clone-options`)).json(),
    );
    expect(again.agents[0]).toMatchObject({ eligible: true, reason: null });
    expect(
      (await w.admin.get(`/admin/vms/qemu/Other/versions/${w.masterId}/clone-options`)).statusCode,
    ).toBe(404);
  });

  it('fails a queued clone whose agent comes back unable to clone', async () => {
    const w = await world();
    w.agent.close();
    await waitFor(async () => {
      const options = cloneOptionsResponseSchema.parse(
        (await w.admin.get(`/admin/vms/qemu/Win98/versions/${w.masterId}/clone-options`)).json(),
      );
      return options.agents[0]?.online === false;
    });
    // Queued while offline is refused up front, so the operation is created as if the agent dropped right after.
    await w.context.pool.execute(
      `INSERT INTO registration_operations
         (id, agent_id, repository_id, request_id, emulator_type, vm_name, mode, version_id, archive_key,
          clone_source_vm_name, clone_source_version_id, clone_source_archive_key,
          clone_source_archive_sha256, clone_source_archive_size_bytes)
       VALUES (?, ?, ?, ?, 'qemu', 'Copy', 'clone', ?, 'archives/qemu/copy/v.zip', 'Win98', ?, 'k', ?, 2048)`,
      [
        randomUUID(),
        w.paired.agentId,
        w.repository.id,
        randomUUID(),
        randomUUID(),
        w.masterId,
        SHA,
      ],
    );
    const { TestAgent, wsUrl } = await import('./agent-helpers.js');
    const agent = await TestAgent.connect(wsUrl(w.context.app), w.paired.credential);
    await agent.hello();
    w.agent = agent;
    await resync(w, { clones: false });
    await barrier(agent);
    const [row] = await rows(
      w,
      "SELECT state, error_code FROM registration_operations WHERE mode = 'clone'",
    );
    expect(row).toEqual({ state: 'failed', error_code: 'clone_unavailable' });
  });

  it('clones a VirtualBox OVA byte for byte, and links no machine', async () => {
    const w = await world();
    await insertVm(w.context.pool, { emulatorType: 'virtualbox', vmName: 'XP-Box' });
    const ovaId = randomUUID();
    await w.context.pool.execute(
      `INSERT INTO vm_versions
         (id, emulator_type, vm_name, kind, repository_id, archive_key, archive_sha256, archive_size_bytes)
       VALUES (?, 'virtualbox', 'XP-Box', 'master', ?, ?, ?, 9000)`,
      [
        ovaId,
        w.repository.id,
        archiveObjectKey({ emulatorType: 'virtualbox', vmName: 'XP-Box' }, ovaId),
        SHA,
      ],
    );
    const response = await cloneRequest(w, ovaId, 'XP-Box-Copy', {}, 'XP-Box', 'virtualbox');
    expect(response.statusCode, response.body).toBe(202);
    const operation = registrationOperationSchema.parse(response.json());
    expect(operation.archiveKey).toMatch(/^archives\/virtualbox\/xp-box-copy\/.+\.ova$/);
    const request = await w.agent.next('server.clone_request');
    expect(request.payload).toMatchObject({
      emulatorType: 'virtualbox',
      source: {
        archiveKey: archiveObjectKey({ emulatorType: 'virtualbox', vmName: 'XP-Box' }, ovaId),
      },
    });
    // A ZIP result for an OVA is not what was asked for.
    w.agent.send(
      envelope('agent.virtualbox_registration_result', {
        operationId: operation.id,
        versionId: operation.versionId,
        archiveKey: operation.archiveKey,
        archiveSizeBytes: 9000,
        archiveSha256: SHA,
      }),
    );
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('committed');
    const vm = adminVmDetailSchema.parse(
      (await w.admin.get('/admin/vms/virtualbox/XP-Box-Copy')).json(),
    );
    expect(vm.clonedFrom).toMatchObject({
      sourceVmName: 'XP-Box',
      sourceEmulatorType: 'virtualbox',
    });
    expect(await rows(w, "SELECT 1 FROM virtualbox_sources WHERE vm_name = 'XP-Box-Copy'")).toEqual(
      [],
    );
    expect(await rows(w, "SELECT 1 FROM agent_vm_state WHERE vm_name = 'XP-Box-Copy'")).toEqual([]);
  });

  it('is for administrators only', async () => {
    const w = await world();
    const anonymous = new TestClient(w.context.app);
    const options = await anonymous.get(
      `/admin/vms/qemu/Win98/versions/${w.masterId}/clone-options`,
    );
    expect(options.statusCode).toBe(401);
    const created = await anonymous.request({
      method: 'POST',
      url: `/admin/vms/qemu/Win98/versions/${w.masterId}/clone`,
      payload: { agentId: w.paired.agentId, vmName: 'Copy', requestId: randomUUID() },
    });
    expect([401, 403]).toContain(created.statusCode);
    expect(await rows(w, "SELECT 1 FROM registration_operations WHERE mode = 'clone'")).toEqual([]);
  });
});
