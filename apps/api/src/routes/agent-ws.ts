import { randomUUID } from 'node:crypto';
import {
  AGENT_WS_PATH,
  API_PREFIX,
  agentMessageSchema,
  envelopeSchema,
  PROTOCOL_VERSION,
  WS_CLOSE_CODES,
  type ServerMessage,
} from '@emucat/contracts';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { parseBearerToken, type AgentAuthenticator } from '../auth/agent-auth.js';
import { errorBody } from '../errors.js';

const HEARTBEAT_INTERVAL_SECONDS = 30;

declare module 'fastify' {
  interface FastifyRequest {
    agent: { agentId: string } | null;
  }
}

type ServerMessageBody = Pick<ServerMessage, 'type' | 'payload'>;

function send(socket: WebSocket, message: ServerMessageBody, correlationId?: string): void {
  socket.send(
    JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      ...(correlationId ? { correlationId } : {}),
      sentAt: new Date().toISOString(),
      ...message,
    }),
  );
}

function sendError(socket: WebSocket, code: string, message: string, correlationId?: string): void {
  send(socket, { type: 'server.error', payload: { code, message } }, correlationId);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function handleMessage(
  socket: WebSocket,
  raw: string,
  agentId: string,
  log: FastifyBaseLogger,
): void {
  const envelope = envelopeSchema.safeParse(parseJson(raw));
  if (!envelope.success) {
    sendError(socket, 'invalid_message', 'Message is not a valid envelope');
    socket.close(WS_CLOSE_CODES.invalidMessage, 'invalid message');
    return;
  }
  const { id, protocolVersion, type } = envelope.data;

  if (protocolVersion !== PROTOCOL_VERSION) {
    sendError(socket, 'unsupported_protocol_version', `Server speaks ${PROTOCOL_VERSION}`, id);
    socket.close(WS_CLOSE_CODES.unsupportedProtocolVersion, 'unsupported protocol version');
    return;
  }

  const message = agentMessageSchema.safeParse(envelope.data);
  if (!message.success) {
    // Unknown types are refused rather than ignored. Nothing here can trigger a control action.
    log.warn({ agentId, type }, 'Rejected agent message');
    sendError(socket, 'unsupported_message', 'Unsupported or malformed message', id);
    return;
  }

  switch (message.data.type) {
    case 'agent.hello':
      log.info({ agentId, ...message.data.payload }, 'Agent said hello');
      send(
        socket,
        {
          type: 'server.welcome',
          payload: { agentId, heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS },
        },
        id,
      );
      break;
    case 'agent.heartbeat':
      send(socket, { type: 'server.heartbeat_ack', payload: {} }, id);
      break;
  }
}

/**
 * Agent connection skeleton. Authentication happens in `preValidation`, before the WebSocket
 * handshake, so an unauthenticated client gets a plain 401 and never has an open socket.
 */
export function registerAgentWebSocket(
  app: FastifyInstance,
  authenticate: AgentAuthenticator,
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
      request.log.info({ agentId }, 'Agent connected');
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          sendError(socket, 'invalid_message', 'Binary messages are not supported');
          socket.close(WS_CLOSE_CODES.invalidMessage, 'binary message');
          return;
        }
        handleMessage(socket, data.toString(), agentId, request.log);
      });
      socket.on('close', (code) => request.log.info({ agentId, code }, 'Agent disconnected'));
      socket.on('error', (error) =>
        request.log.warn({ agentId, err: error }, 'Agent socket error'),
      );
    },
  );
}
