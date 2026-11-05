import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeNextPath } from '../src/auth';
import {
  adminSession,
  apiError,
  mockApi,
  renderAt,
  Reply,
  resetApiState,
  signedInAsAdmin,
} from './mock-api';

const SUMMARY = {
  vms: { total: 0, public: 0, private: 0 },
  media: { total: 0, published: 0, private: 0 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  resetApiState();
});

const location = () => screen.getByTestId('location').textContent;

function typeCredentials(username: string, password: string) {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
}

describe('navigation by authentication state', () => {
  it('offers only public links to an anonymous visitor', async () => {
    mockApi();
    renderAt('/');
    const nav = screen.getByRole('navigation');
    expect(await within(nav).findByRole('link', { name: 'Sign in' })).toBeTruthy();
    for (const name of ['Dashboard', 'Manage', 'Settings']) {
      expect(within(nav).queryByRole('link', { name })).toBeNull();
    }
    expect(within(nav).queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('offers the administration links to an administrator', async () => {
    mockApi(signedInAsAdmin);
    renderAt('/');
    const nav = screen.getByRole('navigation');
    expect(await within(nav).findByRole('link', { name: 'Dashboard' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Manage' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Ada Admin' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Sign in' })).toBeNull();
  });

  it('does not offer administration links to other users', async () => {
    mockApi({ 'GET /auth/session': { session: adminSession({ role: 'user' }) } });
    renderAt('/');
    const nav = screen.getByRole('navigation');
    expect(await within(nav).findByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Dashboard' })).toBeNull();
  });
});

describe('route protection', () => {
  it.each(['/admin', '/admin/catalog', '/admin/vms/qemu/Win98', '/account', '/settings'])(
    'sends an anonymous visitor from %s to sign in, and remembers where they were going',
    async (path) => {
      const api = mockApi();
      renderAt(path);
      await screen.findByRole('heading', { name: 'Sign in' });
      expect(location()).toBe(`/login?next=${encodeURIComponent(path)}`);
      // Nothing private was requested on the way.
      expect(api.calls.filter((call) => call.path.startsWith('/admin'))).toEqual([]);
    },
  );

  it('keeps the query string when redirecting', async () => {
    mockApi();
    renderAt('/admin/catalog?q=win');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(location()).toBe(`/login?next=${encodeURIComponent('/admin/catalog?q=win')}`);
  });

  it('turns away a signed-in user who is not an administrator', async () => {
    const api = mockApi({ 'GET /auth/session': { session: adminSession({ role: 'user' }) } });
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Administrators only' })).toBeTruthy();
    expect(api.callsTo('GET', '/admin/summary')).toEqual([]);
  });

  it('does not treat an unreachable server as signed out', async () => {
    mockApi({ 'GET /auth/session': new Reply(502, 'Bad gateway') });
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Cannot check your session' })).toBeTruthy();
    expect(location()).toBe('/admin');
  });

  it('retries after the server comes back', async () => {
    let up = false;
    mockApi({
      ...signedInAsAdmin,
      'GET /admin/summary': SUMMARY,
      'GET /auth/session': () => (up ? { session: adminSession() } : new Reply(502, 'Bad gateway')),
    });
    renderAt('/admin');
    await screen.findByRole('heading', { name: 'Cannot check your session' });
    up = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
  });

  it('goes to sign-in as soon as the server says the session is gone', async () => {
    mockApi({
      ...signedInAsAdmin,
      'GET /admin/summary': apiError(401, 'unauthenticated', 'Sign in required'),
    });
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(location()).toBe(`/login?next=${encodeURIComponent('/admin')}`);
  });
});

describe('signing in', () => {
  it('signs in, then goes where the visitor was heading', async () => {
    const api = mockApi({
      'POST /auth/login': adminSession(),
      'GET /admin/catalog': {},
      'GET /admin/summary': SUMMARY,
      'GET /admin/vms': {
        items: [],
        pagination: { page: 1, pageSize: 24, total: 0, totalPages: 0 },
      },
    });
    renderAt('/login?next=%2Fadmin%2Fcatalog');
    await screen.findByRole('heading', { name: 'Sign in' });
    typeCredentials('admin', 'a password');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Manage the catalog' })).toBeTruthy();
    expect(api.callsTo('POST', '/auth/login')[0]?.body).toEqual({
      username: 'admin',
      password: 'a password',
    });
    expect(location()).toBe('/admin/catalog');
  });

  it('goes to the dashboard without a target', async () => {
    mockApi({ 'POST /auth/login': adminSession(), 'GET /admin/summary': SUMMARY });
    renderAt('/login');
    await screen.findByRole('heading', { name: 'Sign in' });
    typeCredentials('admin', 'a password');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
  });

  it('shows the generic message for wrong credentials, and clears the password', async () => {
    mockApi({
      'POST /auth/login': apiError(401, 'invalid_credentials', 'Invalid username or password'),
    });
    renderAt('/login');
    await screen.findByRole('heading', { name: 'Sign in' });
    typeCredentials('admin', 'wrong');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Invalid username or password',
    );
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    expect(location()).toBe('/login');
  });

  it('says how long to wait when rate limited', async () => {
    mockApi({
      'POST /auth/login': apiError(429, 'rate_limited', 'Too many attempts. Try again later.', {
        'retry-after': '600',
      }),
    });
    renderAt('/login');
    await screen.findByRole('heading', { name: 'Sign in' });
    typeCredentials('admin', 'wrong');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('about 10 minutes');
  });

  it('skips the form for someone already signed in', async () => {
    mockApi({ ...signedInAsAdmin, 'GET /admin/summary': SUMMARY });
    renderAt('/login');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
  });

  it('sends a fresh installation to setup', async () => {
    mockApi({ 'GET /setup/status': { setupRequired: true } });
    renderAt('/login');
    expect(await screen.findByRole('heading', { name: 'Welcome to EmuCat' })).toBeTruthy();
    expect(location()).toBe('/setup');
  });

  it.each([
    ['//evil.example', '/admin'],
    ['https://evil.example', '/admin'],
    ['/\\evil.example', '/admin'],
    ['evil', '/admin'],
    ['', '/admin'],
    [null, '/admin'],
    ['/admin/catalog?q=x', '/admin/catalog?q=x'],
    ['/account', '/account'],
  ])('resolves the redirect target %j to %j', (next, expected) => {
    expect(safeNextPath(next)).toBe(expected);
  });
});

describe('signing out', () => {
  it('ends the session and returns to the public catalog', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      'GET /admin/summary': SUMMARY,
      'POST /auth/logout': new Reply(204, null),
    });
    renderAt('/admin');
    await screen.findByRole('heading', { name: 'Dashboard' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Catalog' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy();
    expect(api.callsTo('POST', '/auth/logout')[0]?.headers['x-csrf-token']).toBe('test-csrf-token');
    expect(location()).toBe('/');
  });

  it('forgets the CSRF token', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      'GET /admin/summary': SUMMARY,
      'POST /auth/logout': new Reply(204, null),
      'POST /auth/login': apiError(401, 'invalid_credentials', 'Invalid username or password'),
    });
    renderAt('/admin');
    await screen.findByRole('heading', { name: 'Dashboard' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.click(await screen.findByRole('link', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    typeCredentials('admin', 'x');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');
    expect(api.callsTo('POST', '/auth/login')[0]?.headers['x-csrf-token']).toBeUndefined();
  });

  it('signs out in this browser even if the server cannot be reached', async () => {
    mockApi({ ...signedInAsAdmin, 'GET /admin/summary': SUMMARY });
    renderAt('/admin');
    await screen.findByRole('heading', { name: 'Dashboard' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('first-administrator setup', () => {
  const fill = (values: Record<string, string>) => {
    for (const [label, value] of Object.entries(values)) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
  };
  const VALID = {
    'Setup token': 'the-token',
    Username: 'admin',
    'Display name': 'Ada Admin',
    Password: 'correct horse battery',
    'Confirm password': 'correct horse battery',
  };

  it('creates the administrator and goes to the dashboard', async () => {
    const api = mockApi({
      'GET /setup/status': { setupRequired: true },
      'POST /setup': new Reply(201, adminSession()),
      'GET /admin/summary': SUMMARY,
    });
    renderAt('/setup');
    await screen.findByRole('heading', { name: 'Welcome to EmuCat' });
    fill(VALID);
    fireEvent.click(screen.getByRole('button', { name: 'Create administrator' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    expect(api.callsTo('POST', '/setup')[0]?.body).toEqual({
      setupToken: 'the-token',
      username: 'admin',
      displayName: 'Ada Admin',
      password: 'correct horse battery',
    });
  });

  it('refuses mismatched passwords without calling the server', async () => {
    const api = mockApi({ 'GET /setup/status': { setupRequired: true } });
    renderAt('/setup');
    await screen.findByRole('heading', { name: 'Welcome to EmuCat' });
    fill({ ...VALID, 'Confirm password': 'something else entirely' });
    fireEvent.click(screen.getByRole('button', { name: 'Create administrator' }));
    expect((await screen.findByRole('alert')).textContent).toContain('do not match');
    expect(api.callsTo('POST', '/setup')).toEqual([]);
  });

  it('refuses an invalid username without calling the server', async () => {
    const api = mockApi({ 'GET /setup/status': { setupRequired: true } });
    renderAt('/setup');
    await screen.findByRole('heading', { name: 'Welcome to EmuCat' });
    fill({ ...VALID, Username: 'a b' });
    fireEvent.click(screen.getByRole('button', { name: 'Create administrator' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/letters, digits/);
    expect(api.callsTo('POST', '/setup')).toEqual([]);
  });

  it('reports a wrong setup token', async () => {
    mockApi({
      'GET /setup/status': { setupRequired: true },
      'POST /setup': apiError(403, 'invalid_setup_token', 'Invalid setup token'),
    });
    renderAt('/setup');
    await screen.findByRole('heading', { name: 'Welcome to EmuCat' });
    fill(VALID);
    fireEvent.click(screen.getByRole('button', { name: 'Create administrator' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Invalid setup token');
  });

  it('shows that setup is complete if someone else finishes first', async () => {
    let done = false;
    mockApi({
      'GET /setup/status': () => ({ setupRequired: !done }),
      'POST /setup': () => {
        done = true;
        return apiError(409, 'setup_completed', 'Setup has already been completed');
      },
    });
    renderAt('/setup');
    await screen.findByRole('heading', { name: 'Welcome to EmuCat' });
    fill(VALID);
    fireEvent.click(screen.getByRole('button', { name: 'Create administrator' }));
    expect(await screen.findByRole('heading', { name: 'Setup is complete' })).toBeTruthy();
  });

  it('offers no setup form once it is complete', async () => {
    mockApi();
    renderAt('/setup');
    expect(await screen.findByRole('heading', { name: 'Setup is complete' })).toBeTruthy();
    expect(screen.queryByLabelText('Setup token')).toBeNull();
  });
});

describe('account', () => {
  const session = (id: string, current: boolean) => ({
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-02T00:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    current,
  });
  const CURRENT = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f61';
  const OTHER = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f62';

  it('lists sessions and revokes another one', async () => {
    let list = [session(CURRENT, true), session(OTHER, false)];
    const api = mockApi({
      ...signedInAsAdmin,
      'GET /account/sessions': () => ({ sessions: list }),
      [`DELETE /account/sessions/${OTHER}`]: () => {
        list = [session(CURRENT, true)];
        return new Reply(204, null);
      },
    });
    renderAt('/account');
    expect(await screen.findByText('This browser')).toBeTruthy();
    expect(screen.getByText('Another session')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByText('Another session')).toBeNull());
    expect(api.callsTo('DELETE', `/account/sessions/${OTHER}`)[0]?.headers['x-csrf-token']).toBe(
      'test-csrf-token',
    );
  });

  it('revokes everything else at once', async () => {
    let list = [session(CURRENT, true), session(OTHER, false)];
    mockApi({
      ...signedInAsAdmin,
      'GET /account/sessions': () => ({ sessions: list }),
      'POST /account/sessions/revoke-others': () => {
        list = [session(CURRENT, true)];
        return { revoked: 1 };
      },
    });
    renderAt('/account');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere else' }));
    await waitFor(() => expect(screen.queryByText('Another session')).toBeNull());
    const button = await screen.findByRole('button', { name: 'Sign out everywhere else' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  const fillPassword = (current: string, next: string, confirm: string) => {
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: current } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: confirm } });
  };

  it('changes the password', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      'GET /account/sessions': { sessions: [session(CURRENT, true)] },
      'POST /account/password': { revoked: 0 },
    });
    renderAt('/account');
    await screen.findByText('This browser');
    fillPassword('the old password', 'the new password', 'the new password');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect((await screen.findByRole('status', { name: '' })).textContent).toBeTruthy();
    await screen.findByText(/Password changed/);
    expect(api.callsTo('POST', '/account/password')[0]?.body).toEqual({
      currentPassword: 'the old password',
      newPassword: 'the new password',
    });
  });

  it('stays signed in when the current password is wrong', async () => {
    mockApi({
      ...signedInAsAdmin,
      'GET /account/sessions': { sessions: [session(CURRENT, true)] },
      'POST /account/password': apiError(
        403,
        'invalid_current_password',
        'The current password is not correct',
      ),
    });
    renderAt('/account');
    await screen.findByText('This browser');
    fillPassword('wrong', 'the new password', 'the new password');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect((await screen.findByRole('alert')).textContent).toContain('not correct');
    expect(screen.getByRole('heading', { name: 'Account' })).toBeTruthy();
  });

  it('refuses a mismatched confirmation without calling the server', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      'GET /account/sessions': { sessions: [session(CURRENT, true)] },
    });
    renderAt('/account');
    await screen.findByText('This browser');
    fillPassword('old', 'the new password', 'something different');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await screen.findByRole('alert');
    expect(api.callsTo('POST', '/account/password')).toEqual([]);
  });
});
