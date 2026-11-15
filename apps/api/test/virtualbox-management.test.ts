/**
 * VirtualBox snapshots, source links, imports, deletions and screenshots (decision 0046) through the real API, on a
 * real database, over a real WebSocket. The agent is a script; nothing here runs VirtualBox, and nothing here
 * imports or deletes a real machine. `agent/tests/virtualbox_management.rs` drives the real agent against a fake
 * VBoxManage.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  captureOperationSchema,
  PROTOCOL_VERSION,
  registrationOperationSchema,
  repositorySummarySchema,
  virtualBoxManagementResponseSchema,
  virtualBoxOperationSchema,
  type RegistrationOperation,
  type RepositorySummary,
  type VirtualBoxManagementResponse,
  type VirtualBoxOperation,
} from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import sharp from 'sharp';
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
  HOST,
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from './browser-app.js';

const SHA = 'c'.repeat(64);
const MACHINE = '2acda0fc-cea6-406b-8a55-746fac380687';
const OTHER_MACHINE = '97910566-2cc6-492b-9dc7-6cc6ee66ffd6';
const IMPORTED_MACHINE = '5b0a7f0e-91c4-4d8e-b0c2-0f5f8d0a1e11';
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

async function sync(agent: TestAgent, management: boolean, virtualboxOperations: object[] = []) {
  agent.send(
    envelope('agent.registration_sync', {
      operations: [],
      virtualbox: true,
      ...(management ? { virtualboxManagement: true, virtualboxOperations } : {}),
    }),
  );
  await barrier(agent);
}

async function world(options: { management?: boolean } = {}): Promise<World> {
  const context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
  worlds.push(context);
  await context.app.listen({ host: '127.0.0.1', port: 0 });
  const admin = await signedInAdmin(context);
  const paired = await pairAgent(context.app, admin);
  const agent = await TestAgent.connect(wsUrl(context.app), paired.credential);
  await agent.hello();
  await sync(agent, options.management ?? true);
  expect((await agent.next('server.virtualbox_watch')).payload.machines).toEqual([]);
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
    return operation.id === request.payload.operationId && operation.status === 'completed'
      ? operation.id
      : undefined;
  }, 'the discovery to finish');
}

function errorCode(response: { json: <T>() => T }): string {
  return response.json<{ error: { code: string } }>().error.code;
}

async function rows(w: World, sql: string, values: unknown[] = []) {
  const [result] = await w.context.pool.query<RowDataPacket[]>(sql, values);
  return result;
}

/** An export the agent reports as published, committed and cleaned up, as the agent does at once. */
async function exported(w: World, operation: RegistrationOperation): Promise<void> {
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
}

/** A committed OVA master of MACHINE, with the agent watching it. */
async function registered(w: World): Promise<RegistrationOperation> {
  const discoveryOperationId = await discover(w);
  const response = await w.admin.request({
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
    },
  });
  expect(response.statusCode, response.body).toBe(202);
  const operation = registrationOperationSchema.parse(response.json());
  await w.agent.next('server.virtualbox_registration_request');
  await exported(w, operation);
  expect((await w.agent.next('server.virtualbox_watch')).payload.machines).toEqual([MACHINE]);
  return operation;
}

