import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { createHost, DB_PASSWORD, REPOSITORY, TOKEN, type Host } from './harness.ts';

/**
 * The real deployment service on a real Unix socket, running the real emucatctl against a disposable
 * host. Linux only, by `pnpm test:deploy`.
 */

const MAIN = join(REPOSITORY, 'apps/deployer/src/main.ts');
const HEALTH_PORT = 18080;

interface Answer {
  status: number;
  body: Record<string, unknown> & { error?: { code: string } };
}

function call(
  h: Host,
  method: string,
  path: string,
  body?: object,
  token = TOKEN,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath: join(h.socketDir, 'deployer.sock'),
        method,
        path,
        headers: {
          authorization: `Bearer ${token}`,
          ...(text ? { 'content-type': 'application/json' } : {}),
        },
      },
      (response) => {
        let data = '';
        response.on('data', (chunk: Buffer) => (data += chunk.toString()));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(data) }),
        );
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

async function startService(h: Host): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN], {
    env: h.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const deadline = Date.now() + 10_000;
  while (!output.includes('listening on')) {
    if (Date.now() > deadline || child.exitCode !== null) {
      throw new Error(`The deployment service did not start: ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return child;
}

async function stopService(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// What the deployment service checks after a deployment: the application through its ingress.
let ingress: Server;
let currentHost: Host | undefined;
before(async () => {
  ingress = createServer((_request, response) => {
    const fake = currentHost?.fake ?? '';
    const running = existsSync(join(fake, 'running'))
      ? readFileSync(join(fake, 'running'), 'utf8')
      : '';
    const ready = running !== '';
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready' }));
  });
  await new Promise<void>((resolve) => ingress.listen(HEALTH_PORT, '127.0.0.1', resolve));
});
after(() => ingress.close());

const children: ChildProcess[] = [];
const hosts: Host[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(stopService));
  for (const h of hosts.splice(0)) h.cleanup();
});

async function world(overrides: Record<string, string> = {}) {
  const h = createHost();
  hosts.push(h);
  h.writeConfig(overrides);
  currentHost = h;
  const service = await startService(h);
  children.push(service);
  return { h, service };
}

async function finished(h: Host, id: string): Promise<Record<string, unknown>> {
  return until(async () => {
    const answer = await call(h, 'GET', `/v1/operations/${id}`);
    return answer.body.status === 'running' ? undefined : answer.body;
  });
}

describe('deployment service', () => {
  it('listens only on its Unix socket, readable by its group alone', async () => {
    const { h } = await world();
    const mode = statSync(join(h.socketDir, 'deployer.sock')).mode & 0o777;
    assert.equal(mode, 0o660);
    assert.equal(
      (await call(h, 'GET', '/v1/status', undefined, 'wrong-token-'.repeat(4))).status,
      401,
    );
    assert.equal((await call(h, 'POST', '/v1/exec', { command: 'id' })).status, 404);
  });

  it('checks, installs, verifies and reports an update requested from the browser', async () => {
    const { h } = await world();
    const check = await call(h, 'POST', '/v1/check', {});
    assert.equal(check.status, 200, JSON.stringify(check.body));
    const latest = (check.body.latest as { commit: string }).commit;
    assert.equal(check.body.updateAvailable, true);

    const started = await call(h, 'POST', '/v1/updates', {
      expectedCommit: latest,
      requestedBy: 'admin',
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const result = await finished(h, started.body.id as string);
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(result.targetCommit, latest);

    const status = await call(h, 'GET', '/v1/status');
    assert.equal((status.body.current as { commit: string }).commit, latest);
    assert.equal(status.body.updateAvailable, false);
    assert.equal((status.body.lastSuccess as { commit: string }).commit, latest);

    // The build printed the database password and a token; the log shown to administrators has neither.
    const log = await call(h, 'GET', `/v1/operations/${started.body.id as string}/log`);
    const text = (log.body.lines as string[]).join('\n');
    assert.match(text, /==> building/);
    assert.ok(!text.includes(DB_PASSWORD));
    assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwx'));
    assert.ok(!text.includes('user:'));
  });

  it('keeps an update going through a restart of the service, and reports its real result', async () => {
    const { h, service } = await world();
    const latest = ((await call(h, 'POST', '/v1/check', {})).body.latest as { commit: string })
      .commit;
    h.setFake('build_sleep', '2');
    const started = await call(h, 'POST', '/v1/updates', {
      expectedCommit: latest,
      requestedBy: 'admin',
    });
    const id = started.body.id as string;
    await until(async () => {
      const operation = await call(h, 'GET', `/v1/operations/${id}`);
      return operation.body.stage === 'building' ? true : undefined;
    });
    await stopService(service);
    const restarted = await startService(h);
    children.push(restarted);
    const during = await call(h, 'GET', `/v1/operations/${id}`);
    assert.equal(during.body.status, 'running');
    assert.equal((await call(h, 'GET', '/v1/status')).body.activeOperation !== null, true);
    const result = await finished(h, id);
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
  });

  it('reports a failed update with its reason', async () => {
    const { h } = await world();
    const latest = ((await call(h, 'POST', '/v1/check', {})).body.latest as { commit: string })
      .commit;
    h.setFake('fail', 'build');
    const started = await call(h, 'POST', '/v1/updates', {
      expectedCommit: latest,
      requestedBy: 'admin',
    });
    const result = await finished(h, started.body.id as string);
    assert.equal(result.status, 'failed');
    assert.deepEqual((result.error as { code: string }).code, 'build_failed');
    assert.equal(result.rollback, 'not_needed');
    assert.equal((await call(h, 'GET', '/v1/status')).body.current, null);
  });

  it('refuses a second update while one runs, from the browser or the command line', async () => {
    const { h } = await world();
    const latest = ((await call(h, 'POST', '/v1/check', {})).body.latest as { commit: string })
      .commit;
    h.setFake('build_sleep', '2');
    const first = await call(h, 'POST', '/v1/updates', {
      expectedCommit: latest,
      requestedBy: 'one',
    });
    assert.equal(first.status, 202);
    const second = await call(h, 'POST', '/v1/updates', {
      expectedCommit: latest,
      requestedBy: 'two',
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error?.code, 'update_in_progress');
    // The command line meets the same lock.
    await until(async () => (existsSync(join(h.root, 'state/deploy.lock')) ? true : undefined));
    const cli = h.run('update', '--yes');
    assert.equal(cli.status, 75);
    await finished(h, first.body.id as string);
  });

  it('refuses updates from the browser when the host disables them', async () => {
    const { h } = await world({ EMUCAT_ADMIN_UPDATES_ENABLED: 'false' });
    const status = await call(h, 'GET', '/v1/status');
    assert.equal(status.body.updatesEnabled, false);
    const latest = ((await call(h, 'POST', '/v1/check', {})).body.latest as { commit: string })
      .commit;
    const started = await call(h, 'POST', '/v1/updates', {
      expectedCommit: latest,
      requestedBy: 'admin',
    });
    assert.equal(started.status, 403);
    assert.equal(started.body.error?.code, 'updates_disabled');
    assert.equal(h.calls().filter((c) => c.startsWith('docker build')).length, 0);
  });
});
