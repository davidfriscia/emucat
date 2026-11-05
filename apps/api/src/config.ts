import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { REPOSITORY_ROOT } from './env.js';

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
  cookieSecure: boolean;
  sessionIdleTtlSeconds: number;
  sessionAbsoluteTtlSeconds: number;
  setupToken: string | undefined;
  publicOrigin: string | undefined;
  trustProxy: string[];
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
    cookieSecure: values.COOKIE_SECURE ?? values.NODE_ENV === 'production',
    sessionIdleTtlSeconds: values.SESSION_IDLE_TTL_HOURS * 3600,
    sessionAbsoluteTtlSeconds: values.SESSION_ABSOLUTE_TTL_HOURS * 3600,
    setupToken: values.SETUP_TOKEN,
    publicOrigin: values.PUBLIC_ORIGIN && new URL(values.PUBLIC_ORIGIN).origin,
    trustProxy: values.TRUST_PROXY.split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  };
}
