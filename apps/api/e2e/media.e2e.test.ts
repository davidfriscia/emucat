/**
 * Screenshots with nothing simulated: the compiled agent, the real API on a real database, real image
 * conversion, and a real OpenSSH server for the archives. Every VM here is a disposable directory this
 * file creates. No real user directory is ever configured, read or touched.
 *
 * Run with `pnpm test:e2e`. It needs MariaDB, Docker and `ssh-keygen`, and runs on Windows only, until
 * another platform has a credential store.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  adminMediaDetailSchema,
  adminMediaListResponseSchema,
  adminMediaSyncResponseSchema,
  discoveryOperationSchema,
  discoveryStateResponseSchema,
  pairingRequestReviewSchema,
  publicCatalogResponseSchema,
  registrationOperationSchema,
  repositorySummarySchema,
  type AdminMedia,
  type RegistrationOperation,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENEROUS_RATE_LIMITS, waitFor } from '../test/agent-helpers.js';
import {
  HOST,
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

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

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

const png = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();

/** What QEMU's `screendump` writes. */
function ppm(width: number, height: number, red: number, green: number, blue: number): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 3) {
    pixels[index] = red;
    pixels[index + 1] = green;
    pixels[index + 2] = blue;
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

async function fingerprint(root: string): Promise<string[]> {
  const entries: string[] = [];
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const path = join(root, String(name));
    const info = await stat(path);
    const contents = info.isFile() ? sha(await readFile(path)) : '';
    entries.push(`${String(name)}|${info.size}|${info.mtimeMs}|${contents}`);
  }
  return entries;
}

