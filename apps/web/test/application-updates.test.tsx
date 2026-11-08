import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  ApplicationUpdatesResponse,
  DeploymentStatus,
  UpdateOperation,
} from '@emucat/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECONNECT_GIVE_UP_MS } from '../src/components/ApplicationUpdates';
import { adminSession, apiError, mockApi, renderAt, signedInAsAdmin } from './mock-api';

const CURRENT = 'a'.repeat(40);
const LATEST = 'b'.repeat(40);
const OPERATION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7401';
const PAST = '2026-11-01T10:00:00.000Z';
const INFO = {
  name: 'EmuCat',
  version: '0.1.0',
  apiVersion: 'v1',
  protocolVersion: 1,
  emulatorTypes: ['86box', 'qemu'],
};

function deployment(overrides: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    environment: 'test',
    branch: 'develop',
    updatesEnabled: true,
    current: { commit: CURRENT, deployedAt: PAST, operationId: null },
    latest: { commit: LATEST, subject: 'Add the thing', committedAt: null, checkedAt: PAST },
    updateAvailable: true,
    activeOperation: null,
    lastOperation: null,
    lastSuccess: null,
    lastFailure: null,
    ...overrides,
  };
}

function updates(overrides: Partial<DeploymentStatus> = {}): ApplicationUpdatesResponse {
  return {
    service: 'connected',
    build: { version: '0.1.0', commit: CURRENT, builtAt: PAST },
    deployment: deployment(overrides),
  };
}

function operation(overrides: Partial<UpdateOperation> = {}): UpdateOperation {
  return {
    id: OPERATION_ID,
    status: 'running',
    stage: 'building',
    stages: [
      { stage: 'checking_repository', startedAt: PAST, message: null },
      { stage: 'fetching_source', startedAt: PAST, message: null },
      { stage: 'building', startedAt: PAST, message: null },
    ],
    fromCommit: CURRENT,
    targetCommit: LATEST,
    requestedBy: 'admin',
    requestedAt: PAST,
    finishedAt: null,
    outcome: null,
    error: null,
    rollback: null,
    backup: null,
    ...overrides,
  };
}

const UPDATES = 'GET /admin/system/updates';

