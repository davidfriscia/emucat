import { z } from 'zod';
import { agentVersionSchema } from './agents.js';
import {
  discoveryErrorPayloadSchema,
  discoveryRequestPayloadSchema,
  discoveryResultPayloadSchema,
} from './discovery.js';
import { architectureSchema, platformSchema } from './platform.js';
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

/** Messages an agent may send. None of them can make the server act on anything but its own report. */
export const agentMessageSchema = z.discriminatedUnion('type', [
  envelopeSchema.extend({ type: z.literal('agent.hello'), payload: agentHelloPayloadSchema }),
  envelopeSchema.extend({ type: z.literal('agent.heartbeat'), payload: emptyPayloadSchema }),
  envelopeSchema.extend({
    type: z.literal('agent.discovery_result'),
    payload: discoveryResultPayloadSchema,
  }),
  envelopeSchema.extend({
    type: z.literal('agent.discovery_error'),
    payload: discoveryErrorPayloadSchema,
  }),
]);
export type AgentMessage = z.infer<typeof agentMessageSchema>;

/** Messages a server may send. `server.discovery_request` is the only command, and it is read-only. */
export const serverMessageSchema = z.discriminatedUnion('type', [
  envelopeSchema.extend({ type: z.literal('server.welcome'), payload: serverWelcomePayloadSchema }),
  envelopeSchema.extend({ type: z.literal('server.heartbeat_ack'), payload: emptyPayloadSchema }),
  envelopeSchema.extend({ type: z.literal('server.error'), payload: serverErrorPayloadSchema }),
  envelopeSchema.extend({
    type: z.literal('server.discovery_request'),
    payload: discoveryRequestPayloadSchema,
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
