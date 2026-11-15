import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { requestLogLevel } from '../src/request-logging.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Line {
  level: number;
  msg: string;
  req?: { method: string; url: string };
  res?: { statusCode: number };
}

/** The app, logging at `level` into an array. */
async function logged(level: string): Promise<Line[]> {
  const lines: Line[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const text of String(chunk).split('\n')) if (text) lines.push(JSON.parse(text) as Line);
      callback();
    },
  });
  app = await buildApp({
    readiness: async () => ({ database: 'ok', migrations: 'ok' }),
    authenticateAgent: async () => null,
    logger: { level, stream },
    extraRoutes: (api) => {
      api.post('/test/change', async () => ({ ok: true }));
    },
  });
  return lines;
}

const completed = (lines: Line[]) => lines.filter((line) => line.msg === 'request completed');
const INFO = 30;
const WARN = 40;

describe('request logging', () => {
  it('keeps successful reads out of the info log, and every change and failure in it', async () => {
    const lines = await logged('info');
    await app!.inject({ url: '/api/v1/health' });
    await app!.inject({ method: 'POST', url: '/api/v1/test/change', payload: {} });
    await app!.inject({ url: '/api/v1/no-such-route' });
    await app!.inject({ url: '/api/v1/admin/sessions' });
    const done = completed(lines);
    expect(
      done.map((line) => [line.req?.method, line.req?.url, line.res?.statusCode, line.level]),
    ).toEqual([
      ['POST', '/api/v1/test/change', 200, INFO],
      ['GET', '/api/v1/no-such-route', 404, WARN],
      ['GET', '/api/v1/admin/sessions', 404, WARN],
    ]);
    expect(lines.some((line) => line.msg === 'incoming request')).toBe(false);
  });

  it('still logs every request at debug', async () => {
    const lines = await logged('debug');
    await app!.inject({ url: '/api/v1/health' });
    expect(completed(lines)).toHaveLength(1);
    expect(lines.some((line) => line.msg === 'incoming request')).toBe(true);
  });

  it('logs reads at debug only when they succeed, and upgrades at info', () => {
    expect(requestLogLevel('GET', 200)).toBe('debug');
    expect(requestLogLevel('HEAD', 304)).toBe('debug');
    expect(requestLogLevel('GET', 101)).toBe('info');
    expect(requestLogLevel('POST', 202)).toBe('info');
    expect(requestLogLevel('DELETE', 204)).toBe('info');
    expect(requestLogLevel('GET', 401)).toBe('warn');
    expect(requestLogLevel('GET', 500)).toBe('warn');
  });
});