async function openSettings(routes: Record<string, unknown>) {
  const api = mockApi({ ...signedInAsAdmin, 'GET /info': INFO, ...routes });
  renderAt('/settings');
  await screen.findByRole('heading', { name: 'Application updates' });
  return api;
}

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('Application updates', () => {
  it('is not shown to users who are not administrators', async () => {
    mockApi({
      'GET /auth/session': { session: adminSession({ role: 'user' }) },
      'GET /info': INFO,
    });
    renderAt('/settings');
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByRole('heading', { name: 'Application updates' })).toBeNull();
  });

  it('shows the deployed version, the branch and what is available', async () => {
    await openSettings({ [UPDATES]: updates() });
    const facts = await screen.findByText('Deployed commit');
    const list = facts.closest('dl') as HTMLElement;
    expect(within(list).getByText('test')).toBeTruthy();
    expect(within(list).getByText('develop')).toBeTruthy();
    expect(within(list).getByTitle(CURRENT).textContent).toBe(CURRENT.slice(0, 12));
    expect(within(list).getByTitle(LATEST)).toBeTruthy();
    expect(within(list).getByText('Add the thing')).toBeTruthy();
    expect(screen.getByTestId('update-availability').textContent).toBe('Available');
    expect(within(list).getByText('Connected')).toBeTruthy();
  });

  it('checks for updates on request', async () => {
    const api = await openSettings({
      [UPDATES]: updates({ latest: null, updateAvailable: null }),
      'POST /admin/system/updates/check': updates({
        updateAvailable: false,
        latest: {
          commit: CURRENT,
          subject: 'Same',
          committedAt: null,
          checkedAt: PAST,
        },
      }),
    });
    expect((await screen.findByTestId('update-availability')).textContent).toBe('Unknown');
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await waitFor(() =>
      expect(screen.getByTestId('update-availability').textContent).toBe('Up to date'),
    );
    expect(api.callsTo('POST', '/admin/system/updates/check')).toHaveLength(1);
    expect(
      (screen.getByRole('button', { name: 'Install update' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('asks for confirmation, then installs exactly the commit shown', async () => {
    const api = await openSettings({
      [UPDATES]: updates(),
      'POST /admin/system/updates': operation({ stage: 'queued', stages: [] }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Install update' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm update' });
    expect(dialog.textContent).toMatch(/may be unavailable/);
    expect(api.callsTo('POST', '/admin/system/updates')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install now' }));
    await waitFor(() => expect(api.callsTo('POST', '/admin/system/updates')).toHaveLength(1));
    expect(api.callsTo('POST', '/admin/system/updates')[0]?.body).toEqual({
      expectedCommit: LATEST,
    });
    expect(api.callsTo('POST', '/admin/system/updates')[0]?.headers['x-csrf-token']).toBe(
      'test-csrf-token',
    );
  });

  it('can be cancelled at the confirmation', async () => {
    const api = await openSettings({ [UPDATES]: updates() });
    fireEvent.click(await screen.findByRole('button', { name: 'Install update' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.callsTo('POST', '/admin/system/updates')).toHaveLength(0);
  });

  it('shows the progress of a running update, including after a page refresh', async () => {
    await openSettings({
      [UPDATES]: updates({ activeOperation: operation(), lastOperation: operation() }),
    });
    const progress = await screen.findByRole('list', { name: 'Update progress' });
    const item = (label: string) =>
      within(progress).getByText(label).closest('li')?.getAttribute('data-state');
    expect(item('Fetching source')).toBe('done');
    expect(item('Building')).toBe('current');
    expect(item('Applying migrations')).toBe('pending');
    expect(
      (screen.getByRole('button', { name: 'Install update' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Building \(started by admin\)/)).toBeTruthy();
  });

  it('shows a failure with its reason, the rollback state and the backup', async () => {
    const failed = operation({
      status: 'failed',
      stage: 'failed',
      stages: [
        ...operation().stages,
        { stage: 'testing', startedAt: PAST, message: null },
        { stage: 'backing_up_database', startedAt: PAST, message: null },
        { stage: 'applying_migrations', startedAt: PAST, message: null },
        { stage: 'failed', startedAt: PAST, message: 'Database migrations failed' },
      ],
      error: { code: 'migration_failed', message: 'Database migrations failed.' },
      rollback: 'unsafe',
      backup: 'emucat-db-20261101T100000Z-aaaaaaaaaaaa.sql.gz',
      finishedAt: PAST,
    });
    localStorage.setItem('emucat.update.watching', OPERATION_ID);
    await openSettings({ [UPDATES]: updates({ lastOperation: failed }) });
    const alert = await screen.findByText('The update failed.');
    const box = alert.closest('.alert') as HTMLElement;
    expect(box.textContent).toMatch(/Database migrations failed\./);
    expect(box.textContent).toMatch(/was not restarted automatically/);
    expect(box.textContent).toMatch(/emucat-db-20261101T100000Z-aaaaaaaaaaaa\.sql\.gz/);
    const progress = screen.getByRole('list', { name: 'Update progress' });
    expect(within(progress).getByText('Applying migrations').closest('li')?.dataset.state).toBe(
      'failed',
    );
  });

  it('keeps following an update while the application restarts, then shows the real result', async () => {
    let phase: 'running' | 'down' | 'done' = 'running';
    await openSettings({
      [UPDATES]: () => {
        if (phase === 'down') return apiError(502, 'unreachable', 'Bad gateway');
        if (phase === 'running') {
          return updates({ activeOperation: operation(), lastOperation: operation() });
        }
        const done = operation({
          status: 'succeeded',
          stage: 'completed',
          outcome: 'updated',
          finishedAt: PAST,
        });
        return updates({
          current: { commit: LATEST, deployedAt: PAST, operationId: OPERATION_ID },
          updateAvailable: false,
          lastOperation: done,
          lastSuccess: {
            operationId: OPERATION_ID,
            commit: LATEST,
            finishedAt: PAST,
            message: null,
          },
        });
      },
    });
    await screen.findByRole('list', { name: 'Update progress' });
    phase = 'down';
    await screen.findByText(/restarting as part of the update/, {}, { timeout: 5_000 });
    phase = 'done';
    await screen.findByText(/Update completed/, {}, { timeout: 5_000 });
    expect(screen.queryByText(/restarting as part of the update/)).toBeNull();
  }, 20_000);

  it('says plainly when the server never comes back, instead of claiming success', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem('emucat.update.watching', OPERATION_ID);
    mockApi({
      ...signedInAsAdmin,
      'GET /info': INFO,
      [UPDATES]: () => apiError(502, 'unreachable', 'Bad gateway'),
    });
    renderAt('/settings');
    await screen.findByRole('heading', { name: 'Application updates' });
    // Refreshed during an update: the server is restarting.
    await screen.findByText(/restarting as part of the update/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_GIVE_UP_MS + 10_000);
    });
    expect(
      await screen.findByText(/Its outcome is unknown: do not assume it succeeded/),
    ).toBeTruthy();
    expect(screen.queryByText(/Update completed/)).toBeNull();
  });

  it('explains when the deployment service does not answer', async () => {
    await openSettings({ [UPDATES]: { ...updates(), service: 'unavailable', deployment: null } });
    expect(await screen.findByText(/deployment service is not answering/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Install update' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Check for updates' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText('Unavailable')).toBeTruthy();
  });

  it('shows that updates are disabled on this server, such as production', async () => {
    await openSettings({
      [UPDATES]: updates({ environment: 'production', branch: 'main', updatesEnabled: false }),
    });
    expect(
      await screen.findByText(/Updates from the browser are disabled on this server/),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Install update' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows an error from the server when starting fails', async () => {
    await openSettings({
      [UPDATES]: updates(),
      'POST /admin/system/updates': apiError(
        409,
        'target_changed',
        'The branch has changed since it was checked. Check for updates again.',
      ),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Install update' }));
    fireEvent.click(screen.getByRole('button', { name: 'Install now' }));
    expect(await screen.findByText(/branch has changed since it was checked/)).toBeTruthy();
  });

  it('shows the update log on request', async () => {
    await openSettings({
      [UPDATES]: updates({ lastOperation: operation({ status: 'succeeded', stage: 'completed' }) }),
      [`GET /admin/system/updates/${OPERATION_ID}/log`]: {
        operationId: OPERATION_ID,
        lines: ['==> building', 'DB_PASSWORD=[redacted]'],
        truncated: false,
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'View update log' }));
    const log = await screen.findByLabelText('Update log');
    expect(log.textContent).toContain('==> building');
    expect(log.textContent).toContain('[redacted]');
  });

  it('explains when this server has no deployment service', async () => {
    await openSettings({
      [UPDATES]: {
        service: 'not_configured',
        build: { version: '0.1.0', commit: null, builtAt: null },
        deployment: null,
      },
    });
    expect(await screen.findByText(/not configured on this server/)).toBeTruthy();
  });
});
