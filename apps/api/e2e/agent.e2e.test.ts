/**
 * The real compiled agent against the real API on a real database: pairing, the credential surviving
 * a restart, presence, discovery, reconnection after a server restart, and revocation.
 *
 * Run with `pnpm test:e2e`, which builds the agent first. MariaDB must be running. Windows only, until
 * another platform has a credential store.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  agentSummarySchema,
  discoveryOperationSchema,
  discoveryStateResponseSchema,
  pairingRequestReviewSchema,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENEROUS_RATE_LIMITS, count, waitFor } from '../test/agent-helpers.js';
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

interface RunningAgent {
  process: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

function startAgent(configPath: string, ...args: string[]): RunningAgent {
  const process = spawn(AGENT_BINARY, [...args, '--config', configPath, '--log-level', 'trace'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  process.stdout?.on('data', (chunk) => {
    output += String(chunk);
    allOutput.push(String(chunk));
  });
  process.stderr?.on('data', (chunk) => {
    output += String(chunk);
    allOutput.push(String(chunk));
  });
  const exited = new Promise<number | null>((done) => process.on('exit', (code) => done(code)));
  running.push(process);
  return { process, output: () => output, exited };
}

const running: ChildProcess[] = [];
const allOutput: string[] = [];

/** Everything under a directory, with what could show a change. */
async function fingerprint(root: string): Promise<string[]> {
  const entries: string[] = [];
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const path = join(root, String(name));
    const info = await stat(path);
    const contents = info.isFile() ? (await readFile(path)).toString('hex') : '';
    entries.push(`${String(name)}|${info.mtimeMs}|${contents}`);
  }
  return entries;
}

