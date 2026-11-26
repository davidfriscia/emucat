import { defineConfig } from 'vitest/config';

/**
 * Test files run against a real MariaDB, each with its own database and a pool of up to 10 connections, plus a
 * connection or two for migrations and for creating and dropping the database. Vitest's default is one worker per
 * CPU but one, which on a 20-thread machine runs 19 files at once and exhausts MariaDB's default of 151
 * connections ("Too many connections", then timeouts).
 *
 * Every test creates its database and applies every migration, and that DDL serializes in MariaDB, so more workers
 * mostly make each test wait longer. Measured on the Windows workstation (Docker Desktop, WSL 2), the whole suite on an
 * otherwise idle MariaDB, 1,216 tests passing each time:
 *
 *   workers   wall     p95 per test   p99 per test   tests over 15 s
 *   4         1,281 s  14.5 s         16.7 s         50
 *   2         1,380 s   8.2 s         10.1 s          2
 *   1         1,616 s   4.7 s          6.5 s          1
 *
 * With 4, dozens of tests run within a factor of two of the 30 s test timeout, and a little more load (another suite,
 * a busy disk) made 9 of them time out in one run. 2 keeps every test well inside it for 7% more time, so it is the
 * Windows default. Linux keeps 4: the suite passed with 4 in a Linux container against the same MariaDB, and CI,
 * which runs on Linux with a database of its own, was not measured here.
 * `EMUCAT_API_TEST_WORKERS`, or `--maxWorkers`, overrides either. See docs/testing.md.
 */
const DEFAULT_WORKERS = process.platform === 'win32' ? 2 : 4;
const workers = Number(process.env.EMUCAT_API_TEST_WORKERS) || DEFAULT_WORKERS;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: workers,
  },
});
