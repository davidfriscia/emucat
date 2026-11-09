import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
import { delimiter, join } from 'node:path';
import { after, describe, it, type TestContext } from 'node:test';
import { createHost, CTL, lastValue, REPOSITORY, type Host } from './harness.ts';

/**
 * The deployment service's systemd sandbox and source export. On MARS, `git archive | tar -x` failed
 * under the unit's RestrictSUIDSGID=yes ("Cannot open: Function not implemented"): systemd's seccomp
 * filter for it answers every openat2() with ENOSYS, and the host's GNU tar did not fall back to openat().
 * emucatctl now exports with Git instead, and the unit keeps the restriction.
 *
 * - The unit and emucatctl are checked as text, everywhere.
 * - The update path runs with a `tar` that fails as MARS's did, and with an export that fails halfway.
 * - With the restrict-suid-sgid helper (deploy/test/restrict-suid-sgid.c, in the test image), the export
 *   and a whole update run under the same seccomp rules systemd installs.
 * - As root on a host booted with systemd, the export and GNU tar run under `systemd-run` with the unit's
 *   own hardening settings. Skipped anywhere else, saying why.
 *
 * Linux only, by `pnpm test:deploy`.
 */

const UNIT = join(REPOSITORY, 'deploy/systemd/emucat-deployer.service');
const unitText = readFileSync(UNIT, 'utf8');
const ctlText = readFileSync(CTL, 'utf8');

/** The hardening settings of the unit, as systemd-run properties. */
const HARDENING = [
  'NoNewPrivileges',
  'PrivateTmp',
  'ProtectSystem',
  'ProtectHome',
  'ProtectKernelTunables',
  'ProtectKernelModules',
  'ProtectControlGroups',
  'RestrictSUIDSGID',
  'LockPersonality',
  'RestrictAddressFamilies',
  'SystemCallArchitectures',
  'UMask',
];
function unitValue(key: string): string | undefined {
  return [...unitText.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].at(-1)?.[1];
}

/** A shell function of emucatctl, as text, so that the tests run the real code. */
function ctlFunction(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm').exec(ctlText);
  assert.ok(match, `emucatctl has no function ${name}`);
  return match[0];
}

function which(command: string, path = process.env.PATH ?? ''): string | undefined {
  for (const dir of path.split(delimiter)) {
    const candidate = join(dir, command);
    if (dir && existsSync(candidate)) return candidate;
  }
  return undefined;
}

const HELPER = process.env.EMUCAT_TEST_RESTRICT_SUID_SGID ?? which('restrict-suid-sgid');

const temporary: string[] = [];
const hosts: Host[] = [];
after(() => {
  for (const h of hosts) h.cleanup();
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});
function host(): Host {
  const h = createHost();
  hosts.push(h);
  h.writeConfig();
  return h;
}
function scratch(base = tmpdir()): string {
  const dir = mkdtempSync(join(base, 'emucat-sandbox-'));
  temporary.push(dir);
  return dir;
}

/** A directory of stand-in commands, first on the host's PATH. */
function shadow(h: Host, commands: Record<string, string>): string {
  const dir = scratch();
  for (const [name, script] of Object.entries(commands)) {
    writeFileSync(join(dir, name), script);
    chmodSync(join(dir, name), 0o755);
  }
  h.env.PATH = `${dir}${delimiter}${h.env.PATH ?? ''}`;
  return dir;
}

/** GNU tar as it failed on MARS. */
const MARS_TAR = `#!/bin/sh
echo 'tar: ./subdir/test.txt: Cannot open: Function not implemented' >&2
echo 'tar: Exiting with failure status due to previous errors' >&2
exit 2
`;

function update(h: Host, wrapper?: string) {
  const result = wrapper
    ? spawnSync(wrapper, ['--', CTL, 'update', '--yes'], {
        env: h.env,
        encoding: 'utf8',
        timeout: 60_000,
      })
    : h.run('update', '--yes');
  const { events } = h.latestOperation();
  return { result, events, error: lastValue(events, 'error'), done: lastValue(events, 'done') };
}

const head = (h: Host) =>
  execFileSync('git', ['-C', h.remote, 'rev-parse', 'develop'], { encoding: 'utf8' }).trim();
const builds = (h: Host) => join(h.root, 'state/builds');

/**
 * A repository with a nested tree like the one tar failed on, plus a script that exports it with
 * emucatctl's export_source into out-git, and with `git archive | tar -x` into out-tar.
 */
