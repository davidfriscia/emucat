/**
 * Screenshot deletion that stays deleted, the gallery's persistent order, and tags with tag-aware search
 * (decision 0050). On a real database and real files, through the real routes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  adminCatalogResponseSchema,
  adminMediaListResponseSchema,
  adminVmDetailSchema,
  createTagResponseSchema,
  entityTagsResponseSchema,
  mediaAcknowledgementResponseSchema,
  mediaUploadResponseSchema,
  PROTOCOL_VERSION,
  publicCatalogResponseSchema,
  publicVmDetailSchema,
  tagListResponseSchema,
  versionTreeResponseSchema,
  type Tag,
} from '@emucat/contracts';
import type { LightMyRequestResponse } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MEDIA_POLICY } from '../src/media/uploads.js';
import { GENEROUS_RATE_LIMITS, pairAgent } from './agent-helpers.js';
import {
  HOST,
  insertMedia,
  insertVm,
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from './browser-app.js';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const png = (width: number, height: number, background = '#cc0000') =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();

let context: BrowserTestContext;
let admin: TestClient;
let agent: { agentId: string; credential: string };
let names = 0;
let repositoryId: string;

beforeAll(async () => {
  context = await startBrowserApp({
    pairingRateLimits: GENEROUS_RATE_LIMITS,
    media: { ...DEFAULT_MEDIA_POLICY, maxUploadBytes: 4 * 1024 * 1024 },
  });
  admin = await signedInAdmin(context);
  agent = await pairAgent(context.app, admin);
  repositoryId = randomUUID();
  await context.pool.execute(
    "INSERT INTO repositories (id, name, kind) VALUES (?, 'NAS', 'test')",
    [repositoryId],
  );
});

afterAll(async () => {
  await context.close();
});

interface TestVm {
  emulatorType: 'qemu' | '86box';
  vmName: string;
  agentPath: string;
  admin: string;
  publicPath: string;
}

async function newVm(
  options: {
    visibility?: 'private' | 'public';
    displayName?: string;
    emulatorType?: 'qemu' | '86box';
  } = {},
): Promise<TestVm> {
  names += 1;
  const emulatorType = options.emulatorType ?? '86box';
  const vmName = `Tagged ${names}`;
  await insertVm(context.pool, {
    emulatorType,
    vmName,
    visibility: options.visibility ?? 'private',
    displayName: options.displayName ?? null,
  });
  await context.pool.execute(
    'INSERT INTO agent_vm_state (agent_id, emulator_type, vm_name) VALUES (?, ?, ?)',
    [agent.agentId, emulatorType, vmName],
  );
  const segments = `${emulatorType}/${encodeURIComponent(vmName)}`;
  return {
    emulatorType,
    vmName,
    agentPath: `/api/v1/agent/media/vms/${segments}`,
    admin: `/admin/vms/${segments}`,
    publicPath: `/catalog/vms/${segments}`,
  };
}

function agentHeaders(): Record<string, string> {
  return {
    host: HOST,
    authorization: `Bearer ${agent.credential}`,
    'x-emucat-protocol-version': String(PROTOCOL_VERSION),
  };
}

function upload(
  vm: TestVm,
  bytes: Buffer,
  options: { sourcePath?: string; captureId?: string } = {},
): Promise<LightMyRequestResponse> {
  const sourcePath =
    options.sourcePath ?? (vm.emulatorType === 'qemu' ? 'shot.ppm' : 'screenshots/one.png');
  return context.app.inject({
    method: 'PUT',
    url: `${vm.agentPath}/screenshots/${sha(bytes)}`,
    headers: {
      ...agentHeaders(),
      'content-type': 'application/octet-stream',
      'x-emucat-source-path': encodeURIComponent(sourcePath),
      ...(options.captureId ? { 'x-emucat-capture-id': options.captureId } : {}),
    },
    payload: bytes,
  });
}

async function acknowledged(vm: TestVm, hashes: string[]): Promise<string[]> {
  const response = await context.app.inject({
    method: 'POST',
    url: `${vm.agentPath}/acknowledgements`,
    headers: agentHeaders(),
    payload: { sha256: hashes },
  });
  return mediaAcknowledgementResponseSchema.parse(response.json()).acknowledged;
}

const mediaIds = async (vm: TestVm) =>
  adminMediaListResponseSchema
    .parse((await admin.get(`${vm.admin}/media`)).json())
    .media.map((item) => item.id);

const send = (method: 'PUT' | 'POST' | 'DELETE', url: string, payload?: object) =>
  admin.request({ method, url, ...(payload ? { payload } : {}) });

async function tag(name: string): Promise<Tag> {
  const response = await send('POST', '/admin/tags', { name });
  expect([200, 201]).toContain(response.statusCode);
  return createTagResponseSchema.parse(response.json()).tag;
}

async function anonymousGet(url: string): Promise<LightMyRequestResponse> {
  return context.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { host: HOST } });
}

async function insertVersion(
  vm: TestVm,
  kind: 'master' | 'snapshot',
  parent: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await context.pool.execute(
    `INSERT INTO vm_versions (id, emulator_type, vm_name, kind, parent_version_id, snapshot_name,
       repository_id, archive_key, archive_sha256, archive_size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      id,
      vm.emulatorType,
      vm.vmName,
      kind,
      parent,
      kind === 'snapshot' ? 'SNAP_202601010000' : null,
      repositoryId,
      `archives/${id}.zip`,
      sha(id),
    ],
  );
  return id;
}

describe('deleting a screenshot from the catalog', () => {
  it('removes it, its files, its tags and the main selection, and keeps the others in order', async () => {
    const vm = await newVm();
    const ids: string[] = [];
    for (const [index, colour] of ['#110000', '#220000', '#330000'].entries()) {
      const response = await upload(vm, await png(20 + index, 10, colour), {
        sourcePath: `screenshots/${index}.png`,
      });
      expect(response.statusCode).toBe(201);
      ids.push(mediaUploadResponseSchema.parse(response.json()).mediaId);
    }
    const [first, second, third] = ids as [string, string, string];
    expect((await send('PUT', `${vm.admin}/main-media`, { mediaId: second })).statusCode).toBe(200);
    const bios = await tag('bios');
    expect(
      (await send('PUT', `${vm.admin}/media/${second}/tags`, { tagIds: [bios.id] })).statusCode,
    ).toBe(200);
    const [keys] = await context.pool.execute<RowDataPacket[]>(
      'SELECT original_key, jpeg_key, thumbnail_key FROM vm_media WHERE id = ?',
      [second],
    );
    const files = Object.values(keys[0] ?? {}).map((key) =>
      join(context.storageRoot, key as string),
    );
    expect(files.every((file) => existsSync(file))).toBe(true);

    const deleted = await send('DELETE', `${vm.admin}/media/${second}`);
    expect(deleted.statusCode).toBe(200);
    const after = adminMediaListResponseSchema.parse(deleted.json()).media;
    expect(after.map((item) => item.id)).toEqual([first, third]);
    expect(after.some((item) => item.isMain)).toBe(false);
    expect(files.some((file) => existsSync(file))).toBe(false);
    const [tagRows] = await context.pool.execute<RowDataPacket[]>(
      'SELECT 1 FROM vm_media_tags WHERE media_id = ?',
      [second],
    );
    expect(tagRows).toHaveLength(0);
    const detail = adminVmDetailSchema.parse((await admin.get(vm.admin)).json());
    expect(detail.mainMediaId).toBeNull();
    // The tag itself stays in the catalog, for reuse.
    const listed = tagListResponseSchema.parse((await admin.get('/admin/tags?q=bios')).json());
    expect(listed.tags.map((item) => item.id)).toContain(bios.id);
  });

  it('answers 404 for an unknown, already deleted, or other VM’s screenshot', async () => {
    const vm = await newVm();
    const other = await newVm();
    const response = await upload(vm, await png(30, 30));
    const { mediaId } = mediaUploadResponseSchema.parse(response.json());
    const fromOther = await send('DELETE', `${other.admin}/media/${mediaId}`);
    expect(fromOther.statusCode).toBe(404);
    expect(fromOther.json<{ error: { code: string } }>().error.code).toBe('media_not_found');
    expect((await send('DELETE', `${vm.admin}/media/${mediaId}`)).statusCode).toBe(200);
    const again = await send('DELETE', `${vm.admin}/media/${mediaId}`);
    expect(again.statusCode).toBe(404);
    expect((await send('DELETE', `${vm.admin}/media/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('refuses without an administrator session', async () => {
    const vm = await newVm();
    const { mediaId } = mediaUploadResponseSchema.parse(
      (await upload(vm, await png(31, 30))).json(),
    );
    const anonymous = new TestClient(context.app);
    expect(
      (await anonymous.request({ method: 'DELETE', url: `${vm.admin}/media/${mediaId}` }))
        .statusCode,
    ).toBe(401);
    expect(await mediaIds(vm)).toEqual([mediaId]);
  });

  it('leaves a file another screenshot still refers to', async () => {
    const vm = await newVm();
    const shared = { jpegKey: 'media/shared/full.jpg', thumbnailKey: 'media/shared/thumb.jpg' };
    const one = await insertMedia(context, vm, shared);
    await insertMedia(context, vm, { ...shared, writeFiles: false });
    expect((await send('DELETE', `${vm.admin}/media/${one.id}`)).statusCode).toBe(200);
    expect(existsSync(join(context.storageRoot, shared.jpegKey))).toBe(true);
    expect(existsSync(join(context.storageRoot, shared.thumbnailKey))).toBe(true);
  });

  it('does not come back when the agent finds and uploads the same file again', async () => {
    const vm = await newVm();
    const bytes = await png(40, 30);
    const { mediaId } = mediaUploadResponseSchema.parse((await upload(vm, bytes)).json());
    expect((await send('DELETE', `${vm.admin}/media/${mediaId}`)).statusCode).toBe(200);

    // A rebuilt agent queue asks first. The hash is not acknowledged, so a transfer still cannot rely on it...
    expect(await acknowledged(vm, [sha(bytes)])).toEqual([]);
    // ...and the upload that follows succeeds without storing anything, so the agent marks the file done.
    const again = await upload(vm, bytes, { sourcePath: 'screenshots/renamed.png' });
    expect(again.statusCode).toBe(200);
    expect(mediaUploadResponseSchema.parse(again.json())).toEqual({
      mediaId,
      sha256: sha(bytes),
      created: false,
      suppressed: true,
    });
    expect(await mediaIds(vm)).toEqual([]);
    const [rows] = await context.pool.execute<RowDataPacket[]>(
      'SELECT media_id, original_filename FROM vm_media_suppressions WHERE emulator_type = ? AND vm_name = ?',
      [vm.emulatorType, vm.vmName],
    );
    expect(rows).toEqual([{ media_id: mediaId, original_filename: 'screenshots/one.png' }]);
  });

  it('suppresses only these bytes, for this VM', async () => {
    const vm = await newVm();
    const other = await newVm();
    const bytes = await png(41, 30);
    const { mediaId } = mediaUploadResponseSchema.parse((await upload(vm, bytes)).json());
    expect((await send('DELETE', `${vm.admin}/media/${mediaId}`)).statusCode).toBe(200);
    // A changed file is new content.
    expect((await upload(vm, await png(41, 31))).statusCode).toBe(201);
    // The same bytes in another VM are another VM's screenshot.
    expect((await upload(other, bytes)).statusCode).toBe(201);
  });

  it('comes back when an administrator explicitly captures identical bytes', async () => {
    const vm = await newVm({ emulatorType: 'qemu' });
    const bytes = await png(42, 30);
    const { mediaId } = mediaUploadResponseSchema.parse((await upload(vm, bytes)).json());
    expect((await send('DELETE', `${vm.admin}/media/${mediaId}`)).statusCode).toBe(200);
    const sessionId = randomUUID();
    const captureId = randomUUID();
    await context.pool.execute(
      `INSERT INTO vm_sessions (id, agent_id, emulator_type, vm_name) VALUES (?, ?, 'qemu', ?)`,
      [sessionId, agent.agentId, vm.vmName],
    );
    await context.pool.execute(
      `INSERT INTO qemu_captures (id, request_id, session_id, agent_id, emulator_type, vm_name, mode, state)
       VALUES (?, ?, ?, ?, 'qemu', ?, 'local', 'uploading')`,
      [captureId, randomUUID(), sessionId, agent.agentId, vm.vmName],
    );
    const captured = await upload(vm, bytes, {
      captureId,
      sourcePath: `emucat-capture-${captureId}.ppm`,
    });
    expect(captured.statusCode).toBe(201);
    expect(await mediaIds(vm)).toHaveLength(1);
    const [rows] = await context.pool.execute<RowDataPacket[]>(
      'SELECT 1 FROM vm_media_suppressions WHERE emulator_type = ? AND vm_name = ?',
      [vm.emulatorType, vm.vmName],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('the order of a VM’s screenshots', () => {
  async function threeScreenshots(vm: TestVm): Promise<string[]> {
    const ids: string[] = [];
    for (const [index, colour] of ['#001100', '#002200', '#003300'].entries()) {
      const response = await upload(vm, await png(50 + index, 20, colour), {
        sourcePath: `screenshots/${index}.png`,
      });
      ids.push(mediaUploadResponseSchema.parse(response.json()).mediaId);
    }
    return ids;
  }

  it('appends new screenshots, saves a new order, and keeps it on every read and after new arrivals', async () => {
    const vm = await newVm({ visibility: 'public' });
    const [a, b, c] = (await threeScreenshots(vm)) as [string, string, string];
    expect(await mediaIds(vm)).toEqual([a, b, c]);
    expect((await send('PUT', `${vm.admin}/main-media`, { mediaId: a })).statusCode).toBe(200);

    const saved = await send('PUT', `${vm.admin}/media-order`, { mediaIds: [c, a, b] });
    expect(saved.statusCode).toBe(200);
    expect(adminMediaListResponseSchema.parse(saved.json()).media.map((item) => item.id)).toEqual([
      c,
      a,
      b,
    ]);
    expect(await mediaIds(vm)).toEqual([c, a, b]);
    // The cover is independent of the order.
    expect(adminVmDetailSchema.parse((await admin.get(vm.admin)).json()).mainMediaId).toBe(a);
    const publicGallery = publicVmDetailSchema
      .parse((await anonymousGet(vm.publicPath)).json())
      .gallery.map((item) => item.id);
    expect(publicGallery).toEqual([c, a, b]);

    const { mediaId: d } = mediaUploadResponseSchema.parse(
      (
        await upload(vm, await png(60, 20, '#004400'), { sourcePath: 'screenshots/new.png' })
      ).json(),
    );
    expect(await mediaIds(vm)).toEqual([c, a, b, d]);
    expect((await send('DELETE', `${vm.admin}/media/${a}`)).statusCode).toBe(200);
    expect(await mediaIds(vm)).toEqual([c, b, d]);
  });

  it('refuses duplicates, unknown, missing and other VMs’ screenshots, and changes nothing', async () => {
    const vm = await newVm();
    const other = await newVm();
    const [a, b, c] = (await threeScreenshots(vm)) as [string, string, string];
    const [foreign] = (await threeScreenshots(other)) as [string];
    const attempts: { ids: string[]; status: number; code: string }[] = [
      { ids: [a, a, b], status: 400, code: 'validation_failed' },
      { ids: [a, b], status: 409, code: 'media_order_conflict' },
      { ids: [a, b, c, randomUUID()], status: 409, code: 'media_order_conflict' },
      { ids: [a, b, foreign], status: 409, code: 'media_order_conflict' },
      { ids: [], status: 400, code: 'validation_failed' },
    ];
    for (const attempt of attempts) {
      const response = await send('PUT', `${vm.admin}/media-order`, { mediaIds: attempt.ids });
      expect(response.statusCode, JSON.stringify(attempt.ids)).toBe(attempt.status);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(attempt.code);
    }
    expect(await mediaIds(vm)).toEqual([a, b, c]);
    expect(
      (await send('PUT', `/admin/vms/qemu/Nobody/media-order`, { mediaIds: [a] })).statusCode,
    ).toBe(404);
  });

  it('applies concurrent orders one at a time, so the result is exactly one of them', async () => {
    const vm = await newVm();
    const [a, b, c] = (await threeScreenshots(vm)) as [string, string, string];
    const orders = [
      [c, b, a],
      [b, c, a],
      [a, c, b],
      [c, a, b],
    ];
    const responses = await Promise.all(
      orders.map((order) => send('PUT', `${vm.admin}/media-order`, { mediaIds: order })),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    const final = await mediaIds(vm);
    expect(orders).toContainEqual(final);
  });

  it('refuses without an administrator session', async () => {
    const vm = await newVm();
    const [a, b, c] = (await threeScreenshots(vm)) as [string, string, string];
    const anonymous = new TestClient(context.app);
    const response = await anonymous.request({
      method: 'PUT',
      url: `${vm.admin}/media-order`,
      payload: { mediaIds: [c, b, a] },
    });
    expect(response.statusCode).toBe(401);
    expect(await mediaIds(vm)).toEqual([a, b, c]);
  });
});

describe('tags', () => {
  it('normalizes names, and never creates two tags that differ only in case or a #', async () => {
    const created = await send('POST', '/admin/tags', { name: '  #Windows 95 ' });
    expect(created.statusCode).toBe(201);
    const first = createTagResponseSchema.parse(created.json());
    expect(first).toMatchObject({ created: true, tag: { name: 'Windows-95' } });
    for (const variant of ['windows-95', '#WINDOWS-95', '##windows-95']) {
      const again = await send('POST', '/admin/tags', { name: variant });
      expect(again.statusCode, variant).toBe(200);
      expect(createTagResponseSchema.parse(again.json())).toEqual({
        created: false,
        tag: first.tag,
      });
    }
    const [rows] = await context.pool.execute<RowDataPacket[]>(
      'SELECT name, normalized_name FROM tags WHERE normalized_name = ?',
      ['windows-95'],
    );
    expect(rows).toEqual([{ name: 'Windows-95', normalized_name: 'windows-95' }]);
  });

  it('refuses empty, overlong and malformed names', async () => {
    for (const name of [
      '',
      '   ',
      '#',
      '##  ',
      'a'.repeat(49),
      'semi;colon',
      '<b>',
      '-leading',
      'a#b',
    ]) {
      const response = await send('POST', '/admin/tags', { name });
      expect(response.statusCode, name).toBe(400);
    }
  });

  it('creates one tag when two administrators create it at once', async () => {
    const responses = await Promise.all(
      ['Racing', 'racing', '#RACING', ' racing '].map((name) =>
        send('POST', '/admin/tags', { name }),
      ),
    );
    const ids = new Set(
      responses.map((response) => createTagResponseSchema.parse(response.json()).tag.id),
    );
    expect(ids.size).toBe(1);
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
  });

  it('lists and searches tags, with or without #, for administrators only', async () => {
    await tag('flight-sim');
    await tag('simcity');
    const found = tagListResponseSchema.parse((await admin.get('/admin/tags?q=%23sim')).json());
    const names = found.tags.map((item) => item.name);
    expect(names).toContain('simcity');
    expect(names).toContain('flight-sim');
    // A name that starts with the text comes before one that only contains it.
    expect(names.indexOf('simcity')).toBeLessThan(names.indexOf('flight-sim'));
    expect((await anonymousGet('/admin/tags')).statusCode).toBe(401);
    expect((await anonymousGet('/tags')).statusCode).toBe(404);
  });

  it('assigns tags to a VM, a master, a snapshot and a screenshot independently', async () => {
    const vm = await newVm();
    const { mediaId } = mediaUploadResponseSchema.parse(
      (await upload(vm, await png(70, 20))).json(),
    );
    const master = await insertVersion(vm, 'master');
    const snapshot = await insertVersion(vm, 'snapshot', master);
    const [retro, dos, gold, bios] = await Promise.all(['retro', 'dos', 'gold', 'bios'].map(tag));

    const put = async (path: string, tags: Tag[]) => {
      const response = await send('PUT', `${vm.admin}${path}/tags`, {
        tagIds: tags.map((item) => item!.id),
      });
      expect(response.statusCode, path).toBe(200);
      return entityTagsResponseSchema.parse(response.json()).tags.map((item) => item.name);
    };
    expect(await put('', [retro!, dos!])).toEqual(['dos', 'retro']);
    expect(await put(`/versions/${master}`, [gold!])).toEqual(['gold']);
    expect(await put(`/versions/${snapshot}`, [dos!])).toEqual(['dos']);
    expect(await put(`/media/${mediaId}`, [bios!])).toEqual(['bios']);

    // Nothing is inherited, in either direction.
    const detail = adminVmDetailSchema.parse((await admin.get(vm.admin)).json());
    expect(detail.tags.map((item) => item.name)).toEqual(['dos', 'retro']);
    const tree = versionTreeResponseSchema.parse((await admin.get(`${vm.admin}/versions`)).json());
    const byId = new Map(
      tree.versions.map((node) => [node.id, node.tags.map((item) => item.name)]),
    );
    expect(byId.get(master)).toEqual(['gold']);
    expect(byId.get(snapshot)).toEqual(['dos']);
    const media = adminMediaListResponseSchema.parse(
      (await admin.get(`${vm.admin}/media`)).json(),
    ).media;
    expect(media[0]?.tags.map((item) => item.name)).toEqual(['bios']);

    // Removing one association leaves the others, and the tag.
    expect(await put('', [retro!])).toEqual(['retro']);
    expect(await put(`/media/${mediaId}`, [])).toEqual([]);
    const read = await admin.get(`${vm.admin}/versions/${snapshot}/tags`);
    expect(entityTagsResponseSchema.parse(read.json()).tags.map((item) => item.name)).toEqual([
      'dos',
    ]);
  });

  it('refuses unknown tags, duplicates, other VMs’ entities and deleted versions, and changes nothing', async () => {
    const vm = await newVm();
    const other = await newVm();
    const { mediaId } = mediaUploadResponseSchema.parse(
      (await upload(other, await png(71, 20))).json(),
    );
    const otherMaster = await insertVersion(other, 'master');
    const kept = await tag('kept');
    expect((await send('PUT', `${vm.admin}/tags`, { tagIds: [kept.id] })).statusCode).toBe(200);

    const unknown = await send('PUT', `${vm.admin}/tags`, { tagIds: [kept.id, randomUUID()] });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe('unknown_tag');
    expect((await send('PUT', `${vm.admin}/tags`, { tagIds: [kept.id, kept.id] })).statusCode).toBe(
      400,
    );
    expect(
      (await send('PUT', `${vm.admin}/media/${mediaId}/tags`, { tagIds: [kept.id] })).statusCode,
    ).toBe(404);
    expect(
      (await send('PUT', `${vm.admin}/versions/${otherMaster}/tags`, { tagIds: [kept.id] }))
        .statusCode,
    ).toBe(404);
    expect((await send('PUT', `/admin/vms/qemu/Nobody/tags`, { tagIds: [] })).statusCode).toBe(404);
    const tags = entityTagsResponseSchema.parse((await admin.get(`${vm.admin}/tags`)).json()).tags;
    expect(tags.map((item) => item.id)).toEqual([kept.id]);

    const anonymous = new TestClient(context.app);
    const refused = await anonymous.request({
      method: 'PUT',
      url: `${vm.admin}/tags`,
      payload: { tagIds: [] },
    });
    expect(refused.statusCode).toBe(401);
  });

  it('shows a public VM’s and its screenshots’ tags publicly, and never a version’s', async () => {
    const vm = await newVm({ visibility: 'public' });
    const { mediaId } = mediaUploadResponseSchema.parse(
      (await upload(vm, await png(72, 20))).json(),
    );
    const master = await insertVersion(vm, 'master');
    const [shown, shot, secret] = await Promise.all(['shown', 'shot', 'secret-build'].map(tag));
    await send('PUT', `${vm.admin}/tags`, { tagIds: [shown!.id] });
    await send('PUT', `${vm.admin}/media/${mediaId}/tags`, { tagIds: [shot!.id] });
    await send('PUT', `${vm.admin}/versions/${master}/tags`, { tagIds: [secret!.id] });

    const detail = await anonymousGet(vm.publicPath);
    const parsed = publicVmDetailSchema.parse(detail.json());
    expect(parsed.tags.map((item) => item.name)).toEqual(['shown']);
    expect(parsed.gallery[0]?.tags.map((item) => item.name)).toEqual(['shot']);
    expect(detail.body).not.toContain('secret-build');
    const cards = publicCatalogResponseSchema.parse(
      (await anonymousGet('/catalog/vms?pageSize=100')).json(),
    );
    const card = cards.items.find((item) => item.vmName === vm.vmName);
    expect(card?.tags.map((item) => item.name)).toEqual(['shown']);
  });
});

describe('searching by tag', () => {
  interface World {
    ownTag: TestVm;
    snapshotTag: TestVm;
    masterTag: TestVm;
    screenshotTag: TestVm;
    privateOwn: TestVm;
    all: TestVm;
    deletedSnapshot: TestVm;
  }
  let world: World;

  beforeAll(async () => {
    const [sharedTag, onlyPrivate, deletedOnly] = await Promise.all([
      tag('Shared-Tag'),
      tag('private-only'),
      tag('gone-tag'),
    ]);
    const own = await newVm({ visibility: 'public', displayName: 'Search own' });
    await send('PUT', `${own.admin}/tags`, { tagIds: [sharedTag.id] });

    const snapshotVm = await newVm({ visibility: 'public', displayName: 'Search snapshot' });
    const master = await insertVersion(snapshotVm, 'master');
    const snapshot = await insertVersion(snapshotVm, 'snapshot', master);
    await send('PUT', `${snapshotVm.admin}/versions/${snapshot}/tags`, { tagIds: [sharedTag.id] });

    const masterVm = await newVm({ visibility: 'public', displayName: 'Search master' });
    const masterId = await insertVersion(masterVm, 'master');
    await send('PUT', `${masterVm.admin}/versions/${masterId}/tags`, { tagIds: [sharedTag.id] });

    const screenshotVm = await newVm({ visibility: 'public', displayName: 'Search screenshot' });
    const { mediaId } = mediaUploadResponseSchema.parse(
      (await upload(screenshotVm, await png(80, 20))).json(),
    );
    await send('PUT', `${screenshotVm.admin}/media/${mediaId}/tags`, { tagIds: [sharedTag.id] });

    const privateOwn = await newVm({ visibility: 'private', displayName: 'Search private' });
    await send('PUT', `${privateOwn.admin}/tags`, { tagIds: [sharedTag.id, onlyPrivate.id] });
    const { mediaId: privateShot } = mediaUploadResponseSchema.parse(
      (await upload(privateOwn, await png(81, 20))).json(),
    );
    await send('PUT', `${privateOwn.admin}/media/${privateShot}/tags`, {
      tagIds: [onlyPrivate.id],
    });

    // Several children with the same tag: still one result.
    const all = await newVm({ visibility: 'public', displayName: 'Search all' });
    await send('PUT', `${all.admin}/tags`, { tagIds: [sharedTag.id] });
    const allMaster = await insertVersion(all, 'master');
    await send('PUT', `${all.admin}/versions/${allMaster}/tags`, { tagIds: [sharedTag.id] });
    for (const index of [0, 1]) {
      const { mediaId: shot } = mediaUploadResponseSchema.parse(
        (
          await upload(all, await png(82 + index, 20), { sourcePath: `screenshots/${index}.png` })
        ).json(),
      );
      await send('PUT', `${all.admin}/media/${shot}/tags`, { tagIds: [sharedTag.id] });
    }

    // A snapshot being deleted no longer makes its VM match.
    const deletedSnapshot = await newVm({ visibility: 'public', displayName: 'Search deleted' });
    const dm = await insertVersion(deletedSnapshot, 'master');
    const ds = await insertVersion(deletedSnapshot, 'snapshot', dm);
    await send('PUT', `${deletedSnapshot.admin}/versions/${ds}/tags`, { tagIds: [deletedOnly.id] });
    await context.pool.execute(
      `INSERT INTO vm_version_deletions (version_id, emulator_type, vm_name, request_id, repository_id,
         archive_key, archive_sha256, archive_size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        ds,
        deletedSnapshot.emulatorType,
        deletedSnapshot.vmName,
        randomUUID(),
        repositoryId,
        `archives/${ds}.zip`,
        sha(ds),
      ],
    );

    world = {
      ownTag: own,
      snapshotTag: snapshotVm,
      masterTag: masterVm,
      screenshotTag: screenshotVm,
      privateOwn,
      all,
      deletedSnapshot,
    };
  });

  const adminSearch = async (q: string) =>
    adminCatalogResponseSchema
      .parse((await admin.get(`/admin/vms?pageSize=100&q=${encodeURIComponent(q)}`)).json())
      .items.map((item) => item.vmName);
  const publicSearch = async (q: string) =>
    publicCatalogResponseSchema
      .parse((await anonymousGet(`/catalog/vms?pageSize=100&q=${encodeURIComponent(q)}`)).json())
      .items.map((item) => item.vmName);

  it('finds a VM by its own, its snapshots’, its masters’ and its screenshots’ tags, for administrators', async () => {
    for (const q of ['Shared-Tag', '#shared-tag', '#SHARED-TAG', 'shared tag', 'shared-t']) {
      const found = await adminSearch(q);
      for (const vm of [
        world.ownTag,
        world.snapshotTag,
        world.masterTag,
        world.screenshotTag,
        world.privateOwn,
        world.all,
      ]) {
        expect(found, `${q} → ${vm.vmName}`).toContain(vm.vmName);
      }
      // No duplicates, however many children match.
      expect(new Set(found).size).toBe(found.length);
    }
  });

  it('matches a # search exactly, and plain text by containment', async () => {
    expect(await adminSearch('#shared')).not.toContain(world.ownTag.vmName);
    expect(await adminSearch('shared')).toContain(world.ownTag.vmName);
  });

  it('keeps the public search to public VMs, their own tags and their screenshots’ tags', async () => {
    const found = await publicSearch('#shared-tag');
    expect(found).toContain(world.ownTag.vmName);
    expect(found).toContain(world.screenshotTag.vmName);
    expect(found).toContain(world.all.vmName);
    expect(found.filter((name) => name === world.all.vmName)).toHaveLength(1);
    // Versions are administrative: their tags never make a VM public-searchable.
    expect(found).not.toContain(world.snapshotTag.vmName);
    expect(found).not.toContain(world.masterTag.vmName);
    // A private VM, and its screenshots' tags, never appear.
    expect(found).not.toContain(world.privateOwn.vmName);
    expect(await publicSearch('private-only')).toEqual([]);
    expect(await publicSearch('#private-only')).toEqual([]);
  });

  it('ignores a version that is deleted or being deleted', async () => {
    expect(await adminSearch('#gone-tag')).toEqual([]);
  });

  it('paginates deterministically, with a total that counts each VM once', async () => {
    const response = adminCatalogResponseSchema.parse(
      (await admin.get(`/admin/vms?pageSize=2&q=${encodeURIComponent('#shared-tag')}`)).json(),
    );
    expect(response.pagination.total).toBe(6);
    const pages: string[] = [];
    for (let page = 1; page <= response.pagination.totalPages; page += 1) {
      const items = adminCatalogResponseSchema
        .parse((await admin.get(`/admin/vms?pageSize=2&page=${page}&q=%23shared-tag`)).json())
        .items.map((item) => item.vmName);
      pages.push(...items);
    }
    expect(pages).toHaveLength(6);
    expect(new Set(pages).size).toBe(6);
  });

  it('stops matching as soon as an association is removed', async () => {
    const vm = await newVm({ visibility: 'public' });
    const fleeting = await tag('fleeting');
    await send('PUT', `${vm.admin}/tags`, { tagIds: [fleeting.id] });
    expect(await publicSearch('#fleeting')).toEqual([vm.vmName]);
    await send('PUT', `${vm.admin}/tags`, { tagIds: [] });
    expect(await publicSearch('#fleeting')).toEqual([]);
  });
});
