/**
 * Listing registration operations as a durable, paginated history (decision 0043): the views, the
 * filters, keyset pagination over more than a thousand rows, acknowledgement of partial successes, and
 * the indexes the queries rely on. Rows are inserted directly, as the history of a long-used server would
 * be; how they get there is covered by `registration.test.ts` and `snapshots.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import {
  registrationListResponseSchema,
  registrationOperationSchema,
  type RegistrationListResponse,
  type RegistrationOperation,
} from '@emucat/contracts';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GENEROUS_RATE_LIMITS,
  TestAgent,
  envelope,
  pairAgent,
  wsUrl,
  type PairedAgent,
} from './agent-helpers.js';
import {
  insertVm,
  signedInAdmin,
  startBrowserApp,
  type BrowserTestContext,
  type TestClient,
} from './browser-app.js';

const SHA = 'c'.repeat(64);
const HISTORY_SIZE = 1_000;

interface Row {
  id?: string;
  agentId: string;
  emulatorType?: 'qemu' | '86box';
  vmName: string;
  mode?: 'copy' | 'transfer' | 'snapshot';
  state: string;
  createdAt: Date;
  errorCode?: string | null;
  localCopy?: string | null;
  versionId?: string;
  parentVersionId?: string | null;
  snapshotName?: string | null;
}

const COMMITTED = ['cleaning_local', 'succeeded', 'partial_success'];
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'partial_success'];

async function insertOperations(pool: Pool, repositoryId: string, rows: Row[]): Promise<string[]> {
  const ids: string[] = [];
  for (let start = 0; start < rows.length; start += 200) {
    const batch = rows.slice(start, start + 200);
    const values: unknown[] = [];
    for (const row of batch) {
      const id = row.id ?? randomUUID();
      ids.push(id);
      const committed = COMMITTED.includes(row.state);
      const versionId = row.versionId ?? randomUUID();
      values.push(
        id,
        row.agentId,
        repositoryId,
        row.emulatorType ?? 'qemu',
        row.vmName,
        row.mode ?? 'copy',
        row.state,
        versionId,
        row.parentVersionId ?? null,
        row.snapshotName ?? null,
        `vms/${row.emulatorType ?? 'qemu'}/${row.vmName}/${versionId}.zip`,
        committed ? SHA : null,
        committed ? 1024 : null,
        committed ? row.createdAt : null,
        TERMINAL.includes(row.state) ? row.createdAt : null,
        row.errorCode ?? (row.state === 'failed' ? 'repository_unreachable' : null),
        row.errorCode ?? (row.state === 'failed' ? 'The repository was unreachable.' : null),
        row.localCopy ?? null,
        row.createdAt,
      );
    }
    await pool.query(
      `INSERT INTO registration_operations
         (id, agent_id, repository_id, emulator_type, vm_name, mode, state, version_id,
          parent_version_id, snapshot_name, archive_key, archive_sha256, archive_size_bytes,
          committed_at, finished_at, error_code, error_message, local_copy, created_at)
       VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      values,
    );
  }
  return ids;
}

async function createRepository(admin: TestClient): Promise<string> {
  const response = await admin.request({
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
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

async function list(admin: TestClient, query: string): Promise<RegistrationListResponse> {
  const response = await admin.get(`/admin/registrations${query ? `?${query}` : ''}`);
  expect(response.statusCode, response.body).toBe(200);
  return registrationListResponseSchema.parse(response.json());
}

/** Every page of a listing, following the cursors. */
async function walk(
  admin: TestClient,
  query: string,
  between?: (page: number) => Promise<void>,
): Promise<RegistrationOperation[]> {
  const seen: RegistrationOperation[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    const suffix: string = cursor ? `&cursor=${cursor}` : '';
    const response = await list(admin, `${query}${suffix}`);
    seen.push(...response.operations);
    cursor = response.nextCursor;
    page += 1;
    if (between) await between(page);
    expect(page).toBeLessThan(200);
  } while (cursor);
  return seen;
}

const ids = (operations: RegistrationOperation[]) => operations.map((operation) => operation.id);

