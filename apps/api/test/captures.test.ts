import { createHash, randomUUID } from 'node:crypto';
import { captureOperationSchema, PROTOCOL_VERSION, type CaptureOperation } from '@emucat/contracts';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CaptureCoordinator } from '../src/execution/captures.js';
import { envelope, GENEROUS_RATE_LIMITS, pairAgent, TestAgent, wsUrl } from './agent-helpers.js';
import {
  HOST,
  insertVm,
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from './browser-app.js';

let context: BrowserTestContext;
let admin: TestClient;
let paired: { agentId: string; credential: string };
let agent: TestAgent;
const capabilities = {
  emulators: [{ emulatorType: 'qemu', launchable: true, problem: null }],
  modes: ['local'],
  qemuScreenshot: true,
};
const ppm = Buffer.concat([Buffer.from('P6\n2 1\n255\n'), Buffer.from([255, 0, 0, 0, 255, 0])]);
const hash = createHash('sha256').update(ppm).digest('hex');

async function barrier() {
  agent.send(envelope('agent.heartbeat', {}));
  await agent.next('server.heartbeat_ack');
}
beforeAll(async () => {
  context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
  admin = await signedInAdmin(context);
  paired = await pairAgent(context.app, admin);
  await context.app.listen({ host: '127.0.0.1', port: 0 });
  agent = await TestAgent.connect(wsUrl(context.app), paired.credential);
  await agent.hello();
  agent.send(envelope('agent.execution_sync', { sessions: [], capabilities, verifications: [] }));
  await barrier();
});
afterAll(async () => {
  agent?.close();
  await context?.close();
});

it('keeps the connection and waits for replay when recording a report fails', async () => {
  const s = await session();
  const capture = captureOperationSchema.parse(
    (
      await admin.request({ method: 'POST', url: s.path, payload: { requestId: randomUUID() } })
    ).json(),
  );
  const interrupted = vi
    .spyOn(CaptureCoordinator.prototype, 'report')
    .mockRejectedValueOnce(new Error('Temporary database outage'));
  try {
    agent.send(envelope('agent.qemu_capture', report(capture)));
    await barrier();
    expect((await admin.get(`${s.path}/${capture.id}`)).json().state).toBe('requested');
    agent.send(envelope('agent.qemu_capture', report(capture)));
    await barrier();
    expect((await admin.get(`${s.path}/${capture.id}`)).json().state).toBe('uploading');
  } finally {
    interrupted.mockRestore();
  }
});

async function session(options: { available?: boolean; emulator?: string } = {}) {
  const id = randomUUID();
  const vmName = `Capture ${randomUUID().slice(0, 8)}`;
  const emulator = options.emulator ?? 'qemu';
  await insertVm(context.pool, { vmName, emulatorType: emulator });
  await context.pool.execute(
    "INSERT INTO vm_sessions (id, agent_id, emulator_type, vm_name, mode, execution_state, screenshot_available) VALUES (?, ?, ?, ?, 'local', 'running', ?)",
    [id, paired.agentId, emulator, vmName, options.available ?? true],
  );
  return { id, vmName, path: `/admin/sessions/${id}/screenshots` };
}
function report(capture: CaptureOperation, overrides = {}) {
  return {
    operationId: capture.id,
    sessionId: capture.sessionId,
    emulatorType: 'qemu',
    vmName: capture.vmName,
    state: 'uploading',
    sha256: hash,
    uncertain: false,
    code: null,
    message: null,
    ...overrides,
  };
}
async function upload(
  capture: CaptureOperation,
  credential = paired.credential,
  captureId = capture.id,
) {
  return context.app.inject({
    method: 'PUT',
    url: `/api/v1/agent/media/vms/qemu/${encodeURIComponent(capture.vmName)}/screenshots/${hash}`,
    headers: {
      host: HOST,
      authorization: `Bearer ${credential}`,
      'x-emucat-protocol-version': String(PROTOCOL_VERSION),
      'x-emucat-source-path': `emucat-capture-${captureId}.ppm`,
      'x-emucat-capture-id': captureId,
      'content-type': 'application/octet-stream',
    },
    payload: ppm,
  });
}

it('requires an administrator and CSRF, and refuses QMP/path injection and unsupported sessions', async () => {
  const s = await session();
  const anonymous = new TestClient(context.app);
  expect(
    (await anonymous.request({ method: 'POST', url: s.path, payload: { requestId: randomUUID() } }))
      .statusCode,
  ).toBe(401);
  const member = new TestClient(context.app);
  const password = 'capture-test-member-password';
  await context.pool.execute(
    "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?, 'capturemember', 'Capture member', ?, 'user')",
    [randomUUID(), await context.dependencies.passwords.hash(password)],
  );
  expect((await member.login('capturemember', password)).statusCode).toBe(200);
  expect(
    (await member.request({ method: 'POST', url: s.path, payload: { requestId: randomUUID() } }))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await admin.request({
        method: 'POST',
        url: s.path,
        csrf: false,
        payload: { requestId: randomUUID() },
      })
    ).statusCode,
  ).toBe(403);
  for (const extra of [
    { filename: 'C:\\arbitrary.ppm' },
    { command: 'quit' },
    { arguments: { filename: 'outside' } },
  ]) {
    expect(
      (
        await admin.request({
          method: 'POST',
          url: s.path,
          payload: { requestId: randomUUID(), ...extra },
        })
      ).statusCode,
    ).toBe(400);
  }
  const recovered = await session({ available: false });
  expect((await admin.get(recovered.path)).json().reason).toMatch(/restart/);
  expect(
    (
      await admin.request({
        method: 'POST',
        url: recovered.path,
        payload: { requestId: randomUUID() },
      })
    ).statusCode,
  ).toBe(409);
  const box = await session({ emulator: '86box' });
  expect(
    (await admin.request({ method: 'POST', url: box.path, payload: { requestId: randomUUID() } }))
      .statusCode,
  ).toBe(409);
});

