import { randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

/**
 * The invariants of migration 0009 that survive any application bug: a snapshot operation names a parent of
 * its own VM, versions stay immutable, and working copies and their sessions cannot cross VMs.
 */
let database: TestDatabase;
let pool: Pool;
let repositoryId: string;
let agentId: string;
let master: string;
let otherMaster: string;

const sha = 'a'.repeat(64);

async function addVersion(vmName: string, kind: string, parent: string | null): Promise<string> {
  const id = randomUUID();
  await pool.execute(
    `INSERT INTO vm_versions (id, emulator_type, vm_name, kind, parent_version_id, snapshot_name,
       repository_id, archive_key, archive_sha256, archive_size_bytes)
     VALUES (?, 'qemu', ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      id,
      vmName,
      kind,
      parent,
      kind === 'snapshot' ? `${vmName}_202601010000` : null,
      repositoryId,
      `archives/qemu/${vmName.toLowerCase()}/${id}.zip`,
      sha,
    ],
  );
  return id;
}

function insertOperation(values: {
  vmName?: string;
  mode?: string;
  parent?: string | null;
  snapshotName?: string | null;
  workspaceId?: string | null;
  requestId?: string | null;
  state?: string;
}) {
  const versionId = randomUUID();
  return pool.execute(
    `INSERT INTO registration_operations
       (id, agent_id, repository_id, emulator_type, vm_name, mode, state, version_id, archive_key,
        parent_version_id, snapshot_name, workspace_id, request_id)
     VALUES (?, ?, ?, 'qemu', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      agentId,
      repositoryId,
      values.vmName ?? 'Win98',
      values.mode ?? 'snapshot',
      values.state ?? 'failed',
      versionId,
      `archives/qemu/win98/${versionId}.zip`,
      values.parent === undefined ? master : values.parent,
      values.snapshotName === undefined ? 'Win98_202601010000' : values.snapshotName,
      values.workspaceId ?? null,
      values.requestId ?? null,
    ],
  );
}

function insertWorkspace(vmName: string, version: string, state = 'ready') {
  const id = randomUUID();
  return pool
    .execute(
      `INSERT INTO vm_workspaces (id, agent_id, emulator_type, vm_name, base_version_id,
         source_version_id, state, finished_at)
       VALUES (?, ?, 'qemu', ?, ?, ?, ?, ?)`,
      [
        id,
        agentId,
        vmName,
        version,
        version,
        state,
        ['preparing', 'ready', 'discarding'].includes(state) ? null : new Date(),
      ],
    )
    .then(() => id);
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.options);
  pool = database.createPool();
  repositoryId = randomUUID();
  agentId = randomUUID();
  await pool.execute("INSERT INTO repositories (id, name, kind) VALUES (?, 'r', 'sftp')", [
    repositoryId,
  ]);
  await pool.execute("INSERT INTO agents (id, name) VALUES (?, 'agent')", [agentId]);
  for (const name of ['Win98', 'Other']) {
    await pool.execute("INSERT INTO virtual_machines (emulator_type, vm_name) VALUES ('qemu', ?)", [
      name,
    ]);
  }
  master = await addVersion('Win98', 'master', null);
  otherMaster = await addVersion('Other', 'master', null);
});

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('snapshot operations', () => {
  it('accepts a snapshot of a version of the same VM', async () => {
    await expect(insertOperation({})).resolves.toBeDefined();
  });

  it('refuses a parent from another VM', async () => {
    await expect(insertOperation({ parent: otherMaster })).rejects.toThrow(/foreign key/i);
  });

  it('refuses a parent that does not exist', async () => {
    await expect(insertOperation({ parent: randomUUID() })).rejects.toThrow(/foreign key/i);
  });

  it('refuses a snapshot without a parent or a name, and a copy with either', async () => {
    await expect(insertOperation({ parent: null })).rejects.toThrow(/ck_registration_snapshot/);
    await expect(insertOperation({ snapshotName: null })).rejects.toThrow(
      /ck_registration_snapshot/,
    );
    await expect(insertOperation({ mode: 'copy' })).rejects.toThrow(/ck_registration_snapshot/);
    await expect(
      insertOperation({ mode: 'copy', parent: null, snapshotName: null }),
    ).resolves.toBeDefined();
  });

  it('refuses an unknown mode', async () => {
    await expect(insertOperation({ mode: 'incremental' })).rejects.toThrow(/ck_registration_mode/);
  });

  it('makes a request ID unique, so a retry cannot create a second snapshot', async () => {
    const requestId = randomUUID();
    await insertOperation({ requestId });
    await expect(insertOperation({ requestId })).rejects.toThrow(/Duplicate/);
  });

  it('allows one active operation per VM', async () => {
    await insertOperation({ state: 'uploading' });
    await expect(insertOperation({ state: 'queued' })).rejects.toThrow(/Duplicate/);
    await pool.execute(
      "UPDATE registration_operations SET state = 'failed' WHERE state = 'uploading'",
    );
  });

  it('only lets a snapshot read a working copy of its own VM', async () => {
    const workspace = await insertWorkspace('Win98', master, 'discarded');
    const otherWorkspace = await insertWorkspace('Other', otherMaster, 'discarded');
    await expect(insertOperation({ workspaceId: workspace })).resolves.toBeDefined();
    await expect(insertOperation({ workspaceId: otherWorkspace })).rejects.toThrow(/foreign key/i);
    await expect(
      insertOperation({ mode: 'copy', parent: null, snapshotName: null, workspaceId: workspace }),
    ).rejects.toThrow(/ck_registration_snapshot/);
  });
});

