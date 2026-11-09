import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  adminMedia,
  adminVm,
  apiError,
  MEDIA_ID,
  mockApi,
  OTHER_MEDIA_ID,
  renderAt,
  signedInAsAdmin,
} from './mock-api';

const THIRD_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f72';
const PUBLIC_PATH = '/catalog/vms/qemu/Win98';
const VM_PATH = '/admin/vms/qemu/Win98';

const image = (id: string) => ({ id, widthPx: 640, heightPx: 480 });

const detail = {
  emulatorType: 'qemu',
  vmName: 'Win98',
  displayName: 'Windows 98 SE',
  description: 'A retro machine',
  mainImage: image(MEDIA_ID),
  gallery: [image(MEDIA_ID), image(OTHER_MEDIA_ID), image(THIRD_ID)],
};

async function openGallery() {
  mockApi({ [`GET ${PUBLIC_PATH}`]: detail });
  renderAt('/vms/qemu/Win98');
  await screen.findByRole('heading', { name: 'Windows 98 SE' });
  return screen.getByRole('heading', { name: 'Screenshots' }).closest('section') as HTMLElement;
}

const thumbnailButton = (gallery: HTMLElement, name: RegExp) =>
  within(gallery).getByRole('button', { name });

describe('the public gallery', () => {
  it('shows the main screenshot prominently, and thumbnails of all of them', async () => {
    const gallery = await openGallery();
    const main = screen.getByAltText('Screenshot of Windows 98 SE');
    expect(main.getAttribute('src')).toBe(`/api/v1/catalog/media/${MEDIA_ID}/full`);
    const thumbnails = [...gallery.querySelectorAll('img')];
    expect(thumbnails.map((item) => item.getAttribute('src'))).toEqual([
      `/api/v1/catalog/media/${MEDIA_ID}/thumbnail`,
      `/api/v1/catalog/media/${OTHER_MEDIA_ID}/thumbnail`,
      `/api/v1/catalog/media/${THIRD_ID}/thumbnail`,
    ]);
    for (const thumbnail of thumbnails) {
      expect(thumbnail.getAttribute('loading')).toBe('lazy');
    }
  });

  it('loads no full-resolution image but the main one until asked', async () => {
    const gallery = await openGallery();
    const full = [...document.querySelectorAll('img')]
      .map((item) => item.getAttribute('src') ?? '')
      .filter((src) => src.endsWith('/full'));
    expect(full).toEqual([`/api/v1/catalog/media/${MEDIA_ID}/full`]);
    expect(gallery.querySelector('[src$="/full"]')).toBeNull();
  });

  it('never refers to an original, or offers an administrator’s controls', async () => {
    const gallery = await openGallery();
    fireEvent.click(thumbnailButton(gallery, /Screenshot 2 of/));
    expect(document.body.innerHTML).not.toContain('/original');
    expect(screen.queryByText('Download original')).toBeNull();
    expect(screen.queryByText('Set as main image')).toBeNull();
    expect(screen.queryByText('Publish')).toBeNull();
    expect(screen.queryByText('Restore…')).toBeNull();
    expect(screen.queryByText('Manage this VM')).toBeNull();
  });

  it('opens the viewer from a thumbnail, with a labelled modal dialog', async () => {
    const gallery = await openGallery();
    fireEvent.click(thumbnailButton(gallery, /Screenshot 2 of/));
    const dialog = screen.getByRole('dialog', {
      name: 'Full-resolution view of Screenshot 2 of Windows 98 SE',
    });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(
      `/api/v1/catalog/media/${OTHER_MEDIA_ID}/full`,
    );
    expect(within(dialog).getByText(/2 of 3/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));
  });

  it('opens the viewer from the main screenshot too', async () => {
    await openGallery();
    fireEvent.click(
      screen.getByRole('button', { name: 'View the main screenshot at full resolution' }),
    );
    expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(
      `/api/v1/catalog/media/${MEDIA_ID}/full`,
    );
  });

  it('moves with the arrow keys and the buttons, wrapping at both ends', async () => {
    const gallery = await openGallery();
    fireEvent.click(thumbnailButton(gallery, /Screenshot 2 of/));
    const shown = () => screen.getByRole('dialog').querySelector('img')?.getAttribute('src');
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(shown()).toBe(`/api/v1/catalog/media/${THIRD_ID}/full`);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(shown()).toBe(`/api/v1/catalog/media/${MEDIA_ID}/full`);
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(shown()).toBe(`/api/v1/catalog/media/${THIRD_ID}/full`);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Previous' }));
    expect(shown()).toBe(`/api/v1/catalog/media/${OTHER_MEDIA_ID}/full`);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Next' }));
    expect(shown()).toBe(`/api/v1/catalog/media/${THIRD_ID}/full`);
  });

  it('traps focus inside the dialog in both directions', async () => {
    const gallery = await openGallery();
    fireEvent.click(thumbnailButton(gallery, /Screenshot 2 of/));
    const dialog = screen.getByRole('dialog');
    const previous = within(dialog).getByRole('button', { name: 'Previous' });
    const close = within(dialog).getByRole('button', { name: 'Close' });

    close.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(previous);

    previous.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);

    // Focus that somehow ended up behind the dialog is brought back.
    thumbnailButton(gallery, /Screenshot 2 of/).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('closes with Escape, and returns focus to the thumbnail of the image it ended on', async () => {
    const gallery = await openGallery();
    fireEvent.click(thumbnailButton(gallery, /Screenshot 2 of/));
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(thumbnailButton(gallery, /Screenshot 3 of/));
  });

  it('stops the page behind from scrolling, and restores it', async () => {
    const gallery = await openGallery();
    fireEvent.click(thumbnailButton(gallery, /Screenshot 2 of/));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('shows a loading state, then the image, or a clear message if it cannot load', async () => {
    const gallery = await openGallery();
    fireEvent.click(thumbnailButton(gallery, /Screenshot 2 of/));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('status').textContent).toContain('Loading');
    const picture = dialog.querySelector('img') as HTMLImageElement;
    expect(picture.hidden).toBe(true);
    fireEvent.load(picture);
    expect(within(dialog).queryByRole('status')).toBeNull();
    expect((dialog.querySelector('img') as HTMLImageElement).hidden).toBe(false);

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    const next = dialog.querySelector('img') as HTMLImageElement;
    expect(within(dialog).getByRole('status')).toBeTruthy();
    fireEvent.error(next);
    expect(within(dialog).getByRole('alert').textContent).toContain('could not be loaded');
    expect(dialog.querySelector('img')).toBeNull();
    // A bad image does not stop the rest of the gallery.
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(dialog.querySelector('img')).not.toBeNull();
  });

  it('has no previous or next for a single image, and the keys do nothing', async () => {
    mockApi({ [`GET ${PUBLIC_PATH}`]: { ...detail, gallery: [image(MEDIA_ID)] } });
    renderAt('/vms/qemu/Win98');
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    fireEvent.click(
      screen.getAllByRole('button', { name: /Screenshot of Windows 98 SE/ })[0] as HTMLElement,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Next' })).toBeNull();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(dialog.querySelector('img')?.getAttribute('src')).toContain(MEDIA_ID);
  });

  it('shows a clear placeholder when the VM has no screenshots', async () => {
    mockApi({ [`GET ${PUBLIC_PATH}`]: { ...detail, mainImage: null, gallery: [] } });
    renderAt('/vms/qemu/Win98');
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    expect(screen.getByRole('img', { name: 'No image' })).toBeTruthy();
    expect(screen.getByText('There are no screenshots yet.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Screenshots' })).toBeNull();
  });

  it('loads a large gallery a page at a time, and the viewer can still reach everything', async () => {
    const ids = Array.from(
      { length: 30 },
      (_, index) => `018f47a0-7c2b-4f7e-9a3d-${String(index).padStart(12, '0')}`,
    );
    mockApi({
      [`GET ${PUBLIC_PATH}`]: { ...detail, mainImage: null, gallery: ids.map(image) },
    });
    renderAt('/vms/qemu/Win98');
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    const gallery = screen
      .getByRole('heading', { name: 'Screenshots' })
      .closest('section') as HTMLElement;
    expect(gallery.querySelectorAll('img')).toHaveLength(24);

    // Moving past what is shown, then closing, has a thumbnail to return to.
    fireEvent.click(thumbnailButton(gallery, /Screenshot 24 of/));
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(gallery.querySelectorAll('img')).toHaveLength(24);

    fireEvent.click(screen.getByRole('button', { name: 'Show more (6 left)' }));
    expect(gallery.querySelectorAll('img')).toHaveLength(30);
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
  });
});

describe('navigation', () => {
  const page = {
    items: [
      {
        emulatorType: 'qemu',
        vmName: 'Win98',
        displayName: 'Windows 98 SE',
        summary: 'A retro machine',
        mainImage: image(MEDIA_ID),
      },
    ],
    pagination: { page: 1, pageSize: 24, total: 1, totalPages: 1 },
  };

  it('makes a card one link to the detail page, with nothing else interactive inside', async () => {
    mockApi({ 'GET /catalog/vms': page, [`GET ${PUBLIC_PATH}`]: detail });
    renderAt('/');
    const link = await screen.findByRole('link', { name: 'Windows 98 SE' });
    const card = link.closest('article') as HTMLElement;
    expect(link.getAttribute('href')).toBe('/vms/qemu/Win98');
    expect(card.querySelectorAll('a')).toHaveLength(1);
    expect(card.querySelectorAll('button')).toHaveLength(0);
    expect(card.querySelector('img')?.getAttribute('src')).toBe(
      `/api/v1/catalog/media/${MEDIA_ID}/thumbnail`,
    );

    fireEvent.click(link);
    expect(await screen.findByRole('heading', { name: 'Screenshots' })).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe('/vms/qemu/Win98');
  });

  it('falls back to the placeholder when a card image fails to load', async () => {
    mockApi({ 'GET /catalog/vms': page });
    renderAt('/');
    const link = await screen.findByRole('link', { name: 'Windows 98 SE' });
    const card = link.closest('article') as HTMLElement;
    fireEvent.error(card.querySelector('img') as HTMLImageElement);
    expect(card.querySelector('img')).toBeNull();
    expect(within(card).getByRole('img', { name: 'No image' })).toBeTruthy();
  });

  it('opens directly from a URL', async () => {
    mockApi({ [`GET ${PUBLIC_PATH}`]: detail });
    renderAt('/vms/qemu/Win98');
    expect(await screen.findByRole('heading', { name: 'Windows 98 SE' })).toBeTruthy();
  });

  it('takes an administrator from the public URL of a private VM to the page they may see', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${PUBLIC_PATH}`]: apiError(404, 'vm_not_found', 'Virtual machine not found'),
      [`GET ${VM_PATH}`]: adminVm(),
      [`GET ${VM_PATH}/media`]: { media: [] },
    });
    renderAt('/vms/qemu/Win98');
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/admin/vms/qemu/Win98'),
    );
  });

  it('tells a visitor nothing about a private VM', async () => {
    mockApi({
      [`GET ${PUBLIC_PATH}`]: apiError(404, 'vm_not_found', 'Virtual machine not found'),
    });
    renderAt('/vms/qemu/Win98');
    expect(
      await screen.findByRole('heading', { name: 'This virtual machine is not available' }),
    ).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe('/vms/qemu/Win98');
  });
});

describe('the cover notice on the administrator’s page', () => {
  const media = [adminMedia({ isMain: true })];

  it('shows a public VM’s main screenshot as the cover, with nothing to publish separately', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${VM_PATH}`]: adminVm({
        visibility: 'public',
        mainMediaId: MEDIA_ID,
        mediaCount: 1,
        publicCover: 'shown',
      }),
      [`GET ${VM_PATH}/media`]: { media: [adminMedia({ isMain: true, shownAsPublicMain: true })] },
    });
    renderAt(VM_PATH);
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    expect(
      await screen.findByText('The main screenshot is the public catalog’s cover.'),
    ).toBeTruthy();
    expect(screen.getByText(/all of its screenshots in the public catalog/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish the main screenshot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(
      api.calls.filter((call) => call.path.includes('/media/') && call.method === 'PUT'),
    ).toEqual([]);
  });

  it('publishes every screenshot by making the VM public, and refreshes them', async () => {
    let vm = adminVm({ mainMediaId: MEDIA_ID, mediaCount: 1, publicCover: 'vm_private' });
    let mediaList = [adminMedia({ isMain: true })];
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${VM_PATH}`]: () => vm,
      [`GET ${VM_PATH}/media`]: () => ({ media: mediaList }),
      [`PUT ${VM_PATH}/visibility`]: () => {
        vm = { ...vm, visibility: 'public', publicCover: 'shown' };
        mediaList = [adminMedia({ isMain: true, shownAsPublicMain: true })];
        return vm;
      },
    });
    renderAt(VM_PATH);
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    expect(
      await screen.findByText(/Making it public publishes all of its screenshots/),
    ).toBeTruthy();
    expect(await screen.findByText(/this VM is private: nobody outside sees it/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Make public' }));
    await screen.findByText('The main screenshot is the public catalog’s cover.');
    expect(await screen.findByText('Shown as the main image in the public catalog.')).toBeTruthy();
    const [call] = api.callsTo('PUT', `${VM_PATH}/visibility`);
    expect(call?.body).toEqual({ visibility: 'public' });
    expect(
      api.calls.filter((call) => call.path.includes('/media/') && call.method === 'PUT'),
    ).toEqual([]);
  });

  it('explains a public VM with no main screenshot', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${VM_PATH}`]: adminVm({ visibility: 'public', publicCover: 'no_main_image' }),
      [`GET ${VM_PATH}/media`]: { media: [] },
    });
    renderAt(VM_PATH);
    expect(await screen.findByText(/no main screenshot is selected/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish the main screenshot' })).toBeNull();
  });

  it('says nothing alarming when a cover is shown, or the VM is private', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${VM_PATH}`]: adminVm({ mainMediaId: MEDIA_ID, publicCover: 'vm_private' }),
      [`GET ${VM_PATH}/media`]: { media },
    });
    renderAt(VM_PATH);
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    expect(screen.queryByText(/No public cover/)).toBeNull();
  });

  it('shows the warning on the administrator’s catalog card', async () => {
    mockApi({
      ...signedInAsAdmin,
      'GET /admin/vms': {
        items: [
          {
            emulatorType: 'qemu',
            vmName: 'Win98',
            displayName: 'Windows 98 SE',
            summary: null,
            visibility: 'public',
            mainMediaId: null,
            publicCover: 'no_main_image',
            mediaCount: 1,
            activeSessions: 0,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        pagination: { page: 1, pageSize: 24, total: 1, totalPages: 1 },
      },
    });
    renderAt('/admin/catalog');
    const link = await screen.findByRole('link', { name: 'Windows 98 SE' });
    expect(link.getAttribute('href')).toBe(VM_PATH);
    expect(screen.getByText('No public cover')).toBeTruthy();
  });
});

describe('the administrator’s gallery', () => {
  const media = [
    adminMedia({ isMain: true }),
    adminMedia({ id: OTHER_MEDIA_ID, originalFilename: 'desk.png' }),
  ];

  const open = async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${VM_PATH}`]: adminVm({ mainMediaId: MEDIA_ID, mediaCount: 2 }),
      [`GET ${VM_PATH}/media`]: { media },
      [`PUT ${VM_PATH}/main-media`]: { media },
      [`DELETE ${VM_PATH}/main-media`]: { media },
    });
    renderAt(VM_PATH);
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    await screen.findByRole('heading', { name: 'desk.png' });
    return api;
  };

  it('shows every screenshot with its controls, on the VM’s page', async () => {
    const api = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Clear main image' }));
    await waitFor(() => expect(api.callsTo('DELETE', `${VM_PATH}/main-media`)).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Set as main image' }));
    await waitFor(() => expect(api.callsTo('PUT', `${VM_PATH}/main-media`)).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('uses the same viewer, with derivatives, and the original only as a download', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'View desk.png at full resolution' }));
    const dialog = screen.getByRole('dialog', { name: 'Full-resolution view of desk.png' });
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(
      `/api/v1${VM_PATH}/media/${OTHER_MEDIA_ID}/full`,
    );
    const download = within(dialog).getByRole('link', { name: 'Download original' });
    expect(download.getAttribute('href')).toBe(
      `/api/v1${VM_PATH}/media/${OTHER_MEDIA_ID}/original`,
    );
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(dialog.querySelector('img')?.getAttribute('src')).toContain(MEDIA_ID);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'View boot.png at full resolution' }),
    );
  });
});
