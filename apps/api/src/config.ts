import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { REPOSITORY_ROOT } from './env.js';
import { DEFAULT_MEDIA_POLICY, type MediaPolicy } from './media/uploads.js';

const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

/** An empty line in `.env` means the same as leaving the variable out. */
function emptyAsUndefined<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema);
}

const envSchema = z.object({
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanFlag.default(false),
  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3307),
  DB_NAME: z.string().min(1).default('emucat'),
  DB_USER: z.string().min(1).default('emucat'),
  // Required, with no default: there are no built-in credentials.
  DB_PASSWORD: z.string().min(1),
  STORAGE_PATH: z.string().min(1).default('var/storage'),
  MEDIA_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(1024 * 1024 * 1024)
    .default(DEFAULT_MEDIA_POLICY.maxUploadBytes),
  MEDIA_MAX_PIXELS: z.coerce
    .number()
    .int()
    .min(1)
    .max(268_402_689)
    .default(DEFAULT_MEDIA_POLICY.maxPixels),
  MEDIA_MAX_DIMENSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(65_535)
    .default(DEFAULT_MEDIA_POLICY.maxDimension),
  MEDIA_MAX_CONCURRENT_UPLOADS: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(DEFAULT_MEDIA_POLICY.maxConcurrentUploads),
  MEDIA_PROCESSING_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(600)
    .default(DEFAULT_MEDIA_POLICY.processingTimeoutSeconds),
  NODE_ENV: z.string().optional(),
  // Defaults to true when NODE_ENV is production.
  COOKIE_SECURE: emptyAsUndefined(booleanFlag.optional()),
  SESSION_IDLE_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(168),
  SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(720),
  // Left empty, a random token is generated and logged while setup is pending.
  SETUP_TOKEN: emptyAsUndefined(z.string().min(32).max(512).optional()),
  // The browser's origin, for when a proxy rewrites the Host header.
  PUBLIC_ORIGIN: emptyAsUndefined(z.url().optional()),
  // Comma-separated addresses or CIDR ranges of proxies whose X-Forwarded-For is believed.
  TRUST_PROXY: z.string().default(''),
  // A label for the installation, such as test or production. Shown to administrators only.
  EMUCAT_ENVIRONMENT: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'Expected a short lowercase name')
    .default('development'),
  // Set by the production image at build time. Never secrets.
  EMUCAT_BUILD_COMMIT: emptyAsUndefined(
    z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'Expected a full commit ID')
      .optional(),
  ),
  EMUCAT_BUILD_TIME: emptyAsUndefined(z.iso.datetime({ offset: true }).optional()),
  // The local deployment service. Both unset, as in development, means administrators see that
  // application updates are not configured.
  DEPLOYER_SOCKET: emptyAsUndefined(z.string().min(1).optional()),
  DEPLOYER_TOKEN_FILE: emptyAsUndefined(z.string().min(1).optional()),
});

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  logPretty: boolean;
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  storagePath: string;
  media: MediaPolicy;
  cookieSecure: boolean;
  sessionIdleTtlSeconds: number;
  sessionAbsoluteTtlSeconds: number;
  setupToken: string | undefined;
  publicOrigin: string | undefined;
  trustProxy: string[];
  environment: string;
  build: { commit: string | undefined; builtAt: string | undefined };
  deployer: { socketPath: string; tokenFile: string } | undefined;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Validates the environment. Error messages name variables but never include their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const values = parsed.data;
  if ((values.DEPLOYER_SOCKET === undefined) !== (values.DEPLOYER_TOKEN_FILE === undefined)) {
    throw new ConfigError(
      'Invalid configuration:\n  DEPLOYER_SOCKET and DEPLOYER_TOKEN_FILE must be set together',
    );
  }
  return {
    host: values.API_HOST,
    port: values.API_PORT,
    logLevel: values.LOG_LEVEL,
    logPretty: values.LOG_PRETTY,
    database: {
      host: values.DB_HOST,
      port: values.DB_PORT,
      name: values.DB_NAME,
      user: values.DB_USER,
      password: values.DB_PASSWORD,
    },
    storagePath: isAbsolute(values.STORAGE_PATH)
      ? values.STORAGE_PATH
      : resolve(REPOSITORY_ROOT, values.STORAGE_PATH),
    media: {
      ...DEFAULT_MEDIA_POLICY,
      maxUploadBytes: values.MEDIA_MAX_UPLOAD_BYTES,
      maxPixels: values.MEDIA_MAX_PIXELS,
      maxDimension: values.MEDIA_MAX_DIMENSION,
      maxConcurrentUploads: values.MEDIA_MAX_CONCURRENT_UPLOADS,
      processingTimeoutSeconds: values.MEDIA_PROCESSING_TIMEOUT_SECONDS,
    },
    cookieSecure: values.COOKIE_SECURE ?? values.NODE_ENV === 'production',
    sessionIdleTtlSeconds: values.SESSION_IDLE_TTL_HOURS * 3600,
    sessionAbsoluteTtlSeconds: values.SESSION_ABSOLUTE_TTL_HOURS * 3600,
    setupToken: values.SETUP_TOKEN,
    publicOrigin: values.PUBLIC_ORIGIN && new URL(values.PUBLIC_ORIGIN).origin,
    trustProxy: values.TRUST_PROXY.split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    environment: values.EMUCAT_ENVIRONMENT,
    build: { commit: values.EMUCAT_BUILD_COMMIT, builtAt: values.EMUCAT_BUILD_TIME },
    deployer:
      values.DEPLOYER_SOCKET && values.DEPLOYER_TOKEN_FILE
        ? { socketPath: values.DEPLOYER_SOCKET, tokenFile: values.DEPLOYER_TOKEN_FILE }
        : undefined,
  };
}
