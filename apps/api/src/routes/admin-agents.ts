import {
  agentPathParamsSchema,
  approvePairingRequestSchema,
  pairingLookupRequestSchema,
  pairingRequestPathParamsSchema,
  type AgentListResponse,
  type AgentSummary,
  type ApprovePairingRequest,
  type DiscoveryOperation,
  type DiscoveryStateResponse,
  type PairingLookupRequest,
  type PairingRequestListResponse,
  type PairingRequestReview,
} from '@emucat/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import type { DiscoveryRecord } from '../agents/discovery.js';
import type { AgentHub } from '../agents/hub.js';
import {
  decidePairingRequest,
  findPairingRequestByCode,
  getPairingRequest,
  listPendingPairingRequests,
  type PairingDecisionOutcome,
} from '../agents/pairing.js';
import {
  getAgent,
  listAgents,
  registeredVmKeys,
  revokeAgent,
  vmIdentityKey,
} from '../agents/repository.js';
import {
  noStore,
  requireAdmin,
  requireSameOrigin,
  requireSession,
  sessionOf,
} from '../auth/guards.js';
import type { RateLimitKey } from '../auth/rate-limiter.js';
import { ApiError } from '../errors.js';
import { enforceRateLimit } from './agent-pairing.js';
import type { BrowserDependencies } from './browser.js';

const agentNotFound = () => new ApiError(404, 'agent_not_found', 'Agent not found');
const invalidCode = () =>
  new ApiError(404, 'pairing_code_invalid', 'That pairing code is not valid. Check it and retry.');
const pairingExpired = () =>
  new ApiError(410, 'pairing_expired', 'This pairing request has expired. Start pairing again.');
const alreadyDecided = () =>
  new ApiError(409, 'pairing_already_decided', 'This pairing request was already decided.');

async function toOperation(pool: Pool, record: DiscoveryRecord): Promise<DiscoveryOperation> {
  const registered = await registeredVmKeys(pool, record.vms);
  return {
    id: record.id,
    agentId: record.agentId,
    status: record.status,
    startedAt: record.startedAt.toISOString(),
    finishedAt: record.finishedAt?.toISOString() ?? null,
    failure: record.failure,
    hostPlatform: record.hostPlatform,
    emulators: record.emulators,
    vms: record.vms.map((vm) => ({ ...vm, registered: registered.has(vmIdentityKey(vm)) })),
    skipped: record.skipped,
  };
}

function reviewOrThrow(outcome: PairingDecisionOutcome): PairingRequestReview {
  switch (outcome.outcome) {
    case 'decided':
      return outcome.request;
    case 'not_found':
    case 'wrong_code':
      throw invalidCode();
    case 'expired':
      throw pairingExpired();
    case 'already_decided':
      throw alreadyDecided();
  }
}

/**
 * Administration of agents. Discovery results and presence come from the hub, and nothing here writes
 * to `virtual_machines` or `vm_versions`: a discovered VM is an observation, not a catalog entry.
 */
