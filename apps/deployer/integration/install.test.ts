import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CTL, REPOSITORY } from './harness.ts';

/**
 * A fresh installation into the real /opt/emucat of a disposable Linux container: `init`, `install`, then
 * `check`, `update`, `backup` and `rollback-app` through the installed, root-owned tooling. Runs as root
 * only, in its own container (`pnpm test:deploy` starts it); docker, systemctl, curl and the MariaDB
 * clients are fakes. Elsewhere it is skipped.
 */

const ROOT = '/opt/emucat';
const CONFIG = `${ROOT}/config/deploy.env`;
const INSTALLED = `${ROOT}/tooling/bin/emucatctl`;
const FAKE = `${ROOT}/config/fake`;
const isRoot = process.getuid?.() === 0;

const env = {
  PATH: process.env.PATH,
  LANG: 'C.UTF-8',
  EMUCAT_DEPLOY_CONFIG: CONFIG,
};

function run(ctl: string, ...args: string[]) {
  return spawnSync(ctl, args, { env, encoding: 'utf8', timeout: 120_000 });
}

function id(flag: '-u' | '-g', name: string): number {
  return Number(execFileSync('id', [flag, name], { encoding: 'utf8' }).trim());
}
function gid(group: string): number {
  return Number(execFileSync('getent', ['group', group], { encoding: 'utf8' }).split(':')[2]);
}

