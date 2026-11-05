import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { PublicVmCard } from '@emucat/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiError,
  emptyPage,
  MEDIA_ID,
  mockApi,
  OTHER_MEDIA_ID,
  renderAt,
  Reply,
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

const card = (overrides: Partial<PublicVmCard> = {}): PublicVmCard => ({
  emulatorType: 'qemu',
  vmName: 'Win98',
  displayName: 'Windows 98 SE',
  summary: 'A retro machine',
  mainImage: null,
  ...overrides,
});

const page = (items: PublicVmCard[], total = items.length, current = 1) => ({
  items,
  pagination: { page: current, pageSize: 24, total, totalPages: Math.ceil(total / 24) },
});

describe('empty states', () => {
  it('explains an empty catalog, requesting real data and offering no filters', async () => {
    const api = mockApi();
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'No virtual machines yet' })).toBeTruthy();
    expect(api.callsTo('GET', '/catalog/vms')).toHaveLength(1);
    expect(screen.queryByRole('search')).toBeNull();
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
  });

  it('works without being signed in', async () => {
    const api = mockApi({ 'GET /catalog/vms': page([card()]) });
    renderAt('/');
    expect(await screen.findByRole('link', { name: 'Windows 98 SE' })).toBeTruthy();
    expect(api.calls.filter((call) => call.path.startsWith('/admin'))).toEqual([]);
  });

  it('distinguishes "nothing matches" from "nothing exists", and can clear filters', async () => {
    const api = mockApi({
      'GET /catalog/vms': (call: { query: URLSearchParams }) =>
        call.query.get('q') ? emptyPage() : page([card()]),
    });
    renderAt('/?q=nothing');
    expect(await screen.findByRole('heading', { name: 'Nothing matches' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('link', { name: 'Windows 98 SE' })).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe('/');
    expect(api.callsTo('GET', '/catalog/vms').at(-1)?.query.get('q')).toBeNull();
  });

  it('copes with a page number past the end', async () => {
    mockApi({
      'GET /catalog/vms': (call: { query: URLSearchParams }) =>
        call.query.get('page') === '99' ? page([], 3, 99) : page([card()], 3),
    });
    renderAt('/?page=99');
    fireEvent.click(await screen.findByRole('button', { name: 'Back to the first page' }));
    expect(await screen.findByRole('link', { name: 'Windows 98 SE' })).toBeTruthy();
  });
});

