/**
 * Registration with nothing simulated: the compiled agent, the real API on a real database, and a real
 * OpenSSH server in a container. Every VM here is a disposable directory this file creates, and it
 * proves after each failure that the source was not touched.
 *
 * Run with `pnpm test:e2e`, which builds the agent first. It needs MariaDB, Docker and `ssh-keygen`, and
 * runs on Windows only, until another platform has a credential store.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  discoveryOperationSchema,
  discoveryStateResponseSchema,
  pairingRequestReviewSchema,
  registrationOperationSchema,
  repositoryListResponseSchema,
  repositorySummarySchema,
  type RegistrationOperation,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENEROUS_RATE_LIMITS, waitFor } from '../test/agent-helpers.js';
import {
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
const LONG = 180_000;

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

class SftpServer {
  container = `emucat-e2e-sftp-${randomUUID().slice(0, 8)}`;
  port = 0;

  constructor(
    private readonly clientKey: string,
    private readonly hostKey: string,
  ) {}

  async start(hostKey = this.hostKey): Promise<void> {
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      this.container,
      '-p',
      this.port ? `127.0.0.1:${this.port}:22` : '127.0.0.1:0:22',
      '--tmpfs',
      '/srv/sftp/repo:size=2g',
      '-e',
      `HOST_KEY_B64=${readFileSync(hostKey).toString('base64')}`,
      '-e',
      `AUTHORIZED_KEY=${readFileSync(`${this.clientKey}.pub`, 'utf8').trim()}`,
      IMAGE,
    );
    this.port = Number(docker('port', this.container, '22/tcp').split(':').pop());
    await waitFor(
      () => {
        try {
          return docker('logs', this.container).length >= 0 && this.listening();
        } catch {
          return false;
        }
      },
      'the SFTP server to start',
      30_000,
    );
  }

  private listening(): boolean {
    const logs = execFileSync('docker', ['logs', this.container], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return /Server listening/.test(logs) || this.exec('pgrep sshd').length > 0;
  }

  stop(): void {
    try {
      docker('rm', '-f', this.container);
    } catch {
      // Already gone.
    }
  }

  exec(command: string): string {
    return docker('exec', this.container, 'sh', '-c', command);
  }

  killSessions(): void {
    try {
      this.exec("pkill -KILL -f 'sshd.*emucat' || true");
    } catch {
      // A session may have just ended by itself.
    }
  }

  /** Everything stored, relative to the root. */
  files(): string[] {
    const listing = this.exec('cd /srv/sftp/repo && find . -type f | sort');
    return listing === '' ? [] : listing.split('\n').map((line) => line.replace(/^\.\//, ''));
  }
}

/** Everything under a directory, including when and what, for proving that nothing changed. */
async function fingerprint(root: string): Promise<string[]> {
  const entries: string[] = [];
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const path = join(root, String(name));
    const info = await stat(path);
    const contents = info.isFile()
      ? createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
      : '';
    entries.push(`${String(name)}|${info.size}|${info.mtimeMs}|${contents}`);
  }
  return entries;
}

