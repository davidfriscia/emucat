/**
 * The public catalog's cover, across every combination that can decide it, with real rows and real files.
 * What this file exists to protect: publication is decided by the VM alone (decision 0036). A public
 * VM's screenshots are reachable with no session at all, a private VM's never are, and whatever a legacy
 * per-media visibility value says changes neither.
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
import type { RowDataPacket } from 'mysql2/promise';
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

beforeAll(async () => {
  context = await startBrowserApp();
  anonymous = new TestClient(context.app);
  admin = await signedInAdmin(context);
});

describe('the visibility matrix', () => {
  // The legacy per-media value is set to both of its old values, to prove that it decides nothing.
  it.each([
    ['PrivPriv', 'private', 'private', null, 'vm_private'],
    ['PrivPub', 'private', 'published', null, 'vm_private'],
    ['PubPriv', 'public', 'private', 'cover', 'shown'],
    ['PubPub', 'public', 'published', 'cover', 'shown'],
  ] as const)(
    '%s: a %s VM with a main image whose legacy value is %s',
    async (vmName, vmVisibility, legacy, cover, status) => {
      await insertVm(context.pool, { vmName, visibility: vmVisibility });
      const item = await addMedia(vmName, { visibility: legacy, isMain: true });

      const card = await publicCard(vmName);
      expect(card !== undefined).toBe(vmVisibility === 'public');
      if (card) expect(card.mainImage?.id ?? null).toBe(cover ? item.id : null);

      const reachable = cover !== null;
      expect((await publicFile(item.id, 'thumbnail')).statusCode).toBe(reachable ? 200 : 404);
      expect((await publicFile(item.id, 'full')).statusCode).toBe(reachable ? 200 : 404);
      expect((await publicFile(item.id, 'original')).statusCode).toBeGreaterThanOrEqual(400);

      // The administration interface says why, whichever it is.
      expect((await adminVm(vmName)).publicCover).toBe(status);
    },
  );

  it('a public VM with no main image shows a placeholder, and its screenshots stay in the gallery', async () => {
    await insertVm(context.pool, { vmName: 'PubNoMain', visibility: 'public' });
    const item = await addMedia('PubNoMain', { visibility: 'private' });
    expect((await publicCard('PubNoMain'))?.mainImage).toBeNull();
    const detail = await publicDetail('PubNoMain');
    expect(detail?.mainImage).toBeNull();
    expect(detail?.gallery.map((image) => image.id)).toEqual([item.id]);
    expect((await adminVm('PubNoMain')).publicCover).toBe('no_main_image');
  });
});

describe('a VM with several screenshots', () => {
  it('shows every screenshot of a public VM, whatever its legacy value, to anyone', async () => {
    await insertVm(context.pool, { vmName: 'ManyPublic', visibility: 'public' });
    const items = [
      await addMedia('ManyPublic', { visibility: 'private', isMain: true }),
      await addMedia('ManyPublic', { visibility: 'published' }),
      await addMedia('ManyPublic', { visibility: 'private' }),
    ];
    const detail = await publicDetail('ManyPublic');
    expect(detail?.mainImage?.id).toBe(items[0]?.id);
    expect(detail?.gallery.map((image) => image.id).sort()).toEqual(
      items.map((item) => item.id).sort(),
    );
    for (const item of items) {
      for (const variant of ['thumbnail', 'full']) {
        const response = await publicFile(item.id, variant);
        expect(response.statusCode, `${item.id} ${variant}`).toBe(200);
        expect(response.body).toContain(`${variant}:${item.id}`);
      }
    }
  });

  it('shows nothing of a private VM to anyone without a session', async () => {
    await insertVm(context.pool, { vmName: 'ManyPrivate', visibility: 'private' });
    const items = [
      await addMedia('ManyPrivate', { visibility: 'published', isMain: true }),
      await addMedia('ManyPrivate', { visibility: 'published' }),
      await addMedia('ManyPrivate', { visibility: 'private' }),
    ];
    expect(await publicCard('ManyPrivate')).toBeUndefined();
    expect(await publicDetail('ManyPrivate')).toBeNull();
    const catalog = await anonymous.get('/catalog/vms?pageSize=100');
    for (const item of items) {
      expect(catalog.body).not.toContain(item.id);
      for (const variant of ['thumbnail', 'full', 'original']) {
        const response = await publicFile(item.id, variant);
        expect(response.statusCode, `${item.id} ${variant}`).toBeGreaterThanOrEqual(400);
        expect(response.body).not.toContain(`:${item.id}`);
      }
      // The administrators' file route needs a session, too.
      const direct = await anonymous.get(`/admin/vms/qemu/ManyPrivate/media/${item.id}/thumbnail`);
      expect(direct.statusCode).toBe(401);
    }
    // An administrator still sees and can fetch all of them.
    const listed = await admin.get('/admin/vms/qemu/ManyPrivate/media');
    expect(listed.json<{ media: { id: string }[] }>().media).toHaveLength(3);
    const file = await admin.get(`/admin/vms/qemu/ManyPrivate/media/${items[2]?.id}/full`);
    expect(file.statusCode).toBe(200);
  });
});

describe('changing things', () => {
  it('follows the main image when it changes, with nothing promoted automatically', async () => {
    await insertVm(context.pool, { vmName: 'Changing', visibility: 'public' });
    const first = await addMedia('Changing', { isMain: true });
    const second = await addMedia('Changing');
    expect((await publicCard('Changing'))?.mainImage?.id).toBe(first.id);

    const selected = await admin.request({
      method: 'PUT',
      url: '/admin/vms/qemu/Changing/main-media',
      payload: { mediaId: second.id },
    });
    expect(selected.statusCode, selected.body).toBe(200);
    expect((await publicCard('Changing'))?.mainImage?.id).toBe(second.id);
    expect((await adminVm('Changing')).publicCover).toBe('shown');

    // Selecting a cover never changes who may see an image: both stay public.
    for (const item of [first, second]) {
      expect((await publicFile(item.id, 'thumbnail')).statusCode).toBe(200);
    }

    const cleared = await admin.request({
      method: 'DELETE',
      url: '/admin/vms/qemu/Changing/main-media',
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await publicCard('Changing'))?.mainImage).toBeNull();
    expect((await adminVm('Changing')).publicCover).toBe('no_main_image');
    // Clearing the cover hides nothing either.
    expect((await publicDetail('Changing'))?.gallery).toHaveLength(2);
  });

  it('offers no per-media visibility route any more', async () => {
    await insertVm(context.pool, { vmName: 'NoMediaRoute', visibility: 'private' });
    const item = await addMedia('NoMediaRoute', { isMain: true });
    const response = await admin.request({
      method: 'PUT',
      url: `/admin/vms/qemu/NoMediaRoute/media/${item.id}/visibility`,
      payload: { visibility: 'published' },
    });
    expect(response.statusCode).toBe(404);
    expect((await publicFile(item.id, 'thumbnail')).statusCode).toBe(404);
  });

  it('takes everything away at once when a VM is made private', async () => {
    await insertVm(context.pool, { vmName: 'Unpublished', visibility: 'public' });
    const item = await addMedia('Unpublished', { visibility: 'published', isMain: true });
    const other = await addMedia('Unpublished');
    expect((await publicFile(item.id, 'thumbnail')).statusCode).toBe(200);
    expect((await publicFile(other.id, 'thumbnail')).statusCode).toBe(200);
    const response = await admin.request({
      method: 'PUT',
      url: '/admin/vms/qemu/Unpublished/visibility',
      payload: { visibility: 'private' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await publicCard('Unpublished')).toBeUndefined();
    expect(await publicDetail('Unpublished')).toBeNull();
    for (const id of [item.id, other.id]) {
      expect((await publicFile(id, 'thumbnail')).statusCode).toBe(404);
      expect((await publicFile(id, 'full')).statusCode).toBe(404);
    }
  });

  it('publishes every screenshot, cover included, when a VM is made public', async () => {
    await insertVm(context.pool, { vmName: 'MadePublic', visibility: 'private' });
    const item = await addMedia('MadePublic', { visibility: 'private', isMain: true });
    const other = await addMedia('MadePublic', { visibility: 'private' });
    expect((await publicFile(item.id, 'thumbnail')).statusCode).toBe(404);
    const response = await admin.request({
      method: 'PUT',
      url: '/admin/vms/qemu/MadePublic/visibility',
      payload: { visibility: 'public' },
    });
    expect(adminVmDetailSchema.parse(response.json()).publicCover).toBe('shown');
    expect((await publicCard('MadePublic'))?.mainImage?.id).toBe(item.id);
    expect((await publicFile(item.id, 'thumbnail')).statusCode).toBe(200);
    expect((await publicFile(other.id, 'full')).statusCode).toBe(200);
    // The legacy column is left exactly as it was.
    const [rows] = await context.pool.query<RowDataPacket[]>(
      'SELECT visibility FROM vm_media WHERE id IN (?, ?)',
      [item.id, other.id],
    );
    expect(rows.map((row) => row.visibility as string)).toEqual(['private', 'private']);
  });

  it('says on the administrator’s card when there is no public cover', async () => {
    await insertVm(context.pool, { vmName: 'CardCover', visibility: 'public' });
    await addMedia('CardCover');
    const response = await admin.get('/admin/vms?q=CardCover');
    const [card] = adminCatalogResponseSchema.parse(response.json()).items;
    expect(card?.publicCover).toBe('no_main_image');
  });
});

describe('retrieving images', () => {
  let item: Item;
  let hidden: Item;

  beforeAll(async () => {
    await insertVm(context.pool, { vmName: 'Files', visibility: 'public' });
    // `hidden` belongs to a private VM, whose legacy value says "published": it is still hidden.
    await insertVm(context.pool, { vmName: 'FilesHidden', visibility: 'private' });
    item = await addMedia('Files', { visibility: 'private', isMain: true });
    hidden = await addMedia('FilesHidden', { visibility: 'published', isMain: true });
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
    const list = await anonymous.get('/catalog/vms?pageSize=100');
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
      items.push(await addMedia('Ordered', { isMain: index === 3 }));
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

  it('gives an administrator every screenshot, including those of a private VM', async () => {
    const response = await admin.get('/admin/vms/qemu/FilesHidden/media');
    const ids = response.json<{ media: { id: string }[] }>().media.map((media) => media.id);
    expect(ids).toEqual([hidden.id]);
    const file = await admin.get(`/admin/vms/qemu/FilesHidden/media/${hidden.id}/thumbnail`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['cache-control']).toBe('private, no-store');
  });
});