it('is idempotent under concurrent requests and serializes different requests per session', async () => {
  const s = await session();
  const requestId = randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 3 }, () =>
      admin.request({ method: 'POST', url: s.path, payload: { requestId } }),
    ),
  );
  expect(responses.map((response) => response.statusCode)).toEqual([202, 202, 202]);
  const ids = responses.map((response) => captureOperationSchema.parse(response.json()).id);
  expect(new Set(ids).size).toBe(1);
  expect(
    (await admin.request({ method: 'POST', url: s.path, payload: { requestId: randomUUID() } }))
      .statusCode,
  ).toBe(409);
  const other = await session();
  expect(
    (await admin.request({ method: 'POST', url: other.path, payload: { requestId } })).statusCode,
  ).toBe(409);
});

it('publishes through existing PPM processing without a persistent local copy and independently completes identical captures', async () => {
  const s = await session();
  const created = await admin.request({
    method: 'POST',
    url: s.path,
    payload: { requestId: randomUUID() },
  });
  expect(created.statusCode, created.body).toBe(202);
  const capture = captureOperationSchema.parse(created.json());
  agent.send(envelope('agent.qemu_capture', report(capture)));
  await barrier();
  expect((await admin.get(`${s.path}/${capture.id}`)).json().state).toBe('uploading');
  // Ordinary uploads remain forbidden: no agent_vm_state association exists.
  const ordinary = await context.app.inject({
    method: 'PUT',
    url: `/api/v1/agent/media/vms/qemu/${encodeURIComponent(s.vmName)}/screenshots/${hash}`,
    headers: {
      host: HOST,
      authorization: `Bearer ${paired.credential}`,
      'x-emucat-protocol-version': String(PROTOCOL_VERSION),
      'x-emucat-source-path': 'manual.ppm',
      'content-type': 'application/octet-stream',
    },
    payload: ppm,
  });
  expect(ordinary.statusCode).toBe(403);
  const stored = await upload(capture);
  expect(stored.statusCode, stored.body).toBe(201);
  const mediaId = stored.json().mediaId;
  agent.send(envelope('agent.qemu_capture', report(capture)));
  await agent.next('server.qemu_capture_ack');
  await barrier();
  expect((await admin.get(`${s.path}/${capture.id}`)).json()).toMatchObject({
    state: 'completed',
    mediaId,
  });
  const duplicate = await upload(capture);
  expect(duplicate.statusCode).toBe(200);
  expect(duplicate.json().mediaId).toBe(mediaId);
  const second = captureOperationSchema.parse(
    (
      await admin.request({ method: 'POST', url: s.path, payload: { requestId: randomUUID() } })
    ).json(),
  );
  // No HTTP upload is needed for the identical second frame.
  agent.send(envelope('agent.qemu_capture', report(second)));
  await agent.next('server.qemu_capture_ack');
  await barrier();
  expect((await admin.get(`${s.path}/${second.id}`)).json()).toMatchObject({
    state: 'completed',
    mediaId,
  });
  for (const variant of ['original', 'thumbnail', 'full'])
    expect(
      (
        await admin.get(
          `/admin/vms/qemu/${encodeURIComponent(s.vmName)}/media/${mediaId}/${variant}`,
        )
      ).statusCode,
    ).toBe(200);
  const wrong = await pairAgent(context.app, admin, { name: 'Wrong capture agent' });
  expect((await upload(capture, wrong.credential)).statusCode).toBe(403);
  expect((await upload(capture, paired.credential, randomUUID())).statusCode).toBe(403);
});