function observation(overrides: object = {}) {
  return {
    machineUuid: MACHINE,
    present: true,
    name: 'Xenix 386',
    state: 'powered_off',
    rawState: 'poweroff',
    stateChangedAt: new Date().toISOString(),
    accessible: true,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function observe(w: World, machines: object[]): Promise<void> {
  w.agent.send(envelope('agent.virtualbox_states', { complete: false, available: true, machines }));
  await barrier(w.agent);
}

async function overview(w: World): Promise<VirtualBoxManagementResponse> {
  const response = await w.admin.get(`${VM_PATH}/virtualbox`);
  expect(response.statusCode, response.body).toBe(200);
  return virtualBoxManagementResponseSchema.parse(response.json());
}

function snapshotRequest(w: World, parentVersionId: string, requestId = randomUUID()) {
  return w.admin.request({
    method: 'POST',
    url: `${VM_PATH}/snapshots`,
    payload: { agentId: w.paired.agentId, parentVersionId, requestId },
  });
}

function linkRequest(w: World, payload: object) {
  return w.admin.request({
    method: 'POST',
    url: `${VM_PATH}/virtualbox/link`,
    payload: { agentId: w.paired.agentId, ...payload },
  });
}

function unlinkRequest(w: World, machineUuid: string) {
  return w.admin.request({
    method: 'POST',
    url: `${VM_PATH}/virtualbox/unlink`,
    payload: { machineUuid },
  });
}

function importRequest(w: World, versionId: string, overrides: object = {}) {
  return w.admin.request({
    method: 'POST',
    url: `${VM_PATH}/versions/${versionId}/virtualbox-import`,
    payload: {
      agentId: w.paired.agentId,
      targetName: 'Xenix 386 (copy)',
      requestId: randomUUID(),
      ...overrides,
    },
  });
}

function deleteRequest(w: World, overrides: object = {}) {
  return w.admin.request({
    method: 'POST',
    url: `${VM_PATH}/virtualbox/delete`,
    payload: {
      agentId: w.paired.agentId,
      machineUuid: MACHINE,
      confirmMachineName: 'Xenix 386',
      requestId: randomUUID(),
      ...overrides,
    },
  });
}

async function operation(w: World, id: string): Promise<VirtualBoxOperation> {
  const response = await w.admin.get(`${VM_PATH}/virtualbox/operations/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return virtualBoxOperationSchema.parse(response.json());
}

function result(operationId: string, overrides: object = {}) {
  return {
    operationId,
    kind: 'import',
    outcome: 'succeeded',
    code: null,
    message: null,
    machine: { uuid: IMPORTED_MACHINE, name: 'Xenix 386 (copy)', state: 'powered_off' },
    strayMachines: [],
    filesRemoved: null,
    ...overrides,
  };
}

/** An import of the master that the agent reports as having created IMPORTED_MACHINE. */
async function imported(w: World, masterId: string): Promise<VirtualBoxOperation> {
  const response = await importRequest(w, masterId);
  expect(response.statusCode, response.body).toBe(202);
  const queued = virtualBoxOperationSchema.parse(response.json());
  await w.agent.next('server.virtualbox_import');
  w.agent.send(envelope('agent.virtualbox_operation_result', result(queued.id)));
  await w.agent.next('server.virtualbox_operation_ack');
  return operation(w, queued.id);
}

describe('snapshots of a VirtualBox VM', () => {
  it('exports the linked machine by UUID and commits an immutable OVA snapshot under its parent', async () => {
    const w = await world();
    const master = await registered(w);
    const response = await snapshotRequest(w, master.versionId);
    expect(response.statusCode, response.body).toBe(202);
    const snapshot = registrationOperationSchema.parse(response.json());
    expect(snapshot).toMatchObject({ mode: 'snapshot', virtualboxUuid: MACHINE });
    expect(snapshot.archiveKey).toBe(`archives/virtualbox/${VM_NAME}/${snapshot.versionId}.ova`);

    // The same command as a master: a full export of a powered-off machine, never a VirtualBox snapshot.
    const request = await w.agent.next('server.virtualbox_registration_request');
    expect(request.payload).toEqual({
      operationId: snapshot.id,
      vmName: VM_NAME,
      machineUuid: MACHINE,
      repositoryId: w.repository.id,
      versionId: snapshot.versionId,
      archiveKey: snapshot.archiveKey,
    });
    await exported(w, snapshot);

    const [version] = await rows(w, 'SELECT * FROM vm_versions WHERE id = ?', [snapshot.versionId]);
    expect(version).toMatchObject({
      kind: 'snapshot',
      parent_version_id: master.versionId,
      archive_sha256: SHA,
    });
    const [state] = await rows(
      w,
      "SELECT local_source_version_id, content_status FROM agent_vm_state WHERE emulator_type = 'virtualbox'",
    );
    // The machine is now that snapshot, and nothing verified it against the OVA.
    expect(state).toMatchObject({
      local_source_version_id: snapshot.versionId,
      content_status: 'unverified',
    });
    expect((await overview(w)).sourceVersionId).toBe(snapshot.versionId);

    // Its lineage is known, so a snapshot from another parent is refused.
    expect(errorCode(await snapshotRequest(w, master.versionId))).toBe('snapshot_parent_mismatch');
  });

  it('refuses a machine that is not powered off, gone, unlinked or busy', async () => {
    const w = await world();
    const master = await registered(w);

    await observe(w, [observation({ state: 'saved', rawState: 'saved' })]);
    const saved = await snapshotRequest(w, master.versionId);
    expect(saved.statusCode).toBe(409);
    expect(errorCode(saved)).toBe('vm_not_powered_off');

    await observe(w, [observation({ state: 'running', rawState: 'running' })]);
    expect(errorCode(await snapshotRequest(w, master.versionId))).toBe('vm_running');

    await observe(w, [
      observation({
        present: false,
        name: null,
        state: 'unknown',
        rawState: null,
        accessible: null,
      }),
    ]);
    expect(errorCode(await snapshotRequest(w, master.versionId))).toBe('source_unavailable');

    await observe(w, [observation()]);
    const first = await snapshotRequest(w, master.versionId);
    expect(first.statusCode, first.body).toBe(202);
    expect(errorCode(await snapshotRequest(w, master.versionId))).toBe('operation_in_progress');
  });

  it('refuses an agent that cannot export VirtualBox machines', async () => {
    const w = await world();
    const master = await registered(w);
    w.agent.send(envelope('agent.registration_sync', { operations: [] }));
    await barrier(w.agent);
    expect(errorCode(await snapshotRequest(w, master.versionId))).toBe('agent_cannot_snapshot');
  });
});

describe('linking a VirtualBox VM to a machine', () => {
  it('unlinks and relinks only on request, keeping the VM, its versions and the old machine', async () => {
    const w = await world();
    const master = await registered(w);

    // Nothing is unlinked because the agent went away.
    w.agent.close();
    w.agent = await TestAgent.connect(wsUrl(w.context.app), w.paired.credential);
    await w.agent.hello();
    await sync(w.agent, true);
    expect((await w.agent.next('server.virtualbox_watch')).payload.machines).toEqual([MACHINE]);
    expect((await overview(w)).source?.machineUuid).toBe(MACHINE);

    // A link that changed since the page was loaded is never replaced.
    const discoveryOperationId = await discover(w, [
      machine(),
      machine({ uuid: OTHER_MACHINE, name: 'Xenix 386 rebuilt' }),
    ]);
    const blind = await linkRequest(w, {
      machineUuid: OTHER_MACHINE,
      discoveryOperationId,
      replaceMachineUuid: null,
    });
    expect(errorCode(blind)).toBe('link_changed');
    expect(
      errorCode(
        await linkRequest(w, {
          machineUuid: MACHINE,
          discoveryOperationId,
          replaceMachineUuid: MACHINE,
        }),
      ),
    ).toBe('already_linked');

    const relinked = await linkRequest(w, {
      machineUuid: OTHER_MACHINE,
      discoveryOperationId,
      replaceMachineUuid: MACHINE,
    });
    expect(relinked.statusCode, relinked.body).toBe(200);
    expect(virtualBoxOperationSchema.parse(relinked.json())).toMatchObject({
      kind: 'relink',
      state: 'succeeded',
      machineUuid: OTHER_MACHINE,
      machineName: 'Xenix 386 rebuilt',
      previousMachineUuid: MACHINE,
    });
    expect((await w.agent.next('server.virtualbox_watch')).payload.machines).toEqual([
      OTHER_MACHINE,
    ]);
    const after = await overview(w);
    expect(after.source).toMatchObject({
      machineUuid: OTHER_MACHINE,
      displayName: 'Xenix 386 rebuilt',
    });
    // A machine linked from discovery has no known lineage.
    expect(after.sourceVersionId).toBeNull();
    expect(after.operations.map((op) => op.kind)).toEqual(['relink']);
    expect(await rows(w, 'SELECT id FROM vm_versions')).toHaveLength(1);
    expect((await rows(w, 'SELECT id FROM vm_versions'))[0]?.id).toBe(master.versionId);
    // No command reached the agent for the machine that was linked before.
    expect(
      w.agent.received.some(
        (m) => m.type === 'server.virtualbox_delete' || m.type === 'server.virtualbox_control',
      ),
    ).toBe(false);

    expect(errorCode(await unlinkRequest(w, MACHINE))).toBe('link_changed');
    const unlinked = await unlinkRequest(w, OTHER_MACHINE);
    expect(unlinked.statusCode, unlinked.body).toBe(200);
    expect(virtualBoxOperationSchema.parse(unlinked.json())).toMatchObject({
      kind: 'unlink',
      previousMachineUuid: OTHER_MACHINE,
    });
    expect((await w.agent.next('server.virtualbox_watch')).payload.machines).toEqual([]);
    expect((await overview(w)).source).toBeNull();
    expect(
      await rows(w, "SELECT 1 FROM agent_vm_state WHERE emulator_type = 'virtualbox'"),
    ).toHaveLength(0);
    // The VM stays in the catalog, unlinked: it cannot be launched until it is linked again.
    expect(
      await rows(w, "SELECT 1 FROM virtual_machines WHERE emulator_type = 'virtualbox'"),
    ).toHaveLength(1);
    const launch = await w.admin.request({
      method: 'POST',
      url: '/admin/sessions',
      payload: {
        agentId: w.paired.agentId,
        emulatorType: 'virtualbox',
        vmName: VM_NAME,
        mode: 'local',
        requestId: randomUUID(),
      },
    });
    expect(launch.statusCode).toBe(409);
    expect(launch.body).toMatch(/not linked to a VirtualBox machine/);
  });

  it('refuses a machine that is running, inaccessible, unknown or linked elsewhere, or a stale discovery', async () => {
    const w = await world();
    await registered(w);

    await observe(w, [observation({ state: 'running', rawState: 'running' })]);
    expect(errorCode(await unlinkRequest(w, MACHINE))).toBe('vm_not_powered_off');
    await observe(w, [observation()]);
    expect(await rows(w, 'SELECT id FROM vm_sessions WHERE active_marker = 1')).toHaveLength(0);

    const discoveryOperationId = await discover(w, [
      machine(),
      machine({ uuid: OTHER_MACHINE, state: 'running', rawState: 'running' }),
    ]);
    const running = await linkRequest(w, {
      machineUuid: OTHER_MACHINE,
      discoveryOperationId,
      replaceMachineUuid: MACHINE,
    });
    expect(errorCode(running)).toBe('virtualbox_not_powered_off');
    expect(
      errorCode(
        await linkRequest(w, {
          machineUuid: '00000000-0000-4000-8000-000000000000',
          discoveryOperationId,
          replaceMachineUuid: MACHINE,
        }),
      ),
    ).toBe('virtualbox_machine_not_found');
    expect(
      errorCode(
        await linkRequest(w, {
          machineUuid: OTHER_MACHINE,
          discoveryOperationId: randomUUID(),
          replaceMachineUuid: MACHINE,
        }),
      ),
    ).toBe('discovery_stale');
    const both = await w.admin.request({
      method: 'POST',
      url: `${VM_PATH}/virtualbox/link`,
      payload: {
        agentId: w.paired.agentId,
        machineUuid: OTHER_MACHINE,
        discoveryOperationId,
        importOperationId: randomUUID(),
        replaceMachineUuid: MACHINE,
      },
    });
    expect(both.statusCode).toBe(400);

    const inaccessible = await discover(w, [
      machine(),
      machine({ uuid: OTHER_MACHINE, accessible: false }),
    ]);
    expect(
      errorCode(
        await linkRequest(w, {
          machineUuid: OTHER_MACHINE,
          discoveryOperationId: inaccessible,
          replaceMachineUuid: MACHINE,
        }),
      ),
    ).toBe('virtualbox_machine_inaccessible');

    // The source stayed as it was through every refusal.
    expect((await overview(w)).source?.machineUuid).toBe(MACHINE);
    expect((await overview(w)).operations).toEqual([]);
  });

  it('refuses while a session of the VM is active', async () => {
    const w = await world();
    await registered(w);
    await observe(w, [observation({ state: 'running', rawState: 'running' })]);
    // Seen running, then reported powered off while the session is still on record as stopping.
    await w.context.pool.execute(
      "UPDATE virtualbox_sources SET state = 'powered_off' WHERE machine_uuid = ?",
      [MACHINE],
    );
    expect(errorCode(await unlinkRequest(w, MACHINE))).toBe('vm_running');
  });
});

describe('importing a version into VirtualBox', () => {
  it('sends the archive identity, records the new machine, and links it only when asked', async () => {
    const w = await world();
    const master = await registered(w);
    const requestId = randomUUID();
    const response = await importRequest(w, master.versionId, { requestId });
    expect(response.statusCode, response.body).toBe(202);
    const queued = virtualBoxOperationSchema.parse(response.json());
    expect(queued).toMatchObject({
      kind: 'import',
      state: 'queued',
      targetName: 'Xenix 386 (copy)',
    });

    const command = await w.agent.next('server.virtualbox_import');
    expect(command.payload).toEqual({
      operationId: queued.id,
      vmName: VM_NAME,
      versionId: master.versionId,
      repositoryId: w.repository.id,
      archiveKey: master.archiveKey,
      archiveSizeBytes: 1 << 20,
      archiveSha256: SHA,
      targetName: 'Xenix 386 (copy)',
    });
    // A repeated request is the same operation, and another one waits for it.
    const repeated = await importRequest(w, master.versionId, { requestId });
    expect(virtualBoxOperationSchema.parse(repeated.json()).id).toBe(queued.id);
    expect(errorCode(await importRequest(w, master.versionId))).toBe('operation_in_progress');

    w.agent.send(
      envelope('agent.virtualbox_operation_progress', {
        operationId: queued.id,
        stage: 'downloading',
        doneBytes: 512,
        totalBytes: 1 << 20,
      }),
    );
    await barrier(w.agent);
    expect(await operation(w, queued.id)).toMatchObject({
      state: 'running',
      stage: 'downloading',
      progress: { doneBytes: 512, totalBytes: 1 << 20 },
    });

    w.agent.send(envelope('agent.virtualbox_operation_result', result(queued.id)));
    expect((await w.agent.next('server.virtualbox_operation_ack')).payload.operationId).toBe(
      queued.id,
    );
    expect(await operation(w, queued.id)).toMatchObject({
      state: 'succeeded',
      machineUuid: IMPORTED_MACHINE,
      machineName: 'Xenix 386 (copy)',
    });
    // A repeated report only gets its answer again.
    w.agent.send(envelope('agent.virtualbox_operation_result', result(queued.id)));
    await w.agent.next('server.virtualbox_operation_ack');

    // Never linked by itself.
    expect((await overview(w)).source?.machineUuid).toBe(MACHINE);

    const linked = await linkRequest(w, {
      machineUuid: IMPORTED_MACHINE,
      importOperationId: queued.id,
      replaceMachineUuid: MACHINE,
    });
    expect(linked.statusCode, linked.body).toBe(200);
    expect((await w.agent.next('server.virtualbox_watch')).payload.machines).toEqual([
      IMPORTED_MACHINE,
    ]);
    const after = await overview(w);
    expect(after.source).toMatchObject({
      machineUuid: IMPORTED_MACHINE,
      displayName: 'Xenix 386 (copy)',
    });
    // Imported from the master, so that is what the machine is.
    expect(after.sourceVersionId).toBe(master.versionId);
  });

  it('records an uncertain import and the machines it cannot attribute, and never links them', async () => {
    const w = await world();
    const master = await registered(w);
    const queued = virtualBoxOperationSchema.parse(
      (await importRequest(w, master.versionId)).json(),
    );
    await w.agent.next('server.virtualbox_import');
    w.agent.send(
      envelope(
        'agent.virtualbox_operation_result',
        result(queued.id, {
          outcome: 'uncertain',
          code: 'import_ambiguous',
          message: 'Two machines appeared during the import.',
          machine: null,
          strayMachines: [
            { uuid: IMPORTED_MACHINE, name: 'Xenix 386 (copy)', state: 'powered_off' },
            { uuid: OTHER_MACHINE, name: 'Something else', state: 'powered_off' },
          ],
        }),
      ),
    );
    await w.agent.next('server.virtualbox_operation_ack');
    const recorded = await operation(w, queued.id);
    expect(recorded).toMatchObject({
      state: 'uncertain',
      machineUuid: null,
      error: { code: 'import_ambiguous' },
    });
    expect(recorded.strayMachines.map((m) => m.uuid)).toEqual([IMPORTED_MACHINE, OTHER_MACHINE]);
    // Neither can be linked from it, nor deleted.
    expect(
      errorCode(
        await linkRequest(w, {
          machineUuid: IMPORTED_MACHINE,
          importOperationId: queued.id,
          replaceMachineUuid: MACHINE,
        }),
      ),
    ).toBe('import_not_found');
    expect(
      errorCode(
        await deleteRequest(w, {
          machineUuid: IMPORTED_MACHINE,
          confirmMachineName: 'Xenix 386 (copy)',
        }),
      ),
    ).toBe('machine_not_associated');
  });

  it('redelivers a queued import, and never retries one the agent lost after starting', async () => {
    const w = await world();
    const master = await registered(w);
    const queued = virtualBoxOperationSchema.parse(
      (await importRequest(w, master.versionId)).json(),
    );
    await w.agent.next('server.virtualbox_import');

    // The agent reconnects without a journal for it: it never received it, so it goes out again.
    await sync(w.agent, true, []);
    expect((await w.agent.next('server.virtualbox_import')).payload.operationId).toBe(queued.id);

    w.agent.send(
      envelope('agent.virtualbox_operation_progress', {
        operationId: queued.id,
        stage: 'importing',
        doneBytes: null,
        totalBytes: null,
      }),
    );
    await barrier(w.agent);
    // Listed as irreversible: left alone until it reports.
    await sync(w.agent, true, [{ operationId: queued.id, phase: 'irreversible' }]);
    expect((await operation(w, queued.id)).state).toBe('running');

    // Lost after it started: uncertain, and nothing is sent again.
    await sync(w.agent, true, []);
    expect(await operation(w, queued.id)).toMatchObject({
      state: 'uncertain',
      error: { code: 'agent_lost_operation' },
    });
    expect(w.agent.received.some((m) => m.type === 'server.virtualbox_import')).toBe(false);
  });

  it('refuses an agent that cannot import, a bad name and a version of another VM', async () => {
    const w = await world({ management: false });
    const master = await registered(w);
    expect(errorCode(await importRequest(w, master.versionId))).toBe(
      'agent_cannot_manage_virtualbox',
    );
    await sync(w.agent, true);
    for (const targetName of ['', 'a/b', 'C:', ' padded', 'dot.', '-option']) {
      expect((await importRequest(w, master.versionId, { targetName })).statusCode).toBe(400);
    }
    expect(errorCode(await importRequest(w, randomUUID()))).toBe('version_not_found');
    expect(await rows(w, 'SELECT 1 FROM virtualbox_operations')).toHaveLength(0);
  });

  it('closes what was queued for an agent that comes back unable to import', async () => {
    const w = await world();
    const master = await registered(w);
    const queued = virtualBoxOperationSchema.parse(
      (await importRequest(w, master.versionId)).json(),
    );
    await sync(w.agent, false);
    expect(await operation(w, queued.id)).toMatchObject({
      state: 'failed',
      error: { code: 'management_unavailable' },
    });
  });
});

describe('deleting a machine from VirtualBox', () => {
  it('deletes the linked machine by UUID once its name is typed, then unlinks it and keeps the VM', async () => {
    const w = await world();
    const master = await registered(w);

    expect(errorCode(await deleteRequest(w, { confirmMachineName: 'xenix 386' }))).toBe(
      'confirmation_mismatch',
    );
    await observe(w, [observation({ state: 'saved', rawState: 'saved' })]);
    expect(errorCode(await deleteRequest(w))).toBe('vm_not_powered_off');
    await observe(w, [observation()]);
    expect(
      errorCode(
        await deleteRequest(w, { machineUuid: OTHER_MACHINE, confirmMachineName: 'Other' }),
      ),
    ).toBe('machine_not_associated');
    expect(w.agent.received.some((m) => m.type === 'server.virtualbox_delete')).toBe(false);

    const response = await deleteRequest(w);
    expect(response.statusCode, response.body).toBe(202);
    const queued = virtualBoxOperationSchema.parse(response.json());
    const command = await w.agent.next('server.virtualbox_delete');
    expect(command.payload).toEqual({
      operationId: queued.id,
      machineUuid: MACHINE,
      machineName: 'Xenix 386',
    });

    w.agent.send(
      envelope(
        'agent.virtualbox_operation_result',
        result(queued.id, { kind: 'delete', machine: null, filesRemoved: true }),
      ),
    );
    await w.agent.next('server.virtualbox_operation_ack');
    expect(await operation(w, queued.id)).toMatchObject({ state: 'succeeded', filesRemoved: true });
    expect((await w.agent.next('server.virtualbox_watch')).payload.machines).toEqual([]);
    const after = await overview(w);
    expect(after.source).toBeNull();
    // Newest first: the unlink was made when the deletion was confirmed.
    expect(after.operations.map((op) => op.kind)).toEqual(['unlink', 'delete']);
    // The catalog entry and its master stay.
    expect((await rows(w, 'SELECT id FROM vm_versions'))[0]?.id).toBe(master.versionId);
    expect(
      await rows(w, "SELECT 1 FROM virtual_machines WHERE emulator_type = 'virtualbox'"),
    ).toHaveLength(1);
  });

  it('keeps the link when a deletion fails or is uncertain', async () => {
    const w = await world();
    await registered(w);
    for (const outcome of ['failed', 'uncertain'] as const) {
      const queued = virtualBoxOperationSchema.parse((await deleteRequest(w)).json());
      await w.agent.next('server.virtualbox_delete');
      w.agent.send(
        envelope(
          'agent.virtualbox_operation_result',
          result(queued.id, {
            kind: 'delete',
            outcome,
            code: outcome === 'failed' ? 'machine_running' : 'delete_unconfirmed',
            message: 'Not deleted.',
            machine: null,
          }),
        ),
      );
      await w.agent.next('server.virtualbox_operation_ack');
      expect((await operation(w, queued.id)).state).toBe(outcome);
      expect((await overview(w)).source?.machineUuid).toBe(MACHINE);
    }
  });

  it('deletes an unlinked machine an import of this VM created, and nothing else', async () => {
    const w = await world();
    const master = await registered(w);
    await imported(w, master.versionId);
    const response = await deleteRequest(w, {
      machineUuid: IMPORTED_MACHINE,
      confirmMachineName: 'Xenix 386 (copy)',
    });
    expect(response.statusCode, response.body).toBe(202);
    const queued = virtualBoxOperationSchema.parse(response.json());
    expect((await w.agent.next('server.virtualbox_delete')).payload.machineUuid).toBe(
      IMPORTED_MACHINE,
    );
    w.agent.send(
      envelope(
        'agent.virtualbox_operation_result',
        result(queued.id, { kind: 'delete', machine: null, filesRemoved: true }),
      ),
    );
    await w.agent.next('server.virtualbox_operation_ack');
    // The linked machine was not touched, and the deleted one cannot be deleted twice.
    expect((await overview(w)).source?.machineUuid).toBe(MACHINE);
    expect(
      errorCode(
        await deleteRequest(w, {
          machineUuid: IMPORTED_MACHINE,
          confirmMachineName: 'Xenix 386 (copy)',
        }),
      ),
    ).toBe('machine_already_deleted');
  });

  it('refuses an agent that cannot delete', async () => {
    const w = await world({ management: false });
    await registered(w);
    expect(errorCode(await deleteRequest(w))).toBe('agent_cannot_manage_virtualbox');
  });
});

describe('screenshots of a VirtualBox VM', () => {
  it('captures the linked machine and files the PNG under the catalog VM', async () => {
    const w = await world();
    await registered(w);
    await observe(w, [observation({ state: 'running', rawState: 'running' })]);
    const [session] = await rows(w, 'SELECT id FROM vm_sessions WHERE active_marker = 1');
    const path = `/admin/sessions/${session?.id as string}/screenshots`;
    const status = await w.admin.get(path);
    expect(status.json()).toMatchObject({ available: true, reason: null });

    const created = await w.admin.request({
      method: 'POST',
      url: path,
      payload: { requestId: randomUUID() },
    });
    expect(created.statusCode, created.body).toBe(202);
    const capture = captureOperationSchema.parse(created.json());
    expect(capture.emulatorType).toBe('virtualbox');
    const command = await w.agent.next('server.virtualbox_capture');
    expect(command.payload).toEqual({
      operationId: capture.id,
      sessionId: capture.sessionId,
      vmName: VM_NAME,
      machineUuid: MACHINE,
    });

    const png = await sharp({
      create: { width: 8, height: 6, channels: 3, background: '#00aa00' },
    })
      .png()
      .toBuffer();
    const sha256 = createHash('sha256').update(png).digest('hex');
    const upload = (label: string) =>
      w.context.app.inject({
        method: 'PUT',
        url: `/api/v1/agent/media/vms/virtualbox/${VM_NAME}/screenshots/${sha256}`,
        headers: {
          host: HOST,
          authorization: `Bearer ${w.paired.credential}`,
          'x-emucat-protocol-version': String(PROTOCOL_VERSION),
          'x-emucat-source-path': label,
          'x-emucat-capture-id': capture.id,
          'content-type': 'application/octet-stream',
        },
        payload: png,
      });
    expect((await upload(`emucat-capture-${capture.id}.ppm`)).statusCode).toBe(400);
    const stored = await upload(`emucat-capture-${capture.id}.png`);
    expect(stored.statusCode, stored.body).toBeLessThan(300);

    const report = {
      operationId: capture.id,
      sessionId: capture.sessionId,
      vmName: VM_NAME,
      machineUuid: MACHINE,
      state: 'uploading',
      sha256,
      uncertain: false,
      code: null,
      message: null,
    };
    // A report naming another machine belongs to no capture.
    w.agent.send(envelope('agent.virtualbox_capture', { ...report, machineUuid: OTHER_MACHINE }));
    await barrier(w.agent);
    expect(w.agent.received.some((m) => m.type === 'server.qemu_capture_ack')).toBe(false);

    w.agent.send(envelope('agent.virtualbox_capture', report));
    const ack = await w.agent.next('server.qemu_capture_ack');
    expect(ack.payload).toMatchObject({ operationId: capture.id, sha256 });
    const [media] = await rows(w, 'SELECT emulator_type, vm_name FROM vm_media WHERE id = ?', [
      ack.payload.mediaId,
    ]);
    expect(media).toMatchObject({ emulator_type: 'virtualbox', vm_name: VM_NAME });

    // The screenshot stays with the VM when its machine is unlinked.
    await observe(w, [observation()]);
    expect((await unlinkRequest(w, MACHINE)).statusCode).toBe(200);
    expect(await rows(w, 'SELECT 1 FROM vm_media WHERE vm_name = ?', [VM_NAME])).toHaveLength(1);
  });

  it('is unavailable for an agent that cannot capture VirtualBox machines', async () => {
    const w = await world({ management: false });
    await registered(w);
    await observe(w, [observation({ state: 'running', rawState: 'running' })]);
    const [session] = await rows(w, 'SELECT id FROM vm_sessions WHERE active_marker = 1');
    const status = await w.admin.get(`/admin/sessions/${session?.id as string}/screenshots`);
    expect(status.json()).toMatchObject({
      available: false,
      reason: 'Update the agent to enable VirtualBox screenshot capture.',
    });
  });
});
