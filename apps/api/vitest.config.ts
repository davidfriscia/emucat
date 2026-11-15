import { defineConfig } from 'vitest/config';

/**
 * Test files run against a real MariaDB, each with its own database and a pool of up to 10 connections, plus a
 * connection or two for migrations and for creating and dropping the database. Vitest's default is one worker per
 * CPU but one, which on a 20-thread machine runs 19 files at once and exhausts MariaDB's default of 151
 * connections ("Too many connections", then timeouts). Four workers stay well below that with room for a running
 * development API. `EMUCAT_API_TEST_WORKERS`, or `--maxWorkers`, overrides it.
 */
const DEFAULT_WORKERS = 4;
const workers = Number(process.env.EMUCAT_API_TEST_WORKERS) || DEFAULT_WORKERS;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: workers,
  },
});
