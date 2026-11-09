/**
 * Screenshots arriving from an agent, on a real database and real files. Images are made with the same
 * library the server uses, apart from the formats it does not read, which are written by hand.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  adminMediaDetailSchema,
  adminMediaListResponseSchema,
  adminMediaSyncResponseSchema,
  agentMediaVmListResponseSchema,
  mediaAcknowledgementResponseSchema,
  mediaUploadResponseSchema,
  PROTOCOL_VERSION,
  publicCatalogResponseSchema,
  publicVmDetailSchema,
  type AdminMedia,
} from '@emucat/contracts';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBmp, decodePpm, sniffImageFormat } from '../src/media/decode.js';
import { processImage, THUMBNAIL_MAX_DIMENSION } from '../src/media/process.js';
import { DEFAULT_MEDIA_POLICY, maintainMediaStorage } from '../src/media/uploads.js';
import { cleanStaging, MEDIA_STAGING_KEY } from '../src/storage/media-storage.js';
import {
  envelope,
  GENEROUS_RATE_LIMITS,
  pairAgent,
  TestAgent,
  waitFor,
  wsUrl,
} from './agent-helpers.js';
import {
  HOST,
  insertVm,
  signedInAdmin,
  startBrowserApp,
  type BrowserTestContext,
  type TestClient,
} from './browser-app.js';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const PNG_RED = (width = 16, height = 12) =>
  sharp({ create: { width, height, channels: 3, background: '#cc0000' } })
    .png()
    .toBuffer();

let context: BrowserTestContext;
let admin: TestClient;
let agent: { agentId: string; credential: string };
let other: { agentId: string; credential: string };
let names = 0;

beforeAll(async () => {
  context = await startBrowserApp({
    pairingRateLimits: GENEROUS_RATE_LIMITS,
    media: {
      ...DEFAULT_MEDIA_POLICY,
      maxUploadBytes: 4 * 1024 * 1024,
      maxPixels: 4_000_000,
      maxDimension: 4096,
    },
  });
  admin = await signedInAdmin(context);
  agent = await pairAgent(context.app, admin);
  other = await pairAgent(context.app, admin, { name: 'Other PC' });
});

afterAll(async () => {
  await context.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function newVm(
  owner: string | null = agent.agentId,
  emulatorType: '86box' | 'qemu' = '86box',
): Promise<{ emulatorType: '86box' | 'qemu'; vmName: string; path: string; admin: string }> {
  names += 1;
  const vmName = `Upload ${names}`;
  await insertVm(context.pool, { emulatorType, vmName });
  if (owner) {
    await context.pool.execute(
      'INSERT INTO agent_vm_state (agent_id, emulator_type, vm_name) VALUES (?, ?, ?)',
      [owner, emulatorType, vmName],
    );
  }
  const segments = `${emulatorType}/${encodeURIComponent(vmName)}`;
  return {
    emulatorType,
    vmName,
    path: `/api/v1/agent/media/vms/${segments}`,
    admin: `/admin/vms/${segments}`,
  };
}

function agentHeaders(credential: string = agent.credential): Record<string, string> {
  return {
    host: HOST,
    authorization: `Bearer ${credential}`,
    'x-emucat-protocol-version': String(PROTOCOL_VERSION),
  };
}

function upload(
  vm: { path: string; emulatorType: string },
  bytes: Buffer,
  options: {
    credential?: string;
    declared?: string;
    sourcePath?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<LightMyRequestResponse> {
  const sourcePath =
    options.sourcePath === undefined
      ? vm.emulatorType === 'qemu'
        ? 'screenshot001.ppm'
        : 'screenshots/nested/one.png'
      : options.sourcePath;
  const request: InjectOptions = {
    method: 'PUT',
    url: `${vm.path}/screenshots/${options.declared ?? sha(bytes)}`,
    headers: {
      ...agentHeaders(options.credential),
      'content-type': 'application/octet-stream',
      ...(sourcePath ? { 'x-emucat-source-path': encodeURIComponent(sourcePath) } : {}),
      ...options.headers,
    },
    payload: bytes,
  };
  return context.app.inject(request);
}

async function mediaOf(vm: { admin: string }): Promise<AdminMedia[]> {
  const response = await admin.get(`${vm.admin}/media`);
  return adminMediaListResponseSchema.parse(response.json()).media;
}

async function storedFiles(): Promise<string[]> {
  const found: string[] = [];
  for (const directory of ['originals', 'full', 'thumbnails']) {
    const base = join(context.storageRoot, 'media', directory);
    if (!existsSync(base)) continue;
    for (const name of await readdir(base, { recursive: true })) {
      if (String(name).includes('.')) found.push(`${directory}/${String(name)}`);
    }
  }
  return found;
}

async function stagedFiles(): Promise<string[]> {
  const base = join(context.storageRoot, MEDIA_STAGING_KEY);
  return existsSync(base) ? readdir(base) : [];
}

describe('authentication and authorization', () => {
  it('accepts a valid upload from the agent that holds the VM', async () => {
    const vm = await newVm();
    const bytes = await PNG_RED();
    const response = await upload(vm, bytes);
    expect(response.statusCode, response.body).toBe(201);
    const body = mediaUploadResponseSchema.parse(response.json());
    expect(body).toMatchObject({ sha256: sha(bytes), created: true });
    const [item] = await mediaOf(vm);
    expect(item).toMatchObject({
      id: body.mediaId,
      isMain: false,
      originalFilename: 'screenshots/nested/one.png',
      originalSizeBytes: bytes.length,
      widthPx: 16,
      heightPx: 12,
    });
  });

  it('refuses a request with no credential or an unknown one, before reading anything', async () => {
    const vm = await newVm();
    const bytes = await PNG_RED();
    const unknown = await upload(vm, bytes, { credential: 'A'.repeat(43) });
    expect(unknown.statusCode).toBe(401);
    const none = await context.app.inject({
      method: 'PUT',
      url: `${vm.path}/screenshots/${sha(bytes)}`,
      headers: { host: HOST, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect(await mediaOf(vm)).toEqual([]);
  });

  it('does not accept a browser session instead of an agent credential', async () => {
    const vm = await newVm();
    const bytes = await PNG_RED();
    const response = await admin.request({
      method: 'PUT',
      url: `${vm.path.replace('/api/v1', '')}/screenshots/${sha(bytes)}`,
      headers: {
        'content-type': 'application/octet-stream',
        'x-emucat-protocol-version': '1',
        'x-emucat-source-path': 'screenshots/one.png',
      },
      payload: bytes,
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a revoked agent, whose credential stops working at once', async () => {
    const revoked = await pairAgent(context.app, admin, { name: 'Soon revoked' });
    const vm = await newVm(revoked.agentId);
    const bytes = await PNG_RED();
    expect((await upload(vm, bytes, { credential: revoked.credential })).statusCode).toBe(201);
    const response = await admin.request({
      method: 'POST',
      url: `/admin/agents/${revoked.agentId}/revoke`,
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    const after = await upload(vm, await PNG_RED(20, 20), { credential: revoked.credential });
    expect(after.statusCode).toBe(401);
    expect((await mediaOf(vm)).length).toBe(1);
  });

  it('refuses a VM that is not registered, and creates nothing', async () => {
    const bytes = await PNG_RED();
    const response = await upload(
      { path: '/api/v1/agent/media/vms/86box/Not%20Registered', emulatorType: '86box' },
      bytes,
    );
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('vm_not_registered');
    const [rows] = await context.pool.execute<RowDataPacket[]>(
      "SELECT 1 FROM virtual_machines WHERE vm_name = 'Not Registered'",
    );
    expect(rows).toEqual([]);
  });

  it('refuses a VM that belongs to another agent', async () => {
    const vm = await newVm(other.agentId);
    const response = await upload(vm, await PNG_RED());
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('vm_not_assigned');
    expect(await mediaOf(vm)).toEqual([]);
    const asked = await context.app.inject({
      method: 'POST',
      url: `${vm.path}/acknowledgements`,
      headers: agentHeaders(),
      payload: { sha256: [sha('anything')] },
    });
    expect(asked.statusCode).toBe(403);
  });

  it('lists only the VMs this agent holds, and not one whose copy it removed', async () => {
    const mine = await newVm();
    const theirs = await newVm(other.agentId);
    const gone = await newVm();
    await context.pool.execute(
      "UPDATE agent_vm_state SET execution_state = 'absent' WHERE vm_name = ?",
      [gone.vmName],
    );
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/agent/media/vms',
      headers: agentHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const { vms, maxUploadBytes } = agentMediaVmListResponseSchema.parse(response.json());
    const listed = vms.map((vm) => vm.vmName);
    expect(listed).toContain(mine.vmName);
    expect(listed).not.toContain(theirs.vmName);
    expect(listed).not.toContain(gone.vmName);
    expect(maxUploadBytes).toBe(4 * 1024 * 1024);
  });

  it('says precisely when the protocol versions differ', async () => {
    const vm = await newVm();
    const response = await upload(vm, await PNG_RED(), {
      headers: { 'x-emucat-protocol-version': '999' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('unsupported_protocol_version');
  });

  it('never puts a credential in a response or in the logs it controls', async () => {
    const vm = await newVm();
    const response = await upload(vm, Buffer.from('not an image'));
    expect(response.body).not.toContain(agent.credential);
    expect(response.body).not.toContain(context.storageRoot);
  });
});

describe('what is sent', () => {
  it('refuses bytes that do not have the declared hash, and keeps nothing', async () => {
    const vm = await newVm();
    const response = await upload(vm, await PNG_RED(), { declared: sha('something else') });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('hash_mismatch');
    expect(await mediaOf(vm)).toEqual([]);
    expect(await stagedFiles()).toEqual([]);
  });

  it('refuses a declared hash that is not a hash', async () => {
    const vm = await newVm();
    const response = await upload(vm, await PNG_RED(), { declared: '..%2F..%2Fetc' });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an upload over the limit, declared or not', async () => {
    const vm = await newVm();
    const declared = await context.app.inject({
      method: 'PUT',
      url: `${vm.path}/screenshots/${sha('x')}`,
      headers: {
        ...agentHeaders(),
        'content-type': 'application/octet-stream',
        'x-emucat-source-path': 'screenshots/one.png',
        'content-length': String(5 * 1024 * 1024),
      },
      payload: Buffer.alloc(10),
    });
    expect(declared.statusCode).toBe(413);

    const large = Buffer.alloc(4 * 1024 * 1024 + 1, 1);
    const actual = await upload(vm, large);
    expect(actual.statusCode).toBe(413);
    expect(actual.json().error.code).toBe('upload_too_large');
    expect(await stagedFiles()).toEqual([]);
  });

  it('refuses an empty upload', async () => {
    const vm = await newVm();
    const response = await upload(vm, Buffer.alloc(0));
    expect(response.statusCode).toBe(422);
  });

  it.each([
    ['text with an image name', Buffer.from('just some text, pretending')],
    ['an executable', Buffer.from('MZ\x90\x00 not really')],
    ['SVG, which can hold scripts', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['GIF', Buffer.from('GIF89a not supported')],
  ])('refuses %s, whatever the file is called', async (_label, bytes) => {
    const vm = await newVm();
    const response = await upload(vm, bytes, { sourcePath: 'screenshots/innocent.png' });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe('unsupported_image');
    expect(await mediaOf(vm)).toEqual([]);
  });

  it('refuses a corrupt image, and leaves nothing behind', async () => {
    const vm = await newVm();
    const before = await storedFiles();
    const bytes = (await PNG_RED()).subarray(0, 40);
    const response = await upload(vm, bytes);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('invalid_image');
    expect(await storedFiles()).toEqual(before);
    expect(await stagedFiles()).toEqual([]);
  });

  it('refuses a decompression bomb from its header, without decoding it', async () => {
    const vm = await newVm();
    // A real PNG that claims to be enormous: only the dimensions in its header are changed.
    const bytes = Buffer.from(await PNG_RED());
    bytes.writeUInt32BE(50_000, 16);
    bytes.writeUInt32BE(50_000, 20);
    const response = await upload(vm, bytes);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toMatch(/image_too_large|invalid_image/);
    expect(await mediaOf(vm)).toEqual([]);
  });

  it('refuses a highly compressed image above the pixel limit', async () => {
    const vm = await newVm();
    const bytes = await sharp({
      create: { width: 3000, height: 3000, channels: 3, background: '#000000' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bytes.length).toBeLessThan(200_000);
    const response = await upload(vm, bytes);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('image_too_large');
  });

  it.each([
    ['a traversal', '../../etc/passwd.png'],
    ['an absolute path', 'C:/Windows/one.png'],
    ['outside the watched tree', 'disks/one.png'],
    ['a control character', 'screenshots/a\u0007.png'],
    ['an unsupported type', 'screenshots/one.txt'],
  ])('refuses a source path that is %s', async (_label, sourcePath) => {
    const vm = await newVm();
    const response = await upload(vm, await PNG_RED(), { sourcePath });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_source_path');
  });

  it('does not treat a QEMU screenshot path as valid for 86Box, or the reverse', async () => {
    const box86 = await newVm();
    const qemu = await newVm(agent.agentId, 'qemu');
    const bytes = await PNG_RED();
    expect((await upload(box86, bytes, { sourcePath: 'shot.ppm' })).statusCode).toBe(400);
    expect((await upload(qemu, bytes, { sourcePath: 'screenshots/a.png' })).statusCode).toBe(400);
    expect((await upload(qemu, bytes, { sourcePath: 'nested/a.ppm' })).statusCode).toBe(400);
  });

  it('never uses the source path as a path', async () => {
    const vm = await newVm();
    const bytes = await PNG_RED(17, 11);
    const sourcePath = 'screenshots/..hidden/naïve name (1).PNG';
    const response = await upload(vm, bytes, { sourcePath });
    expect(response.statusCode, response.body).toBe(201);
    const { mediaId } = mediaUploadResponseSchema.parse(response.json());
    const [rows] = await context.pool.execute<RowDataPacket[]>(
      'SELECT original_filename, original_key, jpeg_key, thumbnail_key FROM vm_media WHERE id = ?',
      [mediaId],
    );
    const row = rows[0] as RowDataPacket;
    expect(row.original_filename).toBe(sourcePath);
    for (const key of [row.original_key, row.jpeg_key, row.thumbnail_key]) {
      expect(key).toContain(mediaId);
      expect(key).toMatch(
        /^media\/(originals|full|thumbnails)\/[0-9a-f]{2}\/[0-9a-f-]{36}\.[a-z]+$/,
      );
    }
  });

  it('refuses a body that is not raw bytes', async () => {
    const vm = await newVm();
    const response = await context.app.inject({
      method: 'PUT',
      url: `${vm.path}/screenshots/${sha('x')}`,
      headers: {
        ...agentHeaders(),
        'content-type': 'application/json',
        'x-emucat-source-path': 'screenshots/one.png',
      },
      payload: { not: 'bytes' },
    });
    expect(response.statusCode).toBe(415);
  });
});

describe('deduplication', () => {
  it('answers with the same item for the same bytes, with no new files', async () => {
    const vm = await newVm();
    const bytes = await PNG_RED(30, 20);
    const first = mediaUploadResponseSchema.parse((await upload(vm, bytes)).json());
    const files = await storedFiles();
    const again = await upload(vm, bytes, { sourcePath: 'screenshots/renamed.png' });
    expect(again.statusCode).toBe(200);
    expect(mediaUploadResponseSchema.parse(again.json())).toEqual({
      mediaId: first.mediaId,
      sha256: first.sha256,
      created: false,
    });
    expect(await storedFiles()).toEqual(files);
    expect((await mediaOf(vm)).length).toBe(1);
  });

  it('keeps identical bytes in two VMs as two items, each with its own files', async () => {
    const one = await newVm();
    const two = await newVm();
    const bytes = await PNG_RED(31, 21);
    const first = mediaUploadResponseSchema.parse((await upload(one, bytes)).json());
    const second = mediaUploadResponseSchema.parse((await upload(two, bytes)).json());
    expect(first.mediaId).not.toBe(second.mediaId);
    // Each follows its own VM: making one VM public does not publish the other's copy.
    await admin.request({
      method: 'PUT',
      url: `${one.admin}/visibility`,
      payload: { visibility: 'public' },
    });
    const fetch = (mediaId: string) =>
      context.app.inject({
        method: 'GET',
        url: `/api/v1/catalog/media/${mediaId}/thumbnail`,
        headers: { host: HOST },
      });
    expect((await fetch(first.mediaId)).statusCode).toBe(200);
    expect((await fetch(second.mediaId)).statusCode).toBe(404);
  });

  it('handles simultaneous identical uploads with one row and no leftovers', async () => {
    const vm = await newVm();
    const bytes = await PNG_RED(40, 30);
    const before = (await storedFiles()).length;
    const responses = await Promise.all(Array.from({ length: 4 }, () => upload(vm, bytes)));
    const ok = responses.filter((response) => response.statusCode < 300);
    // Anything over the concurrency limit is told to come back, and a retry finds the winner.
    for (const response of responses) {
      expect([200, 201, 503]).toContain(response.statusCode);
    }
    const ids = new Set(ok.map((response) => response.json<{ mediaId: string }>().mediaId));
    expect(ids.size).toBe(1);
    expect(ok.filter((response) => response.statusCode === 201).length).toBe(1);
    expect((await mediaOf(vm)).length).toBe(1);
    expect((await storedFiles()).length).toBe(before + 3);
    expect(await stagedFiles()).toEqual([]);
  });

  it('treats changed content at the same path as new, and does not touch the main image', async () => {
    const vm = await newVm();
    const first = mediaUploadResponseSchema.parse(
      (await upload(vm, await PNG_RED(32, 24), { sourcePath: 'screenshots/one.png' })).json(),
    );
    await admin.request({
      method: 'PUT',
      url: `${vm.admin}/main-media`,
      payload: { mediaId: first.mediaId },
    });
    const second = await upload(vm, await PNG_RED(33, 25), { sourcePath: 'screenshots/one.png' });
    expect(second.statusCode).toBe(201);
    const media = await mediaOf(vm);
    expect(media.length).toBe(2);
    expect(media.filter((item) => item.isMain).map((item) => item.id)).toEqual([first.mediaId]);
  });

  it('answers honestly about what it holds, for that VM only', async () => {
    const one = await newVm();
    const two = await newVm();
    const bytes = await PNG_RED(34, 26);
    await upload(one, bytes);
    const ask = async (vm: { path: string }, hashes: string[]) =>
      mediaAcknowledgementResponseSchema.parse(
        (
          await context.app.inject({
            method: 'POST',
            url: `${vm.path}/acknowledgements`,
            headers: agentHeaders(),
            payload: { sha256: hashes },
          })
        ).json(),
      ).acknowledged;
    const unknown = sha('never uploaded');
    expect(await ask(one, [sha(bytes), unknown])).toEqual([sha(bytes)]);
    expect(await ask(two, [sha(bytes)])).toEqual([]);
    expect(await ask(one, [])).toEqual([]);
  });

  it('forgets what an administrator deleted, so a transfer cannot rely on it', async () => {
    const vm = await newVm();
    const bytes = await PNG_RED(35, 27);
    const { mediaId } = mediaUploadResponseSchema.parse((await upload(vm, bytes)).json());
    const response = await admin.request({
      method: 'DELETE',
      url: `${vm.admin}/media/${mediaId}`,
    });
    expect(response.statusCode).toBe(200);
    const asked = await context.app.inject({
      method: 'POST',
      url: `${vm.path}/acknowledgements`,
      headers: agentHeaders(),
      payload: { sha256: [sha(bytes)] },
    });
    expect(asked.json<{ acknowledged: string[] }>().acknowledged).toEqual([]);
  });
});

describe('failures along the way', () => {
  it('stores nothing visible when the storage fails, and a retry succeeds', async () => {
    const vm = await newVm();
    const bytes = await PNG_RED(50, 40);
    const before = await storedFiles();
    const publish = vi
      .spyOn(context.dependencies.storage, 'publish')
      .mockRejectedValueOnce(new Error('C:\\secret\\path: disk full'));
    const failed = await upload(vm, bytes);
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('secret');
    expect(await mediaOf(vm)).toEqual([]);
    expect(await storedFiles()).toEqual(before);
    expect(await stagedFiles()).toEqual([]);
    publish.mockRestore();
    expect((await upload(vm, bytes)).statusCode).toBe(201);
  });

  it('removes the published files when the second of them cannot be stored', async () => {
    const vm = await newVm();
    const bytes = await PNG_RED(51, 41);
    const before = await storedFiles();
    const real = context.dependencies.storage.publish.bind(context.dependencies.storage);
    let calls = 0;
    vi.spyOn(context.dependencies.storage, 'publish').mockImplementation(async (path, key) => {
      calls += 1;
      if (calls === 2) throw new Error('disk full');
      return real(path, key);
    });
    expect((await upload(vm, bytes)).statusCode).toBe(500);
    expect(await storedFiles()).toEqual(before);
    expect(await mediaOf(vm)).toEqual([]);
  });

  it('leaves no row and no files when the database fails at the end', async () => {
    const vm = await newVm();
    const bytes = await PNG_RED(52, 42);
    const before = await storedFiles();
    const original = context.pool.getConnection.bind(context.pool);
    vi.spyOn(context.pool, 'getConnection').mockImplementationOnce(async () => {
      void original;
      throw new Error('the database went away');
    });
    const failed = await upload(vm, bytes);
    expect(failed.statusCode).toBe(500);
    expect(await storedFiles()).toEqual(before);
    expect(await stagedFiles()).toEqual([]);
    vi.restoreAllMocks();
    expect((await upload(vm, bytes)).statusCode).toBe(201);
  });

  it('answers 503 rather than 401 when the credential cannot be checked', async () => {
    const vm = await newVm();
    const bytes = await PNG_RED(53, 43);
    vi.spyOn(context.pool, 'execute').mockRejectedValueOnce(new Error('the database went away'));
    const response = await upload(vm, bytes);
    expect(response.statusCode).toBe(503);
  });

  it('says it is busy when too many uploads are running', async () => {
    const busy = await startBrowserApp({
      media: { ...DEFAULT_MEDIA_POLICY, maxConcurrentUploads: 1 },
      pairingRateLimits: GENEROUS_RATE_LIMITS,
    });
    try {
      const client = await signedInAdmin(busy);
      const paired = await pairAgent(busy.app, client);
      await insertVm(busy.pool, { emulatorType: '86box', vmName: 'Busy' });
      await busy.pool.execute(
        "INSERT INTO agent_vm_state (agent_id, emulator_type, vm_name) VALUES (?, '86box', 'Busy')",
        [paired.agentId],
      );
      await busy.app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = busy.app.server.address() as AddressInfo;
      // One upload that has started and is not finishing.
      const head = [
        `PUT /api/v1/agent/media/vms/86box/Busy/screenshots/${sha('x')} HTTP/1.1`,
        `Host: ${HOST}`,
        `Authorization: Bearer ${paired.credential}`,
        `x-emucat-protocol-version: ${PROTOCOL_VERSION}`,
        'x-emucat-source-path: screenshots/one.png',
        'Content-Type: application/octet-stream',
        'Content-Length: 100000',
        '',
        '',
      ].join('\r\n');
      const slow = connect(port, '127.0.0.1');
      slow.on('error', () => undefined);
      slow.write(head);
      slow.write(Buffer.alloc(100));
      await waitFor(
        async () => (await readdirSafe(join(busy.storageRoot, MEDIA_STAGING_KEY))).length > 0,
      );

      const bytes = await PNG_RED();
      const response = await busy.app.inject({
        method: 'PUT',
        url: `/api/v1/agent/media/vms/86box/Busy/screenshots/${sha(bytes)}`,
        headers: {
          ...agentHeaders(paired.credential),
          'content-type': 'application/octet-stream',
          'x-emucat-source-path': 'screenshots/two.png',
        },
        payload: bytes,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('media_busy');
      expect(response.headers['retry-after']).toBeDefined();
      slow.destroy();
    } finally {
      await busy.close();
    }
  });

  it('cleans up after a connection that drops partway through', async () => {
    const dropped = await startBrowserApp({ pairingRateLimits: GENEROUS_RATE_LIMITS });
    try {
      const client = await signedInAdmin(dropped);
      const paired = await pairAgent(dropped.app, client);
      await insertVm(dropped.pool, { emulatorType: '86box', vmName: 'Dropped' });
      await dropped.pool.execute(
        "INSERT INTO agent_vm_state (agent_id, emulator_type, vm_name) VALUES (?, '86box', 'Dropped')",
        [paired.agentId],
      );
      await dropped.app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = dropped.app.server.address() as AddressInfo;
      const socket = connect(port, '127.0.0.1');
      socket.on('error', () => undefined);
      socket.write(
        [
          `PUT /api/v1/agent/media/vms/86box/Dropped/screenshots/${sha('x')} HTTP/1.1`,
          `Host: ${HOST}`,
          `Authorization: Bearer ${paired.credential}`,
          `x-emucat-protocol-version: ${PROTOCOL_VERSION}`,
          'x-emucat-source-path: screenshots/one.png',
          'Content-Type: application/octet-stream',
          'Content-Length: 100000',
          '',
          '',
        ].join('\r\n'),
      );
      socket.write(Buffer.alloc(1000));
      const staging = join(dropped.storageRoot, MEDIA_STAGING_KEY);
      await waitFor(async () => (await readdirSafe(staging)).length > 0, 'the upload to start');
      socket.destroy();
      await waitFor(async () => (await readdirSafe(staging)).length === 0, 'the cleanup');
      const [rows] = await dropped.pool.execute<RowDataPacket[]>('SELECT 1 FROM vm_media');
      expect(rows).toEqual([]);
    } finally {
      await dropped.close();
    }
  });

  it('gives up on a connection that stops sending', async () => {
    const quiet = await startBrowserApp({
      pairingRateLimits: GENEROUS_RATE_LIMITS,
      media: { ...DEFAULT_MEDIA_POLICY, uploadIdleTimeoutMs: 100 },
    });
    try {
      const client = await signedInAdmin(quiet);
      const paired = await pairAgent(quiet.app, client);
      await insertVm(quiet.pool, { emulatorType: '86box', vmName: 'Quiet' });
      await quiet.pool.execute(
        "INSERT INTO agent_vm_state (agent_id, emulator_type, vm_name) VALUES (?, '86box', 'Quiet')",
        [paired.agentId],
      );
      await quiet.app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = quiet.app.server.address() as AddressInfo;
      const socket = connect(port, '127.0.0.1');
      socket.on('error', () => undefined);
      socket.write(
        [
          `PUT /api/v1/agent/media/vms/86box/Quiet/screenshots/${sha('x')} HTTP/1.1`,
          `Host: ${HOST}`,
          `Authorization: Bearer ${paired.credential}`,
          `x-emucat-protocol-version: ${PROTOCOL_VERSION}`,
          'x-emucat-source-path: screenshots/one.png',
          'Content-Type: application/octet-stream',
          'Content-Length: 100000',
          '',
          'partial',
        ].join('\r\n'),
      );
      const staging = join(quiet.storageRoot, MEDIA_STAGING_KEY);
      await waitFor(async () => (await readdirSafe(staging)).length > 0, 'the upload to start');
      await waitFor(async () => (await readdirSafe(staging)).length === 0, 'the timeout', 5000);
      socket.destroy();
    } finally {
      await quiet.close();
    }
  });
});

async function readdirSafe(path: string): Promise<string[]> {
  return existsSync(path) ? readdir(path) : [];
}

describe('storage housekeeping', () => {
  it('removes only old staged files, and reports orphans without deleting them', async () => {
    const root = context.storageRoot;
    const staging = join(root, MEDIA_STAGING_KEY);
    const storage = context.dependencies.storage;
    const staged = await storage.stagingPath('.old');
    await writeFile(staged, 'left by a crash');
    expect(await cleanStaging(root, 60_000)).toBe(0);
    expect(existsSync(staged)).toBe(true);
    expect(await cleanStaging(root, -60_000)).toBeGreaterThanOrEqual(1);
    expect(existsSync(staged)).toBe(false);
    expect(await readdirSafe(staging)).toEqual([]);

    const orphanKey = `media/originals/ab/${randomUUID()}.png`;
    const temporary = await storage.stagingPath('.orphan');
    await writeFile(temporary, 'nothing refers to this');
    await storage.publish(temporary, orphanKey);
    const warn = vi.fn();
    const log = { info: vi.fn(), warn } as unknown as Parameters<typeof maintainMediaStorage>[2];
    await maintainMediaStorage(context.pool, root, log);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ orphans: expect.any(Number) }),
      expect.any(String),
    );
    expect(existsSync(join(root, orphanKey))).toBe(true);
    await rm(join(root, orphanKey));
  });
});

describe('image processing', () => {
  const limits = { maxPixels: 40_000_000, maxDimension: 16_384, timeoutSeconds: 30 };

  async function convert(bytes: Buffer) {
    const storage = context.dependencies.storage;
    const original = await storage.stagingPath('.test');
    await writeFile(original, bytes);
    const full = `${original}.full.jpg`;
    const thumbnail = `${original}.thumb.jpg`;
    try {
      const image = await processImage(original, full, thumbnail, limits);
      return {
        image,
        full: await readFile(full),
        thumbnail: await readFile(thumbnail),
      };
    } finally {
      await Promise.all([original, full, thumbnail].map((path) => rm(path, { force: true })));
    }
  }

  function ppm(width: number, height: number, fill: number[]): Buffer {
    const header = Buffer.from(`P6\n# from QEMU\n${width} ${height}\n255\n`);
    const pixels = Buffer.alloc(width * height * 3);
    for (let index = 0; index < pixels.length; index += 3) {
      pixels[index] = fill[0] as number;
      pixels[index + 1] = fill[1] as number;
      pixels[index + 2] = fill[2] as number;
    }
    return Buffer.concat([header, pixels]);
  }

  function bmp(width: number, height: number, bits: 24 | 32): Buffer {
    const stride = Math.ceil((width * bits) / 32) * 4;
    const data = Buffer.alloc(54 + stride * height);
    data.write('BM', 0, 'latin1');
    data.writeUInt32LE(data.length, 2);
    data.writeUInt32LE(54, 10);
    data.writeUInt32LE(40, 14);
    data.writeInt32LE(width, 18);
    data.writeInt32LE(height, 22);
    data.writeUInt16LE(1, 26);
    data.writeUInt16LE(bits, 28);
    // Bottom-up, as a BMP usually is: the first row in the file is the bottom one, in blue.
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const pixel = 54 + row * stride + column * (bits / 8);
        if (row === 0) {
          data[pixel] = 255;
        } else {
          data[pixel + 2] = 255;
        }
      }
    }
    return data;
  }

  it('converts a PNG, and makes a thumbnail with the longest side at 400', async () => {
    const { image, full, thumbnail } = await convert(await PNG_RED(1600, 900));
    expect(image).toMatchObject({
      format: 'png',
      mimeType: 'image/png',
      widthPx: 1600,
      heightPx: 900,
    });
    const fullInfo = await sharp(full).metadata();
    expect(fullInfo).toMatchObject({ format: 'jpeg', width: 1600, height: 900 });
    const thumbnailInfo = await sharp(thumbnail).metadata();
    expect(thumbnailInfo).toMatchObject({
      format: 'jpeg',
      width: THUMBNAIL_MAX_DIMENSION,
      height: 225,
    });
  });

  it('keeps the shape of a tall image', async () => {
    const { thumbnail } = await convert(await PNG_RED(600, 1200));
    expect(await sharp(thumbnail).metadata()).toMatchObject({ width: 200, height: 400 });
  });

  it('does not enlarge a small image', async () => {
    const { image, thumbnail } = await convert(await PNG_RED(64, 48));
    expect(image).toMatchObject({ widthPx: 64, heightPx: 48 });
    expect(await sharp(thumbnail).metadata()).toMatchObject({ width: 64, height: 48 });
  });

  it('converts a JPEG', async () => {
    const bytes = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#00aa00' },
    })
      .jpeg()
      .toBuffer();
    const { image, full } = await convert(bytes);
    expect(image).toMatchObject({ format: 'jpeg', widthPx: 800, heightPx: 600 });
    expect((await sharp(full).metadata()).format).toBe('jpeg');
  });

  it('converts a binary PPM, as QEMU writes them', async () => {
    const { image, full } = await convert(ppm(640, 480, [10, 200, 30]));
    expect(image).toMatchObject({
      format: 'ppm',
      mimeType: 'image/x-portable-pixmap',
      widthPx: 640,
      heightPx: 480,
    });
    const { dominant } = await sharp(full).stats();
    expect(dominant.g).toBeGreaterThan(dominant.r);
    expect(dominant.g).toBeGreaterThan(dominant.b);
  });

  it('converts a text PPM, and scales its samples', () => {
    const decoded = decodePpm(Buffer.from('P3\n2 1\n15\n15 0 0  0 15 0\n'), limits);
    expect(decoded).toMatchObject({ width: 2, height: 1, channels: 3 });
    expect([...decoded.data]).toEqual([255, 0, 0, 0, 255, 0]);
  });

  it('reads a 16-bit PPM', () => {
    const data = Buffer.concat([
      Buffer.from('P6 1 1 65535\n'),
      Buffer.from([0xff, 0xff, 0x00, 0x00, 0x80, 0x00]),
    ]);
    expect([...decodePpm(data, limits).data]).toEqual([255, 0, 128]);
  });

  it.each([
    ['truncated pixels', Buffer.from('P6\n10 10\n255\nabc')],
    ['no maximum value', Buffer.from('P6\n10 10\n')],
    ['a zero size', Buffer.from('P6\n0 10\n255\n')],
    ['garbage in the header', Buffer.from('P6\n10 ten\n255\n')],
    ['a maximum out of range', Buffer.from('P6\n1 1\n70000\nabc')],
  ])('refuses a PPM with %s', (_label, data) => {
    expect(() => decodePpm(data, limits)).toThrow();
  });

  it('refuses a PPM claiming to be enormous before allocating anything', () => {
    const data = Buffer.from('P6\n100000 100000\n255\n');
    expect(() => decodePpm(data, limits)).toThrow(/longest side/);
  });

  it('converts 24-bit and 32-bit BMPs, the right way up', async () => {
    for (const bits of [24, 32] as const) {
      const { image, full } = await convert(bmp(40, 30, bits));
      expect(image).toMatchObject({ format: 'bmp', widthPx: 40, heightPx: 30 });
      const { data } = await sharp(full)
        .extract({ left: 20, top: 29, width: 1, height: 1 })
        .raw()
        .toBuffer({ resolveWithObject: true });
      // The file's first row is the image's last, and it is the blue one.
      expect(data[2] as number).toBeGreaterThan(data[0] as number);
    }
  });

  it('reads an 8-bit palette BMP', () => {
    const data = Buffer.alloc(54 + 8 + 4);
    data.write('BM', 0, 'latin1');
    data.writeUInt32LE(62, 10);
    data.writeUInt32LE(40, 14);
    data.writeInt32LE(2, 18);
    data.writeInt32LE(1, 22);
    data.writeUInt16LE(8, 28);
    data.writeUInt32LE(2, 46);
    data.set([0, 0, 255, 0, 0, 255, 0, 0], 54); // Red, green, in BGRA.
    data.set([1, 0], 62);
    expect([...decodeBmp(data, limits).data]).toEqual([0, 255, 0, 255, 0, 0]);
  });

  it('refuses a compressed BMP, and one shorter than it says', () => {
    const compressed = bmp(4, 4, 24);
    compressed.writeUInt32LE(1, 30);
    expect(() => decodeBmp(compressed, limits)).toThrow(/compressed/);
    expect(() => decodeBmp(bmp(4, 4, 24).subarray(0, 60), limits)).toThrow(/shorter/);
  });

  it('flattens transparency onto white', async () => {
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const { full } = await convert(bytes);
    const { channels } = await sharp(full).stats();
    expect(channels[0]?.mean).toBeGreaterThan(250);
    expect((await sharp(full).metadata()).hasAlpha).toBe(false);
  });

  it('drops metadata from what it produces', async () => {
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#888888' },
    })
      .withExif({ IFD0: { Copyright: 'SECRET-EXIF-VALUE' } })
      .jpeg()
      .toBuffer();
    expect(bytes.includes('SECRET-EXIF-VALUE')).toBe(true);
    const { full, thumbnail } = await convert(bytes);
    expect(full.includes('SECRET-EXIF-VALUE')).toBe(false);
    expect(thumbnail.includes('SECRET-EXIF-VALUE')).toBe(false);
  });

  it('recognizes formats from their contents only', () => {
    expect(sniffImageFormat(Buffer.from('P6\n'))).toBe('ppm');
    expect(sniffImageFormat(Buffer.from('P3 '))).toBe('ppm');
    expect(sniffImageFormat(Buffer.from('P5\n'))).toBeNull();
    expect(sniffImageFormat(Buffer.from('Paris\n'))).toBeNull();
    expect(sniffImageFormat(Buffer.from([0xff, 0xd8, 0xff]))).toBe('jpeg');
    expect(sniffImageFormat(Buffer.alloc(0))).toBeNull();
  });

  it('keeps the original byte for byte, and serves it only to an administrator', async () => {
    const vm = await newVm(agent.agentId, 'qemu');
    const bytes = ppm(32, 24, [1, 2, 3]);
    const { mediaId } = mediaUploadResponseSchema.parse((await upload(vm, bytes)).json());
    const original = await admin.get(`${vm.admin}/media/${mediaId}/original`);
    expect(original.statusCode).toBe(200);
    expect(original.rawPayload.equals(bytes)).toBe(true);
    expect(original.headers['content-type']).toBe('image/x-portable-pixmap');
    expect(original.headers['content-disposition']).toBe(
      'attachment; filename="screenshot001.ppm"',
    );
    expect(original.headers['cache-control']).toBe('private, no-store');
    expect(original.headers['x-content-type-options']).toBe('nosniff');

    const full = await admin.get(`${vm.admin}/media/${mediaId}/full`);
    expect(full.headers['content-type']).toBe('image/jpeg');
    expect(await sharp(full.rawPayload).metadata()).toMatchObject({ width: 32, height: 24 });
    const detail = adminMediaDetailSchema.parse(
      (await admin.get(`${vm.admin}/media/${mediaId}`)).json(),
    );
    expect(detail).toMatchObject({
      originalSha256: sha(bytes),
      originalMimeType: 'image/x-portable-pixmap',
      uploadedByAgentId: agent.agentId,
      uploadedByAgentName: 'Desk PC',
    });
    expect(JSON.stringify(detail)).not.toMatch(/media\/(originals|full|thumbnails)/);
  });

  it('removes all three files when an item is deleted', async () => {
    const vm = await newVm();
    const before = await storedFiles();
    const { mediaId } = mediaUploadResponseSchema.parse(
      (await upload(vm, await PNG_RED(70, 50))).json(),
    );
    expect((await storedFiles()).length).toBe(before.length + 3);
    await admin.request({ method: 'DELETE', url: `${vm.admin}/media/${mediaId}` });
    expect(await storedFiles()).toEqual(before);
  });
});

describe('visibility', () => {
  async function published(vmVisibility: 'private' | 'public') {
    const vm = await newVm();
    const { mediaId } = mediaUploadResponseSchema.parse(
      (await upload(vm, await PNG_RED(80, 60))).json(),
    );
    await admin.request({
      method: 'PUT',
      url: `${vm.admin}/main-media`,
      payload: { mediaId },
    });
    await admin.request({
      method: 'PUT',
      url: `${vm.admin}/visibility`,
      payload: { visibility: vmVisibility },
    });
    return { vm, mediaId };
  }

  const anonymous = (url: string) =>
    context.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { host: HOST } });

  it('is private by default, through its VM, and selects no main image', async () => {
    const vm = await newVm();
    const { mediaId } = mediaUploadResponseSchema.parse(
      (await upload(vm, await PNG_RED(81, 61))).json(),
    );
    const [item] = await mediaOf(vm);
    expect(item).toMatchObject({ isMain: false, shownAsPublicMain: false });
    expect(item).not.toHaveProperty('visibility');
    expect((await anonymous(`/catalog/media/${mediaId}/thumbnail`)).statusCode).toBe(404);
  });

  it.each([
    ['private', 404],
    ['public', 200],
  ] as const)(
    'with a %s VM, the public gets %i for an uploaded screenshot',
    async (vmState, code) => {
      const { vm, mediaId } = await published(vmState);
      for (const variant of ['thumbnail', 'full']) {
        const response = await anonymous(`/catalog/media/${mediaId}/${variant}`);
        expect(response.statusCode, variant).toBe(code);
        if (code === 200) expect(response.headers['content-type']).toBe('image/jpeg');
      }
      const detail = await anonymous(`/catalog/vms/86box/${encodeURIComponent(vm.vmName)}`);
      if (vmState === 'private') {
        expect(detail.statusCode).toBe(404);
      } else {
        const parsed = publicVmDetailSchema.parse(detail.json());
        expect(parsed.mainImage?.id).toBe(mediaId);
        expect(parsed.gallery.map((item) => item.id)).toEqual([mediaId]);
      }
    },
  );

  it('never serves an original to the public, however visible the item is', async () => {
    const { mediaId } = await published('public');
    const response = await anonymous(`/catalog/media/${mediaId}/original`);
    expect(response.statusCode).toBe(400);
  });

  it('refuses every media route without a session', async () => {
    const { vm, mediaId } = await published('public');
    for (const url of [
      `${vm.admin}/media`,
      `${vm.admin}/media-sync`,
      `${vm.admin}/media/${mediaId}`,
      `${vm.admin}/media/${mediaId}/original`,
      `${vm.admin}/media/${mediaId}/full`,
    ]) {
      expect((await anonymous(url)).statusCode, url).toBe(401);
    }
  });

  it('requires the CSRF token to publish a VM or to select its cover', async () => {
    const { vm, mediaId } = await published('private');
    const publish = await admin.request({
      method: 'PUT',
      url: `${vm.admin}/visibility`,
      payload: { visibility: 'public' },
      csrf: false,
    });
    expect(publish.statusCode).toBe(403);
    const select = await admin.request({
      method: 'PUT',
      url: `${vm.admin}/main-media`,
      payload: { mediaId },
      csrf: false,
    });
    expect(select.statusCode).toBe(403);
    expect((await anonymous(`/catalog/media/${mediaId}/thumbnail`)).statusCode).toBe(404);
  });

  it('shows a new upload of a public VM at once, without changing the cover', async () => {
    const { vm, mediaId } = await published('public');
    const another = mediaUploadResponseSchema.parse(
      (await upload(vm, await PNG_RED(82, 62))).json(),
    );
    expect((await anonymous(`/catalog/media/${another.mediaId}/full`)).statusCode).toBe(200);
    const listed = publicCatalogResponseSchema.parse(
      (await anonymous(`/catalog/vms?q=${encodeURIComponent(vm.vmName)}`)).json(),
    );
    expect(listed.items[0]?.mainImage?.id).toBe(mediaId);
    const media = await mediaOf(vm);
    expect(media.find((item) => item.id === mediaId)?.isMain).toBe(true);
    expect(media.find((item) => item.id === another.mediaId)?.isMain).toBe(false);
  });

  it('shows the placeholder with no main image, or after clearing it', async () => {
    const { vm } = await published('public');
    await admin.request({ method: 'DELETE', url: `${vm.admin}/main-media` });
    const listed = publicCatalogResponseSchema.parse(
      (await anonymous(`/catalog/vms?q=${encodeURIComponent(vm.vmName)}`)).json(),
    );
    expect(listed.items[0]?.mainImage).toBeNull();
    expect((await mediaOf(vm)).every((item) => !item.isMain)).toBe(true);
  });

  it('keeps one main image through concurrent changes', async () => {
    const vm = await newVm();
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const { mediaId } = mediaUploadResponseSchema.parse(
        (await upload(vm, await PNG_RED(90 + index, 70))).json(),
      );
      ids.push(mediaId);
    }
    const responses = await Promise.all(
      ids.flatMap((mediaId) => [
        admin.request({ method: 'PUT', url: `${vm.admin}/main-media`, payload: { mediaId } }),
        admin.request({ method: 'PUT', url: `${vm.admin}/main-media`, payload: { mediaId } }),
      ]),
    );
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    const main = (await mediaOf(vm)).filter((item) => item.isMain);
    expect(main.length).toBe(1);
  });

  it('does not expose private media through another VM or a guess', async () => {
    const one = await newVm();
    const two = await newVm();
    const { mediaId } = mediaUploadResponseSchema.parse(
      (await upload(one, await PNG_RED(99, 70))).json(),
    );
    expect((await admin.get(`${two.admin}/media/${mediaId}/original`)).statusCode).toBe(404);
    expect((await admin.get(`${two.admin}/media/${mediaId}`)).statusCode).toBe(404);
    for (const url of [
      `/media/originals/${mediaId.slice(0, 2)}/${mediaId}.png`,
      `/storage/media/full/${mediaId.slice(0, 2)}/${mediaId}.jpg`,
    ]) {
      expect((await anonymous(url)).statusCode).toBe(404);
    }
  });
});

describe('the status an agent reports', () => {
  it('reaches the administrator, and only for the right VM', async () => {
    await context.app.listen({ host: '127.0.0.1', port: 0 });
    const vm = await newVm();
    const quiet = await newVm();
    const socket = await TestAgent.connect(wsUrl(context.app), agent.credential);
    await socket.hello();
    const empty = adminMediaSyncResponseSchema.parse(
      (await admin.get(`${vm.admin}/media-sync`)).json(),
    );
    expect(empty.agents[0]).toMatchObject({ agentId: agent.agentId, online: true, status: null });

    socket.send(
      envelope('agent.media_sync_status', {
        vms: [
          {
            emulatorType: vm.emulatorType,
            vmName: vm.vmName,
            pending: 2,
            uploading: 1,
            synchronized: 7,
            failed: 1,
            lastError: {
              code: 'invalid_image',
              message: 'The image could not be decoded',
              sourcePath: 'screenshots/bad.png',
            },
          },
        ],
        truncated: false,
      }),
    );
    const reported = await waitFor(async () => {
      const body = adminMediaSyncResponseSchema.parse(
        (await admin.get(`${vm.admin}/media-sync`)).json(),
      );
      return body.agents[0]?.status ?? null;
    }, 'the report');
    expect(reported).toMatchObject({ pending: 2, uploading: 1, synchronized: 7, failed: 1 });
    expect(reported.lastError?.sourcePath).toBe('screenshots/bad.png');
    const other = adminMediaSyncResponseSchema.parse(
      (await admin.get(`${quiet.admin}/media-sync`)).json(),
    );
    expect(other.agents[0]?.status).toBeNull();

    socket.close();
    await waitFor(async () => {
      const body = adminMediaSyncResponseSchema.parse(
        (await admin.get(`${vm.admin}/media-sync`)).json(),
      );
      return body.agents[0]?.online === false;
    }, 'the agent to be offline');
  });

  it('is refused if it is malformed, without closing the connection', async () => {
    const socket = await TestAgent.connect(wsUrl(context.app), other.credential);
    await socket.hello();
    socket.send(envelope('agent.media_sync_status', { vms: 'nonsense' }));
    const error = await socket.next('server.error');
    expect(error.payload.code).toBe('unsupported_message');
    socket.close();
  });
});