/** The order the API promises, worked out independently, from the database. */
async function expectedOrder(pool: Pool, where: string, parameters: unknown[]) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM registration_operations ${where} ORDER BY created_at DESC, id DESC`,
    parameters,
  );
  return rows.map((row) => row.id as string);
}

describe('the registration history', () => {
  let context: BrowserTestContext;
  let admin: TestClient;
  let first: PairedAgent;
  let second: PairedAgent;
  let repositoryId: string;
  const base = Date.UTC(2026, 0, 1);
  const at = (minutes: number) => new Date(base + minutes * 60_000);
  let queuedId: string;
  let partialId: string;
  let acknowledgedId: string;
  let snapshotId: string;
  let deletedSnapshotId: string;
  let masterVersionId: string;
  let firstHistory: number;

  beforeAll(async () => {
    context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
    admin = await signedInAdmin(context);
    first = await pairAgent(context.app, admin, { name: 'First PC' });
    second = await pairAgent(context.app, admin, { name: 'Second PC' });
    repositoryId = await createRepository(admin);

    // A thousand ended operations on the first agent, some sharing a creation time, so that only the ID
    // tells them apart.
    const history: Row[] = [];
    for (let index = 0; index < HISTORY_SIZE; index += 1) {
      history.push({
        agentId: first.agentId,
        emulatorType: index % 3 === 0 ? '86box' : 'qemu',
        vmName: `Vm-${String(index).padStart(4, '0')}`,
        mode: index % 5 === 0 ? 'transfer' : 'copy',
        state: ['succeeded', 'succeeded', 'failed', 'cancelled'][index % 4] as string,
        createdAt: at(Math.floor(index / 3)),
      });
    }
    await insertOperations(context.pool, repositoryId, history);
    firstHistory = HISTORY_SIZE;

    // What needs attention: one running, one partial success, and one already acknowledged.
    [queuedId, partialId, acknowledgedId] = (await insertOperations(context.pool, repositoryId, [
      { agentId: first.agentId, vmName: 'Running_VM', state: 'queued', createdAt: at(10) },
      {
        agentId: first.agentId,
        vmName: 'Kept%Copy',
        mode: 'transfer',
        state: 'partial_success',
        errorCode: 'cleanup_content_changed',
        localCopy: 'cleanup_failed',
        createdAt: at(20),
      },
      {
        agentId: first.agentId,
        vmName: 'Handled',
        mode: 'transfer',
        state: 'partial_success',
        errorCode: 'cleanup_in_use',
        localCopy: 'cleanup_failed',
        createdAt: at(30),
      },
    ])) as [string, string, string];
    await context.pool.execute(
      `UPDATE registration_operations SET acknowledged_at = UTC_TIMESTAMP(3) WHERE id = ?`,
      [acknowledgedId],
    );

    // A registered VM with a master and two snapshots, one of them deleted since.
    await insertVm(context.pool, { emulatorType: '86box', vmName: '486-dos622ita' });
    masterVersionId = randomUUID();
    const snapshotVersionId = randomUUID();
    const deletedVersionId = randomUUID();
    const version = (id: string, kind: string, parent: string | null, name: string | null) =>
      context.pool.execute(
        `INSERT INTO vm_versions (id, emulator_type, vm_name, kind, parent_version_id, snapshot_name,
           repository_id, archive_key, archive_sha256, archive_size_bytes)
         VALUES (?, '86box', '486-dos622ita', ?, ?, ?, ?, ?, ?, 1024)`,
        [id, kind, parent, name, repositoryId, `vms/86box/486-dos622ita/${id}.zip`, SHA],
      );
    await version(masterVersionId, 'master', null, null);
    await version(snapshotVersionId, 'snapshot', masterVersionId, '486-dos622ita 2026-11-10');
    await version(deletedVersionId, 'snapshot', snapshotVersionId, '486-dos622ita 2026-11-11');
    await context.pool.execute(
      `INSERT INTO vm_version_deletions (version_id, emulator_type, vm_name, request_id, state,
         repository_id, archive_key, archive_sha256, archive_size_bytes, completed_at, archive_outcome)
       VALUES (?, '86box', '486-dos622ita', ?, 'deleted', ?, ?, ?, 1024, UTC_TIMESTAMP(3), 'deleted')`,
      [
        deletedVersionId,
        randomUUID(),
        repositoryId,
        `vms/86box/486-dos622ita/${deletedVersionId}.zip`,
        SHA,
      ],
    );
    [, , snapshotId, deletedSnapshotId] = (await insertOperations(context.pool, repositoryId, [
      {
        agentId: second.agentId,
        emulatorType: '86box',
        vmName: '486-dos622ita',
        state: 'succeeded',
        versionId: masterVersionId,
        createdAt: at(1000),
      },
      {
        agentId: second.agentId,
        emulatorType: '86box',
        vmName: '486-dos622ita',
        mode: 'snapshot',
        state: 'failed',
        errorCode: 'snapshot_lineage_unverified',
        parentVersionId: masterVersionId,
        snapshotName: '486-dos622ita 2026-11-10 attempt',
        createdAt: at(1001),
      },
      {
        agentId: second.agentId,
        emulatorType: '86box',
        vmName: '486-dos622ita',
        mode: 'snapshot',
        state: 'succeeded',
        versionId: snapshotVersionId,
        parentVersionId: masterVersionId,
        snapshotName: '486-dos622ita 2026-11-10',
        createdAt: at(1002),
      },
      {
        agentId: second.agentId,
        emulatorType: '86box',
        vmName: '486-dos622ita',
        mode: 'snapshot',
        state: 'succeeded',
        versionId: deletedVersionId,
        parentVersionId: snapshotVersionId,
        snapshotName: '486-dos622ita 2026-11-11',
        createdAt: at(1003),
      },
    ])) as [string, string, string, string];
    await context.pool.query('ANALYZE TABLE registration_operations');
  }, 60_000);

  afterAll(async () => {
    await context?.close();
  });

  describe('as it always was', () => {
    it('lists the newest hundred by default, now with a cursor for the rest', async () => {
      const response = await list(admin, `agentId=${first.agentId}`);
      expect(response.operations).toHaveLength(100);
      expect(response.nextCursor).not.toBeNull();
      expect(response.total).toBeUndefined();
      const expected = await expectedOrder(context.pool, 'WHERE agent_id = ?', [first.agentId]);
      expect(ids(response.operations)).toEqual(expected.slice(0, 100));
    });

    it('needs an administrator', async () => {
      const anonymous = await context.app.inject({
        method: 'GET',
        url: '/api/v1/admin/registrations',
        headers: { host: 'emucat.test' },
      });
      expect(anonymous.statusCode).toBe(401);
      const acknowledge = await admin.request({
        method: 'POST',
        url: `/admin/registrations/${partialId}/acknowledge`,
        headers: { 'x-csrf-token': 'wrong' },
      });
      expect(acknowledge.statusCode).toBe(403);
    });
  });

  describe('pagination', () => {
    it('visits every operation exactly once, in a stable order, over a thousand rows', async () => {
      const seen = await walk(admin, `agentId=${first.agentId}&view=history&limit=37`);
      const expected = await expectedOrder(
        context.pool,
        'WHERE agent_id = ? AND active_marker IS NULL',
        [first.agentId],
      );
      expect(expected.length).toBe(firstHistory + 2);
      expect(ids(seen)).toEqual(expected);
      expect(new Set(ids(seen)).size).toBe(seen.length);
    });

    it('is not disturbed by operations created while someone is paging', async () => {
      const before = await expectedOrder(context.pool, 'WHERE agent_id = ?', [second.agentId]);
      const inserted: string[] = [];
      const seen = await walk(admin, `agentId=${second.agentId}&limit=1`, async (page) => {
        if (page === 2) {
          inserted.push(
            ...(await insertOperations(context.pool, repositoryId, [
              {
                agentId: second.agentId,
                vmName: 'Newcomer',
                state: 'failed',
                createdAt: new Date(base + 10_000 * 60_000),
              },
            ])),
          );
        }
      });
      expect(ids(seen)).toEqual(before);
      expect(ids(seen)).not.toContain(inserted[0]);
      const fresh = await list(admin, `agentId=${second.agentId}&limit=1`);
      expect(ids(fresh.operations)).toEqual(inserted);
    });

    it('bounds the page size, and accepts only cursors it issued', async () => {
      for (const query of [
        'limit=0',
        'limit=101',
        'limit=ten',
        'cursor=not-a-cursor!',
        `cursor=${Buffer.from('["yesterday","x"]').toString('base64url')}`,
        `cursor=${'A'.repeat(300)}`,
      ]) {
        const response = await admin.get(`/admin/registrations?${query}`);
        expect(response.statusCode, query).toBe(400);
      }
      const page = await list(admin, `limit=100`);
      expect(page.operations).toHaveLength(100);
    });
  });

  describe('filters', () => {
    it('refuses what is not a filter, or an impossible one', async () => {
      for (const query of [
        'view=everything',
        'agentId=not-a-uuid',
        'emulatorType=bochs',
        'vmName=../etc',
        'mode=move',
        'state=succeeded,exploded',
        'state=',
        'createdFrom=yesterday',
        'createdFrom=2026-02-01T00:00:00Z&createdBefore=2026-01-01T00:00:00Z',
        'path=C:\\Windows',
      ]) {
        const response = await admin.get(`/admin/registrations?${query}`);
        expect(response.statusCode, query).toBe(400);
      }
    });

    it('narrow by agent, emulator, VM, mode, state and date, together', async () => {
      const byEmulator = await walk(admin, `agentId=${first.agentId}&emulatorType=86box`);
      expect(byEmulator.length).toBe(Math.ceil(HISTORY_SIZE / 3));
      expect(byEmulator.every((operation) => operation.emulatorType === '86box')).toBe(true);

      const byVm = await list(admin, 'vmName=vm-0003');
      expect(byVm.operations.map((operation) => operation.vmName)).toEqual(['Vm-0003']);

      const byMode = await walk(admin, `agentId=${first.agentId}&mode=transfer&view=history`);
      expect(byMode.every((operation) => operation.mode === 'transfer')).toBe(true);
      expect(byMode.length).toBe(HISTORY_SIZE / 5 + 2);

      const byState = await walk(admin, `agentId=${first.agentId}&state=failed,cancelled`);
      expect(byState.length).toBe(HISTORY_SIZE / 2);
      expect(new Set(byState.map((operation) => operation.state))).toEqual(
        new Set(['failed', 'cancelled']),
      );

      // Minutes 100 to 109, three operations each.
      const byDate = await list(
        admin,
        `agentId=${first.agentId}&createdFrom=${at(100).toISOString()}&createdBefore=${at(110).toISOString()}`,
      );
      expect(byDate.operations).toHaveLength(30);

      const combined = await list(
        admin,
        `agentId=${first.agentId}&emulatorType=86box&state=succeeded&mode=copy&createdBefore=${at(10).toISOString()}`,
      );
      for (const operation of combined.operations) {
        expect(operation).toMatchObject({
          emulatorType: '86box',
          state: 'succeeded',
          mode: 'copy',
        });
        expect(Date.parse(operation.createdAt)).toBeLessThan(at(10).getTime());
      }
      expect(combined.operations.length).toBeGreaterThan(0);

      const otherAgent = await list(admin, `agentId=${randomUUID()}`);
      expect(otherAgent.operations).toEqual([]);
    });

    it('searches part of a name, taking its characters literally', async () => {
      const search = await list(admin, 'q=vm-012');
      expect(search.operations.map((operation) => operation.vmName).sort()).toEqual(
        Array.from({ length: 10 }, (_, index) => `Vm-012${index}`),
      );
      // "_" and "%" match only themselves, not any character.
      expect((await list(admin, 'q=g_V')).operations.map((o) => o.vmName)).toEqual(['Running_VM']);
      expect((await list(admin, 'q=t%25C')).operations.map((o) => o.vmName)).toEqual(['Kept%Copy']);
      expect((await list(admin, 'q=g%25V')).operations).toEqual([]);
    });
  });

  describe('what needs attention', () => {
    it('is what runs and what an administrator has to deal with, and never a plain failure', async () => {
      const attention = await list(admin, `agentId=${first.agentId}&view=attention`);
      expect(ids(attention.operations)).toEqual([partialId, queuedId]);
      expect(attention.total).toBe(2);
      expect(attention.operations.map((operation) => operation.state)).toEqual([
        'partial_success',
        'queued',
      ]);
    });

    it('says how many there are when they do not fit, so none is hidden', async () => {
      const page = await list(admin, 'view=attention&limit=1');
      expect(page.operations).toHaveLength(1);
      expect(page.total).toBe(2);
      expect(page.nextCursor).not.toBeNull();
    });

    it('keeps acknowledged partial successes, and failures, in the history', async () => {
      const history = await walk(admin, `agentId=${first.agentId}&view=history`);
      const historyIds = ids(history);
      expect(historyIds).toContain(partialId);
      expect(historyIds).toContain(acknowledgedId);
      expect(historyIds).not.toContain(queuedId);
      const acknowledged = history.find((operation) => operation.id === acknowledgedId);
      expect(acknowledged?.acknowledgedAt).not.toBeNull();
    });
  });

  describe('snapshots in the history', () => {
    it('name their parent, and say when their version has been deleted since', async () => {
      const history = await list(admin, `vmName=486-dos622ita&emulatorType=86box`);
      const byId = new Map(history.operations.map((operation) => [operation.id, operation]));
      expect(byId.get(snapshotId)).toMatchObject({
        mode: 'snapshot',
        parentVersionId: masterVersionId,
        parentSnapshotName: null,
        versionDeletion: null,
      });
      expect(byId.get(deletedSnapshotId)).toMatchObject({
        mode: 'snapshot',
        parentSnapshotName: '486-dos622ita 2026-11-10',
        versionDeletion: 'deleted',
      });
      const master = history.operations.find((operation) => operation.mode === 'copy');
      expect(master).toMatchObject({ versionId: masterVersionId, parentVersionId: null });
      expect(history.operations).toHaveLength(4);
    });
  });

  describe('query plans', () => {
    // The listings must read along an index in their own order, rather than sort the whole history.
    async function plan(sql: string, parameters: unknown[]) {
      const [rows] = await context.pool.query<RowDataPacket[]>(`EXPLAIN ${sql}`, parameters);
      return rows[0] as { key: string | null; Extra: string | null };
    }

    it('reads one agent’s history along its index', async () => {
      const used = await plan(
        `SELECT id FROM registration_operations AS op
         WHERE op.agent_id = ? AND op.active_marker IS NULL
         ORDER BY op.created_at DESC, op.id DESC LIMIT 101`,
        [first.agentId],
      );
      expect(used.key).toBe('ix_registration_agent_created');
      expect(used.Extra ?? '').not.toMatch(/filesort/);
    });

    it('reads one VM’s history along its index', async () => {
      const used = await plan(
        `SELECT id FROM registration_operations AS op
         WHERE op.emulator_type = ? AND op.vm_name = ?
         ORDER BY op.created_at DESC, op.id DESC LIMIT 101`,
        ['86box', '486-dos622ita'],
      );
      expect(used.key).toBe('ix_registration_vm_created');
      expect(used.Extra ?? '').not.toMatch(/filesort/);
    });

    it('finds what needs attention without reading the history', async () => {
      const used = await plan(
        `SELECT id FROM registration_operations AS op
         WHERE op.attention_marker = 1 AND op.agent_id = ?
         ORDER BY op.created_at DESC, op.id DESC LIMIT 11`,
        [first.agentId],
      );
      expect(used.key).toBe('ix_registration_attention');
      expect(used.Extra ?? '').not.toMatch(/filesort/);
    });
  });
});

describe('acknowledging a partial success', () => {
  let context: BrowserTestContext;
  let admin: TestClient;
  let paired: PairedAgent;
  let repositoryId: string;

  beforeAll(async () => {
    context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
    await context.app.listen({ host: '127.0.0.1', port: 0 });
    admin = await signedInAdmin(context);
    paired = await pairAgent(context.app, admin);
    repositoryId = await createRepository(admin);
  });

  afterAll(async () => {
    await context?.close();
  });

  const acknowledge = (operationId: string) =>
    admin.request({ method: 'POST', url: `/admin/registrations/${operationId}/acknowledge` });

  it('moves it to the history, says who did it, and changes nothing else', async () => {
    const [id] = await insertOperations(context.pool, repositoryId, [
      {
        agentId: paired.agentId,
        vmName: 'Kept',
        mode: 'transfer',
        state: 'partial_success',
        errorCode: 'cleanup_content_changed',
        localCopy: 'cleanup_failed',
        createdAt: new Date(),
      },
    ]);
    const response = await acknowledge(id as string);
    expect(response.statusCode, response.body).toBe(200);
    const operation = registrationOperationSchema.parse(response.json());
    expect(operation).toMatchObject({
      state: 'partial_success',
      localCopy: 'cleanup_failed',
      error: { code: 'cleanup_content_changed' },
      acknowledgedByDisplayName: 'The Admin',
    });
    expect(operation.acknowledgedAt).not.toBeNull();

    const again = await acknowledge(id as string);
    expect(again.statusCode).toBe(200);
    expect(registrationOperationSchema.parse(again.json()).acknowledgedAt).toBe(
      operation.acknowledgedAt,
    );
    const attention = await list(admin, `agentId=${paired.agentId}&view=attention`);
    expect(ids(attention.operations)).not.toContain(id);
  });

  it('is refused for anything else', async () => {
    const created = await insertOperations(context.pool, repositoryId, [
      { agentId: paired.agentId, vmName: 'Failed', state: 'failed', createdAt: new Date() },
      { agentId: paired.agentId, vmName: 'Done', state: 'succeeded', createdAt: new Date() },
      { agentId: paired.agentId, vmName: 'Busy', state: 'uploading', createdAt: new Date() },
    ]);
    for (const id of created) {
      const response = await acknowledge(id);
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        'registration_not_acknowledgeable',
      );
    }
    expect((await acknowledge(randomUUID())).statusCode).toBe(404);
    // The schema holds the rule too, whatever the application does.
    await expect(
      context.pool.execute(
        'UPDATE registration_operations SET acknowledged_at = UTC_TIMESTAMP(3) WHERE id = ?',
        [created[0] as string],
      ),
    ).rejects.toThrow(/ck_registration_acknowledged/);
    await context.pool.execute("UPDATE registration_operations SET state = 'failed' WHERE id = ?", [
      created[2] as string,
    ]);
  });

  it('is undone by retrying a removal, which needs attention again until it ends', async () => {
    const agent = await TestAgent.connect(wsUrl(context.app), paired.credential);
    await agent.hello();
    agent.send(envelope('agent.registration_sync', { operations: [] }));
    const [id] = await insertOperations(context.pool, repositoryId, [
      {
        agentId: paired.agentId,
        vmName: 'Blocked',
        mode: 'transfer',
        state: 'partial_success',
        errorCode: 'transfer_blocked_media',
        localCopy: 'preserved',
        createdAt: new Date(),
      },
    ]);
    expect((await acknowledge(id as string)).statusCode).toBe(200);
    const retried = await admin.request({
      method: 'POST',
      url: `/admin/registrations/${id}/retry-cleanup`,
    });
    expect(retried.statusCode, retried.body).toBe(202);
    expect(registrationOperationSchema.parse(retried.json())).toMatchObject({
      state: 'cleaning_local',
      acknowledgedAt: null,
      acknowledgedByDisplayName: null,
    });
    await agent.next('server.registration_retry_cleanup');
    const attention = await list(admin, `agentId=${paired.agentId}&view=attention`);
    expect(ids(attention.operations)).toContain(id);
    agent.close();
  });
});