describe.runIf(process.platform === 'win32')('the real agent and the real API', () => {
  let context: BrowserTestContext;
  let admin: TestClient;
  let apiUrl: string;
  let directory: string;
  let configPath: string;
  let box86: string;
  let qemu: string;
  let agentId: string;
  let daemon: RunningAgent;
  let server: FastifyInstance;

  beforeAll(async () => {
    if (!existsSync(AGENT_BINARY)) throw new Error(`Build the agent first: ${AGENT_BINARY}`);
    context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
    admin = await signedInAdmin(context);
    server = context.app;
    await server.listen({ host: '127.0.0.1', port: 0 });
    apiUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;

    directory = await mkdtemp(join(tmpdir(), 'emucat-e2e-'));
    box86 = join(directory, 'box86');
    qemu = join(directory, 'qemu');
    await mkdir(join(box86, 'DOS 6.22'), { recursive: true });
    await writeFile(join(box86, 'DOS 6.22', '86box.cfg'), 'machine = x\n');
    await mkdir(join(box86, 'NoMarker'));
    await mkdir(join(box86, 'bad.name.'), { recursive: true }).catch(() => undefined);
    await mkdir(join(qemu, 'Win98'), { recursive: true });
    await writeFile(join(qemu, 'Win98', 'run-win.cmd'), 'echo never run\n');
    await writeFile(join(qemu, 'Win98', 'run-linux.sh'), 'echo never run\n');
    await mkdir(join(qemu, 'LinuxOnly'));
    await writeFile(join(qemu, 'LinuxOnly', 'run-linux.sh'), 'echo never run\n');
    const executable = join(directory, 'emulator.exe');
    await writeFile(executable, '');

    configPath = join(directory, 'agent.toml');
    await writeFile(
      configPath,
      [
        '[server]',
        `api_url = ${JSON.stringify(apiUrl)}`,
        '[agent]',
        'name = "E2E machine"',
        '[emulators.86box]',
        `base_path = ${JSON.stringify(box86)}`,
        `executable = ${JSON.stringify(executable)}`,
        '[emulators.qemu]',
        `base_path = ${JSON.stringify(qemu)}`,
        `executable = ${JSON.stringify(executable)}`,
        '[state]',
        `dir = ${JSON.stringify(join(directory, 'state'))}`,
        '',
      ].join('\n'),
    );
  });

  afterAll(async () => {
    for (const child of running) child.kill();
    await context?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const summary = async () =>
    agentSummarySchema.parse((await admin.get(`/admin/agents/${agentId}`)).json());

  it('refuses to run before it is paired', async () => {
    const agent = startAgent(configPath, 'run');
    expect(await agent.exited).toBe(1);
    expect(agent.output()).toContain('not paired');
  });

  it('pairs after an administrator approves', async () => {
    const pairing = startAgent(configPath, 'pair');
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
    expect(review).toMatchObject({
      name: 'E2E machine',
      platform: 'windows',
      architecture: 'x86_64',
      status: 'pending',
    });

    const decided = await admin.request({
      method: 'POST',
      url: `/admin/agent-pairing/requests/${review.id}/approve`,
      payload: { code },
    });
    expect(decided.statusCode).toBe(200);

    expect(await pairing.exited).toBe(0);
    agentId = /Paired as agent (\S+)\./.exec(pairing.output())?.[1] as string;
    expect(agentId).toBeTruthy();
  });

  it('stores the credential protected, and refuses to pair over it by accident', async () => {
    const stored = await readFile(join(directory, 'state', 'credential.dpapi'));
    expect(stored.includes('emucat_agent_')).toBe(false);
    expect(stored.includes('"credential"')).toBe(false);
    const config = await readFile(configPath, 'utf8');
    expect(config).not.toContain('emucat_agent_');

    const again = startAgent(configPath, 'pair');
    expect(await again.exited).toBe(1);
    expect(again.output()).toContain('already paired');
  });

  it('connects with the stored credential and shows as online', async () => {
    daemon = startAgent(configPath, 'run');
    await waitFor(async () => (await summary()).online, 'the agent to be online');
    expect(await summary()).toMatchObject({
      name: 'E2E machine',
      pairingStatus: 'paired',
      platform: 'windows',
    });
  });

  async function discover() {
    const started = await admin.request({
      method: 'POST',
      url: `/admin/agents/${agentId}/discovery`,
    });
    expect(started.statusCode, started.body).toBe(202);
    const { id } = discoveryOperationSchema.parse(started.json());
    return waitFor(async () => {
      const { operation } = discoveryStateResponseSchema.parse(
        (await admin.get(`/admin/agents/${agentId}/discovery`)).json(),
      );
      return operation?.id === id && operation.status !== 'running' ? operation : null;
    }, 'the scan');
  }

  it('discovers what is in the configured directories, changing nothing', async () => {
    const before = [await fingerprint(box86), await fingerprint(qemu)];
    const catalog = await count(context.pool, 'virtual_machines');

    const operation = await discover();
    expect(operation.status).toBe('completed');
    expect(operation.hostPlatform).toBe('windows');

    const found = Object.fromEntries(operation.vms.map((vm) => [vm.vmName, vm]));
    expect(found['DOS 6.22']).toMatchObject({
      emulatorType: '86box',
      markers: ['86box.cfg'],
      hostCompatible: null,
      registered: false,
    });
    expect(found.Win98).toMatchObject({
      emulatorType: 'qemu',
      markers: ['run-win.cmd', 'run-linux.sh'],
      hostCompatible: true,
    });
    expect(found.LinuxOnly).toMatchObject({ hostCompatible: false });
    expect(operation.skipped).toContainEqual({
      emulatorType: '86box',
      name: 'NoMarker',
      reason: 'missing_marker',
      nameError: null,
    });

    expect([await fingerprint(box86), await fingerprint(qemu)]).toEqual(before);
    expect(await count(context.pool, 'virtual_machines')).toBe(catalog);
  });

  it('reports a base directory that disappears while it runs', async () => {
    const moved = join(directory, 'moved');
    const { rename } = await import('node:fs/promises');
    await rename(qemu, moved);
    const operation = await discover();
    expect(operation.emulators.find((e) => e.emulatorType === 'qemu')?.status).toBe(
      'base_path_missing',
    );
    await rename(moved, qemu);
  });

  it('reconnects by itself after the server restarts', async () => {
    const port = (server.server.address() as AddressInfo).port;
    await server.close();
    await waitFor(() => /reconnecting/.test(daemon.output()), 'the agent to notice');
    expect(daemon.process.exitCode).toBeNull();

    server = await context.buildAnother();
    await server.listen({ host: '127.0.0.1', port });
    admin = new TestClient(server);
    expect((await admin.login('admin', ADMIN_PASSWORD)).statusCode).toBe(200);
    await waitFor(async () => (await summary()).online, 'the agent to return', 90_000);

    const operation = await discover();
    expect(operation.status).toBe('completed');
  }, 120_000);

  it('survives its own restart, keeping its identity', async () => {
    daemon.process.kill();
    await daemon.exited;
    await waitFor(async () => !(await summary()).online, 'the agent to go offline');

    daemon = startAgent(configPath, 'run');
    await waitFor(async () => (await summary()).online, 'the agent to return');
    expect((await summary()).id).toBe(agentId);
  });

  it('is disconnected by revocation, stops, and cannot return', async () => {
    const response = await admin.request({
      method: 'POST',
      url: `/admin/agents/${agentId}/revoke`,
    });
    expect(agentSummarySchema.parse(response.json())).toMatchObject({
      pairingStatus: 'revoked',
      online: false,
    });
    expect(await daemon.exited).toBe(1);
    expect(daemon.output()).toContain('pair --force');

    const blocked = startAgent(configPath, 'run');
    expect(await blocked.exited).toBe(1);
    expect(blocked.output()).toContain('pair --force');
    expect((await summary()).online).toBe(false);
  });

  it('left VM directories alone, and never logged a secret, even at trace level', async () => {
    const all = allOutput.join('');
    expect(all).toContain('Pairing code');
    expect(all).not.toMatch(/emucat_agent_[A-Za-z0-9_-]{20}/);
    expect(all).not.toMatch(/emucat_pairing_[A-Za-z0-9_-]{20}/);
    expect(all.toLowerCase()).not.toContain('bearer ');
    expect(await readdir(join(box86, 'DOS 6.22'))).toEqual(['86box.cfg']);
    expect((await readdir(join(qemu, 'Win98'))).sort()).toEqual(['run-linux.sh', 'run-win.cmd']);
  });

  it('can be removed locally, leaving VM directories untouched', async () => {
    const before = await fingerprint(box86);
    const unpair = startAgent(configPath, 'unpair');
    expect(await unpair.exited).toBe(0);
    expect(existsSync(join(directory, 'state', 'credential.dpapi'))).toBe(false);
    expect(await fingerprint(box86)).toEqual(before);
  });
});