function exportFixture(base?: string) {
  const dir = scratch(base);
  const work = join(dir, 'work');
  mkdirSync(join(work, 'subdir/deeper'), { recursive: true });
  writeFileSync(join(work, 'top.txt'), 'top\n');
  writeFileSync(join(work, 'subdir/test.txt'), 'nested\n');
  writeFileSync(join(work, 'subdir/deeper/run.sh'), '#!/bin/sh\n');
  chmodSync(join(work, 'subdir/deeper/run.sh'), 0o755);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', work, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir },
    });
  git('init', '--quiet');
  git('add', '.');
  git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  const commit = git('rev-parse', 'HEAD').trim();
  execFileSync('git', ['clone', '--quiet', '--bare', work, join(dir, 'repo.git')], {
    env: { ...process.env, HOME: dir },
  });
  const script = join(dir, 'export.sh');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      'umask 027',
      `dir=${dir}`,
      'export HOME=$dir',
      'REPO=$dir/repo.git EMUCAT_GIT_SSH_KEY= KNOWN_HOSTS=',
      ctlFunction('git_repo'),
      ctlFunction('export_source'),
      `export_source ${commit} "$dir/out-git"; echo "git=$?"`,
      'mkdir -p "$dir/out-tar"',
      `git_repo archive --format=tar ${commit} | tar -x -C "$dir/out-tar" 2>"$dir/tar.err"; echo "tar=$?"`,
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  return {
    dir,
    script,
    check(output: string, t: TestContext) {
      assert.match(output, /^git=0$/m, output);
      assert.equal(readFileSync(join(dir, 'out-git/subdir/test.txt'), 'utf8'), 'nested\n');
      assert.equal(readFileSync(join(dir, 'out-git/top.txt'), 'utf8'), 'top\n');
      assert.ok(existsSync(join(dir, 'out-git/subdir/deeper/run.sh')));
      assert.ok(!existsSync(join(dir, 'out-git.index')), 'the temporary index is removed');
      // GNU tar's result depends on its build: some fall back to openat() after ENOSYS, some do not.
      const tar = /^tar=(\d+)$/m.exec(output)?.[1];
      const error = existsSync(join(dir, 'tar.err'))
        ? readFileSync(join(dir, 'tar.err'), 'utf8')
        : '';
      t.diagnostic(
        tar === '0'
          ? 'this GNU tar extracts under the restriction (it falls back after ENOSYS)'
          : `this GNU tar fails under the restriction, as on MARS: ${error.trim()}`,
      );
    },
  };
}

describe('the deployment service unit', () => {
  it('keeps its systemd hardening, RestrictSUIDSGID=yes included', () => {
    assert.equal(unitValue('RestrictSUIDSGID'), 'yes');
    assert.equal(unitValue('NoNewPrivileges'), 'yes');
    assert.equal(unitValue('PrivateTmp'), 'yes');
    assert.equal(unitValue('ProtectSystem'), 'strict');
    assert.equal(unitValue('ProtectHome'), 'yes');
    assert.equal(unitValue('ProtectKernelTunables'), 'yes');
    assert.equal(unitValue('ProtectKernelModules'), 'yes');
    assert.equal(unitValue('ProtectControlGroups'), 'yes');
    assert.equal(unitValue('LockPersonality'), 'yes');
    assert.equal(unitValue('SystemCallArchitectures'), 'native');
    assert.equal(unitValue('RestrictAddressFamilies'), 'AF_UNIX AF_INET AF_INET6');
    assert.equal(
      unitValue('ReadWritePaths'),
      '@ROOT@/state @ROOT@/releases @ROOT@/repo.git @ROOT@/backups',
    );
    // No setting that would loosen what RestrictSUIDSGID or the rest add up to.
    assert.doesNotMatch(
      unitText,
      /^(SystemCallFilter|SystemCallErrorNumber|CapabilityBoundingSet|AmbientCapabilities)=/m,
    );
    for (const key of HARDENING) assert.ok(unitValue(key) !== undefined, key);
  });

  it('is what install writes, and install rewrites it from the new tooling every time', () => {
    // An upgrade is `emucatctl install` from a newer checkout: the unit and emucatctl come from it.
    assert.match(
      ctlText,
      /install -m 0644 "\$source\/deploy\/systemd\/emucat-deployer\.service" "\$staged\/systemd\/"/,
    );
    assert.match(
      ctlText,
      /install -m 0755 "\$source\/deploy\/bin\/emucatctl" "\$staged\/bin\/emucatctl"/,
    );
    assert.match(ctlText, /"\$TOOLING\/systemd\/emucat-deployer\.service" >"\$unit\.tmp"/);
  });
});

