import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseAgentAuthenticator, hashToken } from '../src/auth/agent-auth.js';
import { loadMigrations, migrate, migrationLockName, MigrationError } from '../src/db/migrate.js';
import { databaseReadiness } from '../src/readiness.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const REQUIRED_TABLES = [
  'users',
  'user_sessions',
  'agents',
  'virtual_machines',
  'vm_versions',
  'agent_vm_state',
  'vm_sessions',
  'vm_media',
  'repositories',
];

let database: TestDatabase;
let pool: Pool;
let repositoryId: string;

const hash = (character: string) => character.repeat(64);

beforeAll(async () => {
  database = await createTestDatabase();
  pool = database.createPool();
});

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('migration runner', () => {
  it('reports pending migrations on a fresh database', async () => {
    const readiness = databaseReadiness(pool, await loadMigrations(), () => undefined);
    await expect(readiness()).resolves.toEqual({ database: 'ok', migrations: 'failed' });
  });

  it('applies all migrations to a fresh database', async () => {
    const all = (await loadMigrations()).map((migration) => migration.version);
    const result = await migrate(database.options);
    expect(result.applied).toEqual(all);
    expect(result.alreadyApplied).toEqual([]);
  });

  it('creates every table in the schema', async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'",
    );
    expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining(REQUIRED_TABLES));
  });

  it('does not seed any users or credentials', async () => {
    for (const table of ['users', 'user_sessions', 'agents']) {
      const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${table}`);
      expect(Number(rows[0]?.count), table).toBe(0);
    }
  });

  it('does nothing on a second run', async () => {
    const result = await migrate(database.options);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toHaveLength((await loadMigrations()).length);
  });

  it('makes readiness pass once applied', async () => {
    const readiness = databaseReadiness(pool, await loadMigrations(), () => undefined);
    await expect(readiness()).resolves.toEqual({ database: 'ok', migrations: 'ok' });
  });

  describe('with a scratch database', () => {
    let scratch: TestDatabase;
    let directory: string;

    beforeEach(async () => {
      scratch = await createTestDatabase();
      directory = await mkdtemp(join(tmpdir(), 'emucat-migrations-'));
      return async () => {
        await scratch.drop();
        await rm(directory, { recursive: true, force: true });
      };
    });

    it('refuses a migration that changed after being applied', async () => {
      const file = join(directory, '0001_a.sql');
      await writeFile(file, 'CREATE TABLE a (id INT);');
      await migrate(scratch.options, directory);
      await writeFile(file, 'CREATE TABLE b (id INT);');
      await expect(migrate(scratch.options, directory)).rejects.toThrow(/changed after/);
    });

    it('treats line endings as the same content', async () => {
      const file = join(directory, '0001_a.sql');
      await writeFile(file, 'CREATE TABLE a (id INT);\n');
      await migrate(scratch.options, directory);
      await writeFile(file, 'CREATE TABLE a (id INT);\r\n');
      await expect(migrate(scratch.options, directory)).resolves.toMatchObject({ applied: [] });
    });

    it('refuses to continue after a failed migration', async () => {
      await writeFile(join(directory, '0001_bad.sql'), 'CREATE TABLE a (id INT); NOT VALID SQL;');
      await expect(migrate(scratch.options, directory)).rejects.toThrow();
      await expect(migrate(scratch.options, directory)).rejects.toThrow(/did not finish/);
    });

    it('refuses a database with an unknown migration', async () => {
      await writeFile(join(directory, '0001_a.sql'), 'CREATE TABLE a (id INT);');
      await migrate(scratch.options, directory);
      await rm(join(directory, '0001_a.sql'));
      await expect(migrate(scratch.options, directory)).rejects.toThrow(/unknown migration/);
    });

    describe('concurrent runs', () => {
      /** Stands in for a run in progress, for as long as a test wants, so nothing depends on timing. */
      const holdLockOf = async (target: TestDatabase) => {
        const holder = await pool.getConnection();
        const name = migrationLockName(target.options.database as string);
        const [rows] = await holder.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS acquired', [
          name,
        ]);
        expect(rows[0]?.acquired).toBe(1);
        return {
          name,
          release: async () => {
            await holder.query('SELECT RELEASE_LOCK(?)', [name]);
            holder.release();
          },
        };
      };

      const waitForLockWaiter = async (name: string) => {
        await expect
          .poll(
            async () => {
              const [rows] = await pool.query<RowDataPacket[]>(
                "SELECT COUNT(*) AS waiting FROM information_schema.processlist WHERE info LIKE 'SELECT GET_LOCK%' AND info LIKE ?",
                [`%${name}%`],
              );
              return Number(rows[0]?.waiting);
            },
            { timeout: 20_000, interval: 20 },
          )
          .toBeGreaterThan(0);
      };

      it('does not make a database wait for a run on another database', async () => {
        const other = await createTestDatabase();
        const lock = await holdLockOf(other);
        try {
          await writeFile(join(directory, '0001_a.sql'), 'CREATE TABLE a (id INT);');
          await expect(migrate(scratch.options, directory)).resolves.toMatchObject({
            applied: ['0001_a'],
          });
        } finally {
          await lock.release();
          await other.drop();
        }
      });

      it('makes a run wait for another on the same database, so each migration applies once', async () => {
        await writeFile(join(directory, '0001_a.sql'), 'CREATE TABLE a (id INT);');
        const lock = await holdLockOf(scratch);
        let waiting: Promise<unknown> | undefined;
        try {
          waiting = migrate(scratch.options, directory);
          await waitForLockWaiter(lock.name);

          const [tables] = await pool.query<RowDataPacket[]>(
            'SELECT 1 FROM information_schema.tables WHERE table_schema = ?',
            [scratch.options.database],
          );
          expect(tables).toEqual([]);
        } finally {
          await lock.release();
        }

        await expect(waiting).resolves.toMatchObject({ applied: ['0001_a'] });
        await expect(migrate(scratch.options, directory)).resolves.toEqual({
          applied: [],
          alreadyApplied: ['0001_a'],
        });
      });
    });

    it('rejects a badly named file', async () => {
      await writeFile(join(directory, 'latest.sql'), 'SELECT 1;');
      await expect(migrate(scratch.options, directory)).rejects.toThrow(MigrationError);
    });
  });
});

describe('schema rules', () => {
  const addVm = (emulatorType: string, vmName: string) =>
    pool.execute('INSERT INTO virtual_machines (emulator_type, vm_name) VALUES (?, ?)', [
      emulatorType,
      vmName,
    ]);

  interface VersionOverrides {
    id?: string;
    emulatorType?: string;
    vmName?: string;
    kind?: string;
    parent?: string | null;
    snapshotName?: string | null;
  }

  async function addVersion(overrides: VersionOverrides = {}): Promise<string> {
    const id = overrides.id ?? randomUUID();
    await pool.execute(
      `INSERT INTO vm_versions (id, emulator_type, vm_name, kind, parent_version_id, snapshot_name,
         repository_id, archive_key, archive_sha256, archive_size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        overrides.emulatorType ?? 'qemu',
        overrides.vmName ?? 'Win98',
        overrides.kind ?? 'snapshot',
        overrides.parent ?? null,
        overrides.snapshotName ?? null,
        repositoryId,
        `archives/${id}.zip`,
        hash('a'),
        1,
      ],
    );
    return id;
  }

  async function addMedia(
    emulatorType: string,
    vmName: string,
    values: { sha?: string; visibility?: string; isMain?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    await pool.execute(
      `INSERT INTO vm_media (id, emulator_type, vm_name, visibility, is_main, original_filename,
         original_sha256, original_size_bytes, jpeg_key, thumbnail_key, width_px, height_px)
       VALUES (?, ?, ?, ?, ?, 'a.ppm', ?, 1, 'j', 't', 1, 1)`,
      [
        id,
        emulatorType,
        vmName,
        values.visibility ?? 'private',
        values.isMain ?? false,
        values.sha ?? uniqueSha(),
      ],
    );
    return id;
  }

  const uniqueSha = () =>
    (randomUUID() + randomUUID()).replaceAll('-', '').padEnd(64, '0').slice(0, 64);

  beforeAll(async () => {
    repositoryId = randomUUID();
    await pool.execute("INSERT INTO repositories (id, name, kind) VALUES (?, 'test', 'test')", [
      repositoryId,
    ]);
    await addVm('qemu', 'Win98');
    await addVm('qemu', 'Other');
    await addVm('86box', 'Win98');
  });

  describe('VM identity', () => {
    it('allows the same name under different emulators', async () => {
      await expect(addVm('86box', 'SameName')).resolves.toBeDefined();
      await expect(addVm('qemu', 'SameName')).resolves.toBeDefined();
    });

    it('treats names differing only by case as the same VM', async () => {
      await expect(addVm('qemu', 'WIN98')).rejects.toThrow(/Duplicate/);
    });

    it.each(['vmware', '86BOX', ''])('rejects the emulator type %j', async (emulatorType) => {
      await expect(addVm(emulatorType, 'Valid')).rejects.toThrow();
    });

    it.each(['../evil', 'a/b', 'a\\b', '.hidden', 'trailing.', '-rf', 'a..b', 'café', 'C:'])(
      'rejects the unsafe name %j',
      async (name) => {
        await expect(addVm('qemu', name)).rejects.toThrow();
      },
    );

    it('rejects a child row for a VM that is not registered', async () => {
      await expect(addVersion({ vmName: 'Missing', kind: 'master' })).rejects.toThrow(
        /foreign key/i,
      );
    });
  });

  describe('versions', () => {
    let master: string;

    beforeAll(async () => {
      master = await addVersion({ kind: 'master' });
    });

    it('allows one master per VM', async () => {
      await expect(addVersion({ kind: 'master' })).rejects.toThrow(/Duplicate/);
    });

    it('allows a master for another VM', async () => {
      await expect(addVersion({ vmName: 'Other', kind: 'master' })).resolves.toBeDefined();
    });

    it('rejects a master with a parent', async () => {
      await expect(addVersion({ kind: 'master', parent: master })).rejects.toThrow();
    });

    it('rejects a snapshot without a parent or a name', async () => {
      await expect(addVersion({ snapshotName: 'Win98_202601010000' })).rejects.toThrow();
      await expect(addVersion({ parent: master })).rejects.toThrow();
    });

    it('allows branching and same-minute snapshot names, with distinct IDs', async () => {
      const name = 'Win98_202601010000';
      const a = await addVersion({ parent: master, snapshotName: name });
      const b = await addVersion({ parent: master, snapshotName: name });
      const c = await addVersion({ parent: a, snapshotName: 'Win98_202601010001' });
      expect(new Set([a, b, c]).size).toBe(3);
    });

    it('rejects a parent from another VM, even with the same name under another emulator', async () => {
      const foreign = await addVersion({ emulatorType: '86box', kind: 'master' });
      await expect(
        addVersion({ parent: foreign, snapshotName: 'Win98_202601010000' }),
      ).rejects.toThrow(/foreign key/i);
    });

    it('rejects a snapshot that is its own parent', async () => {
      const id = randomUUID();
      await expect(
        addVersion({ id, parent: id, snapshotName: 'Win98_202601010000' }),
      ).rejects.toThrow();
    });

    it('rejects changes to a version', async () => {
      await expect(
        pool.execute('UPDATE vm_versions SET archive_sha256 = ? WHERE id = ?', [hash('b'), master]),
      ).rejects.toThrow(/immutable/);
    });

    it('rejects reparenting, which could form a cycle', async () => {
      const child = await addVersion({ parent: master, snapshotName: 'Win98_202602010000' });
      await expect(
        pool.execute('UPDATE vm_versions SET parent_version_id = ? WHERE id = ?', [
          randomUUID(),
          child,
        ]),
      ).rejects.toThrow(/immutable/);
    });

    it('rejects deleting a version that has descendants', async () => {
      await expect(pool.execute('DELETE FROM vm_versions WHERE id = ?', [master])).rejects.toThrow(
        /foreign key/i,
      );
    });

    it('keeps a version when the agent that created it is removed', async () => {
      const agent = randomUUID();
      await pool.execute("INSERT INTO agents (id, name) VALUES (?, 'to-remove')", [agent]);
      const id = randomUUID();
      await pool.execute(
        `INSERT INTO vm_versions (id, emulator_type, vm_name, kind, parent_version_id, snapshot_name,
           repository_id, archive_key, archive_sha256, archive_size_bytes, created_by_agent_id)
         VALUES (?, 'qemu', 'Win98', 'snapshot', ?, 'Win98_202603010000', ?, ?, ?, 1, ?)`,
        [id, master, repositoryId, `archives/${id}.zip`, hash('c'), agent],
      );
      await pool.execute('DELETE FROM agents WHERE id = ?', [agent]);
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT created_by_agent_id FROM vm_versions WHERE id = ?',
        [id],
      );
      expect(rows[0]?.created_by_agent_id).toBeNull();
    });
  });

  describe('agent state', () => {
    it('defaults a new local copy to unverified', async () => {
      const agent = randomUUID();
      await pool.execute("INSERT INTO agents (id, name) VALUES (?, 'state')", [agent]);
      await pool.execute(
        "INSERT INTO agent_vm_state (agent_id, emulator_type, vm_name) VALUES (?, 'qemu', 'Win98')",
        [agent],
      );
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT content_status, execution_state FROM agent_vm_state WHERE agent_id = ?',
        [agent],
      );
      expect(rows[0]).toEqual({ content_status: 'unverified', execution_state: 'unknown' });
    });

    it('rejects a source version from another VM', async () => {
      const agent = randomUUID();
      await pool.execute("INSERT INTO agents (id, name) VALUES (?, 'state2')", [agent]);
      const [masters] = await pool.query<RowDataPacket[]>(
        "SELECT id FROM vm_versions WHERE emulator_type = 'qemu' AND vm_name = 'Other' AND kind = 'master'",
      );
      await expect(
        pool.execute(
          `INSERT INTO agent_vm_state (agent_id, emulator_type, vm_name, local_source_version_id)
           VALUES (?, 'qemu', 'Win98', ?)`,
          [agent, masters[0]?.id],
        ),
      ).rejects.toThrow(/foreign key/i);
    });

    it('rejects a verified status with no verification time', async () => {
      const agent = randomUUID();
      await pool.execute("INSERT INTO agents (id, name) VALUES (?, 'state3')", [agent]);
      await expect(
        pool.execute(
          `INSERT INTO agent_vm_state (agent_id, emulator_type, vm_name, content_status)
           VALUES (?, 'qemu', 'Win98', 'verified')`,
          [agent],
        ),
      ).rejects.toThrow();
    });
  });

  describe('sessions', () => {
    it('allows one active session per agent and VM', async () => {
      const agent = randomUUID();
      await pool.execute("INSERT INTO agents (id, name) VALUES (?, 'sessions')", [agent]);
      const insert = () =>
        pool.execute(
          "INSERT INTO vm_sessions (id, agent_id, emulator_type, vm_name) VALUES (?, ?, 'qemu', 'Win98')",
          [randomUUID(), agent],
        );
      await insert();
      await expect(insert()).rejects.toThrow(/Duplicate/);
      await pool.execute(
        "UPDATE vm_sessions SET execution_state = 'stopped', ended_at = CURRENT_TIMESTAMP(3) WHERE agent_id = ?",
        [agent],
      );
      await expect(insert()).resolves.toBeDefined();
    });

    it('keeps the state and the end in agreement, and one session per launch request', async () => {
      const agent = randomUUID();
      await pool.execute("INSERT INTO agents (id, name) VALUES (?, 'sessions-2')", [agent]);
      const id = randomUUID();
      const request = randomUUID();
      await pool.execute(
        "INSERT INTO vm_sessions (id, agent_id, request_id, emulator_type, vm_name) VALUES (?, ?, ?, 'qemu', 'Win98')",
        [id, agent, request],
      );
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT execution_state, mode FROM vm_sessions WHERE id = ?',
        [id],
      );
      expect(rows[0]).toMatchObject({ execution_state: 'requested', mode: 'local' });
      // Ended, yet running: refused. Running is not a state that can end.
      await expect(
        pool.execute('UPDATE vm_sessions SET ended_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [id]),
      ).rejects.toThrow(/ck_vm_sessions_active/);
      await expect(
        pool.execute("UPDATE vm_sessions SET execution_state = 'exploded' WHERE id = ?", [id]),
      ).rejects.toThrow(/ck_vm_sessions_state/);
      await expect(
        pool.execute("UPDATE vm_sessions SET mode = 'shell' WHERE id = ?", [id]),
      ).rejects.toThrow(/ck_vm_sessions_mode/);
      await pool.execute(
        "UPDATE vm_sessions SET execution_state = 'failed', ended_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
        [id],
      );
      await expect(
        pool.execute(
          "INSERT INTO vm_sessions (id, agent_id, request_id, emulator_type, vm_name) VALUES (?, ?, ?, 'qemu', 'Win98')",
          [randomUUID(), agent, request],
        ),
      ).rejects.toThrow(/Duplicate/);
    });
  });

  describe('media', () => {
    const cardMedia = async (vmName: string) => {
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT media_id FROM public_catalog_card_media WHERE vm_name = ?',
        [vmName],
      );
      return rows.map((row) => row.media_id as string);
    };

    const newVm = async (visibility = 'public') => {
      const name = `vm${randomUUID().slice(0, 8)}`;
      await pool.execute(
        "INSERT INTO virtual_machines (emulator_type, vm_name, visibility) VALUES ('qemu', ?, ?)",
        [name, visibility],
      );
      return name;
    };

    it('defaults to private and not main', async () => {
      const vm = await newVm();
      const id = await addMedia('qemu', vm, { sha: uniqueSha() });
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT visibility, is_main FROM vm_media WHERE id = ?',
        [id],
      );
      expect(rows[0]).toEqual({ visibility: 'private', is_main: 0 });
    });

    it('deduplicates by VM identity and original hash', async () => {
      const [a, b] = [await newVm(), await newVm()];
      const sha = uniqueSha();
      await addMedia('qemu', a, { sha });
      await expect(addMedia('qemu', a, { sha })).rejects.toThrow(/Duplicate/);
      await expect(addMedia('qemu', b, { sha })).resolves.toBeDefined();
    });

    it('allows at most one main item per VM', async () => {
      const vm = await newVm();
      await addMedia('qemu', vm, { sha: uniqueSha(), isMain: true });
      await expect(addMedia('qemu', vm, { sha: uniqueSha(), isMain: true })).rejects.toThrow(
        /Duplicate/,
      );
      await expect(addMedia('qemu', vm, { sha: uniqueSha() })).resolves.toBeDefined();
    });

    it("shows a public VM's main item publicly, whatever its legacy visibility", async () => {
      const vm = await newVm();
      const id = await addMedia('qemu', vm, { sha: uniqueSha(), isMain: true });
      await expect(cardMedia(vm)).resolves.toEqual([id]);
      await pool.execute("UPDATE vm_media SET visibility = 'published' WHERE id = ?", [id]);
      await expect(cardMedia(vm)).resolves.toEqual([id]);
      await pool.execute('UPDATE vm_media SET is_main = FALSE WHERE id = ?', [id]);
      await expect(cardMedia(vm)).resolves.toEqual([]);
    });

    it('never falls back to other media after deleting the main item', async () => {
      const vm = await newVm();
      const main = await addMedia('qemu', vm, { sha: uniqueSha(), isMain: true });
      await addMedia('qemu', vm, { sha: uniqueSha(), visibility: 'published' });
      await expect(cardMedia(vm)).resolves.toEqual([main]);
      await pool.execute('DELETE FROM vm_media WHERE id = ?', [main]);
      await expect(cardMedia(vm)).resolves.toEqual([]);
    });

    it('does not expose media of a private VM, whatever its legacy visibility', async () => {
      const vm = await newVm('private');
      await addMedia('qemu', vm, { sha: uniqueSha(), isMain: true, visibility: 'published' });
      await expect(cardMedia(vm)).resolves.toEqual([]);
    });

    it('still refuses an unknown legacy value, so the column stays meaningful history', async () => {
      const vm = await newVm();
      await expect(
        addMedia('qemu', vm, { sha: uniqueSha(), visibility: 'public' }),
      ).rejects.toThrow(/CONSTRAINT|check/i);
    });

    it('rejects media for an unregistered VM', async () => {
      await expect(addMedia('qemu', 'Missing', { sha: uniqueSha() })).rejects.toThrow(
        /foreign key/i,
      );
    });
  });

  describe('agent credentials', () => {
    it('authenticates by token hash and honors revocation', async () => {
      const id = randomUUID();
      const token = 'a-long-random-agent-token';
      await pool.execute("INSERT INTO agents (id, name, credential_hash) VALUES (?, 'auth', ?)", [
        id,
        hashToken(token),
      ]);
      const authenticate = databaseAgentAuthenticator(pool);
      await expect(authenticate(token)).resolves.toEqual({ agentId: id });
      await expect(authenticate('another-long-random-token')).resolves.toBeNull();
      await pool.execute('UPDATE agents SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [id]);
      await expect(authenticate(token)).resolves.toBeNull();
    });

    it('never matches an agent that has no credential', async () => {
      await pool.execute("INSERT INTO agents (id, name) VALUES (?, 'unpaired')", [randomUUID()]);
      await expect(databaseAgentAuthenticator(pool)('')).resolves.toBeNull();
    });
  });
});

