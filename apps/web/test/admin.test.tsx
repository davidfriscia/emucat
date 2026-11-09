import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminMedia,
  adminVm,
  apiError,
  MEDIA_ID,
  mockApi,
  OTHER_MEDIA_ID,
  renderAt,
  resetApiState,
  signedInAsAdmin,
} from './mock-api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  resetApiState();
});

const VM_PATH = '/admin/vms/qemu/Win98';
const emptyAdminPage = {
  items: [],
  pagination: { page: 1, pageSize: 24, total: 0, totalPages: 0 },
};
const SUMMARY = {
  vms: { total: 3, public: 1, private: 2 },
  media: { total: 5, public: 4, private: 1 },
};

describe('dashboard', () => {
  it('shows real counts and explains how VMs get registered', async () => {
    mockApi({ ...signedInAsAdmin, 'GET /admin/summary': SUMMARY });
    renderAt('/admin');
    expect(await screen.findByText('1 public, 2 private')).toBeTruthy();
    expect(screen.getByText('4 public, 1 private, by their VM')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/connected EmuCat agent/);
    expect(screen.getByRole('note').textContent).toMatch(/Agents page/);
  });

  it('reports a failure', async () => {
    mockApi({
      ...signedInAsAdmin,
      'GET /admin/summary': apiError(500, 'internal_error', 'Internal error'),
    });
    renderAt('/admin');
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('catalog management', () => {
  const list = (items: object[]) => ({
    items,
    pagination: { page: 1, pageSize: 24, total: items.length, totalPages: 1 },
  });
  const CARD = {
    emulatorType: 'qemu',
    vmName: 'Win98',
    displayName: 'Windows 98 SE',
    summary: 'A retro machine',
    visibility: 'private',
    mainMediaId: null,
    publicCover: 'vm_private',
    activeSessions: 0,
    mediaCount: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('has an empty state, and no way to create a VM', async () => {
    mockApi({ ...signedInAsAdmin, 'GET /admin/vms': emptyAdminPage });
    renderAt('/admin/catalog');
    expect(
      await screen.findByRole('heading', { name: 'No registered virtual machines' }),
    ).toBeTruthy();
    expect(screen.getAllByText(/Agents page/).length).toBeGreaterThan(0);
    for (const element of [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')]) {
      expect(element.textContent).not.toMatch(/\b(create|add|new|register)\b/i);
    }
  });

  it('marks each VM’s visibility', async () => {
    mockApi({
      ...signedInAsAdmin,
      'GET /admin/vms': list([
        CARD,
        { ...CARD, vmName: 'Dos', displayName: 'DOS 6.22', visibility: 'public' },
      ]),
    });
    renderAt('/admin/catalog');
    const privateCard = (await screen.findByRole('link', { name: 'Windows 98 SE' })).closest(
      'article',
    ) as HTMLElement;
    const publicCard = screen
      .getByRole('link', { name: 'DOS 6.22' })
      .closest('article') as HTMLElement;
    expect(within(privateCard).getByText('Private')).toBeTruthy();
    expect(within(publicCard).getByText('Public')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Windows 98 SE' }).getAttribute('href')).toBe(VM_PATH);
  });

  it('shows the main image through the authenticated route', async () => {
    mockApi({
      ...signedInAsAdmin,
      'GET /admin/vms': list([{ ...CARD, mainMediaId: MEDIA_ID, mediaCount: 1 }]),
    });
    renderAt('/admin/catalog');
    const article = (await screen.findByRole('link', { name: 'Windows 98 SE' })).closest(
      'article',
    ) as HTMLElement;
    expect(article.querySelector('img')?.getAttribute('src')).toBe(
      `/api/v1/admin/vms/qemu/Win98/media/${MEDIA_ID}/thumbnail`,
    );
  });

  it('filters by visibility', async () => {
    const api = mockApi({ ...signedInAsAdmin, 'GET /admin/vms': list([CARD]) });
    renderAt('/admin/catalog');
    await screen.findByRole('link', { name: 'Windows 98 SE' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by visibility' }), {
      target: { value: 'private' },
    });
    await waitFor(() =>
      expect(api.callsTo('GET', '/admin/vms').at(-1)?.query.get('visibility')).toBe('private'),
    );
  });
});

describe('VM editor', () => {
  it('shows the identity as read-only text', async () => {
    mockApi({ ...signedInAsAdmin, [`GET ${VM_PATH}`]: adminVm() });
    renderAt(VM_PATH);
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    expect(screen.queryByRole('textbox', { name: /VM name|emulator/i })).toBeNull();
    expect(screen.getAllByText('Win98').length).toBeGreaterThan(0);
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Windows 98 SE');
  });

  it('saves only the permitted fields, with the CSRF token', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${VM_PATH}`]: adminVm(),
      [`PATCH ${VM_PATH}`]: adminVm({ displayName: 'Renamed', description: 'New text' }),
    });
    renderAt(VM_PATH);
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Renamed' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'New text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { name: 'Renamed' })).toBeTruthy();
    const [call] = api.callsTo('PATCH', VM_PATH);
    expect(call?.body).toEqual({ displayName: 'Renamed', description: 'New text' });
    expect(call?.headers['x-csrf-token']).toBe('test-csrf-token');
  });

  it('never sends the CSRF token on reads', async () => {
    const api = mockApi({ ...signedInAsAdmin, [`GET ${VM_PATH}`]: adminVm() });
    renderAt(VM_PATH);
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    expect(api.callsTo('GET', VM_PATH)[0]?.headers['x-csrf-token']).toBeUndefined();
  });

  it('sends blank fields as null, to clear them', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${VM_PATH}`]: adminVm(),
      [`PATCH ${VM_PATH}`]: adminVm({ displayName: null, description: null }),
    });
    renderAt(VM_PATH);
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { name: 'Win98' })).toBeTruthy();
    expect(api.callsTo('PATCH', VM_PATH)[0]?.body).toEqual({
      displayName: null,
      description: null,
    });
  });

  it('reports validation problems from the server', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${VM_PATH}`]: adminVm(),
      [`PATCH ${VM_PATH}`]: (() => {
        const reply = apiError(400, 'validation_failed', 'Request validation failed');
        (reply.body as { error: { details: object[] } }).error.details = [
          { path: 'displayName', message: 'Control characters are not allowed' },
        ];
        return reply;
      })(),
    });
    renderAt(VM_PATH);
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Control characters are not allowed');
    expect(alert.textContent).toContain('displayName');
  });

  it('changes visibility', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${VM_PATH}`]: adminVm(),
      [`PUT ${VM_PATH}/visibility`]: adminVm({ visibility: 'public' }),
    });
    renderAt(VM_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Make public' }));
    expect(await screen.findByRole('button', { name: 'Make private' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View the public page' })).toBeTruthy();
    expect(api.callsTo('PUT', `${VM_PATH}/visibility`)[0]?.body).toEqual({ visibility: 'public' });
  });

  it('explains a VM that is not registered, without offering to create it', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${VM_PATH}`]: apiError(404, 'vm_not_found', 'Virtual machine not found'),
    });
    renderAt(VM_PATH);
    expect(
      await screen.findByRole('heading', { name: 'This virtual machine is not registered' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
  });

  it('shows not-found for an invalid identity, without asking the server', async () => {
    const api = mockApi(signedInAsAdmin);
    renderAt('/admin/vms/dosbox/Win98');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(api.calls.filter((call) => call.path.startsWith('/admin/vms'))).toEqual([]);
  });
});

describe('media management', () => {
  const MEDIA_PATH = `${VM_PATH}/media`;
  const twoItems = [
    adminMedia({ isMain: true, shownAsPublicMain: true }),
    adminMedia({ id: OTHER_MEDIA_ID, originalFilename: 'desktop.png' }),
  ];
  const cardFor = (name: string) =>
    screen.getByRole('heading', { name }).closest('article') as HTMLElement;

  it('has an empty state that names no upload button', async () => {
    mockApi({ ...signedInAsAdmin, [`GET ${MEDIA_PATH}`]: { media: [] } });
    renderAt(MEDIA_PATH);
    expect(await screen.findByRole('heading', { name: 'No media yet' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /upload/i })).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('shows each item’s state through the authenticated image route', async () => {
    mockApi({ ...signedInAsAdmin, [`GET ${MEDIA_PATH}`]: { media: twoItems } });
    renderAt(MEDIA_PATH);
    await screen.findByRole('heading', { name: 'boot.png' });
    const main = cardFor('boot.png');
    expect(within(main).getByText('Main image')).toBeTruthy();
    expect(within(main).getByText(/Shown as the main image/)).toBeTruthy();
    expect(main.querySelector('img')?.getAttribute('src')).toBe(
      `/api/v1/admin/vms/qemu/Win98/media/${MEDIA_ID}/thumbnail`,
    );
    const other = cardFor('desktop.png');
    expect(within(other).queryByText('Main image')).toBeNull();
  });

  it('offers no per-screenshot publication, only the cover and deletion', async () => {
    const api = mockApi({ ...signedInAsAdmin, [`GET ${MEDIA_PATH}`]: { media: twoItems } });
    renderAt(MEDIA_PATH);
    await screen.findByRole('heading', { name: 'desktop.png' });
    for (const name of ['boot.png', 'desktop.png']) {
      const card = within(cardFor(name));
      expect(card.queryByRole('button', { name: 'Publish' })).toBeNull();
      expect(card.queryByRole('button', { name: 'Make private' })).toBeNull();
      expect(card.queryByText('Published')).toBeNull();
      expect(card.queryByText('Private')).toBeNull();
    }
    expect(screen.getAllByRole('button', { name: /main image/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    expect(screen.getByText(/all of them are public while this VM is public/)).toBeTruthy();
    expect(api.calls.filter((call) => call.path.endsWith('/visibility'))).toEqual([]);
  });

  it('says when the main image is not shown because the VM is private', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: [adminMedia({ isMain: true })] },
    });
    renderAt(MEDIA_PATH);
    expect(await screen.findByText(/this VM is private: nobody outside sees it/)).toBeTruthy();
  });

  it('selects a main image', async () => {
    const after = [
      adminMedia(),
      adminMedia({ id: OTHER_MEDIA_ID, originalFilename: 'desktop.png', isMain: true }),
    ];
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: twoItems },
      [`PUT ${VM_PATH}/main-media`]: { media: after },
    });
    renderAt(MEDIA_PATH);
    await screen.findByRole('heading', { name: 'desktop.png' });
    fireEvent.click(
      within(cardFor('desktop.png')).getByRole('button', { name: 'Set as main image' }),
    );
    await waitFor(() =>
      expect(within(cardFor('desktop.png')).getByText('Main image')).toBeTruthy(),
    );
    const [call] = api.callsTo('PUT', `${VM_PATH}/main-media`);
    expect(call?.body).toEqual({ mediaId: OTHER_MEDIA_ID });
    expect(call?.headers['x-csrf-token']).toBe('test-csrf-token');
  });

  it('clears the main image', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: twoItems },
      [`DELETE ${VM_PATH}/main-media`]: {
        media: [adminMedia(), twoItems[1]],
      },
    });
    renderAt(MEDIA_PATH);
    await screen.findByRole('heading', { name: 'boot.png' });
    fireEvent.click(within(cardFor('boot.png')).getByRole('button', { name: 'Clear main image' }));
    await waitFor(() => expect(screen.queryByText('Main image')).toBeNull());
    expect(api.callsTo('DELETE', `${VM_PATH}/main-media`)).toHaveLength(1);
  });

  it('asks for confirmation before deleting, and can back out', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: twoItems },
      [`DELETE ${VM_PATH}/media/${OTHER_MEDIA_ID}`]: { media: [twoItems[0]] },
    });
    renderAt(MEDIA_PATH);
    await screen.findByRole('heading', { name: 'desktop.png' });
    const card = within(cardFor('desktop.png'));

    fireEvent.click(card.getByRole('button', { name: 'Delete' }));
    expect(api.callsTo('DELETE', `${VM_PATH}/media/${OTHER_MEDIA_ID}`)).toEqual([]);
    fireEvent.click(card.getByRole('button', { name: 'Keep' }));
    expect(api.callsTo('DELETE', `${VM_PATH}/media/${OTHER_MEDIA_ID}`)).toEqual([]);

    fireEvent.click(card.getByRole('button', { name: 'Delete' }));
    fireEvent.click(card.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'desktop.png' })).toBeNull());
    expect(api.callsTo('DELETE', `${VM_PATH}/media/${OTHER_MEDIA_ID}`)).toHaveLength(1);
  });

  it('shows a failure and keeps the list', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: twoItems },
      [`PUT ${VM_PATH}/main-media`]: apiError(404, 'media_not_found', 'Media not found'),
    });
    renderAt(MEDIA_PATH);
    await screen.findByRole('heading', { name: 'desktop.png' });
    fireEvent.click(
      within(cardFor('desktop.png')).getByRole('button', { name: 'Set as main image' }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain('Media not found');
    expect(screen.getByRole('heading', { name: 'desktop.png' })).toBeTruthy();
  });
});
