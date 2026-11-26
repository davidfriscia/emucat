/**
 * Staging diagnostics (assessment R7 and R8): a failing periodic cleanup is logged, without flooding the log, and
 * files in the staging area that EmuCat did not create are reported and left alone.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { afterEach, describe, expect, it } from 'vitest';
import { NO_REPOSITORY_ACCESS } from '../src/repository-access/ssh.js';
import { DEFAULT_TRANSFER_POLICY } from '../src/transfers/policy.js';
import { TransferService } from '../src/transfers/service.js';
import { StagingArea } from '../src/transfers/staging.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function recorder() {
  const lines: Array<{ level: string; object: Record<string, unknown>; message: string }> = [];
  const at = (level: string) => (object: Record<string, unknown>, message: string) =>
    void lines.push({ level, object, message });
  const log = {
    warn: at('warn'),
    info: at('info'),
    error: at('error'),
    debug: at('debug'),
    child: () => log,
  };
  return { lines, log: log as unknown as FastifyBaseLogger & typeof log };
}

async function stagingArea() {
  const root = await mkdtemp(join(tmpdir(), 'emucat-staging-'));
  directories.push(root);
  const staging = new StagingArea({ ...DEFAULT_TRANSFER_POLICY, stagingPath: root });
  await staging.prepare();
  return { root, staging };
}

const ACTIVE = '3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';

describe('Unexpected staging artifacts', () => {
  it('reports non-UUID files once, again only when they change, and never removes them', async () => {
    const { root, staging } = await stagingArea();
    const { lines, log } = recorder();
    await mkdir(join(root, 'transfers', ACTIVE));
    await writeFile(join(root, 'transfers', ACTIVE, 'part'), 'active transfer');
    await writeFile(join(root, 'transfers', 'notes.txt'), 'someone left this');
    await mkdir(join(root, 'clones', 'backup-old'));

    await staging.reportUnexpected(log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      object: { transfers: ['notes.txt'], clones: ['backup-old'], count: 2 },
    });
    await staging.reportUnexpected(log);
    expect(lines).toHaveLength(1);

    await writeFile(join(root, 'clones', 'stray.zip'), 'x');
    await staging.reportUnexpected(log);
    expect(lines).toHaveLength(2);

    // Nothing was deleted, and the active transfer is untouched.
    expect((await readdir(join(root, 'transfers'))).sort()).toEqual([ACTIVE, 'notes.txt'].sort());
    expect(await readdir(join(root, 'transfers', ACTIVE))).toEqual(['part']);
    expect((await readdir(join(root, 'clones'))).sort()).toEqual(['backup-old', 'stray.zip']);
    // Only UUID-named directories count as EmuCat's own.
    expect(await staging.present('transfers')).toEqual([ACTIVE]);

    await rm(join(root, 'transfers', 'notes.txt'));
    await rm(join(root, 'clones', 'backup-old'), { recursive: true });
    await rm(join(root, 'clones', 'stray.zip'));
    await staging.reportUnexpected(log);
    expect(lines.at(-1)).toMatchObject({ level: 'info' });
  });
});

describe('Staging cleanup failures', () => {
  it('logs a failing sweep at warning level, at most every 15 minutes, and its recovery', async () => {
    const { staging } = await stagingArea();
    const { lines, log } = recorder();
    let failing = true;
    let now = 1_000_000;
    const pool = {
      execute: async () => {
        if (failing)
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        return [[], []];
      },
    } as unknown as Pool;
    const service = new TransferService(
      pool,
      NO_REPOSITORY_ACCESS,
      staging,
      DEFAULT_TRANSFER_POLICY,
      log,
      () => now,
    );
    await service.sweepAndReport();
    await service.sweepAndReport();
    now += 14 * 60_000;
    await service.sweepAndReport();
    const warnings = () => lines.filter((line) => line.level === 'warn');
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatchObject({
      message: 'Staging cleanup failed; it will be tried again',
      object: { operation: 'transfer staging sweep', consecutiveFailures: 1 },
    });
    now += 2 * 60_000;
    await service.sweepAndReport();
    expect(warnings()).toHaveLength(2);
    expect(warnings()[1]?.object).toMatchObject({ consecutiveFailures: 4 });
    // No secrets: the database password is not anywhere in what was logged.
    expect(JSON.stringify(lines)).not.toMatch(/password/i);

    failing = false;
    await service.sweepAndReport();
    expect(lines.at(-1)).toMatchObject({ level: 'info', message: 'Staging cleanup works again' });
  });
});
