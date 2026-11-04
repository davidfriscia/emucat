import { z } from 'zod';
import { timestampSchema } from './version.js';

export const PROTOCOL_VERSION = 1;
export const AGENT_WS_PATH = '/api/v1/agent/ws';
export const AGENT_MAX_MESSAGE_BYTES = 64 * 1024;

/** Application-defined WebSocket close codes (the 4000-4999 range is reserved for this). */
export const WS_CLOSE_CODES = {
  invalidMessage: 4400,
  unsupportedProtocolVersion: 4406,
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

export const PLATFORMS = ['windows', 'macos', 'linux'] as const;
export const platformSchema = z.enum(PLATFORMS);
export const ARCHITECTURES = ['x86_64', 'aarch64'] as const;
export const architectureSchema = z.enum(ARCHITECTURES);

export const agentHelloPayloadSchema = z.object({
  agentVersion: z.string().min(1).max(64),
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

/** Messages an agent may send. There are deliberately no control commands in this version. */
export const agentMessageSchema = z.discriminatedUnion('type', [
  envelopeSchema.extend({ type: z.literal('agent.hello'), payload: agentHelloPayloadSchema }),
  envelopeSchema.extend({ type: z.literal('agent.heartbeat'), payload: emptyPayloadSchema }),
]);
export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  envelopeSchema.extend({ type: z.literal('server.welcome'), payload: serverWelcomePayloadSchema }),
  envelopeSchema.extend({ type: z.literal('server.heartbeat_ack'), payload: emptyPayloadSchema }),
  envelopeSchema.extend({ type: z.literal('server.error'), payload: serverErrorPayloadSchema }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
