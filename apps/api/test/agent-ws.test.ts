import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { AGENT_WS_PATH, PROTOCOL_VERSION, serverMessageSchema } from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { parseBearerToken } from '../src/auth/agent-auth.js';

const VALID_TOKEN = 'valid-agent-token-for-tests';
const AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f63';

let app: FastifyInstance;
let url: string;

beforeAll(async () => {
  app = await buildApp({
    readiness: async () => ({ database: 'ok', migrations: 'ok' }),
    authenticateAgent: async (token) => (token === VALID_TOKEN ? { agentId: AGENT_ID } : null),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}${AGENT_WS_PATH}`;
});

afterAll(async () => {
  await app.close();
});

function rejectedStatus(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.on('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.on('open', () => reject(new Error('Socket opened without authentication')));
    socket.on('error', () => undefined);
  });
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket: WebSocket) {
  return new Promise<ReturnType<typeof serverMessageSchema.parse>>((resolve) => {
    socket.once('message', (data) =>
      resolve(serverMessageSchema.parse(JSON.parse(data.toString()))),
    );
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

function envelope(type: string, payload: unknown, protocolVersion = PROTOCOL_VERSION) {
  return JSON.stringify({
    protocolVersion,
    id: randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  });
}

describe('agent WebSocket authentication', () => {
  it('rejects a connection without credentials before the handshake', async () => {
    await expect(rejectedStatus({})).resolves.toBe(401);
  });

  it('rejects an unknown token', async () => {
    await expect(
      rejectedStatus({ authorization: 'Bearer unknown-token-that-is-long' }),
    ).resolves.toBe(401);
  });

  it.each(['Basic abc', 'Bearer', 'Bearer short', VALID_TOKEN])(
    'rejects the malformed header %j',
    async (authorization) => {
      await expect(rejectedStatus({ authorization })).resolves.toBe(401);
    },
  );

  it('parses bearer tokens strictly', () => {
    expect(parseBearerToken(`Bearer ${VALID_TOKEN}`)).toBe(VALID_TOKEN);
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken(`bearer ${VALID_TOKEN} extra`)).toBeNull();
  });
});

describe('agent WebSocket messages', () => {
  it('answers hello with a welcome tied to the request', async () => {
    const socket = await connect();
    const hello = envelope('agent.hello', {
      agentVersion: '0.1.0',
      platform: 'windows',
      architecture: 'x86_64',
    });
    const reply = nextMessage(socket);
    socket.send(hello);
    const message = await reply;
    expect(message.type).toBe('server.welcome');
    expect(message.correlationId).toBe(JSON.parse(hello).id);
    expect(message.payload).toMatchObject({ agentId: AGENT_ID });
    socket.close();
  });

  it('acknowledges a heartbeat', async () => {
    const socket = await connect();
    const reply = nextMessage(socket);
    socket.send(envelope('agent.heartbeat', {}));
    expect((await reply).type).toBe('server.heartbeat_ack');
    socket.close();
  });

  it('refuses unknown message types, including commands', async () => {
    const socket = await connect();
    const reply = nextMessage(socket);
    socket.send(envelope('vm.launch', { vmName: 'x' }));
    const message = await reply;
    expect(message.type).toBe('server.error');
    expect(message.payload).toMatchObject({ code: 'unsupported_message' });
    socket.close();
  });

  it('closes the connection on an unsupported protocol version', async () => {
    const socket = await connect();
    const reply = nextMessage(socket);
    const closeCode = closed(socket);
    socket.send(envelope('agent.hello', {}, PROTOCOL_VERSION + 1));
    expect((await reply).payload).toMatchObject({ code: 'unsupported_protocol_version' });
    await expect(closeCode).resolves.toBe(4406);
  });

  it.each(['not json', '{}', '[]', 'null'])('closes the connection on %j', async (raw) => {
    const socket = await connect();
    const closeCode = closed(socket);
    socket.send(raw);
    await expect(closeCode).resolves.toBe(4400);
  });

  it('closes the connection on binary data', async () => {
    const socket = await connect();
    const closeCode = closed(socket);
    socket.send(Buffer.from([1, 2, 3]));
    await expect(closeCode).resolves.toBe(4400);
  });
});
