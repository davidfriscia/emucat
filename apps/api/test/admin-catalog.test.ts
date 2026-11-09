import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  adminCatalogResponseSchema,
  adminMediaListResponseSchema,
  adminSummaryResponseSchema,
  adminVmDetailSchema,
  errorResponseSchema,
  publicCatalogResponseSchema,
} from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_PASSWORD,
  insertMedia,
  insertVm,
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from './browser-app.js';

const UNKNOWN_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60';

let context: BrowserTestContext;
let admin: TestClient;
let vmCounter = 0;

/** A new private VM for one test, so that tests cannot affect each other. */
async function newVm(fields: Parameters<typeof insertVm>[1] | object = {}) {
  vmCounter += 1;
  const vmName = `Vm${vmCounter}`;
  await insertVm(context.pool, { vmName, ...fields });
  return { vmName, path: `/admin/vms/qemu/${vmName}` };
}

const mediaState = async (path: string) => {
  const response = await admin.get(`${path}/media`);
  expect(response.statusCode, response.body).toBe(200);
  return adminMediaListResponseSchema.parse(response.json()).media;
};

const put = (url: string, payload: object) => admin.request({ method: 'PUT', url, payload });

const publicCard = async (vmName: string) => {
  const response = await new TestClient(context.app).get(`/catalog/vms?q=${vmName}`);
  return publicCatalogResponseSchema
    .parse(response.json())
    .items.find((item) => item.vmName === vmName);
};

beforeAll(async () => {
  context = await startBrowserApp();
  admin = await signedInAdmin(context);
});

afterAll(async () => {
  await context.close();
});

const ROUTES: [method: 'GET' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object][] = [
  ['GET', '/admin/summary'],
  ['GET', '/admin/vms'],
  ['GET', '/admin/vms/qemu/Target'],
  ['PATCH', '/admin/vms/qemu/Target', { displayName: 'Hacked' }],
  ['PUT', '/admin/vms/qemu/Target/visibility', { visibility: 'public' }],
  ['GET', '/admin/vms/qemu/Target/media'],
  ['PUT', '/admin/vms/qemu/Target/main-media', { mediaId: UNKNOWN_ID }],
  ['DELETE', '/admin/vms/qemu/Target/main-media'],
  ['DELETE', `/admin/vms/qemu/Target/media/${UNKNOWN_ID}`],
  ['GET', `/admin/vms/qemu/Target/media/${UNKNOWN_ID}/full`],
];