function owner(path: string): { uid: number; gid: number; mode: number } {
  const stat = statSync(path);
  return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=EmuCat tests', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

/** Every path that earlier layouts used, or a default home might have created. */
const OUTSIDE = [
  '/etc/emucat',
  '/srv/emucat',
  '/var/backups/emucat',
  '/var/lib/emucat-deploy',
  '/home/emucat-deploy',
];

describe('fresh installation under /opt/emucat', { skip: !isRoot && 'needs root' }, () => {
  it('bootstraps, installs and operates the whole layout', () => {
    for (const path of [ROOT, ...OUTSIDE]) assert.equal(existsSync(path), false, path);
    const deploy = { uid: id('-u', 'emucat-deploy'), gid: id('-g', 'emucat-deploy') };
    const socket = gid('emucat-socket');

    // The remote: develop with the files a release needs.
    const dir = mkdtempSync(join(tmpdir(), 'emucat-install-'));
    chmodSync(dir, 0o755);
    const remote = join(dir, 'remote.git');
    const work = join(dir, 'work');
    git(dir, 'init', '--quiet', '--bare', remote);
    git(dir, 'init', '--quiet', '--initial-branch=develop', work);
    mkdirSync(join(work, 'deploy/docker'), { recursive: true });
    mkdirSync(join(work, 'apps/api/migrations'), { recursive: true });
    writeFileSync(
      join(work, 'deploy/compose.yaml'),
      readFileSync(join(REPOSITORY, 'deploy/compose.yaml')),
    );
    writeFileSync(join(work, 'deploy/docker/api.Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(work, 'deploy/docker/web.Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(work, 'apps/api/migrations/0001_initial_schema.sql'), 'SELECT 1;\n');
    const publish = (message: string) => {
      writeFileSync(join(work, 'CHANGES'), `${message}\n`);
      git(work, 'add', '.');
      git(work, 'commit', '--quiet', '-m', message);
      // Git refuses repositories owned by another user, so the remote changes hands around the push: it
      // belongs to the deployment account whenever emucatctl reads it.
      execFileSync('chown', ['-R', 'root:root', remote]);
      git(work, 'push', '--quiet', remote, 'develop');
      execFileSync('chown', ['-R', 'emucat-deploy:emucat-deploy', remote]);
      return git(work, 'rev-parse', 'HEAD');
    };
    const first = publish('First release');

    // 1. init: the layout and a starting configuration, nothing else.
    const init = run(CTL, 'init');
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /Before install:/);
    assert.match(init.stdout, /set EMUCAT_GIT_URL/);
    assert.match(init.stdout, /set DB_PASSWORD/);
    assert.match(init.stdout, /ssh-ed25519 /, 'prints the new deploy key');

    const expected: Record<string, [number, number, number]> = {
      [ROOT]: [0, 0, 0o755],
      [`${ROOT}/config`]: [0, deploy.gid, 0o750],
      [`${ROOT}/config/deploy.env`]: [0, deploy.gid, 0o640],
      [`${ROOT}/config/app.env`]: [0, deploy.gid, 0o640],
      [`${ROOT}/config/deployer.token`]: [0, socket, 0o640],
      [`${ROOT}/config/deploy_key`]: [deploy.uid, deploy.gid, 0o600],
      [`${ROOT}/repo.git`]: [deploy.uid, deploy.gid, 0o750],
      [`${ROOT}/releases`]: [deploy.uid, deploy.gid, 0o750],
      [`${ROOT}/state`]: [deploy.uid, deploy.gid, 0o750],
      [`${ROOT}/state/operations`]: [deploy.uid, deploy.gid, 0o750],
      [`${ROOT}/state/builds`]: [deploy.uid, deploy.gid, 0o750],
      [`${ROOT}/state/home`]: [deploy.uid, deploy.gid, 0o700],
      [`${ROOT}/data`]: [0, 0, 0o755],
      [`${ROOT}/data/media`]: [10001, 10001, 0o750],
      [`${ROOT}/backups`]: [deploy.uid, deploy.gid, 0o750],
    };
    const checkLayout = () => {
      for (const [path, [uid, group, mode]] of Object.entries(expected)) {
        assert.deepEqual(owner(path), { uid, gid: group, mode }, path);
      }
    };
    checkLayout();
    assert.equal(readFileSync(`${ROOT}/config/deployer.token`, 'utf8').length >= 32, true);
    assert.equal(existsSync(`${ROOT}/tooling`), false, 'tooling is written by install only');

    // 2. install refuses an unfinished configuration.
    let result = run(CTL, 'install');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EMUCAT_GIT_URL/);
    assert.match(result.stderr, /known_hosts/);

    // The administrator's edits.
    const config = readFileSync(CONFIG, 'utf8');
    assert.match(config, /^EMUCAT_BRANCH=develop$/m);
    assert.match(config, /^EMUCAT_BIND_ADDRESS=10\.0\.0\.2$/m);
    assert.match(config, /^EMUCAT_HTTP_PORT=8095$/m);
    assert.match(config, /^EMUCAT_PUBLIC_URL=https:\/\/emucat-test\.dfri\.info$/m);
    writeFileSync(CONFIG, config.replace(/^EMUCAT_GIT_URL=.*$/m, `EMUCAT_GIT_URL=${remote}`));
    const app = readFileSync(`${ROOT}/config/app.env`, 'utf8');
    writeFileSync(
      `${ROOT}/config/app.env`,
      app.replace(/^DB_PASSWORD=$/m, 'DB_PASSWORD=install-test-password-0123456789'),
    );
    writeFileSync(`${ROOT}/config/known_hosts`, 'github.com ssh-ed25519 AAAAtest\n');
    chmodSync(CONFIG, 0o644); // install puts it back
    mkdirSync(FAKE, { recursive: true });
    chmodSync(FAKE, 0o777);

    // 3. install: tooling, mirror, unit.
    result = run(CTL, 'install');
    assert.equal(result.status, 0, result.stderr);
    expected[`${ROOT}/config/known_hosts`] = [0, deploy.gid, 0o640];
    checkLayout();
    assert.deepEqual(owner(`${ROOT}/tooling`), { uid: 0, gid: 0, mode: 0o755 });
    assert.deepEqual(owner(INSTALLED), { uid: 0, gid: 0, mode: 0o755 });
    const walk = (path: string): void => {
      const stat = statSync(path);
      assert.equal(stat.uid, 0, path);
      assert.equal(stat.mode & 0o022, 0, `${path} is writable by others`);
      if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
    };
    walk(`${ROOT}/tooling`);
    assert.ok(existsSync(`${ROOT}/tooling/deployer/src/main.ts`));
    assert.ok(existsSync(`${ROOT}/repo.git/HEAD`));
    assert.equal(statSync(`${ROOT}/repo.git/HEAD`).uid, deploy.uid);

    const unit = readFileSync('/etc/systemd/system/emucat-deployer.service', 'utf8');
    assert.doesNotMatch(unit, /@[A-Z_]+@/);
    assert.match(unit, /^User=emucat-deploy$/m);
    assert.match(unit, /^Group=emucat-socket$/m);
    assert.match(unit, /^SupplementaryGroups=emucat-deploy$/m);
    assert.match(unit, /^Environment=EMUCAT_DEPLOY_CONFIG=\/opt\/emucat\/config\/deploy\.env$/m);
    assert.match(unit, /^Environment=HOME=\/opt\/emucat\/state\/home$/m);
    assert.match(unit, /^ExecStart=\S+node .* \/opt\/emucat\/tooling\/deployer\/src\/main\.ts$/m);
    assert.match(unit, /^RuntimeDirectory=emucat-deployer$/m);
    assert.match(
      unit,
      /^ReadWritePaths=\/opt\/emucat\/state \/opt\/emucat\/releases \/opt\/emucat\/repo\.git \/opt\/emucat\/backups$/m,
    );
    assert.doesNotMatch(unit, /\/etc\/emucat|\/srv\/emucat|\/var\/backups/);
    const calls = () => readFileSync(join(FAKE, 'calls'), 'utf8');
    assert.match(calls(), /systemctl enable --now emucat-deployer\.service/);

    // 4. check, through the installed tooling, as the deployment account. Only the socket of the (fake)
    // service is missing.
    result = run(INSTALLED, 'check');
    const failed = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('  FAIL'))
      .map((line) => line.replace(/^ {2}FAIL {2}/, ''));
    assert.deepEqual(failed, ['deployment service socket'], result.stdout + result.stderr);
    assert.match(result.stdout, /ok {4}\/opt\/emucat\/config is root-owned/);
    assert.match(result.stdout, /ok {4}tooling \/opt\/emucat\/tooling is root-owned/);
    assert.match(result.stdout, /ok {4}media directory owned by UID 10001/);

    // 5. update: the first release.
    result = run(INSTALLED, 'update', '--yes');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const current = () => JSON.parse(readFileSync(`${ROOT}/state/current-release.json`, 'utf8'));
    assert.equal(current().commit, first);
    assert.equal(statSync(`${ROOT}/state/current-release.json`).uid, deploy.uid);
    assert.ok(existsSync(`${ROOT}/releases/${first}/compose.yaml`));

    // 6. backup.
    writeFileSync(join(FAKE, 'applied'), '0001_initial_schema\n');
    result = run(INSTALLED, 'backup');
    assert.equal(result.status, 0, result.stderr);
    const dumps = readdirSync(`${ROOT}/backups`).filter((file) => file.endsWith('-manual.sql.gz'));
    assert.equal(dumps.length, 1);
    assert.deepEqual(owner(`${ROOT}/backups/${dumps[0]}`), {
      uid: deploy.uid,
      gid: deploy.gid,
      mode: 0o640,
    });

    // 7. A second release, then rollback-app to the first.
    const second = publish('Second release');
    result = run(INSTALLED, 'update', '--yes');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual([current().commit, current().previous], [second, first]);
    assert.ok(
      readdirSync(`${ROOT}/backups`).some((file) => file.endsWith(`-${first.slice(0, 12)}.sql.gz`)),
    );
    result = run(INSTALLED, 'rollback-app', '--yes');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(current().commit, first);

    // Compose was only ever given paths under /opt/emucat.
    for (const line of readFileSync(join(FAKE, 'compose-env'), 'utf8').trim().split('\n')) {
      assert.equal(
        line,
        'EMUCAT_APP_ENV_FILE=/opt/emucat/config/app.env ' +
          'EMUCAT_DEPLOYER_TOKEN_FILE=/opt/emucat/config/deployer.token ' +
          'EMUCAT_MEDIA_DIR=/opt/emucat/data/media EMUCAT_SOCKET_DIR=/run/emucat-deployer',
      );
    }

    // 8. init and install again: nothing edited is replaced, the layout stays as it was.
    result = run(CTL, 'init');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Keeping the existing/);
    assert.match(result.stdout, /The configuration is complete/);
    assert.match(readFileSync(CONFIG, 'utf8'), new RegExp(`^EMUCAT_GIT_URL=${remote}$`, 'm'));
    result = run(CTL, 'install');
    assert.equal(result.status, 0, result.stderr);
    checkLayout();
    assert.equal(current().commit, first);

    for (const path of OUTSIDE) assert.equal(existsSync(path), false, path);
  });
});
