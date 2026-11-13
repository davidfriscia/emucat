import {
  captureCommandSchema,
  captureReportSchema,
  captureAckSchema,
  captureRetrySchema,
} from './capture.js';
import { z } from 'zod';
import { agentVersionSchema } from './agents.js';
import {
  archiveDeletePayloadSchema,
  archiveDeleteResultPayloadSchema,
  localCopyRemoveAckPayloadSchema,
  localCopyRemovePayloadSchema,
  localCopyRemoveResultPayloadSchema,
} from './cleanup.js';
import {
  discoveryErrorPayloadSchema,
  discoveryRequestPayloadSchema,
  discoveryResultPayloadSchema,
} from './discovery.js';
import {
  executionSyncPayloadSchema,
  vmExecutionAckPayloadSchema,
  vmExecutionStatusPayloadSchema,
  vmLaunchPayloadSchema,
  vmStopPayloadSchema,
  vmVerifyAckPayloadSchema,
  vmVerifyPayloadSchema,
  vmVerifyResultPayloadSchema,
} from './execution.js';
import { mediaSyncStatusPayloadSchema } from './media.js';
import { workspaceDiscardPayloadSchema, workspaceDiscardResultPayloadSchema } from './versions.js';
import { architectureSchema, platformSchema } from './platform.js';
import {
  registrationAckPayloadSchema,
  registrationCancelPayloadSchema,
  registrationCleanupPayloadSchema,
  registrationErrorPayloadSchema,
  registrationProgressPayloadSchema,
  registrationRequestPayloadSchema,
  registrationResultPayloadSchema,
  registrationRetryCleanupPayloadSchema,
  registrationSyncPayloadSchema,
  repositoryHealthRequestPayloadSchema,
  repositoryHealthResultPayloadSchema,
} from './registration.js';
import {
  restoreAckPayloadSchema,
  restoreCancelPayloadSchema,
  restoreErrorPayloadSchema,
  restoreProgressPayloadSchema,
  restoreRequestPayloadSchema,
  restoreResultPayloadSchema,
  restoreSyncPayloadSchema,
} from './restore.js';
import { timestampSchema } from './version.js';

export * from './platform.js';

export const PROTOCOL_VERSION = 1;
export const AGENT_WS_PATH = '/api/v1/agent/ws';
export const AGENT_MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * Application-defined WebSocket close codes (the 4000-4999 range is reserved for this). The agent
 * reconnects after any close except `agentRevoked`, `superseded` and `unsupportedProtocolVersion`.
 */
export const WS_CLOSE_CODES = {
  invalidMessage: 4400,
  /** The credential was revoked. It will not work again. */
  agentRevoked: 4401,
  unsupportedProtocolVersion: 4406,
  /** No `agent.hello`, or no traffic at all, within the allowed time. */
  timedOut: 4408,
  /** A newer connection with the same identity replaced this one. */
  superseded: 4409,
  /** The peer sent far more messages than the protocol calls for. */
  tooManyMessages: 4429,
} as const;

/**
 * Outer shape of every message. It is checked first, on its own, so that a peer speaking a
 * different protocol version gets a precise answer even if its messages are otherwise unknown.
 */
export const envelopeSchema = z.object({
  protocolVersion: z.number().int().positive(),
  id: z.uuid(),
  correlationId: z.uuid().optional(),
  sentAt: timestampSchema,
  type: z.string().min(1).max(64),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

export const agentHelloPayloadSchema = z.object({
  agentVersion: agentVersionSchema,
  platform: platformSchema,
  architecture: architectureSchema,
});
export type AgentHelloPayload = z.infer<typeof agentHelloPayloadSchema>;

export const serverWelcomePayloadSchema = z.object({
  agentId: z.uuid(),
  heartbeatIntervalSeconds: z.number().int().positive(),
});
export type ServerWelcomePayload = z.infer<typeof serverWelcomePayloadSchema>;

export const serverErrorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
});
export type ServerErrorPayload = z.infer<typeof serverErrorPayloadSchema>;

const emptyPayloadSchema = z.object({}).strict();

/**
 * Messages an agent may send. None of them can make the server act on anything but its own report, and
 * a registration result only counts for an operation the server itself created for this agent.
 */