describe('loading and errors', () => {
  it('shows a loading state until the data arrives', async () => {
    let release: (value: unknown) => void = () => undefined;
    mockApi({ 'GET /catalog/vms': () => new Promise((resolve) => (release = resolve)) });
    renderAt('/');
    expect(screen.getByText('Loading the catalog')).toBeTruthy();
    release(page([card()]));
    expect(await screen.findByRole('link', { name: 'Windows 98 SE' })).toBeTruthy();
    expect(screen.queryByText('Loading the catalog')).toBeNull();
  });

  it('reports a failure, and recovers with a retry', async () => {
    let failing = true;
    mockApi({
      'GET /catalog/vms': () =>
        failing ? apiError(500, 'internal_error', 'Internal error') : page([card()]),
    });
    renderAt('/');
    expect(
      await screen.findByRole('heading', { name: 'The catalog could not be loaded' }),
    ).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Windows 98 SE' })).toBeTruthy();
  });

  it('reports an unreachable server', async () => {
    mockApi({ 'GET /catalog/vms': new Reply(502, 'Bad gateway') });
    renderAt('/');
    expect((await screen.findByRole('alert')).textContent).toContain('could not be reached');
  });

  it('refuses a response that does not match the contract', async () => {
    mockApi({ 'GET /catalog/vms': { items: 'nope' } });
    renderAt('/');
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('refuses a public response carrying a field it should not', async () => {
    mockApi({
      'GET /catalog/vms': page([{ ...card(), jpegKey: 'private/path.jpg' } as PublicVmCard]),
    });
    renderAt('/');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(document.body.textContent).not.toContain('private/path.jpg');
  });
});

describe('cards', () => {
  it('shows the display name, emulator and description', async () => {
    mockApi({ 'GET /catalog/vms': page([card()]) });
    renderAt('/');
    const link = await screen.findByRole('link', { name: 'Windows 98 SE' });
    const article = link.closest('article') as HTMLElement;
    expect(within(article).getByText('QEMU')).toBeTruthy();
    expect(within(article).getByText('A retro machine')).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/vms/qemu/Win98');
  });

  it('falls back to the VM name, and encodes it in the link', async () => {
    mockApi({
      'GET /catalog/vms': page([card({ displayName: null, vmName: 'Windows 98 SE' })]),
    });
    renderAt('/');
    const link = await screen.findByRole('link', { name: 'Windows 98 SE' });
    expect(link.getAttribute('href')).toBe('/vms/qemu/Windows%2098%20SE');
  });

  it('shows the image when there is one, and the placeholder otherwise', async () => {
    mockApi({
      'GET /catalog/vms': page([
        card({ vmName: 'WithImage', mainImage: { id: MEDIA_ID, widthPx: 640, heightPx: 480 } }),
        card({ vmName: 'NoImage', displayName: 'No image here' }),
      ]),
    });
    renderAt('/');
    const withImage = (await screen.findByRole('link', { name: 'Windows 98 SE' })).closest(
      'article',
    ) as HTMLElement;
    expect(withImage.querySelector('img')?.getAttribute('src')).toBe(
      `/api/v1/catalog/media/${MEDIA_ID}/thumbnail`,
    );
    const noImage = screen
      .getByRole('link', { name: 'No image here' })
      .closest('article') as HTMLElement;
    expect(noImage.querySelector('img')).toBeNull();
    expect(within(noImage).getByRole('img', { name: 'No image' })).toBeTruthy();
  });

  it('falls back to the placeholder if the image fails to load', async () => {
    mockApi({
      'GET /catalog/vms': page([
        card({ mainImage: { id: MEDIA_ID, widthPx: 640, heightPx: 480 } }),
      ]),
    });
    renderAt('/');
    const article = (await screen.findByRole('link', { name: 'Windows 98 SE' })).closest(
      'article',
    ) as HTMLElement;
    fireEvent.error(article.querySelector('img') as HTMLImageElement);
    expect(within(article).getByRole('img', { name: 'No image' })).toBeTruthy();
  });

  it('does not indicate visibility in the public view', async () => {
    mockApi({ 'GET /catalog/vms': page([card()]) });
    renderAt('/');
    await screen.findByRole('link', { name: 'Windows 98 SE' });
    expect(screen.queryByText('Public')).toBeNull();
    expect(screen.queryByText('Private')).toBeNull();
  });

  it('renders text from the server as text, never as markup', async () => {
    mockApi({
      'GET /catalog/vms': page([
        card({
          displayName: '<img src=x onerror=alert(1)>',
          summary: '<script>alert(1)</script>',
        }),
      ]),
    });
    renderAt('/');
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
    expect(document.querySelector('main script, main img[src="x"]')).toBeNull();
  });
});

describe('filters', () => {
  const lastQuery = (api: ReturnType<typeof mockApi>) =>
    api.callsTo('GET', '/catalog/vms').at(-1)?.query;

  it('sends the search and keeps it in the URL', async () => {
    const api = mockApi({ 'GET /catalog/vms': page([card()]) });
    renderAt('/');
    await screen.findByRole('link', { name: 'Windows 98 SE' });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '  win 98 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(lastQuery(api)?.get('q')).toBe('win 98'));
    expect(screen.getByTestId('location').textContent).toBe('/?q=win+98');
  });

  it('restores filters from the URL', async () => {
    const api = mockApi({ 'GET /catalog/vms': page([card()]) });
    renderAt('/?q=dos&emulator=86box&page=2');
    await screen.findByRole('link', { name: 'Windows 98 SE' });
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('dos');
    expect(lastQuery(api)?.get('q')).toBe('dos');
    expect(lastQuery(api)?.get('emulatorType')).toBe('86box');
    expect(lastQuery(api)?.get('page')).toBe('2');
    expect(screen.getByRole('button', { name: '86Box' }).getAttribute('aria-pressed')).toBe('true');
  });

  it.each(['/?emulator=dosbox', '/?page=-1', '/?page=abc', '/?page=1.5'])(
    'ignores the invalid URL %s rather than sending it',
    async (path) => {
      const api = mockApi({ 'GET /catalog/vms': page([card()]) });
      renderAt(path);
      await screen.findByRole('link', { name: 'Windows 98 SE' });
      expect(lastQuery(api)?.get('emulatorType')).toBeNull();
      expect(lastQuery(api)?.get('page')).toBe('1');
    },
  );

  it('filters by emulator and returns to the first page', async () => {
    const api = mockApi({ 'GET /catalog/vms': page([card()], 50) });
    renderAt('/?page=2');
    await screen.findByRole('link', { name: 'Windows 98 SE' });
    fireEvent.click(screen.getByRole('button', { name: 'QEMU' }));
    await waitFor(() => expect(lastQuery(api)?.get('emulatorType')).toBe('qemu'));
    expect(lastQuery(api)?.get('page')).toBe('1');
    fireEvent.click(await screen.findByRole('button', { name: 'All' }));
    await waitFor(() => expect(lastQuery(api)?.get('emulatorType')).toBeNull());
  });

  it('pages through results', async () => {
    const api = mockApi({
      'GET /catalog/vms': (call: { query: URLSearchParams }) =>
        page([card()], 60, Number(call.query.get('page'))),
    });
    renderAt('/');
    await screen.findByRole('link', { name: 'Windows 98 SE' });
    expect(screen.getByText('60 virtual machines, page 1 of 3')).toBeTruthy();
    const previous = screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('60 virtual machines, page 2 of 3');
    expect(lastQuery(api)?.get('page')).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    await screen.findByText('60 virtual machines, page 3 of 3');
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides pagination when there is one page', async () => {
    mockApi({ 'GET /catalog/vms': page([card()]) });
    renderAt('/');
    await screen.findByRole('link', { name: 'Windows 98 SE' });
    expect(screen.queryByRole('navigation', { name: 'Catalog pages' })).toBeNull();
  });
});

describe('VM detail', () => {
  const detail = {
    emulatorType: 'qemu',
    vmName: 'Win98',
    displayName: 'Windows 98 SE',
    description: 'Line one\nLine two',
    mainImage: { id: MEDIA_ID, widthPx: 640, heightPx: 480 },
    gallery: [
      { id: MEDIA_ID, widthPx: 640, heightPx: 480 },
      { id: OTHER_MEDIA_ID, widthPx: 640, heightPx: 480 },
    ],
  };

  it('shows the main image, the description and the rest of the gallery', async () => {
    mockApi({ 'GET /catalog/vms/qemu/Win98': detail });
    renderAt('/vms/qemu/Win98');
    expect(await screen.findByRole('heading', { name: 'Windows 98 SE' })).toBeTruthy();
    expect(screen.getByAltText('Screenshot of Windows 98 SE').getAttribute('src')).toBe(
      `/api/v1/catalog/media/${MEDIA_ID}/full`,
    );
    expect(screen.getByText(/Line one/)).toBeTruthy();
    const gallery = screen.getByRole('heading', { name: 'More images' })
      .parentElement as HTMLElement;
    const sources = within(gallery)
      .getAllByRole('img')
      .map((image) => image.getAttribute('src'));
    expect(sources).toEqual([`/api/v1/catalog/media/${OTHER_MEDIA_ID}/thumbnail`]);
  });

  it('shows the placeholder without promoting a gallery image', async () => {
    mockApi({ 'GET /catalog/vms/qemu/Win98': { ...detail, mainImage: null } });
    renderAt('/vms/qemu/Win98');
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    expect(screen.queryByAltText('Screenshot of Windows 98 SE')).toBeNull();
    expect(screen.getByRole('img', { name: 'No image' })).toBeTruthy();
  });

  it('decodes names with spaces', async () => {
    const api = mockApi({
      'GET /catalog/vms/qemu/Windows 98 SE': { ...detail, vmName: 'Windows 98 SE' },
    });
    renderAt('/vms/qemu/Windows%2098%20SE');
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    expect(api.callsTo('GET', '/catalog/vms/qemu/Windows 98 SE')).toHaveLength(1);
  });

  it('treats a missing or private VM the same way', async () => {
    mockApi({
      'GET /catalog/vms/qemu/Hidden': apiError(404, 'vm_not_found', 'Virtual machine not found'),
    });
    renderAt('/vms/qemu/Hidden');
    expect(
      await screen.findByRole('heading', { name: 'This virtual machine is not available' }),
    ).toBeTruthy();
  });

  it.each(['/vms/dosbox/Win98', '/vms/qemu/..%2F..%2Fetc', '/vms/qemu/CON'])(
    'does not request the invalid identity %s',
    async (path) => {
      const api = mockApi();
      renderAt(path);
      await screen.findByRole('heading', { name: 'This virtual machine is not available' });
      expect(api.calls.filter((call) => call.path.startsWith('/catalog/vms/'))).toEqual([]);
    },
  );

  it('offers administrators a link to manage the VM, and nobody else', async () => {
    mockApi({ ...signedInAsAdmin, 'GET /catalog/vms/qemu/Win98': detail });
    renderAt('/vms/qemu/Win98');
    const manage = await screen.findByRole('link', { name: 'Manage this VM' });
    expect(manage.getAttribute('href')).toBe('/admin/vms/qemu/Win98');
  });

  it('shows no management link to the public', async () => {
    mockApi({ 'GET /catalog/vms/qemu/Win98': detail });
    renderAt('/vms/qemu/Win98');
    await screen.findByRole('heading', { name: 'Windows 98 SE' });
    expect(screen.queryByRole('link', { name: 'Manage this VM' })).toBeNull();
  });
});
