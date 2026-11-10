import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

/**
 * Migration 0010 (decision 0040): what the schema itself guarantees about remote sessions and
 * replacements, whatever the application does, and an upgrade of a database Milestone 7 populated.
 */
const sha = 'a'.repeat(64);
const ACTIVE = [
  'preparing',
  'ready',
  'running',
  'held',
  'publishing',
  'publish_failed',
  'discarding',
];

interface Fixture {
  repositoryId: string;
  agentId: string;
  master: string;
}

async function populate(pool: Pool): Promise<Fixture> {
  const fixture = { repositoryId: randomUUID(), agentId: randomUUID(), master: randomUUID() };
  await pool.execute("INSERT INTO repositories (id, name, kind) VALUES (?, 'NAS', 'sftp')", [
    fixture.repositoryId,
  ]);
  await pool.execute("INSERT INTO agents (id, name) VALUES (?, 'Study PC')", [fixture.agentId]);
  await pool.execute(
    "INSERT INTO virtual_machines (emulator_type, vm_name, visibility) VALUES ('qemu', 'Win98', 'public')",
  );
  await pool.execute(
    `INSERT INTO vm_versions (id, emulator_type, vm_name, kind, repository_id, archive_key,
       archive_sha256, archive_size_bytes)
     VALUES (?, 'qemu', 'Win98', 'master', ?, ?, ?, 2048)`,
    [fixture.master, fixture.repositoryId, `archives/qemu/win98/${fixture.master}.zip`, sha],
  );
  return fixture;
}

function workspace(
  pool: Pool,
  fixture: Fixture,
  values: { purpose?: string; state: string },
): Promise<string> {
  const id = randomUUID();
  const columns = values.purpose ? ', purpose' : '';
  const placeholders = values.purpose ? ', ?' : '';
  return pool
    .execute(
      `INSERT INTO vm_workspaces (id, agent_id, emulator_type, vm_name, base_version_id,
         source_version_id, state, finished_at${columns})
       VALUES (?, ?, 'qemu', 'Win98', ?, ?, ?, ?${placeholders})`,
      [
        id,
        fixture.agentId,
        fixture.master,
        fixture.master,
        values.state,
        ACTIVE.includes(values.state) ? null : new Date(),
        ...(values.purpose ? [values.purpose] : []),
      ],
    )
    .then(() => id);
}

async function finish(pool: Pool, id: string): Promise<void> {
  await pool.execute(
    "UPDATE vm_workspaces SET state = 'discarded', finished_at = UTC_TIMESTAMP(3) WHERE id = ?",
    [id],
  );
}

