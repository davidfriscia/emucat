import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
 *
 * The deployment service itself is real: the compiled artifact that deploy/test/integration.sh built from
 * deploy/docker/deployer.Dockerfile with the real Docker, which the fake docker hands to `install`. The
 * fake systemctl starts it from the installed unit, with the unit's identity and with Node's TypeScript
 * support switched off, as on a Node.js built without it.
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
  EMUCAT_TEST_DEPLOYER_ARTIFACT: process.env.EMUCAT_TEST_DEPLOYER_ARTIFACT,
};
const UNIT = '/etc/systemd/system/emucat-deployer.service';
const SOCKET = '/run/emucat-deployer/deployer.sock';

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

/** The process the (fake) systemd started for the unit, as the kernel sees it. */
function serviceProcess(): {
  pid: number;
  uid: number;
  gid: number;
  groups: number[];
  cmdline: string[];
} {
  const pid = Number(readFileSync(join(FAKE, 'deployer.pid'), 'utf8').trim());
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const field = (name: string) =>
    (new RegExp(`^${name}:(.*)$`, 'm').exec(status)?.[1] ?? '').trim();
  return {
    pid,
    uid: Number(field('Uid').split(/\s+/)[0]),
    gid: Number(field('Gid').split(/\s+/)[0]),
    groups: field('Groups')
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b),
    cmdline: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
  };
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function systemctl(...args: string[]) {
  return spawnSync('systemctl', args, { env, encoding: 'utf8' });
}
const serviceLog = () => readFileSync(join(FAKE, 'deployer.log'), 'utf8');
const sortNumbers = (values: number[]) => [...values].sort((a, b) => a - b);

const CLIENT = `
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
const [tokenPath, socketPath, given] = process.argv.slice(1);
let token = given;
if (!token) {
  try { token = readFileSync(tokenPath, 'utf8').trim(); }
  catch (error) { console.log('token:' + error.code); process.exit(0); }
}
const req = request({ socketPath, path: '/v1/status', headers: { authorization: 'Bearer ' + token } },
  (response) => { console.log('status:' + response.statusCode); response.resume(); });
req.on('error', (error) => console.log('socket:' + error.code));
req.end();
`;

