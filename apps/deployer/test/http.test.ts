import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlServer, tokenMatches } from '../src/http.ts';
import { createWorld, CURRENT, LATEST, TOKEN, type World } from './helpers.ts';

interface Answer {
  status: number;
  body: { error?: { code: string } } & Record<string, unknown>;
}

function call(
  socketPath: string,
  method: string,
  path: string,
  { body, token = TOKEN }: { body?: string; token?: string | null } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk: Buffer) => (text += chunk.toString()));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

let world: World | undefined;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  world?.cleanup();
  world = undefined;
  close = undefined;
});

async function serve(): Promise<World> {
  world = createWorld();
  world.setCurrent(CURRENT);
  world.setRemote(LATEST);
  const server = createControlServer(world.service, () => TOKEN);
  await new Promise<void>((resolve) => server.listen(world?.config.socketPath, resolve));
  close = () => new Promise((resolve) => server.close(() => resolve()));
  return world;
}

describe('control channel', () => {
  it('requires the token on every route', async () => {
    const w = await serve();
    for (const [method, path] of [
      ['GET', '/v1/status'],
      ['POST', '/v1/check'],
      ['POST', '/v1/updates'],
    ] as const) {
      expect((await call(w.config.socketPath, method, path, { token: null })).status).toBe(401);
      expect(
        (await call(w.config.socketPath, method, path, { token: 'x'.repeat(48) })).status,
      ).toBe(401);
    }
    expect(w.runner.started).toEqual([]);
  });

  it('serves the status', async () => {
    const w = await serve();
    const answer = await call(w.config.socketPath, 'GET', '/v1/status');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      environment: 'test',
      branch: 'develop',
      updateAvailable: true,
    });
  });

  it('has no endpoint for commands, scripts, branches or repositories', async () => {
    const w = await serve();
    for (const path of [
      '/v1/exec',
      '/v1/run',
      '/v1/shell',
      '/v1/branch',
      '/v1/repository',
      '/v1/scripts',
      '/v1/../../etc/passwd',
      '/',
    ]) {
      const answer = await call(w.config.socketPath, 'POST', path, { body: '{"command":"id"}' });
      expect(answer.status).toBe(404);
    }
    expect(w.runner.started).toEqual([]);
  });

  it('accepts only the expected commit and requester when starting an update', async () => {
    const w = await serve();
    const extra = await call(w.config.socketPath, 'POST', '/v1/updates', {
      body: JSON.stringify({ expectedCommit: LATEST, requestedBy: 'admin', branch: 'main' }),
    });
    expect(extra).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    const notJson = await call(w.config.socketPath, 'POST', '/v1/updates', { body: 'branch=main' });
    expect(notJson.status).toBe(400);
    const huge = await call(w.config.socketPath, 'POST', '/v1/updates', {
      body: JSON.stringify({ expectedCommit: LATEST, requestedBy: 'x'.repeat(10_000) }),
    }).catch(() => ({ status: 413 }));
    expect(huge.status).toBe(413);
    expect(w.runner.started).toEqual([]);

    const ok = await call(w.config.socketPath, 'POST', '/v1/updates', {
      body: JSON.stringify({ expectedCommit: LATEST, requestedBy: 'admin' }),
    });
    expect(ok.status).toBe(202);
    expect(w.runner.started).toHaveLength(1);
    const again = await call(w.config.socketPath, 'POST', '/v1/updates', {
      body: JSON.stringify({ expectedCommit: LATEST, requestedBy: 'admin' }),
    });
    expect(again).toMatchObject({ status: 409, body: { error: { code: 'update_in_progress' } } });
  });

  it('serves an operation and its log, and nothing for unknown IDs', async () => {
    const w = await serve();
    const started = await call(w.config.socketPath, 'POST', '/v1/updates', {
      body: JSON.stringify({ expectedCommit: LATEST, requestedBy: 'admin' }),
    });
    const id = started.body.id as string;
    expect((await call(w.config.socketPath, 'GET', `/v1/operations/${id}`)).status).toBe(200);
    expect((await call(w.config.socketPath, 'GET', `/v1/operations/${id}/log`)).status).toBe(200);
    expect(
      (
        await call(
          w.config.socketPath,
          'GET',
          '/v1/operations/018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7301',
        )
      ).status,
    ).toBe(404);
    expect((await call(w.config.socketPath, 'POST', `/v1/operations/${id}`)).status).toBe(405);
  });

  it('compares tokens without accepting short or missing ones', () => {
    expect(tokenMatches(TOKEN, `Bearer ${TOKEN}`)).toBe(true);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, undefined)).toBe(false);
    expect(tokenMatches('short', 'Bearer short')).toBe(false);
  });
});
