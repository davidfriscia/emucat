/**
 * The HTTPS relay (decision 0055): an agent's repository operations carried out by the server over its own SFTP
 * connection, with resumable chunked uploads, verified ranged downloads, and authorization from the database only.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  archiveObjectKey,
  PROTOCOL_VERSION,
  relayInfoResponseSchema,
  transferStatusSchema,
  type TransferStatus,
} from '@emucat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from './agent-helpers.js';
import { insertVm } from './browser-app.js';
import { closeServers, serverWorld, type ServerWorld } from './server-world.js';
import { closeWorlds } from './version-world.js';
import { sha256 } from './zip-builder.js';

afterEach(async () => {
  await closeWorlds();
  await closeServers();
});

const CHUNK = 256 * 1024;
const BASE = '/api/v1/agent/repositories';

function agentHeaders(w: ServerWorld, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${w.paired.credential}`,
    'x-emucat-protocol-version': String(PROTOCOL_VERSION),
    ...extra,
  };
}

function call(
  w: ServerWorld,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return w.context.app.inject({
    method,
    url: `${BASE}/${w.repository.id}${path}`,
    headers: agentHeaders(w, headers),
    ...(body === undefined
      ? {}
      : Buffer.isBuffer(body)
        ? {
            payload: body,
            headers: agentHeaders(w, { 'content-type': 'application/octet-stream', ...headers }),
          }
        : { payload: body as object }),
  });
}

async function relayWorld(policy: object = {}) {
  return serverWorld({ transfers: { chunkBytes: CHUNK, ...policy } });
}

/** A registration of this agent that is uploading, as the agent's own operation would be. */
async function uploadingOperation(w: ServerWorld, agentId = w.paired.agentId) {
  const id = randomUUID();
  const versionId = randomUUID();
  const archiveKey = archiveObjectKey({ emulatorType: 'qemu', vmName: 'NewVm' }, versionId);
  await w.context.pool.execute(
    `INSERT INTO registration_operations
       (id, agent_id, repository_id, emulator_type, vm_name, mode, state, version_id, archive_key)
     VALUES (?, ?, ?, 'qemu', 'NewVm', 'copy', 'uploading', ?, ?)`,
    [id, agentId, w.repository.id, versionId, archiveKey],
  );
  return { id, stagingKey: `archives/.staging/${id}.part`, archiveKey };
}

