/**
 * Running VMs and verifying local copies with nothing simulated: the compiled agent, the real API on a
 * real database, a real OpenSSH server in a container, the real web app, a real browser, and the real
 * 86Box and QEMU. Every VM here is a disposable directory this file creates, with no disk image the user
 * owns; the emulator installations are only executed.
 *
 * Run with `pnpm test:e2e`. It needs MariaDB, Docker, `ssh-keygen`, Microsoft Edge or Chrome, and the
 * emulators: `EMUCAT_E2E_QEMU` names qemu-system-x86_64.exe and `EMUCAT_E2E_86BOX` names 86Box.exe. When
 * one is not set, its default location is tried, and its tests are skipped if it is not there.
 *
 * Remote HTTPS is deliberately not exercised: the agent talks to this API over loopback HTTP.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  discoveryOperationSchema,
  discoveryStateResponseSchema,
  executionOptionsResponseSchema,
  pairingRequestReviewSchema,
  registrationOperationSchema,
  repositorySummarySchema,
  versionTreeResponseSchema,
  vmSessionSchema,
  vmVerificationSchema,
  vmWorkspaceSchema,
  type RegistrationOperation,
  type VmSession,
  type VmVerification,
  type VmWorkspace,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENEROUS_RATE_LIMITS, waitFor } from '../test/agent-helpers.js';
import {
  ADMIN_PASSWORD,
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from '../test/browser-app.js';

const profile = process.env.EMUCAT_AGENT_E2E_PROFILE ?? 'debug';
const AGENT_BINARY = resolve(
  import.meta.dirname,
  `../../../agent/target/${profile}/emucat-agent.exe`,
);
const IMAGE = 'emucat-sftp-test:local';
const IMAGE_CONTEXT = resolve(import.meta.dirname, '../../../infra/docker/sftp-test');
const WEB_DIRECTORY = resolve(import.meta.dirname, '../../web');
const LONG = 240_000;

const QEMU_EXE = process.env.EMUCAT_E2E_QEMU ?? 'C:\\Program Files\\qemu\\qemu-system-x86_64.exe';
const BOX86_EXE =
  process.env.EMUCAT_E2E_86BOX ?? 'C:\\Users\\david\\emulation\\86box_5.3\\86Box.exe';
const HAVE_QEMU = existsSync(QEMU_EXE);
const HAVE_86BOX = existsSync(BOX86_EXE);

function docker(...args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function generateKey(path: string): void {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-C', 'emucat-e2e', '-N', '', '-f', path]);
}

function fingerprintOf(path: string): string {
  return execFileSync('ssh-keygen', ['-lf', `${path}.pub`], { encoding: 'utf8' }).split(
    ' ',
  )[1] as string;
}

/** Every file under a directory and its hash, plus the directories, which is what "the same VM" means. */
async function fingerprint(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result[`${relative}/`] = 'directory';
      Object.assign(result, await fingerprint(path, `${relative}/`));
    } else {
      result[relative] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    }
  }
  return result;
}

/** A 486 with no disks, which stops at the BIOS. The machine and its ROMs are 86Box's own. */
const BOX86_CONFIG = [
  '[General]',
  'vid_renderer = qt_software',
  'confirm_exit = 0',
  '',
  '[Machine]',
  'machine = 486sp3c',
  'cpu_family = i486sx',
  'cpu_speed = 33333333',
  'cpu_multi = 1',
  'mem_size = 4096',
  '',
  '[Video]',
  'gfxcard = et4000w32',
  '',
].join('\r\n');

