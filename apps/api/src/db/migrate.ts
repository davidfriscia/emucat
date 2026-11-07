import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql, { type Connection, type PoolOptions, type RowDataPacket } from 'mysql2/promise';

export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LOCK_PREFIX = 'emucat_schema_migrations';
const LOCK_TIMEOUT_SECONDS = 30;

export interface Migration {
  version: string;
  checksum: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

export async function loadMigrations(directory = MIGRATIONS_DIRECTORY): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    if (!MIGRATION_FILE.test(file)) {
      throw new MigrationError(`Migration file name is not valid: ${file}`);
    }
    // Line endings are normalized so that a checkout's settings cannot change the checksum.
    const sql = (await readFile(join(directory, file), 'utf8')).replaceAll('\r\n', '\n');
    migrations.push({
      version: file.replace(/\.sql$/, ''),
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
    });
  }
  return migrations;
}

interface AppliedRow extends RowDataPacket {
  version: string;
  checksum: string;
  finished_at: Date | null;
}

async function ensureHistoryTable(connection: Connection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      finished_at DATETIME(3) NULL
    ) ENGINE=InnoDB
  `);
}

/** Fails if the database does not match the migration files, or a past run did not finish. */
function verifyHistory(applied: AppliedRow[], migrations: Migration[]): void {
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    if (row.finished_at === null) {
      throw new MigrationError(
        `Migration ${row.version} did not finish. MariaDB cannot roll back DDL, so the schema may ` +
          'be partially changed. Restore a backup, or reset a development database.',
      );
    }
    const migration = byVersion.get(row.version);
    if (!migration) {
      throw new MigrationError(`Database has unknown migration ${row.version}`);
    }
    if (migration.checksum !== row.checksum) {
      throw new MigrationError(`Migration ${row.version} changed after it was applied`);
    }
  }
}

/**
 * `GET_LOCK` names are global to the server, while migrations belong to one database. So the name
 * carries the database: runs against the same database wait for each other, and runs against
 * different databases on one server have nothing to wait for.
 */
export function migrationLockName(database: string): string {
  return `${LOCK_PREFIX}.${database}`;
}

async function selectedDatabase(connection: Connection): Promise<string> {
  const [rows] = await connection.query<RowDataPacket[]>('SELECT DATABASE() AS name');
  const database = rows[0]?.name as string | null | undefined;
  if (!database) {
    throw new MigrationError('Migrations need a database to be selected');
  }
  return database;
}

/**
 * Applies pending migrations in order. A lock serializes concurrent runs against a database.
 * Migrations are forward-only: applied files must not be edited, and changes go in a new file.
 */
export async function migrate(
  options: PoolOptions,
  directory = MIGRATIONS_DIRECTORY,
): Promise<MigrationResult> {
  const migrations = await loadMigrations(directory);
  // Multiple statements are enabled only on this dedicated connection, never on the API pool.
  const connection = await mysql.createConnection({ ...options, multipleStatements: true });
  try {
    await connection.query("SET time_zone = '+00:00'");
    const lockName = migrationLockName(await selectedDatabase(connection));
    const [lock] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [
      lockName,
      LOCK_TIMEOUT_SECONDS,
    ]);
    if (lock[0]?.acquired !== 1) {
      throw new MigrationError('Another migration run is in progress');
    }
    try {
      await ensureHistoryTable(connection);
      const [applied] = await connection.query<AppliedRow[]>(
        'SELECT version, checksum, finished_at FROM schema_migrations',
      );
      verifyHistory(applied, migrations);

      const done = new Set(applied.map((row) => row.version));
      const result: MigrationResult = { applied: [], alreadyApplied: [...done].sort() };
      for (const migration of migrations) {
        if (done.has(migration.version)) continue;
        await connection.execute(
          'INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)',
          [migration.version, migration.checksum],
        );
        await connection.query(migration.sql);
        await connection.execute(
          'UPDATE schema_migrations SET finished_at = CURRENT_TIMESTAMP(3) WHERE version = ?',
          [migration.version],
        );
        result.applied.push(migration.version);
      }
      return result;
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
    }
  } finally {
    await connection.end();
  }
}

/** Versions in the migration files that have not finished applying to this database. */
export async function pendingMigrations(
  query: (sql: string) => Promise<unknown>,
  migrations: Migration[],
): Promise<string[]> {
  const [rows] = (await query(
    'SELECT version FROM schema_migrations WHERE finished_at IS NOT NULL',
  )) as [{ version: string }[], unknown];
  const done = new Set(rows.map((row) => row.version));
  return migrations.map((migration) => migration.version).filter((version) => !done.has(version));
}
