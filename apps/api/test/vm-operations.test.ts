/**
 * The operations that concern one VM's versions (decision 0060): what the Version History and General pages poll.
 * Every entry is the registration operation the server already persists; these tests prove which rows a VM sees, that
 * their state is the authoritative recorded one through progress, an agent's disconnection and the end, and that
 * nothing about another VM leaks into the listing.
 */
import { randomUUID } from 'node:crypto';
import {
  VM_OPERATION_RETENTION_HOURS,
  archiveObjectKey,
  vmOperationListResponseSchema,
  vmOperationPhase,
  type VmOperationListResponse,
} from '@emucat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { envelope, waitFor } from './agent-helpers.js';
import { ADMIN_PASSWORD, insertVm, TestClient } from './browser-app.js';
import { closeWorlds, complete, snapshot, SHA, world, type World } from './version-world.js';

afterEach(closeWorlds);

async function listed(
  w: World,
  vmName = 'Win98',
  client = w.admin,
): Promise<VmOperationListResponse> {
  const response = await client.get(`/admin/vms/qemu/${vmName}/operations`);
  expect(response.statusCode, response.body).toBe(200);
  return vmOperationListResponseSchema.parse(response.json());
}

/** A clone of `versionId` of Win98 into `vmName`, as the server records one it performs itself (decision 0055). */
async function insertClone(
  w: World,
  versionId: string,
  vmName: string,
  state: string,
  finished: string | null = null,
): Promise<string> {
  const id = randomUUID();
  const newVersion = randomUUID();
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(state);
  await w.context.pool.execute(
    `INSERT INTO registration_operations
       (id, agent_id, repository_id, request_id, emulator_type, vm_name, mode, state, version_id, archive_key,
        clone_source_vm_name, clone_source_version_id, clone_source_archive_key, clone_source_archive_sha256,
        clone_source_archive_size_bytes, progress_done_bytes, progress_total_bytes,
        error_code, error_message, archive_sha256, archive_size_bytes, committed_at, finished_at)
     VALUES (?, NULL, ?, ?, 'qemu', ?, 'clone', ?, ?, ?, 'Win98', ?, ?, ?, 2048, ?, ?, ?, ?, ?, ?,
       ${state === 'succeeded' ? 'UTC_TIMESTAMP(3)' : 'NULL'},
       ${finished ?? (terminal ? 'UTC_TIMESTAMP(3)' : 'NULL')})`,
    [
      id,
      w.repository.id,
      randomUUID(),
      vmName,
      state,
      newVersion,
      archiveObjectKey({ emulatorType: 'qemu', vmName }, newVersion),
      versionId,
      archiveObjectKey({ emulatorType: 'qemu', vmName: 'Win98' }, versionId),
      SHA,
      state === 'uploading' ? 512 : null,
      state === 'uploading' ? 2048 : null,
      state === 'failed' ? 'repository_unreachable' : null,
      state === 'failed' ? 'The repository did not answer.' : null,
      state === 'succeeded' ? SHA : null,
      state === 'succeeded' ? 2048 : null,
    ],
  );
  return id;
}

