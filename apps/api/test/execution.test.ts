import { createHash, randomUUID } from 'node:crypto';
import {
  adminCatalogResponseSchema,
  archiveObjectKey,
  executionOptionsResponseSchema,
  vmSessionListResponseSchema,
  vmSessionSchema,
  vmVerificationSchema,
  type RepositorySummary,
  type VmSession,
  type VmVerification,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, describe, expect, it } from 'vitest';
import {
  envelope,
  GENEROUS_RATE_LIMITS,
  HELLO,
  pairAgent,
  TestAgent,
  waitFor,
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

const worlds: BrowserTestContext[] = [];
afterAll(async () => {
  await Promise.all(worlds.map((world) => world.close()));
});

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const ARCHIVE_SHA256 = hash('the archive');
const MANIFEST_SHA256 = hash('the manifest');

interface World {
  context: BrowserTestContext;
  admin: TestClient;
  agent: TestAgent;
  paired: PairedAgent;
  repository: RepositorySummary;
  versionId: string;
}

async function connect(app: FastifyInstance, credential: string): Promise<TestAgent> {
  const agent = await TestAgent.connect(wsUrl(app), credential);
  agent.send(envelope('agent.hello', HELLO));
  await agent.next('server.welcome');
  return agent;
}

async function barrier(agent: TestAgent): Promise<void> {
  agent.send(envelope('agent.heartbeat', {}));
  await agent.next('server.heartbeat_ack');
}

const CAPABILITIES = {
  emulators: [
    { emulatorType: 'qemu', launchable: true, problem: null },
    { emulatorType: '86box', launchable: false, problem: 'The executable is not configured.' },
  ],
  modes: ['local'],
};

async function executionSync(agent: TestAgent, overrides: object = {}): Promise<void> {
  agent.send(
    envelope('agent.execution_sync', {
      sessions: [],
      capabilities: CAPABILITIES,
      verifications: [],
      ...overrides,
    }),
  );
  await barrier(agent);
}

async function world(options: { local?: boolean } = {}): Promise<World> {
  const context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
  worlds.push(context);
  await context.app.listen({ host: '127.0.0.1', port: 0 });
  const admin = await signedInAdmin(context);
  const paired = await pairAgent(context.app, admin);
  const agent = await connect(context.app, paired.credential);
  const created = await admin.request({
    method: 'POST',
    url: '/admin/repositories',
    payload: { name: 'NAS', host: 'nas.example', port: 22, username: 'emucat', remoteRoot: '/r' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const repository = created.json<RepositorySummary>();
  const { pool } = context;
  await insertVm(pool, { vmName: 'Win98' });
  const versionId = randomUUID();
  await pool.execute(
    `INSERT INTO vm_versions
       (id, emulator_type, vm_name, kind, repository_id, archive_key, archive_sha256,
        archive_size_bytes, created_by_agent_id)
     VALUES (?, 'qemu', 'Win98', 'master', ?, ?, ?, 4096, ?)`,
    [
      versionId,
      repository.id,
      archiveObjectKey({ emulatorType: 'qemu', vmName: 'Win98' }, versionId),
      ARCHIVE_SHA256,
      paired.agentId,
    ],
  );
  if (options.local !== false) {
    await pool.execute(
      `INSERT INTO agent_vm_state
         (agent_id, emulator_type, vm_name, local_source_version_id, execution_state)
       VALUES (?, 'qemu', 'Win98', ?, 'idle')`,
      [paired.agentId, versionId],
    );
  }
  await executionSync(agent);
  return { context, admin, agent, paired, repository, versionId };
}

function launchBody(w: World, overrides: object = {}) {
  return {
    agentId: w.paired.agentId,
    emulatorType: 'qemu',
    vmName: 'Win98',
    mode: 'local',
    requestId: randomUUID(),
    ...overrides,
  };
}

async function launch(w: World, overrides: object = {}): Promise<VmSession> {
  const response = await w.admin.request({
    method: 'POST',
    url: '/admin/sessions',
    payload: launchBody(w, overrides),
  });
  expect(response.statusCode, response.body).toBe(202);
  return vmSessionSchema.parse(response.json());
}

async function read(w: World, sessionId: string): Promise<VmSession> {
  const response = await w.admin.get(`/admin/sessions/${sessionId}`);
  expect(response.statusCode, response.body).toBe(200);
  return vmSessionSchema.parse(response.json());
}

function status(sessionId: string, overrides: object = {}) {
  return {
    sessionId,
    emulatorType: 'qemu',
    vmName: 'Win98',
    state: 'running',
    pid: 4242,
    processStartedAt: '2026-11-07T10:00:00.000Z',
    startedAt: '2026-11-07T10:00:00.100Z',
    endedAt: null,
    exitCode: null,
    stopRequested: false,
    gracefulStopAvailable: true,
    code: null,
    message: null,
    ...overrides,
  };
}

async function running(w: World): Promise<VmSession> {
  const session = await launch(w);
  await w.agent.next('server.vm_launch');
  w.agent.send(envelope('agent.vm_execution_status', status(session.id)));
  await barrier(w.agent);
  return read(w, session.id);
}

async function insertSession(
  w: World,
  state: string,
  options: { ageSeconds?: number; vmName?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await w.context.pool.execute(
    `INSERT INTO vm_sessions
       (id, agent_id, request_id, emulator_type, vm_name, mode, execution_state, ended_at, created_at)
     VALUES (?, ?, ?, 'qemu', ?, 'local', ?, NULL, UTC_TIMESTAMP(3) - INTERVAL ? SECOND)`,
    [id, w.paired.agentId, randomUUID(), options.vmName ?? 'Win98', state, options.ageSeconds ?? 0],
  );
  return id;
}

async function errorCode(response: { json: <T>() => T }): Promise<string> {
  return response.json<{ error: { code: string } }>().error.code;
}

describe('options', () => {
  it('offers all three modes, and says for each agent why a remote one cannot start', async () => {
    const w = await world();
    const response = await w.admin.get('/admin/vms/qemu/Win98/execution-options');
    expect(response.statusCode, response.body).toBe(200);
    const options = executionOptionsResponseSchema.parse(response.json());
    expect(options.modes.map((mode) => [mode.mode, mode.available, mode.reason])).toEqual([
      ['local', true, null],
      ['remote_volatile', true, null],
      ['remote_snapshot', true, null],
    ]);
    // This agent only says it runs local sessions: the remote modes are refused, with the reason.
    expect(options.agents[0]).toMatchObject({
      launch: { eligible: true, reason: null },
      verify: { eligible: true, reason: null },
      remote: {
        remote_volatile: { eligible: false, reason: 'mode_not_supported' },
        remote_snapshot: { eligible: false, reason: 'mode_not_supported' },
      },
      activeWorkspaceId: null,
      local: { present: true, sourceVersionId: w.versionId },
      activeSession: null,
    });
  });

  it('explains what stands in the way', async () => {
    const w = await world({ local: false });
    let options = executionOptionsResponseSchema.parse(
      (await w.admin.get('/admin/vms/qemu/Win98/execution-options')).json(),
    );
    expect(options.agents[0]?.launch.reason).toBe('vm_not_on_agent');
    expect(options.agents[0]?.verify.reason).toBe('vm_not_on_agent');

    await executionSync(w.agent, {
      capabilities: { ...CAPABILITIES, emulators: [CAPABILITIES.emulators[1]] },
    });
    options = executionOptionsResponseSchema.parse(
      (await w.admin.get('/admin/vms/qemu/Win98/execution-options')).json(),
    );
    expect(options.agents[0]?.launch).toMatchObject({
      eligible: false,
      reason: 'emulator_not_launchable',
    });

    w.agent.close();
    await waitFor(async () => {
      const body = executionOptionsResponseSchema.parse(
        (await w.admin.get('/admin/vms/qemu/Win98/execution-options')).json(),
      );
      return body.agents[0]?.launch.reason === 'agent_offline';
    }, 'the agent to be offline');
  });

  it('is for administrators only', async () => {
    const w = await world();
    const anonymous = await w.context.app.inject({
      method: 'GET',
      url: '/api/v1/admin/vms/qemu/Win98/execution-options',
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('launch', () => {
  it('records a request and sends the agent only names, never a command', async () => {
    const w = await world();
    const session = await launch(w);
    expect(session).toMatchObject({ state: 'requested', mode: 'local', versionId: w.versionId });
    const message = await w.agent.next('server.vm_launch');
    expect(message.payload).toEqual({
      sessionId: session.id,
      emulatorType: 'qemu',
      vmName: 'Win98',
      mode: 'local',
      versionId: w.versionId,
    });
  });

  it('starts one session for one request, however often it is sent', async () => {
    const w = await world();
    const body = launchBody(w);
    const [first, second] = await Promise.all(
      [0, 1].map(() => w.admin.request({ method: 'POST', url: '/admin/sessions', payload: body })),
    );
    expect(first?.statusCode, first?.body).toBe(202);
    expect(second?.statusCode, second?.body).toBe(202);
    expect(first?.json<VmSession>().id).toBe(second?.json<VmSession>().id);
    const [rows] = await w.context.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM vm_sessions',
    );
    expect(Number(rows[0]?.n)).toBe(1);

    const reused = await w.admin.request({
      method: 'POST',
      url: '/admin/sessions',
      payload: { ...body, vmName: 'Other' },
    });
    expect(reused.statusCode).toBe(409);
    expect(await errorCode(reused)).toBe('request_id_reused');
  });

  it('refuses a second session of a running VM', async () => {
    const w = await world();
    await running(w);
    const response = await w.admin.request({
      method: 'POST',
      url: '/admin/sessions',
      payload: launchBody(w),
    });
    expect(response.statusCode).toBe(409);
    expect(await errorCode(response)).toBe('session_active');
  });

  it('refuses a remote mode, and never falls back to a local launch', async () => {
    const w = await world();
    const attempts: [object, number, string][] = [
      // A remote mode runs a working copy, so it has to name one.
      [{ mode: 'remote_volatile' }, 400, 'validation_failed'],
      [{ mode: 'remote_snapshot' }, 400, 'validation_failed'],
      // This agent only says it runs local sessions.
      [{ mode: 'remote_volatile', workspaceId: randomUUID() }, 409, 'execution_mode_unavailable'],
      [{ mode: 'remote_snapshot', workspaceId: randomUUID() }, 409, 'execution_mode_unavailable'],
    ];
    for (const [overrides, status, code] of attempts) {
      const response = await w.admin.request({
        method: 'POST',
        url: '/admin/sessions',
        payload: launchBody(w, overrides),
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(await errorCode(response)).toBe(code);
    }
    await barrier(w.agent);
    expect(w.agent.received.filter((message) => message.type === 'server.vm_launch')).toEqual([]);
    const [rows] = await w.context.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM vm_sessions',
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('refuses while the agent works on the VM', async () => {
    const w = await world();
    const verification = await w.admin.request({
      method: 'POST',
      url: '/admin/verifications',
      payload: { agentId: w.paired.agentId, emulatorType: 'qemu', vmName: 'Win98' },
    });
    expect(verification.statusCode, verification.body).toBe(202);
    const response = await w.admin.request({
      method: 'POST',
      url: '/admin/sessions',
      payload: launchBody(w),
    });
    expect(response.statusCode).toBe(409);
    expect(await errorCode(response)).toBe('operation_in_progress');
  });

  it('rejects anything that looks like a command', async () => {
    const w = await world();
    for (const payload of [
      launchBody(w, { command: 'calc.exe' }),
      launchBody(w, { vmName: '..\\..\\Windows' }),
      launchBody(w, { vmName: 'Win98 & calc' }),
      launchBody(w, { arguments: ['-hda', 'C:\\x'] }),
    ]) {
      const response = await w.admin.request({ method: 'POST', url: '/admin/sessions', payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('what the agent reports', () => {
  it('follows a session to its end, and answers the end until the agent stops repeating it', async () => {
    const w = await world();
    const session = await running(w);
    expect(session).toMatchObject({
      state: 'running',
      pid: 4242,
      processStartedAt: '2026-11-07T10:00:00.000Z',
      gracefulStopAvailable: true,
      endedAt: null,
    });
    const ended = status(session.id, {
      state: 'exited',
      endedAt: '2026-11-07T10:05:00.000Z',
      exitCode: 0,
    });
    w.agent.send(envelope('agent.vm_execution_status', ended));
    expect((await w.agent.next('server.vm_execution_ack')).payload).toEqual({
      sessionId: session.id,
    });
    w.agent.send(envelope('agent.vm_execution_status', ended));
    await w.agent.next('server.vm_execution_ack');
    expect(await read(w, session.id)).toMatchObject({
      state: 'exited',
      exitCode: 0,
      endedAt: '2026-11-07T10:05:00.000Z',
    });
  });

  it('ignores a report that names another VM, or comes from another agent', async () => {
    const w = await world();
    const session = await running(w);
    w.agent.send(
      envelope(
        'agent.vm_execution_status',
        status(session.id, { vmName: 'Other', state: 'exited' }),
      ),
    );
    await barrier(w.agent);
    expect((await read(w, session.id)).state).toBe('running');

    const other = await pairAgent(w.context.app, w.admin);
    const intruder = await connect(w.context.app, other.credential);
    intruder.send(
      envelope('agent.vm_execution_status', status(session.id, { state: 'exited', endedAt: null })),
    );
    await barrier(intruder);
    expect((await read(w, session.id)).state).toBe('running');
  });

  it('recovers after a reconnection, from what the agent still knows', async () => {
    const w = await world();
    const lost = await running(w);
    await insertVm(w.context.pool, { vmName: 'Fresh' });
    await insertVm(w.context.pool, { vmName: 'Old' });
    const fresh = await insertSession(w, 'requested', { vmName: 'Fresh' });
    const stale = await insertSession(w, 'requested', { vmName: 'Old', ageSeconds: 3600 });

    w.agent.close();
    const agent = await connect(w.context.app, w.paired.credential);
    await executionSync(agent);
    const redispatched = await agent.next('server.vm_launch');
    expect(redispatched.payload).toMatchObject({ sessionId: fresh, vmName: 'Fresh' });
    expect(await read(w, stale)).toMatchObject({
      state: 'failed',
      error: { code: 'launch_not_acknowledged' },
    });
    const interrupted = await read(w, lost.id);
    expect(interrupted).toMatchObject({
      state: 'interrupted',
      error: { code: 'agent_lost_session' },
    });
    expect(interrupted.endedAt).not.toBeNull();

    // The agent can see the process, so its word reopens the session, which protects the VM again.
    agent.send(envelope('agent.vm_execution_status', status(lost.id)));
    await barrier(agent);
    expect(await read(w, lost.id)).toMatchObject({ state: 'running', endedAt: null, error: null });
  });

  it('records the end of a session the agent finished while the server was away', async () => {
    const w = await world();
    const session = await running(w);
    w.agent.close();
    const agent = await connect(w.context.app, w.paired.credential);
    await executionSync(agent, {
      sessions: [
        status(session.id, {
          state: 'stopped',
          endedAt: '2026-11-07T11:00:00.000Z',
          code: 'exited_while_agent_away',
          message: 'The emulator ended while the agent was not running.',
          pid: 4242,
        }),
      ],
    });
    await agent.next('server.vm_execution_ack');
    expect(await read(w, session.id)).toMatchObject({
      state: 'stopped',
      error: { code: 'exited_while_agent_away' },
    });
  });
});

describe('stop', () => {
  it('asks for a graceful stop by default', async () => {
    const w = await world();
    const session = await running(w);
    const response = await w.admin.request({
      method: 'POST',
      url: `/admin/sessions/${session.id}/stop`,
      payload: { force: false },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(vmSessionSchema.parse(response.json()).stopRequested).toBe(true);
    const message = await w.agent.next('server.vm_stop');
    expect(message.payload).toEqual({
      sessionId: session.id,
      emulatorType: 'qemu',
      vmName: 'Win98',
      force: false,
    });
  });

  it('forces a stop only when the VM’s name is typed again', async () => {
    const w = await world();
    const session = await running(w);
    const stop = (payload: object) =>
      w.admin.request({ method: 'POST', url: `/admin/sessions/${session.id}/stop`, payload });
    expect((await stop({ force: true })).statusCode).toBe(400);
    const wrong = await stop({ force: true, confirmVmName: 'Win95' });
    expect(wrong.statusCode).toBe(400);
    expect(await errorCode(wrong)).toBe('confirmation_mismatch');
    await barrier(w.agent);
    expect(w.agent.received.filter((message) => message.type === 'server.vm_stop')).toEqual([]);

    const confirmed = await stop({ force: true, confirmVmName: 'win98' });
    expect(confirmed.statusCode, confirmed.body).toBe(202);
    expect(vmSessionSchema.parse(confirmed.json()).forceRequested).toBe(true);
    expect((await w.agent.next('server.vm_stop')).payload.force).toBe(true);
  });

  it('refuses what it cannot stop', async () => {
    const w = await world();
    const requested = await launch(w);
    const early = await w.admin.request({
      method: 'POST',
      url: `/admin/sessions/${requested.id}/stop`,
      payload: { force: false },
    });
    expect(await errorCode(early)).toBe('session_not_started');

    w.agent.send(envelope('agent.vm_execution_status', status(requested.id, { state: 'unknown' })));
    await barrier(w.agent);
    const unknown = await w.admin.request({
      method: 'POST',
      url: `/admin/sessions/${requested.id}/stop`,
      payload: { force: true, confirmVmName: 'Win98' },
    });
    expect(await errorCode(unknown)).toBe('session_unknown');

    w.agent.send(
      envelope(
        'agent.vm_execution_status',
        status(requested.id, { state: 'exited', endedAt: '2026-11-07T10:01:00.000Z' }),
      ),
    );
    await w.agent.next('server.vm_execution_ack');
    const ended = await w.admin.request({
      method: 'POST',
      url: `/admin/sessions/${requested.id}/stop`,
      payload: { force: false },
    });
    expect(await errorCode(ended)).toBe('session_ended');
  });

  it('never queues a stop for an agent that is away', async () => {
    const w = await world();
    const session = await running(w);
    w.agent.close();
    await waitFor(async () => !(await read(w, session.id)).agentOnline, 'the agent to go');
    const response = await w.admin.request({
      method: 'POST',
      url: `/admin/sessions/${session.id}/stop`,
      payload: { force: false },
    });
    expect(response.statusCode).toBe(409);
    expect(await errorCode(response)).toBe('agent_offline');
    expect((await read(w, session.id)).stopRequested).toBe(false);
  });
});

describe('dismiss', () => {
  it('ends an unknown session only with the VM’s name, and tells the agent', async () => {
    const w = await world();
    const session = await running(w);
    w.agent.send(envelope('agent.vm_execution_status', status(session.id, { state: 'unknown' })));
    await barrier(w.agent);
    const dismiss = (confirmVmName: string) =>
      w.admin.request({
        method: 'POST',
        url: `/admin/sessions/${session.id}/dismiss`,
        payload: { confirmVmName },
      });
    expect(await errorCode(await dismiss('nope'))).toBe('confirmation_mismatch');
    const response = await dismiss('Win98');
    expect(response.statusCode, response.body).toBe(200);
    expect(vmSessionSchema.parse(response.json()).state).toBe('interrupted');
    expect((await w.agent.next('server.vm_execution_ack')).payload.sessionId).toBe(session.id);
  });

  it('refuses to dismiss a session the agent can see running', async () => {
    const w = await world();
    const session = await running(w);
    const response = await w.admin.request({
      method: 'POST',
      url: `/admin/sessions/${session.id}/dismiss`,
      payload: { confirmVmName: 'Win98' },
    });
    expect(await errorCode(response)).toBe('session_not_dismissable');
  });
});

describe('conflicts', () => {
  it('blocks a restore and a verification while the VM may be running', async () => {
    const w = await world({ local: false });
    const associated = await w.admin.request({
      method: 'PUT',
      url: `/admin/repositories/${w.repository.id}/agents/${w.paired.agentId}`,
    });
    expect(associated.statusCode, associated.body).toBe(200);
    w.agent.send(
      envelope('agent.restore_sync', {
        operations: [],
        capabilities: {
          emulators: [{ emulatorType: 'qemu', basePath: 'C:\\vms\\qemu' }],
          repositoryIds: [w.repository.id],
          cacheMaxBytes: 1000,
          cacheUsedBytes: 0,
        },
        localCopies: [],
      }),
    );
    await barrier(w.agent);
    // A session the agent cannot account for, with no local copy recorded.
    await insertSession(w, 'unknown');
    const restore = await w.admin.request({
      method: 'POST',
      url: '/admin/restores',
      payload: {
        agentId: w.paired.agentId,
        emulatorType: 'qemu',
        vmName: 'Win98',
        versionId: w.versionId,
      },
    });
    expect(restore.statusCode).toBe(409);
    expect(await errorCode(restore)).toBe('vm_running');
  });

  it('refuses to verify a running VM', async () => {
    const w = await world();
    await running(w);
    const response = await w.admin.request({
      method: 'POST',
      url: '/admin/verifications',
      payload: { agentId: w.paired.agentId, emulatorType: 'qemu', vmName: 'Win98' },
    });
    expect(response.statusCode).toBe(409);
    expect(await errorCode(response)).toBe('session_active');
  });

  it('shows a running VM in the administrator’s catalog only', async () => {
    const w = await world();
    await running(w);
    const admin = adminCatalogResponseSchema.parse((await w.admin.get('/admin/vms')).json());
    expect(admin.items.find((item) => item.vmName === 'Win98')?.activeSessions).toBe(1);
    await w.context.pool.execute(`UPDATE virtual_machines SET visibility = 'public'`);
    const anonymous = await w.context.app.inject({ method: 'GET', url: '/api/v1/catalog' });
    expect(anonymous.body).not.toMatch(/activeSessions|running/i);
  });
});

describe('verification', () => {
  async function verify(w: World): Promise<VmVerification> {
    const response = await w.admin.request({
      method: 'POST',
      url: '/admin/verifications',
      payload: { agentId: w.paired.agentId, emulatorType: 'qemu', vmName: 'win98' },
    });
    expect(response.statusCode, response.body).toBe(202);
    return vmVerificationSchema.parse(response.json());
  }

  function result(verification: VmVerification, overrides: object = {}) {
    const none = { count: 0, paths: [] };
    return {
      operationId: verification.id,
      versionId: verification.versionId,
      status: 'verified',
      filesVerified: 3,
      bytesHashed: 8192,
      durationMs: 12,
      missing: none,
      modified: none,
      unexpected: none,
      manifestSha256: MANIFEST_SHA256,
      manifestSource: 'repository',
      code: null,
      message: null,
      ...overrides,
    };
  }

  async function state(w: World) {
    const [rows] = await w.context.pool.execute<RowDataPacket[]>(
      `SELECT execution_state, content_status, last_verified_sha256 FROM agent_vm_state
       WHERE agent_id = ?`,
      [w.paired.agentId],
    );
    return rows[0];
  }

  it('names the master, and records a verified copy', async () => {
    const w = await world();
    const verification = await verify(w);
    expect(verification).toMatchObject({ state: 'requested', vmName: 'Win98' });
    const request = await w.agent.next('server.vm_verify');
    expect(request.payload).toMatchObject({
      operationId: verification.id,
      versionId: w.versionId,
      repositoryId: w.repository.id,
      archiveSha256: ARCHIVE_SHA256,
      manifestSha256: null,
    });
    w.agent.send(envelope('agent.vm_verify_result', result(verification)));
    expect((await w.agent.next('server.vm_verify_ack')).payload.operationId).toBe(verification.id);
    const response = await w.admin.get(`/admin/verifications/${verification.id}`);
    expect(vmVerificationSchema.parse(response.json())).toMatchObject({
      state: 'completed',
      status: 'verified',
      filesVerified: 3,
      manifestSource: 'repository',
    });
    expect(await state(w)).toMatchObject({
      content_status: 'verified',
      last_verified_sha256: MANIFEST_SHA256,
    });
  });

  it('records a modified copy with its paths, and a copy that is gone', async () => {
    const w = await world();
    let verification = await verify(w);
    await w.agent.next('server.vm_verify');
    w.agent.send(
      envelope(
        'agent.vm_verify_result',
        result(verification, {
          status: 'modified',
          modified: { count: 1, paths: ['disk.qcow2'] },
          unexpected: { count: 2, paths: ['a.txt', 'b.txt'] },
        }),
      ),
    );
    await w.agent.next('server.vm_verify_ack');
    const read = vmVerificationSchema.parse(
      (await w.admin.get(`/admin/verifications/${verification.id}`)).json(),
    );
    expect(read.modified).toEqual({ count: 1, paths: ['disk.qcow2'] });
    expect(read.unexpected?.count).toBe(2);
    expect(await state(w)).toMatchObject({ content_status: 'modified' });

    verification = await verify(w);
    await w.agent.next('server.vm_verify');
    w.agent.send(
      envelope(
        'agent.vm_verify_result',
        result(verification, { status: 'missing', code: 'vm_not_found', manifestSha256: null }),
      ),
    );
    await w.agent.next('server.vm_verify_ack');
    expect(await state(w)).toMatchObject({ execution_state: 'absent' });
  });

  it('changes nothing about the copy when the check could not be made', async () => {
    const w = await world();
    const verification = await verify(w);
    await w.agent.next('server.vm_verify');
    w.agent.send(
      envelope(
        'agent.vm_verify_result',
        result(verification, {
          status: 'unavailable',
          code: 'vm_running',
          manifestSha256: null,
          manifestSource: null,
        }),
      ),
    );
    await w.agent.next('server.vm_verify_ack');
    expect(await state(w)).toMatchObject({ content_status: 'unverified' });
  });

  it('runs one verification per agent, and gives up one the agent forgot', async () => {
    const w = await world();
    const first = await verify(w);
    const second = await w.admin.request({
      method: 'POST',
      url: '/admin/verifications',
      payload: { agentId: w.paired.agentId, emulatorType: 'qemu', vmName: 'Win98' },
    });
    expect(await errorCode(second)).toBe('operation_in_progress');
    await w.context.pool.execute(
      `UPDATE vm_verifications SET created_at = UTC_TIMESTAMP(3) - INTERVAL 1 HOUR WHERE id = ?`,
      [first.id],
    );
    await executionSync(w.agent);
    const read = vmVerificationSchema.parse(
      (await w.admin.get(`/admin/verifications/${first.id}`)).json(),
    );
    expect(read).toMatchObject({ state: 'expired', error: { code: 'verify_not_acknowledged' } });
  });
});

describe('history and revocation', () => {
  it('lists sessions newest first, and ends them when the agent is revoked', async () => {
    const w = await world();
    const session = await running(w);
    const list = vmSessionListResponseSchema.parse(
      (await w.admin.get('/admin/sessions?vmName=Win98')).json(),
    );
    expect(list.sessions.map((item) => item.id)).toEqual([session.id]);
    const revoked = await w.admin.request({
      method: 'POST',
      url: `/admin/agents/${w.paired.agentId}/revoke`,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    await waitFor(
      async () => (await read(w, session.id)).state === 'interrupted',
      'the session to end',
    );
    expect((await read(w, session.id)).error?.code).toBe('agent_revoked');
  });
});