describe('authorization', () => {
  let regularUser: TestClient;

  beforeAll(async () => {
    await insertVm(context.pool, { vmName: 'Target', displayName: 'Untouched' });
    await context.pool.execute(
      `INSERT INTO users (id, username, display_name, password_hash, role)
       VALUES (UUID(), 'regular', 'Regular', ?, 'user')`,
      [await context.dependencies.passwords.hash(ADMIN_PASSWORD)],
    );
    regularUser = new TestClient(context.app);
    expect((await regularUser.login('regular', ADMIN_PASSWORD)).statusCode).toBe(200);
  });

  it.each(ROUTES)('%s %s requires a session', async (method, url, payload) => {
    const response = await new TestClient(context.app).request({
      method,
      url,
      ...(payload ? { payload } : {}),
    });
    expect(response.statusCode).toBe(401);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('unauthenticated');
  });

  it.each(ROUTES)('%s %s requires the administrator role', async (method, url, payload) => {
    const response = await regularUser.request({ method, url, ...(payload ? { payload } : {}) });
    expect(response.statusCode).toBe(403);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('forbidden');
  });

  it.each(ROUTES.filter(([method]) => method !== 'GET'))(
    '%s %s requires the CSRF token',
    async (method, url, payload) => {
      const response = await admin.request({
        method,
        url,
        csrf: false,
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode).toBe(403);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('csrf_rejected');
    },
  );

  it('left the target unchanged through all of that', async () => {
    const vm = adminVmDetailSchema.parse((await admin.get('/admin/vms/qemu/Target')).json());
    expect(vm.displayName).toBe('Untouched');
    expect(vm.visibility).toBe('private');
  });

  it('marks administrative responses as uncacheable', async () => {
    expect((await admin.get('/admin/vms')).headers['cache-control']).toBe('no-store');
  });
});

describe('no direct creation path', () => {
  it.each([
    ['POST', '/admin/vms'],
    ['PUT', '/admin/vms'],
    ['POST', '/catalog/vms'],
    ['PUT', '/catalog/vms/qemu/NewVm'],
    ['POST', '/vms'],
  ] as const)('%s %s does not exist', async (method, url) => {
    const before = await context.pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM virtual_machines',
    );
    const response = await admin.request({
      method,
      url,
      payload: { emulatorType: 'qemu', vmName: 'NewVm', displayName: 'New' },
    });
    expect(response.statusCode).toBe(404);
    const after = await context.pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM virtual_machines',
    );
    expect(after[0][0]?.n).toBe(before[0][0]?.n);
  });

  it('does not create a VM by updating one that does not exist', async () => {
    const response = await admin.request({
      method: 'PATCH',
      url: '/admin/vms/qemu/DoesNotExist',
      payload: { displayName: 'New' },
    });
    expect(response.statusCode).toBe(404);
    const [rows] = await context.pool.query<RowDataPacket[]>(
      "SELECT 1 FROM virtual_machines WHERE vm_name = 'DoesNotExist'",
    );
    expect(rows).toEqual([]);
  });
});

describe('administrative listing', () => {
  it('includes private VMs and their visibility', async () => {
    const hidden = await newVm({ displayName: 'Hidden one' });
    const response = await admin.get(`/admin/vms?q=${hidden.vmName}`);
    const { items } = adminCatalogResponseSchema.parse(response.json());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ visibility: 'private', mainMediaId: null, mediaCount: 0 });
  });

  it('filters by visibility and emulator', async () => {
    await newVm({ visibility: 'public', description: 'filter-probe' });
    await newVm({ visibility: 'private', description: 'filter-probe' });
    const query = async (extra: string) =>
      adminCatalogResponseSchema.parse(
        (await admin.get(`/admin/vms?q=filter-probe${extra}`)).json(),
      ).items;
    expect(await query('')).toHaveLength(2);
    expect((await query('&visibility=public')).map((item) => item.visibility)).toEqual(['public']);
    expect((await query('&visibility=private')).map((item) => item.visibility)).toEqual([
      'private',
    ]);
    expect(await query('&emulatorType=86box')).toEqual([]);
  });

  it('rejects invalid filters', async () => {
    expect((await admin.get('/admin/vms?visibility=secret')).statusCode).toBe(400);
    expect((await admin.get('/admin/vms?pageSize=1000')).statusCode).toBe(400);
  });

  it('counts media and marks the main selection', async () => {
    const vm = await newVm();
    const item = await insertMedia(context, vm, { isMain: true });
    await insertMedia(context, vm);
    const { items } = adminCatalogResponseSchema.parse(
      (await admin.get(`/admin/vms?q=${vm.vmName}`)).json(),
    );
    expect(items[0]).toMatchObject({ mainMediaId: item.id, mediaCount: 2 });
  });

  it('summarizes the catalog', async () => {
    const summary = adminSummaryResponseSchema.parse((await admin.get('/admin/summary')).json());
    expect(summary.vms.total).toBe(summary.vms.public + summary.vms.private);
    expect(summary.media.total).toBe(summary.media.public + summary.media.private);
  });

  it('counts media as public or private by their VM, not by a legacy per-media value', async () => {
    const before = adminSummaryResponseSchema.parse((await admin.get('/admin/summary')).json());
    const publicVm = await newVm({ visibility: 'public' });
    const privateVm = await newVm({ visibility: 'private' });
    await insertMedia(context, publicVm, { legacyVisibility: 'private' });
    await insertMedia(context, publicVm, { legacyVisibility: 'published' });
    await insertMedia(context, privateVm, { legacyVisibility: 'published' });
    const after = adminSummaryResponseSchema.parse((await admin.get('/admin/summary')).json());
    expect(after.media.total - before.media.total).toBe(3);
    expect(after.media.public - before.media.public).toBe(2);
    expect(after.media.private - before.media.private).toBe(1);
  });
});