describe('upgrading to VM-level publication (0008)', () => {
  let scratch: TestDatabase;
  let directory: string;
  let upgradePool: Pool;

  beforeAll(async () => {
    scratch = await createTestDatabase();
    directory = await mkdtemp(join(tmpdir(), 'emucat-migrations-'));
    const all = await loadMigrations();
    for (const migration of all.filter((item) => item.version < '0008')) {
      await writeFile(join(directory, `${migration.version}.sql`), migration.sql);
    }
    await migrate(scratch.options, directory);
    upgradePool = mysql.createPool(scratch.options);
  });

  afterAll(async () => {
    await upgradePool?.end();
    await scratch?.drop();
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps every legacy value, and lets the VM alone decide afterwards', async () => {
    const insertVm = (name: string, visibility: string) =>
      upgradePool.execute(
        "INSERT INTO virtual_machines (emulator_type, vm_name, visibility) VALUES ('qemu', ?, ?)",
        [name, visibility],
      );
    const insertMedia = async (vmName: string, visibility: string, isMain: boolean) => {
      const id = randomUUID();
      await upgradePool.execute(
        `INSERT INTO vm_media (id, emulator_type, vm_name, visibility, is_main, original_filename,
           original_sha256, original_size_bytes, jpeg_key, thumbnail_key, width_px, height_px)
         VALUES (?, 'qemu', ?, ?, ?, 'a.ppm', ?, 1, 'j', 't', 1, 1)`,
        [id, vmName, visibility, isMain, createHash('sha256').update(id).digest('hex')],
      );
      return id;
    };
    const card = async (vmName: string) => {
      const [rows] = await upgradePool.query<RowDataPacket[]>(
        'SELECT media_id FROM public_catalog_card_media WHERE vm_name = ?',
        [vmName],
      );
      return rows.map((row) => row.media_id as string);
    };

    await insertVm('LegacyPublic', 'public');
    await insertVm('LegacyPrivate', 'private');
    const privateMainOfPublicVm = await insertMedia('LegacyPublic', 'private', true);
    const publishedOfPublicVm = await insertMedia('LegacyPublic', 'published', false);
    const publishedMainOfPrivateVm = await insertMedia('LegacyPrivate', 'published', true);

    // Before: both had to agree.
    await expect(card('LegacyPublic')).resolves.toEqual([]);
    await expect(card('LegacyPrivate')).resolves.toEqual([]);

    const result = await migrate(scratch.options);
    expect(result.applied[0]).toBe('0008_vm_level_publication');

    // After: the VM decides, for the cover and for everything else.
    await expect(card('LegacyPublic')).resolves.toEqual([privateMainOfPublicVm]);
    await expect(card('LegacyPrivate')).resolves.toEqual([]);

    // Nothing was rewritten or lost.
    const [rows] = await upgradePool.query<RowDataPacket[]>(
      'SELECT id, visibility, is_main FROM vm_media ORDER BY id',
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, [row.visibility, row.is_main]]))).toEqual({
      [privateMainOfPublicVm]: ['private', 1],
      [publishedOfPublicVm]: ['published', 0],
      [publishedMainOfPrivateVm]: ['published', 1],
    });
    const [vms] = await upgradePool.query<RowDataPacket[]>(
      'SELECT vm_name, visibility FROM virtual_machines ORDER BY vm_name',
    );
    expect(vms.map((row) => [row.vm_name, row.visibility])).toEqual([
      ['LegacyPrivate', 'private'],
      ['LegacyPublic', 'public'],
    ]);

    // The column says what it has become.
    const [columns] = await upgradePool.query<RowDataPacket[]>(
      `SELECT COLUMN_COMMENT AS comment FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vm_media' AND COLUMN_NAME = 'visibility'`,
    );
    expect(columns[0]?.comment).toMatch(/Legacy, ignored/);

    // And it runs once.
    await expect(migrate(scratch.options)).resolves.toMatchObject({ applied: [] });
  });
});