describe('remote sessions in the schema', () => {
  let database: TestDatabase;
  let pool: Pool;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createTestDatabase();
    await migrate(database.options);
    pool = database.createPool();
    fixture = await populate(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  it('gives each purpose its own states', async () => {
    for (const purpose of ['remote_volatile', 'remote_snapshot']) {
      const id = await workspace(pool, fixture, { purpose, state: 'running' });
      await finish(pool, id);
    }
    // A Milestone 7 working copy keeps its old lifecycle; a volatile one is never published.
    await expect(workspace(pool, fixture, { state: 'running' })).rejects.toThrow(
      /ck_vm_workspaces_lifecycle/,
    );
    await expect(
      workspace(pool, fixture, { purpose: 'remote_volatile', state: 'publishing' }),
    ).rejects.toThrow(/ck_vm_workspaces_publication/);
    await expect(workspace(pool, fixture, { purpose: 'local', state: 'ready' })).rejects.toThrow(
      /ck_vm_workspaces_purpose/,
    );
  });

  it('keeps one active remote session of a VM per agent, a pending publication included', async () => {
    for (const state of ['held', 'publish_failed', 'discarding']) {
      const id = await workspace(pool, fixture, { purpose: 'remote_snapshot', state });
      await expect(
        workspace(pool, fixture, { purpose: 'remote_volatile', state: 'preparing' }),
        state,
      ).rejects.toThrow(/Duplicate/);
      await finish(pool, id);
    }
  });

  it('ties every remote session to a working copy, and only those', async () => {
    const id = await workspace(pool, fixture, { purpose: 'remote_volatile', state: 'running' });
    const session = (mode: string, workspaceId: string | null) =>
      pool.execute(
        `INSERT INTO vm_sessions (id, agent_id, emulator_type, vm_name, mode, workspace_id,
           execution_state, ended_at)
         VALUES (?, ?, 'qemu', 'Win98', ?, ?, 'stopped', UTC_TIMESTAMP(3))`,
        [randomUUID(), fixture.agentId, mode, workspaceId],
      );
    await expect(session('remote_volatile', id)).resolves.toBeDefined();
    await expect(session('remote_volatile', null)).rejects.toThrow(/ck_vm_sessions_workspace/);
    await expect(session('local', id)).rejects.toThrow(/ck_vm_sessions_workspace/);
    await finish(pool, id);
  });

  it('only lets a replacement say what it replaced, and never into a working copy', async () => {
    const restore = (values: {
      replace: boolean;
      replaced: string | null;
      discard: boolean;
      workspaceId?: string | null;
    }) =>
      pool.execute(
        `INSERT INTO restore_operations (id, agent_id, repository_id, emulator_type, vm_name,
           version_id, state, archive_key, archive_sha256, archive_size_bytes, workspace_id,
           replace_existing, replaced_version_id, discard_local_changes, finished_at)
         VALUES (?, ?, ?, 'qemu', 'Win98', ?, 'failed', ?, ?, 2048, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
        [
          randomUUID(),
          fixture.agentId,
          fixture.repositoryId,
          fixture.master,
          `archives/qemu/win98/${fixture.master}.zip`,
          sha,
          values.workspaceId ?? null,
          values.replace,
          values.replaced,
          values.discard,
        ],
      );
    await expect(
      restore({ replace: true, replaced: fixture.master, discard: true }),
    ).resolves.toBeDefined();
    await expect(restore({ replace: true, replaced: null, discard: false })).resolves.toBeDefined();
    await expect(
      restore({ replace: false, replaced: fixture.master, discard: false }),
    ).rejects.toThrow(/ck_restore_replace/);
    await expect(restore({ replace: false, replaced: null, discard: true })).rejects.toThrow(
      /ck_restore_replace/,
    );
    await expect(
      restore({ replace: true, replaced: randomUUID(), discard: false }),
    ).rejects.toThrow(/foreign key/i);
    const id = await workspace(pool, fixture, { purpose: 'remote_volatile', state: 'failed' });
    await expect(
      restore({ replace: true, replaced: null, discard: false, workspaceId: id }),
    ).rejects.toThrow(/ck_restore_replace/);
  });
});

describe('upgrading a populated database to 0010', () => {
  let scratch: TestDatabase;
  let directory: string;
  let upgrade: Pool;

  beforeAll(async () => {
    scratch = await createTestDatabase();
    directory = await mkdtemp(join(tmpdir(), 'emucat-0010-'));
    for (const migration of (await loadMigrations()).filter((item) => item.version < '0010')) {
      await writeFile(join(directory, `${migration.version}.sql`), migration.sql);
    }
    await migrate(scratch.options, directory);
    upgrade = scratch.createPool();
  });

  afterAll(async () => {
    await upgrade?.end();
    await scratch?.drop();
    await rm(directory, { recursive: true, force: true });
  });

  const rowsOf = async (table: string) => {
    const [rows] = await upgrade.query<RowDataPacket[]>(`SELECT * FROM ${table} ORDER BY id`);
    return rows.map((row) => ({ ...row }));
  };

  it('keeps every working copy, session and restore, as manual working copies and creations', async () => {
    const fixture = await populate(upgrade);
    // What Milestone 7 leaves: a ready working copy with changes, its ended session, a discarded one,
    // a restore into it and an ordinary restore, and an unknown local session.
    const ready = randomUUID();
    const gone = randomUUID();
    await upgrade.execute(
      `INSERT INTO vm_workspaces (id, agent_id, request_id, emulator_type, vm_name, state,
         base_version_id, source_version_id, may_have_changes, local_directory)
       VALUES (?, ?, ?, 'qemu', 'Win98', 'ready', ?, ?, TRUE, 'C:\\\\state\\\\w\\\\Win98')`,
      [ready, fixture.agentId, randomUUID(), fixture.master, fixture.master],
    );
    await upgrade.execute(
      `INSERT INTO vm_workspaces (id, agent_id, emulator_type, vm_name, state, base_version_id,
         source_version_id, finished_at)
       VALUES (?, ?, 'qemu', 'Win98', 'discarded', ?, ?, UTC_TIMESTAMP(3))`,
      [gone, fixture.agentId, fixture.master, fixture.master],
    );
    await upgrade.execute(
      `INSERT INTO vm_sessions (id, agent_id, emulator_type, vm_name, source_version_id, mode,
         workspace_id, execution_state, ended_at)
       VALUES (?, ?, 'qemu', 'Win98', ?, 'remote_snapshot', ?, 'stopped', UTC_TIMESTAMP(3))`,
      [randomUUID(), fixture.agentId, fixture.master, ready],
    );
    await upgrade.execute(
      `INSERT INTO vm_sessions (id, agent_id, emulator_type, vm_name, mode, execution_state)
       VALUES (?, ?, 'qemu', 'Win98', 'local', 'unknown')`,
      [randomUUID(), fixture.agentId],
    );
    for (const workspaceId of [ready, null]) {
      await upgrade.execute(
        `INSERT INTO restore_operations (id, agent_id, repository_id, emulator_type, vm_name,
           version_id, state, archive_key, archive_sha256, archive_size_bytes, workspace_id,
           manifest_sha256, local_directory, finished_at)
         VALUES (?, ?, ?, 'qemu', 'Win98', ?, 'succeeded', ?, ?, 2048, ?, ?, 'D:/vms/Win98',
           UTC_TIMESTAMP(3))`,
        [
          randomUUID(),
          fixture.agentId,
          fixture.repositoryId,
          fixture.master,
          `archives/qemu/win98/${fixture.master}.zip`,
          sha,
          workspaceId,
          'b'.repeat(64),
        ],
      );
    }
    const tables = ['vm_workspaces', 'vm_sessions', 'restore_operations'];
    const before = new Map<string, Record<string, unknown>[]>();
    for (const table of tables) before.set(table, await rowsOf(table));

    for (const migration of (await loadMigrations()).filter((item) =>
      item.version.startsWith('0010'),
    )) {
      await writeFile(join(directory, `${migration.version}.sql`), migration.sql);
    }
    const result = await migrate(scratch.options, directory);
    expect(result.applied).toEqual(['0010_temporary_remote_sessions']);

    const defaults: Record<string, unknown> = {
      purpose: 'manual',
      session_id: null,
      snapshot_operation_id: null,
      publish_attempts: 0,
      next_retry_at: null,
      abandoned_at: null,
      replace_existing: 0,
      replaced_version_id: null,
      discard_local_changes: 0,
    };
    for (const table of tables) {
      const after = await rowsOf(table);
      const old = before.get(table) as Record<string, unknown>[];
      expect(after.length, table).toBe(old.length);
      after.forEach((row, index) => {
        const previous = old[index] as Record<string, unknown>;
        // Every column that existed is unchanged: no history is reinterpreted.
        for (const [column, value] of Object.entries(previous)) {
          expect(row[column], `${table}.${column}`).toEqual(value);
        }
        for (const [column, value] of Object.entries(defaults)) {
          if (column in row && !(column in previous)) {
            expect(row[column], `${table}.${column}`).toEqual(value);
          }
        }
      });
    }

    // The ready working copy is still the one active copy of that VM on that agent, and still manual:
    // it keeps its old states, so nothing can start running it as a remote session by itself.
    await expect(
      workspace(upgrade, fixture, { purpose: 'remote_volatile', state: 'preparing' }),
    ).rejects.toThrow(/Duplicate/);
    await expect(
      upgrade.execute("UPDATE vm_workspaces SET state = 'publishing' WHERE id = ?", [ready]),
    ).rejects.toThrow(/ck_vm_workspaces/);
    await expect(migrate(scratch.options, directory)).resolves.toMatchObject({ applied: [] });
  });
});
