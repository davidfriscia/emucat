import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { after, afterEach, describe, it } from 'node:test';
import { deriveOperation } from '../src/operations.ts';
import { createHost, CTL, DB_PASSWORD, lastValue, type Host } from './harness.ts';

/**
 * emucatctl against a disposable host. Real bash, Git and flock; fake docker, mariadb and curl. Run in
 * Linux only, by `pnpm test:deploy`.
 */

const hosts: Host[] = [];
function host(): Host {
  const created = createHost();
  hosts.push(created);
  return created;
}
afterEach(() => {
  // Whatever happened, existing data is untouched and nothing destructive was ever called.
  for (const h of hosts) {
    assert.equal(readFileSync(join(h.media, 'existing-screenshot.jpg'), 'utf8'), 'precious');
    assert.equal(
      readFileSync(join(h.backups, 'manual-dump-before-install.sql.gz'), 'utf8'),
      'older backup',
    );
    for (const call of h.calls()) {
      assert.doesNotMatch(
        call,
        /\bdown\b|--volumes|\bvolume\b|\bprune\b|DROP DATABASE|\bsystem\b/,
        call,
      );
      assert.doesNotMatch(call, new RegExp(DB_PASSWORD), 'a password reached a command line');
    }
  }
});
after(() => {
  for (const h of hosts) h.cleanup();
});

function develop(h: Host): string {
  return spawnSync('git', ['-C', h.remote, 'rev-parse', 'refs/heads/develop'], {
    encoding: 'utf8',
  }).stdout.trim();
}

function update(h: Host, ...args: string[]) {
  const result = h.run('update', '--yes', ...args);
  const { id, events } = h.latestOperation();
  return { result, id, events, error: lastValue(events, 'error'), done: lastValue(events, 'done') };
}

const builds = (h: Host) => h.calls().filter((call) => call.startsWith('docker build'));

