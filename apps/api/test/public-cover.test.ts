/**
 * The public catalog's cover, across every combination that can decide it, with real rows and real files.
 * What this file exists to protect: a public VM does not make its media public, and when both are
 * published the image really is reachable with no session at all.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  adminCatalogResponseSchema,
  adminVmDetailSchema,
  publicCatalogResponseSchema,
  publicVmDetailSchema,
} from '@emucat/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD,
  insertVm,
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from './browser-app.js';

let context: BrowserTestContext;
let anonymous: TestClient;
let admin: TestClient;

afterAll(async () => context.close());

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

interface Item {
  id: string;
  files: { full: string; thumbnail: string; original: string };
}

let counter = 0;

async function addMedia(
  vmName: string,
  { visibility = 'private', isMain = false }: { visibility?: string; isMain?: boolean } = {},
): Promise<Item> {
  counter += 1;
  const id = randomUUID();
  const keys = {
    full: `media/full/${id}.jpg`,
    thumbnail: `media/thumbnails/${id}.jpg`,
    original: `media/originals/${id}.png`,
  };
  for (const [variant, key] of Object.entries(keys)) {
    const path = join(context.storageRoot, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.concat([JPEG, Buffer.from(`${variant}:${id}`)]));
  }
  await context.pool.execute(
    `INSERT INTO vm_media
       (id, emulator_type, vm_name, visibility, is_main, original_filename, original_sha256,
        original_size_bytes, original_key, original_mime, jpeg_key, thumbnail_key, width_px, height_px)
     VALUES (?, 'qemu', ?, ?, ?, ?, ?, 10, ?, 'image/png', ?, ?, 640, 480)`,
    [
      id,
      vmName,
      visibility,
      isMain,
      `SENTINEL-${id}.png`,
      counter.toString(16).padStart(64, '0'),
      keys.original,
      keys.full,
      keys.thumbnail,
    ],
  );
  return { id, files: keys };
}

const publicCards = async () => {
  const response = await anonymous.get('/catalog/vms?pageSize=100');
  expect(response.statusCode, response.body).toBe(200);
  return publicCatalogResponseSchema.parse(response.json()).items;
};

const publicCard = async (vmName: string) =>
  (await publicCards()).find((card) => card.vmName === vmName);

const publicDetail = async (vmName: string) => {
  const response = await anonymous.get(`/catalog/vms/qemu/${vmName}`);
  return response.statusCode === 200 ? publicVmDetailSchema.parse(response.json()) : null;
};

const publicFile = (id: string, variant: string) =>
  anonymous.get(`/catalog/media/${id}/${variant}`);

const adminVm = async (vmName: string) => {
  const response = await admin.get(`/admin/vms/qemu/${vmName}`);
  expect(response.statusCode, response.body).toBe(200);
  return adminVmDetailSchema.parse(response.json());
};

const setMedia = (vmName: string, id: string, visibility: string) =>
  admin.request({
    method: 'PUT',
    url: `/admin/vms/qemu/${vmName}/media/${id}/visibility`,
    payload: { visibility },
  });

beforeAll(async () => {
  context = await startBrowserApp();
  anonymous = new TestClient(context.app);
  admin = await signedInAdmin(context);
});

describe('the visibility matrix', () => {
  it.each([
    ['PrivPriv', 'private', 'private', true, null, false, 'vm_private'],
    ['PrivPub', 'private', 'published', true, null, false, 'vm_private'],
    ['PubPriv', 'public', 'private', true, null, true, 'main_private'],
    ['PubPub', 'public', 'published', true, 'cover', true, 'shown'],
  ] as const)(
    '%s: a %s VM with a %s main image',
    async (vmName, vmVisibility, mediaVisibility, isMain, cover, listed, status) => {
      await insertVm(context.pool, { vmName, visibility: vmVisibility });
      const item = await addMedia(vmName, { visibility: mediaVisibility, isMain });

      const card = await publicCard(vmName);
      expect(card !== undefined).toBe(listed);
      if (card) expect(card.mainImage?.id ?? null).toBe(cover ? item.id : null);

      const reachable = cover !== null;
      expect((await publicFile(item.id, 'thumbnail')).statusCode).toBe(reachable ? 200 : 404);
      expect((await publicFile(item.id, 'full')).statusCode).toBe(reachable ? 200 : 404);

      // The administration interface says why, whichever it is.
      expect((await adminVm(vmName)).publicCover).toBe(status);
    },
  );

  it('a public VM with no main image shows a placeholder, and its published images stay in the gallery', async () => {
    await insertVm(context.pool, { vmName: 'PubNoMain', visibility: 'public' });
    const item = await addMedia('PubNoMain', { visibility: 'published' });
    expect((await publicCard('PubNoMain'))?.mainImage).toBeNull();
    const detail = await publicDetail('PubNoMain');
    expect(detail?.mainImage).toBeNull();
    expect(detail?.gallery.map((image) => image.id)).toEqual([item.id]);
    expect((await adminVm('PubNoMain')).publicCover).toBe('no_main_image');
  });
});

describe('changing things', () => {
  it('follows the main image when it changes, with nothing promoted automatically', async () => {
    await insertVm(context.pool, { vmName: 'Changing', visibility: 'public' });
    const first = await addMedia('Changing', { visibility: 'published', isMain: true });
    const second = await addMedia('Changing', { visibility: 'published' });
    expect((await publicCard('Changing'))?.mainImage?.id).toBe(first.id);

    const selected = await admin.request({
      method: 'PUT',
      url: '/admin/vms/qemu/Changing/main-media',
      payload: { mediaId: second.id },
    });
    expect(selected.statusCode, selected.body).toBe(200);
    expect((await publicCard('Changing'))?.mainImage?.id).toBe(second.id);

    // Unpublishing the main image shows a placeholder, and never promotes the other published one.
    await setMedia('Changing', second.id, 'private');
    expect((await publicCard('Changing'))?.mainImage).toBeNull();
    expect((await publicFile(second.id, 'thumbnail')).statusCode).toBe(404);
    expect((await publicFile(first.id, 'thumbnail')).statusCode).toBe(200);
    expect((await adminVm('Changing')).publicCover).toBe('main_private');

    await setMedia('Changing', second.id, 'published');
    expect((await publicCard('Changing'))?.mainImage?.id).toBe(second.id);
    expect((await adminVm('Changing')).publicCover).toBe('shown');

    const cleared = await admin.request({
      method: 'DELETE',
      url: '/admin/vms/qemu/Changing/main-media',
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await publicCard('Changing'))?.mainImage).toBeNull();
    expect((await adminVm('Changing')).publicCover).toBe('no_main_image');
  });

  it('takes everything away at once when a VM is unpublished', async () => {
    await insertVm(context.pool, { vmName: 'Unpublished', visibility: 'public' });
    const item = await addMedia('Unpublished', { visibility: 'published', isMain: true });
    expect((await publicFile(item.id, 'thumbnail')).statusCode).toBe(200);
    const response = await admin.request({
      method: 'PUT',
      url: '/admin/vms/qemu/Unpublished/visibility',
      payload: { visibility: 'private' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await publicCard('Unpublished')).toBeUndefined();
    expect(await publicDetail('Unpublished')).toBeNull();
    expect((await publicFile(item.id, 'thumbnail')).statusCode).toBe(404);
    expect((await publicFile(item.id, 'full')).statusCode).toBe(404);
  });

  it('never publishes anything as a side effect of making a VM public', async () => {
    await insertVm(context.pool, { vmName: 'NoSideEffect', visibility: 'private' });
    const item = await addMedia('NoSideEffect', { visibility: 'private', isMain: true });
    const response = await admin.request({
      method: 'PUT',
      url: '/admin/vms/qemu/NoSideEffect/visibility',
      payload: { visibility: 'public' },
    });
    expect(adminVmDetailSchema.parse(response.json()).publicCover).toBe('main_private');
    expect((await publicFile(item.id, 'thumbnail')).statusCode).toBe(404);
  });

  it('says on the administrator’s card when there is no public cover', async () => {
    await insertVm(context.pool, { vmName: 'CardCover', visibility: 'public' });
    await addMedia('CardCover', { visibility: 'private', isMain: true });
    const response = await admin.get('/admin/vms?q=CardCover');
    const [card] = adminCatalogResponseSchema.parse(response.json()).items;
    expect(card?.publicCover).toBe('main_private');
  });
});

describe('retrieving images', () => {
  let item: Item;
  let hidden: Item;

  beforeAll(async () => {
    await insertVm(context.pool, { vmName: 'Files', visibility: 'public' });
    item = await addMedia('Files', { visibility: 'published', isMain: true });
    hidden = await addMedia('Files', { visibility: 'private' });
  });

  it('serves the thumbnail and the full derivative with no session at all', async () => {
    for (const variant of ['thumbnail', 'full'] as const) {
      const response = await publicFile(item.id, variant);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/jpeg');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.rawPayload.subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(response.body).toContain(`${variant}:${item.id}`);
    }
  });

  it('is not disturbed by an expired or invalid session cookie', async () => {
    for (const cookie of ['emucat_session=expired-or-invalid', 'emucat_session=']) {
      const response = await context.app.inject({
        method: 'GET',
        url: `/api/v1/catalog/media/${item.id}/thumbnail`,
        headers: { cookie },
      });
      expect(response.statusCode, cookie).toBe(200);
      const catalog = await context.app.inject({
        method: 'GET',
        url: '/api/v1/catalog/vms',
        headers: { cookie },
      });
      expect(catalog.statusCode, cookie).toBe(200);
      expect(JSON.stringify(catalog.json())).toContain(item.id);
    }
  });

  it('is not disturbed by a session that was really revoked', async () => {
    const client = new TestClient(context.app);
    const signedIn = await client.login('admin', ADMIN_PASSWORD);
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const stale = client.cookie;
    const logout = await client.request({ method: 'POST', url: '/auth/logout' });
    expect(logout.statusCode).toBeLessThan(300);
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/catalog/media/${item.id}/thumbnail`,
      headers: { cookie: `emucat_session=${stale}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('never serves an original to the public, under any name', async () => {
    for (const id of [item.id, hidden.id]) {
      for (const variant of ['original', 'originals', 'jpeg', '..%2Foriginal']) {
        const response = await publicFile(id, variant);
        expect(response.statusCode, `${id} ${variant}`).toBeGreaterThanOrEqual(400);
        expect(response.body).not.toContain('original:');
      }
    }
    // Not on the administrators' route either, without a session.
    const direct = await anonymous.get(`/admin/vms/qemu/Files/media/${item.id}/original`);
    expect(direct.statusCode).toBe(401);
    expect(direct.body).not.toContain('original:');
  });

  it('does not reveal that a private image exists', async () => {
    const privateAnswer = await publicFile(hidden.id, 'thumbnail');
    const noSuchAnswer = await publicFile(randomUUID(), 'thumbnail');
    expect(privateAnswer.statusCode).toBe(noSuchAnswer.statusCode);
    expect(privateAnswer.json<{ error: { code: string } }>().error.code).toBe(
      noSuchAnswer.json<{ error: { code: string } }>().error.code,
    );
  });

  it('keeps private media and its metadata out of every public response', async () => {
    const detail = await anonymous.get('/catalog/vms/qemu/Files');
    const list = await anonymous.get('/catalog/vms?q=Files');
    for (const body of [detail.body, list.body]) {
      expect(body).not.toContain(hidden.id);
      expect(body).not.toContain('SENTINEL');
      expect(body).not.toMatch(/filename|sha256|_key|media\/|archive|repository|agent|C:\\\\/i);
    }
    const parsed = publicVmDetailSchema.parse(detail.json());
    expect(parsed.gallery.map((image) => image.id)).toEqual([item.id]);
  });

  it('keeps the gallery in the same order on every request, with the main image first', async () => {
    await insertVm(context.pool, { vmName: 'Ordered', visibility: 'public' });
    const items: Item[] = [];
    for (let index = 0; index < 5; index += 1) {
      items.push(await addMedia('Ordered', { visibility: 'published', isMain: index === 3 }));
    }
    const first = (await publicDetail('Ordered'))?.gallery.map((image) => image.id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await publicDetail('Ordered'))?.gallery.map((image) => image.id)).toEqual(first);
    }
    expect(first?.[0]).toBe(items[3]?.id);
    expect(first).toHaveLength(5);
  });

  it('matches a VM’s identity without regard to capitalization', async () => {
    const lower = await anonymous.get('/catalog/vms/qemu/files');
    expect(lower.statusCode).toBe(200);
    expect(publicVmDetailSchema.parse(lower.json()).vmName).toBe('Files');
  });

  it('gives an administrator every screenshot, including private ones', async () => {
    const response = await admin.get('/admin/vms/qemu/Files/media');
    const ids = response.json<{ media: { id: string }[] }>().media.map((media) => media.id);
    expect(ids).toContain(hidden.id);
    expect(ids).toContain(item.id);
    const file = await admin.get(`/admin/vms/qemu/Files/media/${hidden.id}/thumbnail`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['cache-control']).toBe('private, no-store');
  });
});
