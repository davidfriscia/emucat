/**
 * VirtualBox registration and local execution (decision 0045) through the real API, on a real database, over a
 * real WebSocket. The agent is a script: each export, command and observation is arranged exactly. Nothing here
 * runs VirtualBox; `agent/tests/virtualbox_operations.rs` drives the real agent against a fake VBoxManage.
 */
import { randomUUID } from 'node:crypto';
import {
  executionOptionsResponseSchema,
  registrationOperationSchema,
  repositorySummarySchema,
  vmSessionSchema,
  type RegistrationOperation,
  type RepositorySummary,
  type VmSession,
} from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GENEROUS_RATE_LIMITS,
  TestAgent,
  envelope,
  pairAgent,
  waitFor,
  wsUrl,
  type PairedAgent,
} from './agent-helpers.js';
import {
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from './browser-app.js';

const SHA = 'c'.repeat(64);
const MACHINE = '2acda0fc-cea6-406b-8a55-746fac380687';
const OTHER_MACHINE = '97910566-2cc6-492b-9dc7-6cc6ee66ffd6';
const VM_NAME = 'xenix-386';
const VM_PATH = `/admin/vms/virtualbox/${VM_NAME}`;

interface World {
  context: BrowserTestContext;
  admin: TestClient;
  agent: TestAgent;
  paired: PairedAgent;
  repository: RepositorySummary;
}

let worlds: BrowserTestContext[] = [];

afterEach(async () => {
  for (const context of worlds) await context.close();
  worlds = [];
});

async function barrier(agent: TestAgent): Promise<void> {
  agent.send(envelope('agent.heartbeat', {}));
  await agent.next('server.heartbeat_ack');
}

async function sync(agent: TestAgent, virtualbox: boolean, operations: object[] = []) {
  agent.send(
    envelope('agent.registration_sync', { operations, ...(virtualbox ? { virtualbox } : {}) }),
  );
  await barrier(agent);
}

async function world(options: { virtualbox?: boolean } = {}): Promise<World> {
  const context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
  worlds.push(context);
  await context.app.listen({ host: '127.0.0.1', port: 0 });
  const admin = await signedInAdmin(context);
  const paired = await pairAgent(context.app, admin);
  const agent = await TestAgent.connect(wsUrl(context.app), paired.credential);
  await agent.hello();
  await sync(agent, options.virtualbox ?? true);
  // A capable agent is told at once what to watch: nothing yet.
  if (options.virtualbox ?? true) {
    expect((await agent.next('server.virtualbox_watch')).payload.machines).toEqual([]);
  }
  const created = await admin.request({
    method: 'POST',
    url: '/admin/repositories',
    payload: {
      name: 'NAS',
      host: 'nas.example',
      port: 22,
      username: 'emucat',
      remoteRoot: '/srv/emucat',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const repository = repositorySummarySchema.parse(created.json());
  const associated = await admin.request({
    method: 'PUT',
    url: `/admin/repositories/${repository.id}/agents/${paired.agentId}`,
  });
  expect(associated.statusCode, associated.body).toBe(200);
  return { context, admin, agent, paired, repository };
}

function machine(overrides: object = {}) {
  return {
    uuid: MACHINE,
    name: 'Xenix 386',
    osType: 'Other/Unknown',
    state: 'powered_off',
    rawState: 'poweroff',
    stateChangedAt: '2026-01-31T15:30:00.000Z',
    accessible: true,
    memoryMb: 4,
    cpus: 1,
    error: null,
    ...overrides,
  };
}

/** A discovery whose VirtualBox report this script supplies. */
async function discover(w: World, vms: object[] = [machine()]): Promise<string> {
  const started = await w.admin.request({
    method: 'POST',
    url: `/admin/agents/${w.paired.agentId}/discovery`,
  });
  expect(started.statusCode, started.body).toBe(202);
  const request = await w.agent.next('server.discovery_request');
  w.agent.send(
    envelope('agent.discovery_result', {
      operationId: request.payload.operationId,
      hostPlatform: 'windows',
      emulators: [],
      vms: [],
      skipped: [],
      virtualbox: { status: 'ok', version: '7.1.10r169112', truncated: false, vms },
    }),
  );
  return waitFor(async () => {
    const state = await w.admin.get(`/admin/agents/${w.paired.agentId}/discovery`);
    const operation = state.json<{ operation: { id: string; status: string } }>().operation;
    return operation.status === 'completed' ? operation.id : undefined;
  }, 'the discovery to finish');
}

function registerRequest(w: World, discoveryOperationId: string, overrides: object = {}) {
  return w.admin.request({
    method: 'POST',
    url: '/admin/registrations',
    payload: {
      agentId: w.paired.agentId,
      repositoryId: w.repository.id,
      emulatorType: 'virtualbox',
      vmName: VM_NAME,
      mode: 'copy',
      discoveryOperationId,
      virtualboxUuid: MACHINE,
      ...overrides,
    },
  });
}

async function errorCode(response: { json: <T>() => T }): Promise<string> {
  return response.json<{ error: { code: string } }>().error.code;
}

async function read(w: World, operationId: string): Promise<RegistrationOperation> {
  const response = await w.admin.get(`/admin/registrations/${operationId}`);
  expect(response.statusCode, response.body).toBe(200);
  return registrationOperationSchema.parse(response.json());
}

async function rows(w: World, sql: string, values: string[] = []) {
  const [result] = await w.context.pool.execute<RowDataPacket[]>(sql, values);
  return result;
}

/** Takes a registration as far as a committed OVA master, and the agent watching its machine. */
async function registered(w: World): Promise<RegistrationOperation> {
  const discoveryId = await discover(w);
  const response = await registerRequest(w, discoveryId);
  expect(response.statusCode, response.body).toBe(202);
  const operation = registrationOperationSchema.parse(response.json());
  await w.agent.next('server.virtualbox_registration_request');
  w.agent.send(
    envelope('agent.virtualbox_registration_result', {
      operationId: operation.id,
      versionId: operation.versionId,
      archiveKey: operation.archiveKey,
      archiveSizeBytes: 1 << 20,
      archiveSha256: SHA,
    }),
  );
  expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('committed');
  const watch = await w.agent.next('server.virtualbox_watch');
  expect(watch.payload.machines).toEqual([MACHINE]);
  // As the agent does at once: the machine stays in VirtualBox, so its local copy is preserved.
  w.agent.send(
    envelope('agent.registration_cleanup', {
      operationId: operation.id,
      versionId: operation.versionId,
      localCopy: 'preserved',
      code: null,
      message: null,
    }),
  );
  expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
  return operation;
}

function observation(overrides: object = {}) {
  return {
    machineUuid: MACHINE,
    present: true,
    name: 'Xenix 386',
    state: 'running',
    rawState: 'running',
    stateChangedAt: new Date().toISOString(),
    accessible: true,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function observe(w: World, machines: object[], complete = false): Promise<void> {
  w.agent.send(envelope('agent.virtualbox_states', { complete, available: true, machines }));
  await barrier(w.agent);
}

async function launch(w: World, overrides: object = {}) {
  return w.admin.request({
    method: 'POST',
    url: '/admin/sessions',
    payload: {
      agentId: w.paired.agentId,
      emulatorType: 'virtualbox',
      vmName: VM_NAME,
      mode: 'local',
      requestId: randomUUID(),
      ...overrides,
    },
  });
}

async function session(w: World, id: string): Promise<VmSession> {
  const response = await w.admin.get(`/admin/sessions/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return vmSessionSchema.parse(response.json());
}

describe('registering a VirtualBox machine', () => {
  // Asks the agent to export by UUID, then commits the OVA as the master.
  it('exports it by UUID and commits the OVA as an immutable master, linked to the machine', async () => {
    const w = await world();
    const discoveryId = await discover(w);
    const response = await registerRequest(w, discoveryId);
    expect(response.statusCode, response.body).toBe(202);
    const operation = registrationOperationSchema.parse(response.json());
    expect(operation.archiveKey).toBe(`archives/virtualbox/${VM_NAME}/${operation.versionId}.ova`);
    expect(operation.virtualboxUuid).toBe(MACHINE);

    const request = await w.agent.next('server.virtualbox_registration_request');
    expect(request.payload).toEqual({
      operationId: operation.id,
      vmName: VM_NAME,
      machineUuid: MACHINE,
      repositoryId: w.repository.id,
      versionId: operation.versionId,
      archiveKey: operation.archiveKey,
    });
    // Never the filesystem request, whose agent would look for a directory.
    expect(w.agent.received.some((m) => m.type === 'server.registration_request')).toBe(false);

    w.agent.send(
      envelope('agent.virtualbox_registration_result', {
        operationId: operation.id,
        versionId: operation.versionId,
        archiveKey: operation.archiveKey,
        archiveSizeBytes: 1 << 20,
        archiveSha256: SHA,
      }),
    );
    const ack = await w.agent.next('server.registration_ack');
    expect(ack.payload).toMatchObject({ outcome: 'committed', removeLocal: false });
    expect((await w.agent.next('server.virtualbox_watch')).payload.machines).toEqual([MACHINE]);

    const [version] = await rows(w, 'SELECT * FROM vm_versions WHERE vm_name = ?', [VM_NAME]);
    expect(version).toMatchObject({
      id: operation.versionId,
      emulator_type: 'virtualbox',
      kind: 'master',
      archive_key: operation.archiveKey,
      archive_sha256: SHA,
    });
    const [source] = await rows(w, 'SELECT * FROM virtualbox_sources WHERE vm_name = ?', [VM_NAME]);
    expect(source).toMatchObject({ agent_id: w.paired.agentId, machine_uuid: MACHINE });

    w.agent.send(
      envelope('agent.registration_cleanup', {
        operationId: operation.id,
        versionId: operation.versionId,
        localCopy: 'preserved',
        code: null,
        message: null,
      }),
    );
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
    const done = await read(w, operation.id);
    expect(done.state).toBe('succeeded');
    expect(done.archive).toMatchObject({ format: 'ova', sha256: SHA, sizeBytes: 1 << 20 });

    // The discovery now names the machine's catalog entry.
    const discovery = await w.admin.get(`/admin/agents/${w.paired.agentId}/discovery`);
    expect(
      discovery.json<{ operation: { virtualboxRegistrations: unknown[] } }>().operation
        .virtualboxRegistrations,
    ).toEqual([{ machineUuid: MACHINE, vmName: VM_NAME }]);
  });

  it('refuses a machine that is already registered, under any name', async () => {
    const w = await world();
    await registered(w);
    const discoveryId = await discover(w);
    const again = await registerRequest(w, discoveryId, { vmName: 'xenix-again' });
    expect(again.statusCode).toBe(409);
    expect(await errorCode(again)).toBe('virtualbox_already_registered');
    expect(await rows(w, 'SELECT * FROM virtualbox_sources')).toHaveLength(1);
  });

  it('refuses a machine that is not powered off, or not in the discovery', async () => {
    const w = await world();
    const discoveryId = await discover(w, [
      machine({ state: 'saved', rawState: 'saved' }),
      machine({ uuid: OTHER_MACHINE, state: 'running', rawState: 'running' }),
    ]);
    const saved = await registerRequest(w, discoveryId);
    expect(saved.statusCode).toBe(409);
    expect(await errorCode(saved)).toBe('virtualbox_not_powered_off');
    const running = await registerRequest(w, discoveryId, { virtualboxUuid: OTHER_MACHINE });
    expect(await errorCode(running)).toBe('virtualbox_not_powered_off');
    const unknown = await registerRequest(w, discoveryId, {
      virtualboxUuid: '14883fa7-b01e-46cc-ba51-04f36f2d7478',
    });
    expect(unknown.statusCode).toBe(409);
    expect(await rows(w, 'SELECT * FROM registration_operations')).toEqual([]);
  });

  it('refuses an agent that has not said it can export VirtualBox machines', async () => {
    const w = await world({ virtualbox: false });
    const discoveryId = await discover(w);
    const response = await registerRequest(w, discoveryId);
    expect(response.statusCode).toBe(409);
    expect(await errorCode(response)).toBe('agent_cannot_register');
  });

  it('refuses a transfer, and a ZIP where an OVA was asked for', async () => {
    const w = await world();
    const discoveryId = await discover(w);
    const transfer = await registerRequest(w, discoveryId, {
      mode: 'transfer',
      confirmDestructive: true,
    });
    expect(transfer.statusCode).toBe(400);

    const response = await registerRequest(w, discoveryId);
    const operation = registrationOperationSchema.parse(response.json());
    await w.agent.next('server.virtualbox_registration_request');
    w.agent.send(
      envelope('agent.registration_result', {
        operationId: operation.id,
        versionId: operation.versionId,
        archiveKey: operation.archiveKey,
        archiveSizeBytes: 2048,
        archiveSha256: SHA,
        manifestVersion: 1,
        manifestSha256: SHA,
        fileCount: 3,
        totalUncompressedBytes: 4096,
      }),
    );
    expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('rejected');
    expect((await read(w, operation.id)).state).toBe('failed');
    expect(await rows(w, 'SELECT * FROM vm_versions')).toEqual([]);
  });

  it('fails a queued export once the agent comes back unable to do it, having done nothing', async () => {
    const w = await world();
    const discoveryId = await discover(w);
    const response = await registerRequest(w, discoveryId);
    const operation = registrationOperationSchema.parse(response.json());
    await w.agent.next('server.virtualbox_registration_request');
    // An older agent, or one without VirtualBox configured, reports no journal for it and no capability.
    await sync(w.agent, false);
    const failed = await read(w, operation.id);
    expect(failed.state).toBe('failed');
    expect(failed.error?.code).toBe('virtualbox_unavailable');
  });
});

describe('running a VirtualBox VM', () => {
  it('offers Local only, and refuses the remote modes and a verification', async () => {
    const w = await world();
    await registered(w);
    const options = executionOptionsResponseSchema.parse(
      (await w.admin.get(`${VM_PATH}/execution-options`)).json(),
    );
    expect(options.modes.find((mode) => mode.mode === 'local')?.available).toBe(true);
    for (const mode of ['remote_volatile', 'remote_snapshot'] as const) {
      expect(options.modes.find((item) => item.mode === mode)?.available).toBe(false);
      expect(options.agents[0]?.remote[mode].eligible).toBe(false);
    }
    expect(options.agents[0]?.verify).toMatchObject({ eligible: false, reason: 'not_supported' });
    expect(options.virtualbox).toMatchObject({ machineUuid: MACHINE, agentId: w.paired.agentId });

    for (const mode of ['remote_volatile', 'remote_snapshot']) {
      // Without a working copy the request is invalid; with one, a VirtualBox VM has none to run.
      expect((await launch(w, { mode })).statusCode).toBe(400);
      const refused = await launch(w, { mode, workspaceId: randomUUID() });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(await errorCode(refused)).toBe('execution_mode_unavailable');
    }
    const workspace = await w.admin.request({
      method: 'POST',
      url: `${VM_PATH}/workspaces`,
      payload: {
        agentId: w.paired.agentId,
        versionId: (await rows(w, 'SELECT id FROM vm_versions'))[0]?.id,
        requestId: randomUUID(),
        mode: 'remote_volatile',
      },
    });
    expect(workspace.statusCode).toBeGreaterThanOrEqual(400);
    expect(w.agent.received.some((m) => m.type === 'server.virtualbox_control')).toBe(false);
    expect(await rows(w, 'SELECT * FROM vm_sessions')).toEqual([]);
  });

  it('starts the machine by UUID, and the session follows what the agent observes', async () => {
    const w = await world();
    await registered(w);
    const response = await launch(w);
    expect(response.statusCode, response.body).toBe(202);
    const requested = vmSessionSchema.parse(response.json());
    expect(requested.state).toBe('requested');

    const control = await w.agent.next('server.virtualbox_control');
    expect(control.payload).toEqual({
      sessionId: requested.id,
      machineUuid: MACHINE,
      action: 'start',
    });
    expect(w.agent.received.some((m) => m.type === 'server.vm_launch')).toBe(false);

    w.agent.send(
      envelope('agent.virtualbox_control_result', {
        sessionId: requested.id,
        machineUuid: MACHINE,
        action: 'start',
        accepted: true,
        code: null,
        message: null,
      }),
    );
    await barrier(w.agent);
    expect((await session(w, requested.id)).state).toBe('starting');

    await observe(w, [observation()]);
    expect((await session(w, requested.id)).state).toBe('running');

    const stop = await w.admin.request({
      method: 'POST',
      url: `/admin/sessions/${requested.id}/stop`,
      payload: { force: false },
    });
    expect(stop.statusCode, stop.body).toBe(202);
    expect((await w.agent.next('server.virtualbox_control')).payload.action).toBe('acpi_shutdown');

    // Still running: the guest has not shut down yet, and a stop was asked for.
    await observe(w, [observation()]);
    expect((await session(w, requested.id)).state).toBe('stopping');

    const forced = await w.admin.request({
      method: 'POST',
      url: `/admin/sessions/${requested.id}/stop`,
      payload: { force: true, confirmVmName: VM_NAME },
    });
    expect(forced.statusCode, forced.body).toBe(202);
    expect((await w.agent.next('server.virtualbox_control')).payload.action).toBe('poweroff');

    await observe(w, [observation({ state: 'powered_off', rawState: 'poweroff' })]);
    const ended = await session(w, requested.id);
    expect(ended.state).toBe('stopped');
    expect(ended.endedAt).not.toBeNull();
    const [source] = await rows(w, 'SELECT state, raw_state FROM virtualbox_sources');
    expect(source).toMatchObject({ state: 'powered_off', raw_state: 'poweroff' });
  });

  it('records a start VirtualBox refused, with its reason', async () => {
    const w = await world();
    await registered(w);
    const requested = vmSessionSchema.parse((await launch(w)).json());
    await w.agent.next('server.virtualbox_control');
    w.agent.send(
      envelope('agent.virtualbox_control_result', {
        sessionId: requested.id,
        machineUuid: MACHINE,
        action: 'start',
        accepted: false,
        code: 'control_refused',
        message: 'VirtualBox refused the command (VBOX_E_INVALID_VM_STATE)',
      }),
    );
    await barrier(w.agent);
    const failed = await session(w, requested.id);
    expect(failed.state).toBe('failed');
    expect(failed.error?.code).toBe('control_refused');
  });

  it('notices a machine started and stopped outside EmuCat', async () => {
    const w = await world();
    await registered(w);
    await observe(w, [observation()]);
    const [external] = await rows(w, 'SELECT * FROM vm_sessions');
    expect(external).toMatchObject({
      execution_state: 'running',
      user_id: null,
      mode: 'local',
      emulator_type: 'virtualbox',
    });
    // A second launch is refused while it runs.
    const refused = await launch(w);
    expect(refused.statusCode).toBe(409);

    await observe(w, [observation({ state: 'powered_off', rawState: 'poweroff' })]);
    const [ended] = await rows(w, 'SELECT execution_state FROM vm_sessions');
    expect(ended?.execution_state).toBe('exited');
  });

  it('reports an aborted machine as failed, and a vanished one as interrupted', async () => {
    const w = await world();
    await registered(w);
    await observe(w, [observation()]);
    await observe(w, [observation({ state: 'aborted', rawState: 'aborted' })]);
    expect((await rows(w, 'SELECT * FROM vm_sessions'))[0]).toMatchObject({
      execution_state: 'failed',
      error_code: 'vm_aborted',
    });

    await observe(w, [observation()]);
    await observe(w, [
      observation({
        present: false,
        name: null,
        state: 'unknown',
        rawState: null,
        accessible: null,
      }),
    ]);
    const sessions = await rows(w, 'SELECT * FROM vm_sessions ORDER BY created_at, id');
    expect(sessions.map((row) => row.execution_state).sort()).toEqual(['failed', 'interrupted']);
    const [source] = await rows(w, 'SELECT present FROM virtualbox_sources');
    expect(Boolean(source?.present)).toBe(false);
    // Kept: the catalog entry and its master stay.
    expect(await rows(w, 'SELECT * FROM vm_versions')).toHaveLength(1);
    const options = executionOptionsResponseSchema.parse(
      (await w.admin.get(`${VM_PATH}/execution-options`)).json(),
    );
    expect(options.agents[0]?.launch).toMatchObject({
      eligible: false,
      reason: 'source_unavailable',
    });
  });

  it('changes nothing for a busy or unknown state, or a machine not registered here', async () => {
    const w = await world();
    await registered(w);
    await observe(w, [observation()]);
    await observe(w, [
      observation({ state: 'busy', rawState: null }),
      observation({ machineUuid: OTHER_MACHINE, state: 'running' }),
    ]);
    const sessions = await rows(w, 'SELECT execution_state FROM vm_sessions');
    expect(sessions).toEqual([{ execution_state: 'running' }]);
  });

  it('refuses to start a machine on an agent that is not VirtualBox-capable any more', async () => {
    const w = await world();
    await registered(w);
    await sync(w.agent, false);
    const refused = await launch(w);
    expect(refused.statusCode).toBe(409);
    expect(w.agent.received.some((m) => m.type === 'server.virtualbox_control')).toBe(false);
  });
});
