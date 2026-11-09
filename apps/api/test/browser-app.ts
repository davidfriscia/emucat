import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { AgentHub, type AgentHubOptions } from '../src/agents/hub.js';
import { DEFAULT_PAIRING_POLICY } from '../src/agents/pairing.js';
import { databaseAgentPresence } from '../src/agents/repository.js';
import { buildApp, type AppDependencies } from '../src/app.js';
import { databaseAgentAuthenticator } from '../src/auth/agent-auth.js';
import { createPasswordHasher } from '../src/auth/passwords.js';
import { RateLimiter } from '../src/auth/rate-limiter.js';
import { createSetupToken } from '../src/auth/setup.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_MEDIA_POLICY } from '../src/media/uploads.js';
import { DEFAULT_PAIRING_RATE_LIMITS } from '../src/routes/agent-pairing.js';
import { DEFAULT_AUTH_RATE_LIMITS } from '../src/routes/auth.js';
import type { BrowserDependencies } from '../src/routes/browser.js';
import { fileMediaStorage } from '../src/storage/media-storage.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

export const SETUP_TOKEN = 'test-setup-token-with-plenty-of-characters';
export const ADMIN_PASSWORD = 'correct horse battery staple';
export const HOST = 'emucat.test';
export const ORIGIN = `http://${HOST}`;

export interface BrowserTestContext {
  app: FastifyInstance;
  pool: Pool;
  database: TestDatabase;
  storageRoot: string;
  dependencies: BrowserDependencies;
  /** Builds another API instance on the same database, like a second server process. */
  buildAnother(overrides?: Partial<BrowserDependencies>): Promise<FastifyInstance>;
  close(): Promise<void>;
}