export function registerAdminAgentRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
  hub: AgentHub,
): void {
  const { pool, limiter, pairing, pairingRateLimits, session, cookie, publicOrigin } = dependencies;
  const isOnline = (agentId: string) => hub.isOnline(agentId);

  /** Counts one try at a code. A correct one is given back, so only wrong guesses use up the limit. */
  const codeAttemptKeys = (request: FastifyRequest): RateLimitKey[] => [
    {
      key: `pairing-code:session:${sessionOf(request).id}`,
      rule: pairingRateLimits.codeAttemptsPerSession,
    },
    { key: `pairing-code:ip:${request.ip}`, rule: pairingRateLimits.codeAttemptsPerAddress },
  ];

  void parent.register(
    async (api) => {
      api.addHook('onRequest', requireSameOrigin(publicOrigin));
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', requireSession({ pool, session, cookie }));
      api.addHook('onRequest', requireAdmin);

      api.get('/agents', async (): Promise<AgentListResponse> => {
        return { agents: await listAgents(pool, isOnline) };
      });

      api.get(
        '/agents/:agentId',
        { schema: { params: agentPathParamsSchema } },
        async (request): Promise<AgentSummary> => {
          const { agentId } = request.params as z.infer<typeof agentPathParamsSchema>;
          const agent = await getAgent(pool, agentId, isOnline);
          if (!agent) throw agentNotFound();
          return agent;
        },
      );

      api.post(
        '/agents/:agentId/revoke',
        { schema: { params: agentPathParamsSchema } },
        async (request): Promise<AgentSummary> => {
          const { agentId } = request.params as z.infer<typeof agentPathParamsSchema>;
          // The database first: once this returns, no new connection can authenticate.
          const revokedNow = await revokeAgent(pool, agentId);
          hub.revoke(agentId);
          const agent = await getAgent(pool, agentId, isOnline);
          if (!agent) throw agentNotFound();
          if (revokedNow) request.log.info({ agentId }, 'Agent revoked');
          return agent;
        },
      );

      api.get(
        '/agents/:agentId/discovery',
        { schema: { params: agentPathParamsSchema } },
        async (request): Promise<DiscoveryStateResponse> => {
          const { agentId } = request.params as z.infer<typeof agentPathParamsSchema>;
          const agent = await getAgent(pool, agentId, isOnline);
          if (!agent) throw agentNotFound();
          const record = hub.discovery.get(agentId);
          return { operation: record ? await toOperation(pool, record) : null };
        },
      );

      api.post(
        '/agents/:agentId/discovery',
        { schema: { params: agentPathParamsSchema } },
        async (request, reply: FastifyReply): Promise<DiscoveryOperation> => {
          const { agentId } = request.params as z.infer<typeof agentPathParamsSchema>;
          const agent = await getAgent(pool, agentId, isOnline);
          if (!agent) throw agentNotFound();
          if (agent.pairingStatus === 'revoked') {
            throw new ApiError(409, 'agent_revoked', 'This agent has been revoked.');
          }
          const record = hub.startDiscovery(agentId);
          if (!record) throw new ApiError(409, 'agent_offline', 'This agent is offline.');
          reply.status(202);
          return toOperation(pool, record);
        },
      );

      api.get('/agent-pairing/requests', async (): Promise<PairingRequestListResponse> => {
        return { requests: await listPendingPairingRequests(pool) };
      });

      api.get(
        '/agent-pairing/requests/:requestId',
        { schema: { params: pairingRequestPathParamsSchema } },
        async (request): Promise<PairingRequestReview> => {
          const { requestId } = request.params as z.infer<typeof pairingRequestPathParamsSchema>;
          const found = await getPairingRequest(pool, requestId);
          if (!found) throw new ApiError(404, 'pairing_not_found', 'Pairing request not found');
          return found;
        },
      );

      // A POST, so that a code never appears in a URL, a log or the browser's history.
      api.post(
        '/agent-pairing/lookup',
        { schema: { body: pairingLookupRequestSchema } },
        async (request, reply): Promise<PairingRequestReview> => {
          const { code } = request.body as PairingLookupRequest;
          const keys = codeAttemptKeys(request);
          enforceRateLimit(limiter, reply, keys);
          const found = await findPairingRequestByCode(pool, code);
          if (!found) throw invalidCode();
          limiter.release(keys);
          if (found.status === 'expired') throw pairingExpired();
          if (found.status !== 'pending') throw alreadyDecided();
          return found;
        },
      );

      api.post(
        '/agent-pairing/requests/:requestId/approve',
        { schema: { params: pairingRequestPathParamsSchema, body: approvePairingRequestSchema } },
        async (request, reply): Promise<PairingRequestReview> => {
          const { requestId } = request.params as z.infer<typeof pairingRequestPathParamsSchema>;
          const { code } = request.body as ApprovePairingRequest;
          const keys = codeAttemptKeys(request);
          enforceRateLimit(limiter, reply, keys);
          const outcome = await decidePairingRequest(
            pool,
            requestId,
            { action: 'approve', code },
            sessionOf(request).user.id,
            pairing,
          );
          if (outcome.outcome !== 'wrong_code' && outcome.outcome !== 'not_found') {
            limiter.release(keys);
          }
          const decided = reviewOrThrow(outcome);
          request.log.info({ requestId, name: decided.name }, 'Pairing request approved');
          return decided;
        },
      );

      // Refusing grants nothing, so it needs no code: an administrator can clear a request they do
      // not recognize, without ever having seen its code.
      api.post(
        '/agent-pairing/requests/:requestId/reject',
        { schema: { params: pairingRequestPathParamsSchema } },
        async (request): Promise<PairingRequestReview> => {
          const { requestId } = request.params as z.infer<typeof pairingRequestPathParamsSchema>;
          const outcome = await decidePairingRequest(
            pool,
            requestId,
            { action: 'reject' },
            sessionOf(request).user.id,
            pairing,
          );
          const decided = reviewOrThrow(outcome);
          request.log.info({ requestId, name: decided.name }, 'Pairing request rejected');
          return decided;
        },
      );
    },
    { prefix: '/admin' },
  );
}