/** A registered master of its own VM, whose archive is these bytes. */
async function registered(w: ServerWorld, data: Buffer) {
  const vmName = `Relayed${randomUUID().slice(0, 8)}`;
  await insertVm(w.context.pool, { vmName });
  return w.insertVersion(data, { vm: { emulatorType: 'qemu', vmName } });
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function waitForState(
  w: ServerWorld,
  path: string,
  states: string[],
): Promise<TransferStatus> {
  return waitFor(
    async () => {
      const response = await call(w, 'GET', path);
      const status = transferStatusSchema.parse(response.json());
      return states.includes(status.state) ? status : null;
    },
    `a transfer in ${states.join(' or ')}`,
    15_000,
  );
}

describe('relayed uploads', () => {
  it('resumes by chunks, checks each and the whole, writes to staging, verifies and publishes', async () => {
    const w = await relayWorld();
    const info = relayInfoResponseSchema.parse((await call(w, 'GET', '/relay')).json());
    expect(info).toMatchObject({ enabled: true, chunkBytes: CHUNK });

    const op = await uploadingOperation(w);
    const data = Buffer.alloc(CHUNK * 2 + 1000);
    for (let index = 0; index < data.length; index += 1) data[index] = (index * 7) % 251;
    const declared = { key: op.stagingKey, sizeBytes: data.length, sha256: sha256(data) };
    const started = await call(w, 'POST', '/uploads', declared);
    expect(started.statusCode, started.body).toBe(200);
    const status = transferStatusSchema.parse(started.json());
    expect(status).toMatchObject({ state: 'receiving', chunkCount: 3, missingChunks: [[0, 2]] });

    const chunk = (index: number) =>
      data.subarray(index * CHUNK, Math.min(data.length, (index + 1) * CHUNK));
    const put = (index: number, body: Buffer, hash = sha(body)) =>
      call(w, 'PUT', `/uploads/${status.transferId}/chunks/${index}`, body, {
        'x-emucat-chunk-sha256': hash,
      });

    expect((await put(1, chunk(1))).statusCode).toBe(200);
    // Again: harmless.
    expect((await put(1, chunk(1))).json()).toMatchObject({ receivedChunks: 1, chunkCount: 3 });
    // A wrong hash, a wrong size and an index past the end are refused, and change nothing.
    expect((await put(0, chunk(0), 'a'.repeat(64))).statusCode).toBe(422);
    expect((await put(0, chunk(0).subarray(1))).statusCode).toBe(400);
    expect((await put(3, chunk(2))).statusCode).toBe(400);
    expect(
      (await call(w, 'PUT', `/uploads/${status.transferId}/chunks/0`, chunk(0))).statusCode,
    ).toBe(400);

    // The same declaration resumes the same upload, and says what is missing.
    const resumed = transferStatusSchema.parse(
      (await call(w, 'POST', '/uploads', declared)).json(),
    );
    expect(resumed.transferId).toBe(status.transferId);
    expect(resumed.missingChunks).toEqual([
      [0, 0],
      [2, 2],
    ]);
    expect((await call(w, 'POST', `/uploads/${status.transferId}/complete`)).statusCode).toBe(409);

    await put(0, chunk(0));
    await put(2, chunk(2));
    const completed = await call(w, 'POST', `/uploads/${status.transferId}/complete`);
    expect(completed.statusCode, completed.body).toBe(200);
    await waitForState(w, `/uploads/${status.transferId}`, ['published']);
    // Completing again only reports.
    expect((await call(w, 'POST', `/uploads/${status.transferId}/complete`)).json()).toMatchObject({
      state: 'published',
    });
    expect((await readFile(join(w.sftp.root, op.stagingKey))).equals(data)).toBe(true);

    const verify = { key: op.stagingKey, sizeBytes: data.length, sha256: sha256(data) };
    const verified = await waitFor(async () => {
      const response = await call(w, 'POST', '/verify', verify);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ state: string }>();
      return body.state === 'running' ? null : body;
    });
    expect(verified).toMatchObject({ state: 'verified', sha256: sha256(data) });

    const published = await call(w, 'POST', '/publish', {
      stagingKey: op.stagingKey,
      finalKey: op.archiveKey,
    });
    expect(published.statusCode, published.body).toBe(204);
    expect((await readFile(join(w.sftp.root, op.archiveKey))).equals(data)).toBe(true);
    const again = await call(w, 'POST', '/publish', {
      stagingKey: op.stagingKey,
      finalKey: op.archiveKey,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'archive_exists' } });

    expect((await call(w, 'POST', '/delete', { key: op.stagingKey })).statusCode).toBe(204);
    expect(existsSync(join(w.sftp.root, op.stagingKey))).toBe(false);
    expect((await call(w, 'POST', '/stat', { key: op.archiveKey })).json()).toEqual({
      exists: true,
      sizeBytes: data.length,
    });
  });

  it('fails an upload whose assembled bytes are not what was declared', async () => {
    const w = await relayWorld();
    const op = await uploadingOperation(w);
    const data = Buffer.alloc(1000, 1);
    const started = transferStatusSchema.parse(
      (
        await call(w, 'POST', '/uploads', {
          key: op.stagingKey,
          sizeBytes: 1000,
          sha256: 'b'.repeat(64),
        })
      ).json(),
    );
    await call(w, 'PUT', `/uploads/${started.transferId}/chunks/0`, data, {
      'x-emucat-chunk-sha256': sha(data),
    });
    await call(w, 'POST', `/uploads/${started.transferId}/complete`);
    const failed = await waitForState(w, `/uploads/${started.transferId}`, ['failed']);
    expect(failed.error?.code).toBe('hash_mismatch');
    expect(existsSync(join(w.sftp.root, op.stagingKey))).toBe(false);
  });

  it('can be cancelled, and refuses chunks afterwards', async () => {
    const w = await relayWorld();
    const op = await uploadingOperation(w);
    const data = Buffer.alloc(10, 1);
    const started = transferStatusSchema.parse(
      (
        await call(w, 'POST', '/uploads', {
          key: op.stagingKey,
          sizeBytes: 10,
          sha256: sha256(data),
        })
      ).json(),
    );
    expect((await call(w, 'DELETE', `/uploads/${started.transferId}`)).json()).toMatchObject({
      state: 'cancelled',
    });
    const late = await call(w, 'PUT', `/uploads/${started.transferId}/chunks/0`, data, {
      'x-emucat-chunk-sha256': sha(data),
    });
    expect(late.statusCode).toBe(409);
  });
});

