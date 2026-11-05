import {
  errorResponseSchema,
  publicCatalogResponseSchema,
  publicMediaPath,
  publicVmDetailSchema,
} from '@emucat/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insertMedia,
  insertVm,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
  type MediaFixture,
} from './browser-app.js';

/** Strict schemas already reject unknown fields. These catch a value leaking through a known one. */
const SECRET_FILENAME = 'SENTINEL-private-filename.png';
const SECRET_DESCRIPTION = 'SENTINEL-private-description';

let context: BrowserTestContext;
let client: TestClient;
const media: Record<string, MediaFixture> = {};

const list = async (query = '') => {
  const response = await client.get(`/catalog/vms${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return publicCatalogResponseSchema.parse(response.json());
};

const detail = async (path: string) => {
  const response = await client.get(`/catalog/vms/${path}`);
  expect(response.statusCode, response.body).toBe(200);
  return publicVmDetailSchema.parse(response.json());
};

beforeAll(async () => {
  context = await startBrowserApp();
  client = new TestClient(context.app);
  const { pool } = context;

  await insertVm(pool, {
    vmName: 'Win98',
    displayName: 'Windows 98 SE',
    description: 'A public machine',
    visibility: 'public',
  });
  await insertVm(pool, { emulatorType: '86box', vmName: 'Win98', visibility: 'public' });
  await insertVm(pool, {
    vmName: 'SecretVM',
    displayName: 'Secret machine',
    description: SECRET_DESCRIPTION,
    visibility: 'private',
  });

  // Every combination of VM visibility, media visibility and the main flag.
  await insertVm(pool, { vmName: 'PublicMainPublished', visibility: 'public' });
  await insertVm(pool, { vmName: 'PublicMainPrivate', visibility: 'public' });
  await insertVm(pool, { vmName: 'PublicNoMain', visibility: 'public' });
  await insertVm(pool, { vmName: 'PrivateMainPublished', visibility: 'private' });

  const secret = { filename: SECRET_FILENAME };
  media.shown = await insertMedia(
    context,
    { vmName: 'PublicMainPublished' },
    { visibility: 'published', isMain: true, ...secret },
  );
  media.galleryOnly = await insertMedia(
    context,
    { vmName: 'PublicMainPublished' },
    { visibility: 'published', ...secret },
  );
  media.unpublishedSibling = await insertMedia(
    context,
    { vmName: 'PublicMainPublished' },
    { visibility: 'private', ...secret },
  );
  media.privateMain = await insertMedia(
    context,
    { vmName: 'PublicMainPrivate' },
    { visibility: 'private', isMain: true, ...secret },
  );
  media.notPromoted = await insertMedia(
    context,
    { vmName: 'PublicMainPrivate' },
    { visibility: 'published', ...secret },
  );
  media.noMain = await insertMedia(
    context,
    { vmName: 'PublicNoMain' },
    { visibility: 'published', ...secret },
  );
  media.ofPrivateVm = await insertMedia(
    context,
    { vmName: 'PrivateMainPublished' },
    { visibility: 'published', isMain: true, ...secret },
  );
});

afterAll(async () => {
  await context.close();
});

describe('public listing', () => {
  it('needs no session', async () => {
    const body = await list();
    expect(body.items.length).toBeGreaterThan(0);
    expect(client.cookie).toBeUndefined();
  });

  it('shows only public VMs', async () => {
    const names = (await list()).items.map((item) => item.vmName);
    expect(names).not.toContain('SecretVM');
    expect(names).not.toContain('PrivateMainPublished');
    expect(names).toContain('PublicMainPublished');
  });

  it('keeps the same name under two emulators as two VMs', async () => {
    const win98 = (await list('?q=win98')).items.map((item) => item.emulatorType).sort();
    expect(win98).toEqual(['86box', 'qemu']);
  });

  it('leaks nothing about private data in any response', async () => {
    const responses = await Promise.all([
      client.get('/catalog/vms?pageSize=100'),
      client.get('/catalog/vms/qemu/PublicMainPublished'),
      client.get('/catalog/vms/qemu/PublicMainPrivate'),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('SENTINEL');
      expect(response.body).not.toMatch(
        /jpeg_key|jpegKey|thumbnail_key|thumbnailKey|sha256|filename|repository|agent|secret_ref|visibility|\bmedia\/[0-9a-f-]+\//i,
      );
      for (const fixture of [media.unpublishedSibling, media.privateMain, media.ofPrivateVm]) {
        expect(response.body).not.toContain(fixture?.id);
      }
    }
  });

  it('cannot be asked for private VMs', async () => {
    const response = await client.get('/catalog/vms?visibility=private');
    expect(response.statusCode).toBe(400);
  });

  it('does not reveal private VMs through search', async () => {
    expect((await list('?q=SecretVM')).items).toEqual([]);
    expect((await list('?q=Secret%20machine')).items).toEqual([]);
    expect((await list(`?q=${SECRET_DESCRIPTION}`)).items).toEqual([]);
    expect((await list('?q=SecretVM')).pagination.total).toBe(0);
  });

  it('counts only public VMs', async () => {
    const { pagination, items } = await list('?pageSize=100');
    expect(pagination.total).toBe(items.length);
    expect(items).toHaveLength(5);
  });

  it('truncates long descriptions in listings', async () => {
    await insertVm(context.pool, {
      vmName: 'LongDescription',
      visibility: 'public',
      description: 'x'.repeat(5000),
    });
    const [item] = (await list('?q=LongDescription')).items;
    expect(item?.summary).toHaveLength(240);
    expect((await detail('qemu/LongDescription')).description).toHaveLength(5000);
    await context.pool.query("DELETE FROM virtual_machines WHERE vm_name = 'LongDescription'");
  });
});

describe('filtering and pagination', () => {
  it('filters by emulator', async () => {
    const { items } = await list('?emulatorType=86box');
    expect(items.map((item) => item.vmName)).toEqual(['Win98']);
    expect(items[0]?.emulatorType).toBe('86box');
  });

  it('searches the display name, the VM name and the description', async () => {
    expect((await list('?q=Windows%2098')).items.map((item) => item.vmName)).toEqual(['Win98']);
    expect((await list('?q=PublicNoM')).items.map((item) => item.vmName)).toEqual(['PublicNoMain']);
    expect((await list('?q=a%20public%20machine')).items.map((item) => item.vmName)).toEqual([
      'Win98',
    ]);
  });

  it('treats LIKE wildcards in a search as plain text', async () => {
    expect((await list('?q=%25')).items).toEqual([]);
    expect((await list('?q=_')).items).toEqual([]);
    expect((await list('?q=%5C')).items).toEqual([]);
  });

  it.each(["' OR 1=1 --", "'; DROP TABLE virtual_machines; --", 'café', '日本語', '🐈', '"', '\\'])(
    'survives searching for %j',
    async (text) => {
      const { items } = await list(`?q=${encodeURIComponent(text)}`);
      expect(items).toEqual([]);
    },
  );

  it('finds non-ASCII display names', async () => {
    await insertVm(context.pool, {
      vmName: 'Unicode',
      displayName: 'Café 日本語',
      visibility: 'public',
    });
    expect((await list('?q=日本')).items.map((item) => item.vmName)).toEqual(['Unicode']);
    await context.pool.query("DELETE FROM virtual_machines WHERE vm_name = 'Unicode'");
  });

  it('pages through results in a stable order, by title', async () => {
    const first = await list('?pageSize=2&page=1');
    const second = await list('?pageSize=2&page=2');
    const third = await list('?pageSize=2&page=3');
    expect(first.pagination).toEqual({ page: 1, pageSize: 2, total: 5, totalPages: 3 });
    const all = [...first.items, ...second.items, ...third.items];
    expect(new Set(all.map((item) => `${item.emulatorType}/${item.vmName}`)).size).toBe(5);
    expect(all.map((item) => item.displayName ?? item.vmName)).toEqual(
      all
        .map((item) => item.displayName ?? item.vmName)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    );
  });

  it('returns an empty page past the end', async () => {
    const { items, pagination } = await list('?page=99');
    expect(items).toEqual([]);
    expect(pagination.total).toBe(5);
  });

  it.each([
    'page=0',
    'page=-1',
    'page=abc',
    'page=1e3&pageSize=abc',
    'pageSize=0',
    'pageSize=101',
    'pageSize=9999999',
    'emulatorType=dosbox',
    'emulatorType=86box&emulatorType=qemu',
    'unknown=1',
    `q=${'x'.repeat(101)}`,
  ])('rejects ?%s', async (query) => {
    const response = await client.get(`/catalog/vms?${query}`);
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_failed');
  });
});

describe('public detail', () => {
  it('returns a public VM', async () => {
    const vm = await detail('qemu/Win98');
    expect(vm).toMatchObject({
      emulatorType: 'qemu',
      vmName: 'Win98',
      displayName: 'Windows 98 SE',
      description: 'A public machine',
      mainImage: null,
      gallery: [],
    });
  });

  it('finds a VM whatever the case, and returns its real spelling', async () => {
    expect((await detail('qemu/WIN98')).vmName).toBe('Win98');
  });

  it('decodes spaces in names', async () => {
    await insertVm(context.pool, { vmName: 'Windows 98 SE', visibility: 'public' });
    expect((await detail('qemu/Windows%2098%20SE')).vmName).toBe('Windows 98 SE');
    await context.pool.query("DELETE FROM virtual_machines WHERE vm_name = 'Windows 98 SE'");
  });

  it('makes a private VM look exactly like one that does not exist', async () => {
    const hidden = await client.get('/catalog/vms/qemu/SecretVM');
    const missing = await client.get('/catalog/vms/qemu/NoSuchVM');
    expect(hidden.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    const strip = (body: string) => {
      const { error } = errorResponseSchema.parse(JSON.parse(body));
      return { code: error.code, message: error.message };
    };
    expect(strip(hidden.body)).toEqual(strip(missing.body));
    expect(hidden.body).not.toContain('Secret machine');
  });

  it.each(['qemu/..%2F..%2Fetc', 'qemu/a..b', 'qemu/CON', 'dosbox/Win98', 'qemu/a%00b'])(
    'rejects the path %s',
    async (path) => {
      expect((await client.get(`/catalog/vms/${path}`)).statusCode).toBe(400);
    },
  );
});

describe('card image rules', () => {
  const imageOf = async (vmName: string) =>
    (await list(`?q=${vmName}`)).items.find((item) => item.vmName === vmName)?.mainImage;

  it('shows a published main image of a public VM', async () => {
    expect(await imageOf('PublicMainPublished')).toEqual({
      id: media.shown?.id,
      widthPx: 640,
      heightPx: 480,
    });
    expect((await detail('qemu/PublicMainPublished')).mainImage?.id).toBe(media.shown?.id);
  });

  it('shows the placeholder when the main image is private, and promotes nothing', async () => {
    expect(await imageOf('PublicMainPrivate')).toBeNull();
    expect((await detail('qemu/PublicMainPrivate')).mainImage).toBeNull();
  });

  it('shows the placeholder when nothing is selected, even with published media', async () => {
    expect(await imageOf('PublicNoMain')).toBeNull();
    expect((await detail('qemu/PublicNoMain')).mainImage).toBeNull();
  });

  it('lists only published media in the gallery', async () => {
    const gallery = (await detail('qemu/PublicMainPublished')).gallery.map((item) => item.id);
    expect(gallery).toEqual([media.shown?.id, media.galleryOnly?.id]);
    expect(gallery).not.toContain(media.unpublishedSibling?.id);
  });
});

describe('public media files', () => {
  const fetchFile = (id: string | undefined, variant: 'thumbnail' | 'full' = 'thumbnail') =>
    context.app.inject({ url: publicMediaPath(id as string, variant) });

  it('serves a published image of a public VM', async () => {
    const thumbnail = await fetchFile(media.shown?.id);
    expect(thumbnail.statusCode).toBe(200);
    expect(thumbnail.headers['content-type']).toBe('image/jpeg');
    expect(thumbnail.headers['x-content-type-options']).toBe('nosniff');
    expect(thumbnail.headers['cache-control']).toBe('no-cache');
    expect(thumbnail.body).toBe(`thumb:${media.shown?.id}`);
    expect((await fetchFile(media.shown?.id, 'full')).body).toBe(`full:${media.shown?.id}`);
  });

  it('serves published non-main images too', async () => {
    expect((await fetchFile(media.galleryOnly?.id)).statusCode).toBe(200);
  });

  it('refuses unpublished media, media of private VMs, and unknown ids identically', async () => {
    const responses = await Promise.all([
      fetchFile(media.unpublishedSibling?.id),
      fetchFile(media.privateMain?.id),
      fetchFile(media.ofPrivateVm?.id),
      fetchFile('018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60'),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('media_not_found');
    }
  });

  it('stops serving as soon as the media or the VM is made private', async () => {
    await insertVm(context.pool, { vmName: 'Flip', visibility: 'public' });
    const item = await insertMedia(
      context,
      { vmName: 'Flip' },
      { visibility: 'published', isMain: true },
    );
    expect((await fetchFile(item.id)).statusCode).toBe(200);
    await context.pool.execute('UPDATE vm_media SET visibility = ? WHERE id = ?', [
      'private',
      item.id,
    ]);
    expect((await fetchFile(item.id)).statusCode).toBe(404);
    await context.pool.execute('UPDATE vm_media SET visibility = ? WHERE id = ?', [
      'published',
      item.id,
    ]);
    await context.pool.execute(
      "UPDATE virtual_machines SET visibility = 'private' WHERE vm_name = 'Flip'",
    );
    expect((await fetchFile(item.id)).statusCode).toBe(404);
    expect((await list('?q=Flip')).items).toEqual([]);
  });

  it('answers 404 when the file is missing from storage', async () => {
    await insertVm(context.pool, { vmName: 'NoFile', visibility: 'public' });
    const item = await insertMedia(
      context,
      { vmName: 'NoFile' },
      { visibility: 'published', writeFiles: false },
    );
    expect((await fetchFile(item.id)).statusCode).toBe(404);
  });

  it.each([
    '../../../../secrets.txt',
    '..\\..\\secrets.txt',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'a/../../secrets.txt',
    '',
  ])('refuses to read the unsafe stored key %j', async (key) => {
    const vmName = `Unsafe${Math.random().toString(36).slice(2, 8)}`;
    await insertVm(context.pool, { vmName, visibility: 'public' });
    const item = await insertMedia(
      context,
      { vmName },
      { visibility: 'published', writeFiles: false, thumbnailKey: key, jpegKey: 'never.jpg' },
    );
    const response = await fetchFile(item.id);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('root:');
  });

  it.each(['not-a-uuid', '..%2F..%2Fetc'])('rejects the media id %s', async (id) => {
    const response = await context.app.inject({ url: `/api/v1/catalog/media/${id}/thumbnail` });
    expect(response.statusCode).toBe(400);
  });

  it('rejects unknown variants', async () => {
    const response = await context.app.inject({
      url: `/api/v1/catalog/media/${media.shown?.id}/original`,
    });
    expect(response.statusCode).toBe(400);
  });
});
