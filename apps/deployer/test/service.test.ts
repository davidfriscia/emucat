import { readdirSync } from 'node:fs';
import {
  deploymentStatusSchema,
  updateLogResponseSchema,
  updateOperationSchema,
} from '@emucat/contracts';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveOperation, parseEvents } from '../src/operations.ts';
import { ServiceError } from '../src/service.ts';
import { createWorld, CURRENT, LATEST, TOKEN, type World } from './helpers.ts';

const worlds: World[] = [];
function world(...args: Parameters<typeof createWorld>): World {
  const created = createWorld(...args);
  worlds.push(created);
  return created;
}
afterEach(() => {
  while (worlds.length) worlds.pop()?.cleanup();
});

function ready(w: World) {
  w.setCurrent(CURRENT);
  w.setRemote(LATEST);
}

async function refusal(promise: Promise<unknown>): Promise<ServiceError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ServiceError);
  return error as ServiceError;
}

describe('starting an update', () => {
  it('starts the fixed command for the checked commit, and records the operation durably', async () => {
    const w = world();
    ready(w);
    const operation = await w.service.start({ expectedCommit: LATEST, requestedBy: 'admin' });
    expect(w.runner.started).toEqual([
      { operationId: operation.id, expectedCommit: LATEST, requestedBy: 'admin' },
    ]);
    expect(updateOperationSchema.parse(operation).status).toBe('running');
    expect(readdirSync(w.config.operationsDir)).toContain(`${operation.id}.json`);
  });

  it('is refused while updates are disabled, which is the default for production', async () => {
    const w = world({ updatesEnabled: false });
    ready(w);
    const error = await refusal(w.service.start({ expectedCommit: LATEST, requestedBy: 'admin' }));
    expect(error).toMatchObject({ status: 403, code: 'updates_disabled' });
    expect(w.runner.started).toEqual([]);
  });

  it.each([
    ['a branch name', 'main'],
    ['a short commit', LATEST.slice(0, 7)],
    ['an option', '--upload-pack=touch /tmp/x'],
    ['a ref expression', 'HEAD~1'],
    ['an uppercase commit', LATEST.toUpperCase()],
  ])('refuses %s as the expected commit', async (_label, expectedCommit) => {
    const w = world();
    ready(w);
    const error = await refusal(w.service.start({ expectedCommit, requestedBy: 'admin' }));
    expect(error.code).toBe('invalid_request');
    expect(w.runner.started).toEqual([]);
  });

  it('refuses an unusual requester name', async () => {
    const w = world();
    ready(w);
    const error = await refusal(
      w.service.start({ expectedCommit: LATEST, requestedBy: 'admin\nforged line' }),
    );
    expect(error.code).toBe('invalid_request');
  });

  it('refuses a commit other than the one last seen on the branch', async () => {
    const w = world();
    ready(w);
    const error = await refusal(
      w.service.start({ expectedCommit: 'c'.repeat(40), requestedBy: 'admin' }),
    );
    expect(error).toMatchObject({ status: 409, code: 'target_changed' });
  });

  it('refuses before any check, and when already up to date', async () => {
    const w = world();
    w.setCurrent(CURRENT);
    expect(
      (await refusal(w.service.start({ expectedCommit: LATEST, requestedBy: 'a' }))).code,
    ).toBe('not_checked');
    w.setRemote(CURRENT);
    expect(
      (await refusal(w.service.start({ expectedCommit: CURRENT, requestedBy: 'a' }))).code,
    ).toBe('already_current');
  });

  it('allows only one update at a time, even for simultaneous requests', async () => {
    const w = world();
    ready(w);
    const results = await Promise.allSettled([
      w.service.start({ expectedCommit: LATEST, requestedBy: 'one' }),
      w.service.start({ expectedCommit: LATEST, requestedBy: 'two' }),
      w.service.start({ expectedCommit: LATEST, requestedBy: 'three' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(w.runner.started).toHaveLength(1);
    const reasons = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    expect(reasons.every((reason) => reason.code === 'update_in_progress')).toBe(true);
  });

  it('refuses while the command line holds the deployment lock', async () => {
    const w = world();
    ready(w);
    w.runner.lock = true;
    const error = await refusal(w.service.start({ expectedCommit: LATEST, requestedBy: 'admin' }));
    expect(error.code).toBe('update_in_progress');
    expect((await refusal(w.service.check())).code).toBe('update_in_progress');
  });
});

describe('progress and outcome', () => {
  it('derives progress from the events the script writes', async () => {
    const w = world();
    ready(w);
    const { id } = await w.service.start({ expectedCommit: LATEST, requestedBy: 'admin' });
    w.event(id, 'from', CURRENT);
    w.event(id, 'stage', 'checking_repository');
    w.event(id, 'stage', 'fetching_source', 'branch develop');
    w.event(id, 'target', LATEST);
    w.event(id, 'stage', 'building');
    const operation = w.service.operation(id);
    expect(operation).toMatchObject({
      status: 'running',
      stage: 'building',
      fromCommit: CURRENT,
      targetCommit: LATEST,
    });
    expect(w.service.status().activeOperation?.id).toBe(id);
  });

  it('marks success only once the recorded release is the target and the application is ready', async () => {
    const w = world();
    ready(w);
    const { id } = await w.service.start({ expectedCommit: LATEST, requestedBy: 'admin' });
    w.event(id, 'target', LATEST);
    w.event(id, 'stage', 'completed');
    w.event(id, 'done', 'succeeded');
    // Finished, recorded, but not answering yet: still being verified.
    w.setCurrent(LATEST);
    w.runner.isHealthy = false;
    await w.service.reconcile();
    expect(w.service.operation(id)?.status).toBe('running');
    w.runner.isHealthy = true;
    await w.service.reconcile();
    const done = w.service.operation(id);
    expect(done?.status).toBe('succeeded');
    const status = deploymentStatusSchema.parse(w.service.status());
    expect(status.lastSuccess?.commit).toBe(LATEST);
    expect(status.activeOperation).toBeNull();
    expect(status.updateAvailable).toBe(false);
  });

  it('does not believe an exit status when the recorded release is not the target', async () => {
    const w = world();
    ready(w);
    const { id } = await w.service.start({ expectedCommit: LATEST, requestedBy: 'admin' });
    w.event(id, 'target', LATEST);
    w.event(id, 'stage', 'completed');
    w.event(id, 'done', 'succeeded');
    await w.service.reconcile();
    expect(w.service.operation(id)).toMatchObject({
      status: 'failed',
      error: { code: 'verification_failed' },
    });
  });

  it('fails verification when a "successful" deployment never becomes healthy', async () => {
    const w = world();
    ready(w);
    const { id } = await w.service.start({ expectedCommit: LATEST, requestedBy: 'admin' });
    w.event(id, 'target', LATEST);
    w.event(id, 'done', 'succeeded', '', new Date(Date.now() - 5 * 60_000).toISOString());
    w.setCurrent(LATEST);
    w.runner.isHealthy = false;
    await w.service.reconcile();
    const operation = w.service.operation(id);
    expect(operation).toMatchObject({ status: 'failed', error: { code: 'verification_failed' } });
  });

  it('reports a failed step with its reason and what happened to the application', async () => {
    const w = world();
    ready(w);
    const { id } = await w.service.start({ expectedCommit: LATEST, requestedBy: 'admin' });
    w.event(id, 'stage', 'applying_migrations');
    w.event(id, 'error', 'migration_failed', 'Database migrations failed. Restore x.sql.gz');
    w.event(id, 'rollback', 'unsafe');
    w.event(id, 'backup', 'emucat-db-20261101T110000Z-aaaaaaaaaaaa.sql.gz');
    w.event(id, 'stage', 'failed');
    w.event(id, 'done', 'failed');
    await w.service.reconcile();
    const operation = updateOperationSchema.parse(w.service.operation(id));
    expect(operation).toMatchObject({
      status: 'failed',
      stage: 'failed',
      rollback: 'unsafe',
      backup: 'emucat-db-20261101T110000Z-aaaaaaaaaaaa.sql.gz',
      error: { code: 'migration_failed' },
    });
    expect(w.service.status().lastFailure?.operationId).toBe(id);
  });

  it('reports an update whose process vanished as interrupted, not as running forever', async () => {
    const w = world();
    ready(w);
    const { id } = await w.service.start({ expectedCommit: LATEST, requestedBy: 'admin' });
    w.event(id, 'stage', 'building');
    w.runner.alive.clear();
    const operation = w.service.operation(id);
    expect(operation).toMatchObject({ status: 'failed', error: { code: 'interrupted' } });
    expect(operation?.error?.message).toMatch(/Nothing was changed in the database/);
    await w.service.reconcile();
    expect(w.service.operation(id)?.status).toBe('failed');
    expect(w.service.status().activeOperation).toBeNull();
  });

  it('warns that migrations may have run when interrupted after they started', () => {
    const events = parseEvents(
      ['t1\tstage\tbacking_up_database\t', 't2\tstage\tapplying_migrations\t'].join('\n'),
    );
    const operation = deriveOperation('018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7201', null, events, false);
    expect(operation.error?.message).toMatch(/migrations may have been applied/);
    expect(operation.rollback).toBe('unsafe');
  });

  it('survives a restart of the service: a new instance sees the same operations', async () => {
    const w = world();
    ready(w);
    const { id } = await w.service.start({ expectedCommit: LATEST, requestedBy: 'admin' });
    w.event(id, 'stage', 'building');
    const restarted = createWorld({ ...w.config });
    restarted.runner.alive = w.runner.alive;
    // Same directories: only the in-memory object is new.
    const service = new (
      w.service.constructor as typeof import('../src/service.ts').DeploymentService
    )({
      config: w.config,
      runner: restarted.runner,
      sanitize: (text) => text,
    });
    expect(service.operation(id)).toMatchObject({ status: 'running', stage: 'building' });
    restarted.cleanup();
  });

  it('shows updates started from the command line too', () => {
    const w = world();
    const id = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7202';
    w.event(id, 'requested', 'cli:david');
    w.event(id, 'target', LATEST);
    w.event(id, 'stage', 'completed');
    w.event(id, 'done', 'succeeded');
    expect(w.service.operation(id)).toMatchObject({
      status: 'succeeded',
      requestedBy: 'cli:david',
    });
  });
});

describe('logs and secrets', () => {
  it('removes secrets from the log before it leaves the host', async () => {
    const w = world();
    ready(w);
    const { id } = await w.service.start({ expectedCommit: LATEST, requestedBy: 'admin' });
    writeFileSync(
      w.service.store.logPath(id),
      [
        '==> fetching source',
        'remote: https://user:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x/emucat.git',
        'DB_PASSWORD=database-password-value',
        `token ${TOKEN}`,
        'Authorization: Bearer abc.def.ghi',
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'b3BlbnNzaC1rZXktdjEAAAAA',
        '-----END OPENSSH PRIVATE KEY-----',
        '\u001b[31mred\u001b[0m',
      ].join('\n'),
    );
    const log = updateLogResponseSchema.parse(w.service.log(id));
    const text = log.lines.join('\n');
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(text).not.toContain('user:');
    expect(text).not.toContain('database-password-value');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('abc.def.ghi');
    expect(text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
    expect(text).not.toContain('\u001b');
    expect(text).toContain('==> fetching source');
    expect(text).toContain('red');
  });

  it('has no log for an unknown or malformed operation', () => {
    const w = world();
    expect(w.service.log('../../etc/passwd')).toBeNull();
    expect(w.service.operation('018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7299')).toBeNull();
  });
});

describe('checking for updates', () => {
  it('reports the newest commit of the configured branch', async () => {
    const w = world();
    w.setCurrent(CURRENT);
    w.runner.onCheck = () => w.setRemote(LATEST, 'Add a feature');
    const status = deploymentStatusSchema.parse(await w.service.check());
    expect(status).toMatchObject({
      branch: 'develop',
      updateAvailable: true,
      latest: { commit: LATEST, subject: 'Add a feature' },
    });
  });

  it('reports no update when the branch is already deployed', async () => {
    const w = world();
    w.setCurrent(LATEST);
    w.runner.onCheck = () => w.setRemote(LATEST);
    expect((await w.service.check()).updateAvailable).toBe(false);
  });
});