describe('relay authorization', () => {
  it('lets an agent write only its own running operation’s staging key, and publish only its archive', async () => {
    const w = await relayWorld();
    const op = await uploadingOperation(w);
    const data = Buffer.alloc(10, 1);
    const declare = (key: string) =>
      call(w, 'POST', '/uploads', { key, sizeBytes: 10, sha256: sha256(data) });
    // Another operation's key, a made-up one, and a final key.
    expect((await declare(`archives/.staging/${randomUUID()}.part`)).statusCode).toBe(403);
    expect((await declare('archives/.staging/../../etc/passwd')).statusCode).toBe(400);
    expect((await declare(op.archiveKey)).statusCode).toBe(400);
    // Publishing anywhere but this operation's own archive key.
    const elsewhere = await call(w, 'POST', '/publish', {
      stagingKey: op.stagingKey,
      finalKey: archiveObjectKey({ emulatorType: 'qemu', vmName: 'Win98' }, randomUUID()),
    });
    expect(elsewhere.statusCode).toBe(403);
    // A registered version's archive can be read, never deleted.
    const { key } = await registered(w, Buffer.from('registered'));
    expect((await call(w, 'POST', '/stat', { key })).json()).toEqual({
      exists: true,
      sizeBytes: 10,
    });
    expect((await call(w, 'POST', '/delete', { key })).statusCode).toBe(403);
    // Something EmuCat never registered is not readable at all.
    expect((await call(w, 'POST', '/stat', { key: 'archives/qemu/x/y.zip' })).statusCode).toBe(403);
    // A finished operation's staging key is no longer writable.
    await w.context.pool.execute(
      "UPDATE registration_operations SET state = 'failed', finished_at = UTC_TIMESTAMP(3) WHERE id = ?",
      [op.id],
    );
    expect((await declare(op.stagingKey)).statusCode).toBe(403);
  });

  it('needs the agent’s credential and an association with the repository', async () => {
    const w = await relayWorld();
    const anonymous = await w.context.app.inject({
      method: 'GET',
      url: `${BASE}/${w.repository.id}/relay`,
      headers: { 'x-emucat-protocol-version': String(PROTOCOL_VERSION) },
    });
    expect(anonymous.statusCode).toBe(401);
    // A browser session is not an agent.
    const browser = await w.admin.get(`${BASE.replace('/api/v1', '')}/${w.repository.id}/relay`);
    expect(browser.statusCode).toBe(401);
    await w.admin.request({
      method: 'DELETE',
      url: `/admin/repositories/${w.repository.id}/agents/${w.paired.agentId}`,
    });
    expect((await call(w, 'GET', '/relay')).statusCode).toBe(403);
  });

  it('says when the relay is turned off', async () => {
    const w = await relayWorld({ relayEnabled: false });
    expect((await call(w, 'GET', '/relay')).json()).toMatchObject({ enabled: false });
    const op = await uploadingOperation(w);
    const refused = await call(w, 'POST', '/uploads', {
      key: op.stagingKey,
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
    });
    expect(refused.statusCode).toBe(503);
  });
});

describe('relayed downloads', () => {
  it('stages a registered archive once, verified, and serves it whole and in ranges', async () => {
    const w = await relayWorld();
    const data = Buffer.alloc(CHUNK + 500);
    for (let index = 0; index < data.length; index += 1) data[index] = index % 256;
    const { key } = await registered(w, data);
    const started = transferStatusSchema.parse(
      (await call(w, 'POST', '/downloads', { key })).json(),
    );
    const again = transferStatusSchema.parse((await call(w, 'POST', '/downloads', { key })).json());
    expect(again.transferId).toBe(started.transferId);
    const ready = await waitForState(w, `/downloads/${started.transferId}`, ['ready']);
    expect(ready).toMatchObject({ sizeBytes: data.length, sha256: sha256(data) });

    const whole = await call(w, 'GET', `/downloads/${started.transferId}/content`);
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['x-emucat-sha256']).toBe(sha256(data));
    expect(whole.rawPayload.equals(data)).toBe(true);

    const range = await call(w, 'GET', `/downloads/${started.transferId}/content`, undefined, {
      range: 'bytes=100-199',
    });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe(`bytes 100-199/${data.length}`);
    expect(range.rawPayload.equals(data.subarray(100, 200))).toBe(true);
    const tail = await call(w, 'GET', `/downloads/${started.transferId}/content`, undefined, {
      range: `bytes=${CHUNK}-`,
    });
    expect(tail.rawPayload.equals(data.subarray(CHUNK))).toBe(true);
    const beyond = await call(w, 'GET', `/downloads/${started.transferId}/content`, undefined, {
      range: `bytes=${data.length}-`,
    });
    expect(beyond.statusCode).toBe(416);
  });

  it('refuses to serve an object that is not what was registered', async () => {
    const w = await relayWorld();
    const { key } = await registered(w, Buffer.from('registered bytes'));
    await w.put(key, Buffer.from('tampered bytes!!'));
    const started = transferStatusSchema.parse(
      (await call(w, 'POST', '/downloads', { key })).json(),
    );
    const failed = await waitForState(w, `/downloads/${started.transferId}`, ['failed']);
    expect(failed.error?.code).toBe('hash_mismatch');
    expect((await call(w, 'GET', `/downloads/${started.transferId}/content`)).statusCode).toBe(409);
  });
});
