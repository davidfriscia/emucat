import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  AGENT_WS_PATH,
  createPairingResponseSchema,
  pairingPollResponseSchema,
  PROTOCOL_VERSION,
  serverMessageSchema,
  type CreatePairingResponse,
  type PairingPollResponse,
  type ServerMessage,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import WebSocket from 'ws';
import type { DEFAULT_PAIRING_RATE_LIMITS } from '../src/routes/agent-pairing.js';
import { HOST, ORIGIN, TestClient } from './browser-app.js';

/** Limits no test reaches by accident. The tests of rate limiting set their own. */
export const GENEROUS_RATE_LIMITS: typeof DEFAULT_PAIRING_RATE_LIMITS = {
  createPerAddress: { maxAttempts: 10_000, windowSeconds: 60 },
  invalidPollPerAddress: { maxAttempts: 10_000, windowSeconds: 60 },
  pollPerRequest: { maxAttempts: 10_000, windowSeconds: 60 },
  codeAttemptsPerSession: { maxAttempts: 10_000, windowSeconds: 60 },
  codeAttemptsPerAddress: { maxAttempts: 10_000, windowSeconds: 60 },
};

export const AGENT_DETAILS = {
  name: 'Desk PC',
  platform: 'windows',
  architecture: 'x86_64',
  agentVersion: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
} as const;

export const HELLO = {
  agentVersion: '0.2.0',
  platform: 'windows',
  architecture: 'x86_64',
} as const;

/** What an unpaired agent does first. */
export async function requestPairing(
  app: FastifyInstance,
  details: object = {},
): Promise<CreatePairingResponse> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/agent/pairing/requests',
    headers: { host: HOST },
    payload: { ...AGENT_DETAILS, ...details },
  });
  if (response.statusCode !== 201) throw new Error(`Request failed: ${response.body}`);
  return createPairingResponseSchema.parse(response.json());
}

export async function pollRaw(app: FastifyInstance, secret: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/agent/pairing/poll',
    headers: { host: HOST, authorization: `Bearer ${secret}` },
  });
}

export async function poll(app: FastifyInstance, secret: string): Promise<PairingPollResponse> {
  const response = await pollRaw(app, secret);
  if (response.statusCode !== 200) throw new Error(`Poll failed: ${response.body}`);
  return pairingPollResponseSchema.parse(response.json());
}

export async function lookUp(admin: TestClient, code: string) {
  return admin.request({ method: 'POST', url: '/admin/agent-pairing/lookup', payload: { code } });
}

export async function approve(admin: TestClient, requestId: string, code: string) {
  return admin.request({
    method: 'POST',
    url: `/admin/agent-pairing/requests/${requestId}/approve`,
    payload: { code },
  });
}

export async function reject(admin: TestClient, requestId: string) {
  return admin.request({
    method: 'POST',
    url: `/admin/agent-pairing/requests/${requestId}/reject`,
  });
}

export interface PairedAgent {
  agentId: string;
  credential: string;
}

/** The whole flow, ending with an agent that holds a real credential. */
export async function pairAgent(
  app: FastifyInstance,
  admin: TestClient,
  details: object = {},
): Promise<PairedAgent> {
  const created = await requestPairing(app, details);
  const review = await lookUp(admin, created.pairingCode);
  if (review.statusCode !== 200) throw new Error(`Lookup failed: ${review.body}`);
  const decided = await approve(admin, review.json<{ id: string }>().id, created.pairingCode);
  if (decided.statusCode !== 200) throw new Error(`Approval failed: ${decided.body}`);
  const result = await poll(app, created.pollingSecret);
  if (result.status !== 'approved') throw new Error(`Unexpected status: ${result.status}`);
  return { agentId: result.agentId, credential: result.credential };
}

export function envelope(
  type: string,
  payload: unknown,
  extra: { protocolVersion?: number; correlationId?: string } = {},
) {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload,
    ...extra,
  });
}

/** A real WebSocket client, which keeps everything that arrives for the test to wait on. */
export class TestAgent {
  readonly received: ServerMessage[] = [];
  closeCode: number | undefined;
  private waiters: (() => void)[] = [];

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      this.received.push(serverMessageSchema.parse(JSON.parse(String(data))));
      this.wake();
    });
    socket.on('close', (code) => {
      this.closeCode = code;
      this.wake();
    });
    socket.on('error', () => undefined);
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  static connect(url: string, credential: string): Promise<TestAgent> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } });
      const agent = new TestAgent(socket);
      socket.once('open', () => resolve(agent));
      socket.once('unexpected-response', (_request, response) =>
        reject(new Error(`Refused with ${response.statusCode}`)),
      );
      socket.once('error', reject);
    });
  }

  private async until<T>(check: () => T | undefined, what: string, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value !== undefined) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** The first message of this type that arrived and has not been taken yet. */
  next<T extends ServerMessage['type']>(
    type: T,
    timeoutMs = 10_000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    return this.until(
      () => {
        const index = this.received.findIndex((message) => message.type === type);
        if (index < 0) return undefined;
        return this.received.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
      },
      type,
      timeoutMs,
    );
  }

  closed(timeoutMs = 10_000): Promise<number> {
    return this.until(() => this.closeCode, 'the socket to close', timeoutMs);
  }

  /** Says hello and waits for the welcome, after which this is the agent's active connection. */
  async hello(): Promise<void> {
    this.socket.send(envelope('agent.hello', HELLO));
    await this.next('server.welcome');
  }

  send(raw: string | Buffer): void {
    this.socket.send(raw);
  }

  close(): void {
    this.socket.terminate();
  }
}

export function wsUrl(app: FastifyInstance): string {
  return `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}${AGENT_WS_PATH}`;
}

export async function waitFor<T>(
  check: () => Promise<T | undefined | false | null> | T | undefined | false | null,
  what = 'a condition',
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function agentRow(pool: Pool, agentId: string) {
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT * FROM agents WHERE id = ?', [
    agentId,
  ]);
  return rows[0];
}

export async function count(pool: Pool, table: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0]?.n);
}

export { ORIGIN };