/** Asks the deployment service for its status as [uid, gid, ...supplementary groups], as the API does. */
function asApi([uid, group, ...groups]: number[], tokenPath: string, token = ''): string {
  return execFileSync(
    'setpriv',
    [
      `--reuid=${uid}`,
      `--regid=${group}`,
      groups.length > 0 ? `--groups=${groups.join(',')}` : '--clear-groups',
      process.execPath,
      '--input-type=module',
      '-e',
      CLIENT,
      tokenPath,
      '/run/emucat-deployer/deployer.sock',
      token,
    ],
    { encoding: 'utf8', timeout: 30_000 },
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
  it('cannot run the TypeScript sources on a Node.js without TypeScript support (the MARS failure)', () => {
    const result = spawnSync(
      process.execPath,
      ['--no-experimental-strip-types', join(REPOSITORY, 'apps/deployer/src/main.ts')],
      { encoding: 'utf8', env: { PATH: process.env.PATH, EMUCAT_DEPLOY_CONFIG: '/nonexistent' } },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ERR_UNKNOWN_FILE_EXTENSION/);
    assert.ok(
      process.env.EMUCAT_TEST_DEPLOYER_ARTIFACT,
      'integration.sh provides the built artifact',
    );
  });

  it('bootstraps, installs and operates the whole layout', () => {
    try {
      installAndOperate();
    } finally {
      systemctl('stop', 'emucat-deployer.service');
    }
  });

  function installAndOperate() {
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
      [`${ROOT}/data/media`]: [1000, 1000, 0o750],
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

    // 3. install: tooling, mirror, unit, and the service started and answering.
    result = run(CTL, 'install');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Building the deployment service/);
    assert.match(result.stdout, /The deployment service answers\./);
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
    // The compiled service only: no sources, no TypeScript, no node_modules.
    assert.deepEqual(readdirSync(`${ROOT}/tooling/deployer`).sort(), [
      'config.js',
      'envfile.js',
      'http.js',
      'main.js',
      'operations.js',
      'package.json',
      'runner.js',
      'sanitize.js',
      'service.js',
    ]);
    assert.equal(
      JSON.parse(readFileSync(`${ROOT}/tooling/deployer/package.json`, 'utf8')).type,
      'module',
    );
    assert.ok(existsSync(`${ROOT}/repo.git/HEAD`));
    assert.equal(statSync(`${ROOT}/repo.git/HEAD`).uid, deploy.uid);

    const unit = readFileSync(UNIT, 'utf8');
    assert.doesNotMatch(unit, /@[A-Z_]+@/);
    assert.match(unit, /^User=emucat-deploy$/m);
    assert.match(unit, /^Group=emucat-socket$/m);
    assert.match(unit, /^SupplementaryGroups=emucat-deploy$/m);
    assert.match(unit, /^Environment=EMUCAT_DEPLOY_CONFIG=\/opt\/emucat\/config\/deploy\.env$/m);
    assert.match(unit, /^Environment=HOME=\/opt\/emucat\/state\/home$/m);
    assert.match(unit, /^ExecStart=\/\S+\/node \/opt\/emucat\/tooling\/deployer\/main\.js$/m);
    assert.doesNotMatch(unit, /\.ts\b|strip-types|ExperimentalWarning/);
    assert.match(unit, /^RuntimeDirectory=emucat-deployer$/m);
    assert.match(
      unit,
      /^ReadWritePaths=\/opt\/emucat\/state \/opt\/emucat\/releases \/opt\/emucat\/repo\.git \/opt\/emucat\/backups$/m,
    );
    assert.doesNotMatch(unit, /\/etc\/emucat|\/srv\/emucat|\/var\/backups/);
    const calls = () => readFileSync(join(FAKE, 'calls'), 'utf8');
    assert.match(
      calls(),
      /systemctl daemon-reload\nsystemctl enable emucat-deployer\.service\nsystemctl reset-failed emucat-deployer\.service\nsystemctl restart emucat-deployer\.service\n/,
    );

    // 3b. The running service: the unit's identity, the compiled entry point, its socket.
    const service = serviceProcess();
    assert.equal(service.uid, deploy.uid);
    assert.equal(service.gid, socket);
    assert.deepEqual(service.groups, sortNumbers([deploy.gid, socket, gid('docker')]));
    assert.equal(service.cmdline.at(-1), `${ROOT}/tooling/deployer/main.js`);
    // TypeScript support is off in its environment (NODE_OPTIONS, set by the fake systemctl): 8b below
    // shows the TypeScript sources failing there exactly as on MARS.
    assert.match(serviceLog(), /listening on \/run\/emucat-deployer\/deployer\.sock/);
    assert.doesNotMatch(serviceLog(), /ERR_UNKNOWN_FILE_EXTENSION|TypeError/);
    assert.ok(statSync(SOCKET).isSocket());
    assert.deepEqual(owner(SOCKET), { uid: deploy.uid, gid: socket, mode: 0o660 });
    assert.deepEqual(owner('/run/emucat-deployer'), { uid: deploy.uid, gid: socket, mode: 0o750 });

    // 4. check, through the installed tooling: everything passes, the service included.
    result = run(INSTALLED, 'check');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /ok {4}deployment service socket/);
    assert.match(
      result.stdout,
      /ok {4}deployment service program \/opt\/emucat\/tooling\/deployer\/main\.js/,
    );
    assert.match(result.stdout, /ok {4}the deployment service answers an authenticated request/);
    assert.match(result.stdout, /ok {4}\/opt\/emucat\/config is root-owned/);
    assert.match(result.stdout, /ok {4}tooling \/opt\/emucat\/tooling is root-owned/);
    assert.match(result.stdout, /ok {4}media directory owned by david:david \(1000:1000\)/);
    assert.match(result.stdout, /ok {4}david is not a member of emucat-socket/);

    // 4b. The API's identity: UID/GID 1000 plus the socket group (Compose group_add). Without that group,
    // UID 1000 gets nothing; without the token, nobody does.
    {
      // The container sees the token file itself (a Compose secret is a bind mount of the inode, so the
      // directories above it do not apply); a hard link stands in for that mount.
      const secrets = mkdtempSync(join(ROOT, '..', 'emucat-secret-'));
      chmodSync(secrets, 0o755);
      const token = join(secrets, 'deployer_token');
      linkSync(`${ROOT}/config/deployer.token`, token);
      try {
        assert.equal(asApi([1000, 1000, socket], token), 'status:200');
        assert.equal(asApi([1000, 1000, socket], token, 'x'.repeat(40)), 'status:401');
        assert.equal(asApi([1000, 1000], token), 'token:EACCES');
        const known = readFileSync(`${ROOT}/config/deployer.token`, 'utf8').trim();
        assert.equal(asApi([1000, 1000], token, known), 'socket:EACCES');
      } finally {
        rmSync(secrets, { recursive: true, force: true });
      }
    }

    // 4c. Media: the API's UID/GID can write and read it, and new files belong to david:david.
    const media = `${ROOT}/data/media`;
    execFileSync('setpriv', [
      '--reuid=1000',
      '--regid=1000',
      '--clear-groups',
      'sh',
      '-c',
      `echo kept > ${media}/written-as-1000 && cat ${media}/written-as-1000`,
    ]);
    assert.deepEqual(owner(`${media}/written-as-1000`).uid, 1000);
    assert.deepEqual(owner(`${media}/written-as-1000`).gid, 1000);
    rmSync(`${media}/written-as-1000`);

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

    // 8a. A build that fails leaves the installed tooling and the running service as they were.
    const running = serviceProcess().pid;
    writeFileSync(join(FAKE, 'fail'), 'deployer');
    result = run(CTL, 'install');
    rmSync(join(FAKE, 'fail'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot build the deployment service/);
    assert.ok(existsSync(`${ROOT}/tooling/deployer/main.js`));
    assert.deepEqual(
      readdirSync(ROOT).filter((name) => name.startsWith('tooling.')),
      [],
      'no staged tooling is left behind',
    );
    assert.equal(serviceProcess().pid, running);
    assert.ok(alive(running));

    // 8b. The state MARS was left in: tooling and unit from before, which ran the TypeScript sources and
    // so could not start on a Node.js without TypeScript support; no socket. install repairs it.
    systemctl('stop', 'emucat-deployer.service');
    rmSync(`${ROOT}/tooling/deployer`, { recursive: true });
    mkdirSync(`${ROOT}/tooling/deployer/src`, { recursive: true });
    for (const file of readdirSync(join(REPOSITORY, 'apps/deployer/src'))) {
      writeFileSync(
        `${ROOT}/tooling/deployer/src/${file}`,
        readFileSync(join(REPOSITORY, 'apps/deployer/src', file)),
      );
    }
    writeFileSync(
      UNIT,
      unit.replace(
        /^ExecStart=(\S+) .*$/m,
        `ExecStart=$1 --disable-warning=ExperimentalWarning ${ROOT}/tooling/deployer/src/main.ts`,
      ),
    );
    systemctl('restart', 'emucat-deployer.service');
    const broken = serviceProcess().pid;
    for (let i = 0; i < 100 && alive(broken); i++) execFileSync('sleep', ['0.1']);
    assert.equal(alive(broken), false, 'the old unit exits');
    assert.match(serviceLog(), /ERR_UNKNOWN_FILE_EXTENSION/, 'and fails as it did on MARS');
    assert.equal(existsSync(SOCKET), false);
    result = run(INSTALLED, 'check');
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL {2}deployment service socket/);
    assert.match(result.stdout, /FAIL {2}deployment service program/);

    // 8c. init and install again: nothing edited is replaced, the layout stays as it was, and the service
    // runs again.
    result = run(CTL, 'init');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Keeping the existing/);
    assert.match(result.stdout, /The configuration is complete/);
    assert.match(readFileSync(CONFIG, 'utf8'), new RegExp(`^EMUCAT_GIT_URL=${remote}$`, 'm'));
    result = run(CTL, 'install');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /The deployment service answers\./);
    checkLayout();
    assert.equal(current().commit, first);
    assert.equal(existsSync(`${ROOT}/tooling/deployer/src`), false);
    assert.match(
      readFileSync(UNIT, 'utf8'),
      /^ExecStart=\/\S+\/node \/opt\/emucat\/tooling\/deployer\/main\.js$/m,
    );
    assert.deepEqual(owner(SOCKET), { uid: deploy.uid, gid: socket, mode: 0o660 });
    result = run(INSTALLED, 'check');
    assert.equal(result.status, 0, result.stdout + result.stderr);

    for (const path of OUTSIDE) assert.equal(existsSync(path), false, path);
  }

  it('resumes an init that stopped halfway, keeping every file it finds', () => {
    // What MARS was left with when init stopped at the media directory: the layout up to data/, a
    // deploy.env from the template of that time (without the application account settings), and here
    // also a deploy key and app.env put there by hand, and an empty media directory owned by root.
    const partial = '/opt/emucat-partial';
    const config = `${partial}/config/deploy.env`;
    const template = readFileSync(join(REPOSITORY, 'deploy/config/deploy.env.example'), 'utf8')
      .replace(/^EMUCAT_APP_(USER|GROUP)=.*\n/gm, '')
      .replace(/^EMUCAT_ROOT=.*$/m, `EMUCAT_ROOT=${partial}`)
      .replace(/^EMUCAT_GIT_SSH_KEY=.*$/m, `EMUCAT_GIT_SSH_KEY=${partial}/config/deploy_key`);
    assert.doesNotMatch(template, /EMUCAT_APP_USER/);
    for (const dir of [
      'config',
      'repo.git',
      'releases',
      'state/operations',
      'state/builds',
      'backups',
    ]) {
      mkdirSync(join(partial, dir), { recursive: true });
    }
    mkdirSync(`${partial}/data/media`, { recursive: true });
    execFileSync('chown', ['root:emucat-deploy', `${partial}/config`]);
    chmodSync(`${partial}/config`, 0o750);
    writeFileSync(config, template, { mode: 0o640 });
    writeFileSync(`${partial}/config/deploy_key`, 'EXISTING DEPLOY KEY\n', { mode: 0o600 });
    writeFileSync(
      `${partial}/config/app.env`,
      'DB_NAME=emucat-db\nDB_USER=emucat-usr\nDB_PASSWORD=kept\n',
    );
    const before = {
      config: readFileSync(config, 'utf8'),
      key: readFileSync(`${partial}/config/deploy_key`, 'utf8'),
      app: readFileSync(`${partial}/config/app.env`, 'utf8'),
    };
    const resume = () =>
      spawnSync(CTL, ['init'], {
        env: { ...env, EMUCAT_DEPLOY_CONFIG: config },
        encoding: 'utf8',
        timeout: 60_000,
      });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = resume();
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /Keeping the existing/);
        assert.doesNotMatch(result.stdout, /Created the deploy key|Created .*app\.env/);
        assert.equal(readFileSync(config, 'utf8'), before.config);
        assert.equal(readFileSync(`${partial}/config/deploy_key`, 'utf8'), before.key);
        assert.equal(readFileSync(`${partial}/config/app.env`, 'utf8'), before.app);
        const deploy = { uid: id('-u', 'emucat-deploy'), gid: id('-g', 'emucat-deploy') };
        assert.deepEqual(owner(`${partial}/config/deploy_key`), { ...deploy, mode: 0o600 });
        assert.deepEqual(owner(`${partial}/data/media`), { uid: 1000, gid: 1000, mode: 0o750 });
        assert.ok(readFileSync(`${partial}/config/deployer.token`, 'utf8').length >= 32);
      }
      // Media that already holds files is never taken over, only reported.
      writeFileSync(`${partial}/data/media/existing.jpg`, 'precious');
      execFileSync('chown', ['-R', 'root:root', `${partial}/data/media`]);
      const result = resume();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /holds files but is not owned by david:david/);
      assert.equal(owner(`${partial}/data/media`).uid, 0);
      assert.equal(readFileSync(`${partial}/data/media/existing.jpg`, 'utf8'), 'precious');
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }
  });
});
