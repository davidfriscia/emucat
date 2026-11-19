import { z } from 'zod';
import { vmDescriptionSchema } from './catalog.js';
import { registrationOperationSchema } from './registration.js';
import { sha256HexSchema } from './version.js';
import { vmNameSchema } from './vm-name.js';

/**
 * Importing an existing OVA into the repository from the agent's command line (`emucat-agent import-ova`,
 * decision 0049). The agent validates and hashes the file, uploads it straight to the repository as it does for
 * any master, and the API records it as the master of a new `virtualbox` catalog VM. Nothing is imported into
 * VirtualBox, and the API never sees a byte of the archive.
 *
 * The agent authenticates with its own bearer credential, as for screenshots, and these routes live under
 * {@link OVA_IMPORT_API_PATH}. They are a control plane only: the server checks, reserves and records.
 */
export const OVA_IMPORT_API_PATH = '/agent/ova-imports';

/**
 * The largest OVA the server accepts. Far above anything a VirtualBox appliance needs, it only refuses what no
 * repository should be asked to hold in one object. The agent also checks the repository's free space.
 */
export const OVA_IMPORT_MAX_BYTES = 2 ** 41;

/**
 * The operation's name for the agent's own file, kept for an administrator as a label and never used as a path.
 * Only the final path component, at most 255 characters, with no control characters.
 */
export const ovaSourceFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u001f\u007f/\\]/.test(value), 'Only a file name, without a path');

const archiveSizeSchema = z.number().int().positive().max(OVA_IMPORT_MAX_BYTES);

/** Whether an import could go ahead, without reserving or changing anything. */
export const ovaImportPreflightRequestSchema = z.strictObject({
  vmName: vmNameSchema,
  archiveSizeBytes: archiveSizeSchema.optional(),
});
export type OvaImportPreflightRequest = z.infer<typeof ovaImportPreflightRequestSchema>;

export const ovaImportPreflightResponseSchema = z.object({
  emulatorType: z.literal('virtualbox'),
  vmName: z.string(),
  /** The repository the archive goes to: the enabled one this agent may use. */
  repositoryId: z.uuid(),
  repositoryName: z.string(),
  maxArchiveBytes: z.number().int().positive(),
});
export type OvaImportPreflightResponse = z.infer<typeof ovaImportPreflightResponseSchema>;

/**
 * Reserves the catalog name and issues the version and archive key. `requestId` is chosen by the agent and kept in
 * its journal, so that a repeated request finds the operation it already created instead of making a second one.
 */
export const createOvaImportRequestSchema = z.strictObject({
  requestId: z.uuid(),
  vmName: vmNameSchema,
  description: vmDescriptionSchema.min(1).optional(),
  sourceFileName: ovaSourceFileNameSchema,
  archiveSizeBytes: archiveSizeSchema,
  archiveSha256: sha256HexSchema,
});
export type CreateOvaImportRequest = z.infer<typeof createOvaImportRequestSchema>;

/** What the agent is doing. Only forward, apart from uploading again after a failed verification. */
export const OVA_IMPORT_STAGES = ['uploading', 'verifying'] as const;
export const ovaImportProgressRequestSchema = z.strictObject({
  stage: z.enum(OVA_IMPORT_STAGES),
  doneBytes: z.number().int().nonnegative().max(OVA_IMPORT_MAX_BYTES).nullable(),
  totalBytes: z.number().int().nonnegative().max(OVA_IMPORT_MAX_BYTES).nullable(),
});
export type OvaImportProgressRequest = z.infer<typeof ovaImportProgressRequestSchema>;

/** The published, verified archive. Every value must be the one the server issued or was told at creation. */
export const completeOvaImportRequestSchema = z.strictObject({
  versionId: z.uuid(),
  archiveKey: z.string().min(1).max(512),
  archiveSizeBytes: archiveSizeSchema,
  archiveSha256: sha256HexSchema,
});
export type CompleteOvaImportRequest = z.infer<typeof completeOvaImportRequestSchema>;

/**
 * Nothing was published, or the agent gave up: the operation ends with this code. `cancelled` ends it as
 * cancelled. Too late once the master is committed: the answer is then the committed operation.
 */
export const failOvaImportRequestSchema = z.strictObject({
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .max(64),
  message: z.string().max(1024),
});
export type FailOvaImportRequest = z.infer<typeof failOvaImportRequestSchema>;

export const ovaImportPathParamsSchema = z.object({ operationId: z.uuid() });

/**
 * The answer to a completion. `committed`: the master exists. `rejected`: it does not, and never will under this
 * operation; `deletePublished` says that nothing refers to the published archive, so the agent removes it.
 */
export const completeOvaImportResponseSchema = z.object({
  outcome: z.enum(['committed', 'rejected']),
  deletePublished: z.boolean(),
  operation: registrationOperationSchema,
});
export type CompleteOvaImportResponse = z.infer<typeof completeOvaImportResponseSchema>;