describe('metadata', () => {
  const patch = (path: string, payload: object) =>
    admin.request({ method: 'PATCH', url: path, payload });

  it('updates the display name and the description', async () => {
    const vm = await newVm();
    const response = await patch(vm.path, {
      displayName: '  Windows 98 SE  ',
      description: 'Line one\nLine two',
    });
    expect(response.statusCode).toBe(200);
    expect(adminVmDetailSchema.parse(response.json())).toMatchObject({
      vmName: vm.vmName,
      displayName: 'Windows 98 SE',
      description: 'Line one\nLine two',
    });
  });

  it('changes only the fields it is given', async () => {
    const vm = await newVm({ displayName: 'Keep', description: 'Keep too' });
    await patch(vm.path, { description: 'Changed' });
    const after = adminVmDetailSchema.parse((await admin.get(vm.path)).json());
    expect(after).toMatchObject({ displayName: 'Keep', description: 'Changed' });
  });

  it('clears fields with null, and an empty description with an empty string', async () => {
    const vm = await newVm({ displayName: 'Name', description: 'Text' });
    const cleared = await patch(vm.path, { displayName: null, description: '' });
    expect(cleared.json()).toMatchObject({ displayName: null, description: null });
  });

  it('keeps Unicode and markup as plain data', async () => {
    const vm = await newVm();
    const description = "<script>alert(1)</script> 日本語 🐈 '; DROP TABLE users; --";
    const response = await patch(vm.path, { displayName: 'Café 🐈', description });
    expect(response.json()).toMatchObject({ displayName: 'Café 🐈', description });
  });

  it('succeeds when nothing actually changes', async () => {
    const vm = await newVm({ displayName: 'Same' });
    expect((await patch(vm.path, { displayName: 'Same' })).statusCode).toBe(200);
  });

  it.each([
    ['an empty body', {}],
    ['a blank name', { displayName: '   ' }],
    ['a long name', { displayName: 'x'.repeat(256) }],
    ['a control character in the name', { displayName: 'a\u0007b' }],
    ['a line break in the name', { displayName: 'a\nb' }],
    ['a NUL in the description', { description: 'a\u0000b' }],
    ['a long description', { description: 'x'.repeat(10_001) }],
    ['a wrong type', { displayName: 42 }],
    ['an identity change', { vmName: 'Other' }],
    ['an emulator change', { emulatorType: '86box' }],
    ['a change alongside an identity change', { displayName: 'ok', vmName: 'Other' }],
    ['visibility on this route', { visibility: 'public' }],
    ['an attribution change', { registered_by_user_id: UNKNOWN_ID }],
    ['an array', []],
  ])('rejects %s', async (_name, payload) => {
    const vm = await newVm({ displayName: 'Original' });
    const response = await patch(vm.path, payload);
    expect(response.statusCode).toBe(400);
    const after = adminVmDetailSchema.parse((await admin.get(vm.path)).json());
    expect(after.displayName).toBe('Original');
    expect(after.vmName).toBe(vm.vmName);
  });

  it('accepts a description at the limit, even in four-byte characters', async () => {
    const vm = await newVm();
    const response = await patch(vm.path, { description: '🐈'.repeat(5000) });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ description: string }>().description).toHaveLength(10_000);
  });

  it('finds a VM whatever the case, but never changes its spelling', async () => {
    const vm = await newVm();
    const response = await patch(`/admin/vms/qemu/${vm.vmName.toUpperCase()}`, {
      displayName: 'Found',
    });
    expect(response.json()).toMatchObject({ vmName: vm.vmName, displayName: 'Found' });
  });

  it('does not touch the same name under another emulator', async () => {
    const vm = await newVm({ displayName: 'qemu one' });
    await insertVm(context.pool, {
      emulatorType: '86box',
      vmName: vm.vmName,
      displayName: '86box one',
    });
    await patch(vm.path, { displayName: 'changed' });
    const other = await admin.get(`/admin/vms/86box/${vm.vmName}`);
    expect(other.json()).toMatchObject({ displayName: '86box one' });
  });

  it('returns version counts without exposing archive details', async () => {
    const vm = await newVm();
    const response = await admin.get(vm.path);
    expect(adminVmDetailSchema.parse(response.json()).versionCount).toBe(0);
    expect(response.body).not.toMatch(/archive|secret|credential/i);
  });

  it.each(['/admin/vms/qemu/..%2F..%2Fetc', '/admin/vms/dosbox/Name', '/admin/vms/qemu/NUL'])(
    'rejects the path %s',
    async (path) => {
      expect((await admin.get(path)).statusCode).toBe(400);
    },
  );
});

