import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEvents, type UpdateEvent } from '../src/operations.ts';

/**
 * A disposable host for emucatctl: a Git "remote" with `main` and `develop`, and the layout `install`
 * makes under an EMUCAT_ROOT: a bare mirror, configuration files in config/, media with existing data in
 * data/media, backups/, and the fakes' state directory (config/fake). Everything lives under one temporary
 * directory, removed afterwards.
 */

export const REPOSITORY = resolve(import.meta.dirname, '../../..');
export const CTL = join(REPOSITORY, 'deploy/bin/emucatctl');
export const DB_PASSWORD = 'integration-db-password-0123456789';
export const TOKEN = 'integration-deployer-token-0123456789abcdef';

export interface Host {
  dir: string;
  root: string;
  /** EMUCAT_ROOT/config. */
  configDir: string;
  config: string;
  fake: string;
  media: string;
  backups: string;
  socketDir: string;
  remote: string;
  work: string;
  env: NodeJS.ProcessEnv;
  /** Adds a commit to a branch of the remote and returns its ID. */
  commit(branch: string, message: string, migration?: string): string;
  run(...args: string[]): SpawnSyncReturns<string>;
  setFake(name: string, value: string | null): void;
  calls(): string[];
  current(): { commit: string; previous: string } | null;
  running(): string;
  images(): string[];
  operations(): string[];
  events(id: string): UpdateEvent[];
  latestOperation(): { id: string; events: UpdateEvent[] };
  writeConfig(overrides?: Record<string, string>): void;
  cleanup(): void;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function createHost(): Host {
  const dir = mkdtempSync(join(tmpdir(), 'emucat-host-'));
  const root = join(dir, 'opt/emucat');
  const configDir = join(root, 'config');
  const fake = join(configDir, 'fake');
  const media = join(root, 'data/media');
  const backups = join(root, 'backups');
  const socketDir = join(dir, 'run');
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  for (const path of [configDir, fake, media, backups, socketDir, join(root, 'state/operations')]) {
    mkdirSync(path, { recursive: true });
  }
  // Data that must survive everything.
  writeFileSync(join(media, 'existing-screenshot.jpg'), 'precious');
  writeFileSync(join(backups, 'manual-dump-before-install.sql.gz'), 'older backup');

  writeFileSync(
    join(configDir, 'app.env'),
    `DB_HOST=host.docker.internal\nDB_PORT=3306\nDB_NAME=emucat-db\nDB_USER=emucat-usr\nDB_PASSWORD=${DB_PASSWORD}\n`,
    { mode: 0o640 },
  );
  writeFileSync(join(configDir, 'deployer.token'), `${TOKEN}\n`, { mode: 0o640 });

  // The remote: a small tree with the files emucatctl reads from a release.
  git(dir, 'init', '--quiet', '--bare', remote);
  git(dir, 'init', '--quiet', work);
  mkdirSync(join(work, 'deploy/docker'), { recursive: true });
  mkdirSync(join(work, 'apps/api/migrations'), { recursive: true });
  writeFileSync(
    join(work, 'deploy/compose.yaml'),
    readFileSync(join(REPOSITORY, 'deploy/compose.yaml')),
  );
  writeFileSync(join(work, 'deploy/docker/api.Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(work, 'deploy/docker/web.Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(work, 'apps/api/migrations/0001_initial_schema.sql'), 'SELECT 1;\n');
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'Initial release');
  git(work, 'push', '--quiet', remote, 'HEAD:refs/heads/main');
  git(work, 'checkout', '--quiet', '-b', 'develop');
  writeFileSync(join(work, 'README'), 'develop\n');
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'Start develop');
  git(work, 'push', '--quiet', remote, 'develop');
  // What `emucatctl install` does.
  git(
    dir,
    'clone',
    '--quiet',
    '--bare',
    '--no-tags',
    '--single-branch',
    '--branch',
    'develop',
    remote,
    join(root, 'repo.git'),
  );

  const config = join(configDir, 'deploy.env');
  const host: Host = {
    dir,
    root,
    configDir,
    config,
    fake,
    media,
    backups,
    socketDir,
    remote,
    work,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: 'C.UTF-8',
      EMUCAT_DEPLOY_CONFIG: config,
    },
    commit(branch, message, migration) {
      git(work, 'checkout', '--quiet', branch);
      if (migration)
        writeFileSync(join(work, `apps/api/migrations/${migration}.sql`), 'SELECT 2;\n');
      writeFileSync(join(work, 'CHANGES'), `${message}\n`);
      git(work, 'add', '.');
      git(work, 'commit', '--quiet', '-m', message);
      git(work, 'push', '--quiet', remote, branch);
      return git(work, 'rev-parse', 'HEAD');
    },
    run(...args) {
      return spawnSync(CTL, args, { env: host.env, encoding: 'utf8', timeout: 60_000 });
    },
    setFake(name, value) {
      const path = join(fake, name);
      if (value === null) rmSync(path, { force: true });
      else writeFileSync(path, value);
    },
    calls() {
      return existsSync(join(fake, 'calls'))
        ? readFileSync(join(fake, 'calls'), 'utf8').split('\n')
        : [];
    },
    current() {
      const path = join(root, 'state/current-release.json');
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    },
    running() {
      return existsSync(join(fake, 'running')) ? readFileSync(join(fake, 'running'), 'utf8') : '';
    },
    images() {
      return existsSync(join(fake, 'images'))
        ? readFileSync(join(fake, 'images'), 'utf8').split('\n').filter(Boolean)
        : [];
    },
    operations() {
      return readdirSync(join(root, 'state/operations'))
        .filter((file) => file.endsWith('.events'))
        .map((file) => file.replace(/\.events$/, ''));
    },
    events(id) {
      return parseEvents(readFileSync(join(root, `state/operations/${id}.events`), 'utf8'));
    },
    latestOperation() {
      const ids = host.operations();
      const sorted = ids
        .map((id) => ({ id, events: host.events(id) }))
        .sort((a, b) => (a.events[0]?.at ?? '').localeCompare(b.events[0]?.at ?? ''));
      const last = sorted.at(-1);
      if (!last) throw new Error('no operation');
      return last;
    },
    writeConfig(overrides = {}) {
      const values: Record<string, string> = {
        EMUCAT_ENVIRONMENT: 'test',
        EMUCAT_BRANCH: 'develop',
        EMUCAT_GIT_URL: remote,
        EMUCAT_ADMIN_UPDATES_ENABLED: 'true',
        EMUCAT_ROOT: root,
        EMUCAT_SOCKET_DIR: socketDir,
        EMUCAT_SOCKET_GID: '1000',
        // The test container's UID/GID 1000 account.
        EMUCAT_APP_USER: 'node',
        EMUCAT_APP_GROUP: 'node',
        EMUCAT_DEPLOY_USER: 'nobody-here',
        EMUCAT_HTTP_PORT: '18080',
        EMUCAT_HEALTH_TIMEOUT_SECONDS: '1',
        EMUCAT_CTL: CTL,
        ...overrides,
      };
      writeFileSync(
        config,
        Object.entries(values)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n') + '\n',
        { mode: 0o640 },
      );
      chmodSync(config, 0o640);
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  host.writeConfig();
  return host;
}

export function lastValue(events: UpdateEvent[], key: string): string | undefined {
  return events.findLast((event) => event.key === key)?.value;
}

export { spawn };
