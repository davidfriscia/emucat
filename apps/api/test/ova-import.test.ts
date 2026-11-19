/**
 * Importing an OVA from the agent's command line (decision 0049), through the real API on a real database. The
 * agent is a script calling the HTTP routes with its real credential, as `emucat-agent import-ova` does; the real
 * command line, against a real SFTP server, is in `e2e/registration.e2e.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import {
  adminVmDetailSchema,
  completeOvaImportResponseSchema,
  executionOptionsResponseSchema,
  ovaImportPreflightResponseSchema,
  PROTOCOL_VERSION,
  registrationOperationSchema,
  repositorySummarySchema,
  versionTreeResponseSchema,
  virtualBoxManagementResponseSchema,
  type CompleteOvaImportResponse,
  type RegistrationOperation,
  type RepositorySummary,
} from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GENEROUS_RATE_LIMITS,
  TestAgent,
  envelope,
  pairAgent,
  wsUrl,
  type PairedAgent,
} from './agent-helpers.js';
import {
  insertVm,
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from './browser-app.js';

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const SIZE = 3 * 1024 * 1024;
const VM_NAME = 'DOS-6.22';
const BASE = '/api/v1/agent/ova-imports';

interface World {
  context: BrowserTestContext;
  admin: TestClient;
  paired: PairedAgent;
  repository: RepositorySummary;
}

let worlds: BrowserTestContext[] = [];

afterEach(async () => {
  for (const context of worlds) await context.close();
  worlds = [];
});

async function associate(admin: TestClient, repositoryId: string, agentId: string) {
  const associated = await admin.request({
    method: 'PUT',
    url: `/admin/repositories/${repositoryId}/agents/${agentId}`,
  });
  expect(associated.statusCode, associated.body).toBe(200);
}

async function world(options: { associate?: boolean } = {}): Promise<World> {
  const context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
  worlds.push(context);
  const admin = await signedInAdmin(context);
  const paired = await pairAgent(context.app, admin);
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
  if (options.associate ?? true) await associate(admin, repository.id, paired.agentId);
  return { context, admin, paired, repository };
}

/** As the agent's command line calls the API: its bearer credential and protocol, and JSON. */
function call(
  w: World,
  method: 'GET' | 'POST',
  path: string,
  payload?: object,
  credential = w.paired.credential,
) {
  return w.context.app.inject({
    method,
    url: `${BASE}${path}`,
    headers: {
      authorization: `Bearer ${credential}`,
      'x-emucat-protocol-version': String(PROTOCOL_VERSION),
    },
    ...(payload ? { payload } : {}),
  });
}

function createRequest(overrides: object = {}) {
  return {
    requestId: randomUUID(),
    vmName: VM_NAME,
    sourceFileName: 'DOS 6.22 — Ελληνικά.ova',
    archiveSizeBytes: SIZE,
    archiveSha256: SHA,
    ...overrides,
  };
}

async function create(w: World, overrides: object = {}, credential?: string) {
  const response = await call(w, 'POST', '', createRequest(overrides), credential);
  expect(response.statusCode, response.body).toBe(201);
  return registrationOperationSchema.parse(response.json());
}

async function progress(w: World, id: string, stage: 'uploading' | 'verifying') {
  return call(w, 'POST', `/${id}/progress`, { stage, doneBytes: 0, totalBytes: SIZE });
}

async function complete(
  w: World,
  operation: RegistrationOperation,
  overrides: object = {},
): Promise<CompleteOvaImportResponse> {
  const response = await call(w, 'POST', `/${operation.id}/complete`, {
    versionId: operation.versionId,
    archiveKey: operation.archiveKey,
    archiveSizeBytes: SIZE,
    archiveSha256: SHA,
    ...overrides,
  });
  expect(response.statusCode, response.body).toBe(200);
  return completeOvaImportResponseSchema.parse(response.json());
}

/** Everything the agent does for a successful import: reserve, upload, verify, complete. */
async function imported(w: World, overrides: object = {}) {
  const operation = await create(w, overrides);
  expect((await progress(w, operation.id, 'uploading')).statusCode).toBe(200);
  expect((await progress(w, operation.id, 'verifying')).statusCode).toBe(200);
  const done = await complete(w, operation);
  expect(done.outcome).toBe('committed');
  return done.operation;
}

const errorCode = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;

