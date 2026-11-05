import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  agentSummarySchema,
  AGENT_MAX_MESSAGE_BYTES,
  discoveryOperationSchema,
  discoveryStateResponseSchema,
  publicCatalogResponseSchema,
  PROTOCOL_VERSION,
  type DiscoveryOperation,
} from '@emucat/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  agentRow,
  count,
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

let context: BrowserTestContext;
let admin: TestClient;
let url: string;

const OPEN: TestAgent[] = [];

async function connect(credential: string, target = url): Promise<TestAgent> {
  const agent = await TestAgent.connect(target, credential);
  OPEN.push(agent);
  return agent;
}

afterEach(() => {
  for (const agent of OPEN.splice(0)) agent.close();
});

/** Short timers, so that timeouts can be observed quickly. */
const HUB_OPTIONS = {
  heartbeatIntervalSeconds: 1,
  helloTimeoutMs: 300,
  silenceTimeoutMs: 800,
  discoveryTimeoutMs: 400,
  closeGraceMs: 200,
};

beforeAll(async () => {
  context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS }, {}, HUB_OPTIONS);
  admin = await signedInAdmin(context);
  await context.app.listen({ host: '127.0.0.1', port: 0 });
  url = wsUrl(context.app);
});

afterAll(async () => {
  await context.close();
});

const newAgent = (details: object = {}) => pairAgent(context.app, admin, details);

async function summary(agentId: string) {
  return agentSummarySchema.parse((await admin.get(`/admin/agents/${agentId}`)).json());
}

const isOnline = async (agentId: string) => (await summary(agentId)).online;

function rejectedStatus(credential: string): Promise<number> {
  return TestAgent.connect(url, credential).then(
    () => {
      throw new Error('Socket opened');
    },
    (error: Error) => Number(/\d+/.exec(error.message)?.[0]),
  );
}

async function online(paired?: PairedAgent) {
  const identity = paired ?? (await newAgent());
  const agent = await connect(identity.credential);
  await agent.hello();
  return { ...identity, agent };
}

describe('authentication', () => {
  it('accepts a real credential, and welcomes with the identity it belongs to', async () => {
    const paired = await newAgent();
    const agent = await connect(paired.credential);
    const hello = envelope('agent.hello', HELLO);
    agent.send(hello);
    const welcome = await agent.next('server.welcome');
    expect(welcome.correlationId).toBe(JSON.parse(hello).id);
    expect(welcome.payload).toEqual({ agentId: paired.agentId, heartbeatIntervalSeconds: 1 });
  });

  it('refuses an unknown credential before the handshake', async () => {
    await expect(rejectedStatus(`emucat_agent_${'x'.repeat(43)}`)).resolves.toBe(401);
  });

  it('refuses a polling secret or a browser session in place of a credential', async () => {
    await expect(rejectedStatus(admin.cookie as string)).resolves.toBe(401);
    await expect(rejectedStatus(admin.csrfToken as string)).resolves.toBe(401);
  });

  it('refuses a revoked credential', async () => {
    const paired = await newAgent();
    await admin.request({ method: 'POST', url: `/admin/agents/${paired.agentId}/revoke` });
    await expect(rejectedStatus(paired.credential)).resolves.toBe(401);
  });

  it('cannot claim another agent’s identity: only the credential counts', async () => {
    const [mine, theirs] = [await newAgent(), await newAgent()];
    const agent = await connect(mine.credential);
    agent.send(envelope('agent.hello', { ...HELLO, agentId: theirs.agentId }));
    expect((await agent.next('server.welcome')).payload).toMatchObject({ agentId: mine.agentId });
    await waitFor(() => isOnline(mine.agentId), 'the right agent');
    expect(await isOnline(theirs.agentId)).toBe(false);
  });
});

