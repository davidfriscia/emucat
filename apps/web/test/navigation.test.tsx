import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_NAV_ITEMS, globalAreaOf, vmManageNavItems } from '../src/navigation';
import {
  adminSession,
  adminVm,
  apiError,
  mockApi,
  renderAt,
  resetApiState,
  signedInAsAdmin,
} from './mock-api';

/**
 * The application's navigation (docs/architecture.md, "Navigation"): the header's two areas, the Admin sidebar, and
 * a VM's management sidebar, reached from the catalog only.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  resetApiState();
  localStorage.clear();
});

const VM_PATH = '/admin/vms/qemu/Win98';
const OTHER_PATH = '/admin/vms/qemu/Dos';
const location = () => screen.getByTestId('location').textContent;
const header = () => within(screen.getAllByRole('navigation')[0] as HTMLElement);
const adminSidebar = () => within(screen.getByRole('navigation', { name: 'Admin' }));
const vmSidebar = () => within(screen.getByRole('navigation', { name: 'VM' }));
const linkNames = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole('link')
    .map((link) => link.textContent);
const current = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'page')
    .map((link) => link.textContent);

const EMPTY_PAGE = { items: [], pagination: { page: 1, pageSize: 24, total: 0, totalPages: 0 } };
const SUMMARY = {
  vms: { total: 2, public: 1, private: 1 },
  media: { total: 0, public: 0, private: 0 },
};

function card(overrides: Record<string, unknown> = {}) {
  return {
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
    tags: [],
    ...overrides,
  };
}

/** Everything a VM's sections read, for two VMs. */
function vmRoutes(path: string, vm = adminVm()) {
  return {
    [`GET ${path}`]: vm,
    [`GET ${path}/media`]: { media: [] },
    [`GET ${path}/media-sync`]: { agents: [] },
    [`GET ${path}/restore-options`]: { master: null, versions: [], agents: [] },
    [`GET ${path}/versions`]: {
      emulatorType: vm.emulatorType,
      vmName: vm.vmName,
      rootVersionId: null,
      versions: [],
    },
    [`GET ${path}/workspaces`]: { workspaces: [] },
    [`GET ${path}/remasters`]: { remasters: [] },
    [`GET ${path}/notes`]: {
      markdown: '',
      exists: false,
      etag: `"${'0'.repeat(64)}"`,
      updatedAt: null,
      sizeBytes: 0,
    },
  };
}

function manage(routes: Record<string, unknown> = {}) {
  return mockApi({
    ...signedInAsAdmin,
    ...vmRoutes(VM_PATH),
    ...vmRoutes(OTHER_PATH, adminVm({ vmName: 'Dos', displayName: 'DOS 6.22' })),
    'GET /admin/restores': { operations: [] },
    'GET /admin/local-copy-removals': { removals: [] },
    'GET /admin/sessions': { sessions: [] },
    'GET /admin/agents': { agents: [] },
    'GET /admin/agent-pairing/requests': { requests: [] },
    'GET /admin/summary': SUMMARY,
    'GET /admin/vms': EMPTY_PAGE,
    ...routes,
  });
}

describe('the navigation definitions', () => {
  it('lists exactly the Admin destinations, in order', () => {
    expect(ADMIN_NAV_ITEMS.map((item) => item.label)).toEqual([
      'Agents',
      'Registrations',
      'Repositories',
      'Appearance',
      'Application Updates',
    ]);
  });

  it('lists exactly the VM sections, in order, under the VM’s own address', () => {
    const items = vmManageNavItems({ emulatorType: 'qemu', vmName: 'Windows 95' });
    expect(items.map((item) => [item.label, item.to])).toEqual([
      ['General', '/admin/vms/qemu/Windows%2095'],
      ['Version History', '/admin/vms/qemu/Windows%2095/versions'],
      ['Local copies and restore', '/admin/vms/qemu/Windows%2095/copies'],
      ['Notes', '/admin/vms/qemu/Windows%2095/notes'],
      ['Screenshots', '/admin/vms/qemu/Windows%2095/screenshots'],
    ]);
  });

  it.each([
    ['/', 'catalog'],
    ['/vms/qemu/Win98', 'catalog'],
    ['/admin/vms/qemu/Win98', 'catalog'],
    ['/admin/vms/qemu/Win98/notes', 'catalog'],
    ['/admin', 'admin'],
    ['/admin/agents/x', 'admin'],
    ['/admin/updates', 'admin'],
    ['/account', null],
    ['/login', null],
  ])('puts %s in the %s area', (path, area) => {
    expect(globalAreaOf(path)).toBe(area);
  });
});

