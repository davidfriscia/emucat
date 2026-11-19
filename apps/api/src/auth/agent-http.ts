import { MEDIA_PROTOCOL_HEADER, PROTOCOL_VERSION } from '@emucat/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import { parseBearerToken, type AgentAuthenticator } from './agent-auth.js';

/**
 * The guard of every HTTP route an agent calls: its bearer credential, and nothing else, says who it is, and the
 * request must speak this server's protocol. A browser session means nothing here. It runs before a byte of the
 * body is read.
 */
export function agentHttpGuard(authenticate: AgentAuthenticator) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = parseBearerToken(request.headers.authorization);
    const principal = token ? await authenticate(token).catch(() => undefined) : null;
    if (principal === undefined) {
      // The database is away, which says nothing about the credential.
      throw new ApiError(503, 'temporarily_unavailable', 'Try again shortly');
    }
    if (!principal) {
      reply.header('www-authenticate', 'Bearer');
      throw new ApiError(401, 'unauthorized', 'Authentication required');
    }
    request.agent = principal;
    const version = request.headers[MEDIA_PROTOCOL_HEADER];
    if (version !== String(PROTOCOL_VERSION)) {
      throw new ApiError(
        400,
        'unsupported_protocol_version',
        `This server speaks protocol ${PROTOCOL_VERSION}`,
      );
    }
  };
}

/** The authenticated agent of a guarded route. */
export function agentIdOf(request: FastifyRequest): string {
  const agentId = request.agent?.agentId;
  if (!agentId) throw new Error('Route is missing the agent guard');
  return agentId;
}
