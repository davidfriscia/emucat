import { z } from 'zod';
import { executionModeSchema } from './execution.js';
import { vmNameSchema } from './vm-name.js';
import { sha256HexSchema, timestampSchema } from './version.js';

export const captureRequestSchema = z.strictObject({ requestId: z.uuid() });
export const captureCommandSchema = z.strictObject({
  operationId: z.uuid(),
  sessionId: z.uuid(),
  emulatorType: z.literal('qemu'),
  vmName: vmNameSchema,
});
export const captureReportSchema = captureCommandSchema.extend({
  state: z.enum(['capturing', 'uploading', 'failed']),
  sha256: sha256HexSchema.nullable(),
  uncertain: z.boolean(),
  code: z.string().max(64).nullable(),
  message: z.string().max(1024).nullable(),
});
export const captureAckSchema = z.strictObject({
  operationId: z.uuid(),
  sha256: sha256HexSchema,
  mediaId: z.uuid(),
});
export const captureRetrySchema = z.strictObject({
  operationId: z.uuid(),
  attempt: z.number().int().min(1).max(3),
});
export const captureOperationSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  sessionId: z.uuid(),
  agentId: z.uuid(),
  emulatorType: z.literal('qemu'),
  vmName: z.string(),
  mode: executionModeSchema,
  versionId: z.uuid().nullable(),
  state: z.enum(['requested', 'capturing', 'uploading', 'completed', 'failed']),
  sha256: sha256HexSchema.nullable(),
  mediaId: z.uuid().nullable(),
  uncertain: z.boolean(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  retryAttempts: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const captureStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  operation: captureOperationSchema.nullable(),
});
export type CaptureCommand = z.infer<typeof captureCommandSchema>;
export type CaptureReport = z.infer<typeof captureReportSchema>;
export type CaptureOperation = z.infer<typeof captureOperationSchema>;
export type CaptureStatus = z.infer<typeof captureStatusSchema>;