describe('the header', () => {
  it('offers an anonymous visitor the catalog, and no Admin', async () => {
    mockApi();
    renderAt('/');
    await header().findByRole('link', { name: 'Sign in' });
    expect(header().getByRole('link', { name: 'Catalog' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(header().queryByRole('link', { name: 'Admin' })).toBeNull();
  });

  it('hides Admin from a user who is not an administrator', async () => {
    mockApi({ 'GET /auth/session': { session: adminSession({ role: 'user' }) } });
    renderAt('/');
    await header().findByRole('button', { name: 'Sign out' });
    expect(header().queryByRole('link', { name: 'Admin' })).toBeNull();
  });

  it('keeps Catalog current while a VM is managed, and Admin in the Admin area', async () => {
    manage();
    const { router } = renderAt(VM_PATH);
    await screen.findByRole('heading', { level: 1, name: 'Windows 98 SE' });
    const nav = screen.getAllByRole('navigation')[0] as HTMLElement;
    expect(current(nav)).toEqual(['Catalog']);
    await act(() => router.navigate('/admin/repositories'));
    await waitFor(() => expect(current(nav)).toEqual(['Admin']));
  });
});

describe('the Admin sidebar', () => {
  it('shows exactly its five destinations, in order', async () => {
    manage();
    renderAt('/admin/agents');
    const sidebar = await screen.findByRole('navigation', { name: 'Admin' });
    expect(linkNames(sidebar)).toEqual([
      'Agents',
      'Registrations',
      'Repositories',
      'Appearance',
      'Application Updates',
    ]);
    expect(
      within(sidebar)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual([
      '/admin/agents',
      '/admin/registrations',
      '/admin/repositories',
      '/admin/appearance',
      '/admin/updates',
    ]);
    // Never a way into a VM's management.
    expect(within(sidebar).queryByRole('link', { name: /manage|vm/i })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'VM' })).toBeNull();
  });

  it.each([
    ['/admin/agents', 'Agents', 'Agents'],
    ['/admin/agents/018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9001', 'Agents', null],
    ['/admin/registrations', 'Registrations', 'Registrations'],
    ['/admin/repositories', 'Repositories', 'Repositories'],
    ['/admin/appearance', 'Appearance', 'Appearance'],
    ['/admin/updates', 'Application Updates', 'Application Updates'],
  ])('highlights the destination of %s', async (path, label, heading) => {
    manage({
      'GET /admin/registrations': { operations: [], nextCursor: null },
      'GET /admin/repositories': { repositories: [] },
    });
    renderAt(path);
    const sidebar = await screen.findByRole('navigation', { name: 'Admin' });
    await waitFor(() => expect(current(sidebar)).toEqual([label]));
    const link = within(sidebar).getByRole('link', { name: label });
    expect(link.className).toMatch(/\bactive\b/);
    if (heading) {
      expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy();
    }
  });

  it('moves the highlight with the page, and back with the browser', async () => {
    manage();
    const { router } = renderAt('/admin/agents');
    const sidebar = await screen.findByRole('navigation', { name: 'Admin' });
    fireEvent.click(within(sidebar).getByRole('link', { name: 'Appearance' }));
    await screen.findByRole('heading', { level: 1, name: 'Appearance' });
    expect(current(sidebar)).toEqual(['Appearance']);
    await act(() => router.navigate(-1));
    await waitFor(() => expect(current(sidebar)).toEqual(['Agents']));
    await act(() => router.navigate(1));
    await waitFor(() => expect(current(sidebar)).toEqual(['Appearance']));
  });

  it('answers an unknown Admin address with not-found', async () => {
    manage();
    renderAt('/admin/dashboard-of-old');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});

describe('entering a VM’s management from the catalog', () => {
  it('goes from a public VM’s card to its public page, then to Manage', async () => {
    manage({
      'GET /admin/vms': {
        items: [card({ visibility: 'public', publicCover: 'no_main_image' })],
        pagination: { page: 1, pageSize: 24, total: 1, totalPages: 1 },
      },
      'GET /catalog/vms/qemu/Win98': {
        emulatorType: 'qemu',
        vmName: 'Win98',
        displayName: 'Windows 98 SE',
        description: null,
        mainImage: null,
        gallery: [],
        tags: [],
      },
      [`GET ${VM_PATH}`]: adminVm({ visibility: 'public' }),
    });
    renderAt('/');
    fireEvent.click(await screen.findByRole('link', { name: 'Windows 98 SE' }));
    // The public page is still the public page, with the administrator's way on.
    const manageLink = await screen.findByRole('link', { name: 'Manage this VM' });
    expect(location()).toBe('/vms/qemu/Win98');
    expect(screen.queryByRole('navigation', { name: 'VM' })).toBeNull();
    fireEvent.click(manageLink);
    await screen.findByRole('navigation', { name: 'VM' });
    expect(location()).toBe(VM_PATH);
    expect(current(screen.getByRole('navigation', { name: 'VM' }))).toEqual(['General']);
  });

  it('opens a private VM, which has no public page, directly on Manage', async () => {
    manage({
      'GET /admin/vms': {
        items: [card()],
        pagination: { page: 1, pageSize: 24, total: 1, totalPages: 1 },
      },
    });
    renderAt('/');
    fireEvent.click(await screen.findByRole('link', { name: 'Windows 98 SE' }));
    await screen.findByRole('navigation', { name: 'VM' });
    expect(location()).toBe(VM_PATH);
  });
});

describe('the VM’s sidebar', () => {
  it('shows exactly its five sections, the VM it is about, and the way back to the catalog', async () => {
    manage();
    renderAt(VM_PATH);
    const sidebar = await screen.findByRole('navigation', { name: 'VM' });
    expect(linkNames(sidebar)).toEqual([
      'General',
      'Version History',
      'Local copies and restore',
      'Notes',
      'Screenshots',
    ]);
    expect(current(sidebar)).toEqual(['General']);
    const aside = sidebar.closest('aside') as HTMLElement;
    expect(within(aside).getByText('Windows 98 SE')).toBeTruthy();
    expect(within(aside).getByText('Win98')).toBeTruthy();
    expect(within(aside).getByRole('link', { name: 'Back to Catalog' }).getAttribute('href')).toBe(
      '/',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Windows 98 SE' })).toBeTruthy();
    // Never mixed with the Admin sidebar.
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull();
  });

  it.each([
    ['', 'General', 'Run and verify'],
    ['/versions', 'Version History', 'Version History'],
    ['/copies', 'Local copies and restore', 'Local copies and restores'],
    ['/notes', 'Notes', 'Notes'],
    ['/screenshots', 'Screenshots', 'Screenshots'],
  ])('opens %s directly, as after a refresh, on %s', async (suffix, label, heading) => {
    manage();
    const first = renderAt(`${VM_PATH}${suffix}`);
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    expect(current(screen.getByRole('navigation', { name: 'VM' }))).toEqual([label]);
    // A refresh is a new application at the same address.
    first.unmount();
    renderAt(`${VM_PATH}${suffix}`);
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    expect(current(screen.getByRole('navigation', { name: 'VM' }))).toEqual([label]);
  });

  it('keeps the VM while moving between sections, reading it once', async () => {
    const api = manage();
    renderAt(VM_PATH);
    await screen.findByRole('navigation', { name: 'VM' });
    for (const [label, path, heading] of [
      ['Version History', `${VM_PATH}/versions`, 'Version History'],
      ['Local copies and restore', `${VM_PATH}/copies`, 'Local copies and restores'],
      ['Notes', `${VM_PATH}/notes`, 'Notes'],
      ['Screenshots', `${VM_PATH}/screenshots`, 'Screenshots'],
      ['General', VM_PATH, 'Run and verify'],
    ] as const) {
      fireEvent.click(vmSidebar().getByRole('link', { name: label }));
      expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
      expect(location()).toBe(path);
      expect(screen.getByRole('heading', { level: 1, name: 'Windows 98 SE' })).toBeTruthy();
    }
    expect(api.callsTo('GET', VM_PATH)).toHaveLength(1);
  });

  it('follows the browser back and forward through sections', async () => {
    manage();
    const { router } = renderAt(VM_PATH);
    await screen.findByRole('navigation', { name: 'VM' });
    fireEvent.click(vmSidebar().getByRole('link', { name: 'Notes' }));
    await screen.findByRole('heading', { name: 'Notes' });
    fireEvent.click(vmSidebar().getByRole('link', { name: 'Screenshots' }));
    await screen.findByRole('heading', { name: 'Screenshots' });
    await act(() => router.navigate(-1));
    await waitFor(() => expect(location()).toBe(`${VM_PATH}/notes`));
    expect(current(screen.getByRole('navigation', { name: 'VM' }))).toEqual(['Notes']);
    await act(() => router.navigate(-1));
    await waitFor(() => expect(location()).toBe(VM_PATH));
    expect(current(screen.getByRole('navigation', { name: 'VM' }))).toEqual(['General']);
    await act(() => router.navigate(1));
    await waitFor(() => expect(location()).toBe(`${VM_PATH}/notes`));
  });

  it('shows nothing of the previous VM when another one is opened', async () => {
    manage();
    const { router } = renderAt(`${VM_PATH}/notes`);
    await screen.findByRole('heading', { level: 1, name: 'Windows 98 SE' });
    await act(() => router.navigate('/admin/agents'));
    await screen.findByRole('navigation', { name: 'Admin' });
    expect(screen.queryByText('Windows 98 SE')).toBeNull();
    await act(() => router.navigate(`${OTHER_PATH}/notes`));
    expect(await screen.findByRole('heading', { level: 1, name: 'DOS 6.22' })).toBeTruthy();
    expect(screen.queryByText('Windows 98 SE')).toBeNull();
    expect(
      vmSidebar()
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual([
      OTHER_PATH,
      `${OTHER_PATH}/versions`,
      `${OTHER_PATH}/copies`,
      `${OTHER_PATH}/notes`,
      `${OTHER_PATH}/screenshots`,
    ]);
  });

  it('leads an old link to a version on the VM’s page to Version History', async () => {
    manage();
    renderAt(`${VM_PATH}#version-018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9010`);
    await screen.findByRole('heading', { name: 'Version History' });
    expect(location()).toBe(`${VM_PATH}/versions`);
    expect(screen.getByTestId('location-hash').textContent).toBe(
      '#version-018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9010',
    );
  });

  it('answers an unknown section with not-found, inside the VM', async () => {
    manage();
    renderAt(`${VM_PATH}/no-such-section`);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'VM' })).toBeTruthy();
  });

  it('explains a VM that is not registered, with the way back to the catalog', async () => {
    manage({ [`GET ${VM_PATH}`]: apiError(404, 'vm_not_found', 'Not found') });
    renderAt(`${VM_PATH}/notes`);
    expect(
      await screen.findByRole('heading', { name: 'This virtual machine is not registered' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Catalog' }).getAttribute('href')).toBe('/');
    expect(screen.queryByRole('navigation', { name: 'VM' })).toBeNull();
  });

  it('shows the server’s refusal when the session is not allowed to manage', async () => {
    manage({ [`GET ${VM_PATH}`]: apiError(403, 'forbidden', 'Administrators only') });
    renderAt(VM_PATH);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Administrators only/);
    expect(screen.queryByRole('navigation', { name: 'VM' })).toBeNull();
  });
});

describe('the sidebar on a narrow screen', () => {
  it('collapses behind a button that names the menu and the current destination', async () => {
    manage();
    renderAt(`${VM_PATH}/notes`);
    const nav = await screen.findByRole('navigation', { name: 'VM' });
    const toggle = screen.getByRole('button', { name: /VM menu/ });
    expect(toggle.textContent).toMatch(/Notes/);
    expect(toggle.getAttribute('aria-controls')).toBe(nav.id);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Hidden only below the wide layout: every destination is still there.
    expect(nav.className).toMatch(/\bcollapse\b/);
    expect(nav.className).toMatch(/\bd-lg-block\b/);
    expect(nav.className).not.toMatch(/\bshow\b/);
    expect(linkNames(nav)).toHaveLength(5);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(nav.className).toMatch(/\bshow\b/);
    // Choosing a destination closes it.
    fireEvent.click(within(nav).getByRole('link', { name: 'Screenshots' }));
    await screen.findByRole('heading', { name: 'Screenshots' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toMatch(/Screenshots/);
  });

  it('closes with Escape and gives the focus back to its button', async () => {
    manage();
    renderAt('/admin/appearance');
    const toggle = await screen.findByRole('button', { name: /Admin menu/ });
    fireEvent.click(toggle);
    const link = adminSidebar().getByRole('link', { name: 'Agents' });
    link.focus();
    fireEvent.keyDown(link, { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it('closes when the browser goes back', async () => {
    manage();
    const { router } = renderAt('/admin/agents');
    await screen.findByRole('navigation', { name: 'Admin' });
    fireEvent.click(adminSidebar().getByRole('link', { name: 'Appearance' }));
    await screen.findByRole('heading', { level: 1, name: 'Appearance' });
    const toggle = screen.getByRole('button', { name: /Admin menu/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await act(() => router.navigate(-1));
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
  });
});

describe('keyboard use and themes', () => {
  it('makes every destination a real link in reading order, reachable by Tab', async () => {
    manage();
    renderAt(VM_PATH);
    const nav = await screen.findByRole('navigation', { name: 'VM' });
    for (const link of within(nav).getAllByRole('link')) {
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toMatch(/^\/admin\/vms\/qemu\/Win98/);
      expect(link.getAttribute('tabindex')).toBeNull();
    }
    // The menu comes before the content it leads through.
    const heading = screen.getByRole('heading', { level: 1, name: 'Windows 98 SE' });
    expect(nav.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(['light', 'dark'] as const)(
    'keeps the sidebars and their highlight in the %s theme',
    async (theme) => {
      localStorage.setItem('emucat.theme', theme);
      manage();
      renderAt('/admin/appearance');
      const sidebar = await screen.findByRole('navigation', { name: 'Admin' });
      expect(document.documentElement.getAttribute('data-bs-theme')).toBe(theme);
      expect(current(sidebar)).toEqual(['Appearance']);
      expect(
        (
          screen.getByRole('radio', {
            name: theme === 'dark' ? 'Dark' : 'Light',
          }) as HTMLInputElement
        ).checked,
      ).toBe(true);
    },
  );
});
