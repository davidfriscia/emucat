import { z } from 'zod';
import { sha256HexSchema, timestampSchema } from './version.js';

/**
 * Repository transfers through the EmuCat server (decision 0055).
 *
 * An agent prefers its own SFTP connection to a repository. When that connection cannot be made at all (the address
 * is unreachable from where the agent is), it may use the server's HTTPS relay instead: the agent talks to the API
 * over its authenticated connection, the API stages bytes on its own disk, and the API talks to the repository over
 * its own SFTP connection, with its own key and its own strict host-key checks. Both paths store the same objects at
 * the same keys, with the same staging, verification and no-overwrite publication.
 *
 * Uploads are sent in fixed-size chunks, each with its SHA-256, and can be resumed: the server says which chunks it
 * already holds. Downloads are staged once on the server, verified, and then read with HTTP `Range` requests, which
 * can be resumed from any offset.
 */

/** Every relay route is under this prefix, then the repository's UUID. Authenticated like every agent route. */
export const AGENT_REPOSITORY_RELAY_PATH = '/api/v1/agent/repositories';
/** The SHA-256 of one chunk's bytes, lowercase hex. Required on every chunk. */
export const CHUNK_SHA256_HEADER = 'x-emucat-chunk-sha256';

/** Bounds on what a server may configure as its chunk size, and so on what an agent accepts. */
export const TRANSFER_MIN_CHUNK_BYTES = 256 * 1024;
export const TRANSFER_MAX_CHUNK_BYTES = 64 * 1024 * 1024;
/** Fits under common reverse-proxy request limits (nginx examples allow 80 MB, Cloudflare 100 MB). */
export const TRANSFER_DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

/** Where incomplete repository objects live. Uploads may only ever name a key under it. */
export const REPOSITORY_STAGING_PREFIX = 'archives/.staging/';

const KEY_SEGMENT = /^[A-Za-z0-9._ -]+$/;

/**
 * A repository-relative object key, by the same rule as the agent's `RepositoryKey`: plain segments of a
 * conservative alphabet, never `.` or `..`, never absolute. It can never name anything outside the repository root.
 */
export function isRepositoryKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  return key
    .split('/')
    .every((segment) => segment !== '.' && segment !== '..' && KEY_SEGMENT.test(segment));
}

export function isStagingKey(key: string): boolean {
  return isRepositoryKey(key) && key.startsWith(REPOSITORY_STAGING_PREFIX);
}

export const repositoryKeySchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isRepositoryKey, 'Not a valid repository key');

const sizeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const codeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const transferErrorSchema = z
  .object({ code: codeSchema, message: z.string().max(1024) })
  .nullable();

/** `GET …/relay`: whether this server relays for this repository, and with what chunk size. */
export const relayInfoResponseSchema = z.object({
  enabled: z.boolean(),
  /** Why not, when it does not. */
  reason: z.string().nullable(),
  chunkBytes: z.number().int().min(TRANSFER_MIN_CHUNK_BYTES).max(TRANSFER_MAX_CHUNK_BYTES),
  /** The largest object an upload may declare. */
  maxObjectBytes: sizeSchema,
});
export type RelayInfoResponse = z.infer<typeof relayInfoResponseSchema>;

export const TRANSFER_DIRECTIONS = ['upload', 'download'] as const;
export const TRANSFER_STATES = [
  // Upload: chunks arriving; all there and checked; being written to the repository's staging key; written.
  'receiving',
  'received',
  'publishing',
  'published',
  // Download: being fetched from the repository and verified; ready to read.
  'staging',
  'ready',
  // Either.
  'failed',
  'cancelled',
  'expired',
] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];
export const ACTIVE_TRANSFER_STATES: readonly TransferState[] = [
  'receiving',
  'received',
  'publishing',
  'staging',
  'ready',
];

/**
 * `POST …/uploads`: an upload of one local file to one staging key. The whole file's size and SHA-256 are declared
 * up front: a repeated request for the same key, size and hash resumes the same transfer; anything else at that key
 * replaces an unfinished one.
 */
export const uploadInitRequestSchema = z.strictObject({
  key: repositoryKeySchema.refine(isStagingKey, 'Uploads go to a staging key only'),
  sizeBytes: sizeSchema,
  sha256: sha256HexSchema,
});
export type UploadInitRequest = z.infer<typeof uploadInitRequestSchema>;

/** `POST …/downloads`: stage one object on the server, verified, so that it can be read in ranges. */
export const downloadInitRequestSchema = z.strictObject({ key: repositoryKeySchema });
export type DownloadInitRequest = z.infer<typeof downloadInitRequestSchema>;

/** Inclusive ranges of chunk indexes, so that a large transfer's status stays small. */
const chunkRangesSchema = z.array(z.tuple([sizeSchema, sizeSchema])).max(100_000);