async function rows(w: World, sql: string, values: unknown[] = []) {
  const [result] = await w.context.pool.execute<RowDataPacket[]>(sql, values as string[]);
  return result;
}

describe('a successful import', () => {
  it('creates one VirtualBox VM with one master, and links no machine', async () => {
    const w = await world();
    const preflight = await call(w, 'POST', '/preflight', {
      vmName: VM_NAME,
      archiveSizeBytes: SIZE,
    });
    expect(preflight.statusCode, preflight.body).toBe(200);
    expect(ovaImportPreflightResponseSchema.parse(preflight.json())).toMatchObject({
      emulatorType: 'virtualbox',
      vmName: VM_NAME,
      repositoryId: w.repository.id,
      repositoryName: 'NAS',
    });
    // A preflight reserves nothing.
    expect(await rows(w, 'SELECT id FROM registration_operations')).toHaveLength(0);

    const operation = await create(w, { description: 'MS-DOS 6.22, as installed in 1994' });
    expect(operation).toMatchObject({
      mode: 'import',
      state: 'queued',
      emulatorType: 'virtualbox',
      vmName: VM_NAME,
      virtualboxUuid: null,
      repositoryId: w.repository.id,
      archiveKey: `archives/virtualbox/dos-6.22/${operation.versionId}.ova`,
      archive: null,
    });

    // Another import of the same name cannot start while the first one runs.
    const second = await call(w, 'POST', '', createRequest());
    expect(second.statusCode).toBe(409);
    expect(await rows(w, 'SELECT id FROM registration_operations')).toHaveLength(1);

    const uploading = await progress(w, operation.id, 'uploading');
    expect(registrationOperationSchema.parse(uploading.json()).state).toBe('uploading');
    const verifying = await progress(w, operation.id, 'verifying');
    expect(registrationOperationSchema.parse(verifying.json()).state).toBe('verifying');
    const completed = await complete(w, operation);
    expect(completed.outcome).toBe('committed');
    expect(completed.deletePublished).toBe(false);
    expect(completed.operation).toMatchObject({
      state: 'succeeded',
      localCopy: 'preserved',
      archive: { format: 'ova', sizeBytes: SIZE, sha256: SHA, manifestSha256: null },
    });

    // The catalog: one VM, its description, one master and nothing else.
    const detail = await w.admin.get(`/admin/vms/virtualbox/${VM_NAME}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(adminVmDetailSchema.parse(detail.json())).toMatchObject({
      emulatorType: 'virtualbox',
      vmName: VM_NAME,
      description: 'MS-DOS 6.22, as installed in 1994',
      versionCount: 1,
    });
    const listing = await w.admin.get('/admin/vms');
    expect(listing.statusCode).toBe(200);
    expect(JSON.stringify(listing.json())).toContain(VM_NAME);
    const tree = versionTreeResponseSchema.parse(
      (await w.admin.get(`/admin/vms/virtualbox/${VM_NAME}/versions`)).json(),
    );
    expect(tree.versions).toHaveLength(1);
    expect(tree.versions[0]).toMatchObject({
      id: operation.versionId,
      kind: 'master',
      parentVersionId: null,
      archiveSha256: SHA,
      archiveSizeBytes: SIZE,
    });

    // No machine, no agent copy, nothing to run.
    expect(await rows(w, 'SELECT * FROM virtualbox_sources')).toHaveLength(0);
    expect(await rows(w, 'SELECT * FROM agent_vm_state')).toHaveLength(0);
    const machine = virtualBoxManagementResponseSchema.parse(
      (await w.admin.get(`/admin/vms/virtualbox/${VM_NAME}/virtualbox`)).json(),
    );
    expect(machine.source).toBeNull();
    expect(machine.sourceVersionId).toBeNull();
    const execution = executionOptionsResponseSchema.parse(
      (await w.admin.get(`/admin/vms/virtualbox/${VM_NAME}/execution-options`)).json(),
    );
    expect(execution.virtualbox).toBeNull();
    expect(execution.agents.every((agent) => !agent.launch.eligible)).toBe(true);

    // The registration history shows it, by the agent and by nobody.
    const history = registrationOperationSchema.parse(
      (await w.admin.get(`/admin/registrations/${operation.id}`)).json(),
    );
    expect(history).toMatchObject({ mode: 'import', requestedByDisplayName: null });
    const [vm] = await rows(
      w,
      "SELECT registered_by_user_id, discovered_by_agent_id FROM virtual_machines WHERE emulator_type = 'virtualbox'",
    );
    expect(vm).toMatchObject({
      registered_by_user_id: null,
      discovered_by_agent_id: w.paired.agentId,
    });
  });

  it('is not runnable until a machine is linked, even on an online VirtualBox agent', async () => {
    const w = await world();
    await w.context.app.listen({ host: '127.0.0.1', port: 0 });
    const agent = await TestAgent.connect(wsUrl(w.context.app), w.paired.credential);
    await agent.hello();
    agent.send(envelope('agent.registration_sync', { operations: [], virtualbox: true }));
    await agent.next('server.virtualbox_watch');
    await imported(w);
    const execution = executionOptionsResponseSchema.parse(
      (await w.admin.get(`/admin/vms/virtualbox/${VM_NAME}/execution-options`)).json(),
    );
    const option = execution.agents.find((item) => item.agentId === w.paired.agentId);
    expect(option?.launch).toMatchObject({ eligible: false, reason: 'vm_not_on_agent' });
    expect(option?.launch.problem).toContain('not linked to a VirtualBox machine');
    // An import changes nothing the running agent watches: no new watch list is sent.
    expect(agent.received.filter((message) => message.type === 'server.virtualbox_watch')).toEqual(
      [],
    );
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
    agent.close();
  });

  it('answers a repeated completion with the same commit, and never a second master', async () => {
    const w = await world();
    const operation = await create(w);
    await progress(w, operation.id, 'uploading');
    const first = await complete(w, operation);
    const second = await complete(w, operation);
    expect(first.outcome).toBe('committed');
    expect(second.outcome).toBe('committed');
    expect(await rows(w, 'SELECT id FROM vm_versions')).toHaveLength(1);
    expect(await rows(w, 'SELECT vm_name FROM virtual_machines')).toHaveLength(1);
  });

  it('finds the operation it already created when the same request is repeated', async () => {
    const w = await world();
    const request = createRequest();
    const first = await call(w, 'POST', '', request);
    const again = await call(w, 'POST', '', request);
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(await rows(w, 'SELECT id FROM registration_operations')).toHaveLength(1);

    const changed = await call(w, 'POST', '', { ...request, archiveSha256: OTHER_SHA });
    expect(changed.statusCode).toBe(409);
    expect(errorCode(changed)).toBe('request_conflict');
  });

  it('is not disturbed by the agent connection, which never lists it', async () => {
    const w = await world();
    await w.context.app.listen({ host: '127.0.0.1', port: 0 });
    const agent = await TestAgent.connect(wsUrl(w.context.app), w.paired.credential);
    await agent.hello();
    const operation = await create(w);
    await progress(w, operation.id, 'uploading');
    // The running agent says hello with its own journals, which never include the command line's import.
    agent.send(envelope('agent.registration_sync', { operations: [], virtualbox: true }));
    agent.send(envelope('agent.heartbeat', {}));
    await agent.next('server.heartbeat_ack');
    const read = registrationOperationSchema.parse(
      (await call(w, 'GET', `/${operation.id}`)).json(),
    );
    expect(read.state).toBe('uploading');
    expect(agent.received.some((message) => message.type.includes('registration_request'))).toBe(
      false,
    );
    expect((await complete(w, operation)).outcome).toBe('committed');
    agent.close();
  });
});

describe('authentication and authorization', () => {
  it('refuses anyone without a valid agent credential, before anything else', async () => {
    const w = await world();
    const anonymous = await w.context.app.inject({
      method: 'POST',
      url: `${BASE}/preflight`,
      headers: { 'x-emucat-protocol-version': String(PROTOCOL_VERSION) },
      payload: { vmName: VM_NAME },
    });
    expect(anonymous.statusCode).toBe(401);
    const forged = await call(w, 'POST', '/preflight', { vmName: VM_NAME }, 'x'.repeat(40));
    expect(forged.statusCode).toBe(401);
    const noProtocol = await w.context.app.inject({
      method: 'POST',
      url: `${BASE}/preflight`,
      headers: { authorization: `Bearer ${w.paired.credential}` },
      payload: { vmName: VM_NAME },
    });
    expect(noProtocol.statusCode).toBe(400);
    expect(errorCode(noProtocol)).toBe('unsupported_protocol_version');
    // A browser session means nothing here.
    const browser = await w.admin.request({ method: 'POST', url: '/agent/ova-imports/preflight' });
    expect(browser.statusCode).toBe(401);
  });

  it('refuses a revoked agent, and fails what it was importing', async () => {
    const w = await world();
    const operation = await create(w);
    const revoked = await w.admin.request({
      method: 'POST',
      url: `/admin/agents/${w.paired.agentId}/revoke`,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const after = await call(w, 'POST', `/${operation.id}/complete`, {
      versionId: operation.versionId,
      archiveKey: operation.archiveKey,
      archiveSizeBytes: SIZE,
      archiveSha256: SHA,
    });
    expect(after.statusCode).toBe(401);
    expect(await rows(w, 'SELECT * FROM virtual_machines')).toHaveLength(0);
  });

  it('refuses an agent with no enabled repository: holding a repository key authorizes nothing', async () => {
    const w = await world({ associate: false });
    const preflight = await call(w, 'POST', '/preflight', { vmName: VM_NAME });
    expect(preflight.statusCode).toBe(409);
    expect(errorCode(preflight)).toBe('repository_not_authorized');
    const created = await call(w, 'POST', '', createRequest());
    expect(created.statusCode).toBe(409);
    expect(await rows(w, 'SELECT id FROM registration_operations')).toHaveLength(0);
  });

  it('refuses a commit once the repository association is removed', async () => {
    const w = await world();
    const operation = await create(w);
    await w.context.pool.execute('DELETE FROM agent_repositories WHERE agent_id = ?', [
      w.paired.agentId,
    ]);
    const done = await complete(w, operation);
    expect(done.outcome).toBe('rejected');
    expect(done.deletePublished).toBe(true);
    expect(done.operation.error?.code).toBe('repository_not_authorized');
    expect(await rows(w, 'SELECT * FROM virtual_machines')).toHaveLength(0);
  });

  it('shows another agent nothing of an import, and lets it change nothing', async () => {
    const w = await world();
    const other = await pairAgent(w.context.app, w.admin);
    await associate(w.admin, w.repository.id, other.agentId);
    const operation = await create(w);
    for (const [method, path, payload] of [
      ['GET', `/${operation.id}`, undefined],
      ['POST', `/${operation.id}/progress`, { stage: 'uploading', doneBytes: 0, totalBytes: 1 }],
      ['POST', `/${operation.id}/fail`, { code: 'cancelled', message: '' }],
      [
        'POST',
        `/${operation.id}/complete`,
        {
          versionId: operation.versionId,
          archiveKey: operation.archiveKey,
          archiveSizeBytes: SIZE,
          archiveSha256: SHA,
        },
      ],
    ] as const) {
      const response = await call(w, method, path, payload, other.credential);
      expect(response.statusCode, `${method} ${path}`).toBe(404);
    }
    const read = registrationOperationSchema.parse(
      (await call(w, 'GET', `/${operation.id}`)).json(),
    );
    expect(read.state).toBe('queued');
  });

  it('does not let an agent read or complete an ordinary registration through these routes', async () => {
    const w = await world();
    const id = randomUUID();
    const versionId = randomUUID();
    // An administrator's registration of this very agent: not an import, so not the command line's.
    await w.context.pool.execute(
      `INSERT INTO registration_operations
         (id, agent_id, repository_id, emulator_type, vm_name, mode, version_id, archive_key)
       VALUES (?, ?, ?, 'qemu', 'Win98', 'copy', ?, ?)`,
      [id, w.paired.agentId, w.repository.id, versionId, `archives/qemu/win98/${versionId}.zip`],
    );
    expect((await call(w, 'GET', `/${id}`)).statusCode).toBe(404);
    const completed = await call(w, 'POST', `/${id}/complete`, {
      versionId,
      archiveKey: `archives/qemu/win98/${versionId}.zip`,
      archiveSizeBytes: SIZE,
      archiveSha256: SHA,
    });
    expect(completed.statusCode).toBe(404);
    expect((await call(w, 'GET', `/${randomUUID()}`)).statusCode).toBe(404);
    expect(await rows(w, 'SELECT * FROM virtual_machines')).toHaveLength(0);
  });
});

describe('the catalog name', () => {
  it('refuses a name a VirtualBox VM already has, whatever its case, and changes nothing', async () => {
    const w = await world();
    await insertVm(w.context.pool, { emulatorType: 'virtualbox', vmName: 'dos-6.22' });
    for (const path of ['/preflight', '']) {
      const response = await call(w, 'POST', path, path ? { vmName: VM_NAME } : createRequest());
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('vm_already_registered');
    }
    expect(await rows(w, 'SELECT id FROM registration_operations')).toHaveLength(0);
    expect(await rows(w, 'SELECT id FROM vm_versions')).toHaveLength(0);
  });

  it('is only taken among VirtualBox VMs: a QEMU VM of the same name is another VM', async () => {
    const w = await world();
    await insertVm(w.context.pool, { emulatorType: 'qemu', vmName: VM_NAME });
    const operation = await imported(w);
    expect(operation.state).toBe('succeeded');
  });

  it('refuses a name that is not a valid catalog name', async () => {
    const w = await world();
    for (const vmName of ['', '../etc', 'a/b', 'C:\\VMs', '-leading', 'x'.repeat(65)]) {
      const response = await call(w, 'POST', '/preflight', { vmName });
      expect(response.statusCode, vmName).toBe(400);
    }
  });

  it('refuses a commit if the VM appeared in the meantime, and says the archive is unreferenced', async () => {
    const w = await world();
    const operation = await create(w);
    await progress(w, operation.id, 'uploading');
    await insertVm(w.context.pool, { emulatorType: 'virtualbox', vmName: VM_NAME });
    const done = await complete(w, operation);
    expect(done).toMatchObject({ outcome: 'rejected', deletePublished: true });
    expect(done.operation).toMatchObject({
      state: 'failed',
      error: { code: 'duplicate_registration' },
    });
    expect(await rows(w, 'SELECT id FROM vm_versions')).toHaveLength(0);
  });

  it('lets one of two concurrent imports of one name start, on two agents', async () => {
    const w = await world();
    const other = await pairAgent(w.context.app, w.admin);
    await associate(w.admin, w.repository.id, other.agentId);
    const [a, b] = await Promise.all([
      call(w, 'POST', '', createRequest()),
      call(w, 'POST', '', createRequest(), other.credential),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const refused = a.statusCode === 409 ? a : b;
    expect(errorCode(refused)).toBe('registration_in_progress');
    expect(await rows(w, 'SELECT id FROM registration_operations')).toHaveLength(1);
  });

  it('runs one operation at a time per agent', async () => {
    const w = await world();
    await create(w);
    const second = await call(w, 'POST', '', createRequest({ vmName: 'Win95' }));
    expect(second.statusCode).toBe(409);
    expect(errorCode(second)).toBe('agent_busy');
  });
});

describe('states', () => {
  it('moves only forward, apart from uploading again after a verification', async () => {
    const w = await world();
    const operation = await create(w);
    const early = await progress(w, operation.id, 'verifying');
    expect(early.statusCode).toBe(409);
    expect(errorCode(early)).toBe('invalid_import_state');
    expect((await progress(w, operation.id, 'uploading')).statusCode).toBe(200);
    expect((await progress(w, operation.id, 'verifying')).statusCode).toBe(200);
    expect((await progress(w, operation.id, 'uploading')).statusCode).toBe(200);
    expect((await progress(w, operation.id, 'verifying')).statusCode).toBe(200);
    await complete(w, operation);
    // Once it ended, a report changes nothing, and says how it ended.
    const late = await progress(w, operation.id, 'uploading');
    expect(late.statusCode).toBe(200);
    expect(registrationOperationSchema.parse(late.json()).state).toBe('succeeded');
  });

  it('refuses another archive than the one declared, and registers nothing', async () => {
    const w = await world();
    const operation = await create(w);
    await progress(w, operation.id, 'uploading');
    const wrongHash = await complete(w, operation, { archiveSha256: OTHER_SHA });
    expect(wrongHash).toMatchObject({ outcome: 'rejected', deletePublished: true });
    expect(wrongHash.operation).toMatchObject({
      state: 'failed',
      error: { code: 'hash_mismatch' },
    });
    expect(await rows(w, 'SELECT * FROM virtual_machines')).toHaveLength(0);
  });

  it('refuses a size other than the one declared', async () => {
    const w = await world();
    const operation = await create(w);
    const wrongSize = await complete(w, operation, { archiveSizeBytes: SIZE + 1 });
    expect(wrongSize.operation.error?.code).toBe('hash_mismatch');
  });

  it('refuses identities it did not issue, and deletes nothing on their word', async () => {
    const w = await world();
    const operation = await create(w);
    const wrongKey = await complete(w, operation, {
      archiveKey: `archives/virtualbox/other/${operation.versionId}.ova`,
    });
    expect(wrongKey).toMatchObject({ outcome: 'rejected', deletePublished: false });
    expect(wrongKey.operation.error?.code).toBe('invalid_result');
  });

  it('records an upload failure, after which the same name can be imported again', async () => {
    const w = await world();
    const operation = await create(w);
    await progress(w, operation.id, 'uploading');
    const failed = await call(w, 'POST', `/${operation.id}/fail`, {
      code: 'upload_interrupted',
      message: 'The connection to the repository dropped',
    });
    expect(registrationOperationSchema.parse(failed.json())).toMatchObject({
      state: 'failed',
      error: { code: 'upload_interrupted' },
    });
    expect(await rows(w, 'SELECT * FROM virtual_machines')).toHaveLength(0);
    // A retry is a new operation, with a new version: the failed one owns nothing.
    const retried = await imported(w);
    expect(retried.versionId).not.toBe(operation.versionId);
  });

  it('records a cancellation from the command line, and rejects a later completion', async () => {
    const w = await world();
    const operation = await create(w);
    await progress(w, operation.id, 'uploading');
    const cancelled = await call(w, 'POST', `/${operation.id}/fail`, {
      code: 'cancelled',
      message: 'Ctrl+C',
    });
    expect(registrationOperationSchema.parse(cancelled.json()).state).toBe('cancelled');
    const late = await complete(w, operation);
    expect(late).toMatchObject({ outcome: 'rejected', deletePublished: true });
    expect(await rows(w, 'SELECT * FROM vm_versions')).toHaveLength(0);
  });

  it('cannot be cancelled once committed: the answer says it was committed', async () => {
    const w = await world();
    const operation = await imported(w);
    const cancel = await call(w, 'POST', `/${operation.id}/fail`, {
      code: 'cancelled',
      message: '',
    });
    expect(registrationOperationSchema.parse(cancel.json()).state).toBe('succeeded');
    const admin = await w.admin.request({
      method: 'POST',
      url: `/admin/registrations/${operation.id}/cancel`,
    });
    expect(admin.statusCode).toBe(409);
  });

  it('is cancelled by an administrator at once, which the agent learns at its next report', async () => {
    const w = await world();
    const operation = await create(w);
    await progress(w, operation.id, 'uploading');
    const cancelled = await w.admin.request({
      method: 'POST',
      url: `/admin/registrations/${operation.id}/cancel`,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(registrationOperationSchema.parse(cancelled.json()).state).toBe('cancelled');
    const report = await progress(w, operation.id, 'verifying');
    expect(registrationOperationSchema.parse(report.json())).toMatchObject({
      state: 'cancelled',
      cancelRequested: true,
    });
    const late = await complete(w, operation);
    expect(late).toMatchObject({ outcome: 'rejected', deletePublished: true });
  });

  it('is committed by an administrator’s retry after a failed commit, from what was reported', async () => {
    const w = await world();
    const operation = await create(w);
    // As if the agent's completion had been recorded, and its commit then failed.
    await w.context.pool.execute(
      `UPDATE registration_operations SET state = 'committing', archive_size_bytes = ?, archive_sha256 = ?
       WHERE id = ?`,
      [SIZE, SHA, operation.id],
    );
    const reconciled = await w.admin.request({
      method: 'POST',
      url: `/admin/registrations/${operation.id}/reconcile`,
    });
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    expect(registrationOperationSchema.parse(reconciled.json()).state).toBe('succeeded');
    // And the agent's repeated completion finds that commit.
    expect((await complete(w, operation)).outcome).toBe('committed');
    expect(await rows(w, 'SELECT * FROM vm_versions')).toHaveLength(1);
  });

  it('refuses an archive larger than the server accepts', async () => {
    const w = await world();
    const response = await call(w, 'POST', '/preflight', {
      vmName: VM_NAME,
      archiveSizeBytes: 2 ** 41 + 1,
    });
    expect(response.statusCode).toBe(400);
  });
});
