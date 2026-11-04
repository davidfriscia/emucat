import type { ReadyResponse } from '@emucat/contracts';
import type { Pool } from 'mysql2/promise';
import { pendingMigrations, type Migration } from './db/migrate.js';

export type ReadinessCheck = () => Promise<ReadyResponse['checks']>;

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Readiness check timed out')), CHECK_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Checks that MariaDB answers and that the schema is what this build of the API expects. */
export function databaseReadiness(
  pool: Pool,
  migrations: Migration[],
  onError: (error: unknown) => void,
): ReadinessCheck {
  return async () => {
    try {
      await withTimeout(pool.query('SELECT 1'));
    } catch (error) {
      onError(error);
      return { database: 'failed', migrations: 'skipped' };
    }
    try {
      const pending = await withTimeout(pendingMigrations((sql) => pool.query(sql), migrations));
      return { database: 'ok', migrations: pending.length === 0 ? 'ok' : 'failed' };
    } catch (error) {
      onError(error);
      return { database: 'ok', migrations: 'failed' };
    }
  };
}