describe.runIf(process.platform === 'win32')('screenshots with nothing simulated', () => {
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
  let sftpPort: number;
  const running: ChildProcess[] = [];
  const allOutput: string[] = [];
  const apiSockets: Socket[] = [];

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
    return response.statusCode === 200 && response.json<{ online: boolean }>().online;
  }

  async function startDaemon(): Promise<void> {
    daemon = startAgent('run');
    await waitFor(isOnline, 'the agent to be online', 30_000);
    await new Promise((done) => setTimeout(done, 300));
  }

  async function killAgent(): Promise<void> {
    daemon.child.kill('SIGKILL');
    await daemon.exited;
    await waitFor(async () => !(await isOnline()), 'the agent to be offline', 30_000);
  }

  function track(instance: FastifyInstance): void {
    instance.server.on('connection', (socket: Socket) => apiSockets.push(socket));
  }

  async function startServer(): Promise<void> {
    server = await context.buildAnother();
    track(server);
    await server.listen({ host: '127.0.0.1', port });
    const moved = new TestClient(server);
    moved.cookie = admin.cookie;
    moved.csrfToken = admin.csrfToken;
    admin = moved;
  }

  async function stopServer(): Promise<void> {
    for (const socket of apiSockets) socket.destroy();
    apiSockets.length = 0;
    await server.close();
  }

  const box86Vm = async (name: string) => {
    const root = join(box86, name);
    await mkdir(join(root, 'screenshots'), { recursive: true });
    await writeFile(join(root, '86box.cfg'), 'machine = x\n');
    await writeFile(join(root, 'disk.img'), randomBytes(64 * 1024));
    return root;
  };

  const qemuVm = async (name: string, megabytes = 1) => {
    const root = join(qemu, name);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'run.bat'), '@echo this must never be run\r\n');
    await writeFile(join(root, 'disk.qcow2'), randomBytes(megabytes * 1024 * 1024));
    return root;
  };

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

  const finished = (operationId: string) =>
    waitFor(
      async () => {
        const operation = await read(operationId);
        return ['succeeded', 'failed', 'cancelled', 'partial_success'].includes(operation.state)
          ? operation
          : null;
      },
      'the operation to finish',
      120_000,
    );

  const adminPath = (emulator: string, vmName: string) =>
    `/admin/vms/${emulator}/${encodeURIComponent(vmName)}`;

  async function mediaOf(emulator: string, vmName: string): Promise<AdminMedia[]> {
    const response = await admin.get(`${adminPath(emulator, vmName)}/media`);
    return adminMediaListResponseSchema.parse(response.json()).media;
  }

  const untilMedia = (emulator: string, vmName: string, count: number) =>
    waitFor(
      async () => {
        const media = await mediaOf(emulator, vmName);
        return media.length >= count ? media : null;
      },
      `${count} media items on ${vmName}`,
      60_000,
    );

  const heldHashes = async (vmName: string) => {
    const [rows] = await context.pool.execute<RowDataPacket[]>(
      'SELECT original_sha256 FROM vm_media WHERE vm_name = ?',
      [vmName],
    );
    return rows.map((row) => row.original_sha256 as string);
  };

  const api = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}/api/v1${path}`, init);

  beforeAll(async () => {
    if (!existsSync(AGENT_BINARY)) throw new Error(`Build the agent first: ${AGENT_BINARY}`);
    docker('build', '-q', '-t', IMAGE, IMAGE_CONTEXT);

    directory = await mkdtemp(join(tmpdir(), 'emucat-e2e-media-'));
    box86 = join(directory, 'box86');
    qemu = join(directory, 'qemu');
    await mkdir(box86);
    await mkdir(qemu);
    await writeFile(join(directory, 'emulator.exe'), '');
    await mkdir(join(directory, 'keys'));
    const clientKey = join(directory, 'keys', 'client');
    const hostKey = join(directory, 'keys', 'host');
    generateKey(clientKey);
    generateKey(hostKey);
    container = `emucat-e2e-media-${randomUUID().slice(0, 8)}`;
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      container,
      '-p',
      '127.0.0.1:0:22',
      '--tmpfs',
      '/srv/sftp/repo:size=1g',
      '-e',
      `HOST_KEY_B64=${readFileSync(hostKey).toString('base64')}`,
      '-e',
      `AUTHORIZED_KEY=${readFileSync(`${clientKey}.pub`, 'utf8').trim()}`,
      IMAGE,
    );
    sftpPort = Number(docker('port', container, '22/tcp').split(':').pop());
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
    track(server);
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

    configPath = join(directory, 'agent.toml');
    await writeFile(
      configPath,
      [
        '[server]',
        `api_url = ${JSON.stringify(`http://127.0.0.1:${port}`)}`,
        '[agent]',
        'name = "E2E media"',
        '[emulators.86box]',
        `base_path = ${JSON.stringify(box86)}`,
        `executable = ${JSON.stringify(join(directory, 'emulator.exe'))}`,
        '[emulators.qemu]',
        `base_path = ${JSON.stringify(qemu)}`,
        `executable = ${JSON.stringify(join(directory, 'emulator.exe'))}`,
        '[state]',
        `dir = ${JSON.stringify(join(directory, 'state'))}`,
        '[storage]',
        `staging_dir = ${JSON.stringify(join(directory, 'staging'))}`,
        '[media]',
        'stability_seconds = 1',
        'retry_initial_seconds = 1',
        'retry_ceiling_seconds = 3',
        'reconcile_interval_seconds = 3600',
        'transfer_wait_seconds = 8',
        `[repositories."${repositoryId}"]`,
        'kind = "sftp"',
        'host = "127.0.0.1"',
        `port = ${sftpPort}`,
        'username = "emucat"',
        'remote_root = "/repo"',
        `private_key_path = ${JSON.stringify(clientKey)}`,
        `host_key_fingerprints = [${JSON.stringify(fingerprintOf(hostKey))}]`,
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
  }, LONG);

  afterAll(async () => {
    for (const child of running) child.kill('SIGKILL');
    try {
      docker('rm', '-f', container);
    } catch {
      // Already gone.
    }
    await context?.close();
    if (directory) {
      await new Promise((done) => setTimeout(done, 500));
      await rm(directory, { recursive: true, force: true });
    }
  }, LONG);

  const firstShot = png(1280, 720, '#112233');
  const nestedShot = png(320, 200, '#445566');

  it(
    'does not touch a VM before it is registered, then finds what it already has',
    async () => {
      const root = await box86Vm('Stopped VM');
      await mkdir(join(root, 'screenshots', 'session one'), { recursive: true });
      const first = await firstShot;
      const nested = await nestedShot;
      await writeFile(join(root, 'screenshots', 'first.png'), first);
      await writeFile(join(root, 'screenshots', 'session one', 'nested.png'), nested);
      await writeFile(join(root, 'screenshots', 'notes.txt'), 'not an image');

      await new Promise((done) => setTimeout(done, 2500));
      const [before] = await context.pool.execute<RowDataPacket[]>('SELECT 1 FROM vm_media');
      expect(before, 'discovered is not registered').toEqual([]);

      const operation = await register('Stopped VM', '86box', 'copy');
      const done = await finished(operation.id);
      expect(done.state, JSON.stringify(done)).toBe('succeeded');

      const media = await untilMedia('86box', 'Stopped VM', 2);
      expect(media.map((item) => item.originalFilename).sort()).toEqual([
        'screenshots/first.png',
        'screenshots/session one/nested.png',
      ]);
      // The archive's own bytes never came this way, and the screenshots never went that way.
      const listing = docker(
        'exec',
        container,
        'sh',
        '-c',
        `unzip -l '/srv/sftp/repo/${done.archiveKey}'`,
      );
      expect(listing).toContain('86box.cfg');
      expect(listing).not.toMatch(/screenshots|first\.png|nested\.png/i);
    },
    LONG,
  );

  it('stores the original untouched, a full JPEG and a thumbnail', async () => {
    const first = await firstShot;
    const media = await mediaOf('86box', 'Stopped VM');
    const item = media.find((entry) => entry.originalFilename === 'screenshots/first.png');
    expect(item).toMatchObject({
      isMain: false,
      widthPx: 1280,
      heightPx: 720,
      originalSizeBytes: first.length,
    });
    const base = `${adminPath('86box', 'Stopped VM')}/media/${item?.id}`;
    const detail = adminMediaDetailSchema.parse((await admin.get(base)).json());
    expect(detail).toMatchObject({
      originalSha256: sha(first),
      originalMimeType: 'image/png',
      uploadedByAgentId: agentId,
    });
    expect((await admin.get(`${base}/original`)).rawPayload.equals(first)).toBe(true);
    const full = await admin.get(`${base}/full`);
    expect(await sharp(full.rawPayload).metadata()).toMatchObject({
      format: 'jpeg',
      width: 1280,
      height: 720,
    });
    const thumbnail = await admin.get(`${base}/thumbnail`);
    expect(await sharp(thumbnail.rawPayload).metadata()).toMatchObject({
      format: 'jpeg',
      width: 400,
      height: 225,
    });
    for (const directoryName of ['originals', 'full', 'thumbnails']) {
      expect(existsSync(join(context.storageRoot, 'media', directoryName))).toBe(true);
    }
  });

  it(
    'notices new and modified screenshots, keeping the old version',
    async () => {
      const root = join(box86, 'Stopped VM');
      const added = await png(640, 480, '#778899');
      await writeFile(join(root, 'screenshots', 'added.png'), added);
      await untilMedia('86box', 'Stopped VM', 3);

      const changed = await png(640, 480, '#99aa00');
      await writeFile(join(root, 'screenshots', 'added.png'), changed);
      const media = await untilMedia('86box', 'Stopped VM', 4);
      expect(media.filter((item) => item.originalFilename.endsWith('added.png')).length).toBe(2);
      expect(await heldHashes('Stopped VM')).toEqual(
        expect.arrayContaining([sha(added), sha(changed)]),
      );
    },
    LONG,
  );

  it(
    'keeps identical content to one item, under any name',
    async () => {
      const root = join(box86, 'Stopped VM');
      await writeFile(join(root, 'screenshots', 'copy of first.png'), await firstShot);
      await writeFile(join(root, 'screenshots', 'one more.png'), await png(100, 100, '#010203'));
      await untilMedia('86box', 'Stopped VM', 5);
      await new Promise((done) => setTimeout(done, 2000));
      expect((await mediaOf('86box', 'Stopped VM')).length).toBe(5);
    },
    LONG,
  );

  it('keeps a screenshot on the server when it is deleted locally', async () => {
    const root = join(box86, 'Stopped VM');
    await rm(join(root, 'screenshots', 'one more.png'));
    await new Promise((done) => setTimeout(done, 1500));
    expect((await mediaOf('86box', 'Stopped VM')).length).toBe(5);
  });

  it('requires a real credential for everything an agent can do', async () => {
    const bytes = await firstShot;
    const path = `/agent/media/vms/86box/${encodeURIComponent('Stopped VM')}`;
    const headers = { 'x-emucat-protocol-version': '1', host: HOST };
    const requests: [string, RequestInit][] = [
      ['/agent/media/vms', { headers }],
      [
        `${path}/screenshots/${sha(bytes)}`,
        {
          method: 'PUT',
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          body: bytes,
        },
      ],
      [
        `${path}/acknowledgements`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ sha256: [sha(bytes)] }),
        },
      ],
    ];
    for (const [url, init] of requests) {
      expect((await api(url, init)).status, url).toBe(401);
      const wrong = await api(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${'A'.repeat(43)}` },
      });
      expect(wrong.status, url).toBe(401);
    }
  });

  it('selects a main image, and publishes only by making the VM public', async () => {
    const vm = adminPath('86box', 'Stopped VM');
    const media = await mediaOf('86box', 'Stopped VM');
    const chosen = media.find((item) => item.originalFilename === 'screenshots/first.png');
    const id = chosen?.id as string;
    const thumbnailUrl = `/catalog/media/${id}/thumbnail`;
    const other = media.find((item) => item.id !== id)?.id as string;

    expect(media.every((item) => !item.isMain && !item.shownAsPublicMain)).toBe(true);
    expect((await api(thumbnailUrl)).status).toBe(404);

    const selected = await admin.request({
      method: 'PUT',
      url: `${vm}/main-media`,
      payload: { mediaId: id },
    });
    expect(selected.statusCode).toBe(200);
    expect((await api(thumbnailUrl)).status, 'selecting does not publish').toBe(404);

    await admin.request({
      method: 'PUT',
      url: `${vm}/visibility`,
      payload: { visibility: 'public' },
    });
    const shown = await api(thumbnailUrl);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('content-type')).toBe('image/jpeg');
    expect((await api(`/catalog/media/${other}/full`)).status, 'the whole VM is public').toBe(200);
    const catalog = publicCatalogResponseSchema.parse(await (await api('/catalog/vms')).json());
    expect(catalog.items.find((item) => item.vmName === 'Stopped VM')?.mainImage?.id).toBe(id);

    // Originals stay administrators' only, however public the VM is.
    expect((await api(`/catalog/media/${id}/original`)).status).toBe(400);
    expect((await api(`${vm}/media/${id}/original`)).status).toBe(401);

    await admin.request({
      method: 'PUT',
      url: `${vm}/visibility`,
      payload: { visibility: 'private' },
    });
    expect((await api(thumbnailUrl)).status, 'unpublished at once').toBe(404);
    expect((await api(`/catalog/media/${other}/full`)).status).toBe(404);
    const after = publicCatalogResponseSchema.parse(await (await api('/catalog/vms')).json());
    expect(after.items.find((item) => item.vmName === 'Stopped VM')).toBeUndefined();
  });

  it('reports its progress to the administrator', async () => {
    const status = await waitFor(
      async () => {
        const body = adminMediaSyncResponseSchema.parse(
          (await admin.get(`${adminPath('86box', 'Stopped VM')}/media-sync`)).json(),
        );
        const reported = body.agents[0]?.status;
        return reported && reported.synchronized >= 4 && reported.pending === 0 ? reported : null;
      },
      'a status report',
      30_000,
    );
    expect(status.failed).toBe(0);
    expect(status.uploading).toBe(0);
  });

  it(
    'survives a killed agent: nothing is sent twice, and what it missed is picked up',
    async () => {
      const count = (await mediaOf('86box', 'Stopped VM')).length;
      const uploadsBefore = (
        await readdir(join(context.storageRoot, 'media', 'originals'), {
          recursive: true,
        })
      ).length;
      await killAgent();
      await writeFile(
        join(box86, 'Stopped VM', 'screenshots', 'while away.png'),
        await png(200, 150, '#0a0b0c'),
      );
      await startDaemon();
      const media = await untilMedia('86box', 'Stopped VM', count + 1);
      expect(media.length).toBe(count + 1);
      await new Promise((done) => setTimeout(done, 1500));
      expect((await mediaOf('86box', 'Stopped VM')).length).toBe(count + 1);
      const uploadsAfter = (
        await readdir(join(context.storageRoot, 'media', 'originals'), {
          recursive: true,
        })
      ).length;
      // One more directory entry at most, for the file itself and perhaps its folder.
      expect(uploadsAfter - uploadsBefore).toBeLessThanOrEqual(2);
    },
    LONG,
  );

  it(
    'survives the API going away, and catches up when it is back',
    async () => {
      const count = (await mediaOf('86box', 'Stopped VM')).length;
      await stopServer();
      const missed = await png(210, 150, '#0d0e0f');
      await writeFile(join(box86, 'Stopped VM', 'screenshots', 'server was down.png'), missed);
      // Long enough for it to notice, try and fail at least once.
      await new Promise((done) => setTimeout(done, 3000));
      expect(daemon.output()).toMatch(/Cannot reach|Upload failed|Connection lost/);
      await startServer();
      await waitFor(isOnline, 'the agent to reconnect', 60_000);
      await untilMedia('86box', 'Stopped VM', count + 1);
      expect(await heldHashes('Stopped VM')).toContain(sha(missed));
    },
    LONG,
  );

  it(
    'marks a corrupt screenshot as failed, says why, and does not keep sending it',
    async () => {
      const root = await qemuVm('Corrupt Shots');
      const operation = await register('Corrupt Shots', 'qemu', 'copy');
      expect((await finished(operation.id)).state).toBe('succeeded');
      await writeFile(join(root, 'bad.ppm'), Buffer.from('P6\n100 100\n255\ntruncated'));
      const status = await waitFor(
        async () => {
          const body = adminMediaSyncResponseSchema.parse(
            (await admin.get(`${adminPath('qemu', 'Corrupt Shots')}/media-sync`)).json(),
          );
          const reported = body.agents[0]?.status;
          return reported && reported.failed === 1 ? reported : null;
        },
        'the failure to be reported',
        30_000,
      );
      expect(status.lastError).toMatchObject({ code: 'invalid_image', sourcePath: 'bad.ppm' });
      expect(JSON.stringify(status)).not.toContain(directory);
      expect(await mediaOf('qemu', 'Corrupt Shots')).toEqual([]);
    },
    LONG,
  );

  it(
    'transfers a VM once the server holds its screenshots, deleting the local copy',
    async () => {
      const root = await qemuVm('Transfer Me');
      const first = ppm(640, 480, 200, 10, 10);
      const second = ppm(800, 600, 10, 200, 10);
      await writeFile(join(root, 'screenshot001.ppm'), first);
      await writeFile(join(root, 'SCREENSHOT002.PPM'), second);
      await writeFile(join(root, 'not a screenshot.png'), await png(10, 10, '#ffffff'));

      const operation = await register('Transfer Me', 'qemu', 'transfer');
      const done = await finished(operation.id);
      expect(done, JSON.stringify(done)).toMatchObject({
        state: 'succeeded',
        localCopy: 'removed',
        error: null,
      });
      expect(existsSync(root)).toBe(false);
      expect(await readdir(qemu)).not.toContain('.emucat-removing');

      const held = await heldHashes('Transfer Me');
      expect(held.sort()).toEqual([sha(first), sha(second)].sort());
      const media = await mediaOf('qemu', 'Transfer Me');
      const shot = media.find((item) => item.originalFilename === 'screenshot001.ppm');
      expect(shot).toMatchObject({ widthPx: 640, heightPx: 480 });
      const original = await admin.get(
        `${adminPath('qemu', 'Transfer Me')}/media/${shot?.id}/original`,
      );
      expect(original.rawPayload.equals(first)).toBe(true);

      // The archive has the other file, and no screenshot.
      const listing = docker(
        'exec',
        container,
        'sh',
        '-c',
        `unzip -l '/srv/sftp/repo/${done.archiveKey}'`,
      );
      expect(listing).toContain('not a screenshot.png');
      expect(listing).not.toMatch(/\.ppm/i);
    },
    LONG,
  );

  it(
    'keeps the VM when a screenshot cannot be preserved, and removes it after that is fixed',
    async () => {
      const root = await box86Vm('Cannot Preserve');
      const good = await png(300, 200, '#123123');
      await writeFile(join(root, 'screenshots', 'good.png'), good);
      await mkdir(join(root, 'screenshots', 'sub'));
      await writeFile(join(root, 'screenshots', 'sub', 'notes.txt'), 'not an image');
      const before = await fingerprint(root);

      const operation = await register('Cannot Preserve', '86box', 'transfer');
      const blocked = await finished(operation.id);
      expect(blocked, JSON.stringify(blocked)).toMatchObject({
        state: 'partial_success',
        localCopy: 'cleanup_failed',
        error: { code: 'transfer_blocked_media' },
      });
      expect(blocked.error?.message).toContain('notes.txt');
      expect(blocked.recovery).toMatch(/Retry removal/);
      expect(await fingerprint(root), 'not one file changed').toEqual(before);
      const [masters] = await context.pool.execute<RowDataPacket[]>(
        "SELECT 1 FROM vm_versions WHERE vm_name = 'Cannot Preserve' AND kind = 'master'",
      );
      expect(masters.length, 'the master stays').toBe(1);

      // The VM is registered now, so its good screenshot still arrives.
      await untilMedia('86box', 'Cannot Preserve', 1);

      // A retry with nothing changed is refused the same way.
      const refused = await admin.request({
        method: 'POST',
        url: `/admin/registrations/${operation.id}/retry-cleanup`,
      });
      expect(refused.statusCode, refused.body).toBe(202);
      const again = await finished(operation.id);
      expect(again.error?.code).toBe('transfer_blocked_media');
      expect(existsSync(join(root, 'disk.img'))).toBe(true);

      await rename(
        join(root, 'screenshots', 'sub', 'notes.txt'),
        join(directory, 'moved-notes.txt'),
      );
      const retried = await admin.request({
        method: 'POST',
        url: `/admin/registrations/${operation.id}/retry-cleanup`,
      });
      expect(retried.statusCode, retried.body).toBe(202);
      const done = await waitFor(
        async () => {
          const current = await read(operation.id);
          return current.state === 'succeeded' ? current : null;
        },
        'the retried removal',
        60_000,
      );
      expect(done.localCopy).toBe('removed');
      expect(existsSync(root)).toBe(false);
      expect(await heldHashes('Cannot Preserve')).toEqual([sha(good)]);
    },
    LONG,
  );

  it(
    'keeps the VM when its screenshot is rejected by the server',
    async () => {
      const root = await qemuVm('Rejected Shot');
      await writeFile(join(root, 'corrupt.ppm'), Buffer.from('P6\n50 50\n255\nnope'));
      const before = await fingerprint(root);
      const operation = await register('Rejected Shot', 'qemu', 'transfer');
      const blocked = await finished(operation.id);
      expect(blocked).toMatchObject({
        state: 'partial_success',
        error: { code: 'transfer_blocked_media' },
      });
      expect(blocked.error?.message).toContain('corrupt.ppm');
      expect(await fingerprint(root)).toEqual(before);
    },
    LONG,
  );

  it(
    'keeps the VM when the API is away at the moment of proof',
    async () => {
      const root = await qemuVm('Server Away');
      await writeFile(join(root, 'shot.ppm'), ppm(64, 48, 1, 2, 3));
      const operation = await register('Server Away', 'qemu', 'transfer');
      await waitFor(
        async () => {
          const current = await read(operation.id);
          return current.committedAt !== null ? current : null;
        },
        'the commit',
        120_000,
      );
      expect((await read(operation.id)).state).toBe('cleaning_local');
      // The server commits before it acknowledges. Only once the agent has the acknowledgement, which
      // its journal records before it reads the archive back, is this the moment of proof; stopping
      // the server earlier would lose the acknowledgement and test a reconnection instead.
      const journal = join(directory, 'state', 'registrations', `${operation.id}.journal`);
      await waitFor(
        async () => {
          try {
            return JSON.parse(await readFile(journal, 'utf8')).phase === 'cleaning';
          } catch {
            // Not there yet, or being replaced.
            return false;
          }
        },
        'the agent to accept the commit',
        30_000,
      );
      // Nothing can have been proved yet: proof takes a read-back and a further round of the wait.
      await stopServer();
      // Longer than the agent is configured to wait.
      await new Promise((done) => setTimeout(done, 12_000));
      expect(existsSync(join(root, 'disk.qcow2')), 'nothing was deleted').toBe(true);
      expect(existsSync(join(root, 'shot.ppm')), 'nothing was deleted').toBe(true);
      await startServer();
      await waitFor(isOnline, 'the agent to reconnect', 60_000);
      const done = await finished(operation.id);
      expect(done, JSON.stringify(done)).toMatchObject({
        state: 'partial_success',
        localCopy: 'cleanup_failed',
        error: { code: 'transfer_blocked_media' },
      });
      expect(done.error?.message).toMatch(/could not confirm|have not reached/);
      expect(existsSync(join(root, 'shot.ppm'))).toBe(true);
      expect(existsSync(join(root, 'disk.qcow2'))).toBe(true);

      // With the server back, its screenshot arrives by itself, and the removal can then go ahead.
      await untilMedia('qemu', 'Server Away', 1);
      const retried = await admin.request({
        method: 'POST',
        url: `/admin/registrations/${operation.id}/retry-cleanup`,
      });
      expect(retried.statusCode, retried.body).toBe(202);
      const removed = await waitFor(
        async () => {
          const current = await read(operation.id);
          return current.state === 'succeeded' ? current : null;
        },
        'the retried removal',
        60_000,
      );
      expect(removed.localCopy).toBe('removed');
      expect(existsSync(root)).toBe(false);
    },
    LONG,
  );

  it(
    'sends no screenshot through the repository, and no archive through the API',
    async () => {
      const listing = docker('exec', container, 'sh', '-c', 'cd /srv/sftp/repo && find . -type f');
      for (const line of listing.split('\n').filter(Boolean)) {
        expect(line).toMatch(/^\.\/archives\/.+\.zip$/);
      }

      const root = await qemuVm('Big Archive', 32);
      const bytesBefore = apiSockets.reduce((sum, socket) => sum + socket.bytesRead, 0);
      const operation = await register('Big Archive', 'qemu', 'copy');
      const done = await finished(operation.id);
      expect(done.state).toBe('succeeded');
      expect(done.archive?.sizeBytes).toBeGreaterThan(32 * 1024 * 1024);
      const received = apiSockets.reduce((sum, socket) => sum + socket.bytesRead, 0) - bytesBefore;
      expect(received, 'bytes the API received').toBeLessThan(512 * 1024);
      expect(existsSync(root)).toBe(true);
    },
    LONG,
  );

  it('never logged a credential, and never served a storage path', async () => {
    const all = allOutput.join('');
    expect(all).toContain('Watching for screenshots');
    expect(all).toContain('Screenshot uploaded');
    expect(all).toContain('Screenshot queued');
    expect(all).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/);
    expect(all).not.toContain('PRIVATE KEY');
    const status = startAgent('media-status');
    expect(await status.exited).toBe(0);
    expect(status.output()).toContain('Stopped VM');
    expect(status.output()).not.toMatch(/PRIVATE KEY|Bearer/);
  });
});