export const agentMessageSchema = z.discriminatedUnion('type', [
  envelopeSchema.extend({ type: z.literal('agent.hello'), payload: agentHelloPayloadSchema }),
  envelopeSchema.extend({ type: z.literal('agent.heartbeat'), payload: emptyPayloadSchema }),
  envelopeSchema.extend({ type: z.literal('agent.qemu_capture'), payload: captureReportSchema }),
  envelopeSchema.extend({
    type: z.literal('agent.discovery_result'),
    payload: discoveryResultPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.discovery_error'),
    payload: discoveryErrorPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.registration_sync'),
    payload: registrationSyncPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.registration_progress'),
    payload: registrationProgressPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.registration_result'),
    payload: registrationResultPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.registration_error'),
    payload: registrationErrorPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.registration_cleanup'),
    payload: registrationCleanupPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.repository_health_result'),
    payload: repositoryHealthResultPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.media_sync_status'),
    payload: mediaSyncStatusPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.restore_sync'),
    payload: restoreSyncPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.restore_progress'),
    payload: restoreProgressPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.restore_result'),
    payload: restoreResultPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.restore_error'),
    payload: restoreErrorPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.execution_sync'),
    payload: executionSyncPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.vm_execution_status'),
    payload: vmExecutionStatusPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.vm_verify_result'),
    payload: vmVerifyResultPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.workspace_discard_result'),
    payload: workspaceDiscardResultPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.local_copy_remove_result'),
    payload: localCopyRemoveResultPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.archive_delete_result'),
    payload: archiveDeleteResultPayloadSchema,
  }),
]);
export type AgentMessage = z.infer<typeof agentMessageSchema>;

/**
 * Messages a server may send. The commands name identities, and never a path or an address: the agent
 * validates each one against its own configuration.
 */
export const serverMessageSchema = z.discriminatedUnion('type', [
  envelopeSchema.extend({ type: z.literal('server.welcome'), payload: serverWelcomePayloadSchema }),
  envelopeSchema.extend({ type: z.literal('server.heartbeat_ack'), payload: emptyPayloadSchema }),
  envelopeSchema.extend({ type: z.literal('server.qemu_capture'), payload: captureCommandSchema }),
  envelopeSchema.extend({ type: z.literal('server.qemu_capture_ack'), payload: captureAckSchema }),
  envelopeSchema.extend({
    type: z.literal('server.qemu_capture_retry'),
    payload: captureRetrySchema,
  }),
  envelopeSchema.extend({ type: z.literal('server.error'), payload: serverErrorPayloadSchema }),
  envelopeSchema.extend({
    type: z.literal('server.discovery_request'),
    payload: discoveryRequestPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('server.registration_request'),
    payload: registrationRequestPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('server.registration_cancel'),
    payload: registrationCancelPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('server.registration_ack'),
    payload: registrationAckPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('server.repository_health_request'),
    payload: repositoryHealthRequestPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('server.registration_retry_cleanup'),
    payload: registrationRetryCleanupPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('server.restore_request'),
    payload: restoreRequestPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('server.restore_cancel'),
    payload: restoreCancelPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('server.restore_ack'),
    payload: restoreAckPayloadSchema,
  }),
  envelopeSchema.extend({ type: z.literal('server.vm_launch'), payload: vmLaunchPayloadSchema }),
  envelopeSchema.extend({ type: z.literal('server.vm_stop'), payload: vmStopPayloadSchema }),
  envelopeSchema.extend({
    type: z.literal('server.vm_execution_ack'),
    payload: vmExecutionAckPayloadSchema,
  }),
  envelopeSchema.extend({ type: z.literal('server.vm_verify'), payload: vmVerifyPayloadSchema }),
  envelopeSchema.extend({
    type: z.literal('server.vm_verify_ack'),
    payload: vmVerifyAckPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('server.workspace_discard'),
    payload: workspaceDiscardPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('server.local_copy_remove'),
    payload: localCopyRemovePayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('server.local_copy_remove_ack'),
    payload: localCopyRemoveAckPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('server.archive_delete'),
    payload: archiveDeletePayloadSchema,
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