describe('the version tree', () => {
  it('branches: two children may share a parent, and versions stay immutable', async () => {
    const a = await addVersion('Win98', 'snapshot', master);
    const b = await addVersion('Win98', 'snapshot', master);
    const c = await addVersion('Win98', 'snapshot', a);
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, parent_version_id FROM vm_versions WHERE parent_version_id IN (?, ?)',
      [master, a],
    );
    expect(rows.map((row) => [row.id, row.parent_version_id]).sort()).toEqual(
      [
        [a, master],
        [b, master],
        [c, a],
      ].sort(),
    );
    await expect(
      pool.execute('UPDATE vm_versions SET parent_version_id = ? WHERE id = ?', [c, a]),
    ).rejects.toThrow(/immutable/);
    // A parent cannot be removed while a child refers to it.
    await expect(pool.execute('DELETE FROM vm_versions WHERE id = ?', [a])).rejects.toThrow(
      /foreign key/i,
    );
  });

  it('refuses a snapshot whose parent belongs to another VM', async () => {
    await expect(addVersion('Win98', 'snapshot', otherMaster)).rejects.toThrow(/foreign key/i);
  });
});

describe('working copies', () => {
  it('allows one active working copy of a VM per agent', async () => {
    const first = await insertWorkspace('Win98', master, 'ready');
    await expect(insertWorkspace('Win98', master, 'preparing')).rejects.toThrow(/Duplicate/);
    await pool.execute(
      "UPDATE vm_workspaces SET state = 'discarded', finished_at = UTC_TIMESTAMP(3) WHERE id = ?",
      [first],
    );
    await expect(insertWorkspace('Win98', master, 'preparing')).resolves.toBeDefined();
  });

  it('refuses a working copy of another VM’s version', async () => {
    await expect(insertWorkspace('Win98', otherMaster, 'failed')).rejects.toThrow(/foreign key/i);
  });

  it('ties remote_snapshot sessions to a working copy, and nothing else', async () => {
    const workspace = await insertWorkspace('Other', otherMaster, 'ready');
    const session = (mode: string, workspaceId: string | null) =>
      pool.execute(
        `INSERT INTO vm_sessions (id, agent_id, emulator_type, vm_name, mode, workspace_id,
           execution_state, ended_at)
         VALUES (?, ?, 'qemu', 'Other', ?, ?, 'stopped', UTC_TIMESTAMP(3))`,
        [randomUUID(), agentId, mode, workspaceId],
      );
    await expect(session('remote_snapshot', workspace)).resolves.toBeDefined();
    await expect(session('remote_snapshot', null)).rejects.toThrow(/ck_vm_sessions_workspace/);
    await expect(session('local', workspace)).rejects.toThrow(/ck_vm_sessions_workspace/);
  });
});