describe('VM visibility', () => {
  it('publishes and withdraws a VM from the public catalog', async () => {
    const vm = await newVm();
    expect(await publicCard(vm.vmName)).toBeUndefined();
    const published = await put(`${vm.path}/visibility`, { visibility: 'public' });
    expect(published.json()).toMatchObject({ visibility: 'public' });
    expect(await publicCard(vm.vmName)).toBeDefined();
    await put(`${vm.path}/visibility`, { visibility: 'private' });
    expect(await publicCard(vm.vmName)).toBeUndefined();
  });

  it('rejects unknown values', async () => {
    const vm = await newVm();
    expect((await put(`${vm.path}/visibility`, { visibility: 'unlisted' })).statusCode).toBe(400);
    expect((await put(`${vm.path}/visibility`, { visibility: 'public', x: 1 })).statusCode).toBe(
      400,
    );
  });

  it('answers 404 for an unknown VM', async () => {
    const response = await put('/admin/vms/qemu/Nope/visibility', { visibility: 'public' });
    expect(response.statusCode).toBe(404);
  });
});

describe('main media', () => {
  let vm: { vmName: string; path: string };
  let first: { id: string };
  let second: { id: string };

  beforeEach(async () => {
    vm = await newVm({ visibility: 'public' });
    first = await insertMedia(context, vm);
    second = await insertMedia(context, vm);
  });

  const mainIds = async () =>
    (await mediaState(vm.path)).filter((item) => item.isMain).map((item) => item.id);

  it('selects a main image', async () => {
    const response = await put(`${vm.path}/main-media`, { mediaId: first.id });
    expect(response.statusCode).toBe(200);
    expect(await mainIds()).toEqual([first.id]);
    expect((await publicCard(vm.vmName))?.mainImage?.id).toBe(first.id);
  });

  it('moves the selection, leaving exactly one', async () => {
    await put(`${vm.path}/main-media`, { mediaId: first.id });
    await put(`${vm.path}/main-media`, { mediaId: second.id });
    expect(await mainIds()).toEqual([second.id]);
    expect((await publicCard(vm.vmName))?.mainImage?.id).toBe(second.id);
  });

  it('can select the same image twice', async () => {
    await put(`${vm.path}/main-media`, { mediaId: first.id });
    const response = await put(`${vm.path}/main-media`, { mediaId: first.id });
    expect(response.statusCode).toBe(200);
    expect(await mainIds()).toEqual([first.id]);
  });

  it('clears the selection without promoting anything', async () => {
    await put(`${vm.path}/main-media`, { mediaId: first.id });
    const response = await admin.request({ method: 'DELETE', url: `${vm.path}/main-media` });
    expect(response.statusCode).toBe(200);
    expect(await mainIds()).toEqual([]);
    expect((await publicCard(vm.vmName))?.mainImage).toBeNull();
  });

  it('clearing with nothing selected is fine', async () => {
    const response = await admin.request({ method: 'DELETE', url: `${vm.path}/main-media` });
    expect(response.statusCode).toBe(200);
  });

  it('refuses another VM’s media, and changes nothing', async () => {
    await put(`${vm.path}/main-media`, { mediaId: first.id });
    const other = await newVm();
    const foreign = await insertMedia(context, other);
    const response = await put(`${vm.path}/main-media`, { mediaId: foreign.id });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('media_not_found');
    expect(await mainIds()).toEqual([first.id]);
    expect((await mediaState(other.path)).filter((item) => item.isMain)).toEqual([]);
  });

  it('refuses media of the same VM name under another emulator', async () => {
    await insertVm(context.pool, { emulatorType: '86box', vmName: vm.vmName });
    const twin = await insertMedia(context, { emulatorType: '86box', vmName: vm.vmName });
    expect((await put(`${vm.path}/main-media`, { mediaId: twin.id })).statusCode).toBe(404);
  });

  it('refuses an unknown VM or media', async () => {
    expect((await put('/admin/vms/qemu/Nope/main-media', { mediaId: first.id })).statusCode).toBe(
      404,
    );
    expect((await put(`${vm.path}/main-media`, { mediaId: UNKNOWN_ID })).statusCode).toBe(404);
    expect((await put(`${vm.path}/main-media`, { mediaId: 'nope' })).statusCode).toBe(400);
  });

  it('keeps one main image under concurrent selections', async () => {
    const candidates = await Promise.all(Array.from({ length: 6 }, () => insertMedia(context, vm)));
    const responses = await Promise.all(
      candidates.flatMap((candidate) => [
        put(`${vm.path}/main-media`, { mediaId: candidate.id }),
        put(`${vm.path}/main-media`, { mediaId: first.id }),
      ]),
    );
    expect(responses.map((response) => response.statusCode)).toEqual(responses.map(() => 200));
    expect(await mainIds()).toHaveLength(1);
    const [rows] = await context.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM vm_media WHERE vm_name = ? AND is_main',
      [vm.vmName],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('rolls back the cleared flag if setting the new selection fails', async () => {
    await put(`${vm.path}/main-media`, { mediaId: first.id });
    // Fails the second of the two updates, after the old flag has already been cleared.
    await context.pool.query(
      `CREATE TRIGGER trg_test_fail_select BEFORE UPDATE ON vm_media FOR EACH ROW
       IF NEW.is_main AND NEW.id = '${second.id}' THEN
         SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected failure';
       END IF`,
    );
    try {
      const response = await put(`${vm.path}/main-media`, { mediaId: second.id });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('injected failure');
    } finally {
      await context.pool.query('DROP TRIGGER trg_test_fail_select');
    }
    expect(await mainIds()).toEqual([first.id]);
    expect((await publicCard(vm.vmName))?.mainImage?.id).toBe(first.id);
  });

  it('the database itself refuses a second main image', async () => {
    await put(`${vm.path}/main-media`, { mediaId: first.id });
    await expect(
      context.pool.execute('UPDATE vm_media SET is_main = TRUE WHERE id = ?', [second.id]),
    ).rejects.toThrow(/Duplicate/);
  });
});

describe('public image visibility rules', () => {
  // [VM visibility, legacy media value, main selected, shown publicly?]. The legacy value never matters.
  const MATRIX = [
    ['public', 'published', true, true],
    ['public', 'published', false, false],
    ['public', 'private', true, true],
    ['public', 'private', false, false],
    ['private', 'published', true, false],
    ['private', 'published', false, false],
    ['private', 'private', true, false],
    ['private', 'private', false, false],
  ] as const;

  it.each(MATRIX)(
    'VM %s, legacy %s, main %s: shown = %s',
    async (vmVisibility, legacyVisibility, isMain, shown) => {
      const vm = await newVm({ visibility: vmVisibility });
      const item = await insertMedia(context, vm, { legacyVisibility, isMain });

      const card = await publicCard(vm.vmName);
      expect(card?.mainImage?.id ?? null).toBe(shown ? item.id : null);

      const [listed] = await mediaState(vm.path);
      expect(listed?.shownAsPublicMain).toBe(shown);
    },
  );

  it('follows the VM: making it private hides the cover, making it public shows it again', async () => {
    const vm = await newVm({ visibility: 'public' });
    const main = await insertMedia(context, vm, { isMain: true });
    const other = await insertMedia(context, vm);

    await put(`${vm.path}/visibility`, { visibility: 'private' });
    expect(await publicCard(vm.vmName)).toBeUndefined();
    const state = await mediaState(vm.path);
    // The cover selection survives, untouched, while the VM is private.
    expect(state.find((item) => item.id === main.id)?.isMain).toBe(true);
    expect(state.find((item) => item.id === other.id)?.isMain).toBe(false);
    expect(state.every((item) => !item.shownAsPublicMain)).toBe(true);

    await put(`${vm.path}/visibility`, { visibility: 'public' });
    expect((await publicCard(vm.vmName))?.mainImage?.id).toBe(main.id);
  });

  it('selects a cover of a private VM without publishing anything', async () => {
    const vm = await newVm({ visibility: 'private' });
    const item = await insertMedia(context, vm);
    expect((await put(`${vm.path}/main-media`, { mediaId: item.id })).statusCode).toBe(200);
    expect(await publicCard(vm.vmName)).toBeUndefined();
    expect(adminVmDetailSchema.parse((await admin.get(vm.path)).json()).publicCover).toBe(
      'vm_private',
    );
  });
});

describe('media administration', () => {
  it('has no per-media visibility route, for any value', async () => {
    const vm = await newVm({ visibility: 'private' });
    const item = await insertMedia(context, vm);
    for (const visibility of ['published', 'private', 'public']) {
      const response = await put(`${vm.path}/media/${item.id}/visibility`, { visibility });
      expect(response.statusCode, visibility).toBe(404);
    }
    expect(await publicCard(vm.vmName)).toBeUndefined();
  });

  it('reports no per-media visibility', async () => {
    const vm = await newVm();
    await insertMedia(context, vm, { legacyVisibility: 'published' });
    const response = await admin.get(`${vm.path}/media`);
    expect(response.body).not.toMatch(/visibility|published/);
  });

  it('lists every field an administrator needs, but no storage keys or hashes', async () => {
    const vm = await newVm();
    const item = await insertMedia(context, vm, { filename: 'shot.ppm' });
    const response = await admin.get(`${vm.path}/media`);
    const [listed] = adminMediaListResponseSchema.parse(response.json()).media;
    expect(listed).toMatchObject({ id: item.id, originalFilename: 'shot.ppm', widthPx: 640 });
    expect(response.body).not.toContain(item.jpegKey);
    expect(response.body).not.toMatch(/sha256|jpegKey|thumbnailKey/i);
  });

  it('answers 404 when listing media of an unknown VM', async () => {
    expect((await admin.get('/admin/vms/qemu/Nope/media')).statusCode).toBe(404);
  });

  it('serves private media to the administrator, without caching', async () => {
    const vm = await newVm();
    const item = await insertMedia(context, vm);
    const response = await admin.get(`${vm.path}/media/${item.id}/thumbnail`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toBe(`thumb:${item.id}`);
  });

  it('does not serve media through another VM’s path', async () => {
    const owner = await newVm();
    const other = await newVm();
    const item = await insertMedia(context, owner);
    expect((await admin.get(`${other.path}/media/${item.id}/full`)).statusCode).toBe(404);
  });
});

describe('deleting media', () => {
  const remove = (path: string, id: string) =>
    admin.request({ method: 'DELETE', url: `${path}/media/${id}` });
  const fileExists = (key: string) => existsSync(join(context.storageRoot, key));

  it('removes the row and both files', async () => {
    const vm = await newVm();
    const item = await insertMedia(context, vm);
    expect(fileExists(item.jpegKey)).toBe(true);
    const response = await remove(vm.path, item.id);
    expect(response.statusCode).toBe(200);
    expect(await mediaState(vm.path)).toEqual([]);
    expect(fileExists(item.jpegKey)).toBe(false);
    expect(fileExists(item.thumbnailKey)).toBe(false);
  });

  it('shows the placeholder after the main image goes, and promotes nothing', async () => {
    const vm = await newVm({ visibility: 'public' });
    const main = await insertMedia(context, vm, { isMain: true });
    const other = await insertMedia(context, vm);
    await remove(vm.path, main.id);
    expect((await publicCard(vm.vmName))?.mainImage).toBeNull();
    const state = await mediaState(vm.path);
    expect(state.map((item) => item.id)).toEqual([other.id]);
    expect(state[0]?.isMain).toBe(false);
  });

  it('succeeds when the files are already gone, so a retry can finish', async () => {
    const vm = await newVm();
    const item = await insertMedia(context, vm, { writeFiles: false });
    expect((await remove(vm.path, item.id)).statusCode).toBe(200);
  });

  it('keeps the metadata if the files cannot be removed, and then a retry works', async () => {
    const vm = await newVm();
    const item = await insertMedia(context, vm);
    const failure = vi
      .spyOn(context.dependencies.storage, 'remove')
      .mockRejectedValueOnce(new Error('EACCES: permission denied, C:\\private\\path'));

    const response = await remove(vm.path, item.id);
    expect(response.statusCode).toBe(500);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('internal_error');
    expect(response.body).not.toContain('private');
    expect((await mediaState(vm.path)).map((media) => media.id)).toEqual([item.id]);
    failure.mockRestore();

    expect((await remove(vm.path, item.id)).statusCode).toBe(200);
    expect(await mediaState(vm.path)).toEqual([]);
    expect(fileExists(item.jpegKey)).toBe(false);
  });

  it('refuses an unsafe stored key, keeping the row and touching nothing', async () => {
    const vm = await newVm();
    const item = await insertMedia(context, vm, {
      writeFiles: false,
      jpegKey: '../../outside.jpg',
      thumbnailKey: 'thumb-unsafe.jpg',
    });
    expect((await remove(vm.path, item.id)).statusCode).toBe(500);
    expect((await mediaState(vm.path)).map((media) => media.id)).toEqual([item.id]);
  });

  it('leaves files that another item still uses', async () => {
    const vm = await newVm();
    const shared = `shared/${vm.vmName}.jpg`;
    const one = await insertMedia(context, vm, { jpegKey: shared, thumbnailKey: `${shared}.1` });
    const two = await insertMedia(context, vm, { jpegKey: shared, thumbnailKey: `${shared}.2` });
    await remove(vm.path, one.id);
    expect(fileExists(shared)).toBe(true);
    expect(fileExists(`${shared}.1`)).toBe(false);
    await remove(vm.path, two.id);
    expect(fileExists(shared)).toBe(false);
  });

  it('cannot delete through another VM', async () => {
    const owner = await newVm();
    const other = await newVm();
    const item = await insertMedia(context, owner);
    expect((await remove(other.path, item.id)).statusCode).toBe(404);
    expect(await mediaState(owner.path)).toHaveLength(1);
    expect(fileExists(item.jpegKey)).toBe(true);
  });

  it('answers 404 for an unknown item', async () => {
    const vm = await newVm();
    expect((await remove(vm.path, UNKNOWN_ID)).statusCode).toBe(404);
  });

  it('leaves versions alone: media are independent of them', async () => {
    const [before] = await context.pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM vm_versions',
    );
    const vm = await newVm();
    const item = await insertMedia(context, vm);
    await remove(vm.path, item.id);
    const [after] = await context.pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM vm_versions',
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});