export const transferStatusSchema = z.object({
  transferId: z.uuid(),
  direction: z.enum(TRANSFER_DIRECTIONS),
  state: z.enum(TRANSFER_STATES),
  key: repositoryKeySchema,
  /** Declared for an upload; known once staged for a download. */
  sizeBytes: sizeSchema.nullable(),
  sha256: sha256HexSchema.nullable(),
  chunkBytes: z.number().int().positive(),
  chunkCount: sizeSchema.nullable(),
  /** An upload's chunks that are still missing. Empty once all arrived. */
  missingChunks: chunkRangesSchema,
  /** Bytes received (upload) or staged (download) so far. */
  doneBytes: sizeSchema,
  error: transferErrorSchema,
  updatedAt: timestampSchema,
  /** When the server may discard it if nothing happens. */
  expiresAt: timestampSchema.nullable(),
});
export type TransferStatus = z.infer<typeof transferStatusSchema>;

/** `PUT …/uploads/:id/chunks/:index`: the answer to one chunk. Repeating a chunk is harmless. */
export const chunkAckSchema = z.object({
  transferId: z.uuid(),
  index: sizeSchema,
  receivedChunks: sizeSchema,
  chunkCount: sizeSchema,
});
export type ChunkAck = z.infer<typeof chunkAckSchema>;

/** `POST …/verify`: read an object back in the repository and hash it, on the server. */
export const relayVerifyRequestSchema = z.strictObject({
  key: repositoryKeySchema,
  sizeBytes: sizeSchema,
  sha256: sha256HexSchema,
});
export type RelayVerifyRequest = z.infer<typeof relayVerifyRequestSchema>;

export const relayVerifyStatusSchema = z.object({
  state: z.enum(['running', 'verified', 'failed']),
  doneBytes: sizeSchema,
  totalBytes: sizeSchema,
  /** What was read, once it was. A mismatch is `failed` with `hash_mismatch`, and still says what was read. */
  sizeBytes: sizeSchema.nullable(),
  sha256: sha256HexSchema.nullable(),
  error: transferErrorSchema,
});
export type RelayVerifyStatus = z.infer<typeof relayVerifyStatusSchema>;

/** `POST …/publish`: make a verified staging object visible at its final key, never replacing anything. */
export const publishRequestSchema = z.strictObject({
  stagingKey: repositoryKeySchema.refine(isStagingKey, 'Not a staging key'),
  finalKey: repositoryKeySchema.refine((key) => !isStagingKey(key), 'Not a final key'),
});
export type PublishRequest = z.infer<typeof publishRequestSchema>;

export const objectKeyRequestSchema = z.strictObject({ key: repositoryKeySchema });
export type ObjectKeyRequest = z.infer<typeof objectKeyRequestSchema>;

export const objectStatResponseSchema = z.object({
  exists: z.boolean(),
  sizeBytes: sizeSchema.nullable(),
});
export type ObjectStatResponse = z.infer<typeof objectStatResponseSchema>;

export const freeSpaceResponseSchema = z.object({ freeBytes: sizeSchema.nullable() });
export type FreeSpaceResponse = z.infer<typeof freeSpaceResponseSchema>;

/** `POST …/health`: the server's own connection, checked the way an agent checks its own. */
export const relayHealthResponseSchema = z.object({
  hostKeyFingerprint: z.string().nullable(),
  rootReadable: z.boolean(),
  rootWritable: z.boolean(),
  noOverwritePublication: z.boolean(),
  freeBytes: sizeSchema.nullable(),
});
export type RelayHealthResponse = z.infer<typeof relayHealthResponseSchema>;

// The server's own connection, as administrators test it.

export const SERVER_CONNECTION_STEPS = [
  'configuration',
  'resolve',
  'connect',
  'host_key',
  'authentication',
  'root_access',
  'write',
  'read',
  'publication',
  'cleanup',
] as const;
export type ServerConnectionStep = (typeof SERVER_CONNECTION_STEPS)[number];

export const SERVER_CONNECTION_STEP_TEXT: Record<ServerConnectionStep, string> = {
  configuration: 'Server key and known_hosts',
  resolve: 'Address resolution',
  connect: 'TCP connection',
  host_key: 'Host key verification',
  authentication: 'SSH authentication',
  root_access: 'Remote root access',
  write: 'Write permission',
  read: 'Read back',
  publication: 'No-overwrite publication (hard links)',
  cleanup: 'Test objects removed',
};

/**
 * What Test Server Connection established, step by step. `ok: null` means the step was not reached. Messages say
 * what to do, and never hold a key, a passphrase or a server filesystem path.
 */
export const serverConnectionTestSchema = z.object({
  ok: z.boolean(),
  testedAt: timestampSchema,
  address: z.object({
    host: z.string(),
    port: z.number().int(),
    /** `server` when the repository's server-side address was used, `repository` when the agents' one was. */
    source: z.enum(['server', 'repository']),
  }),
  hostKeyFingerprint: z.string().nullable(),
  freeBytes: sizeSchema.nullable(),
  steps: z.array(
    z.object({
      step: z.enum(SERVER_CONNECTION_STEPS),
      ok: z.boolean().nullable(),
      message: z.string().max(1024),
    }),
  ),
  error: transferErrorSchema,
});
export type ServerConnectionTest = z.infer<typeof serverConnectionTestSchema>;
