import { z } from 'zod';
import { architectureSchema, platformSchema } from './platform.js';
import { timestampSchema } from './version.js';

export const AGENT_NAME_MAX_LENGTH = 128;
export const PAIRING_CODE_LENGTH = 8;

/** Crockford's base32: no I, L, O or U, so that a code survives being read aloud or retyped. */
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const SEPARATORS = /[\s-]/g;
const CANONICAL_CODE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

/**
 * The canonical form of what somebody typed, or `null` if it cannot be a code. Case and separators
 * do not matter, and letters that look like digits are read as those digits. The agent implements the
 * same rule, and both are tested against `fixtures/pairing-codes.json`.
 */
export function normalizePairingCode(input: string): string | null {
  const code = input.replace(SEPARATORS, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  return CANONICAL_CODE.test(code) ? code : null;
}

/** `ABCD-EFGH`, the way a code is shown to people. */
export function formatPairingCode(canonical: string): string {
  const middle = PAIRING_CODE_LENGTH / 2;
  return `${canonical.slice(0, middle)}-${canonical.slice(middle)}`;
}

/** Deliberately loose on shape: a wrong guess is reported as wrong, not as badly formed. */
export const pairingCodeInputSchema = z.string().min(1).max(32);

const CONTROL_CHARACTERS = /\p{Cc}/u;

/** A label chosen by whoever runs the agent. It is shown to the administrator who approves it. */
export const agentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_NAME_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTERS.test(value), 'Control characters are not allowed');

export const agentVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\x21-\x7e]+$/, 'Use printable ASCII without spaces');

// What the agent sends and receives while it has no credential.

export const createPairingRequestSchema = z.strictObject({
  name: agentNameSchema,
  platform: platformSchema,
  architecture: architectureSchema,
  agentVersion: agentVersionSchema,
  protocolVersion: z.number().int().positive(),
});
export type CreatePairingRequest = z.infer<typeof createPairingRequestSchema>;

export const createPairingResponseSchema = z.object({
  /** To be shown to a person, who enters it in the web app. */
  pairingCode: z.string(),
  /** Known only to the agent, which sends it as a bearer token when polling. Never shown. */
  pollingSecret: z.string(),
  expiresAt: timestampSchema,
  pollIntervalSeconds: z.number().int().positive(),
});
export type CreatePairingResponse = z.infer<typeof createPairingResponseSchema>;

export const pairingPollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), expiresAt: timestampSchema }),
  /** Sent exactly once. After this, the same request answers `consumed`. */
  z.object({ status: z.literal('approved'), agentId: z.uuid(), credential: z.string() }),
  z.object({ status: z.literal('rejected') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('consumed') }),
]);
export type PairingPollResponse = z.infer<typeof pairingPollResponseSchema>;

// What an administrator sees.

export const PAIRING_REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'completed',
] as const;
export const pairingRequestStatusSchema = z.enum(PAIRING_REQUEST_STATUSES);
export type PairingRequestStatus = z.infer<typeof pairingRequestStatusSchema>;

export const pairingRequestReviewSchema = z.object({
  id: z.uuid(),
  status: pairingRequestStatusSchema,
  name: z.string(),
  platform: platformSchema,
  architecture: architectureSchema,
  agentVersion: z.string(),
  protocolVersion: z.number().int().positive(),
  /** The address the request came from, so that it can be told apart from a look-alike. */
  requestedFrom: z.string(),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  /** Set once the agent has collected its credential. */
  agentId: z.uuid().nullable(),
});
export type PairingRequestReview = z.infer<typeof pairingRequestReviewSchema>;

export const pairingRequestListResponseSchema = z.object({
  requests: z.array(pairingRequestReviewSchema),
});
export type PairingRequestListResponse = z.infer<typeof pairingRequestListResponseSchema>;

export const pairingLookupRequestSchema = z.strictObject({ code: pairingCodeInputSchema });
export type PairingLookupRequest = z.infer<typeof pairingLookupRequestSchema>;

/** Approving needs the code again: knowing a request exists is not enough to authorize it. */
export const approvePairingRequestSchema = z.strictObject({ code: pairingCodeInputSchema });
export type ApprovePairingRequest = z.infer<typeof approvePairingRequestSchema>;

export const AGENT_PAIRING_STATUSES = ['paired', 'revoked'] as const;
export const agentPairingStatusSchema = z.enum(AGENT_PAIRING_STATUSES);
export type AgentPairingStatus = z.infer<typeof agentPairingStatusSchema>;

export const agentSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  platform: platformSchema.nullable(),
  architecture: architectureSchema.nullable(),
  agentVersion: z.string().nullable(),
  protocolVersion: z.number().int().positive().nullable(),
  pairingStatus: agentPairingStatusSchema,
  /** True while this API process holds a live connection on which the agent has said hello. */
  online: z.boolean(),
  ownerDisplayName: z.string().nullable(),
  pairedAt: timestampSchema.nullable(),
  lastConnectedAt: timestampSchema.nullable(),
  lastSeenAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
});
export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const agentListResponseSchema = z.object({ agents: z.array(agentSummarySchema) });
export type AgentListResponse = z.infer<typeof agentListResponseSchema>;

export const agentPathParamsSchema = z.object({ agentId: z.uuid() });
export const pairingRequestPathParamsSchema = z.object({ requestId: z.uuid() });