describe('presence', () => {
  it('records the connection and what the agent reports about itself', async () => {
    const { agentId } = await online();
    const row = await agentRow(context.pool, agentId);
    expect(row?.agent_version).toBe('0.2.0');
    expect(row?.protocol_version).toBe(PROTOCOL_VERSION);
    expect(row?.last_connected_at).toBeInstanceOf(Date);
    expect(row?.last_seen_at).toBeInstanceOf(Date);
    expect(await summary(agentId)).toMatchObject({ online: true, agentVersion: '0.2.0' });
  });

  it('is not online until it has said hello', async () => {
    const paired = await newAgent();
    await connect(paired.credential);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await isOnline(paired.agentId)).toBe(false);
  });

  it('goes offline at once when the socket closes, and records when', async () => {
    const { agentId, agent } = await online();
    const before = (await agentRow(context.pool, agentId))?.last_seen_at as Date;
    await new Promise((resolve) => setTimeout(resolve, 10));
    agent.close();
    await waitFor(async () => !(await isOnline(agentId)), 'offline');
    await waitFor(async () => {
      const row = await agentRow(context.pool, agentId);
      return (row?.last_seen_at as Date).getTime() > before.getTime();
    }, 'last seen to move');
  });

  it('acknowledges heartbeats and moves last seen', async () => {
    const { agentId, agent } = await online();
    const before = (await agentRow(context.pool, agentId))?.last_seen_at as Date;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const beat = envelope('agent.heartbeat', {});
    agent.send(beat);
    const ack = await agent.next('server.heartbeat_ack');
    expect(ack.correlationId).toBe(JSON.parse(beat).id);
    const after = (await agentRow(context.pool, agentId))?.last_seen_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    expect(await isOnline(agentId)).toBe(true);
  });
});

describe('timeouts', () => {
  it('closes a connection that never says hello', async () => {
    const paired = await newAgent();
    const agent = await connect(paired.credential);
    const error = await agent.next('server.error');
    expect(error.payload.code).toBe('hello_timeout');
    await expect(agent.closed()).resolves.toBe(4408);
  });

  it('closes a connection that goes silent, and marks the agent offline', async () => {
    const { agentId, agent } = await online();
    await expect(agent.closed()).resolves.toBe(4408);
    expect(await isOnline(agentId)).toBe(false);
  });

  it('keeps a connection that sends heartbeats', async () => {
    const { agentId, agent } = await online();
    for (let index = 0; index < 5; index += 1) {
      agent.send(envelope('agent.heartbeat', {}));
      await agent.next('server.heartbeat_ack');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(agent.closeCode).toBeUndefined();
    expect(await isOnline(agentId)).toBe(true);
  });
});

describe('duplicate connections', () => {
  it('lets the newest connection win, and closes the older one', async () => {
    const { agentId, credential, agent: older } = await online();
    const newer = await connect(credential);
    await newer.hello();

    const error = await older.next('server.error');
    expect(error.payload.code).toBe('superseded');
    await expect(older.closed()).resolves.toBe(4409);
    expect(await isOnline(agentId)).toBe(true);

    newer.send(envelope('agent.heartbeat', {}));
    await newer.next('server.heartbeat_ack');
    expect(newer.closeCode).toBeUndefined();
  });

  it('does not let a stale socket mark the agent offline when it finally closes', async () => {
    const { agentId, credential, agent: stale } = await online();
    const current = await connect(credential);
    await current.hello();
    stale.close();
    await stale.closed();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await isOnline(agentId)).toBe(true);

    current.close();
    await waitFor(async () => !(await isOnline(agentId)), 'offline after the real one closes');
  });

  it('does not let a connection that has not said hello disturb the active one', async () => {
    const { credential, agentId, agent: active } = await online();
    const idle = await connect(credential);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active.send(envelope('agent.heartbeat', {}));
    await active.next('server.heartbeat_ack');
    expect(active.closeCode).toBeUndefined();
    idle.close();
    await idle.closed();
    expect(await isOnline(agentId)).toBe(true);
  });

  it('refuses a second hello on one connection', async () => {
    const { agent } = await online();
    agent.send(envelope('agent.hello', HELLO));
    expect((await agent.next('server.error')).payload.code).toBe('already_greeted');
    expect(agent.closeCode).toBeUndefined();
  });
});

