/**
 * The real compiled agent, asking the real VirtualBox of this computer for its machines, reported through
 * the real API. Read-only: it checks that every machine is in the same state afterwards.
 *
 * Opt-in, since it needs VirtualBox: set `EMUCAT_E2E_VBOXMANAGE` to the path of `VBoxManage.exe`, then
 * run `pnpm test:e2e -- virtualbox`. MariaDB must be running. Windows only.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  discoveryOperationSchema,
  discoveryStateResponseSchema,
  pairingRequestReviewSchema,
  type DiscoveryOperation,
} from '@emucat/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENEROUS_RATE_LIMITS, count, waitFor } from '../test/agent-helpers.js';
import {
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from '../test/browser-app.js';

const run = promisify(execFile);
const VBOXMANAGE = process.env.EMUCAT_E2E_VBOXMANAGE;
const profile = process.env.EMUCAT_AGENT_E2E_PROFILE ?? 'debug';
const AGENT_BINARY = resolve(
  import.meta.dirname,
  `../../../agent/target/${profile}/emucat-agent.exe`,
);

/** What VirtualBox itself says, read-only, for comparison. Always by UUID. */
async function listed(): Promise<{ uuid: string; name: string }[]> {
  const { stdout } = await run(VBOXMANAGE!, ['list', 'vms'], { windowsHide: true });
  return stdout
    .split(/\r?\n/)
    .map((line) => /^"(.*)" \{([0-9a-f-]{36})\}$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ name: match[1]!, uuid: match[2]! }));
}

async function stateOf(uuid: string): Promise<string> {
  const { stdout } = await run(VBOXMANAGE!, ['showvminfo', uuid, '--machinereadable'], {
    windowsHide: true,
  });
  const line = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(stdout)?.[1] ?? '';
  return `${line('VMState')}|${line('VMStateChangeTime')}`;
}

describe.runIf(process.platform === 'win32' && !!VBOXMANAGE)(
  'the real agent and VirtualBox',
  () => {
    let context: BrowserTestContext;
    let admin: TestClient;
    let directory: string;
    let configPath: string;
    let agentId: string;
    const children: ChildProcess[] = [];
    let before: Map<string, string>;

    function startAgent(...args: string[]) {
      const child = spawn(AGENT_BINARY, [...args, '--config', configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout?.on('data', (chunk) => (output += String(chunk)));
      child.stderr?.on('data', (chunk) => (output += String(chunk)));
      const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
      children.push(child);
      return { output: () => output, exited };
    }

    beforeAll(async () => {
      if (!existsSync(AGENT_BINARY)) throw new Error(`Build the agent first: ${AGENT_BINARY}`);
      before = new Map();
      for (const vm of await listed()) before.set(vm.uuid, await stateOf(vm.uuid));

      context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
      admin = await signedInAdmin(context);
      await context.app.listen({ host: '127.0.0.1', port: 0 });
      const apiUrl = `http://127.0.0.1:${(context.app.server.address() as AddressInfo).port}`;

      directory = await mkdtemp(join(tmpdir(), 'emucat-vbox-e2e-'));
      const qemu = join(directory, 'qemu');
      await mkdir(join(qemu, 'Win98'), { recursive: true });
      await writeFile(join(qemu, 'Win98', 'run.bat'), 'echo never run\n');
      const executable = join(directory, 'qemu.exe');
      await writeFile(executable, '');
      configPath = join(directory, 'agent.toml');
      await writeFile(
        configPath,
        [
          '[server]',
          `api_url = ${JSON.stringify(apiUrl)}`,
          '[agent]',
          'name = "VirtualBox E2E"',
          '[emulators.qemu]',
          `base_path = ${JSON.stringify(qemu)}`,
          `executable = ${JSON.stringify(executable)}`,
          '[platforms.virtualbox]',
          `vboxmanage = ${JSON.stringify(VBOXMANAGE)}`,
          '[state]',
          `dir = ${JSON.stringify(join(directory, 'state'))}`,
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
      await admin.request({
        method: 'POST',
        url: `/admin/agent-pairing/requests/${review.id}/approve`,
        payload: { code },
      });
      expect(await pairing.exited).toBe(0);
      agentId = /Paired as agent (\S+)\./.exec(pairing.output())?.[1] as string;

      startAgent('run');
      await waitFor(
        async () =>
          (await admin.get(`/admin/agents/${agentId}`)).json<{ online: boolean }>().online,
        'the agent to be online',
      );
    }, 120_000);

    afterAll(async () => {
      for (const child of children) child.kill();
      await context?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    async function discover(): Promise<DiscoveryOperation> {
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

    it('reports every machine VirtualBox lists, beside the QEMU scan, changing nothing', async () => {
      const catalog = await count(context.pool, 'virtual_machines');
      const operation = await discover();
      expect(operation.status).toBe('completed');
      expect(operation.vms.map((vm) => vm.vmName)).toEqual(['Win98']);

      const virtualbox = operation.virtualbox!;
      expect(virtualbox.status).toBe('ok');
      expect(virtualbox.version).toMatch(/^\d+\.\d+/);
      const expected = await listed();
      expect(virtualbox.vms.map((vm) => vm.uuid)).toEqual(expected.map((vm) => vm.uuid));
      expect(virtualbox.vms.map((vm) => vm.name)).toEqual(expected.map((vm) => vm.name));
      for (const vm of virtualbox.vms) {
        expect(vm.error, vm.name).toBeNull();
        expect(vm.state, vm.name).not.toBe('unknown');
        const raw = before.get(vm.uuid)?.split('|')[0]?.replaceAll('"', '');
        expect(vm.rawState, vm.name).toBe(raw);
      }
      const raw = (await admin.get(`/admin/agents/${agentId}/discovery`)).body;
      expect(raw).not.toMatch(/\.vbox|\.vdi|VirtualBox VMs/);

      // Nothing was registered, and no machine changed state.
      expect(await count(context.pool, 'virtual_machines')).toBe(catalog);
      for (const [uuid, state] of before) expect(await stateOf(uuid), uuid).toBe(state);
    });
  },
);
