import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt, resetApiState, signedInAsAdmin } from './mock-api';

const NOT_READY = { status: 'not_ready', checks: { database: 'failed', migrations: 'skipped' } };
const INFO = {
  name: 'EmuCat',
  version: '1.2.3',
  apiVersion: 'v1',
  protocolVersion: 7,
  emulatorTypes: ['86box', 'qemu'],
};

beforeEach(() => {
  mockApi({ 'GET /info': INFO });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  resetApiState();
});

describe('application shell', () => {
  it('shows the brand and the public navigation', async () => {
    renderAt('/');
    expect(screen.getByText('EmuCat')).toBeTruthy();
    const nav = screen.getByRole('navigation');
    expect(within(nav).getByRole('link', { name: 'Catalog' })).toBeTruthy();
    expect(await within(nav).findByRole('link', { name: 'Sign in' })).toBeTruthy();
    await screen.findByText('API online');
  });

  it('navigates between pages', async () => {
    mockApi({ ...signedInAsAdmin, 'GET /info': INFO });
    renderAt('/');
    fireEvent.click(await screen.findByRole('link', { name: 'Settings' }));
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
    mockApi({ 'GET /ready': NOT_READY });
    renderAt('/');
    expect(await screen.findByText('API degraded')).toBeTruthy();
  });

  it('reports offline when the API cannot be reached', async () => {
    mockApi({}, { defaults: false });
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

describe('settings', () => {
  beforeEach(() => {
    mockApi({ ...signedInAsAdmin, 'GET /info': INFO });
  });

  it('shows information from the server', async () => {
    renderAt('/settings');
    expect(await screen.findByText('1.2.3')).toBeTruthy();
  });

  it('says so when the server information is unavailable', async () => {
    mockApi(signedInAsAdmin);
    renderAt('/settings');
    expect(await screen.findByText('Server information is unavailable.')).toBeTruthy();
  });

  it('changes the theme', async () => {
    renderAt('/settings');
    fireEvent.click(await screen.findByRole('radio', { name: 'Dark' }));
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

  it('follows a dark system preference, including when it changes', async () => {
    const listeners: (() => void)[] = [];
    const media = {
      matches: true,
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
      removeEventListener: () => undefined,
    };
    vi.stubGlobal('matchMedia', () => media);
    renderAt('/');
    expect(document.documentElement.getAttribute('data-bs-theme')).toBe('dark');
    media.matches = false;
    listeners.forEach((listener) => listener());
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