it('retains failed operations across API rebuilds and bounds explicit retries', async () => {
  const s = await session();
  const capture = captureOperationSchema.parse(
    (
      await admin.request({ method: 'POST', url: s.path, payload: { requestId: randomUUID() } })
    ).json(),
  );
  for (let attempt = 1; attempt <= 3; attempt++) {
    agent.send(
      envelope(
        'agent.qemu_capture',
        report(capture, {
          state: 'failed',
          code: 'upload_too_large',
          message: 'Retained on agent',
        }),
      ),
    );
    await barrier();
    const retried = await admin.request({
      method: 'POST',
      url: `${s.path}/${capture.id}/retry`,
      payload: {},
    });
    expect(retried.statusCode, retried.body).toBe(202);
    expect(retried.json().retryAttempts).toBe(attempt);
  }
  agent.send(
    envelope(
      'agent.qemu_capture',
      report(capture, { state: 'failed', code: 'upload_too_large', message: 'Retained on agent' }),
    ),
  );
  await barrier();
  expect(
    (await admin.request({ method: 'POST', url: `${s.path}/${capture.id}/retry`, payload: {} }))
      .statusCode,
  ).toBe(409);
  const another = await context.buildAnother();
  const client = new TestClient(another);
  client.cookie = admin.cookie;
  client.csrfToken = admin.csrfToken;
  expect((await client.get(`${s.path}/${capture.id}`)).json()).toMatchObject({
    state: 'failed',
    retryAttempts: 3,
  });
});

it('ignores a foreign agent report and never reactivates a failed capture beside a newer operation', async () => {
  const s = await session();
  const first = captureOperationSchema.parse(
    (
      await admin.request({ method: 'POST', url: s.path, payload: { requestId: randomUUID() } })
    ).json(),
  );
  agent.send(
    envelope(
      'agent.qemu_capture',
      report(first, {
        state: 'failed',
        sha256: null,
        uncertain: true,
        code: 'capture_failed',
        message: 'Interrupted',
      }),
    ),
  );
  await barrier();
  const second = captureOperationSchema.parse(
    (
      await admin.request({ method: 'POST', url: s.path, payload: { requestId: randomUUID() } })
    ).json(),
  );
  agent.send(envelope('agent.qemu_capture', report(first)));
  await barrier();
  expect((await admin.get(`${s.path}/${first.id}`)).json().state).toBe('failed');
  expect((await admin.get(s.path)).json().operation.id).toBe(second.id);
  const pairedOther = await pairAgent(context.app, admin, { name: 'Foreign report agent' });
  const other = await TestAgent.connect(wsUrl(context.app), pairedOther.credential);
  await other.hello();
  other.send(
    envelope(
      'agent.qemu_capture',
      report(second, { state: 'failed', code: 'forged', message: 'wrong agent' }),
    ),
  );
  other.send(envelope('agent.heartbeat', {}));
  await other.next('server.heartbeat_ack');
  expect((await admin.get(`${s.path}/${second.id}`)).json().state).toBe('requested');
  other.close();
});
