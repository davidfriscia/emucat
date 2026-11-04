import { z } from 'zod';
import { emulatorTypeSchema } from './emulator.js';
import { sha256HexSchema, timestampSchema, vmVersionIdSchema } from './version.js';
import { vmNameSchema } from './vm-name.js';

/** Declared for future milestones. No operation is implemented yet. */
export const OPERATION_TYPES = [
  'discover_vms',
  'register_vm',
  'download_version',
  'verify_content',
  'launch_vm',
  'stop_vm',
  'create_snapshot',
  'upload_snapshot',
  'upload_media',
  'remove_local_copy',
] as const;
export const operationTypeSchema = z.enum(OPERATION_TYPES);
export type OperationType = z.infer<typeof operationTypeSchema>;

export const OPERATION_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const operationStateSchema = z.enum(OPERATION_STATES);
export type OperationState = z.infer<typeof operationStateSchema>;

/** What an agent is currently doing with its local copy of a VM. */
export const EXECUTION_STATES = [
  'unknown',
  'absent',
  'idle',
  'downloading',
  'extracting',
  'verifying',
  'starting',
  'running',
  'stopping',
  'archiving',
  'uploading',
  'error',
] as const;
export const executionStateSchema = z.enum(EXECUTION_STATES);
export type ExecutionState = z.infer<typeof executionStateSchema>;

export const CONTENT_STATUSES = ['unverified', 'verified', 'modified'] as const;
export const contentStatusSchema = z.enum(CONTENT_STATUSES);
export type ContentStatus = z.infer<typeof contentStatusSchema>;

export const pendingOperationSchema = z.object({
  id: z.uuid(),
  type: operationTypeSchema,
  state: operationStateSchema,
  requestedAt: timestampSchema,
});
export type PendingOperation = z.infer<typeof pendingOperationSchema>;

export const agentVmStateSchema = z.object({
  agentId: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
  localSourceVersionId: vmVersionIdSchema.nullable(),
  executionState: executionStateSchema,
  contentStatus: contentStatusSchema,
  lastVerifiedAt: timestampSchema.nullable(),
  lastVerifiedSha256: sha256HexSchema.nullable(),
  pendingOperations: z.array(pendingOperationSchema),
});
export type AgentVmState = z.infer<typeof agentVmStateSchema>;

/**
 * A local copy can change while its agent is offline, so a verification only counts if it happened
 * after the agent's most recent connection.
 */
export function isLocalContentTrusted(
  state: Pick<AgentVmState, 'contentStatus' | 'lastVerifiedAt'>,
  lastConnectedAt: string,
): boolean {
  if (state.contentStatus !== 'verified' || state.lastVerifiedAt === null) return false;
  return Date.parse(state.lastVerifiedAt) >= Date.parse(lastConnectedAt);
}
