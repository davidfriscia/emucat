import {
  API_VERSION,
  APP_NAME,
  APP_VERSION,
  EMULATOR_TYPES,
  PROTOCOL_VERSION,
  type HealthResponse,
  type InfoResponse,
  type ReadyResponse,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import type { ReadinessCheck } from '../readiness.js';

export function registerSystemRoutes(app: FastifyInstance, readiness: ReadinessCheck): void {
  app.get('/health', (): HealthResponse => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    const checks = await readiness();
    const ready = checks.database === 'ok' && checks.migrations === 'ok';
    const body: ReadyResponse = { status: ready ? 'ready' : 'not_ready', checks };
    return reply.status(ready ? 200 : 503).send(body);
  });

  app.get('/info', (): InfoResponse => ({
    name: APP_NAME,
    version: APP_VERSION,
    apiVersion: API_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    emulatorTypes: [...EMULATOR_TYPES],
  }));
}