describe('the operations of a VM', () => {
  it('follow a snapshot from its request to its publication, with the recorded phases and progress', async () => {
    const w = await world();
    expect((await listed(w)).operations).toEqual([]);

    const operation = await snapshot(w);
    const queued = await listed(w);
    expect(queued.retentionHours).toBe(VM_OPERATION_RETENTION_HOURS);
    expect(queued.operations).toHaveLength(1);
    const [entry] = queued.operations;
    expect(entry?.relation).toBe('this_vm');
    expect(entry?.transport).toBeNull();
    expect(entry?.operation).toMatchObject({
      id: operation.id,
      mode: 'snapshot',
      parentVersionId: w.masterId,
      agentOnline: true,
    });

    const request = await w.agent.next('server.registration_request');
    expect(request.payload.operationId).toBe(operation.id);
    w.agent.send(
      envelope('agent.registration_progress', {
        operationId: operation.id,
        stage: 'uploading',
        doneBytes: 100,
        totalBytes: 400,
      }),
    );
    const uploading = await waitFor(async () => {
      const found = (await listed(w)).operations[0]?.operation;
      return found?.state === 'uploading' ? found : null;
    }, 'the upload to be recorded');
    expect(uploading.progress).toEqual({ doneBytes: 100, totalBytes: 400 });
    expect(vmOperationPhase(uploading)).toBe('transferring');

    // A report the server does not believe (verifying is past uploading, archiving is before it) moves nothing back.
    w.agent.send(
      envelope('agent.registration_progress', {
        operationId: operation.id,
        stage: 'archiving',
        doneBytes: 1,
        totalBytes: 2,
      }),
    );
    w.agent.send(envelope('agent.heartbeat', {}));
    await w.agent.next('server.heartbeat_ack');
    expect((await listed(w)).operations[0]?.operation.state).toBe('uploading');

    // The rest of the agent's side, from the result onward.
    w.agent.send(
      envelope('agent.registration_result', {
        operationId: operation.id,
        versionId: operation.versionId,
        archiveKey: operation.archiveKey,
        archiveSizeBytes: 4096,
        archiveSha256: 'c'.repeat(64),
        manifestVersion: 1,
        manifestSha256: 'd'.repeat(64),
        fileCount: 4,
        totalUncompressedBytes: 8192,
      }),
    );
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('committed');
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

    const ended = (await listed(w)).operations[0]?.operation;
    expect(ended?.state).toBe('succeeded');
    expect(ended?.finishedAt).not.toBeNull();
    expect(ended?.archive?.sha256).toBe('c'.repeat(64));
    // Another VM sees none of it.
    expect((await listed(w, 'Other')).operations).toEqual([]);
  });

  it('keep an operation whose agent went offline active, and say the agent is offline', async () => {
    const w = await world();
    const operation = await snapshot(w);
    await w.agent.next('server.registration_request');
    w.agent.close();
    const waiting = await waitFor(async () => {
      const found = (await listed(w)).operations[0]?.operation;
      return found && !found.agentOnline ? found : null;
    }, 'the agent to be offline');
    expect(waiting.id).toBe(operation.id);
    expect(waiting.state).toBe('queued');
    expect(vmOperationPhase(waiting)).toBe('waiting_agent');
  });

  it('list clones made from this VM’s versions on the source, and never on another VM', async () => {
    const w = await world();
    const running = await insertClone(w, w.masterId, 'Win98_Copy', 'uploading');
    const failed = await insertClone(w, w.masterId, 'Win98_Broken', 'failed');
    const { operations } = await listed(w);
    expect(operations.map((entry) => entry.operation.id)).toEqual([running, failed]);
    const [active, ended] = operations;
    expect(active).toMatchObject({
      relation: 'clone_source',
      transport: 'server',
      operation: {
        vmName: 'Win98_Copy',
        performedBy: 'server',
        cloneSource: { vmName: 'Win98', versionId: w.masterId },
        progress: { doneBytes: 512, totalBytes: 2048 },
      },
    });
    expect(ended?.operation.error).toEqual({
      code: 'repository_unreachable',
      message: 'The repository did not answer.',
    });
    expect(ended?.operation.recovery).not.toBeNull();
    expect((await listed(w, 'Other')).operations).toEqual([]);
  });

  it('put active operations first, and keep ended ones only for the retention period', async () => {
    const w = await world();
    const old = await insertClone(
      w,
      w.masterId,
      'Win98_Old',
      'failed',
      `UTC_TIMESTAMP(3) - INTERVAL ${VM_OPERATION_RETENTION_HOURS + 1} HOUR`,
    );
    const recent = await insertClone(w, w.masterId, 'Win98_Recent', 'succeeded');
    const operation = await snapshot(w);
    const ids = (await listed(w)).operations.map((entry) => entry.operation.id);
    expect(ids).toEqual([operation.id, recent]);
    expect(ids).not.toContain(old);
    // The record itself is kept: the history still has it.
    const history = await w.admin.get(`/admin/registrations/${old}`);
    expect(history.statusCode).toBe(200);
  });

  it('do not list how this VM was made, nor another VM’s snapshots', async () => {
    const w = await world();
    await insertVm(w.context.pool, { vmName: 'Win98_Copy' });
    // A clone into Win98_Copy is that VM's history, not an operation on it.
    await insertClone(w, w.masterId, 'Win98_Copy', 'succeeded');
    expect((await listed(w, 'Win98_Copy')).operations).toEqual([]);
    expect((await listed(w, 'Other')).operations).toEqual([]);
  });

  it('are for administrators only, and only for a VM that exists', async () => {
    const w = await world();
    const url = '/admin/vms/qemu/Win98/operations';
    expect((await new TestClient(w.context.app).get(url)).statusCode).toBe(401);
    await w.context.pool.execute(
      `INSERT INTO users (id, username, display_name, password_hash, role) VALUES (UUID(), 'viewer', 'V', ?, 'user')`,
      [await w.context.dependencies.passwords.hash(ADMIN_PASSWORD)],
    );
    const user = new TestClient(w.context.app);
    expect((await user.login('viewer', ADMIN_PASSWORD)).statusCode).toBe(200);
    expect((await user.get(url)).statusCode).toBe(403);
    expect((await w.admin.get('/admin/vms/qemu/Nope/operations')).statusCode).toBe(404);
    // Not in any public route.
    expect(
      (await new TestClient(w.context.app).get('/public/vms/qemu/Win98/operations')).statusCode,
    ).toBe(404);
  });

  it('end a snapshot completed through the usual helper as succeeded', async () => {
    const w = await world();
    const operation = await snapshot(w);
    await complete(w, operation);
    const found = (await listed(w)).operations.find((entry) => entry.operation.id === operation.id);
    expect(found?.operation.state).toBe('succeeded');
  });
});