describe('malformed traffic', () => {
  it.each(['not json', '{}', '[]', 'null'])('closes the connection on %j', async (raw) => {
    const { agent } = await online();
    agent.send(raw);
    await expect(agent.closed()).resolves.toBe(4400);
  });

  it('closes the connection on a binary frame', async () => {
    const { agent } = await online();
    agent.send(Buffer.from([1, 2, 3]));
    await expect(agent.closed()).resolves.toBe(4400);
  });

  it('closes the connection on another protocol version', async () => {
    const { agent } = await online();
    agent.send(envelope('agent.heartbeat', {}, { protocolVersion: PROTOCOL_VERSION + 1 }));
    expect((await agent.next('server.error')).payload.code).toBe('unsupported_protocol_version');
    await expect(agent.closed()).resolves.toBe(4406);
  });

  it('closes the connection on an oversized frame', async () => {
    const { agent, agentId } = await online();
    agent.send('x'.repeat(AGENT_MAX_MESSAGE_BYTES + 1));
    // The server closes with 1009, but the data it refused to read can reset the connection first.
    expect([1006, 1009]).toContain(await agent.closed());
    await waitFor(async () => !(await isOnline(agentId)), 'offline');
  });

  it('accepts a frame right at the limit, as far as size goes', async () => {
    const { agent } = await online();
    const padded = envelope('agent.heartbeat', { padding: 'x'.repeat(100) });
    agent.send(padded + ' '.repeat(AGENT_MAX_MESSAGE_BYTES - padded.length));
    expect((await agent.next('server.error')).payload.code).toBe('unsupported_message');
    expect(agent.closeCode).toBeUndefined();
  });

  it('keeps the connection after an unknown type or a bad payload', async () => {
    const { agent } = await online();
    agent.send(envelope('vm.launch', { vmName: 'x' }));
    expect((await agent.next('server.error')).payload.code).toBe('unsupported_message');
    agent.send(envelope('agent.hello', { agentVersion: 'not valid!' }));
    expect((await agent.next('server.error')).payload.code).toBe('unsupported_message');
    agent.send(envelope('agent.heartbeat', {}));
    await agent.next('server.heartbeat_ack');
  });

  it('cuts off a client that floods the connection', async () => {
    const flooded = await startBrowserApp(
      { pairingRateLimits: GENEROUS_RATE_LIMITS },
      {},
      { maxMessagesPerMinute: 5, closeGraceMs: 100 },
    );
    try {
      const client = await signedInAdmin(flooded);
      await flooded.app.listen({ host: '127.0.0.1', port: 0 });
      const paired = await pairAgent(flooded.app, client);
      const agent = await TestAgent.connect(wsUrl(flooded.app), paired.credential);
      OPEN.push(agent);
      for (let index = 0; index < 10; index += 1) {
        if (agent.socket.readyState === agent.socket.OPEN) {
          agent.send(envelope('agent.heartbeat', {}));
        }
      }
      await expect(agent.closed()).resolves.toBe(4429);
    } finally {
      await flooded.close();
    }
  });
});

