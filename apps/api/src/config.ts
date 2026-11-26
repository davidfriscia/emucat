import { isAbsolute, resolve } from 'node:path';
import {
  TRANSFER_DEFAULT_CHUNK_BYTES,
  TRANSFER_MAX_CHUNK_BYTES,
  TRANSFER_MIN_CHUNK_BYTES,
} from '@emucat/contracts';
import { z } from 'zod';
import { DEFAULT_ARCHIVE_POLICY as ARCHIVE, type ArchivePolicy } from './archives/policy.js';
import { REPOSITORY_ROOT } from './env.js';
import { DEFAULT_MEDIA_POLICY, type MediaPolicy } from './media/uploads.js';
import type { RepositoryAccessSettings } from './repository-access/ssh.js';
import { DEFAULT_TRANSFER_POLICY, type TransferPolicy } from './transfers/policy.js';

const intIn = (min: number, max: number, fallback: number) =>
  emptyAsUndefined(z.coerce.number().int().min(min).max(max).default(fallback));

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

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
  // Per-VM Markdown notes (decision 0053): the directory that holds <emulator>/<vm>/<vm> - notes.md.
  NOTES_PATH: z.string().min(1).default('var/notes'),
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
  // The server's own SSH connection to repositories (decision 0055). Without a key, the server has none: clones,
  // archive inspection and the transfer relay say so, and everything else works as before. The key is read from
  // this file whenever a connection is opened, and never stored, logged or returned.
  REPOSITORY_SSH_PRIVATE_KEY_PATH: emptyAsUndefined(z.string().min(1).optional()),
  // A file holding the key's passphrase, if it has one. Never the passphrase itself.
  REPOSITORY_SSH_PASSPHRASE_FILE: emptyAsUndefined(z.string().min(1).optional()),
  // OpenSSH known_hosts with the repository's host key. Required with a key: host keys are always verified.
  REPOSITORY_SSH_KNOWN_HOSTS_PATH: emptyAsUndefined(z.string().min(1).optional()),
  REPOSITORY_SSH_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(15),
  REPOSITORY_SSH_REQUEST_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
  // Where transfers and clones stage bytes on the server: a persistent disk, never the container layer.
  TRANSFER_STAGING_PATH: z.string().min(1).default('var/transfers'),
  TRANSFER_RELAY_ENABLED: booleanFlag.default(true),
  TRANSFER_CHUNK_BYTES: z.coerce
    .number()
    .int()
    .min(TRANSFER_MIN_CHUNK_BYTES)
    .max(TRANSFER_MAX_CHUNK_BYTES)
    .default(TRANSFER_DEFAULT_CHUNK_BYTES),
  TRANSFER_MAX_STAGING_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1024 * 1024)
    .max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_TRANSFER_POLICY.maxStagingBytes),
  TRANSFER_MIN_FREE_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_TRANSFER_POLICY.minFreeBytes),
  TRANSFER_MAX_CONCURRENT: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(DEFAULT_TRANSFER_POLICY.maxConcurrent),
  TRANSFER_INACTIVITY_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(30 * 86400)
    .default(DEFAULT_TRANSFER_POLICY.inactivityTimeoutSeconds),
  TRANSFER_RETENTION_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(30 * 86400)
    .default(DEFAULT_TRANSFER_POLICY.retentionSeconds),
  // Archive inspection and Archive Explorer (decisions 0055 and 0056). All optional; see docs/deployment.md.
  ARCHIVE_INSPECTION_MAX_ENTRIES: intIn(1000, 500_000, ARCHIVE.inspection.maxEntries),
  ARCHIVE_INSPECTION_MAX_DIRECTORY_BYTES: intIn(
    MiB,
    128 * MiB,
    ARCHIVE.inspection.maxDirectoryBytes,
  ),
  ARCHIVE_INSPECTION_MAX_MANIFEST_BYTES: intIn(MiB, 128 * MiB, ARCHIVE.inspection.maxManifestBytes),
  ARCHIVE_INSPECTION_MAX_CONCURRENT: intIn(1, 16, ARCHIVE.inspection.maxConcurrent),
  ARCHIVE_INSPECTION_TIMEOUT_SECONDS: intIn(5, 3600, ARCHIVE.inspection.timeoutMs / 1000),
  ARCHIVE_CACHE_MAX_INDEXES: intIn(0, 256, ARCHIVE.cache.maxIndexes),
  ARCHIVE_CACHE_TTL_SECONDS: intIn(0, 86_400, ARCHIVE.cache.ttlMs / 1000),
  ARCHIVE_CACHE_MAX_BYTES: intIn(0, 4 * GiB, ARCHIVE.cache.maxBytes),
  ARCHIVE_PREVIEW_TEXT_BYTES: intIn(4 * KiB, 16 * MiB, ARCHIVE.preview.textBytes),
  ARCHIVE_PREVIEW_HEX_BYTES: intIn(KiB, 4 * MiB, ARCHIVE.preview.hexBytes),
  ARCHIVE_PREVIEW_IMAGE_BYTES: intIn(64 * KiB, 256 * MiB, ARCHIVE.preview.imageBytes),
  ARCHIVE_PREVIEW_IMAGE_PIXELS: intIn(4096, 268_402_689, ARCHIVE.preview.imagePixels),
  ARCHIVE_PREVIEW_PDF_BYTES: intIn(64 * KiB, 512 * MiB, ARCHIVE.preview.pdfBytes),
  ARCHIVE_PREVIEW_SEEK_BYTES: intIn(0, GiB, ARCHIVE.preview.maxSeekBytes),
  ARCHIVE_PREVIEW_MAX_CONCURRENT: intIn(1, 16, ARCHIVE.preview.maxConcurrent),
  ARCHIVE_PREVIEW_MAX_QUEUED: intIn(0, 64, ARCHIVE.preview.maxQueued),
  ARCHIVE_PREVIEW_TIMEOUT_SECONDS: intIn(5, 600, ARCHIVE.preview.timeoutMs / 1000),
  ARCHIVE_DOWNLOAD_MAX_BYTES: intIn(0, 64 * GiB, ARCHIVE.download.maxBytes),
  ARCHIVE_DOWNLOAD_MAX_CONCURRENT: intIn(1, 16, ARCHIVE.download.maxConcurrent),
  ARCHIVE_DOWNLOAD_MAX_QUEUED: intIn(0, 64, ARCHIVE.download.maxQueued),
  ARCHIVE_DOWNLOAD_TIMEOUT_SECONDS: intIn(10, 86_400, ARCHIVE.download.timeoutMs / 1000),
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
  notesPath: string;
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
  /** The server's own repository connection. `undefined` when no key is configured. */
  repositoryAccess: RepositoryAccessSettings | undefined;
  transfers: TransferPolicy;
  archives: ArchivePolicy;
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(REPOSITORY_ROOT, path);
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
  if (
    values.REPOSITORY_SSH_PRIVATE_KEY_PATH !== undefined &&
    values.REPOSITORY_SSH_KNOWN_HOSTS_PATH === undefined
  ) {
    throw new ConfigError(
      'Invalid configuration:\n  REPOSITORY_SSH_KNOWN_HOSTS_PATH is required with REPOSITORY_SSH_PRIVATE_KEY_PATH: host keys are always verified',
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
    notesPath: isAbsolute(values.NOTES_PATH)
      ? values.NOTES_PATH
      : resolve(REPOSITORY_ROOT, values.NOTES_PATH),
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
    repositoryAccess:
      values.REPOSITORY_SSH_PRIVATE_KEY_PATH && values.REPOSITORY_SSH_KNOWN_HOSTS_PATH
        ? {
            privateKeyPath: absolute(values.REPOSITORY_SSH_PRIVATE_KEY_PATH),
            passphraseFile: values.REPOSITORY_SSH_PASSPHRASE_FILE
              ? absolute(values.REPOSITORY_SSH_PASSPHRASE_FILE)
              : undefined,
            knownHostsPath: absolute(values.REPOSITORY_SSH_KNOWN_HOSTS_PATH),
            connectTimeoutMs: values.REPOSITORY_SSH_CONNECT_TIMEOUT_SECONDS * 1000,
            requestTimeoutMs: values.REPOSITORY_SSH_REQUEST_TIMEOUT_SECONDS * 1000,
          }
        : undefined,
    transfers: {
      stagingPath: absolute(values.TRANSFER_STAGING_PATH),
      relayEnabled: values.TRANSFER_RELAY_ENABLED,
      chunkBytes: values.TRANSFER_CHUNK_BYTES,
      maxStagingBytes: values.TRANSFER_MAX_STAGING_BYTES,
      minFreeBytes: values.TRANSFER_MIN_FREE_BYTES,
      maxConcurrent: values.TRANSFER_MAX_CONCURRENT,
      inactivityTimeoutSeconds: values.TRANSFER_INACTIVITY_TIMEOUT_SECONDS,
      retentionSeconds: values.TRANSFER_RETENTION_SECONDS,
    },
    archives: {
      inspection: {
        maxEntries: values.ARCHIVE_INSPECTION_MAX_ENTRIES,
        maxDirectoryBytes: values.ARCHIVE_INSPECTION_MAX_DIRECTORY_BYTES,
        maxManifestBytes: values.ARCHIVE_INSPECTION_MAX_MANIFEST_BYTES,
        maxConcurrent: values.ARCHIVE_INSPECTION_MAX_CONCURRENT,
        timeoutMs: values.ARCHIVE_INSPECTION_TIMEOUT_SECONDS * 1000,
      },
      cache: {
        maxIndexes: values.ARCHIVE_CACHE_MAX_INDEXES,
        ttlMs: values.ARCHIVE_CACHE_TTL_SECONDS * 1000,
        maxBytes: values.ARCHIVE_CACHE_MAX_BYTES,
      },
      preview: {
        textBytes: values.ARCHIVE_PREVIEW_TEXT_BYTES,
        hexBytes: values.ARCHIVE_PREVIEW_HEX_BYTES,
        imageBytes: values.ARCHIVE_PREVIEW_IMAGE_BYTES,
        imagePixels: values.ARCHIVE_PREVIEW_IMAGE_PIXELS,
        pdfBytes: values.ARCHIVE_PREVIEW_PDF_BYTES,
        maxSeekBytes: values.ARCHIVE_PREVIEW_SEEK_BYTES,
        maxConcurrent: values.ARCHIVE_PREVIEW_MAX_CONCURRENT,
        maxQueued: values.ARCHIVE_PREVIEW_MAX_QUEUED,
        timeoutMs: values.ARCHIVE_PREVIEW_TIMEOUT_SECONDS * 1000,
      },
      download: {
        maxBytes: values.ARCHIVE_DOWNLOAD_MAX_BYTES,
        maxConcurrent: values.ARCHIVE_DOWNLOAD_MAX_CONCURRENT,
        maxQueued: values.ARCHIVE_DOWNLOAD_MAX_QUEUED,
        timeoutMs: values.ARCHIVE_DOWNLOAD_TIMEOUT_SECONDS * 1000,
      },
    },
  };
}