describe('source export', () => {
  it('never extracts with tar', () => {
    const update = /^cmd_update\(\) \{\n[\s\S]*?^\}\n/m.exec(ctlText)?.[0] ?? '';
    assert.match(update, /export_source "\$TARGET" "\$source"/);
    const code = ctlText.replace(/^\s*#.*$/gm, '');
    assert.doesNotMatch(code, /\|\s*tar\b|\btar\s+-?x/);
    assert.doesNotMatch(
      ctlFunction('export_source').replace(/^\s*#.*$/gm, ''),
      /\btar\b|\barchive\b/,
    );
  });

  it('deploys even where GNU tar fails as it did on MARS', () => {
    const h = host();
    shadow(h, { tar: MARS_TAR });
    const { result, done, error } = update(h);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(done, 'succeeded', error);
    const target = head(h);
    assert.equal(h.current()?.commit, target);
    assert.equal(
      readFileSync(join(h.root, `releases/${target}/migrations.txt`), 'utf8'),
      '0001_initial_schema\n',
    );
    assert.equal(
      readFileSync(join(h.root, `releases/${target}/compose.yaml`), 'utf8'),
      readFileSync(join(REPOSITORY, 'deploy/compose.yaml'), 'utf8'),
    );
    assert.deepEqual(readdirSync(builds(h)), [], 'the exported source is removed after the update');
  });

  it('leaves the active release alone when the export fails halfway, and the next attempt succeeds', () => {
    const h = host();
    assert.equal(update(h).done, 'succeeded');
    const active = h.current();
    const running = h.running();
    const calls = h.calls().length;
    const next = h.commit('develop', 'Next release');

    // A checkout that writes some files and then fails, as an interrupted export would.
    const realGit = which('git');
    assert.ok(realGit);
    const dir = shadow(h, {
      git: `#!/bin/sh
for argument; do
  if [ "$argument" = checkout-index ]; then
    ${realGit} "$@"
    echo 'error: simulated export failure' >&2
    exit 128
  fi
done
exec ${realGit} "$@"
`,
    });
    const failed = update(h);
    assert.equal(failed.result.status, 1);
    assert.equal(failed.error, 'fetch_failed');
    assert.equal(lastValue(failed.events, 'target'), next);
    assert.equal(lastValue(failed.events, 'rollback'), 'not_needed');
    assert.equal(failed.done, 'failed');
    assert.deepEqual(h.current(), active, 'no release was recorded');
    assert.equal(h.running(), running, 'the running containers are untouched');
    assert.ok(!existsSync(join(h.root, `releases/${next}`)));
    assert.deepEqual(readdirSync(builds(h)), [], 'the partial export and its index are removed');
    const during = h.calls().slice(calls);
    assert.ok(
      !during.some(
        (c) => c.startsWith('docker build') || c.startsWith('mariadb-dump') || / up | run /.test(c),
      ),
      during.join('\n'),
    );

    // The repository mirror is still usable: the next update deploys the same commit.
    h.env.PATH = (h.env.PATH ?? '')
      .split(delimiter)
      .filter((entry) => entry !== dir)
      .join(delimiter);
    const retried = update(h);
    assert.equal(retried.done, 'succeeded', retried.error);
    assert.equal(h.current()?.commit, next);
    assert.equal(h.running(), next);
  });
});

describe('under the seccomp rules of RestrictSUIDSGID=yes (restrict-suid-sgid)', () => {
  const skip = HELPER
    ? false
    : 'restrict-suid-sgid is not installed (it is in the pnpm test:deploy image)';

  it('refuses openat2() with ENOSYS and set-ID modes with EPERM, as systemd does', { skip }, () => {
    const result = spawnSync(HELPER!, ['--check'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const file = join(scratch(), 'file');
    writeFileSync(file, '');
    const chmod = spawnSync(
      HELPER!,
      [process.execPath, '-e', `require('fs').chmodSync(${JSON.stringify(file)}, 0o2755)`],
      {
        encoding: 'utf8',
      },
    );
    assert.notEqual(chmod.status, 0);
    assert.match(chmod.stderr, /EPERM/);
  });

  it('exports a nested tree with export_source (GNU tar shown for comparison)', { skip }, (t) => {
    const fixture = exportFixture();
    const result = spawnSync(HELPER!, ['--', fixture.script], { encoding: 'utf8' });
    fixture.check(result.stdout, t);
  });

  it('runs a whole update', { skip }, () => {
    const h = host();
    const { result, done, error } = update(h, HELPER);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(done, 'succeeded', error);
    assert.equal(h.current()?.commit, head(h));
  });
});

describe('under systemd with the unit hardening (systemd-run)', () => {
  const reason = (() => {
    if (process.getuid?.() !== 0) return 'needs root';
    if (!existsSync('/run/systemd/system')) return 'this host was not booted with systemd';
    if (!which('systemd-run')) return 'systemd-run is not installed';
    return false;
  })();

  it(
    'exports a nested tree with export_source (GNU tar shown for comparison)',
    { skip: reason },
    (t) => {
      // Outside /tmp, /var/tmp and /home, which PrivateTmp and ProtectHome hide.
      mkdirSync('/var/lib/emucat-sandbox-test', { recursive: true, mode: 0o700 });
      temporary.push('/var/lib/emucat-sandbox-test');
      const fixture = exportFixture('/var/lib/emucat-sandbox-test');
      const properties = HARDENING.flatMap((key) => ['-p', `${key}=${unitValue(key)}`]);
      const result = spawnSync(
        'systemd-run',
        [
          '--wait',
          '--pipe',
          '--quiet',
          '--collect',
          '--service-type=exec',
          ...properties,
          '-p',
          `ReadWritePaths=${fixture.dir}`,
          '-p',
          `Environment=PATH=${process.env.PATH}`,
          fixture.script,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );
      assert.equal(result.status, 0, result.stderr);
      fixture.check(result.stdout, t);
    },
  );
});
