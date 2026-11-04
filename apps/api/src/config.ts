import { isAbsolute, resolve } from 'node:path';
import { REPOSITORY_KIND_PATTERN } from '@emucat/contracts';
import { z } from 'zod';
import { REPOSITORY_ROOT } from './env.js';

const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

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
  ARCHIVE_REPOSITORY_KIND: z.string().regex(REPOSITORY_KIND_PATTERN).default('none'),
  ARCHIVE_REPOSITORY_URI: z.string().default(''),
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
  archiveRepository: { kind: string; uri: string };
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
    archiveRepository: {
      kind: values.ARCHIVE_REPOSITORY_KIND,
      uri: values.ARCHIVE_REPOSITORY_URI,
    },
  };
}
