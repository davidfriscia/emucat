import { Writable } from 'node:stream';
import {
  agentListResponseSchema,
  agentSummarySchema,
  errorResponseSchema,
  normalizePairingCode,
  pairingRequestListResponseSchema,
  pairingRequestReviewSchema,
  PROTOCOL_VERSION,
} from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/auth/agent-auth.js';
import { RateLimiter } from '../src/auth/rate-limiter.js';
import {
  agentRow,
  AGENT_DETAILS,
  approve,
  count,
  GENEROUS_RATE_LIMITS,
  lookUp,
  ORIGIN,
  pairAgent,
  poll,
  pollRaw,
  reject,
  requestPairing,
} from './agent-helpers.js';
import {
  ADMIN_PASSWORD,
  HOST,
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from './browser-app.js';

const UNKNOWN_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60';

let context: BrowserTestContext;
let admin: TestClient;
let adminId: string;

beforeAll(async () => {
  context = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
  admin = await signedInAdmin(context);
  const me = await admin.get('/auth/me');
  adminId = me.json<{ user: { id: string } }>().user.id;
});

afterAll(async () => {
  await context.close();
});

const app = () => context.app;

/** Makes a request's deadline pass, without waiting for it. */
async function expire(code: string) {
  const canonical = normalizePairingCode(code) as string;
  await context.pool.execute(
    `UPDATE agent_pairing_requests SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND
     WHERE code_hash = ?`,
    [hashToken(canonical)],
  );
}

const errorCode = (body: unknown) => errorResponseSchema.parse(body).error.code;

describe('requesting pairing', () => {
  it('returns a code and a secret, and stores only digests of them', async () => {
    const created = await requestPairing(app());
    expect(created.pairingCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(created.pollingSecret.length).toBeGreaterThanOrEqual(43);
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const canonical = normalizePairingCode(created.pairingCode) as string;
    const [rows] = await context.pool.execute<RowDataPacket[]>(
      'SELECT * FROM agent_pairing_requests WHERE polling_secret_hash = ?',
      [hashToken(created.pollingSecret)],
    );
    expect(rows).toHaveLength(1);
    expect((rows[0]?.code_hash as Buffer).equals(hashToken(canonical))).toBe(true);
    const stored = JSON.stringify(rows[0]);
    expect(stored).not.toContain(created.pollingSecret);
    expect(stored).not.toContain(canonical);
  });

  it('marks responses as uncacheable', async () => {
    const response = await app().inject({
      method: 'POST',
      url: '/api/v1/agent/pairing/requests',
      headers: { host: HOST },
      payload: AGENT_DETAILS,
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['an unknown field', { agentId: UNKNOWN_ID }],
    ['control characters in the name', { name: 'a\nb' }],
    ['an empty name', { name: '   ' }],
    ['a long name', { name: 'x'.repeat(129) }],
    ['an unknown platform', { platform: 'plan9' }],
    ['an unknown architecture', { architecture: 'mips' }],
    ['a strange version', { agentVersion: 'a b' }],
  ])('refuses %s', async (_label, change) => {
    const response = await app().inject({
      method: 'POST',
      url: '/api/v1/agent/pairing/requests',
      headers: { host: HOST },
      payload: { ...AGENT_DETAILS, ...change },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses another protocol version', async () => {
    const response = await app().inject({
      method: 'POST',
      url: '/api/v1/agent/pairing/requests',
      headers: { host: HOST },
      payload: { ...AGENT_DETAILS, protocolVersion: PROTOCOL_VERSION + 1 },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response.json())).toBe('unsupported_protocol_version');
  });

  it('refuses a request a browser says is from another site', async () => {
    const response = await app().inject({
      method: 'POST',
      url: '/api/v1/agent/pairing/requests',
      headers: { host: HOST, origin: 'https://evil.example' },
      payload: AGENT_DETAILS,
    });
    expect(response.statusCode).toBe(403);
  });

  it('removes long-dead requests when a new one arrives', async () => {
    const old = await requestPairing(app());
    await context.pool.execute(
      `UPDATE agent_pairing_requests SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 2 DAY
       WHERE polling_secret_hash = ?`,
      [hashToken(old.pollingSecret)],
    );
    await requestPairing(app());
    const [rows] = await context.pool.execute<RowDataPacket[]>(
      'SELECT 1 FROM agent_pairing_requests WHERE polling_secret_hash = ?',
      [hashToken(old.pollingSecret)],
    );
    expect(rows).toEqual([]);
  });
});

describe('reviewing a request', () => {
  it('shows who is asking, and no secret', async () => {
    const created = await requestPairing(app(), { name: 'Attic server' });
    const response = await lookUp(admin, created.pairingCode);
    expect(response.statusCode).toBe(200);
    const review = pairingRequestReviewSchema.parse(response.json());
    expect(review).toMatchObject({
      status: 'pending',
      name: 'Attic server',
      platform: 'windows',
      architecture: 'x86_64',
      agentVersion: '0.1.0',
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(review.requestedFrom).not.toBe('');
    expect(response.body).not.toContain(created.pollingSecret);
    expect(response.body).not.toMatch(/hash|secret/i);
  });

  it.each(['lowercase', 'unseparated', 'spaced'])('accepts a %s code', async (form) => {
    const { pairingCode } = await requestPairing(app());
    const input =
      form === 'lowercase'
        ? pairingCode.toLowerCase()
        : form === 'unseparated'
          ? pairingCode.replace('-', '')
          : pairingCode.replace('-', ' ');
    expect((await lookUp(admin, input)).statusCode).toBe(200);
  });

  it('gives one answer for a malformed code and an unknown one', async () => {
    const answers = await Promise.all(
      ['nonsense!', 'ZZZZ-ZZZZ'].map(async (code) => {
        const response = await lookUp(admin, code);
        expect(response.statusCode).toBe(404);
        const { code: error, message } = errorResponseSchema.parse(response.json()).error;
        return { error, message };
      }),
    );
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]?.error).toBe('pairing_code_invalid');
  });

  it('says when a request has expired', async () => {
    const created = await requestPairing(app());
    await expire(created.pairingCode);
    const response = await lookUp(admin, created.pairingCode);
    expect(response.statusCode).toBe(410);
    expect(errorCode(response.json())).toBe('pairing_expired');
  });

  it('lists only what is still waiting, without codes', async () => {
    const waiting = await requestPairing(app(), { name: 'Listed' });
    const expired = await requestPairing(app(), { name: 'Expired' });
    await expire(expired.pairingCode);
    const response = await admin.get('/admin/agent-pairing/requests');
    const { requests } = pairingRequestListResponseSchema.parse(response.json());
    const names = requests.map((request) => request.name);
    expect(names).toContain('Listed');
    expect(names).not.toContain('Expired');
    expect(response.body).not.toContain(waiting.pairingCode);
    expect(response.body).not.toContain(waiting.pollingSecret);
  });
});

describe('approving', () => {
  it('pairs: the agent receives a credential, and only its digest is stored', async () => {
    const before = await count(context.pool, 'agents');
    const created = await requestPairing(app(), { name: 'Full flow' });
    expect(await poll(app(), created.pollingSecret)).toMatchObject({ status: 'pending' });

    const review = pairingRequestReviewSchema.parse(
      (await lookUp(admin, created.pairingCode)).json(),
    );
    const decided = await approve(admin, review.id, created.pairingCode);
    expect(decided.statusCode).toBe(200);
    expect(pairingRequestReviewSchema.parse(decided.json()).status).toBe('approved');
    expect(decided.body).not.toMatch(/credential/i);

    // No agent yet: one that never collects leaves nothing behind.
    expect(await count(context.pool, 'agents')).toBe(before);

    const result = await poll(app(), created.pollingSecret);
    if (result.status !== 'approved') throw new Error(result.status);
    expect(result.credential.length).toBeGreaterThanOrEqual(43);

    const row = await agentRow(context.pool, result.agentId);
    expect(row?.credential_hash).toEqual(hashToken(result.credential));
    expect(JSON.stringify(row)).not.toContain(result.credential);
    expect(row).toMatchObject({ name: 'Full flow', owner_user_id: adminId, revoked_at: null });
    expect(row?.paired_at).toBeInstanceOf(Date);

    const after = pairingRequestReviewSchema.parse(
      (await admin.get(`/admin/agent-pairing/requests/${review.id}`)).json(),
    );
    expect(after).toMatchObject({ status: 'completed', agentId: result.agentId });
  });

  it('delivers a credential exactly once', async () => {
    const created = await requestPairing(app());
    const review = (await lookUp(admin, created.pairingCode)).json<{ id: string }>();
    await approve(admin, review.id, created.pairingCode);
    expect((await poll(app(), created.pollingSecret)).status).toBe('approved');
    expect(await poll(app(), created.pollingSecret)).toEqual({ status: 'consumed' });
    expect(await poll(app(), created.pollingSecret)).toEqual({ status: 'consumed' });
  });

  it('gives each agent its own credential', async () => {
    const a = await pairAgent(app(), admin);
    const b = await pairAgent(app(), admin);
    expect(a.agentId).not.toBe(b.agentId);
    expect(a.credential).not.toBe(b.credential);
  });

  it('needs the right code, not merely the ID', async () => {
    const victim = await requestPairing(app());
    const other = await requestPairing(app());
    const review = (await lookUp(admin, victim.pairingCode)).json<{ id: string }>();
    for (const code of [other.pairingCode, 'ZZZZ-ZZZZ', 'nonsense']) {
      const response = await approve(admin, review.id, code);
      expect(response.statusCode).toBe(404);
      expect(errorCode(response.json())).toBe('pairing_code_invalid');
    }
    expect((await poll(app(), victim.pollingSecret)).status).toBe('pending');
  });

  it('cannot approve an expired request, and the agent is told', async () => {
    const created = await requestPairing(app());
    const review = (await lookUp(admin, created.pairingCode)).json<{ id: string }>();
    await expire(created.pairingCode);
    const response = await approve(admin, review.id, created.pairingCode);
    expect(response.statusCode).toBe(410);
    expect(errorCode(response.json())).toBe('pairing_expired');
    expect(await poll(app(), created.pollingSecret)).toEqual({ status: 'expired' });
  });

  it('expires by the clock, before any cleanup and without any status change', async () => {
    const created = await requestPairing(app());
    await expire(created.pairingCode);
    const [rows] = await context.pool.execute<RowDataPacket[]>(
      'SELECT status FROM agent_pairing_requests WHERE polling_secret_hash = ?',
      [hashToken(created.pollingSecret)],
    );
    expect(rows[0]?.status).toBe('pending');
    expect(await poll(app(), created.pollingSecret)).toEqual({ status: 'expired' });
  });

  it('issues nothing if an approved request expires before collection', async () => {
    const before = await count(context.pool, 'agents');
    const created = await requestPairing(app());
    const review = (await lookUp(admin, created.pairingCode)).json<{ id: string }>();
    await approve(admin, review.id, created.pairingCode);
    await expire(created.pairingCode);
    expect(await poll(app(), created.pollingSecret)).toEqual({ status: 'expired' });
    expect(await count(context.pool, 'agents')).toBe(before);
  });

  it('leaves the agent time to collect after a last-moment approval', async () => {
    const created = await requestPairing(app());
    const review = (await lookUp(admin, created.pairingCode)).json<{ id: string }>();
    await context.pool.execute(
      `UPDATE agent_pairing_requests SET expires_at = UTC_TIMESTAMP(3) + INTERVAL 1 SECOND
       WHERE id = ?`,
      [review.id],
    );
    const decided = await approve(admin, review.id, created.pairingCode);
    const { expiresAt } = pairingRequestReviewSchema.parse(decided.json());
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it('answers 404 for a request that does not exist', async () => {
    const response = await approve(admin, UNKNOWN_ID, 'ABCD-2345');
    expect(response.statusCode).toBe(404);
  });
});

describe('rejecting', () => {
  it('tells the agent, issues nothing, and cannot be undone', async () => {
    const before = await count(context.pool, 'agents');
    const created = await requestPairing(app());
    const review = (await lookUp(admin, created.pairingCode)).json<{ id: string }>();
    const response = await reject(admin, review.id);
    expect(response.statusCode).toBe(200);
    expect(pairingRequestReviewSchema.parse(response.json()).status).toBe('rejected');
    expect(await poll(app(), created.pollingSecret)).toEqual({ status: 'rejected' });
    expect(await count(context.pool, 'agents')).toBe(before);

    const again = await approve(admin, review.id, created.pairingCode);
    expect(again.statusCode).toBe(409);
    expect(errorCode(again.json())).toBe('pairing_already_decided');
    expect((await lookUp(admin, created.pairingCode)).statusCode).toBe(409);
  });

  it('needs no code, since refusing grants nothing', async () => {
    const created = await requestPairing(app(), { name: 'Unwanted' });
    const { requests } = pairingRequestListResponseSchema.parse(
      (await admin.get('/admin/agent-pairing/requests')).json(),
    );
    const listed = requests.find((request) => request.name === 'Unwanted');
    expect((await reject(admin, listed?.id as string)).statusCode).toBe(200);
    expect(await poll(app(), created.pollingSecret)).toEqual({ status: 'rejected' });
  });

  it('cannot reject what was already approved', async () => {
    const created = await requestPairing(app());
    const review = (await lookUp(admin, created.pairingCode)).json<{ id: string }>();
    await approve(admin, review.id, created.pairingCode);
    expect((await reject(admin, review.id)).statusCode).toBe(409);
    expect((await poll(app(), created.pollingSecret)).status).toBe('approved');
  });
});

describe('races', () => {
  it('lets one of many concurrent approvals win', async () => {
    const created = await requestPairing(app());
    const review = (await lookUp(admin, created.pairingCode)).json<{ id: string }>();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => approve(admin, review.id, created.pairingCode)),
    );
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
  });

  it('issues exactly one credential to many concurrent polls', async () => {
    const before = await count(context.pool, 'agents');
    const created = await requestPairing(app());
    const review = (await lookUp(admin, created.pairingCode)).json<{ id: string }>();
    await approve(admin, review.id, created.pairingCode);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => poll(app(), created.pollingSecret)),
    );
    const approved = results.filter((result) => result.status === 'approved');
    expect(approved).toHaveLength(1);
    expect(results.filter((result) => result.status === 'consumed')).toHaveLength(7);
    expect(await count(context.pool, 'agents')).toBe(before + 1);
  });

  it('settles a race between approval and rejection on one outcome', async () => {
    for (let round = 0; round < 5; round += 1) {
      const created = await requestPairing(app());
      const review = (await lookUp(admin, created.pairingCode)).json<{ id: string }>();
      const [approval, rejection] = await Promise.all([
        approve(admin, review.id, created.pairingCode),
        reject(admin, review.id),
      ]);
      const outcomes = [approval.statusCode, rejection.statusCode].sort();
      expect(outcomes).toEqual([200, 409]);
      const result = await poll(app(), created.pollingSecret);
      expect(result.status).toBe(approval.statusCode === 200 ? 'approved' : 'rejected');
    }
  });

  it('never gives both a credential and an expiry when polling races approval', async () => {
    const created = await requestPairing(app());
    const review = (await lookUp(admin, created.pairingCode)).json<{ id: string }>();
    const [polled, decided] = await Promise.all([
      poll(app(), created.pollingSecret),
      approve(admin, review.id, created.pairingCode),
    ]);
    expect(decided.statusCode).toBe(200);
    expect(['pending', 'approved']).toContain(polled.status);
    const after = await poll(app(), created.pollingSecret);
    expect(
      polled.status === 'approved' ? after.status === 'consumed' : after.status === 'approved',
    ).toBe(true);
  });
});

describe('polling', () => {
  it.each(['Bearer', 'Basic abc', 'Bearer short', ''])('refuses the header %j', async (header) => {
    const response = await app().inject({
      method: 'POST',
      url: '/api/v1/agent/pairing/poll',
      headers: { host: HOST, ...(header ? { authorization: header } : {}) },
    });
    expect(response.statusCode).toBe(401);
    expect(errorCode(response.json())).toBe('invalid_pairing_secret');
  });

  it('refuses a secret it does not know', async () => {
    const response = await pollRaw(app(), `emucat_pairing_${'x'.repeat(43)}`);
    expect(response.statusCode).toBe(401);
  });

  it('does not accept the code as a secret', async () => {
    const created = await requestPairing(app());
    const response = await pollRaw(app(), `${created.pairingCode}-${created.pairingCode}`);
    expect(response.statusCode).toBe(401);
  });
});

describe('authorization', () => {
  let regularUser: TestClient;

  beforeAll(async () => {
    await context.pool.execute(
      `INSERT INTO users (id, username, display_name, password_hash, role)
       VALUES (UUID(), 'regular-agents', 'Regular', ?, 'user')`,
      [await context.dependencies.passwords.hash(ADMIN_PASSWORD)],
    );
    regularUser = new TestClient(context.app);
    expect((await regularUser.login('regular-agents', ADMIN_PASSWORD)).statusCode).toBe(200);
  });

  const ROUTES: [method: 'GET' | 'POST', url: string, payload?: object][] = [
    ['GET', '/admin/agents'],
    ['GET', `/admin/agents/${UNKNOWN_ID}`],
    ['POST', `/admin/agents/${UNKNOWN_ID}/revoke`],
    ['GET', `/admin/agents/${UNKNOWN_ID}/discovery`],
    ['POST', `/admin/agents/${UNKNOWN_ID}/discovery`],
    ['GET', '/admin/agent-pairing/requests'],
    ['GET', `/admin/agent-pairing/requests/${UNKNOWN_ID}`],
    ['POST', '/admin/agent-pairing/lookup', { code: 'ABCD-2345' }],
    ['POST', `/admin/agent-pairing/requests/${UNKNOWN_ID}/approve`, { code: 'ABCD-2345' }],
    ['POST', `/admin/agent-pairing/requests/${UNKNOWN_ID}/reject`],
  ];

  it.each(ROUTES)('%s %s requires a session', async (method, url, payload) => {
    const response = await new TestClient(context.app).request({
      method,
      url,
      ...(payload ? { payload } : {}),
    });
    expect(response.statusCode).toBe(401);
    expect(errorCode(response.json())).toBe('unauthenticated');
  });

  it.each(ROUTES)('%s %s requires the administrator role', async (method, url, payload) => {
    const response = await regularUser.request({ method, url, ...(payload ? { payload } : {}) });
    expect(response.statusCode).toBe(403);
    expect(errorCode(response.json())).toBe('forbidden');
  });

  it.each(ROUTES.filter(([method]) => method !== 'GET'))(
    '%s %s requires the CSRF token',
    async (method, url, payload) => {
      const response = await admin.request({
        method,
        url,
        csrf: false,
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode).toBe(403);
      expect(errorCode(response.json())).toBe('csrf_rejected');
    },
  );

  it.each(ROUTES.filter(([method]) => method !== 'GET'))(
    '%s %s refuses another origin, even with the token',
    async (method, url, payload) => {
      const response = await admin.request({
        method,
        url,
        headers: { origin: 'https://evil.example' },
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode).toBe(403);
      expect(errorCode(response.json())).toBe('cross_origin_rejected');
    },
  );

  it('accepts the same origin', async () => {
    const created = await requestPairing(app());
    const response = await admin.request({
      method: 'POST',
      url: '/admin/agent-pairing/lookup',
      headers: { origin: ORIGIN },
      payload: { code: created.pairingCode },
    });
    expect(response.statusCode).toBe(200);
  });

  it('cannot be approved by the code alone', async () => {
    const created = await requestPairing(app());
    const review = (await lookUp(admin, created.pairingCode)).json<{ id: string }>();
    const response = await app().inject({
      method: 'POST',
      url: `/api/v1/admin/agent-pairing/requests/${review.id}/approve`,
      headers: { host: HOST },
      payload: { code: created.pairingCode },
    });
    expect(response.statusCode).toBe(401);
    expect((await poll(app(), created.pollingSecret)).status).toBe('pending');
  });

  it('marks responses as uncacheable', async () => {
    expect((await admin.get('/admin/agents')).headers['cache-control']).toBe('no-store');
  });
});

describe('listing and revoking agents', () => {
  it('lists agents and exposes no credential material', async () => {
    const paired = await pairAgent(app(), admin, { name: 'Listed agent' });
    const list = await admin.get('/admin/agents');
    const { agents } = agentListResponseSchema.parse(list.json());
    expect(agents.find((agent) => agent.id === paired.agentId)).toMatchObject({
      name: 'Listed agent',
      platform: 'windows',
      architecture: 'x86_64',
      agentVersion: '0.1.0',
      pairingStatus: 'paired',
      online: false,
      lastSeenAt: null,
      ownerDisplayName: 'The Admin',
    });
    expect(list.body).not.toContain(paired.credential);
    expect(list.body).not.toMatch(/credential|hash|secret/i);

    const detail = await admin.get(`/admin/agents/${paired.agentId}`);
    expect(agentSummarySchema.parse(detail.json()).id).toBe(paired.agentId);
    expect(detail.body).not.toMatch(/credential|hash|secret/i);
  });

  it('answers 404 for an agent that does not exist, 400 for one that cannot', async () => {
    expect((await admin.get(`/admin/agents/${UNKNOWN_ID}`)).statusCode).toBe(404);
    expect((await admin.get('/admin/agents/not-a-uuid')).statusCode).toBe(400);
    const revoke = await admin.request({
      method: 'POST',
      url: `/admin/agents/${UNKNOWN_ID}/revoke`,
    });
    expect(revoke.statusCode).toBe(404);
  });

  it('revokes: invalidates the credential and keeps the record', async () => {
    const paired = await pairAgent(app(), admin, { name: 'To revoke' });
    const authenticate = (await import('../src/auth/agent-auth.js')).databaseAgentAuthenticator(
      context.pool,
    );
    await expect(authenticate(paired.credential)).resolves.toEqual({ agentId: paired.agentId });

    const response = await admin.request({
      method: 'POST',
      url: `/admin/agents/${paired.agentId}/revoke`,
    });
    expect(response.statusCode).toBe(200);
    expect(agentSummarySchema.parse(response.json())).toMatchObject({
      pairingStatus: 'revoked',
      online: false,
      name: 'To revoke',
    });

    await expect(authenticate(paired.credential)).resolves.toBeNull();
    const row = await agentRow(context.pool, paired.agentId);
    expect(row?.credential_hash).toBeNull();
    expect(row?.revoked_at).toBeInstanceOf(Date);
  });

  it('keeps catalog history that refers to a revoked agent', async () => {
    const paired = await pairAgent(app(), admin);
    await context.pool.execute(
      `INSERT INTO virtual_machines (emulator_type, vm_name, discovered_by_agent_id)
       VALUES ('qemu', 'HistoryVm', ?)`,
      [paired.agentId],
    );
    await admin.request({ method: 'POST', url: `/admin/agents/${paired.agentId}/revoke` });
    const [rows] = await context.pool.execute<RowDataPacket[]>(
      "SELECT discovered_by_agent_id AS agent FROM virtual_machines WHERE vm_name = 'HistoryVm'",
    );
    expect(rows[0]?.agent).toBe(paired.agentId);
  });

  it('is safe to repeat', async () => {
    const paired = await pairAgent(app(), admin);
    const first = await admin.request({
      method: 'POST',
      url: `/admin/agents/${paired.agentId}/revoke`,
    });
    const second = await admin.request({
      method: 'POST',
      url: `/admin/agents/${paired.agentId}/revoke`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ revokedAt: string }>().revokedAt).toBe(
      first.json<{ revokedAt: string }>().revokedAt,
    );
  });

  it('re-pairing is an explicit new pairing, with a new identity', async () => {
    const original = await pairAgent(app(), admin, { name: 'Machine' });
    await admin.request({ method: 'POST', url: `/admin/agents/${original.agentId}/revoke` });

    const again = await pairAgent(app(), admin, { name: 'Machine' });
    expect(again.agentId).not.toBe(original.agentId);
    expect(again.credential).not.toBe(original.credential);

    const old = await agentRow(context.pool, original.agentId);
    expect(old?.revoked_at).toBeInstanceOf(Date);
    const fresh = await agentRow(context.pool, again.agentId);
    expect(fresh?.revoked_at).toBeNull();
  });

  it('does nothing to the catalog at all', async () => {
    const before = [
      await count(context.pool, 'virtual_machines'),
      await count(context.pool, 'vm_versions'),
    ];
    await pairAgent(app(), admin);
    expect([
      await count(context.pool, 'virtual_machines'),
      await count(context.pool, 'vm_versions'),
    ]).toEqual(before);
  });
});

describe('rate limits and capacity', () => {
  let limited: BrowserTestContext | undefined;

  afterEach(async () => {
    await limited?.close();
    limited = undefined;
  });

  const rule = (maxAttempts: number) => ({ maxAttempts, windowSeconds: 600 });

  it('limits new requests per address', async () => {
    limited = await startBrowserApp({
      limiter: new RateLimiter(),
      pairingRateLimits: { ...GENEROUS_RATE_LIMITS, createPerAddress: rule(2) },
    });
    await requestPairing(limited.app);
    await requestPairing(limited.app);
    const response = await limited.app.inject({
      method: 'POST',
      url: '/api/v1/agent/pairing/requests',
      headers: { host: HOST },
      payload: AGENT_DETAILS,
    });
    expect(response.statusCode).toBe(429);
    expect(errorCode(response.json())).toBe('rate_limited');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('limits wrong codes per session, and a burst cannot get around it', async () => {
    limited = await startBrowserApp({
      limiter: new RateLimiter(),
      pairingRateLimits: { ...GENEROUS_RATE_LIMITS, codeAttemptsPerSession: rule(3) },
    });
    const client = await signedInAdmin(limited);
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => lookUp(client, 'ZZZZ-ZZZZ')),
    );
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses.filter((status) => status === 404)).toHaveLength(3);
    expect(statuses.filter((status) => status === 429)).toHaveLength(7);
  });

  it('does not count correct codes against the limit', async () => {
    limited = await startBrowserApp({
      limiter: new RateLimiter(),
      pairingRateLimits: { ...GENEROUS_RATE_LIMITS, codeAttemptsPerSession: rule(2) },
    });
    const client = await signedInAdmin(limited);
    for (let index = 0; index < 5; index += 1) {
      const { pairingCode } = await requestPairing(limited.app);
      expect((await lookUp(client, pairingCode)).statusCode).toBe(200);
    }
  });

  it('counts wrong codes on approval too', async () => {
    limited = await startBrowserApp({
      limiter: new RateLimiter(),
      pairingRateLimits: { ...GENEROUS_RATE_LIMITS, codeAttemptsPerSession: rule(2) },
    });
    const client = await signedInAdmin(limited);
    const created = await requestPairing(limited.app);
    const review = (await lookUp(client, created.pairingCode)).json<{ id: string }>();
    expect((await approve(client, review.id, 'ZZZZ-ZZZZ')).statusCode).toBe(404);
    expect((await approve(client, review.id, 'ZZZZ-ZZZZ')).statusCode).toBe(404);
    expect((await approve(client, review.id, created.pairingCode)).statusCode).toBe(429);
  });

  it('limits guesses at a polling secret per address, not valid polls', async () => {
    limited = await startBrowserApp({
      limiter: new RateLimiter(),
      pairingRateLimits: { ...GENEROUS_RATE_LIMITS, invalidPollPerAddress: rule(2) },
    });
    const created = await requestPairing(limited.app);
    for (let index = 0; index < 5; index += 1) {
      expect((await pollRaw(limited.app, created.pollingSecret)).statusCode).toBe(200);
    }
    const guess = `emucat_pairing_${'x'.repeat(43)}`;
    expect((await pollRaw(limited.app, guess)).statusCode).toBe(401);
    expect((await pollRaw(limited.app, guess)).statusCode).toBe(401);
    expect((await pollRaw(limited.app, guess)).statusCode).toBe(429);
  });

  it('limits how often one request can be polled, and loses no credential to it', async () => {
    limited = await startBrowserApp({
      limiter: new RateLimiter(),
      pairingRateLimits: { ...GENEROUS_RATE_LIMITS, pollPerRequest: rule(2) },
    });
    const client = await signedInAdmin(limited);
    const created = await requestPairing(limited.app);
    await poll(limited.app, created.pollingSecret);
    await poll(limited.app, created.pollingSecret);
    const review = (await lookUp(client, created.pairingCode)).json<{ id: string }>();
    await approve(client, review.id, created.pairingCode);
    expect((await pollRaw(limited.app, created.pollingSecret)).statusCode).toBe(429);
    const [rows] = await limited.pool.execute<RowDataPacket[]>(
      'SELECT status FROM agent_pairing_requests WHERE id = ?',
      [review.id],
    );
    expect(rows[0]?.status).toBe('approved');
  });

  it('caps how many requests can wait at once', async () => {
    limited = await startBrowserApp({
      pairingRateLimits: GENEROUS_RATE_LIMITS,
      pairing: {
        requestTtlSeconds: 600,
        collectionTtlSeconds: 120,
        pollIntervalSeconds: 3,
        maxPendingRequests: 2,
      },
    });
    await requestPairing(limited.app);
    await requestPairing(limited.app);
    const response = await limited.app.inject({
      method: 'POST',
      url: '/api/v1/agent/pairing/requests',
      headers: { host: HOST },
      payload: AGENT_DETAILS,
    });
    expect(response.statusCode).toBe(429);
    expect(errorCode(response.json())).toBe('pairing_capacity');
  });
});

describe('logging', () => {
  it('never logs a code, a polling secret or a credential', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logged = await startBrowserApp(
      { pairingRateLimits: GENEROUS_RATE_LIMITS },
      {
        logger: {
          level: 'trace',
          stream,
          redact: ['req.headers.authorization', 'req.headers.cookie'],
        },
      },
    );
    try {
      const client = await signedInAdmin(logged);
      const created = await requestPairing(logged.app);
      const review = (await lookUp(client, created.pairingCode)).json<{ id: string }>();
      await approve(client, review.id, created.pairingCode);
      const result = await poll(logged.app, created.pollingSecret);
      if (result.status !== 'approved') throw new Error(result.status);
      await client.request({ method: 'POST', url: `/admin/agents/${result.agentId}/revoke` });

      const all = lines.join('');
      expect(all.length).toBeGreaterThan(0);
      expect(all).toContain('Pairing request approved');
      expect(all).not.toContain(created.pollingSecret);
      expect(all).not.toContain(result.credential);
      expect(all).not.toContain(created.pairingCode);
      expect(all).not.toContain(normalizePairingCode(created.pairingCode));
    } finally {
      await logged.close();
    }
  });
});
