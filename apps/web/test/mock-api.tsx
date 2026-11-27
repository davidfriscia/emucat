import { render } from '@testing-library/react';
import type { AdminMedia, AdminVmDetail, AuthenticatedSession } from '@emucat/contracts';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { vi } from 'vitest';
import { App } from '../src/App';
import { setCsrfToken, setSessionLostHandler } from '../src/api';

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {}
}

export function apiError(status: number, code: string, message: string, headers = {}) {
  return new Reply(status, { error: { code, message, requestId: 'test-request' } }, headers);
}

type Handler = unknown | ((call: RecordedCall) => unknown | Promise<unknown>);

const DEFAULTS: Record<string, Handler> = {
  'GET /ready': { status: 'ready', checks: { database: 'ok', migrations: 'ok' } },
  'GET /auth/session': { session: null },
  'GET /setup/status': { setupRequired: false },
  'GET /catalog/vms': emptyPage(),
};

const OPERATIONS_PATH = /^\/admin\/vms\/[^/]+\/[^/]+\/operations$/;

/** A VM with no operation to show. */
export function noOperations() {
  return { operations: [], retentionHours: 24, serverTime: '2026-11-27T12:00:00.000Z' };
}

export function emptyPage() {
  return { items: [], pagination: { page: 1, pageSize: 24, total: 0, totalPages: 0 } };
}

/** A stand-in for the API. `Reply` sets a status. A route that is not listed cannot be reached. */
export function mockApi(routes: Record<string, Handler> = {}, { defaults = true } = {}) {
  const table = { ...(defaults ? DEFAULTS : {}), ...routes };
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://emucat.test');
    const path = url.pathname.replace('/api/v1', '');
    const method = init.method ?? 'GET';
    const call: RecordedCall = {
      method,
      path: decodeURI(path),
      query: url.searchParams,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const key = `${method} ${call.path}`;
    // Every VM's management follows its operations (decision 0060). Unless a test says otherwise, there are none.
    if (!(key in table) && method === 'GET' && OPERATIONS_PATH.test(call.path)) {
      return new Response(JSON.stringify(noOperations()));
    }
    if (!(key in table)) throw new TypeError('Failed to fetch');
    const handler = table[key];
    const result = await (typeof handler === 'function' ? handler(call) : handler);
    // A test that needs bytes or particular headers answers with a Response of its own.
    if (result instanceof Response) return result;
    if (result instanceof Reply) {
      return new Response(result.status === 204 ? null : JSON.stringify(result.body), {
        status: result.status,
        headers: result.headers,
      });
    }
    return new Response(JSON.stringify(result));
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    routes: table,
    callsTo: (method: string, path: string) =>
      calls.filter((call) => call.method === method && call.path === path),
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

/** The probe shows the hash too, when there is one, so that a test can tell where a link to a version leads. */
function HashProbe() {
  const { hash } = useLocation();
  return <span data-testid="location-hash">{hash}</span>;
}

/** The application at `path`, under a data router as in production (src/main.tsx). */
export function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            <App />
            <LocationProbe />
            <HashProbe />
          </>
        ),
      },
    ],
    { initialEntries: [path] },
  );
  const result = render(<RouterProvider router={router} />);
  return Object.assign(result, { router });
}

export function resetApiState() {
  setCsrfToken(null);
  setSessionLostHandler(null);
}

const FUTURE = '2030-01-01T00:00:00.000Z';
const PAST = '2026-01-01T00:00:00.000Z';

export function adminSession(overrides: Partial<AuthenticatedSession['user']> = {}) {
  return {
    user: {
      id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60',
      username: 'admin',
      displayName: 'Ada Admin',
      role: 'admin',
      ...overrides,
    },
    csrfToken: 'test-csrf-token',
    sessionId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f61',
    expiresAt: FUTURE,
  } satisfies AuthenticatedSession;
}

export const signedInAsAdmin = { 'GET /auth/session': { session: adminSession() } };

export const MEDIA_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f70';
export const OTHER_MEDIA_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f71';

export function adminVm(overrides: Partial<AdminVmDetail> = {}): AdminVmDetail {
  return {
    emulatorType: 'qemu',
    vmName: 'Win98',
    displayName: 'Windows 98 SE',
    description: 'A retro machine',
    visibility: 'private',
    mainMediaId: null,
    publicCover: 'vm_private',
    mediaCount: 0,
    versionCount: 1,
    tags: [],
    clonedFrom: null,
    createdAt: PAST,
    updatedAt: PAST,
    ...overrides,
  };
}

export function adminMedia(overrides: Partial<AdminMedia> = {}): AdminMedia {
  return {
    id: MEDIA_ID,
    isMain: false,
    originalFilename: 'boot.png',
    originalSizeBytes: 2048,
    widthPx: 640,
    heightPx: 480,
    capturedAt: null,
    createdAt: PAST,
    shownAsPublicMain: false,
    tags: [],
    ...overrides,
  };
}
