import type { AgentSummary, RegistrationOperation } from '@emucat/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt, resetApiState, signedInAsAdmin } from './mock-api';
import { registrationOperation } from './registration-fixture';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  resetApiState();
});

const AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6103';

const agent = (overrides: Partial<AgentSummary> = {}): AgentSummary => ({
  id: AGENT_ID,
  name: 'Desk PC',
  platform: 'windows',
  architecture: 'x86_64',
  agentVersion: '0.2.0',
  protocolVersion: 1,
  pairingStatus: 'paired',
  online: true,
  ownerDisplayName: 'Ada Admin',
  pairedAt: '2026-01-31T15:30:00.000Z',
  lastConnectedAt: '2026-01-31T15:30:00.000Z',
  lastSeenAt: '2026-01-31T15:30:00.000Z',
  revokedAt: null,
  ...overrides,
});

function ended(index: number, overrides: Partial<RegistrationOperation> = {}) {
  return {
    ...registrationOperation(),
    id: `018f47a0-7c2b-4f7e-9a3d-${String(100000000000 + index)}`,
    vmName: `Vm${index}`,
    mode: 'copy' as const,
    state: 'succeeded' as const,
    localCopy: 'preserved' as const,
    error: null,
    recovery: null,
    ...overrides,
  };
}

function routes(overrides: Record<string, unknown> = {}) {
  return {
    ...signedInAsAdmin,
    'GET /admin/agents': {
      agents: [agent(), agent({ id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6199', name: 'Attic' })],
    },
    ...overrides,
  };
}

describe('the registration history page', () => {
  it('is in the administration menu', async () => {
    mockApi(routes({ 'GET /admin/registrations': { operations: [], nextCursor: null } }));
    renderAt('/');
    const link = await screen.findByRole('link', { name: 'Registrations' });
    expect(link.getAttribute('href')).toBe('/admin/registrations');
  });

  it('shows one page at a time, from the server, and pages with its cursors', async () => {
    const pages: Record<
      string,
      { operations: RegistrationOperation[]; nextCursor: string | null }
    > = {
      first: { operations: [ended(1), ended(2)], nextCursor: 'cursor-2' },
      'cursor-2': { operations: [ended(3)], nextCursor: null },
    };
    const api = mockApi(
      routes({
        'GET /admin/registrations': (call: { query: URLSearchParams }) =>
          pages[call.query.get('cursor') ?? 'first'],
      }),
    );
    renderAt('/admin/registrations');
    expect(await screen.findByText('Vm1')).toBeTruthy();
    expect(screen.getByText('Page 1')).toBeTruthy();
    const newer = screen.getByRole('button', { name: 'Newer' }) as HTMLButtonElement;
    expect(newer.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    expect(await screen.findByText('Vm3')).toBeTruthy();
    expect(screen.queryByText('Vm1')).toBeNull();
    expect((screen.getByRole('button', { name: 'Older' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Newer' }));
    expect(await screen.findByText('Vm1')).toBeTruthy();

    const calls = api.callsTo('GET', '/admin/registrations');
    expect(calls.every((call) => call.query.get('limit') === '25')).toBe(true);
    expect(calls.map((call) => call.query.get('cursor'))).toEqual([null, 'cursor-2', null]);
  });

  it('sends every filter to the server, and starts again from the newest when one changes', async () => {
    const api = mockApi(
      routes({
        'GET /admin/registrations': { operations: [ended(1)], nextCursor: 'more' },
      }),
    );
    renderAt(`/admin/registrations?agentId=${AGENT_ID}`);
    expect(await screen.findByText('Vm1')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the agent' })).toBeTruthy();
    expect(
      (screen.getByRole('combobox', { name: 'Filter by agent' }) as HTMLSelectElement).value,
    ).toBe(AGENT_ID);
    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(() =>
      expect(api.callsTo('GET', '/admin/registrations').at(-1)?.query.get('cursor')).toBe('more'),
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), {
      target: { value: 'failed' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by mode' }), {
      target: { value: 'snapshot' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by emulator' }), {
      target: { value: '86box' },
    });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-10' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by VM name' }), {
      target: { value: 'dos' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() =>
      expect(api.callsTo('GET', '/admin/registrations').at(-1)?.query.get('q')).toBe('dos'),
    );
    const query = api.callsTo('GET', '/admin/registrations').at(-1)?.query as URLSearchParams;
    expect(Object.fromEntries(query)).toEqual({
      view: 'all',
      agentId: AGENT_ID,
      emulatorType: '86box',
      mode: 'snapshot',
      q: 'dos',
      state: 'failed',
      createdFrom: new Date(2026, 10, 1).toISOString(),
      createdBefore: new Date(2026, 10, 11).toISOString(),
      limit: '25',
    });
    expect(screen.getByTestId('location').textContent).toMatch(/status=failed/);
  });

  it('shows what needs attention, with how many there are', async () => {
    const api = mockApi(
      routes({
        'GET /admin/registrations': {
          operations: [registrationOperation()],
          nextCursor: null,
          total: 1,
        },
      }),
    );
    renderAt(`/admin/registrations?agentId=${AGENT_ID}&status=attention`);
    expect(await screen.findByText('1 registration needs attention.')).toBeTruthy();
    const row = screen.getByText('Win98').closest('tr') as HTMLElement;
    expect(within(row).getByText('Needs attention')).toBeTruthy();
    expect(api.callsTo('GET', '/admin/registrations')[0]?.query.get('view')).toBe('attention');
  });

  it('opens an operation’s details, with its error and what to do', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': {
          operations: [
            ended(1, {
              mode: 'snapshot',
              state: 'failed',
              parentVersionId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6101',
              snapshotName: 'Vm1 2026-11-10',
              error: { code: 'snapshot_lineage_unverified', message: 'Lineage is not proven' },
              recovery: 'Verify the local copy, and try again.',
            }),
          ],
          nextCursor: null,
        },
      }),
    );
    renderAt('/admin/registrations');
    const row = (await screen.findByText('Vm1')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Snapshot')).toBeTruthy();
    expect(within(row).getByText('Failed')).toBeTruthy();
    expect(within(row).getByText('None')).toBeTruthy();
    expect(within(row).getByText('Desk PC')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: /^Details of the snapshot of Vm1/ }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Registration details' }));
    expect(dialog.getByRole('alert').textContent).toMatch(/Lineage is not proven/);
    expect(dialog.getByRole('alert').textContent).toMatch(/Verify the local copy/);
    expect(dialog.getByText(/No snapshot was created/)).toBeTruthy();
  });

  it('tells an empty history from a filter that matches nothing', async () => {
    mockApi(routes({ 'GET /admin/registrations': { operations: [], nextCursor: null } }));
    const { unmount } = renderAt('/admin/registrations');
    expect(await screen.findByRole('heading', { name: 'No registrations yet' })).toBeTruthy();
    unmount();

    mockApi(routes({ 'GET /admin/registrations': { operations: [], nextCursor: null } }));
    renderAt('/admin/registrations?status=failed');
    expect(await screen.findByRole('heading', { name: 'Nothing matches' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('heading', { name: 'No registrations yet' })).toBeTruthy();
  });

  it('says when the history cannot be loaded', async () => {
    mockApi(routes());
    renderAt('/admin/registrations');
    expect(
      await screen.findByRole('heading', { name: 'The registrations could not be loaded' }),
    ).toBeTruthy();
  });
});