describe.runIf(process.platform === 'win32')('registration with nothing simulated', () => {
  let context: BrowserTestContext;
  let server: FastifyInstance;
  let admin: TestClient;
  let port: number;
  let directory: string;
  let configPath: string;
  let box86: string;
  let qemu: string;
  let sftp: SftpServer;
  let hostKey: string;
  let otherHostKey: string;
  let repositoryId: string;
  let agentId: string;
  const running: ChildProcess[] = [];
  const allOutput: string[] = [];
  const apiSockets: Socket[] = [];

  function trackSockets(instance: FastifyInstance): void {
    instance.server.on('connection', (socket: Socket) => apiSockets.push(socket));
  }

  function startAgent(...args: string[]) {
    const child = spawn(AGENT_BINARY, [...args, '--config', configPath, '--log-level', 'debug'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += String(chunk);
      allOutput.push(String(chunk));
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
    return response.json<{ online: boolean }>().online;
  }

  /** Stops the agent as a crash would, with no chance to clean anything up. */
  async function killAgent(): Promise<void> {
    daemon.child.kill('SIGKILL');
    await daemon.exited;
  }

  async function startDaemon(): Promise<void> {
    daemon = startAgent('run');
    await waitFor(isOnline, 'the agent to be online', 30_000);
    // The server knows it can register once it has handled the agent's sync.
    await new Promise((done) => setTimeout(done, 300));
  }

  async function startServer(): Promise<void> {
    server = await context.buildAnother();
    trackSockets(server);
    await server.listen({ host: '127.0.0.1', port });
    const moved = new TestClient(server);
    moved.cookie = admin.cookie;
    moved.csrfToken = admin.csrfToken;
    admin = moved;
  }

  function writeConfig(): Promise<void> {
    const executable = join(directory, 'emulator.exe');
    return writeFile(
      configPath,
      [
        '[server]',
        `api_url = ${JSON.stringify(`http://127.0.0.1:${port}`)}`,
        '[agent]',
        'name = "E2E registrar"',
        '[emulators.86box]',
        `base_path = ${JSON.stringify(box86)}`,
        `executable = ${JSON.stringify(executable)}`,
        '[emulators.qemu]',
        `base_path = ${JSON.stringify(qemu)}`,
        `executable = ${JSON.stringify(executable)}`,
        '[state]',
        `dir = ${JSON.stringify(join(directory, 'state'))}`,
        '[storage]',
        `staging_dir = ${JSON.stringify(join(directory, 'staging'))}`,
        `[repositories."${repositoryId}"]`,
        'kind = "sftp"',
        'host = "127.0.0.1"',
        `port = ${sftp.port}`,
        'username = "emucat"',
        'remote_root = "/repo"',
        `private_key_path = ${JSON.stringify(join(directory, 'keys', 'client'))}`,
        `host_key_fingerprints = [${JSON.stringify(fingerprintOf(hostKey))}]`,
        'connect_timeout_seconds = 10',
        'transfer_timeout_seconds = 15',
        'connect_retries = 1',
        'upload_attempts = 2',
        '',
      ].join('\n'),
    );
  }

  /** A QEMU VM with random, incompressible contents, so that its size is really transferred. */
  async function makeQemuVm(name: string, megabytes: number): Promise<string> {
    const root = join(qemu, name);
    await mkdir(join(root, 'nvram', 'empty'), { recursive: true });
    await writeFile(join(root, 'run.bat'), '@echo this must never be run\r\n');
    await writeFile(join(root, 'nvram', 'state.bin'), randomBytes(1024));
    const chunk = randomBytes(1024 * 1024);
    const disk = Buffer.alloc(megabytes * 1024 * 1024);
    for (let offset = 0; offset < disk.length; offset += chunk.length) {
      chunk.copy(disk, offset);
      disk.writeUInt32LE(offset, offset);
    }
    await writeFile(join(root, 'disk.qcow2'), disk);
    return root;
  }

  async function discover(vmName: string) {
    const started = await admin.request({
      method: 'POST',
      url: `/admin/agents/${agentId}/discovery`,
    });
    expect(started.statusCode, started.body).toBe(202);
    const { id } = discoveryOperationSchema.parse(started.json());
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

  async function register(
    vmName: string,
    emulatorType: 'qemu' | '86box',
    mode: 'copy' | 'transfer',
  ): Promise<RegistrationOperation> {
    const discovery = await discover(vmName);
    const response = await admin.request({
      method: 'POST',
      url: '/admin/registrations',
      payload: {
        agentId,
        repositoryId,
        emulatorType,
        vmName,
        mode,
        discoveryOperationId: discovery.id,
        ...(mode === 'transfer' ? { confirmDestructive: true } : {}),
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    return registrationOperationSchema.parse(response.json());
  }

  async function read(operationId: string): Promise<RegistrationOperation> {
    const response = await admin.get(`/admin/registrations/${operationId}`);
    return registrationOperationSchema.parse(response.json());
  }

  async function until(
    operationId: string,
    check: (operation: RegistrationOperation) => boolean,
    what: string,
    timeoutMs = 120_000,
  ): Promise<RegistrationOperation> {
    return waitFor(
      async () => {
        const operation = await read(operationId);
        return check(operation) ? operation : null;
      },
      what,
      timeoutMs,
    );
  }

  const finished = (operationId: string) =>
    until(
      operationId,
      (operation) =>
        ['succeeded', 'failed', 'cancelled', 'partial_success'].includes(operation.state),
      'the operation to finish',
    );

  const uploading = (operationId: string) =>
    until(
      operationId,
      (operation) => operation.state === 'uploading' && (operation.progress.doneBytes ?? 0) > 0,
      'the upload to be under way',
    );

  async function mastersOf(vmName: string): Promise<RowDataPacket[]> {
    const [rows] = await context.pool.execute<RowDataPacket[]>(
      "SELECT * FROM vm_versions WHERE vm_name = ? AND kind = 'master'",
      [vmName],
    );
    return rows;
  }

  beforeAll(async () => {
    if (!existsSync(AGENT_BINARY)) throw new Error(`Build the agent first: ${AGENT_BINARY}`);
    docker('build', '-q', '-t', IMAGE, IMAGE_CONTEXT);

    directory = await mkdtemp(join(tmpdir(), 'emucat-e2e-registration-'));
    box86 = join(directory, 'box86');
    qemu = join(directory, 'qemu');
    await mkdir(box86);
    await mkdir(qemu);
    await writeFile(join(directory, 'emulator.exe'), '');
    await mkdir(join(directory, 'keys'));
    const clientKey = join(directory, 'keys', 'client');
    hostKey = join(directory, 'keys', 'host');
    otherHostKey = join(directory, 'keys', 'other-host');
    generateKey(clientKey);
    generateKey(hostKey);
    generateKey(otherHostKey);
    sftp = new SftpServer(clientKey, hostKey);
    await sftp.start();

    context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
    admin = await signedInAdmin(context);
    server = context.app;
    trackSockets(server);
    await server.listen({ host: '127.0.0.1', port: 0 });
    port = (server.server.address() as AddressInfo).port;

    const created = await admin.request({
      method: 'POST',
      url: '/admin/repositories',
      payload: {
        name: 'E2E repository',
        host: '127.0.0.1',
        port: sftp.port,
        username: 'emucat',
        remoteRoot: '/repo',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    repositoryId = repositorySummarySchema.parse(created.json()).id;

    configPath = join(directory, 'agent.toml');
    await writeConfig();

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

    await startDaemon();
  }, LONG);

  afterAll(async () => {
    for (const child of running) child.kill('SIGKILL');
    sftp?.stop();
    await context?.close();
    if (directory) {
      await new Promise((done) => setTimeout(done, 500));
      await rm(directory, { recursive: true, force: true });
    }
  }, LONG);

  it('tests the repository through the agent, and records the trusted key', async () => {
    const associated = await admin.request({
      method: 'PUT',
      url: `/admin/repositories/${repositoryId}/agents/${agentId}`,
    });
    expect(associated.statusCode, associated.body).toBe(200);
    const started = await admin.request({
      method: 'POST',
      url: `/admin/repositories/${repositoryId}/agents/${agentId}/health-check`,
    });
    expect(started.statusCode, started.body).toBe(202);
    const summary = await waitFor(async () => {
      const { repositories } = repositoryListResponseSchema.parse(
        (await admin.get('/admin/repositories')).json(),
      );
      return repositories[0]?.agents[0]?.checkInProgress === false ? repositories[0] : null;
    }, 'the health check');
    expect(summary.status, JSON.stringify(summary)).toBe('healthy');
    expect(summary.agents[0]?.hostKeyFingerprint).toBe(fingerprintOf(hostKey));
    expect(summary.lastSuccessfulCheckAt).not.toBeNull();
    expect(sftp.files(), 'the check left nothing behind').toEqual([]);
  });

  it(
    'copies a VM directly to the repository, verified, without passing through the API',
    async () => {
      const root = await makeQemuVm('Copy Me', 48);
      const before = await fingerprint(root);
      const bytesBefore = apiSockets.reduce((sum, socket) => sum + socket.bytesRead, 0);

      const operation = await register('Copy Me', 'qemu', 'copy');
      const done = await finished(operation.id);
      expect(done, JSON.stringify(done)).toMatchObject({
        state: 'succeeded',
        localCopy: 'preserved',
        error: null,
      });

      // Local source preservation.
      expect(await fingerprint(root)).toEqual(before);

      // Direct transfer: the archive is tens of megabytes, and the API received only small messages.
      const received = apiSockets.reduce((sum, socket) => sum + socket.bytesRead, 0) - bytesBefore;
      expect(done.archive?.sizeBytes).toBeGreaterThan(48 * 1024 * 1024);
      expect(received, 'bytes the API received').toBeLessThan(512 * 1024);

      // The server's own tools confirm the hash the agent reported, without either of them trusting it.
      expect(sftp.files()).toEqual([`archives/qemu/copy me/${done.versionId}.zip`]);
      const path = `/srv/sftp/repo/${done.archiveKey}`;
      expect(sftp.exec(`sha256sum '${path}' | cut -d' ' -f1`)).toBe(done.archive?.sha256);
      expect(Number(sftp.exec(`stat -c %s '${path}'`))).toBe(done.archive?.sizeBytes);

      // The ZIP's contents and manifest.
      const listing = sftp.exec(`unzip -l '${path}'`);
      for (const name of [
        'run.bat',
        'disk.qcow2',
        'nvram/state.bin',
        'nvram/empty/',
        '.emucat-manifest.json',
      ]) {
        expect(listing, name).toContain(name);
      }
      expect(listing).not.toContain('Copy Me/');
      const manifest = JSON.parse(sftp.exec(`unzip -p '${path}' .emucat-manifest.json`)) as {
        manifestVersion: number;
        vmName: string;
        fileCount: number;
        entries: { path: string; type: string; sha256?: string; sizeBytes?: number }[];
      };
      expect(manifest).toMatchObject({ manifestVersion: 1, vmName: 'Copy Me', fileCount: 3 });
      expect(manifest.entries.map((entry) => entry.path)).toEqual(
        [...manifest.entries.map((entry) => entry.path)].sort(),
      );
      const disk = manifest.entries.find((entry) => entry.path === 'disk.qcow2');
      expect(disk?.sha256).toBe(
        createHash('sha256')
          .update(await readFile(join(root, 'disk.qcow2')))
          .digest('hex'),
      );
      // Extracting it, on the server, gives back exactly the source's bytes.
      expect(sftp.exec(`unzip -p '${path}' disk.qcow2 | sha256sum | cut -d' ' -f1`)).toBe(
        disk?.sha256,
      );
    },
    LONG,
  );

  it('creates exactly one master, and a private catalog entry', async () => {
    const masters = await mastersOf('Copy Me');
    expect(masters).toHaveLength(1);
    expect(masters[0]).toMatchObject({ parent_version_id: null, snapshot_name: null });
    const privateList = await admin.get('/admin/vms');
    expect(
      privateList.json<{ items: { vmName: string; visibility: string }[] }>().items,
    ).toMatchObject([{ vmName: 'Copy Me', visibility: 'private' }]);
    const publicList = await server.inject({
      url: '/api/v1/catalog/vms',
      headers: { host: 'emucat.test' },
    });
    expect(publicList.json<{ items: unknown[] }>().items).toEqual([]);
    const [state] = await context.pool.execute<RowDataPacket[]>(
      'SELECT * FROM agent_vm_state WHERE vm_name = ?',
      ['Copy Me'],
    );
    expect(state[0]).toMatchObject({
      execution_state: 'idle',
      content_status: 'verified',
      local_source_version_id: masters[0]?.id,
    });
  });

  it('refuses to register the same VM twice', async () => {
    const discovery = await discover('Copy Me');
    expect(discovery.vms.find((vm) => vm.vmName === 'Copy Me')?.registered).toBe(true);
    const response = await admin.request({
      method: 'POST',
      url: '/admin/registrations',
      payload: {
        agentId,
        repositoryId,
        emulatorType: 'qemu',
        vmName: 'Copy Me',
        mode: 'copy',
        discoveryOperationId: discovery.id,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(await mastersOf('Copy Me')).toHaveLength(1);
  });

  it(
    'transfers a disposable VM, deleting it only after the verified commit',
    async () => {
      const root = await makeQemuVm('Transfer Me', 8);
      const operation = await register('Transfer Me', 'qemu', 'transfer');
      const done = await finished(operation.id);
      expect(done, JSON.stringify(done)).toMatchObject({
        state: 'succeeded',
        localCopy: 'removed',
      });

      expect(existsSync(root), 'the local VM is gone').toBe(false);
      expect((await readdir(qemu)).filter((name) => name.startsWith('.emucat-removing'))).toEqual(
        [],
      );
      expect(await mastersOf('Transfer Me')).toHaveLength(1);
      const path = `/srv/sftp/repo/${done.archiveKey}`;
      expect(sftp.exec(`sha256sum '${path}' | cut -d' ' -f1`)).toBe(done.archive?.sha256);
      const [state] = await context.pool.execute<RowDataPacket[]>(
        'SELECT * FROM agent_vm_state WHERE vm_name = ?',
        ['Transfer Me'],
      );
      expect(state[0]).toMatchObject({ execution_state: 'absent', local_source_version_id: null });
    },
    LONG,
  );

  it(
    'blocks a transfer when screenshots would be lost, and archives none in a copy',
    async () => {
      const root = join(box86, 'Has Media');
      await mkdir(join(root, 'screenshots'), { recursive: true });
      await writeFile(join(root, '86box.cfg'), 'machine = x\n');
      await writeFile(join(root, 'disk.img'), randomBytes(4096));
      await writeFile(join(root, 'screenshots', 'one.png'), 'a screenshot');
      const before = await fingerprint(root);

      const blocked = await register('Has Media', '86box', 'transfer');
      const failed = await finished(blocked.id);
      expect(failed.state, JSON.stringify(failed)).toBe('failed');
      expect(failed.error?.code).toBe('transfer_blocked_media');
      expect(failed.recovery).toMatch(/Copy/);
      expect(await fingerprint(root)).toEqual(before);
      expect(await mastersOf('Has Media')).toEqual([]);

      const copied = await register('Has Media', '86box', 'copy');
      const done = await finished(copied.id);
      expect(done.state, JSON.stringify(done)).toBe('succeeded');
      const listing = sftp.exec(`unzip -l '/srv/sftp/repo/${done.archiveKey}'`);
      expect(listing).toContain('86box.cfg');
      expect(listing).not.toMatch(/screenshots/i);
      expect(await fingerprint(root)).toEqual(before);
    },
    LONG,
  );

  it(
    'retries an upload that was interrupted once, and ends with one verified master',
    async () => {
      const root = await makeQemuVm('Interrupted Once', 96);
      const operation = await register('Interrupted Once', 'qemu', 'copy');
      await uploading(operation.id);
      sftp.killSessions();
      const done = await finished(operation.id);
      expect(done.state, JSON.stringify(done)).toBe('succeeded');
      expect(existsSync(root)).toBe(true);
      expect(sftp.exec(`sha256sum '/srv/sftp/repo/${done.archiveKey}' | cut -d' ' -f1`)).toBe(
        done.archive?.sha256,
      );
      expect(await mastersOf('Interrupted Once')).toHaveLength(1);
      expect(sftp.files().filter((file) => file.startsWith('archives/.staging'))).toEqual([]);
    },
    LONG,
  );

  it(
    'fails safely when the upload keeps being interrupted, even for a transfer',
    async () => {
      const root = await makeQemuVm('Keeps Failing', 96);
      const before = await fingerprint(root);
      const operation = await register('Keeps Failing', 'qemu', 'transfer');
      await uploading(operation.id);
      const killer = setInterval(() => sftp.killSessions(), 150);
      let done: RegistrationOperation;
      try {
        done = await finished(operation.id);
      } finally {
        clearInterval(killer);
      }
      expect(done.state, JSON.stringify(done)).toBe('failed');
      expect(done.localCopy).toBe('preserved');
      expect(
        ['upload_interrupted', 'repository_unreachable'],
        JSON.stringify(done.error),
      ).toContain(done.error?.code);
      expect(await fingerprint(root), 'the source is untouched').toEqual(before);
      expect(await mastersOf('Keeps Failing')).toEqual([]);
      expect(
        sftp.files().filter((file) => file.includes(done.versionId)),
        'nothing was published',
      ).toEqual([]);
      // Once the repository is reachable again, what the failed attempts left is tidied away.
      await waitFor(
        () => !sftp.files().includes(`archives/.staging/${operation.id}.part`),
        'the staging object to be removed',
        60_000,
      );
    },
    LONG,
  );

  it(
    'cancels during the upload, keeping the source and cleaning up',
    async () => {
      const root = await makeQemuVm('Cancel Me', 96);
      const before = await fingerprint(root);
      const operation = await register('Cancel Me', 'qemu', 'transfer');
      await uploading(operation.id);
      const cancelled = await admin.request({
        method: 'POST',
        url: `/admin/registrations/${operation.id}/cancel`,
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      const done = await finished(operation.id);
      expect(done.state, JSON.stringify(done)).toBe('cancelled');
      expect(await fingerprint(root)).toEqual(before);
      expect(await mastersOf('Cancel Me')).toEqual([]);
      await waitFor(
        () => !sftp.files().includes(`archives/.staging/${operation.id}.part`),
        'the staging object to be removed',
        30_000,
      );
      expect(await readdir(join(directory, 'staging'))).toEqual([]);
    },
    LONG,
  );

  it(
    'survives an API restart during an upload, without any false success',
    async () => {
      const root = await makeQemuVm('Api Restart', 128);
      const operation = await register('Api Restart', 'qemu', 'copy');
      await uploading(operation.id);
      await server.close();

      // The upload carries on directly to the repository, with no API at all.
      const [row] = await context.pool.execute<RowDataPacket[]>(
        'SELECT state FROM registration_operations WHERE id = ?',
        [operation.id],
      );
      expect(row[0]?.state).toBe('uploading');
      await waitFor(
        () => sftp.files().includes(operation.archiveKey),
        'the archive to be published while the API is down',
        120_000,
      );
      expect(await mastersOf('Api Restart'), 'no API, no master').toEqual([]);

      await startServer();
      await waitFor(isOnline, 'the agent to reconnect', 60_000);
      const done = await finished(operation.id);
      expect(done.state, JSON.stringify(done)).toBe('succeeded');
      expect(await mastersOf('Api Restart')).toHaveLength(1);
      expect(existsSync(root)).toBe(true);
    },
    LONG,
  );

  it(
    'survives an agent crash during an upload: nothing is deleted, and retrying works',
    async () => {
      const root = await makeQemuVm('Agent Crash', 128);
      const before = await fingerprint(root);
      const operation = await register('Agent Crash', 'qemu', 'transfer');
      await uploading(operation.id);
      await killAgent();
      expect(await fingerprint(root)).toEqual(before);
      expect((await read(operation.id)).state, 'no false outcome while it is away').toBe(
        'uploading',
      );

      await startDaemon();
      const failed = await finished(operation.id);
      expect(failed.state, JSON.stringify(failed)).toBe('failed');
      expect(failed.error?.code).toBe('agent_restarted');
      expect(await fingerprint(root), 'a restart deletes nothing').toEqual(before);
      await waitFor(
        () => !sftp.files().includes(`archives/.staging/${operation.id}.part`),
        'the partial object to be removed',
        30_000,
      );

      const retry = await register('Agent Crash', 'qemu', 'copy');
      expect(retry.versionId).not.toBe(operation.versionId);
      const done = await finished(retry.id);
      expect(done.state, JSON.stringify(done)).toBe('succeeded');
      expect(await mastersOf('Agent Crash')).toHaveLength(1);
    },
    LONG,
  );

  it(
    'recovers a lost acknowledgement: a transfer finishes only once the commit is confirmed',
    async () => {
      const root = await makeQemuVm('Lost Ack', 64);
      const before = await fingerprint(root);
      const operation = await register('Lost Ack', 'qemu', 'transfer');
      await uploading(operation.id);

      // The server goes away, the agent publishes without it, and then the agent crashes as well.
      await server.close();
      await waitFor(
        () => sftp.files().includes(operation.archiveKey),
        'the archive to be published',
        120_000,
      );
      await new Promise((done) => setTimeout(done, 500));
      await killAgent();
      expect(await fingerprint(root), 'published, but not committed: nothing is deleted').toEqual(
        before,
      );

      // Back up. Starting the agent alone must not delete anything.
      daemon = startAgent('run');
      await new Promise((done) => setTimeout(done, 2000));
      expect(await fingerprint(root)).toEqual(before);

      await startServer();
      await waitFor(isOnline, 'the agent to reconnect', 60_000);
      const done = await finished(operation.id);
      expect(done, JSON.stringify(done)).toMatchObject({
        state: 'succeeded',
        localCopy: 'removed',
      });
      expect(existsSync(root)).toBe(false);
      expect(await mastersOf('Lost Ack')).toHaveLength(1);
    },
    LONG,
  );

  it(
    'refuses a changed host key, and keeps the source',
    async () => {
      const root = await makeQemuVm('Host Key', 4);
      const before = await fingerprint(root);

      sftp.stop();
      await sftp.start(otherHostKey);
      const operation = await register('Host Key', 'qemu', 'transfer');
      const failed = await finished(operation.id);
      expect(failed.state, JSON.stringify(failed)).toBe('failed');
      expect(failed.error?.code).toBe('host_key_changed');
      expect(failed.error?.message).toContain(fingerprintOf(otherHostKey));
      expect(await fingerprint(root)).toEqual(before);
      expect(sftp.files(), 'nothing was sent to the impostor').toEqual([]);

      await admin.request({
        method: 'POST',
        url: `/admin/repositories/${repositoryId}/agents/${agentId}/health-check`,
      });
      const summary = await waitFor(async () => {
        const { repositories } = repositoryListResponseSchema.parse(
          (await admin.get('/admin/repositories')).json(),
        );
        return repositories[0]?.agents[0]?.checkInProgress === false ? repositories[0] : null;
      }, 'the health check');
      expect(summary.status).toBe('failing');
      expect(summary.agents[0]?.errorCode).toBe('host_key_changed');

      sftp.stop();
      await sftp.start();
    },
    LONG,
  );

  it(
    'ends a running registration when the agent is revoked, keeping the source',
    async () => {
      const root = await makeQemuVm('Revoked', 128);
      const before = await fingerprint(root);
      const operation = await register('Revoked', 'qemu', 'transfer');
      await uploading(operation.id);
      const revoked = await admin.request({
        method: 'POST',
        url: `/admin/agents/${agentId}/revoke`,
      });
      expect(revoked.statusCode).toBe(200);
      const failed = await finished(operation.id);
      expect(failed).toMatchObject({ state: 'failed', error: { code: 'agent_revoked' } });
      expect(await daemon.exited, 'the agent stops').toBe(1);
      expect(await fingerprint(root)).toEqual(before);
      expect(await mastersOf('Revoked')).toEqual([]);
    },
    LONG,
  );

  it('never logged a private key, a credential or a passphrase', async () => {
    const all = allOutput.join('');
    expect(all).toContain('Archive published');
    expect(all).not.toContain('PRIVATE KEY');
    const clientKey = readFileSync(join(directory, 'keys', 'client'), 'utf8');
    const secretLine = clientKey.split('\n')[1] as string;
    expect(all).not.toContain(secretLine);
    expect(all).not.toMatch(/emucat_agent_[A-Za-z0-9_-]{20}/);
    const config = readFileSync(configPath, 'utf8');
    expect(config).not.toContain('PRIVATE KEY');
    const stored = await context.pool.query<RowDataPacket[]>(
      'SELECT config, secret_ref FROM repositories',
    );
    expect(JSON.stringify(stored[0])).not.toContain('PRIVATE KEY');
  });
});
