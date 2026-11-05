import { authenticatedSessionSchema, errorResponseSchema } from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapAdministrator, isSetupRequired } from '../src/auth/setup.js';
import { DEFAULT_AUTH_RATE_LIMITS } from '../src/routes/auth.js';
import {
  ADMIN_PASSWORD,
  ORIGIN,
  SETUP_TOKEN,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from './browser-app.js';

let context: BrowserTestContext;

afterEach(async () => {
  await context.close();
});

async function count(table: string): Promise<number> {
  const [rows] = await context.pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0]?.n);
}

describe('first-administrator setup', () => {
  it('starts from no users at all, and reports that setup is required', async () => {
    context = await startBrowserApp();
    expect(await count('users')).toBe(0);
    const response = await new TestClient(context.app).get('/setup/status');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ setupRequired: true });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('creates an administrator and signs them in', async () => {
    context = await startBrowserApp();
    const client = new TestClient(context.app);
    const response = await client.setup();
    expect(response.statusCode).toBe(201);
    const session = authenticatedSessionSchema.parse(response.json());
    expect(session.user).toMatchObject({
      username: 'admin',
      displayName: 'The Admin',
      role: 'admin',
    });
    expect(response.body).not.toContain(ADMIN_PASSWORD);
    expect((await client.get('/auth/me')).statusCode).toBe(200);
    expect((await client.get('/setup/status')).json()).toEqual({ setupRequired: false });
  });

  it('stores the password as Argon2id and never in the clear', async () => {
    context = await startBrowserApp();
    await new TestClient(context.app).setup();
    const [rows] = await context.pool.query<RowDataPacket[]>('SELECT password_hash FROM users');
    const stored = rows[0]?.password_hash as string;
    expect(stored).toMatch(/^\$argon2id\$/);
    expect(stored).not.toContain(ADMIN_PASSWORD);
  });

  it('records which user completed setup', async () => {
    context = await startBrowserApp();
    await new TestClient(context.app).setup();
    const [rows] = await context.pool.query<RowDataPacket[]>(
      `SELECT u.username FROM system_bootstrap AS b JOIN users AS u ON u.id = b.admin_user_id`,
    );
    expect(rows.map((row) => row.username)).toEqual(['admin']);
  });

  it('refuses a wrong setup token and creates nothing', async () => {
    context = await startBrowserApp();
    const response = await new TestClient(context.app).setup({ setupToken: 'wrong' });
    expect(response.statusCode).toBe(403);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('invalid_setup_token');
    expect(await count('users')).toBe(0);
    expect(await count('system_bootstrap')).toBe(0);
  });

  it('refuses a second setup, even with the right token', async () => {
    context = await startBrowserApp();
    const client = new TestClient(context.app);
    await client.setup();
    const response = await new TestClient(context.app).setup({ username: 'attacker' });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('setup_completed');
    expect(await count('users')).toBe(1);
  });

  it('stays closed after the first administrator is removed', async () => {
    context = await startBrowserApp();
    await new TestClient(context.app).setup();
    await context.pool.query('DELETE FROM users');
    expect(await isSetupRequired(context.pool)).toBe(false);
    expect((await new TestClient(context.app).setup()).statusCode).toBe(409);
  });

  it('stays closed when an administrator already exists without a bootstrap record', async () => {
    context = await startBrowserApp();
    await context.pool.execute(
      `INSERT INTO users (id, username, display_name, password_hash, role)
       VALUES (UUID(), 'existing', 'Existing', 'x', 'admin')`,
    );
    expect((await new TestClient(context.app).setup()).statusCode).toBe(409);
  });

  it.each([
    ['a short password', { password: 'short' }],
    ['an overlong password', { password: 'x'.repeat(257) }],
    ['an invalid username', { username: "admin' OR 1=1 --" }],
    ['a blank display name', { displayName: '   ' }],
    ['a chosen role', { role: 'user' }],
    ['a chosen id', { id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60' }],
  ])('rejects %s', async (_name, fields) => {
    context = await startBrowserApp();
    const response = await new TestClient(context.app).setup(fields);
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_failed');
    expect(response.body).not.toContain(SETUP_TOKEN);
    expect(await count('users')).toBe(0);
  });

  it('rate limits guesses at the setup token', async () => {
    context = await startBrowserApp({
      rateLimits: {
        loginPerAddress: { maxAttempts: 100, windowSeconds: 60 },
        loginPerUsername: { maxAttempts: 100, windowSeconds: 60 },
        passwordChangePerUser: { maxAttempts: 100, windowSeconds: 60 },
        setupPerAddress: { maxAttempts: 2, windowSeconds: 60 },
      },
    });
    const client = new TestClient(context.app);
    expect((await client.setup({ setupToken: 'guess-1' })).statusCode).toBe(403);
    expect((await client.setup({ setupToken: 'guess-2' })).statusCode).toBe(403);
    const limited = await client.setup();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(await count('users')).toBe(0);
  });

  it('refuses a cross-site setup request', async () => {
    context = await startBrowserApp();
    const response = await new TestClient(context.app).request({
      method: 'POST',
      url: '/setup',
      headers: { origin: 'https://evil.example' },
      payload: {
        setupToken: SETUP_TOKEN,
        username: 'admin',
        displayName: 'Admin',
        password: ADMIN_PASSWORD,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(await count('users')).toBe(0);
  });
});

describe('concurrent setup', () => {
  it('lets exactly one of many concurrent requests win', async () => {
    context = await startBrowserApp({
      rateLimits: {
        ...DEFAULT_AUTH_RATE_LIMITS,
        setupPerAddress: { maxAttempts: 100, windowSeconds: 60 },
      },
    });
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        new TestClient(context.app).setup({ username: `admin${index}` }),
      ),
    );
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(11);
    expect(await count('users')).toBe(1);
    expect(await count('system_bootstrap')).toBe(1);
    expect(await count('user_sessions')).toBe(1);
  });

  it('lets exactly one win across separate API instances', async () => {
    context = await startBrowserApp();
    const other = await context.buildAnother();
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        new TestClient(index % 2 === 0 ? context.app : other).setup({ username: `admin${index}` }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(await count('users')).toBe(1);
  });

  it('holds at the database level when every attempt passes the earlier checks', async () => {
    context = await startBrowserApp();
    const { pool, dependencies } = context;
    const hash = await dependencies.passwords.hash(ADMIN_PASSWORD);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        bootstrapAdministrator(
          pool,
          { username: `admin${index}`, displayName: 'Admin' },
          hash,
          dependencies.session,
        ),
      ),
    );
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(await count('users')).toBe(1);
  });

  it('leaves setup open if the winning attempt fails part way', async () => {
    context = await startBrowserApp();
    const { pool, dependencies } = context;
    // A username this long fails the column limit after the bootstrap row has been inserted.
    await expect(
      bootstrapAdministrator(
        pool,
        { username: 'x'.repeat(65), displayName: 'Admin' },
        'hash',
        dependencies.session,
      ),
    ).rejects.toThrow();
    expect(await count('system_bootstrap')).toBe(0);
    expect(await count('users')).toBe(0);
    expect((await new TestClient(context.app).setup()).statusCode).toBe(201);
  });
});

describe('system_bootstrap', () => {
  it('cannot hold more than one row, or any other key', async () => {
    context = await startBrowserApp();
    await context.pool.query('INSERT INTO system_bootstrap (id) VALUES (1)');
    await expect(
      context.pool.query('INSERT INTO system_bootstrap (id) VALUES (1)'),
    ).rejects.toThrow(/Duplicate/);
    await expect(
      context.pool.query('INSERT INTO system_bootstrap (id) VALUES (2)'),
    ).rejects.toThrow(/CONSTRAINT|ck_system_bootstrap/);
  });
});

describe('same-origin setup', () => {
  it('is accepted', async () => {
    context = await startBrowserApp();
    const response = await new TestClient(context.app).request({
      method: 'POST',
      url: '/setup',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      payload: {
        setupToken: SETUP_TOKEN,
        username: 'admin',
        displayName: 'Admin',
        password: ADMIN_PASSWORD,
      },
    });
    expect(response.statusCode).toBe(201);
  });
});
