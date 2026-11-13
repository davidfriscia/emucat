import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

/**
 * The invariants of migration 0011 that survive any application bug (decision 0041): an agent removes one
 * copy at a time, a master is never deleted, and a tombstone never goes away, comes back or changes target.
 */
let database: TestDatabase;
let pool: Pool;
let repositoryId: string;
let agentId: string;
let otherAgentId: string;
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

function insertRemoval(values: {
  agent?: string;
  vmName?: string;
  expected?: string | null;
  state?: string;
  errorCode?: string | null;
  cleanupPending?: boolean;
  finished?: boolean;
}) {
  const state = values.state ?? 'requested';
  return pool.execute(
    `INSERT INTO local_copy_removals (id, agent_id, request_id, emulator_type, vm_name,
       expected_version_id, state, error_code, cleanup_pending, finished_at)
     VALUES (?, ?, ?, 'qemu', ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      values.agent ?? agentId,
      randomUUID(),
      values.vmName ?? 'Win98',
      values.expected === undefined ? master : values.expected,
      state,
      values.errorCode === undefined ? (state === 'failed' ? 'vm_running' : null) : values.errorCode,
      values.cleanupPending ?? false,
      (values.finished ?? state !== 'requested') ? new Date() : null,
    ],
  );
}

function insertDeletion(version: string, vmName = 'Win98') {
  return pool.execute(
    `INSERT INTO vm_version_deletions (version_id, emulator_type, vm_name, request_id, repository_id,
       archive_key, archive_sha256, archive_size_bytes)
     VALUES (?, 'qemu', ?, ?, ?, ?, ?, 1)`,
    [
      version,
      vmName,
      randomUUID(),
      repositoryId,
      `archives/qemu/${vmName.toLowerCase()}/${version}.zip`,
      sha,
    ],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.options);
  pool = database.createPool();
  repositoryId = randomUUID();
  agentId = randomUUID();
  otherAgentId = randomUUID();
  await pool.execute("INSERT INTO repositories (id, name, kind) VALUES (?, 'r', 'sftp')", [
    repositoryId,
  ]);
  await pool.execute("INSERT INTO agents (id, name) VALUES (?, 'agent'), (?, 'other')", [
    agentId,
    otherAgentId,
  ]);
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

describe('local copy removals', () => {
  it('allows one active removal per agent, and any number that ended', async () => {
    await expect(insertRemoval({})).resolves.toBeDefined();
    await expect(insertRemoval({ vmName: 'Other', expected: null })).rejects.toThrow(
      /uq_local_copy_removals_active_agent/,
    );
    await expect(insertRemoval({ agent: otherAgentId })).resolves.toBeDefined();
    await expect(insertRemoval({ state: 'succeeded' })).resolves.toBeDefined();
    await expect(insertRemoval({ state: 'failed' })).resolves.toBeDefined();
  });

  it('names only a version of the VM it removes', async () => {
    await expect(
      insertRemoval({ agent: randomUUID(), expected: otherMaster, state: 'failed' }),
    ).rejects.toThrow(/foreign key/i);
    await expect(insertRemoval({ expected: otherMaster, state: 'failed' })).rejects.toThrow(
      /foreign key/i,
    );
  });

  it('keeps state, finish, failure and cleanup consistent', async () => {
    await expect(insertRemoval({ state: 'failed', errorCode: null })).rejects.toThrow(
      /ck_local_copy_removals_failed/,
    );
    await expect(insertRemoval({ state: 'succeeded', finished: false })).rejects.toThrow(
      /ck_local_copy_removals_finished/,
    );
    await expect(insertRemoval({ state: 'failed', cleanupPending: true })).rejects.toThrow(
      /ck_local_copy_removals_cleanup/,
    );
    await expect(insertRemoval({ state: 'done' })).rejects.toThrow(/ck_local_copy_removals_state/);
  });
});

describe('version deletions', () => {
  it('never deletes a master', async () => {
    await expect(insertDeletion(master)).rejects.toThrow(/only snapshots can be deleted/);
  });

  it('only names a version of its own VM', async () => {
    const snapshot = await addVersion('Win98', 'snapshot', master);
    await expect(insertDeletion(snapshot, 'Other')).rejects.toThrow(/foreign key/i);
  });

  it('is final: never undone, removed or pointed elsewhere', async () => {
    const snapshot = await addVersion('Win98', 'snapshot', master);
    await insertDeletion(snapshot);
    await expect(insertDeletion(snapshot)).rejects.toThrow(/Duplicate/);

    // Attempts are recorded freely while it is deleting.
    await pool.execute(
      `UPDATE vm_version_deletions SET attempts = attempts + 1, attempt_id = ?, error_code = 'x'
       WHERE version_id = ?`,
      [randomUUID(), snapshot],
    );
    for (const change of [
      "archive_key = 'archives/qemu/win98/other.zip'",
      'archive_size_bytes = 2',
      `archive_sha256 = '${'b'.repeat(64)}'`,
      `repository_id = '${randomUUID()}'`,
    ]) {
      await expect(
        pool.execute(`UPDATE vm_version_deletions SET ${change} WHERE version_id = ?`, [snapshot]),
      ).rejects.toThrow(/cannot be undone or redirected/);
    }
    await expect(
      pool.execute(
        "UPDATE vm_version_deletions SET state = 'deleted' WHERE version_id = ?",
        [snapshot],
      ),
    ).rejects.toThrow(/ck_vm_version_deletions_completed/);
    await pool.execute(
      `UPDATE vm_version_deletions SET state = 'deleted', archive_outcome = 'deleted',
         completed_at = CURRENT_TIMESTAMP(3) WHERE version_id = ?`,
      [snapshot],
    );
    await expect(
      pool.execute(
        `UPDATE vm_version_deletions SET state = 'deleting', archive_outcome = NULL, completed_at = NULL
         WHERE version_id = ?`,
        [snapshot],
      ),
    ).rejects.toThrow(/cannot be undone or redirected/);
    await expect(
      pool.execute('DELETE FROM vm_version_deletions WHERE version_id = ?', [snapshot]),
    ).rejects.toThrow(/never removed/);
    // And the version itself stays, as history names it.
    await expect(
      pool.execute('DELETE FROM vm_versions WHERE id = ?', [snapshot]),
    ).rejects.toThrow();
  });
});
