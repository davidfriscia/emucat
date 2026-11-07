/**
 * Restoring, the public cover and the VM detail page with nothing simulated: the compiled agent, the real
 * API on a real database, a real OpenSSH server in a container, the real web app, and a real browser.
 * Every VM here is a disposable directory this file creates.
 *
 * Run with `pnpm test:e2e`, which builds the agent first. Set `EMUCAT_AGENT_E2E_PROFILE=release` to run
 * the Release binary. It needs MariaDB, Docker, `ssh-keygen` and Microsoft Edge or Chrome, and runs on
 * Windows only, until another platform has a credential store.
 *
 * Remote HTTPS is deliberately not exercised: the agent talks to this API over loopback HTTP.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  discoveryOperationSchema,
  discoveryStateResponseSchema,
  pairingRequestReviewSchema,
  registrationOperationSchema,
  repositorySummarySchema,
  restoreOperationSchema,
  restoreOptionsResponseSchema,
  type RegistrationOperation,
  type RestoreOperation,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENEROUS_RATE_LIMITS, waitFor } from '../test/agent-helpers.js';
import {
  ADMIN_PASSWORD,
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from '../test/browser-app.js';

// What runs inside the page. This package is compiled for Node, and has no DOM types of its own.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const document: any;
type HTMLImageElement = any;
type CanvasRenderingContext2D = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const profile = process.env.EMUCAT_AGENT_E2E_PROFILE ?? 'debug';
const AGENT_BINARY = resolve(
  import.meta.dirname,
  `../../../agent/target/${profile}/emucat-agent.exe`,
);
const IMAGE = 'emucat-sftp-test:local';
const IMAGE_CONTEXT = resolve(import.meta.dirname, '../../../infra/docker/sftp-test');
const WEB_DIRECTORY = resolve(import.meta.dirname, '../../web');
const LONG = 240_000;

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

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const png = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();

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
      result[relative] = sha256(await readFile(path));
    }
  }
  return result;
}

describe('restore, public cover and VM details, end to end', () => {
  let context: BrowserTestContext;
  let server: FastifyInstance;
  let admin: TestClient;
  let port: number;
  let directory: string;
  let configPath: string;
  let box86: string;
  let qemu: string;
  let stateDir: string;
  let stagingDir: string;
  let cacheDir: string;
  let repositoryId: string;
  let agentId: string;
  let container: string;
  let webPort: number;
  let web: ChildProcess;
  let browser: Browser;
  const running: ChildProcess[] = [];
  const apiSockets: Socket[] = [];
  /** Bytes the API has handled on connections that have since been closed. */
  let closedBytes = 0;

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

  /** Online, and it has said what it can restore. */
  async function startDaemon(): Promise<void> {
    daemon = startAgent('run');
    await waitFor(isOnline, 'the agent to be online', 30_000);
    await waitFor(
      async () => {
        const options = await admin.get('/admin/vms/qemu/nothing/restore-options');
        return options.statusCode !== 200;
      },
      'the server to answer',
      5_000,
    );
    await new Promise((done) => setTimeout(done, 500));
  }

  async function killAgent(): Promise<void> {
    daemon.child.kill('SIGKILL');
    await daemon.exited;
    await waitFor(async () => !(await isOnline()), 'the agent to be offline', 30_000);
  }

  function track(instance: FastifyInstance): void {
    instance.server.on('connection', (socket: Socket) => {
      apiSockets.push(socket);
      socket.on('close', () => {
        closedBytes += socket.bytesRead + socket.bytesWritten;
        apiSockets.splice(apiSockets.indexOf(socket), 1);
      });
    });
  }

  const apiBytes = () =>
    closedBytes +
    apiSockets.reduce((sum, socket) => sum + socket.bytesRead + socket.bytesWritten, 0);

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
    for (const socket of [...apiSockets]) socket.destroy();
    await server.close();
  }

  const qemuVm = async (name: string, megabytes = 1) => {
    const root = join(qemu, name);
    await mkdir(join(root, 'nested', 'deep'), { recursive: true });
    await mkdir(join(root, 'empty directory'));
    await writeFile(join(root, 'run.bat'), '@echo this must never be run\r\n');
    await writeFile(join(root, 'disk.qcow2'), randomBytes(megabytes * 1024 * 1024));
    await writeFile(join(root, 'nested', 'deep', 'config.txt'), 'nested\n');
    return root;
  };

  const box86Vm = async (name: string) => {
    const root = join(box86, name);
    await mkdir(join(root, 'screenshots'), { recursive: true });
    await writeFile(join(root, '86box.cfg'), 'machine = x\n');
    await writeFile(join(root, 'disk.img'), randomBytes(64 * 1024));
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
    if (vmName) expect(operation.vms.map((vm) => vm.vmName)).toContain(vmName);
    return operation;
  }

  const TERMINAL = ['succeeded', 'failed', 'cancelled', 'partial_success'];

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
    const { id } = registrationOperationSchema.parse(response.json());
    const done = await waitFor(
      async () => {
        const operation = registrationOperationSchema.parse(
          (await admin.get(`/admin/registrations/${id}`)).json(),
        );
        return TERMINAL.includes(operation.state) ? operation : null;
      },
      'the registration to finish',
      120_000,
    );
    expect(done.state, JSON.stringify(done)).toBe('succeeded');
    return done;
  }

  async function restore(vmName: string, versionId: string, emulatorType = 'qemu') {
    const response = await admin.request({
      method: 'POST',
      url: '/admin/restores',
      payload: { agentId, emulatorType, vmName, versionId },
    });
    expect(response.statusCode, response.body).toBe(202);
    return restoreOperationSchema.parse(response.json());
  }

  async function readRestore(id: string): Promise<RestoreOperation> {
    return restoreOperationSchema.parse((await admin.get(`/admin/restores/${id}`)).json());
  }

  const restoreFinished = (id: string, timeout = 120_000) =>
    waitFor(
      async () => {
        const operation = await readRestore(id);
        return TERMINAL.includes(operation.state) ? operation : null;
      },
      'the restore to finish',
      timeout,
    );

  async function vmState(vmName: string) {
    const [rows] = await context.pool.execute<RowDataPacket[]>(
      `SELECT local_source_version_id, execution_state, content_status, last_verified_sha256
       FROM agent_vm_state WHERE agent_id = ? AND vm_name = ?`,
      [agentId, vmName],
    );
    return rows[0];
  }

  const mediaOf = async (emulator: string, vmName: string) => {
    const response = await admin.get(`/admin/vms/${emulator}/${encodeURIComponent(vmName)}/media`);
    return response.json<{
      media: { id: string; originalFilename: string; visibility: string }[];
    }>().media;
  };

  const baseFiles = async (base: string) =>
    (await readdir(base)).filter((name) => name.startsWith('.emucat-'));

  const stagingFiles = async () => (existsSync(stagingDir) ? readdir(stagingDir) : []);

  /** Pictures of the real pages, for a person to look at, when `EMUCAT_E2E_SCREENSHOTS` names a directory. */
  async function shot(page: Page, name: string): Promise<void> {
    const target = process.env.EMUCAT_E2E_SCREENSHOTS;
    if (target) await page.screenshot({ path: join(target, `${name}.png`), fullPage: true });
  }

  async function assertNothingLeftBehind(base = qemu): Promise<void> {
    expect(await baseFiles(base), 'left in the base path').toEqual([]);
    expect(await stagingFiles(), 'left in staging').toEqual([]);
  }

  const webUrl = (path: string) => `http://127.0.0.1:${webPort}${path}`;

  async function signIn(page: Page): Promise<void> {
    await page.goto(webUrl('/login'));
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  }

  /** The image has really decoded, which says more than an element or a URL being present. */
  async function decodedImage(page: Page, selector: string) {
    await page.waitForFunction(
      (query) => {
        const image = document.querySelector(query);
        return image?.complete && image.naturalWidth > 0;
      },
      selector,
      { timeout: 20_000 },
    );
    return page.evaluate((query) => {
      const image = document.querySelector(query) as HTMLImageElement;
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const drawing = canvas.getContext('2d') as CanvasRenderingContext2D;
      drawing.drawImage(image, 0, 0, 1, 1);
      const [red, green, blue] = drawing.getImageData(0, 0, 1, 1).data;
      return {
        src: new URL(image.src).pathname,
        width: image.naturalWidth,
        height: image.naturalHeight,
        color: [red, green, blue],
      };
    }, selector);
  }

  beforeAll(async () => {
    if (!existsSync(AGENT_BINARY)) throw new Error(`Build the agent first: ${AGENT_BINARY}`);
    docker('build', '-q', '-t', IMAGE, IMAGE_CONTEXT);

    directory = await mkdtemp(join(tmpdir(), 'emucat-e2e-restore-'));
    box86 = join(directory, 'box86');
    qemu = join(directory, 'qemu');
    stateDir = join(directory, 'state');
    stagingDir = join(directory, 'staging');
    cacheDir = join(directory, 'cache');
    await mkdir(box86);
    await mkdir(qemu);
    await writeFile(join(directory, 'emulator.exe'), '');
    await mkdir(join(directory, 'keys'));
    const clientKey = join(directory, 'keys', 'client');
    const hostKey = join(directory, 'keys', 'host');
    generateKey(clientKey);
    generateKey(hostKey);
    container = `emucat-e2e-restore-${randomUUID().slice(0, 8)}`;
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      container,
      '-p',
      '127.0.0.1:0:22',
      '--tmpfs',
      '/srv/sftp/repo:size=2g',
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
        'name = "E2E restore"',
        '[emulators.86box]',
        `base_path = ${JSON.stringify(box86)}`,
        `executable = ${JSON.stringify(join(directory, 'emulator.exe'))}`,
        '[emulators.qemu]',
        `base_path = ${JSON.stringify(qemu)}`,
        `executable = ${JSON.stringify(join(directory, 'emulator.exe'))}`,
        '[state]',
        `dir = ${JSON.stringify(stateDir)}`,
        '[storage]',
        `staging_dir = ${JSON.stringify(stagingDir)}`,
        `cache_dir = ${JSON.stringify(cacheDir)}`,
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

    // The real web app, in front of this API.
    webPort = 5300 + Math.floor(Math.random() * 400);
    web = spawn(
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
    await browser?.close();
    for (const child of running) child.kill('SIGKILL');
    try {
      docker('unpause', container);
    } catch {
      // It was not paused.
    }
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

  describe('the public cover and the VM detail page', () => {
    const VM = 'Cover VM';
    const COVER_RGB = [18, 52, 86];
    let main: string;
    let otherPublished: string;
    let hidden: string;
    let anonymous: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      const root = await box86Vm(VM);
      await writeFile(join(root, 'screenshots', 'a-main.png'), await png(1280, 720, '#123456'));
      await writeFile(join(root, 'screenshots', 'b-other.png'), await png(640, 480, '#654321'));
      await writeFile(join(root, 'screenshots', 'c-private.png'), await png(800, 600, '#aa0000'));
      await register(VM, '86box', 'copy');
      const media = await waitFor(
        async () => {
          const items = await mediaOf('86box', VM);
          return items.length >= 3 ? items : null;
        },
        'three screenshots to arrive through the API',
        60_000,
      );
      const byName = (fragment: string) =>
        media.find((item) => item.originalFilename.includes(fragment))?.id as string;
      main = byName('a-main');
      otherPublished = byName('b-other');
      hidden = byName('c-private');
      anonymous = await browser.newContext();
      page = await anonymous.newPage();
    }, LONG);

    afterAll(async () => {
      await anonymous?.close();
    });

    const path = `/admin/vms/86box/${encodeURIComponent(VM)}`;

    it(
      'keeps a placeholder while the main screenshot is private, as the user saw',
      async () => {
        const selected = await admin.request({
          method: 'PUT',
          url: `${path}/main-media`,
          payload: { mediaId: main },
        });
        expect(selected.statusCode, selected.body).toBe(200);
        const published = await admin.request({
          method: 'PUT',
          url: `${path}/visibility`,
          payload: { visibility: 'public' },
        });
        expect(published.statusCode, published.body).toBe(200);

        await page.goto(webUrl('/'));
        const card = page.getByRole('article').filter({ hasText: VM });
        await card.waitFor();
        expect(await card.locator('img').count()).toBe(0);
        expect(await card.getByRole('img', { name: 'No image' }).count()).toBe(1);
        const answer = await anonymous.request.get(
          webUrl(`/api/v1/catalog/media/${main}/thumbnail`),
        );
        expect(answer.status()).toBe(404);
      },
      LONG,
    );

    it(
      'explains why to the administrator, who publishes it explicitly',
      async () => {
        const adminContext = await browser.newContext();
        const adminPage = await adminContext.newPage();
        await signIn(adminPage);
        await adminPage.goto(webUrl(path));
        await adminPage.getByText('its main screenshot is private').waitFor();
        await shot(adminPage, '1-admin-no-public-cover');
        await adminPage.getByRole('button', { name: 'Publish the main screenshot' }).click();
        await adminPage.getByText('The main screenshot is the public catalog’s cover.').waitFor();
        await adminContext.close();
        expect((await mediaOf('86box', VM)).find((item) => item.id === main)?.visibility).toBe(
          'published',
        );
        expect((await mediaOf('86box', VM)).find((item) => item.id === hidden)?.visibility).toBe(
          'private',
        );
      },
      LONG,
    );

    it(
      'shows the actual screenshot on the public card, with no session at all',
      async () => {
        await page.goto(webUrl('/'));
        const card = page.getByRole('article').filter({ hasText: VM });
        await card.waitFor();
        const decoded = await decodedImage(page, 'article img');
        expect(decoded.src).toBe(`/api/v1/catalog/media/${main}/thumbnail`);
        expect(decoded.width).toBeGreaterThan(0);
        await shot(page, '2-public-catalog-cover');
        for (const [channel, expected] of decoded.color.entries()) {
          expect(Math.abs((expected as number) - (COVER_RGB[channel] as number))).toBeLessThan(12);
        }
        expect((await anonymous.cookies()).filter((cookie) => /session/.test(cookie.name))).toEqual(
          [],
        );
      },
      LONG,
    );

    it(
      'still loads it with an expired session cookie in the browser',
      async () => {
        const expired = await browser.newContext();
        await expired.addCookies([
          {
            name: 'emucat_session',
            value: 'expired-or-invalid',
            domain: '127.0.0.1',
            path: '/',
          },
        ]);
        const expiredPage = await expired.newPage();
        await expiredPage.goto(webUrl('/'));
        await expiredPage.getByRole('article').filter({ hasText: VM }).waitFor();
        const decoded = await decodedImage(expiredPage, 'article img');
        expect(decoded.src).toBe(`/api/v1/catalog/media/${main}/thumbnail`);
        await expired.close();
      },
      LONG,
    );

    it('never lets the public fetch an original or a private image', async () => {
      for (const id of [main, hidden]) {
        const original = await anonymous.request.get(
          webUrl(`/api/v1/catalog/media/${id}/original`),
        );
        expect(original.status()).toBeGreaterThanOrEqual(400);
      }
      const admins = await anonymous.request.get(webUrl(`/api/v1${path}/media/${main}/original`));
      expect(admins.status()).toBe(401);
      const privateFull = await anonymous.request.get(
        webUrl(`/api/v1/catalog/media/${hidden}/full`),
      );
      expect(privateFull.status()).toBe(404);
    });

    it(
      'opens the detail page from the card, and back and forward work',
      async () => {
        await setVisibility(otherPublished, 'published');
        await page.goto(webUrl('/'));
        await page.getByRole('link', { name: VM }).click();
        await page.waitForURL(`**/vms/86box/${encodeURIComponent(VM)}`);
        await page.getByRole('heading', { name: 'Screenshots' }).waitFor();
        await page.goBack();
        await page.getByRole('link', { name: VM }).waitFor();
        expect(new URL(page.url()).pathname).toBe('/');
        await page.goForward();
        await page.getByRole('heading', { name: 'Screenshots' }).waitFor();
        await page.reload();
        await page.getByRole('heading', { name: 'Screenshots' }).waitFor();
      },
      LONG,
    );

    async function setVisibility(mediaId: string, visibility: string): Promise<void> {
      const response = await admin.request({
        method: 'PUT',
        url: `${path}/media/${mediaId}/visibility`,
        payload: { visibility },
      });
      expect(response.statusCode, response.body).toBe(200);
    }

    it(
      'reaches the detail page by keyboard',
      async () => {
        await page.goto(webUrl('/'));
        const link = page.getByRole('link', { name: VM });
        await link.waitFor();
        await link.focus();
        await page.keyboard.press('Enter');
        await page.waitForURL(`**/vms/86box/${encodeURIComponent(VM)}`);
      },
      LONG,
    );

    it(
      'shows only published screenshots, and no private detail, to the public',
      async () => {
        await page.goto(webUrl(`/vms/86box/${encodeURIComponent(VM)}`));
        await page.getByRole('heading', { name: 'Screenshots' }).waitFor();
        const sources = await page
          .locator('img')
          .evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src));
        const joined = sources.join(' ');
        await decodedImage(page, 'main .vm-detail-media img');
        await shot(page, '3-public-detail');
        expect(joined).toContain(`${main}/full`);
        expect(joined).toContain(`${main}/thumbnail`);
        expect(joined).toContain(`${otherPublished}/thumbnail`);
        expect(joined).not.toContain(hidden);
        const text = await page.locator('main').innerText();
        expect(text).not.toMatch(/repository|sha-256|restore|agent|\.png/i);
        expect(await page.content()).not.toContain(hidden);
        expect(await page.getByRole('button', { name: 'Restore…' }).count()).toBe(0);
      },
      LONG,
    );

    it(
      'browses with the keyboard, traps focus, and returns it',
      async () => {
        await page.goto(webUrl(`/vms/86box/${encodeURIComponent(VM)}`));
        const thumbnail = page.getByRole('button', { name: /Screenshot 2 of/ });
        await thumbnail.waitFor();
        await thumbnail.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        expect(await dialog.getAttribute('aria-modal')).toBe('true');
        await decodedImage(page, '[role="dialog"] img');
        await shot(page, '4-viewer');
        await decodedImage(page, '[role="dialog"] img');

        for (let step = 0; step < 8; step += 1) {
          await page.keyboard.press('Tab');
          const inside = await page.evaluate(() =>
            document.querySelector('[role="dialog"]')?.contains(document.activeElement),
          );
          expect(inside, `Tab ${step}`).toBe(true);
        }
        for (let step = 0; step < 8; step += 1) {
          await page.keyboard.press('Shift+Tab');
          const inside = await page.evaluate(() =>
            document.querySelector('[role="dialog"]')?.contains(document.activeElement),
          );
          expect(inside, `Shift+Tab ${step}`).toBe(true);
        }

        const before = (await decodedImage(page, '[role="dialog"] img')).src;
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction((src) => {
          const image = document.querySelector('[role="dialog"] img');
          return image && new URL(image.src).pathname !== src && image.complete;
        }, before);
        const after = (await decodedImage(page, '[role="dialog"] img')).src;
        expect(after).not.toBe(before);
        expect(after).toMatch(/\/full$/);
        await page.keyboard.press('ArrowLeft');
        await page.waitForFunction((src) => {
          const image = document.querySelector('[role="dialog"] img');
          return image && new URL(image.src).pathname === src;
        }, before);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        const focused = await page.evaluate(() =>
          document.activeElement?.getAttribute('aria-label'),
        );
        expect(focused).toMatch(/Screenshot 2 of/);
      },
      LONG,
    );

    it(
      'fits a phone, in light and dark, with no sideways scroll',
      async () => {
        for (const colorScheme of ['light', 'dark'] as const) {
          const phone = await browser.newContext({
            viewport: { width: 375, height: 812 },
            colorScheme,
          });
          const phonePage = await phone.newPage();
          for (const url of ['/', `/vms/86box/${encodeURIComponent(VM)}`]) {
            await phonePage.goto(webUrl(url));
            await phonePage.locator('img.vm-image').first().waitFor();
            await shot(phonePage, `5-phone-${colorScheme}-${url === '/' ? 'catalog' : 'detail'}`);
            const widths = await phonePage.evaluate(() => ({
              scroll: document.documentElement.scrollWidth,
              client: document.documentElement.clientWidth,
            }));
            expect(widths.scroll, `${url} ${colorScheme}`).toBeLessThanOrEqual(widths.client);
          }
          await phone.close();
        }
      },
      LONG,
    );

    it(
      'shows an administrator every screenshot, with controls and the same viewer',
      async () => {
        const adminContext = await browser.newContext();
        const adminPage = await adminContext.newPage();
        await signIn(adminPage);
        await adminPage.goto(webUrl('/admin/catalog'));
        await adminPage.getByRole('link', { name: VM }).click();
        await adminPage.waitForURL(`**${path}`);
        await adminPage.getByRole('heading', { name: 'Screenshots', exact: true }).waitFor();
        await adminPage.getByRole('button', { name: /c-private/ }).waitFor();
        await shot(adminPage, '6-admin-detail');
        expect(await adminPage.getByRole('button', { name: 'Clear main image' }).count()).toBe(1);
        expect(await adminPage.getByRole('button', { name: 'Set as main image' }).count()).toBe(2);
        await adminPage.getByRole('button', { name: /c-private/ }).click();
        const dialog = adminPage.getByRole('dialog');
        await dialog.waitFor();
        await decodedImage(adminPage, '[role="dialog"] img');
        expect(await dialog.getByRole('link', { name: 'Download original' }).count()).toBe(1);
        await adminPage.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        await adminContext.close();
      },
      LONG,
    );

    it(
      'takes a cover away at once when the main screenshot or the VM is unpublished',
      async () => {
        await setVisibility(main, 'private');
        await page.goto(webUrl('/'));
        await page.getByRole('article').filter({ hasText: VM }).waitFor();
        expect(await page.locator('article img').count()).toBe(0);
        await setVisibility(main, 'published');

        const hiddenVm = await admin.request({
          method: 'PUT',
          url: `${path}/visibility`,
          payload: { visibility: 'private' },
        });
        expect(hiddenVm.statusCode).toBe(200);
        const answer = await anonymous.request.get(
          webUrl(`/api/v1/catalog/media/${main}/thumbnail`),
        );
        expect(answer.status()).toBe(404);
        await page.goto(webUrl(`/vms/86box/${encodeURIComponent(VM)}`));
        await page.getByText('This virtual machine is not available').waitFor();
        const back = await admin.request({
          method: 'PUT',
          url: `${path}/visibility`,
          payload: { visibility: 'public' },
        });
        expect(back.statusCode).toBe(200);
      },
      LONG,
    );
  });

  describe('restoring', () => {
    const VM = 'Restore Me';
    let original: Record<string, string>;
    let version: string;
    let archiveSize: number;
    let archiveSha: string;
    let manifestSha: string;

    beforeAll(async () => {
      const root = await qemuVm(VM, 32);
      original = await fingerprint(root);
      const done = await register(VM, 'qemu', 'transfer');
      expect(existsSync(root), 'a transfer removed the source').toBe(false);
      version = done.versionId;
      archiveSize = done.archive?.sizeBytes as number;
      archiveSha = done.archive?.sha256 as string;
      manifestSha = done.archive?.manifestSha256 as string;
    }, LONG);

    const destination = () => join(qemu, VM);

    it('offers the master, the agent and the destination the agent would use', async () => {
      const options = restoreOptionsResponseSchema.parse(
        (await admin.get(`/admin/vms/qemu/${encodeURIComponent(VM)}/restore-options`)).json(),
      );
      expect(options.master).toMatchObject({
        versionId: version,
        archiveSizeBytes: archiveSize,
        archiveSha256: archiveSha,
        manifestSha256: manifestSha,
      });
      expect(options.agents[0]).toMatchObject({
        agentId,
        eligible: true,
        destination: destination(),
        local: { availability: 'absent' },
      });
    });

    it(
      'restores straight from SFTP, without the archive passing through the API',
      async () => {
        const before = apiBytes();
        const operation = await restore(VM, version);
        const done = await restoreFinished(operation.id);
        expect(done, JSON.stringify(done)).toMatchObject({
          state: 'succeeded',
          error: null,
          localDirectory: destination(),
          cache: { hit: false, downloadedBytes: archiveSize, archiveCached: true },
        });
        expect(archiveSize).toBeGreaterThan(32 * 1024 * 1024);
        const carried = apiBytes() - before;
        expect(carried, 'bytes through the API during the restore').toBeLessThan(512 * 1024);

        // Files, hashes, nested and empty directories: the same VM, and nothing extra.
        expect(await fingerprint(destination())).toEqual(original);
        expect(done.verified?.manifestSha256).toBe(manifestSha);
        await assertNothingLeftBehind();

        // What is in the repository has not changed, and is what was downloaded.
        const remote = docker(
          'exec',
          container,
          'sh',
          '-c',
          `sha256sum '/srv/sftp/repo/archives/qemu/restore me/${version}.zip' | cut -d' ' -f1`,
        );
        expect(remote).toBe(archiveSha);

        // A local copy, verified, and from this version.
        expect(await vmState(VM)).toMatchObject({
          local_source_version_id: version,
          execution_state: 'idle',
          content_status: 'verified',
          last_verified_sha256: manifestSha,
        });
      },
      LONG,
    );

    it('keeps the ZIP in the cache under its identity, and never in a VM directory', async () => {
      const files = await readdir(cacheDir);
      expect(files).toEqual([`${version}-${archiveSha}.zip`]);
      expect(sha256(await readFile(join(cacheDir, files[0] as string)))).toBe(archiveSha);
      expect(await fingerprint(destination())).toEqual(original);
    });

    it(
      'is recognized by discovery as registered, and not as a new VM',
      async () => {
        const discovery = await discover(VM);
        const listed = discovery.vms.find((vm) => vm.vmName === VM);
        expect(listed).toMatchObject({ registered: true });
        expect(await vmState(VM)).toMatchObject({ execution_state: 'idle' });
      },
      LONG,
    );

    it('will not restore over a copy this agent is known to hold', async () => {
      const response = await admin.request({
        method: 'POST',
        url: '/admin/restores',
        payload: { agentId, emulatorType: 'qemu', vmName: VM, versionId: version },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('local_copy_exists');
    });

    it(
      'notices a removed copy, and restores it again from the cache alone',
      async () => {
        await rm(destination(), { recursive: true, force: true });
        await discover('');
        expect(await vmState(VM)).toMatchObject({ execution_state: 'absent' });

        const operation = await restore(VM, version);
        const done = await restoreFinished(operation.id);
        expect(done, JSON.stringify(done)).toMatchObject({
          state: 'succeeded',
          cache: { hit: true, downloadedBytes: 0 },
        });
        expect(await fingerprint(destination())).toEqual(original);
      },
      LONG,
    );

    it(
      'refuses a corrupted cache entry and downloads a good copy',
      async () => {
        await rm(destination(), { recursive: true, force: true });
        await discover('');
        const entry = join(cacheDir, `${version}-${archiveSha}.zip`);
        const bytes = await readFile(entry);
        bytes[bytes.length >> 1] = (bytes[bytes.length >> 1] as number) ^ 0xff;
        await writeFile(entry, bytes);

        const operation = await restore(VM, version);
        const done = await restoreFinished(operation.id);
        expect(done, JSON.stringify(done)).toMatchObject({
          state: 'succeeded',
          cache: { hit: false, downloadedBytes: archiveSize },
        });
        expect(await fingerprint(destination())).toEqual(original);
        expect(sha256(await readFile(entry))).toBe(archiveSha);
      },
      LONG,
    );

    it(
      'never overwrites an existing directory, in any capitalization',
      async () => {
        await rm(destination(), { recursive: true, force: true });
        await discover('');
        const squatter = join(qemu, VM.toUpperCase());
        await mkdir(squatter);
        await writeFile(join(squatter, 'precious.txt'), 'do not touch');

        const operation = await restore(VM, version);
        const done = await restoreFinished(operation.id);
        expect(done.state, JSON.stringify(done)).toBe('failed');
        expect(done.error?.code).toBe('restore_destination_exists');
        expect(await readFile(join(squatter, 'precious.txt'), 'utf8')).toBe('do not touch');
        expect(await readdir(squatter)).toEqual(['precious.txt']);
        await assertNothingLeftBehind();
        await rm(squatter, { recursive: true, force: true });
      },
      LONG,
    );

    it(
      'fails cleanly when the repository’s copy is damaged, and changes nothing',
      async () => {
        const damaged = await qemuVm('Damaged', 1);
        const done = await register('Damaged', 'qemu', 'transfer');
        expect(existsSync(damaged)).toBe(false);
        const path = `/srv/sftp/repo/archives/qemu/damaged/${done.versionId}.zip`;
        docker(
          'exec',
          container,
          'sh',
          '-c',
          `printf 'XXXX' | dd of='${path}' bs=1 seek=4096 conv=notrunc 2>/dev/null`,
        );
        const operation = await restore('Damaged', done.versionId);
        const failed = await restoreFinished(operation.id);
        expect(failed.state, JSON.stringify(failed)).toBe('failed');
        expect(failed.error?.code).toBe('hash_mismatch');
        expect(existsSync(join(qemu, 'Damaged'))).toBe(false);
        await assertNothingLeftBehind();
      },
      LONG,
    );

    describe('interruptions', () => {
      const BIG = 'Big VM';
      let bigOriginal: Record<string, string>;
      let bigVersion: string;

      beforeAll(async () => {
        const root = await qemuVm(BIG, 64);
        bigOriginal = await fingerprint(root);
        const done = await register(BIG, 'qemu', 'transfer');
        bigVersion = done.versionId;
      }, LONG);

      /** The repository stops answering, so a transfer is in flight for as long as a test needs. */
      const pauseRepository = () => docker('pause', container);
      const resumeRepository = () => docker('unpause', container);

      const untilDownloading = (id: string) =>
        waitFor(
          async () => (await readRestore(id)).state === 'downloading',
          'the download to start',
          20_000,
        );

      const clearLocal = async () => {
        await rm(join(qemu, BIG), { recursive: true, force: true });
        await rm(join(cacheDir, `${bigVersion}-placeholder`), { force: true });
      };

      const purgeCache = async () => {
        for (const name of await readdir(cacheDir)) {
          if (name.startsWith(bigVersion)) await rm(join(cacheDir, name), { force: true });
        }
      };

      it(
        'cancels during the download, and leaves nothing',
        async () => {
          const operation = await restore(BIG, bigVersion);
          await untilDownloading(operation.id);
          pauseRepository();
          const response = await admin.request({
            method: 'POST',
            url: `/admin/restores/${operation.id}/cancel`,
          });
          expect(response.statusCode, response.body).toBe(200);
          const done = await restoreFinished(operation.id, 30_000);
          resumeRepository();
          expect(done.state, JSON.stringify(done)).toBe('cancelled');
          expect(existsSync(join(qemu, BIG))).toBe(false);
          await assertNothingLeftBehind();
        },
        LONG,
      );

      it(
        'reports a repository that goes away, and a retry works',
        async () => {
          const operation = await restore(BIG, bigVersion);
          await untilDownloading(operation.id);
          pauseRepository();
          const done = await restoreFinished(operation.id, 60_000);
          resumeRepository();
          expect(done.state, JSON.stringify(done)).toBe('failed');
          expect(['repository_unreachable', 'upload_interrupted', 'repository_error']).toContain(
            done.error?.code,
          );
          expect(existsSync(join(qemu, BIG))).toBe(false);
          await assertNothingLeftBehind();

          const again = await restore(BIG, bigVersion);
          const finished = await restoreFinished(again.id);
          expect(finished.state, JSON.stringify(finished)).toBe('succeeded');
          expect(await fingerprint(join(qemu, BIG))).toEqual(bigOriginal);
          await clearLocal();
          await discover('');
          await purgeCache();
        },
        LONG,
      );

      it(
        'survives an agent killed during the download',
        async () => {
          const operation = await restore(BIG, bigVersion);
          await untilDownloading(operation.id);
          pauseRepository();
          await killAgent();
          resumeRepository();
          expect(await stat(join(stateDir, 'restores', `${operation.id}.journal`))).toBeTruthy();

          await startDaemon();
          const done = await restoreFinished(operation.id, 30_000);
          expect(done.state, JSON.stringify(done)).toBe('failed');
          expect(done.error?.code).toBe('agent_restarted');
          expect(done.recovery).toMatch(/safe to try again/);
          expect(existsSync(join(qemu, BIG))).toBe(false);
          await assertNothingLeftBehind();

          const again = await restore(BIG, bigVersion);
          const finished = await restoreFinished(again.id);
          expect(finished.state, JSON.stringify(finished)).toBe('succeeded');
          expect(await fingerprint(join(qemu, BIG))).toEqual(bigOriginal);
          await clearLocal();
          await discover('');
          await purgeCache();
        },
        LONG,
      );

      it(
        'survives an API restart during the download',
        async () => {
          const operation = await restore(BIG, bigVersion);
          await untilDownloading(operation.id);
          await stopServer();
          // The work is the agent's, and it carries on with nobody listening.
          await waitFor(() => existsSync(join(qemu, BIG)), 'the VM to be published', 120_000);
          await startServer();
          const done = await restoreFinished(operation.id, 60_000);
          expect(done.state, JSON.stringify(done)).toBe('succeeded');
          expect(await fingerprint(join(qemu, BIG))).toEqual(bigOriginal);
          expect(await vmState(BIG)).toMatchObject({
            execution_state: 'idle',
            local_source_version_id: bigVersion,
          });
          // The report repeated until it was answered, so nothing is left unresolved.
          await waitFor(
            async () => !existsSync(join(stateDir, 'restores', `${operation.id}.journal`)),
            'the agent to close the operation',
            60_000,
          );
        },
        LONG,
      );
    });

    it(
      'restores through the web interface, with progress and the result on screen',
      async () => {
        const root = await qemuVm('Via Browser', 8);
        const expected = await fingerprint(root);
        await register('Via Browser', 'qemu', 'transfer');
        const adminContext = await browser.newContext();
        const page = await adminContext.newPage();
        await signIn(page);
        await page.goto(webUrl(`/admin/vms/qemu/${encodeURIComponent('Via Browser')}`));
        await page.getByRole('button', { name: 'Restore…' }).click();
        const dialog = page.getByRole('dialog', { name: 'Restore Via Browser' });
        await dialog.waitFor();
        await dialog.getByText(join(qemu, 'Via Browser')).waitFor();
        await shot(page, '7-restore-dialog');
        await dialog
          .getByText('creates a local copy of the immutable master', { exact: false })
          .waitFor();
        await dialog.getByRole('button', { name: 'Restore' }).click();
        await dialog.waitFor({ state: 'detached' });
        const card = page.getByRole('article', { name: /Restore on/ });
        await card.getByText('Restored', { exact: true }).waitFor({ timeout: 120_000 });
        await card.getByText(join(qemu, 'Via Browser')).waitFor();
        await card.getByText(/files were verified by the agent/).waitFor();
        await card.getByText(/The VM was not started/).waitFor();
        await shot(page, '8-restored');
        await adminContext.close();
        expect(await fingerprint(join(qemu, 'Via Browser'))).toEqual(expected);
      },
      LONG,
    );

    it(
      'reports changes conservatively after the agent reconnects',
      async () => {
        // A new connection means that the copy could have changed in the meantime.
        await killAgent();
        await writeFile(join(destination2(), 'run.bat'), 'changed, and longer than it was before');
        await startDaemon();
        await waitFor(
          async () => (await vmState('Via Browser'))?.content_status === 'modified',
          'the change to be noticed',
          20_000,
        );
      },
      LONG,
    );

    const destination2 = () => join(qemu, 'Via Browser');

    it('sends screenshots through the API, and never through the repository', () => {
      const files = docker('exec', container, 'sh', '-c', 'cd /srv/sftp/repo && find . -type f');
      expect(files).not.toMatch(/\.(png|jpg|bmp|ppm)/i);
      expect(files).toMatch(/\.zip/);
    });
  });

  describe('what must not have happened', () => {
    it('touched no directory outside this test’s own', async () => {
      // The agent only knows the base paths this file gave it.
      const config = await readFile(configPath, 'utf8');
      expect(config).not.toContain('emucat-86box');
      expect(config).not.toContain('emucat-qemu');
      expect(config).toContain(directory.replaceAll('\\', '\\\\'));
    });
  });
});