describe('running and verifying VMs, end to end', () => {
  let context: BrowserTestContext;
  let server: FastifyInstance;
  let admin: TestClient;
  let port: number;
  let directory: string;
  let configPath: string;
  let box86: string;
  let qemu: string;
  let repositoryId: string;
  let agentId: string;
  let container: string;
  let webPort: number;
  let browser: Browser;
  const running: ChildProcess[] = [];
  /** Sessions this file started, so that none outlives it even if a test fails. */
  const started = new Set<string>();

  function startAgent(...args: string[]) {
    const child = spawn(AGENT_BINARY, [...args, '--config', configPath, '--log-level', 'info'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += String(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
    running.push(child);
    return { child, output: () => output, exited };
  }

  let daemon: ReturnType<typeof startAgent>;

  async function isOnline(): Promise<boolean> {
    const response = await admin.get(`/admin/agents/${agentId}`);
    return response.statusCode === 200 && response.json<{ online: boolean }>().online;
  }

  async function options(vmName: string, emulator = 'qemu') {
    const response = await admin.get(
      `/admin/vms/${emulator}/${encodeURIComponent(vmName)}/execution-options`,
    );
    expect(response.statusCode, response.body).toBe(200);
    return executionOptionsResponseSchema.parse(response.json());
  }

  /** Online, and it has said what it can launch. */
  async function startDaemon(): Promise<void> {
    daemon = startAgent('run');
    await untilOnline();
    await new Promise((done) => setTimeout(done, 1_000));
  }

  /** Waits for the agent's connection, and says what the agent printed when it does not come. */
  async function untilOnline(timeoutMs = 30_000): Promise<void> {
    try {
      await waitFor(isOnline, 'the agent to be online', timeoutMs);
    } catch (error) {
      const tail = daemon?.output().split('\n').slice(-20).join('\n') ?? '(never started)';
      const exit = daemon?.child.exitCode ?? daemon?.child.signalCode ?? 'still running';
      throw new Error(`${(error as Error).message}. Agent process: ${exit}. Its output:\n${tail}`, {
        cause: error,
      });
    }
  }

  /**
   * Each group of tests starts from a connected agent, whatever the group before it did: a test that
   * stopped the agent and then failed must not leave the next group without one.
   */
  async function ensureAgentOnline(): Promise<void> {
    if (await isOnline()) return;
    if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null) {
      // Running, and perhaps still reconnecting.
      await untilOnline();
    } else {
      await startDaemon();
    }
  }

  async function killAgent(): Promise<void> {
    daemon.child.kill('SIGKILL');
    await daemon.exited;
    await waitFor(async () => !(await isOnline()), 'the agent to be offline', 30_000);
  }

  async function discover(vmName: string) {
    const response = await admin.request({
      method: 'POST',
      url: `/admin/agents/${agentId}/discovery`,
    });
    expect(response.statusCode, response.body).toBe(202);
    const { id } = discoveryOperationSchema.parse(response.json());
    const operation = await waitFor(async () => {
      const state = discoveryStateResponseSchema.parse(
        (await admin.get(`/admin/agents/${agentId}/discovery`)).json(),
      );
      return state.operation?.id === id && state.operation.status === 'completed'
        ? state.operation
        : null;
    }, 'the scan');
    expect(operation.vms.map((vm) => vm.vmName)).toContain(vmName);
    return operation;
  }

  async function register(vmName: string, emulatorType: 'qemu' | '86box') {
    const discovery = await discover(vmName);
    const response = await admin.request({
      method: 'POST',
      url: '/admin/registrations',
      payload: {
        agentId,
        repositoryId,
        emulatorType,
        vmName,
        mode: 'copy',
        discoveryOperationId: discovery.id,
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    const { id } = registrationOperationSchema.parse(response.json());
    const done = await waitFor(
      async () => {
        const operation = registrationOperationSchema.parse(
          (await admin.get(`/admin/registrations/${id}`)).json(),
        );
        return ['succeeded', 'failed', 'cancelled', 'partial_success'].includes(operation.state)
          ? operation
          : null;
      },
      'the registration to finish',
      120_000,
    );
    expect(done.state, JSON.stringify(done)).toBe('succeeded');
    return done as RegistrationOperation;
  }

  async function launch(
    vmName: string,
    emulatorType = 'qemu',
    mode = 'local',
    workspaceId?: string,
  ) {
    return admin.request({
      method: 'POST',
      url: '/admin/sessions',
      payload: {
        agentId,
        emulatorType,
        vmName,
        mode,
        requestId: randomUUID(),
        ...(workspaceId ? { workspaceId } : {}),
      },
    });
  }

  const errorCode = (response: { json: <T>() => T }) =>
    response.json<{ error: { code: string } }>().error.code;

  async function readSession(id: string): Promise<VmSession> {
    return vmSessionSchema.parse((await admin.get(`/admin/sessions/${id}`)).json());
  }

  const sessionIn = (id: string, states: string[], timeout = 60_000) =>
    waitFor(
      async () => {
        const session = await readSession(id);
        return states.includes(session.state) ? session : null;
      },
      `the session to be ${states.join(' or ')}`,
      timeout,
    );

  async function verify(vmName: string, emulatorType = 'qemu'): Promise<VmVerification> {
    const response = await admin.request({
      method: 'POST',
      url: '/admin/verifications',
      payload: { agentId, emulatorType, vmName },
    });
    expect(response.statusCode, response.body).toBe(202);
    const { id } = vmVerificationSchema.parse(response.json());
    return waitFor(
      async () => {
        const verification = vmVerificationSchema.parse(
          (await admin.get(`/admin/verifications/${id}`)).json(),
        );
        return verification.state === 'requested' ? null : verification;
      },
      'the verification to finish',
      60_000,
    );
  }

  const webUrl = (path: string) => `http://127.0.0.1:${webPort}${path}`;
  const stateDirectory = () => join(directory, 'state');

  async function signIn(page: Page): Promise<void> {
    await page.goto(webUrl('/login'));
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  }

  async function shot(page: Page, name: string): Promise<void> {
    const target = process.env.EMUCAT_E2E_SCREENSHOTS;
    if (target) await page.screenshot({ path: join(target, `${name}.png`), fullPage: true });
  }

  beforeAll(async () => {
    if (!existsSync(AGENT_BINARY)) throw new Error(`Build the agent first: ${AGENT_BINARY}`);
    docker('build', '-q', '-t', IMAGE, IMAGE_CONTEXT);

    directory = await mkdtemp(join(tmpdir(), 'emucat-e2e-execution-'));
    box86 = join(directory, 'box86');
    qemu = join(directory, 'qemu');
    await mkdir(box86);
    await mkdir(qemu);
    await mkdir(join(directory, 'keys'));
    const clientKey = join(directory, 'keys', 'client');
    const hostKey = join(directory, 'keys', 'host');
    generateKey(clientKey);
    generateKey(hostKey);
    container = `emucat-e2e-execution-${randomUUID().slice(0, 8)}`;
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      container,
      '-p',
      '127.0.0.1:0:22',
      '--tmpfs',
      '/srv/sftp/repo:size=512m',
      '-e',
      `HOST_KEY_B64=${readFileSync(hostKey).toString('base64')}`,
      '-e',
      `AUTHORIZED_KEY=${readFileSync(`${clientKey}.pub`, 'utf8').trim()}`,
      IMAGE,
    );
    const sftpPort = Number(docker('port', container, '22/tcp').split(':').pop());
    await waitFor(
      () => {
        try {
          return docker('exec', container, 'sh', '-c', 'pgrep sshd').length > 0;
        } catch {
          return false;
        }
      },
      'the SFTP server to start',
      30_000,
    );

    context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
    admin = await signedInAdmin(context);
    server = context.app;
    await server.listen({ host: '127.0.0.1', port: 0 });
    port = (server.server.address() as AddressInfo).port;

    const created = await admin.request({
      method: 'POST',
      url: '/admin/repositories',
      payload: {
        name: 'E2E repository',
        host: '127.0.0.1',
        port: sftpPort,
        username: 'emucat',
        remoteRoot: '/repo',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    repositoryId = repositorySummarySchema.parse(created.json()).id;

    // An executable that does not exist yet stands in for a missing emulator: it can be registered,
    // but not launched.
    const missing = join(directory, 'not-installed', 'emulator.exe');
    configPath = join(directory, 'agent.toml');
    await writeFile(
      configPath,
      [
        '[server]',
        `api_url = ${JSON.stringify(`http://127.0.0.1:${port}`)}`,
        '[agent]',
        'name = "E2E execution"',
        '[emulators.86box]',
        `base_path = ${JSON.stringify(box86)}`,
        `executable = ${JSON.stringify(HAVE_86BOX ? BOX86_EXE : missing)}`,
        '[emulators.qemu]',
        `base_path = ${JSON.stringify(qemu)}`,
        `executable = ${JSON.stringify(HAVE_QEMU ? QEMU_EXE : missing)}`,
        '[state]',
        `dir = ${JSON.stringify(join(directory, 'state'))}`,
        '[storage]',
        `staging_dir = ${JSON.stringify(join(directory, 'staging'))}`,
        `cache_dir = ${JSON.stringify(join(directory, 'cache'))}`,
        '[execution]',
        'stop_timeout_seconds = 5',
        'start_grace_seconds = 2',
        `[repositories."${repositoryId}"]`,
        'kind = "sftp"',
        'host = "127.0.0.1"',
        `port = ${sftpPort}`,
        'username = "emucat"',
        'remote_root = "/repo"',
        `private_key_path = ${JSON.stringify(clientKey)}`,
        `host_key_fingerprints = [${JSON.stringify(fingerprintOf(hostKey))}]`,
        'connect_timeout_seconds = 5',
        'transfer_timeout_seconds = 5',
        'connect_retries = 0',
        '',
      ].join('\n'),
    );

    const pairing = startAgent('pair');
    const code = await waitFor(
      () => /Pairing code: (\S+)/.exec(pairing.output())?.[1],
      'the agent to print its code',
    );
    const lookup = await admin.request({
      method: 'POST',
      url: '/admin/agent-pairing/lookup',
      payload: { code },
    });
    const review = pairingRequestReviewSchema.parse(lookup.json());
    const decided = await admin.request({
      method: 'POST',
      url: `/admin/agent-pairing/requests/${review.id}/approve`,
      payload: { code },
    });
    expect(decided.statusCode).toBe(200);
    expect(await pairing.exited).toBe(0);
    agentId = /Paired as agent (\S+)\./.exec(pairing.output())?.[1] as string;
    const associated = await admin.request({
      method: 'PUT',
      url: `/admin/repositories/${repositoryId}/agents/${agentId}`,
    });
    expect(associated.statusCode, associated.body).toBe(200);
    await startDaemon();

    webPort = 5700 + Math.floor(Math.random() * 200);
    const web = spawn(
      process.execPath,
      [
        join(WEB_DIRECTORY, 'node_modules', 'vite', 'bin', 'vite.js'),
        '--port',
        String(webPort),
        '--strictPort',
      ],
      {
        cwd: WEB_DIRECTORY,
        env: { ...process.env, VITE_API_PROXY_TARGET: `http://127.0.0.1:${port}` },
        stdio: 'ignore',
      },
    );
    running.push(web);
    await waitFor(
      async () => {
        try {
          return (await fetch(webUrl('/'))).ok;
        } catch {
          return false;
        }
      },
      'the web app to start',
      60_000,
    );
    browser = await chromium
      .launch({ channel: 'msedge', headless: true })
      .catch(() => chromium.launch({ channel: 'chrome', headless: true }));
  }, LONG);

  afterAll(async () => {
    // Every emulator this file started is ended through the agent, by its identity, never by name.
    for (const id of started) {
      try {
        const session = await readSession(id);
        if (['starting', 'running', 'stopping'].includes(session.state) && session.agentOnline) {
          await admin.request({
            method: 'POST',
            url: `/admin/sessions/${id}/stop`,
            payload: { force: true, confirmVmName: session.vmName },
          });
          await sessionIn(id, ['stopped', 'exited', 'failed'], 20_000);
        }
      } catch {
        // Reported by the test that failed.
      }
    }
    await browser?.close();
    for (const child of running) child.kill('SIGKILL');
    try {
      docker('rm', '-f', container);
    } catch {
      // Already gone.
    }
    await context?.close();
    if (directory) {
      await new Promise((done) => setTimeout(done, 1_000));
      await rm(directory, { recursive: true, force: true });
    }
  }, LONG);

  describe.skipIf(!HAVE_QEMU)('QEMU', () => {
    const VM = 'E2E QEMU';
    let root: string;
    let session: VmSession;
    let launched = false;

    /**
     * The tests after the browser launch act on the session it started: they are one scenario by design.
     * When that launch did not happen, each says so, rather than failing on an undefined session.
     */
    function requireLaunched(): void {
      if (!launched)
        throw new Error('No QEMU session: the browser launch earlier in this file failed');
    }

    beforeAll(async () => {
      root = join(qemu, VM);
      await mkdir(join(root, 'nested'), { recursive: true });
      // A real launcher, parsed by the agent and never run. SeaBIOS finds no disk, and waits.
      await writeFile(
        join(root, 'run.bat'),
        '@echo off\r\nqemu-system-i386 -m 16 -nodefaults -display none\r\n',
      );
      await writeFile(join(root, 'disk.qcow2'), randomBytes(256 * 1024));
      await writeFile(join(root, 'nested', 'notes.txt'), 'original\n');
      await ensureAgentOnline();
      await register(VM, 'qemu');
    }, LONG);

    it('offers local and Remote Snapshot execution, and says why Remote Volatile is not available', async () => {
      const result = await options(VM);
      expect(result.modes.map((mode) => [mode.mode, mode.available])).toEqual([
        ['local', true],
        ['remote_volatile', false],
        ['remote_snapshot', true],
      ]);
      expect(result.modes[0]?.reason).toBeNull();
      expect(result.modes[1]?.reason).toMatch(/remote display/);
      // Available, but only through a working copy prepared from the version history.
      expect(result.modes[2]?.reason).toMatch(/working copy/);
      expect(result.agents[0]).toMatchObject({
        agentId,
        launch: { eligible: true },
        verify: { eligible: true },
        local: { present: true, contentStatus: 'verified' },
      });

      // Each refusal is a refusal: nothing is launched, locally or otherwise.
      const volatile = await launch(VM, 'qemu', 'remote_volatile');
      expect(volatile.statusCode, volatile.body).toBe(409);
      expect(errorCode(volatile)).toBe('execution_mode_unavailable');
      // Remote Snapshot names its working copy; without one it is invalid, never a local launch.
      const unnamed = await launch(VM, 'qemu', 'remote_snapshot');
      expect(unnamed.statusCode, unnamed.body).toBe(400);
      expect(errorCode(unnamed)).toBe('validation_failed');
      // This agent can run the mode, so what is refused is a working copy that does not exist.
      const unknown = await launch(VM, 'qemu', 'remote_snapshot', randomUUID());
      expect(unknown.statusCode, unknown.body).toBe(404);
      expect(errorCode(unknown)).toBe('workspace_not_found');
      // A local session runs the persistent copy, and cannot be pointed at a working copy.
      const local = await launch(VM, 'qemu', 'local', randomUUID());
      expect(local.statusCode, local.body).toBe(400);
      expect(errorCode(local)).toBe('validation_failed');
      const list = (await admin.get(`/admin/sessions?vmName=${encodeURIComponent(VM)}`)).json<{
        sessions: VmSession[];
      }>().sessions;
      expect(list, 'no refused request started a session').toEqual([]);
    });

    it(
      'verifies an untouched copy, finds a changed file, and verifies it again once restored',
      async () => {
        const clean = await verify(VM);
        expect(clean, JSON.stringify(clean)).toMatchObject({
          status: 'verified',
          manifestSource: 'local',
          filesVerified: 3,
        });

        const notes = join(root, 'nested', 'notes.txt');
        await appendFile(notes, 'changed\n');
        await writeFile(join(root, 'extra.txt'), 'not in the master\n');
        const changed = await verify(VM);
        expect(changed).toMatchObject({
          status: 'modified',
          modified: { count: 1, paths: ['nested/notes.txt'] },
          unexpected: { count: 1, paths: ['extra.txt'] },
        });
        expect((await options(VM)).agents[0]?.local.contentStatus).toBe('modified');

        await writeFile(notes, 'original\n');
        await rm(join(root, 'extra.txt'));
        expect((await verify(VM)).status).toBe('verified');
        // Verifying wrote nothing into the VM.
        expect(await readFile(notes, 'utf8')).toBe('original\n');
      },
      LONG,
    );

    it(
      'launches real QEMU from the browser, and shows it running',
      async () => {
        const page = await (await browser.newContext()).newPage();
        await signIn(page);
        await page.goto(webUrl(`/admin/vms/qemu/${encodeURIComponent(VM)}`));
        const section = page.getByRole('region', { name: 'Run and verify' });
        const localMode = section.getByRole('radio', { name: 'Local', exact: true });
        await localMode.waitFor();
        expect(await localMode.isChecked()).toBe(true);
        // Remote Volatile cannot be chosen at all, and Remote Snapshot only from the version history,
        // since it runs a working copy that has to be prepared first.
        expect(
          await section
            .getByRole('radio', { name: 'Remote volatile (not available)' })
            .isDisabled(),
        ).toBe(true);
        expect(
          await section
            .getByRole('radio', { name: 'Remote snapshot (from the version history)' })
            .isDisabled(),
        ).toBe(true);
        await section.getByRole('button', { name: 'Launch' }).click();
        await section.getByText('Running', { exact: true }).first().waitFor({ timeout: 60_000 });
        await shot(page, 'execution-qemu-running');
        const list = (await admin.get(`/admin/sessions?vmName=${encodeURIComponent(VM)}`)).json<{
          sessions: VmSession[];
        }>().sessions;
        session = list[0] as VmSession;
        started.add(session.id);
        expect(session).toMatchObject({
          state: 'running',
          mode: 'local',
          gracefulStopAvailable: true,
        });
        expect(session.pid).toBeGreaterThan(0);
        launched = true;

        await page.goto(webUrl('/admin/catalog'));
        await page
          .getByText(/Running/)
          .first()
          .waitFor();
        await shot(page, 'execution-catalog-running');
        await page.context().close();
      },
      LONG,
    );

    it('refuses a second launch, a verification and a restore while it runs', async () => {
      requireLaunched();
      const again = await launch(VM);
      expect(again.json<{ error: { code: string } }>().error.code).toBe('session_active');
      const verification = await admin.request({
        method: 'POST',
        url: '/admin/verifications',
        payload: { agentId, emulatorType: 'qemu', vmName: VM },
      });
      expect(verification.json<{ error: { code: string } }>().error.code).toBe('session_active');
      const restore = await admin.request({
        method: 'POST',
        url: '/admin/restores',
        payload: { agentId, emulatorType: 'qemu', vmName: VM, versionId: session.versionId },
      });
      expect(restore.json<{ error: { code: string } }>().error.code).toBe('vm_running');
    });

    it(
      'asks for a graceful stop, which a guest without an OS ignores until it times out',
      async () => {
        requireLaunched();
        const response = await admin.request({
          method: 'POST',
          url: `/admin/sessions/${session.id}/stop`,
          payload: { force: false },
        });
        expect(response.statusCode, response.body).toBe(202);
        const timedOut = await waitFor(
          async () => {
            const current = await readSession(session.id);
            return current.error?.code === 'stop_timeout' ? current : null;
          },
          'the stop to time out',
          30_000,
        );
        expect(timedOut.state).toBe('running');
      },
      LONG,
    );

    it(
      'keeps the VM protected while the agent is away, and finds the same process after a restart',
      async () => {
        requireLaunched();
        await killAgent();
        try {
          const away = await readSession(session.id);
          expect(away).toMatchObject({ state: 'running', agentOnline: false });
          const verification = await admin.request({
            method: 'POST',
            url: '/admin/verifications',
            payload: { agentId, emulatorType: 'qemu', vmName: VM },
          });
          expect(verification.statusCode).toBe(409);
        } finally {
          // Whatever was found while it was away, the rest of the file needs the agent back.
          await startDaemon();
        }
        const found = await waitFor(
          async () => {
            const current = await readSession(session.id);
            return current.agentOnline && current.error?.code === 'graceful_stop_unavailable'
              ? current
              : null;
          },
          'the agent to find QEMU again',
          30_000,
        );
        expect(found).toMatchObject({
          state: 'running',
          pid: session.pid,
          processStartedAt: session.processStartedAt,
          gracefulStopAvailable: false,
        });
      },
      LONG,
    );

    it(
      'forces a stop from the browser only after the VM’s name is typed',
      async () => {
        requireLaunched();
        const page = await (await browser.newContext()).newPage();
        await signIn(page);
        await page.goto(webUrl(`/admin/vms/qemu/${encodeURIComponent(VM)}`));
        const section = page.getByRole('region', { name: 'Run and verify' });
        await section.getByRole('button', { name: 'Force stop…' }).click();
        const dialog = page.getByRole('dialog', { name: `Force ${VM} to stop` });
        const confirm = dialog.getByRole('button', { name: 'Force stop' });
        expect(await confirm.isDisabled()).toBe(true);
        await dialog.getByLabel(/to confirm/).fill(VM.toLowerCase());
        await shot(page, 'execution-force-stop');
        await confirm.click();
        const stopped = await sessionIn(session.id, ['stopped'], 30_000);
        expect(stopped.forceRequested).toBe(true);
        expect(stopped.endedAt).not.toBeNull();
        await page.getByRole('table').getByText('Stopped').first().waitFor();
        await shot(page, 'execution-history');
        await page.context().close();

        // Stopping deleted nothing.
        expect(existsSync(join(root, 'run.bat'))).toBe(true);
        expect((await verify(VM)).status).toBe('verified');
      },
      LONG,
    );
  });

  /**
   * Milestone 7 with nothing simulated: a snapshot of the verified local copy, a working copy of the
   * older master beside it, real QEMU in that working copy, an agent restart while it runs, a stop that
   * publishes nothing, a preservation that branches from the master, and a discard.
   */
  describe.skipIf(!HAVE_QEMU)('snapshots and Remote Snapshot', () => {
    const VM = 'E2E Snapshot';
    let root: string;
    let masterId: string;
    let snapshotId: string;
    let workspace: VmWorkspace;
    let session: VmSession | undefined;
    /** The persistent copy as it is once the snapshot is taken. Nothing after that may change it. */
    let persistent: Record<string, string>;

    const workspaceUrl = (suffix = '') => `/admin/workspaces/${workspace.id}${suffix}`;
    const readWorkspace = async () =>
      vmWorkspaceSchema.parse((await admin.get(workspaceUrl())).json());
    const tree = async () =>
      versionTreeResponseSchema.parse(
        (await admin.get(`/admin/vms/qemu/${encodeURIComponent(VM)}/versions`)).json(),
      );
    const finishedOperation = (id: string) =>
      waitFor(
        async () => {
          const operation = registrationOperationSchema.parse(
            (await admin.get(`/admin/registrations/${id}`)).json(),
          );
          return ['succeeded', 'failed', 'cancelled', 'partial_success'].includes(operation.state)
            ? operation
            : null;
        },
        'the snapshot to finish',
        120_000,
      );
    const repositoryArchives = () =>
      docker('exec', container, 'sh', '-c', 'cd /srv/sftp/repo && find archives -type f | sort')
        .split('\n')
        .filter(Boolean);
    function requireSession(): VmSession {
      if (!session)
        throw new Error('No working-copy session: the launch earlier in this group failed');
      return session;
    }

    beforeAll(async () => {
      root = join(qemu, VM);
      await mkdir(join(root, 'nested'), { recursive: true });
      await writeFile(
        join(root, 'run.bat'),
        '@echo off\r\nqemu-system-i386 -m 16 -nodefaults -display none\r\n',
      );
      await writeFile(join(root, 'disk.qcow2'), randomBytes(128 * 1024));
      await writeFile(join(root, 'nested', 'notes.txt'), 'master\n');
      await ensureAgentOnline();
      masterId = (await register(VM, 'qemu')).versionId;
    }, LONG);

    it(
      'snapshots the verified local copy as a child of its master',
      async () => {
        expect((await verify(VM)).status).toBe('verified');
        await writeFile(join(root, 'nested', 'notes.txt'), 'snapshot\n');
        const response = await admin.request({
          method: 'POST',
          url: `/admin/vms/qemu/${encodeURIComponent(VM)}/snapshots`,
          payload: { agentId, parentVersionId: masterId, requestId: randomUUID() },
        });
        expect(response.statusCode, response.body).toBe(202);
        const done = await finishedOperation(registrationOperationSchema.parse(response.json()).id);
        expect(done, JSON.stringify(done)).toMatchObject({
          state: 'succeeded',
          mode: 'snapshot',
          parentVersionId: masterId,
          localCopy: 'preserved',
        });
        snapshotId = done.versionId;
        const versions = (await tree()).versions;
        expect(versions.map((node) => [node.id, node.kind, node.parentVersionId])).toEqual([
          [masterId, 'master', null],
          [snapshotId, 'snapshot', masterId],
        ]);
        expect((await options(VM)).agents[0]?.local).toMatchObject({
          sourceVersionId: snapshotId,
          contentStatus: 'verified',
        });
        persistent = await fingerprint(root);
      },
      LONG,
    );

    it(
      'prepares a working copy of the older master, beside the persistent copy',
      async () => {
        const response = await admin.request({
          method: 'POST',
          url: `/admin/vms/qemu/${encodeURIComponent(VM)}/workspaces`,
          payload: { agentId, versionId: masterId, requestId: randomUUID(), launch: false },
        });
        expect(response.statusCode, response.body).toBe(202);
        workspace = vmWorkspaceSchema.parse(response.json());
        workspace = await waitFor(
          async () => {
            const current = await readWorkspace();
            return current.state === 'preparing' ? null : current;
          },
          'the working copy to be prepared',
          120_000,
        );
        expect(workspace, JSON.stringify(workspace)).toMatchObject({
          state: 'ready',
          baseVersionId: masterId,
          sourceVersionId: masterId,
          mayHaveChanges: false,
        });
        const directory = workspace.localDirectory as string;
        expect(directory).toBe(join(stateDirectory(), 'workspaces', workspace.id, VM));
        // The master's content, not the persistent copy's.
        expect(await readFile(join(directory, 'nested', 'notes.txt'), 'utf8')).toBe('master\n');
        expect(await fingerprint(root)).toEqual(persistent);
      },
      LONG,
    );

    it(
      'runs real QEMU from the working copy, never from the persistent copy',
      async () => {
        const response = await admin.request({
          method: 'POST',
          url: workspaceUrl('/launch'),
          payload: { requestId: randomUUID() },
        });
        expect(response.statusCode, response.body).toBe(202);
        const requested = vmSessionSchema.parse(response.json());
        started.add(requested.id);
        const live = await sessionIn(requested.id, ['running', 'failed', 'exited'], 60_000);
        expect(live, JSON.stringify(live)).toMatchObject({
          state: 'running',
          mode: 'remote_snapshot',
          workspaceId: workspace.id,
          versionId: masterId,
        });
        expect(live.pid).toBeGreaterThan(0);
        session = live;
        expect((await readWorkspace()).mayHaveChanges).toBe(true);
        expect(await fingerprint(root)).toEqual(persistent);
        // A working copy's session is the VM's session on this agent, for every purpose.
        const local = await launch(VM);
        expect(errorCode(local)).toBe('session_active');
      },
      LONG,
    );

    it('refuses to discard or snapshot while the working copy runs', async () => {
      requireSession();
      const discard = await admin.request({
        method: 'POST',
        url: workspaceUrl('/discard'),
        payload: { confirmVmName: VM },
      });
      expect(discard.statusCode, discard.body).toBe(409);
      expect(errorCode(discard)).toBe('vm_running');
      const preserve = await admin.request({
        method: 'POST',
        url: workspaceUrl('/snapshot'),
        payload: { requestId: randomUUID() },
      });
      expect(preserve.statusCode, preserve.body).toBe(409);
      expect((await readWorkspace()).state).toBe('ready');
    });

    it(
      'keeps the working copy and its session through an agent restart, refusing a discard meanwhile',
      async () => {
        const running = requireSession();
        await killAgent();
        try {
          expect(await readSession(running.id)).toMatchObject({
            state: 'running',
            agentOnline: false,
          });
          // Whether it still runs cannot be known while the agent is away, so nothing is removed.
          const discard = await admin.request({
            method: 'POST',
            url: workspaceUrl('/discard'),
            payload: { confirmVmName: VM },
          });
          expect(discard.statusCode, discard.body).toBe(409);
          expect(errorCode(discard)).toBe('vm_running');
        } finally {
          await startDaemon();
        }
        const found = await waitFor(
          async () => {
            const current = await readSession(running.id);
            return current.agentOnline && current.error?.code === 'graceful_stop_unavailable'
              ? current
              : null;
          },
          'the agent to find QEMU again',
          30_000,
        );
        expect(found).toMatchObject({
          state: 'running',
          pid: running.pid,
          workspaceId: workspace.id,
        });
        expect(await readWorkspace()).toMatchObject({ state: 'ready', mayHaveChanges: true });
        expect(existsSync(workspace.localDirectory as string)).toBe(true);
      },
      LONG,
    );

    it(
      'stops without publishing anything, and asks for the name before discarding changes',
      async () => {
        const running = requireSession();
        const archivesBefore = repositoryArchives();
        const versionsBefore = (await tree()).versions.length;
        const response = await admin.request({
          method: 'POST',
          url: `/admin/sessions/${running.id}/stop`,
          payload: { force: true, confirmVmName: VM },
        });
        expect(response.statusCode, response.body).toBe(202);
        expect((await sessionIn(running.id, ['stopped'], 30_000)).forceRequested).toBe(true);
        expect(repositoryArchives(), 'a stop uploads nothing').toEqual(archivesBefore);
        expect((await tree()).versions).toHaveLength(versionsBefore);
        expect(await readWorkspace()).toMatchObject({ state: 'ready', mayHaveChanges: true });

        const unconfirmed = await admin.request({
          method: 'POST',
          url: workspaceUrl('/discard'),
          payload: {},
        });
        expect(unconfirmed.statusCode, unconfirmed.body).toBe(400);
        expect(errorCode(unconfirmed)).toBe('confirmation_required');
        expect(existsSync(workspace.localDirectory as string)).toBe(true);
      },
      LONG,
    );

    it(
      'preserves the working copy as a new snapshot, branching from the master',
      async () => {
        requireSession();
        // What the guest would have written.
        await writeFile(
          join(workspace.localDirectory as string, 'nested', 'notes.txt'),
          'working copy\n',
        );
        const response = await admin.request({
          method: 'POST',
          url: workspaceUrl('/snapshot'),
          payload: { requestId: randomUUID() },
        });
        expect(response.statusCode, response.body).toBe(202);
        const done = await finishedOperation(registrationOperationSchema.parse(response.json()).id);
        expect(done, JSON.stringify(done)).toMatchObject({
          state: 'succeeded',
          mode: 'snapshot',
          parentVersionId: masterId,
        });
        const branch = done.versionId;
        const versions = (await tree()).versions;
        expect(versions.find((node) => node.id === masterId)?.childVersionIds.sort()).toEqual(
          [snapshotId, branch].sort(),
        );
        expect(versions.find((node) => node.id === branch)?.parentVersionId).toBe(masterId);
        expect(await readWorkspace()).toMatchObject({
          state: 'ready',
          sourceVersionId: branch,
          mayHaveChanges: false,
        });
        // The persistent copy still comes from the first snapshot, untouched.
        expect(await fingerprint(root)).toEqual(persistent);
        expect((await options(VM)).agents[0]?.local.sourceVersionId).toBe(snapshotId);
      },
      LONG,
    );

    it(
      'discards the stopped working copy, and leaves the persistent copy verified',
      async () => {
        requireSession();
        const directory = workspace.localDirectory as string;
        // Everything is preserved, so no confirmation is needed.
        const response = await admin.request({
          method: 'POST',
          url: workspaceUrl('/discard'),
          payload: {},
        });
        expect(response.statusCode, response.body).toBe(200);
        const discarded = await waitFor(
          async () => {
            const current = await readWorkspace();
            return current.state === 'discarded' ? current : null;
          },
          'the working copy to be discarded',
          30_000,
        );
        expect(discarded.error).toBeNull();
        expect(existsSync(directory)).toBe(false);
        expect(existsSync(join(stateDirectory(), 'workspaces', workspace.id))).toBe(false);
        expect(await fingerprint(root)).toEqual(persistent);
        expect((await verify(VM)).status).toBe('verified');
      },
      LONG,
    );
  });

  describe.skipIf(!HAVE_86BOX)('86Box', () => {
    const VM = 'E2E 86Box';

    beforeAll(async () => {
      const root = join(box86, VM);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, '86box.cfg'), BOX86_CONFIG);
      await ensureAgentOnline();
      await register(VM, '86box');
    }, LONG);

    it(
      'launches real 86Box and closes it gracefully',
      async () => {
        const response = await launch(VM, '86box');
        expect(response.statusCode, response.body).toBe(202);
        const { id } = vmSessionSchema.parse(response.json());
        started.add(id);
        const live = await sessionIn(id, ['running', 'failed'], 60_000);
        expect(live, JSON.stringify(live)).toMatchObject({
          state: 'running',
          gracefulStopAvailable: true,
        });
        await new Promise((done) => setTimeout(done, 3_000));
        const stop = await admin.request({
          method: 'POST',
          url: `/admin/sessions/${id}/stop`,
          payload: { force: false },
        });
        expect(stop.statusCode, stop.body).toBe(202);
        const stopped = await sessionIn(id, ['stopped', 'exited'], 60_000);
        expect(stopped).toMatchObject({ state: 'stopped', exitCode: 0, forceRequested: false });
        expect(stopped.error).toBeNull();

        // 86Box writes its settings and NVRAM as it runs, which a verification reports faithfully.
        const after = await verify(VM, '86box');
        expect(['verified', 'modified']).toContain(after.status);
        console.log('86Box copy after a run:', JSON.stringify(after));
      },
      LONG,
    );
  });
});
