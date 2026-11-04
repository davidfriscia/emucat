import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

const READY = { status: 'ready', checks: { database: 'ok', migrations: 'ok' } };
const NOT_READY = { status: 'not_ready', checks: { database: 'failed', migrations: 'skipped' } };
const INFO = {
  name: 'EmuCat',
  version: '1.2.3',
  apiVersion: 'v1',
  protocolVersion: 7,
  emulatorTypes: ['86box', 'qemu'],
};

function respondWith(routes: Record<string, unknown>) {
  const mock = vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((route) => url.endsWith(route));
    if (!key) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(routes[key]));
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  respondWith({ '/ready': READY, '/info': INFO });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

describe('application shell', () => {
  it('shows the brand and the main navigation', async () => {
    renderAt('/');
    expect(screen.getByText('EmuCat')).toBeTruthy();
    const nav = screen.getByRole('navigation');
    expect(within(nav).getByRole('link', { name: 'Catalog' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Sign in' })).toBeTruthy();
    await screen.findByText('API online');
  });

  it('navigates between pages', async () => {
    renderAt('/');
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    await screen.findByText('API online');
  });

  it('opens the collapsed menu', async () => {
    renderAt('/');
    const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await screen.findByText('API online');
  });

  it('shows a not-found page for unknown routes', async () => {
    renderAt('/no/such/page');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    await screen.findByText('API online');
  });
});

describe('API status', () => {
  it('reports online when the API is ready', async () => {
    renderAt('/');
    expect(await screen.findByText('API online')).toBeTruthy();
  });

  it('reports degraded when the API is up but not ready', async () => {
    respondWith({ '/ready': NOT_READY });
    renderAt('/');
    expect(await screen.findByText('API degraded')).toBeTruthy();
  });

  it('reports offline when the API cannot be reached', async () => {
    respondWith({});
    renderAt('/');
    expect(await screen.findByText('API offline')).toBeTruthy();
  });

  it('reports offline when something other than the API answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Bad gateway', { status: 502 })),
    );
    renderAt('/');
    expect(await screen.findByText('API offline')).toBeTruthy();
  });
});

describe('catalog', () => {
  it('shows an honest empty state and does not request VM data', async () => {
    const fetchMock = respondWith({ '/ready': READY });
    renderAt('/');
    expect(screen.getByRole('heading', { name: 'No virtual machines yet' })).toBeTruthy();
    expect(screen.getByText(/not available in this version/)).toBeTruthy();
    await screen.findByText('API online');
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls.every((url) => url.endsWith('/ready'))).toBe(true);
  });
});

describe('login placeholder', () => {
  it('does not pretend to authenticate', async () => {
    renderAt('/login');
    expect(screen.getByText(/Sign-in is not available yet/)).toBeTruthy();
    expect(document.querySelector('input, form')).toBeNull();
    await screen.findByText('API online');
  });
});

describe('settings', () => {
  it('shows information from the server', async () => {
    renderAt('/settings');
    expect(await screen.findByText('1.2.3')).toBeTruthy();
  });

  it('says so when the server information is unavailable', async () => {
    respondWith({});
    renderAt('/settings');
    expect(await screen.findByText('Server information is unavailable.')).toBeTruthy();
  });

  it('changes the theme', async () => {
    renderAt('/settings');
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.getAttribute('data-bs-theme')).toBe('dark');
    await screen.findByText('1.2.3');
  });
});

describe('theme', () => {
  it('follows the system preference by default', async () => {
    renderAt('/');
    expect(document.documentElement.getAttribute('data-bs-theme')).toBe('light');
    await screen.findByText('API online');
  });

  it('cycles through preferences and remembers the choice', async () => {
    renderAt('/');
    const button = screen.getByRole('button', { name: /^Theme: Auto/ });
    fireEvent.click(button);
    expect(document.documentElement.getAttribute('data-bs-theme')).toBe('light');
    expect(localStorage.getItem('emucat.theme')).toBe('light');
    fireEvent.click(button);
    expect(document.documentElement.getAttribute('data-bs-theme')).toBe('dark');
    expect(localStorage.getItem('emucat.theme')).toBe('dark');
    await screen.findByText('API online');
  });

  it('restores a saved preference', async () => {
    localStorage.setItem('emucat.theme', 'dark');
    renderAt('/');
    expect(document.documentElement.getAttribute('data-bs-theme')).toBe('dark');
    await screen.findByText('API online');
  });

  it('ignores an invalid saved preference', async () => {
    localStorage.setItem('emucat.theme', 'neon');
    renderAt('/');
    expect(document.documentElement.getAttribute('data-bs-theme')).toBe('light');
    await screen.findByText('API online');
  });
});