describe('update', () => {
  it('deploys the tip of the configured branch, never another branch', () => {
    const h = host();
    const target = develop(h);
    const { result, events, done } = update(h);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(done, 'succeeded');
    assert.equal(lastValue(events, 'target'), target);
    assert.equal(h.current()?.commit, target);
    assert.equal(h.running(), target);
    assert.ok(h.images().includes(`emucat-api:${target}`));
    assert.ok(h.images().includes(`emucat-web:${target}`));
    assert.ok(builds(h).some((call) => call.includes(`EMUCAT_COMMIT=${target}`)));
    // Stages in order, ending in completed.
    const stages = events.filter((event) => event.key === 'stage').map((event) => event.value);
    assert.deepEqual(stages, [
      'checking_repository',
      'fetching_source',
      'building',
      'testing',
      'backing_up_database',
      'applying_migrations',
      'starting_services',
      'health_checking',
      'completed',
    ]);

    // A commit on main is invisible to a develop host.
    h.commit('main', 'Production-only change');
    const check = h.run('check-update', '--json');
    assert.equal(check.status, 0, check.stderr);
    assert.equal(JSON.parse(check.stdout).updateAvailable, false);
    assert.equal(JSON.parse(check.stdout).remote.commit, target);
  });

  it('does nothing when the deployed release is current and healthy', () => {
    const h = host();
    assert.equal(update(h).done, 'succeeded');
    const before = builds(h).length;
    const second = update(h);
    assert.equal(second.result.status, 0);
    assert.equal(lastValue(second.events, 'outcome'), 'up_to_date');
    assert.equal(builds(h).length, before);
  });

  it('backs up before migrating and keeps the previous images', () => {
    const h = host();
    const first = develop(h);
    update(h);
    const second = h.commit('develop', 'Add a column', '0002_next');
    h.setFake('applied', '0001_initial_schema\n');
    h.setFake('migrations_applied', '1');
    const before = h.calls().length;
    const { result, events } = update(h);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(h.current(), { ...h.current(), commit: second, previous: first });
    const backup = lastValue(events, 'backup');
    assert.match(backup ?? '', /^emucat-db-\d{8}T\d{9}Z-[0-9a-f]{12}\.sql\.gz$/);
    const dump = gunzipSync(readFileSync(join(h.backups, backup as string))).toString();
    assert.match(dump, /-- Dump completed/);
    // Order within this update: back up, then migrate, then start.
    const calls = h.calls().slice(before);
    const dumpAt = calls.findIndex((c) => c.startsWith('mariadb-dump'));
    const migrateAt = calls.findIndex((c) => /compose .*run .*migrate-cli/.test(c));
    const upAt = calls.findIndex((c) => / up /.test(c));
    assert.ok(dumpAt >= 0 && dumpAt < migrateAt && migrateAt < upAt, calls.join('\n'));
    assert.ok(h.images().includes(`emucat-api:${first}`), 'previous images are kept for rollback');
    assert.equal(readdirSync(h.backups).filter((file) => file.endsWith('.partial')).length, 0);
  });

  it('refuses when the branch moved since the administrator checked it', () => {
    const h = host();
    const seen = develop(h);
    h.commit('develop', 'Pushed meanwhile');
    const { result, error } = update(h, '--expect', seen);
    assert.equal(result.status, 1);
    assert.equal(error, 'target_changed');
    assert.equal(builds(h).length, 0);
    assert.equal(h.current(), null);
  });

  it('accepts only a full commit as --expect', () => {
    const h = host();
    for (const value of ['main', 'HEAD', develop(h).slice(0, 12), '--force']) {
      const result = h.run('update', '--yes', '--expect', value);
      assert.equal(result.status, 1, value);
      assert.match(result.stderr, /full lowercase commit/);
    }
    assert.equal(builds(h).length, 0);
  });

  it('refuses to run while another update holds the lock', async () => {
    const h = host();
    const holder = spawn('flock', [join(h.root, 'state/deploy.lock'), 'sleep', '5']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const { result, error } = update(h);
      assert.equal(result.status, 75);
      assert.equal(error, 'update_in_progress');
      assert.equal(builds(h).length, 0);
    } finally {
      holder.kill();
    }
  });

  it('stops cleanly when the repository cannot be fetched', () => {
    const h = host();
    h.writeConfig({ EMUCAT_GIT_URL: join(h.dir, 'does-not-exist.git') });
    const { result, error, events } = update(h);
    assert.equal(result.status, 1);
    assert.equal(error, 'fetch_failed');
    assert.equal(lastValue(events, 'rollback'), 'not_needed');
    assert.equal(builds(h).length, 0);
  });

  for (const [fail, code] of [
    ['build', 'build_failed'],
    ['verify', 'test_failed'],
  ] as const) {
    it(`stops before touching the database when ${fail} fails`, () => {
      const h = host();
      update(h);
      const running = h.running();
      h.commit('develop', 'Broken change');
      h.setFake('fail', fail);
      const { result, error, events } = update(h);
      assert.equal(result.status, 1);
      assert.equal(error, code);
      assert.equal(lastValue(events, 'rollback'), 'not_needed');
      assert.equal(h.running(), running);
      const after = h.calls().slice(h.calls().findLastIndex((c) => c.includes('--target runtime')));
      assert.ok(!after.some((c) => c.startsWith('mariadb-dump') || / up | run /.test(c)));
    });
  }

  it('stops before migrating when the backup fails, leaving no partial file', () => {
    const h = host();
    update(h);
    const running = h.running();
    h.commit('develop', 'Needs a backup');
    h.setFake('applied', '0001_initial_schema\n');
    h.setFake('fail', 'backup');
    const { result, error } = update(h);
    assert.equal(result.status, 1);
    assert.equal(error, 'backup_failed');
    assert.deepEqual(readdirSync(h.backups), ['manual-dump-before-install.sql.gz']);
    assert.ok(!h.calls().some((c) => /migrate-cli/.test(c) && c.includes(develop(h))));
    assert.equal(h.running(), running);
  });

  it('reports a failed migration as unsafe to roll back, and keeps the old containers', () => {
    const h = host();
    update(h);
    const running = h.running();
    h.commit('develop', 'Bad migration', '0002_bad');
    h.setFake('applied', '0001_initial_schema\n');
    h.setFake('fail', 'migrate');
    const { result, error, events } = update(h);
    assert.equal(result.status, 1);
    assert.equal(error, 'migration_failed');
    assert.equal(lastValue(events, 'rollback'), 'unsafe');
    assert.ok(lastValue(events, 'backup'));
    assert.equal(h.running(), running);
    assert.equal(h.current()?.commit, running);
  });

  it('restores the previous release when health checks fail and no migration ran', () => {
    const h = host();
    update(h);
    const previous = h.running();
    const next = h.commit('develop', 'Crashes at start');
    h.setFake('applied', '0001_initial_schema\n');
    h.setFake('unhealthy', next);
    const { result, error, events } = update(h);
    assert.equal(result.status, 1);
    assert.equal(error, 'health_check_failed');
    assert.equal(lastValue(events, 'rollback'), 'restored_previous');
    assert.equal(h.running(), previous);
    assert.equal(h.current()?.commit, previous, 'a failed release is never recorded');
  });

  it('does not restore the previous release over migrated data', () => {
    const h = host();
    update(h);
    const next = h.commit('develop', 'Migrates then crashes', '0002_next');
    h.setFake('applied', '0001_initial_schema\n');
    h.setFake('migrations_applied', '1');
    h.setFake('unhealthy', next);
    const { error, events } = update(h);
    assert.equal(error, 'health_check_failed');
    assert.equal(lastValue(events, 'rollback'), 'unsafe');
    assert.equal(h.running(), next);
  });

  it('recovers from an interrupted deployment', async () => {
    const h = host();
    update(h);
    const previous = h.current()?.commit;
    const next = h.commit('develop', 'Slow build');
    h.setFake('applied', '0001_initial_schema\n');
    h.setFake('build_sleep', '30');
    const earlier = new Set(h.operations());
    const child = spawn(CTL, ['update', '--yes'], { env: h.env, detached: true, stdio: 'ignore' });
    const deadline = Date.now() + 15_000;
    let id = '';
    while (Date.now() < deadline && !id) {
      for (const candidate of h.operations().filter((op) => !earlier.has(op))) {
        if (h.events(candidate).some((e) => e.key === 'stage' && e.value === 'building')) {
          id = candidate;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(id, 'the update reached the build');
    // A power cut, an OOM kill: no trap runs.
    process.kill(-(child.pid as number), 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const events = h.events(id);
    assert.equal(lastValue(events, 'done'), undefined);
    const derived = deriveOperation(id, null, events, false);
    assert.equal(derived.status, 'failed');
    assert.equal(derived.error?.code, 'interrupted');
    assert.equal(h.current()?.commit, previous, 'the release record is unchanged');

    // The lock died with the process, and the next update completes.
    h.setFake('build_sleep', null);
    const retry = update(h);
    assert.equal(retry.result.status, 0, retry.result.stderr);
    assert.equal(h.current()?.commit, next);
  });

  it('keeps every backup by default, and prunes only with an explicit retention count', () => {
    const h = host();
    update(h);
    h.setFake('applied', '0001_initial_schema\n');
    for (let i = 0; i < 3; i++) assert.equal(h.run('backup').status, 0);
    assert.equal(readdirSync(h.backups).length, 4);
    h.writeConfig({ EMUCAT_BACKUP_RETENTION_COUNT: '2' });
    assert.equal(h.run('backup').status, 0);
    // Only emucatctl's own dumps are counted and pruned; any other file stays (checked after each test).
    const own = readdirSync(h.backups).filter((file) => file.startsWith('emucat-db-'));
    assert.equal(own.length, 2);
  });
});

describe('rollback-app', () => {
  it('refuses when the database has migrations the older release does not know', () => {
    const h = host();
    update(h);
    h.commit('develop', 'With migration', '0002_next');
    h.setFake('applied', '0001_initial_schema\n');
    update(h);
    h.setFake('applied', '0001_initial_schema\n0002_next\n');
    const result = h.run('rollback-app', '--yes');
    assert.equal(result.status, 3);
    assert.match(result.stderr, /unsafe/);
  });

  it('runs the previous release again when the schema allows it', () => {
    const h = host();
    update(h);
    const first = h.current()?.commit;
    h.commit('develop', 'No migration');
    h.setFake('applied', '0001_initial_schema\n');
    update(h);
    const result = h.run('rollback-app', '--yes');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(h.running(), first);
    assert.equal(h.current()?.commit, first);
  });

  it('accepts only releases deployed on this host', () => {
    const h = host();
    update(h);
    h.setFake('applied', '0001_initial_schema\n');
    for (const value of ['main', 'f'.repeat(40)]) {
      const result = h.run('rollback-app', '--yes', '--to', value);
      assert.equal(result.status, 1, value);
    }
  });
});

describe('configuration', () => {
  it('rejects a branch that looks like an option or a ref expression', () => {
    const h = host();
    for (const branch of ['--upload-pack=x', 'develop~1', 'develop..main', '@{-1}']) {
      h.writeConfig({ EMUCAT_BRANCH: branch });
      const result = h.run('status');
      assert.equal(result.status, 1, branch);
    }
  });

  it('never evaluates configuration values', () => {
    const h = host();
    const marker = join(h.dir, 'pwned');
    h.writeConfig({ EMUCAT_ENVIRONMENT: `$(touch ${marker})` });
    assert.equal(h.run('status').status, 1);
    writeFileSync(
      join(h.configDir, 'app.env'),
      `DB_NAME=emucat-db\nDB_USER=emucat-usr\nDB_PASSWORD=$(touch ${marker})\n`,
    );
    h.writeConfig();
    h.run('backup');
    assert.equal(existsSync(marker), false);
  });

  it('refuses the MariaDB root account for the application', () => {
    const h = host();
    writeFileSync(join(h.configDir, 'app.env'), 'DB_NAME=emucat-db\nDB_USER=root\nDB_PASSWORD=x\n');
    const result = h.run('backup');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /root account/);
  });
});

describe('layout', () => {
  it('keeps releases, state, backups and every path given to Compose under EMUCAT_ROOT', () => {
    const h = host();
    const first = develop(h);
    assert.equal(update(h).done, 'succeeded');
    h.setFake('applied', '0001_initial_schema\n');
    assert.equal(h.run('backup').status, 0);
    const second = h.commit('develop', 'Second release');
    assert.equal(update(h).done, 'succeeded');
    const rollback = h.run('rollback-app', '--yes');
    assert.equal(rollback.status, 0, rollback.stderr);

    for (const commit of [first, second]) {
      assert.ok(existsSync(join(h.root, `releases/${commit}/compose.yaml`)));
      assert.ok(existsSync(join(h.root, `releases/${commit}/migrations.txt`)));
    }
    assert.ok(existsSync(join(h.root, 'releases/history.tsv')));
    assert.ok(existsSync(join(h.root, 'state/current-release.json')));
    // Build exports are temporary and removed after a successful update.
    assert.deepEqual(readdirSync(join(h.root, 'state/builds')), []);
    assert.ok(readdirSync(h.backups).some((file) => /^emucat-db-.*-manual\.sql\.gz$/.test(file)));

    // What Compose was given, for every update and the rollback.
    const environments = readFileSync(join(h.fake, 'compose-env'), 'utf8').trim().split('\n');
    assert.ok(environments.length >= 3);
    for (const line of environments) {
      assert.equal(
        line,
        [
          `EMUCAT_APP_ENV_FILE=${join(h.root, 'config/app.env')}`,
          `EMUCAT_DEPLOYER_TOKEN_FILE=${join(h.root, 'config/deployer.token')}`,
          `EMUCAT_MEDIA_DIR=${join(h.root, 'data/media')}`,
          `EMUCAT_SOCKET_DIR=${h.socketDir}`,
        ].join(' '),
      );
    }
  });

  for (const line of [
    'EMUCAT_APP_ENV_FILE=/etc/emucat/app.env',
    'EMUCAT_DEPLOYER_TOKEN_FILE=/etc/emucat/deployer.token',
    'EMUCAT_MEDIA_DIR=/srv/emucat/media',
    'EMUCAT_BACKUP_DIR=/var/backups/emucat',
  ]) {
    it(`refuses the old path setting ${line}`, () => {
      const h = host();
      const [key, value] = line.split('=') as [string, string];
      h.writeConfig({ [key]: value });
      for (const command of ['status', 'backup', 'update']) {
        const result = h.run(command, '--yes');
        assert.equal(result.status, 1, command);
        assert.match(result.stderr, /no longer supported/);
      }
      assert.equal(builds(h).length, 0);
    });
  }

  it('refuses a configuration file that is not EMUCAT_ROOT/config/deploy.env', () => {
    const h = host();
    h.writeConfig({ EMUCAT_ROOT: join(h.dir, 'elsewhere') });
    const result = h.run('status');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be .*elsewhere\/config\/deploy\.env/);
  });

  it('refuses init and install without root', () => {
    const h = host();
    for (const command of ['init', 'install']) {
      const result = h.run(command);
      assert.equal(result.status, 1, command);
      assert.match(result.stderr, /must run as root/);
    }
  });
});