describe('revocation', () => {
  it('closes the connection at once, and blocks reconnecting', async () => {
    const { agentId, credential, agent } = await online();
    const response = await admin.request({
      method: 'POST',
      url: `/admin/agents/${agentId}/revoke`,
    });
    expect(response.statusCode).toBe(200);
    expect(agentSummarySchema.parse(response.json())).toMatchObject({
      online: false,
      pairingStatus: 'revoked',
    });
    expect((await agent.next('server.error')).payload.code).toBe('agent_revoked');
    await expect(agent.closed()).resolves.toBe(4401);
    await expect(rejectedStatus(credential)).resolves.toBe(401);
  });

  it('also closes a connection that has not said hello yet', async () => {
    const paired = await newAgent();
    const waiting = await connect(paired.credential);
    await admin.request({ method: 'POST', url: `/admin/agents/${paired.agentId}/revoke` });
    await expect(waiting.closed()).resolves.toBe(4401);
  });

  it('refuses a hello that races a revocation', async () => {
    const paired = await newAgent();
    const agent = await connect(paired.credential);
    // The database says revoked, but no hub was told, as with a revocation made elsewhere.
    await context.pool.execute('UPDATE agents SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ?', [
      paired.agentId,
    ]);
    agent.send(envelope('agent.hello', HELLO));
    await expect(agent.closed()).resolves.toBe(4401);
    expect(await isOnline(paired.agentId)).toBe(false);
  });

  it('closes a live connection on its next heartbeat if revoked elsewhere', async () => {
    const { agentId, agent } = await online();
    await context.pool.execute('UPDATE agents SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ?', [
      agentId,
    ]);
    agent.send(envelope('agent.heartbeat', {}));
    await expect(agent.closed()).resolves.toBe(4401);
  });

  it('refuses discovery for a revoked agent', async () => {
    const { agentId } = await online();
    await admin.request({ method: 'POST', url: `/admin/agents/${agentId}/revoke` });
    const response = await admin.request({
      method: 'POST',
      url: `/admin/agents/${agentId}/discovery`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('agent_revoked');
  });

  it('fails a scan that is running', async () => {
    const { agentId, agent } = await online();
    await startDiscovery(agentId);
    await agent.next('server.discovery_request');
    await admin.request({ method: 'POST', url: `/admin/agents/${agentId}/revoke` });
    expect((await readDiscovery(agentId))?.failure?.code).toBe('agent_revoked');
  });
});

async function startDiscovery(agentId: string): Promise<DiscoveryOperation> {
  const response = await admin.request({
    method: 'POST',
    url: `/admin/agents/${agentId}/discovery`,
  });
  if (response.statusCode !== 202) throw new Error(`Refused: ${response.body}`);
  return discoveryOperationSchema.parse(response.json());
}

async function readDiscovery(agentId: string): Promise<DiscoveryOperation | null> {
  const response = await admin.get(`/admin/agents/${agentId}/discovery`);
  return discoveryStateResponseSchema.parse(response.json()).operation;
}

function report(operationId: string, overrides: object = {}) {
  return {
    operationId,
    hostPlatform: 'windows',
    emulators: [
      { emulatorType: '86box', status: 'ok', truncated: false },
      { emulatorType: 'qemu', status: 'ok', truncated: false },
    ],
    vms: [
      { emulatorType: '86box', vmName: 'Dos622', markers: ['86box.cfg'], hostCompatible: null },
      { emulatorType: 'qemu', vmName: 'Win98', markers: ['run-win.cmd'], hostCompatible: true },
      { emulatorType: 'qemu', vmName: 'Tux', markers: ['run-linux.sh'], hostCompatible: false },
    ],
    skipped: [
      { emulatorType: 'qemu', name: 'bad.', reason: 'invalid_name', nameError: 'invalid_boundary' },
    ],
    ...overrides,
  };
}

/** An online agent with a scan under way: its request has arrived and has not been answered. */
async function scanning() {
  const on = await online();
  const started = await startDiscovery(on.agentId);
  const request = await on.agent.next('server.discovery_request');
  expect(request.payload.operationId).toBe(started.id);
  return { ...on, started, request };
}

function answer(agent: TestAgent, requestId: string, operationId: string, overrides: object = {}) {
  agent.send(
    envelope('agent.discovery_result', report(operationId, overrides), {
      correlationId: requestId,
    }),
  );
}

describe('discovery', () => {
  it('refuses an offline or unknown agent', async () => {
    const paired = await newAgent();
    const offline = await admin.request({
      method: 'POST',
      url: `/admin/agents/${paired.agentId}/discovery`,
    });
    expect(offline.statusCode).toBe(409);
    expect(offline.json<{ error: { code: string } }>().error.code).toBe('agent_offline');
    const unknown = await admin.request({
      method: 'POST',
      url: `/admin/agents/${randomUUID()}/discovery`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(await readDiscovery(paired.agentId)).toBeNull();
  });

  it('carries a request to the agent and its answer to the administrator', async () => {
    const { agentId, agent, started, request } = await scanning();
    expect(started).toMatchObject({ status: 'running', agentId, vms: [], finishedAt: null });

    answer(agent, request.id, started.id);
    const finished = await waitFor(async () => {
      const operation = await readDiscovery(agentId);
      return operation?.status === 'completed' ? operation : null;
    }, 'the result');
    expect(finished.id).toBe(started.id);
    expect(finished.hostPlatform).toBe('windows');
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.vms.map((vm) => vm.vmName)).toEqual(['Dos622', 'Win98', 'Tux']);
    expect(finished.skipped[0]).toMatchObject({ reason: 'invalid_name', name: 'bad.' });
  });

  it('never creates catalog entries, and nothing reaches the public catalog', async () => {
    const before = [
      await count(context.pool, 'virtual_machines'),
      await count(context.pool, 'vm_versions'),
      await count(context.pool, 'agent_vm_state'),
    ];
    const { agentId, agent, started, request } = await scanning();
    answer(agent, request.id, started.id, {
      vms: [
        {
          emulatorType: 'qemu',
          vmName: 'NeverPublic',
          markers: ['run-win.cmd'],
          hostCompatible: true,
        },
      ],
    });
    await waitFor(async () => (await readDiscovery(agentId))?.status === 'completed', 'the result');
    expect([
      await count(context.pool, 'virtual_machines'),
      await count(context.pool, 'vm_versions'),
      await count(context.pool, 'agent_vm_state'),
    ]).toEqual(before);
    const catalog = publicCatalogResponseSchema.parse(
      (await new TestClient(context.app).get('/catalog/vms?q=NeverPublic')).json(),
    );
    expect(catalog.items).toEqual([]);
  });

  it('says which VMs are already registered, whatever their case', async () => {
    await insertVm(context.pool, { emulatorType: 'qemu', vmName: 'WIN98' });
    await insertVm(context.pool, { emulatorType: '86box', vmName: 'Tux' });
    const { agentId, agent, started, request } = await scanning();
    answer(agent, request.id, started.id);
    const finished = await waitFor(async () => {
      const operation = await readDiscovery(agentId);
      return operation?.status === 'completed' ? operation : null;
    }, 'the result');
    const flag = Object.fromEntries(finished.vms.map((vm) => [vm.vmName, vm.registered]));
    expect(flag).toEqual({ Dos622: false, Win98: true, Tux: false });
  });

  it('works out host compatibility itself rather than believing the agent', async () => {
    const { agentId, agent, started, request } = await scanning();
    answer(agent, request.id, started.id, {
      vms: [
        { emulatorType: 'qemu', vmName: 'Liar', markers: ['run-linux.sh'], hostCompatible: true },
      ],
    });
    const finished = await waitFor(async () => {
      const operation = await readDiscovery(agentId);
      return operation?.status === 'completed' ? operation : null;
    }, 'the result');
    expect(finished.vms[0]?.hostCompatible).toBe(false);
  });

  it('ignores a claim of identity, and files the report under the connection', async () => {
    const victim = await newAgent();
    const { agentId, agent, started, request } = await scanning();
    answer(agent, request.id, started.id, { agentId: victim.agentId });
    await waitFor(async () => (await readDiscovery(agentId))?.status === 'completed', 'the result');
    expect(await readDiscovery(victim.agentId)).toBeNull();
  });

  it('shares one scan between concurrent requests', async () => {
    const { agentId, agent } = await online();
    const [first, second, third] = await Promise.all([
      startDiscovery(agentId),
      startDiscovery(agentId),
      startDiscovery(agentId),
    ]);
    expect(new Set([first.id, second.id, third.id]).size).toBe(1);
    await agent.next('server.discovery_request');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(agent.received.filter((message) => message.type === 'server.discovery_request')).toEqual(
      [],
    );
  });

  it('times out an agent that never answers, and accepts nothing afterwards', async () => {
    const { agentId, agent, started, request } = await scanning();
    const failed = await waitFor(async () => {
      const operation = await readDiscovery(agentId);
      return operation?.status === 'failed' ? operation : null;
    }, 'the timeout');
    expect(failed.failure?.code).toBe('timeout');

    answer(agent, request.id, started.id);
    agent.send(envelope('agent.heartbeat', {}));
    await agent.next('server.heartbeat_ack');
    const after = await readDiscovery(agentId);
    expect(after).toMatchObject({ status: 'failed', vms: [] });
  });

  it('ignores a duplicate result', async () => {
    const { agentId, agent, started, request } = await scanning();
    answer(agent, request.id, started.id);
    answer(agent, request.id, started.id, { vms: [] });
    agent.send(envelope('agent.heartbeat', {}));
    await agent.next('server.heartbeat_ack');
    const finished = await readDiscovery(agentId);
    expect(finished?.status).toBe('completed');
    expect(finished?.vms).toHaveLength(3);
  });

  it('ignores a result for an operation nobody asked for', async () => {
    const { agentId, agent, started, request } = await scanning();
    answer(agent, request.id, randomUUID());
    agent.send(envelope('agent.heartbeat', {}));
    await agent.next('server.heartbeat_ack');
    expect((await readDiscovery(agentId))?.status).toBe('running');
    answer(agent, request.id, started.id);
    await waitFor(async () => (await readDiscovery(agentId))?.status === 'completed', 'the result');
  });

  it('ignores a result from before any request, with no effect on the connection', async () => {
    const { agentId, agent } = await online();
    agent.send(envelope('agent.discovery_result', report(randomUUID())));
    agent.send(envelope('agent.heartbeat', {}));
    await agent.next('server.heartbeat_ack');
    expect(await readDiscovery(agentId)).toBeNull();
  });

  it('only accepts an answer on the connection that was asked', async () => {
    const { agentId, credential, agent: older, started, request } = await scanning();
    const newer = await connect(credential);
    await newer.hello();
    // Replacing the connection ends the scan on it, and the new connection cannot finish it.
    await older.closed();
    expect((await readDiscovery(agentId))?.failure?.code).toBe('agent_disconnected');
    answer(newer, request.id, started.id);
    newer.send(envelope('agent.heartbeat', {}));
    await newer.next('server.heartbeat_ack');
    expect((await readDiscovery(agentId))?.status).toBe('failed');
  });

  it('does not let another agent answer', async () => {
    const { agentId, started, request } = await scanning();
    const { agent: stranger } = await online();
    answer(stranger, request.id, started.id);
    stranger.send(envelope('agent.heartbeat', {}));
    await stranger.next('server.heartbeat_ack');
    expect((await readDiscovery(agentId))?.status).toBe('running');
  });

  it.each([
    [
      'an invalid VM name',
      {
        vms: [
          {
            emulatorType: 'qemu',
            vmName: '../evil',
            markers: ['run-win.cmd'],
            hostCompatible: true,
          },
        ],
      },
    ],
    [
      'a marker of another emulator',
      {
        vms: [{ emulatorType: 'qemu', vmName: 'Vm', markers: ['86box.cfg'], hostCompatible: true }],
      },
    ],
    [
      'an unknown reason',
      { skipped: [{ emulatorType: 'qemu', name: 'x', reason: 'because', nameError: null }] },
    ],
    [
      'an unsafe skipped name',
      { skipped: [{ emulatorType: 'qemu', name: 'a\nb', reason: 'vanished', nameError: null }] },
    ],
    [
      'too many VMs',
      {
        vms: Array.from({ length: 257 }, (_, index) => ({
          emulatorType: 'qemu',
          vmName: `Vm${index}`,
          markers: ['run-win.cmd'],
          hostCompatible: true,
        })),
      },
    ],
    [
      'one identity twice',
      {
        vms: [
          { emulatorType: 'qemu', vmName: 'Vm', markers: ['run-win.cmd'], hostCompatible: true },
          { emulatorType: 'qemu', vmName: 'VM', markers: ['run-win.cmd'], hostCompatible: true },
        ],
      },
    ],
  ])('fails the operation on a malformed result: %s', async (_label, overrides) => {
    const { agentId, agent, started, request } = await scanning();
    answer(agent, request.id, started.id, overrides);
    expect((await agent.next('server.error')).payload.code).toBe('unsupported_message');
    const failed = await readDiscovery(agentId);
    expect(failed?.failure?.code).toBe('malformed_result');
    expect(failed?.vms).toEqual([]);
    expect(agent.closeCode).toBeUndefined();
  });

  it('fails the operation on a result too large for the protocol', async () => {
    const { agentId, agent, started } = await scanning();
    agent.send(
      envelope('agent.discovery_result', {
        ...report(started.id),
        padding: 'x'.repeat(AGENT_MAX_MESSAGE_BYTES),
      }),
    );
    // The server closes with 1009, but the data it refused to read can reset the connection first.
    expect([1006, 1009]).toContain(await agent.closed());
    await waitFor(
      async () => (await readDiscovery(agentId))?.failure?.code === 'result_too_large',
      'the failure',
    );
  });

  it('fails the operation when the agent disconnects', async () => {
    const { agentId, agent } = await scanning();
    agent.close();
    await waitFor(
      async () => (await readDiscovery(agentId))?.failure?.code === 'agent_disconnected',
      'the failure',
    );
  });

  it('survives an agent restarting mid-scan: a new scan works on the new connection', async () => {
    const { agentId, credential, agent } = await scanning();
    agent.close();
    await waitFor(async () => (await readDiscovery(agentId))?.status === 'failed', 'the failure');

    const restarted = await connect(credential);
    await restarted.hello();
    const again = await startDiscovery(agentId);
    const request = await restarted.next('server.discovery_request');
    answer(restarted, request.id, again.id);
    await waitFor(async () => (await readDiscovery(agentId))?.status === 'completed', 'the result');
  });

  it.each([
    ['busy', 'agent_busy'],
    ['scan_failed', 'agent_error'],
    ['invalid_request', 'agent_error'],
  ])('reports the agent’s error %s', async (code, failure) => {
    const { agentId, agent, started, request } = await scanning();
    agent.send(
      envelope(
        'agent.discovery_error',
        { operationId: started.id, code, message: 'x' },
        { correlationId: request.id },
      ),
    );
    agent.send(envelope('agent.heartbeat', {}));
    await agent.next('server.heartbeat_ack');
    expect((await readDiscovery(agentId))?.failure?.code).toBe(failure);
  });

  it('exposes no filesystem path, because a report has no place for one', async () => {
    const { agentId, agent, started, request } = await scanning();
    answer(agent, request.id, started.id, { basePath: 'C:\\secret\\vms', path: '/etc' });
    await waitFor(async () => (await readDiscovery(agentId))?.status === 'completed', 'the result');
    const raw = (await admin.get(`/admin/agents/${agentId}/discovery`)).body;
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('/etc');
  });
});

describe('server restart', () => {
  it('shows nobody as online afterwards, and accepts the same credential again', async () => {
    const first = await startBrowserApp(
      { pairingRateLimits: GENEROUS_RATE_LIMITS },
      {},
      HUB_OPTIONS,
    );
    try {
      const client = await signedInAdmin(first);
      await first.app.listen({ host: '127.0.0.1', port: 0 });
      const paired = await pairAgent(first.app, client);
      const agent = await TestAgent.connect(wsUrl(first.app), paired.credential);
      OPEN.push(agent);
      await agent.hello();
      const seenBefore = (await agentRow(first.pool, paired.agentId))?.last_seen_at as Date;

      // A second instance stands in for the restarted server: same database, empty hub.
      const restarted = await first.buildAnother();
      await restarted.listen({ host: '127.0.0.1', port: 0 });
      const after = new TestClient(restarted);
      await after.login('admin', 'correct horse battery staple');
      const summaryAfter = agentSummarySchema.parse(
        (await after.get(`/admin/agents/${paired.agentId}`)).json(),
      );
      expect(summaryAfter.online).toBe(false);

      // The old server going away closes the socket, as the agent will see it.
      await first.app.close();
      await expect(agent.closed()).resolves.toBe(1001);
      const seenAfter = (await agentRow(first.pool, paired.agentId))?.last_seen_at as Date;
      expect(seenAfter.getTime()).toBeGreaterThanOrEqual(seenBefore.getTime());

      const port = (restarted.server.address() as AddressInfo).port;
      const again = await TestAgent.connect(
        `ws://127.0.0.1:${port}/api/v1/agent/ws`,
        paired.credential,
      );
      OPEN.push(again);
      await again.hello();
      expect(
        agentSummarySchema.parse((await after.get(`/admin/agents/${paired.agentId}`)).json())
          .online,
      ).toBe(true);
    } finally {
      await first.close();
    }
  });
});
