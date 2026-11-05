import {
  createPairingRequestSchema,
  PROTOCOL_VERSION,
  type CreatePairingRequest,
  type CreatePairingResponse,
  type PairingPollResponse,
} from '@emucat/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  createPairingRequest,
  PairingCapacityError,
  pollPairingRequest,
} from '../agents/pairing.js';
import { hashToken, parseBearerToken } from '../auth/agent-auth.js';
import { noStore, requireSameOrigin } from '../auth/guards.js';
import type { RateLimiter, RateLimitKey, RateLimitRule } from '../auth/rate-limiter.js';
import { ApiError } from '../errors.js';
import type { BrowserDependencies } from './browser.js';

export interface PairingRateLimits {
  /** Requests are cheap to make and cost a row, so they are limited whether or not they succeed. */
  createPerAddress: RateLimitRule;
  /** Failed polls: guesses at a secret. Every poll with a valid secret is given back. */
  invalidPollPerAddress: RateLimitRule;
  /** Polls of one request, far above what the advertised interval produces. */
  pollPerRequest: RateLimitRule;
  /** Wrong codes entered by an administrator, on any route. */
  codeAttemptsPerSession: RateLimitRule;
  codeAttemptsPerAddress: RateLimitRule;
}

const MINUTE = 60;

export const DEFAULT_PAIRING_RATE_LIMITS: PairingRateLimits = {
  createPerAddress: { maxAttempts: 20, windowSeconds: 15 * MINUTE },
  invalidPollPerAddress: { maxAttempts: 30, windowSeconds: 15 * MINUTE },
  pollPerRequest: { maxAttempts: 120, windowSeconds: MINUTE },
  codeAttemptsPerSession: { maxAttempts: 10, windowSeconds: 15 * MINUTE },
  codeAttemptsPerAddress: { maxAttempts: 30, windowSeconds: 15 * MINUTE },
};

export function enforceRateLimit(
  limiter: RateLimiter,
  reply: FastifyReply,
  keys: readonly RateLimitKey[],
): void {
  const decision = limiter.attempt(keys);
  if (!decision.allowed) {
    reply.header('retry-after', String(decision.retryAfterSeconds));
    throw new ApiError(429, 'rate_limited', 'Too many attempts. Try again later.');
  }
}

/**
 * What an agent uses before it has a credential. These are unauthenticated by nature: the agent proves
 * itself later, by knowing the secret it received here when a person approves it. Nothing on these
 * routes grants anything until then.
 */
export function registerAgentPairingRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
): void {
  const { pool, limiter, pairing, pairingRateLimits, publicOrigin } = dependencies;

  void parent.register(async (api) => {
    api.addHook('onRequest', requireSameOrigin(publicOrigin));
    api.addHook('onRequest', noStore);

    api.post(
      '/agent/pairing/requests',
      { schema: { body: createPairingRequestSchema } },
      async (request, reply): Promise<CreatePairingResponse> => {
        const body = request.body as CreatePairingRequest;
        enforceRateLimit(limiter, reply, [
          { key: `pairing-create:ip:${request.ip}`, rule: pairingRateLimits.createPerAddress },
        ]);
        if (body.protocolVersion !== PROTOCOL_VERSION) {
          throw new ApiError(
            400,
            'unsupported_protocol_version',
            `This server speaks protocol ${PROTOCOL_VERSION}`,
          );
        }
        try {
          const created = await createPairingRequest(pool, body, request.ip, pairing);
          reply.status(201);
          return created;
        } catch (error) {
          if (error instanceof PairingCapacityError) {
            reply.header('retry-after', String(pairing.requestTtlSeconds));
            throw new ApiError(429, 'pairing_capacity', 'Too many pairing requests are waiting');
          }
          throw error;
        }
      },
    );

    api.post('/agent/pairing/poll', async (request, reply): Promise<PairingPollResponse> => {
      const addressKeys = [
        { key: `pairing-poll:ip:${request.ip}`, rule: pairingRateLimits.invalidPollPerAddress },
      ];
      enforceRateLimit(limiter, reply, addressKeys);

      const invalid = () =>
        new ApiError(401, 'invalid_pairing_secret', 'Unknown or invalid pairing secret');
      const secret = parseBearerToken(request.headers.authorization);
      if (!secret) throw invalid();

      // Checked first: a poll that is refused must not also use up a credential nobody would receive.
      enforceRateLimit(limiter, reply, [
        {
          key: `pairing-poll:secret:${hashToken(secret).toString('hex')}`,
          rule: pairingRateLimits.pollPerRequest,
        },
      ]);
      const response = await pollPairingRequest(pool, secret);
      if (!response) throw invalid();

      limiter.release(addressKeys);
      return response;
    });
  });
}
