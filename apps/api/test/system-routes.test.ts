import { errorResponseSchema, infoResponseSchema, readyResponseSchema } from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp, type AppDependencies } from '../src/app.js';
import type { ReadinessCheck } from '../src/readiness.js';

const healthy: ReadinessCheck = async () => ({ database: 'ok', migrations: 'ok' });
let app: FastifyInstance;

async function start(overrides: Partial<AppDependencies> = {}): Promise<FastifyInstance> {
  app = await buildApp({
    readiness: healthy,
    authenticateAgent: async () => null,
    ...overrides,
  });
  return app;
}

afterEach(async () => {
  await app.close();
});

describe('GET /api/v1/health', () => {
  it('reports that the process is running, even if the database is down', async () => {
    await start({ readiness: async () => ({ database: 'failed', migrations: 'skipped' }) });
    const response = await app.inject({ url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /api/v1/ready', () => {
  it('returns 200 when all checks pass', async () => {
    await start();
    const response = await app.inject({ url: '/api/v1/ready' });
    expect(response.statusCode).toBe(200);
    expect(readyResponseSchema.parse(response.json()).status).toBe('ready');
  });

  it('returns 503 when the database is down', async () => {
    await start({ readiness: async () => ({ database: 'failed', migrations: 'skipped' }) });
    const response = await app.inject({ url: '/api/v1/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      checks: { database: 'failed', migrations: 'skipped' },
    });
  });

  it('returns 503 when migrations are pending', async () => {
    await start({ readiness: async () => ({ database: 'ok', migrations: 'failed' }) });
    const response = await app.inject({ url: '/api/v1/ready' });
    expect(response.statusCode).toBe(503);
  });
});

describe('GET /api/v1/info', () => {
  it('exposes version information and nothing else', async () => {
    await start();
    const response = await app.inject({ url: '/api/v1/info' });
    expect(response.statusCode).toBe(200);
    const body = infoResponseSchema.parse(response.json());
    expect(Object.keys(response.json()).sort()).toEqual(
      ['apiVersion', 'emulatorTypes', 'name', 'protocolVersion', 'version'].sort(),
    );
    expect(body.emulatorTypes).toEqual(['86box', 'qemu']);
    expect(response.body).not.toMatch(/password|secret|[A-Za-z]:\\|\/home\/|\/var\//i);
  });
});

describe('errors', () => {
  it('uses the common shape for unknown routes', async () => {
    await start();
    const response = await app.inject({ url: '/api/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('reports validation failures with details', async () => {
    await start({
      extraRoutes: (api) => {
        api.post(
          '/echo',
          { schema: { body: z.object({ name: z.string().min(1) }) } },
          (request) => request.body,
        );
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      payload: { name: '' },
    });
    expect(response.statusCode).toBe(400);
    const { error } = errorResponseSchema.parse(response.json());
    expect(error.code).toBe('validation_failed');
    expect(error.details?.[0]?.path).toBe('name');
  });

  it('accepts a valid request on a validated route', async () => {
    await start({
      extraRoutes: (api) => {
        api.post(
          '/echo',
          { schema: { body: z.object({ name: z.string().min(1) }) } },
          (request) => request.body,
        );
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      payload: { name: 'a' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('reports malformed JSON as a client error', async () => {
    await start({
      extraRoutes: (api) => {
        api.post('/echo', (request) => request.body);
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.safeParse(response.json()).success).toBe(true);
  });

  it('hides the details of unexpected errors', async () => {
    await start({
      extraRoutes: (api) => {
        api.get('/boom', () => {
          throw new Error('secret connection string');
        });
      },
    });
    const response = await app.inject({ url: '/api/v1/boom' });
    expect(response.statusCode).toBe(500);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('internal_error');
    expect(response.body).not.toContain('secret connection string');
  });
});