/** A real application on a real, uniquely named database, with a cheap password hash for speed. */
export async function startBrowserApp(
  overrides: Partial<BrowserDependencies> = {},
  appOverrides: Partial<AppDependencies> = {},
  hubOptions: Partial<AgentHubOptions> = {},
): Promise<BrowserTestContext> {
  const database = await createTestDatabase();
  // Nobody can close a context that was never returned, so a failure here cleans up after itself.
  await migrate(database.options).catch(async (error: unknown) => {
    await database.drop().catch(() => undefined);
    throw error;
  });
  const pool = database.createPool();
  const storageRoot = await mkdtemp(join(tmpdir(), 'emucat-storage-'));

  const baseDependencies = (): BrowserDependencies => ({
    pool,
    storage: fileMediaStorage(storageRoot),
    media: DEFAULT_MEDIA_POLICY,
    passwords: createPasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 }),
    setupToken: createSetupToken(SETUP_TOKEN),
    limiter: new RateLimiter(),
    rateLimits: DEFAULT_AUTH_RATE_LIMITS,
    session: { idleTtlSeconds: 3600, absoluteTtlSeconds: 7200 },
    cookie: { secure: false, maxAgeSeconds: 7200 },
    pairing: DEFAULT_PAIRING_POLICY,
    pairingRateLimits: DEFAULT_PAIRING_RATE_LIMITS,
    ...overrides,
  });
  const dependencies = baseDependencies();
  const instances: FastifyInstance[] = [];
  const build = async (browser: BrowserDependencies) => {
    const instance = await buildApp({
      readiness: async () => ({ database: 'ok', migrations: 'ok' }),
      authenticateAgent: databaseAgentAuthenticator(pool),
      agentHub: new AgentHub({ presence: databaseAgentPresence(pool), ...hubOptions }),
      browser,
      ...appOverrides,
    });
    instances.push(instance);
    return instance;
  };
  const app = await build(dependencies);

  return {
    app,
    pool,
    database,
    storageRoot,
    dependencies,
    buildAnother: (more = {}) => build({ ...baseDependencies(), ...more }),
    close: async () => {
      await Promise.all(instances.map((instance) => instance.close()));
      await pool.end();
      await database.drop();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

/** A browser, in effect: it keeps its cookie and its CSRF token, and sends both like the web app. */
export class TestClient {
  cookie: string | undefined;
  csrfToken: string | undefined;
  cookieName = 'emucat_session';

  constructor(private readonly app: FastifyInstance) {}

  async request(
    options: Omit<InjectOptions, 'url'> & { url: string; csrf?: boolean | string },
  ): Promise<LightMyRequestResponse> {
    const { csrf = true, headers, ...rest } = options;
    const method = options.method ?? 'GET';
    const unsafe = !['GET', 'HEAD'].includes(method);
    const csrfHeader = typeof csrf === 'string' ? csrf : csrf ? this.csrfToken : undefined;
    const response = await this.app.inject({
      ...rest,
      url: `/api/v1${options.url}`,
      headers: {
        host: HOST,
        ...(this.cookie ? { cookie: `${this.cookieName}=${this.cookie}` } : {}),
        ...(unsafe && csrfHeader ? { 'x-csrf-token': csrfHeader } : {}),
        ...headers,
      },
    });
    for (const cookie of response.cookies) {
      if (cookie.name !== this.cookieName) continue;
      // An expired cookie is how a server tells a browser to forget it.
      const expired = cookie.value === '' || (cookie.expires && cookie.expires <= new Date());
      this.cookie = expired ? undefined : cookie.value;
    }
    const body = (() => {
      try {
        return response.json<{ csrfToken?: string }>();
      } catch {
        return null;
      }
    })();
    if (body?.csrfToken) this.csrfToken = body.csrfToken;
    return response;
  }

  get(url: string) {
    return this.request({ method: 'GET', url });
  }

  login(username: string, password: string) {
    return this.request({ method: 'POST', url: '/auth/login', payload: { username, password } });
  }

  setup(overrides: Record<string, unknown> = {}) {
    return this.request({
      method: 'POST',
      url: '/setup',
      payload: {
        setupToken: SETUP_TOKEN,
        username: 'admin',
        displayName: 'The Admin',
        password: ADMIN_PASSWORD,
        ...overrides,
      },
    });
  }
}

export async function signedInAdmin(context: BrowserTestContext): Promise<TestClient> {
  const client = new TestClient(context.app);
  const response = await client.setup();
  if (response.statusCode !== 201) throw new Error(`Setup failed: ${response.body}`);
  return client;
}

/** Inserted directly, as a test fixture: the application itself has no way to create a VM. */
export async function insertVm(
  pool: Pool,
  vm: {
    emulatorType?: string;
    vmName: string;
    displayName?: string | null;
    description?: string | null;
    visibility?: 'private' | 'public';
  },
): Promise<void> {
  await pool.execute(
    `INSERT INTO virtual_machines (emulator_type, vm_name, display_name, description, visibility)
     VALUES (?, ?, ?, ?, ?)`,
    [
      vm.emulatorType ?? 'qemu',
      vm.vmName,
      vm.displayName ?? null,
      vm.description ?? null,
      vm.visibility ?? 'private',
    ],
  );
}

export interface MediaFixture {
  id: string;
  jpegKey: string;
  thumbnailKey: string;
}

export async function insertMedia(
  context: Pick<BrowserTestContext, 'pool' | 'storageRoot'>,
  vm: { emulatorType?: string; vmName: string },
  options: {
    /**
     * The legacy `vm_media.visibility` value, which decides nothing since decision 0036. Tests set it
     * to prove exactly that.
     */
    legacyVisibility?: 'private' | 'published';
    isMain?: boolean;
    filename?: string;
    writeFiles?: boolean;
    jpegKey?: string;
    thumbnailKey?: string;
  } = {},
): Promise<MediaFixture> {
  const id = randomUUID();
  const emulatorType = vm.emulatorType ?? 'qemu';
  const jpegKey = options.jpegKey ?? `media/${id}/full.jpg`;
  const thumbnailKey = options.thumbnailKey ?? `media/${id}/thumb.jpg`;
  await context.pool.execute(
    `INSERT INTO vm_media (id, emulator_type, vm_name, visibility, is_main, original_filename,
       original_sha256, original_size_bytes, jpeg_key, thumbnail_key, width_px, height_px)
     VALUES (?, ?, ?, ?, ?, ?, ?, 2048, ?, ?, 640, 480)`,
    [
      id,
      emulatorType,
      vm.vmName,
      options.legacyVisibility ?? 'private',
      options.isMain ?? false,
      options.filename ?? 'screenshot.png',
      createHash('sha256').update(id).digest('hex'),
      jpegKey,
      thumbnailKey,
    ],
  );
  if (options.writeFiles !== false) {
    for (const [key, content] of [
      [jpegKey, `full:${id}`],
      [thumbnailKey, `thumb:${id}`],
    ] as const) {
      const path = join(context.storageRoot, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
  }
  return { id, jpegKey, thumbnailKey };
}
