import { AGENT_WS_PATH, API_PREFIX } from '@emucat/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AgentHub } from '../agents/hub.js';
import { parseBearerToken, type AgentAuthenticator } from '../auth/agent-auth.js';
import { errorBody } from '../errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    agent: { agentId: string } | null;
  }
}

/**
 * The agent connection. Authentication happens in `preValidation`, before the WebSocket handshake, so
 * an unauthenticated client gets a plain 401 and never has an open socket. Everything after the
 * handshake is the hub's.
 */
export function registerAgentWebSocket(
  app: FastifyInstance,
  authenticate: AgentAuthenticator,
  hub: AgentHub,
): void {
  app.decorateRequest('agent', null);

  const path = AGENT_WS_PATH.slice(API_PREFIX.length);
  app.get(
    path,
    {
      websocket: true,
      preValidation: async (request: FastifyRequest, reply) => {
        const token = parseBearerToken(request.headers.authorization);
        const principal = token ? await authenticate(token) : null;
        if (!principal) {
          return reply
            .status(401)
            .header('www-authenticate', 'Bearer')
            .send(errorBody(request, 'unauthorized', 'Authentication required'));
        }
        request.agent = principal;
        return undefined;
      },
    },
    (socket, request) => {
      const agentId = request.agent?.agentId;
      if (!agentId) {
        // Unreachable by construction, but a socket must never run without an identity.
        socket.close(1008, 'unauthenticated');
        return;
      }
      hub.attach(socket, agentId, request.log);
    },
  );
}
