import {
  authenticatedSessionSchema,
  errorResponseSchema,
  sessionListResponseSchema,
  sessionStateResponseSchema,
} from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/auth/agent-auth.js';
import { csrfTokenFor } from '../src/auth/sessions.js';
import { DEFAULT_AUTH_RATE_LIMITS } from '../src/routes/auth.js';
import {
  ADMIN_PASSWORD,
  HOST,
  ORIGIN,
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from './browser-app.js';

let context: BrowserTestContext;
let admin: TestClient;

async function freshClient(): Promise<TestClient> {
  const client = new TestClient(context.app);
  const response = await client.login('admin', ADMIN_PASSWORD);
  expect(response.statusCode).toBe(200);
  return client;
}

describe('with an administrator', () => {
  beforeAll(async () => {
    context = await startBrowserApp();
    admin = await signedInAdmin(context);
  });

  afterAll(async () => {
    await context.close();
  });

  describe('sign-in', () => {
    it('signs in with the right password and sets a protected cookie', async () => {
      const client = new TestClient(context.app);
      const response = await client.login('admin', ADMIN_PASSWORD);
      expect(response.statusCode).toBe(200);
      const session = authenticatedSessionSchema.parse(response.json());
      expect(session.user.username).toBe('admin');

      const cookie = response.cookies.find((item) => item.name === 'emucat_session');
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
      expect(cookie?.maxAge).toBe(7200);
      expect(cookie?.secure).toBeUndefined();
      expect(response.body).not.toContain(cookie?.value);
      expect(response.body).not.toMatch(/password|hash/i);
    });

    it('treats the username case-insensitively', async () => {
      expect((await new TestClient(context.app).login('ADMIN', ADMIN_PASSWORD)).statusCode).toBe(
        200,
      );
    });

    it('gives the same answer for every kind of wrong credentials', async () => {
      await context.pool.execute(
        `INSERT INTO users (id, username, display_name, password_hash, role, disabled_at)
         VALUES (UUID(), 'disabled', 'Disabled', ?, 'admin', UTC_TIMESTAMP(3))`,
        [await context.dependencies.passwords.hash(ADMIN_PASSWORD)],
      );
      const attempts = await Promise.all([
        new TestClient(context.app).login('admin', 'wrong password here'),
        new TestClient(context.app).login('nobody', 'wrong password here'),
        new TestClient(context.app).login('disabled', ADMIN_PASSWORD),
        new TestClient(context.app).login("admin' OR '1'='1", ADMIN_PASSWORD),
        new TestClient(context.app).login('adm', ADMIN_PASSWORD),
      ]);
      for (const response of attempts) {
        expect(response.statusCode).toBe(401);
        const { error } = errorResponseSchema.parse(response.json());
        expect(error.code).toBe('invalid_credentials');
        expect(error.message).toBe('Invalid username or password');
        expect(response.cookies).toEqual([]);
      }
    });

    it('does the password work for unknown users too', async () => {
      const dummy = vi.spyOn(context.dependencies.passwords, 'verifyAgainstDummy');
      await new TestClient(context.app).login('nobody', 'wrong password here');
      expect(dummy).toHaveBeenCalledOnce();
      dummy.mockRestore();
    });

    it('does not let a malformed stored hash in', async () => {
      await context.pool.execute(
        `INSERT INTO users (id, username, display_name, password_hash, role)
         VALUES (UUID(), 'brokenhash', 'Broken', 'not-a-hash', 'admin')`,
      );
      const response = await new TestClient(context.app).login('brokenhash', 'not-a-hash');
      expect(response.statusCode).toBe(401);
    });

    it.each([
      ['an object', { username: { $ne: null }, password: 'x' }],
      ['a missing password', { username: 'admin' }],
      ['an extra field', { username: 'admin', password: 'x', role: 'admin' }],
    ])('rejects %s without trying the credentials', async (_name, payload) => {
      const response = await new TestClient(context.app).request({
        method: 'POST',
        url: '/auth/login',
        payload,
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a body that is not JSON, as a cross-site form would send', async () => {
      const response = await new TestClient(context.app).request({
        method: 'POST',
        url: '/auth/login',
        headers: { 'content-type': 'text/plain' },
        payload: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
      });
      expect(response.statusCode).toBe(400);
      expect(response.cookies).toEqual([]);
    });

    it('stores only a digest of the session token', async () => {
      const client = await freshClient();
      const token = client.cookie as string;
      const [rows] = await context.pool.query<RowDataPacket[]>(
        'SELECT token_hash FROM user_sessions',
      );
      const digests = rows.map((row) => (row.token_hash as Buffer).toString('hex'));
      expect(digests).toContain(hashToken(token).toString('hex'));
      expect(digests).not.toContain(Buffer.from(token).toString('hex'));
      expect(token.length).toBeGreaterThanOrEqual(43);
    });

    it('issues a new token and revokes a token presented at sign-in', async () => {
      const client = await freshClient();
      const planted = client.cookie as string;
      await client.login('admin', ADMIN_PASSWORD);
      expect(client.cookie).not.toBe(planted);
      const reused = new TestClient(context.app);
      reused.cookie = planted;
      expect((await reused.get('/auth/me')).statusCode).toBe(401);
    });

    it('keeps tokens out of error messages and headers other than Set-Cookie', async () => {
      const client = await freshClient();
      const response = await client.get('/auth/me');
      expect(response.body).not.toContain(client.cookie as string);
    });
  });

  describe('current user', () => {
    it('requires a session', async () => {
      const response = await new TestClient(context.app).get('/auth/me');
      expect(response.statusCode).toBe(401);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('unauthenticated');
    });

    it('returns the user without any secret fields', async () => {
      const response = await admin.get('/auth/me');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.json<{ user: Record<string, unknown> }>();
      expect(Object.keys(body.user).sort()).toEqual(['displayName', 'id', 'role', 'username']);
    });

    it('reports anonymous visitors without an error, for the web app', async () => {
      const response = await new TestClient(context.app).get('/auth/session');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ session: null });
    });

    it('reports a signed-in user on the same route', async () => {
      const state = sessionStateResponseSchema.parse((await admin.get('/auth/session')).json());
      expect(state.session?.user.username).toBe('admin');
    });

    it.each(['not-a-real-token', '', 'a'.repeat(5000), "' OR 1=1 --"])(
      'rejects the cookie %j',
      async (value) => {
        const client = new TestClient(context.app);
        client.cookie = value;
        expect((await client.get('/auth/me')).statusCode).toBe(401);
      },
    );
  });

  describe('sign-out', () => {
    it('revokes the session and clears the cookie', async () => {
      const client = await freshClient();
      const token = client.cookie as string;
      const response = await client.request({ method: 'POST', url: '/auth/logout' });
      expect(response.statusCode).toBe(204);
      expect(client.cookie).toBeUndefined();

      const replay = new TestClient(context.app);
      replay.cookie = token;
      expect((await replay.get('/auth/me')).statusCode).toBe(401);

      const [rows] = await context.pool.execute<RowDataPacket[]>(
        'SELECT revoked_at FROM user_sessions WHERE token_hash = ?',
        [hashToken(token)],
      );
      expect(rows[0]?.revoked_at).toBeInstanceOf(Date);
    });

    it('requires the CSRF token', async () => {
      const client = await freshClient();
      const response = await client.request({ method: 'POST', url: '/auth/logout', csrf: false });
      expect(response.statusCode).toBe(403);
      expect((await client.get('/auth/me')).statusCode).toBe(200);
    });
  });

  describe('expiry', () => {
    async function setTimes(token: string, sql: string) {
      await context.pool.execute(`UPDATE user_sessions SET ${sql} WHERE token_hash = ?`, [
        hashToken(token),
      ]);
    }

    it('rejects a session past its expiry, and clears the cookie', async () => {
      const client = await freshClient();
      await setTimes(client.cookie as string, 'expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND');
      const response = await client.get('/auth/me');
      expect(response.statusCode).toBe(401);
      expect(client.cookie).toBeUndefined();
    });

    it('accepts a session until then', async () => {
      const client = await freshClient();
      await setTimes(client.cookie as string, 'expires_at = UTC_TIMESTAMP(3) + INTERVAL 5 SECOND');
      expect((await client.get('/auth/me')).statusCode).toBe(200);
    });

    it('extends an active session by the idle limit', async () => {
      const client = await freshClient();
      await setTimes(
        client.cookie as string,
        `last_seen_at = UTC_TIMESTAMP(3) - INTERVAL 10 MINUTE,
         expires_at = UTC_TIMESTAMP(3) + INTERVAL 10 MINUTE`,
      );
      await client.get('/auth/me');
      const [rows] = await context.pool.execute<RowDataPacket[]>(
        `SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), expires_at) AS remaining,
                TIMESTAMPDIFF(SECOND, last_seen_at, UTC_TIMESTAMP(3)) AS idle
         FROM user_sessions WHERE token_hash = ?`,
        [hashToken(client.cookie as string)],
      );
      expect(Number(rows[0]?.remaining)).toBeGreaterThan(3500);
      expect(Number(rows[0]?.remaining)).toBeLessThanOrEqual(3600);
      expect(Number(rows[0]?.idle)).toBeLessThan(5);
    });

    it('never extends a session past the absolute limit', async () => {
      const client = await freshClient();
      await setTimes(
        client.cookie as string,
        `created_at = UTC_TIMESTAMP(3) - INTERVAL 7190 SECOND,
         last_seen_at = UTC_TIMESTAMP(3) - INTERVAL 10 MINUTE`,
      );
      await client.get('/auth/me');
      const [rows] = await context.pool.execute<RowDataPacket[]>(
        `SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), expires_at) AS remaining
         FROM user_sessions WHERE token_hash = ?`,
        [hashToken(client.cookie as string)],
      );
      expect(Number(rows[0]?.remaining)).toBeLessThanOrEqual(10);
    });

    it('does not write on every request', async () => {
      const client = await freshClient();
      await setTimes(client.cookie as string, 'expires_at = UTC_TIMESTAMP(3) + INTERVAL 99 SECOND');
      await client.get('/auth/me');
      const [rows] = await context.pool.execute<RowDataPacket[]>(
        `SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), expires_at) AS remaining
         FROM user_sessions WHERE token_hash = ?`,
        [hashToken(client.cookie as string)],
      );
      expect(Number(rows[0]?.remaining)).toBeLessThan(100);
    });

    it('purges long-dead sessions at the next sign-in', async () => {
      const client = await freshClient();
      const token = client.cookie as string;
      await setTimes(token, 'expires_at = UTC_TIMESTAMP(3) - INTERVAL 31 DAY');
      await new TestClient(context.app).login('admin', ADMIN_PASSWORD);
      const [rows] = await context.pool.execute<RowDataPacket[]>(
        'SELECT 1 FROM user_sessions WHERE token_hash = ?',
        [hashToken(token)],
      );
      expect(rows).toEqual([]);
    });

    it('rejects a session once its user is disabled', async () => {
      const username = 'tobedisabled';
      await context.pool.execute(
        `INSERT INTO users (id, username, display_name, password_hash, role)
         VALUES (UUID(), ?, 'X', ?, 'admin')`,
        [username, await context.dependencies.passwords.hash(ADMIN_PASSWORD)],
      );
      const client = new TestClient(context.app);
      expect((await client.login(username, ADMIN_PASSWORD)).statusCode).toBe(200);
      await context.pool.execute(
        'UPDATE users SET disabled_at = UTC_TIMESTAMP(3) WHERE username = ?',
        [username],
      );
      expect((await client.get('/auth/me')).statusCode).toBe(401);
    });
  });

  describe('session management', () => {
    it('lists the active sessions and marks the current one', async () => {
      const client = await freshClient();
      const { sessions } = sessionListResponseSchema.parse(
        (await client.get('/account/sessions')).json(),
      );
      expect(sessions.filter((session) => session.current)).toHaveLength(1);
      expect(Object.keys(sessions[0] ?? {}).sort()).toEqual(
        ['createdAt', 'current', 'expiresAt', 'id', 'lastSeenAt'].sort(),
      );
    });

    it('revokes another session', async () => {
      const client = await freshClient();
      const other = await freshClient();
      const { sessions } = sessionListResponseSchema.parse(
        (await other.get('/account/sessions')).json(),
      );
      const current = sessions.find((session) => session.current);
      const response = await client.request({
        method: 'DELETE',
        url: `/account/sessions/${current?.id}`,
      });
      expect(response.statusCode).toBe(204);
      expect((await other.get('/auth/me')).statusCode).toBe(401);
      expect((await client.get('/auth/me')).statusCode).toBe(200);
    });

    it('revoking the current session signs out', async () => {
      const client = await freshClient();
      const { sessionId } = authenticatedSessionSchema.parse((await client.get('/auth/me')).json());
      await client.request({ method: 'DELETE', url: `/account/sessions/${sessionId}` });
      expect(client.cookie).toBeUndefined();
    });

    it('revokes all the others at once', async () => {
      const client = await freshClient();
      const other = await freshClient();
      const response = await client.request({
        method: 'POST',
        url: '/account/sessions/revoke-others',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ revoked: number }>().revoked).toBeGreaterThan(0);
      expect((await other.get('/auth/me')).statusCode).toBe(401);
      expect((await client.get('/auth/me')).statusCode).toBe(200);
    });

    it('cannot reach another user’s session', async () => {
      await context.pool.execute(
        `INSERT INTO users (id, username, display_name, password_hash, role)
         VALUES (UUID(), 'someoneelse', 'X', ?, 'admin')`,
        [await context.dependencies.passwords.hash(ADMIN_PASSWORD)],
      );
      const victim = new TestClient(context.app);
      await victim.login('someoneelse', ADMIN_PASSWORD);
      const { sessionId } = authenticatedSessionSchema.parse((await victim.get('/auth/me')).json());

      const client = await freshClient();
      const response = await client.request({
        method: 'DELETE',
        url: `/account/sessions/${sessionId}`,
      });
      expect(response.statusCode).toBe(404);
      expect((await victim.get('/auth/me')).statusCode).toBe(200);
    });

    it('rejects a malformed session id', async () => {
      const client = await freshClient();
      const response = await client.request({
        method: 'DELETE',
        url: "/account/sessions/'%20OR%201=1",
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('CSRF', () => {
    const logout = { method: 'POST', url: '/auth/logout' } as const;

    it('rejects a state-changing request with no token', async () => {
      const client = await freshClient();
      const response = await client.request({ ...logout, csrf: false });
      expect(response.statusCode).toBe(403);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('csrf_rejected');
    });

    it('rejects a wrong token', async () => {
      const client = await freshClient();
      expect((await client.request({ ...logout, csrf: 'wrong' })).statusCode).toBe(403);
    });

    it('rejects a token that belongs to another session', async () => {
      const client = await freshClient();
      const other = await freshClient();
      expect(
        (await client.request({ ...logout, csrf: other.csrfToken as string })).statusCode,
      ).toBe(403);
    });

    it('rejects the session token used as a CSRF token', async () => {
      const client = await freshClient();
      expect((await client.request({ ...logout, csrf: client.cookie as string })).statusCode).toBe(
        403,
      );
    });

    it('derives the token so that it does not reveal the session token', () => {
      const token = csrfTokenFor('session-token');
      expect(token).not.toContain('session-token');
      expect(token).toBe(csrfTokenFor('session-token'));
      expect(token).not.toBe(csrfTokenFor('another-session-token'));
    });

    it.each([
      ['another origin', { origin: 'https://evil.example' }],
      ['the null origin', { origin: 'null' }],
      ['a malformed origin', { origin: 'not a url' }],
      ['a look-alike origin', { origin: `http://${HOST}.evil.example` }],
      ['fetch metadata saying cross-site', { 'sec-fetch-site': 'cross-site' }],
      ['fetch metadata saying same-site', { 'sec-fetch-site': 'same-site' }],
    ])('rejects %s even with a valid token', async (_name, headers) => {
      const client = await freshClient();
      const response = await client.request({ ...logout, headers });
      expect(response.statusCode).toBe(403);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('cross_origin_rejected');
      expect((await client.get('/auth/me')).statusCode).toBe(200);
    });

    it('accepts the same origin', async () => {
      const client = await freshClient();
      const response = await client.request({
        ...logout,
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      });
      expect(response.statusCode).toBe(204);
    });

    it('protects sign-in from cross-site requests', async () => {
      const response = await new TestClient(context.app).request({
        method: 'POST',
        url: '/auth/login',
        headers: { origin: 'https://evil.example' },
        payload: { username: 'admin', password: ADMIN_PASSWORD },
      });
      expect(response.statusCode).toBe(403);
      expect(response.cookies).toEqual([]);
    });

    it('does not need a token for reads', async () => {
      const client = await freshClient();
      expect(
        (await client.request({ method: 'GET', url: '/auth/me', csrf: false })).statusCode,
      ).toBe(200);
    });

    it('answers 401, not 400, to an anonymous request with a bad body', async () => {
      const response = await new TestClient(context.app).request({
        method: 'POST',
        url: '/account/password',
        payload: { nonsense: true },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('changing the password', () => {
    const NEW_PASSWORD = 'a completely new passphrase';

    afterEach(async () => {
      // Put it back through the API, so that each test starts from the known password.
      const client = new TestClient(context.app);
      if ((await client.login('admin', NEW_PASSWORD)).statusCode === 200) {
        await client.request({
          method: 'POST',
          url: '/account/password',
          payload: { currentPassword: NEW_PASSWORD, newPassword: ADMIN_PASSWORD },
        });
      }
      admin = await freshClient();
    });

    it('requires the current password', async () => {
      const client = await freshClient();
      const response = await client.request({
        method: 'POST',
        url: '/account/password',
        payload: { currentPassword: 'wrong wrong wrong', newPassword: NEW_PASSWORD },
      });
      expect(response.statusCode).toBe(403);
      expect((await new TestClient(context.app).login('admin', NEW_PASSWORD)).statusCode).toBe(401);
      expect((await client.get('/auth/me')).statusCode).toBe(200);
    });

    it('enforces the password rules', async () => {
      const client = await freshClient();
      const response = await client.request({
        method: 'POST',
        url: '/account/password',
        payload: { currentPassword: ADMIN_PASSWORD, newPassword: 'short' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('changes it, and revokes every other session', async () => {
      const client = await freshClient();
      const other = await freshClient();
      const response = await client.request({
        method: 'POST',
        url: '/account/password',
        payload: { currentPassword: ADMIN_PASSWORD, newPassword: NEW_PASSWORD },
      });
      expect(response.statusCode).toBe(200);
      expect((await other.get('/auth/me')).statusCode).toBe(401);
      expect((await client.get('/auth/me')).statusCode).toBe(200);
      expect((await new TestClient(context.app).login('admin', ADMIN_PASSWORD)).statusCode).toBe(
        401,
      );
      expect((await new TestClient(context.app).login('admin', NEW_PASSWORD)).statusCode).toBe(200);
    });
  });
});

describe('rate limiting', () => {
  beforeEach(async () => {
    context = await startBrowserApp({
      rateLimits: {
        ...DEFAULT_AUTH_RATE_LIMITS,
        loginPerAddress: { maxAttempts: 3, windowSeconds: 60 },
      },
    });
    admin = await signedInAdmin(context);
  });

  afterEach(async () => {
    await context.close();
  });

  it('blocks further attempts from an address, even with the right password', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await new TestClient(context.app).login('admin', 'wrong password here');
      expect(response.statusCode).toBe(401);
    }
    const limited = await new TestClient(context.app).login('admin', ADMIN_PASSWORD);
    expect(limited.statusCode).toBe(429);
    expect(errorResponseSchema.parse(limited.json()).error.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.cookies).toEqual([]);
  });

  it('does not count successful sign-ins', async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await new TestClient(context.app).login('admin', ADMIN_PASSWORD)).statusCode).toBe(
        200,
      );
    }
  });

  it('is not fooled by a parallel burst', async () => {
    const verify = vi.spyOn(context.dependencies.passwords, 'verify');
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        new TestClient(context.app).login('admin', 'wrong password here'),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 401)).toHaveLength(3);
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(17);
    expect(verify).toHaveBeenCalledTimes(3);
    verify.mockRestore();
  });

  it('ignores X-Forwarded-For unless a proxy is trusted', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new TestClient(context.app).request({
        method: 'POST',
        url: '/auth/login',
        headers: { 'x-forwarded-for': `203.0.113.${attempt}` },
        payload: { username: 'admin', password: 'wrong password here' },
      });
    }
    const limited = await new TestClient(context.app).request({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-forwarded-for': '203.0.113.99' },
      payload: { username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(limited.statusCode).toBe(429);
  });
});

describe('username rate limit', () => {
  it('applies across addresses, ignoring case', async () => {
    context = await startBrowserApp(
      {
        rateLimits: {
          ...DEFAULT_AUTH_RATE_LIMITS,
          loginPerUsername: { maxAttempts: 2, windowSeconds: 60 },
        },
      },
      { trustProxy: ['127.0.0.1'] },
    );
    admin = await signedInAdmin(context);
    const attempt = (username: string, address: string, password: string) =>
      new TestClient(context.app).request({
        method: 'POST',
        url: '/auth/login',
        headers: { 'x-forwarded-for': address },
        remoteAddress: '127.0.0.1',
        payload: { username, password },
      });
    expect((await attempt('admin', '203.0.113.1', 'wrong password')).statusCode).toBe(401);
    expect((await attempt('ADMIN', '203.0.113.2', 'wrong password')).statusCode).toBe(401);
    expect((await attempt('Admin', '203.0.113.3', ADMIN_PASSWORD)).statusCode).toBe(429);
    await context.close();
  });
});

describe('secure cookies', () => {
  it('uses Secure and the __Host- prefix in production mode', async () => {
    context = await startBrowserApp({ cookie: { secure: true, maxAgeSeconds: 7200 } });
    const client = new TestClient(context.app);
    client.cookieName = '__Host-emucat_session';
    const response = await client.setup();
    const cookie = response.cookies.find((item) => item.name === '__Host-emucat_session');
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(cookie).not.toHaveProperty('domain');
    expect((await client.get('/auth/me')).statusCode).toBe(200);

    // A cookie under the insecure name carries no authority in this mode.
    const plain = new TestClient(context.app);
    plain.cookie = client.cookie;
    expect((await plain.get('/auth/me')).statusCode).toBe(401);
    await context.close();
  });
});

describe('PUBLIC_ORIGIN', () => {
  it('compares against the configured origin rather than the Host header', async () => {
    context = await startBrowserApp({ publicOrigin: 'https://emucat.example' });
    const client = new TestClient(context.app);
    const attempt = (origin: string) =>
      client.request({
        method: 'POST',
        url: '/auth/login',
        headers: { origin },
        payload: { username: 'nobody', password: 'wrong password here' },
      });
    expect((await attempt(ORIGIN)).statusCode).toBe(403);
    expect((await attempt('https://emucat.example')).statusCode).toBe(401);
    await context.close();
  });
});
