import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  ExecutionAgentOption,
  ExecutionOptionsResponse,
  VmSession,
  VmVerification,
} from '@emucat/contracts';
import { describe, expect, it } from 'vitest';
import { adminVm, apiError, emptyPage, mockApi, renderAt, signedInAsAdmin } from './mock-api';

const disabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled;
const VM_PATH = '/admin/vms/qemu/Win98';
const OPTIONS_PATH = `${VM_PATH}/execution-options`;
const AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7001';
const VERSION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7003';
const SESSION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7005';
const VERIFICATION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7006';
const PAST = '2026-01-01T00:00:00.000Z';

const MODES: ExecutionOptionsResponse['modes'] = [
  { mode: 'local', available: true, reason: null },
  {
    mode: 'remote_volatile',
    available: false,
    reason: 'Remote volatile sessions need a remote display.',
  },
  {
    mode: 'remote_snapshot',
    available: false,
    reason: 'Remote snapshot sessions are planned for Milestone 7.',
  },
];

function session(overrides: Partial<VmSession> = {}): VmSession {
  return {
    id: SESSION_ID,
    agentId: AGENT_ID,
    agentName: 'Study PC',
    agentOnline: true,
    emulatorType: 'qemu',
    vmName: 'Win98',
    mode: 'local',
    state: 'running',
    versionId: VERSION_ID,
    workspaceId: null,
    pid: 4242,
    processStartedAt: PAST,
    requestedAt: PAST,
    startedAt: PAST,
    endedAt: null,
    exitCode: null,
    stopRequested: false,
    forceRequested: false,
    gracefulStopAvailable: true,
    error: null,
    recovery: null,
    requestedByDisplayName: 'Ada Admin',
    updatedAt: PAST,
    ...overrides,
  };
}

function verification(overrides: Partial<VmVerification> = {}): VmVerification {
  const none = { count: 0, paths: [] };
  return {
    id: VERIFICATION_ID,
    agentId: AGENT_ID,
    agentName: 'Study PC',
    emulatorType: 'qemu',
    vmName: 'Win98',
    versionId: VERSION_ID,
    state: 'completed',
    status: 'verified',
    filesVerified: 3,
    bytesHashed: 4096,
    durationMs: 1200,
    missing: none,
    modified: none,
    unexpected: none,
    manifestSha256: 'a'.repeat(64),
    manifestSource: 'local',
    error: null,
    recovery: null,
    requestedByDisplayName: 'Ada Admin',
    requestedAt: PAST,
    completedAt: PAST,
    ...overrides,
  };
}

function agent(overrides: Partial<ExecutionAgentOption> = {}): ExecutionAgentOption {
  return {
    agentId: AGENT_ID,
    agentName: 'Study PC',
    online: true,
    launch: { eligible: true, reason: null, problem: null },
    verify: { eligible: true, reason: null },
    local: {
      present: true,
      contentStatus: 'unverified',
      sourceVersionId: VERSION_ID,
      lastVerifiedAt: null,
    },
    activeSession: null,
    lastSession: null,
    lastVerification: null,
    ...overrides,
  };
}

function base(routes: Record<string, unknown> = {}) {
  return mockApi({
    ...signedInAsAdmin,
    [`GET ${VM_PATH}`]: adminVm(),
    [`GET ${VM_PATH}/media`]: { media: [] },
    [`GET ${VM_PATH}/restore-options`]: { master: null, versions: [], agents: [] },
    'GET /admin/restores': { operations: [] },
    [`GET ${OPTIONS_PATH}`]: { modes: MODES, agents: [agent()] },
    'GET /admin/sessions': { sessions: [] },
    ...routes,
  });
}

async function section() {
  renderAt(VM_PATH);
  const heading = await screen.findByRole('heading', { name: 'Run and verify' });
  return within(heading.closest('section') as HTMLElement);
}

describe('launching', () => {
  it('offers local execution, and shows each remote mode as unavailable with its reason', async () => {
    base();
    const view = await section();
    expect(((await view.findByRole('radio', { name: 'Local' })) as HTMLInputElement).checked).toBe(
      true,
    );
    const volatile = view.getByRole('radio', { name: 'Remote volatile (not available)' });
    expect(disabled(volatile)).toBe(true);
    expect(disabled(view.getByRole('radio', { name: 'Remote snapshot (not available)' }))).toBe(
      true,
    );
    expect(view.getByText(/planned for Milestone 7/)).toBeTruthy();
  });

  it('sends only the agent, the VM, the mode and a request ID', async () => {
    const api = base({ 'POST /admin/sessions': session({ state: 'requested', pid: null }) });
    const view = await section();
    fireEvent.click(await view.findByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(api.callsTo('POST', '/admin/sessions')).toHaveLength(1));
    const body = api.callsTo('POST', '/admin/sessions')[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['agentId', 'emulatorType', 'mode', 'requestId', 'vmName'].sort(),
    );
    expect(body).toMatchObject({
      agentId: AGENT_ID,
      emulatorType: 'qemu',
      vmName: 'Win98',
      mode: 'local',
    });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('retries a failed launch with the same request ID, so it cannot start two', async () => {
    const api = base({ 'POST /admin/sessions': apiError(503, 'unavailable', 'Try again') });
    const view = await section();
    const button = await view.findByRole('button', { name: 'Launch' });
    fireEvent.click(button);
    await view.findByText('Try again');
    fireEvent.click(button);
    await waitFor(() => expect(api.callsTo('POST', '/admin/sessions')).toHaveLength(2));
    const [first, second] = api.callsTo('POST', '/admin/sessions');
    expect((first?.body as { requestId: string }).requestId).toBe(
      (second?.body as { requestId: string }).requestId,
    );
  });

  it('says why it cannot launch, and disables the button', async () => {
    base({
      [`GET ${OPTIONS_PATH}`]: {
        modes: MODES,
        agents: [
          agent({
            launch: {
              eligible: false,
              reason: 'emulator_not_launchable',
              problem: 'The executable is not 86Box.exe.',
            },
          }),
        ],
      },
    });
    const view = await section();
    expect(disabled(await view.findByRole('button', { name: 'Launch' }))).toBe(true);
    expect(view.getByText(/it cannot launch this emulator/)).toBeTruthy();
    expect(view.getByText('The executable is not 86Box.exe.')).toBeTruthy();
  });
});

describe('a running session', () => {
  const running = { modes: MODES, agents: [agent({ activeSession: session() })] };

  it('shows its process and stops it gracefully by default', async () => {
    const api = base({
      [`GET ${OPTIONS_PATH}`]: running,
      [`POST /admin/sessions/${SESSION_ID}/stop`]: session({ stopRequested: true }),
    });
    const view = await section();
    expect(await view.findByText(/PID 4242/)).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Stop' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/sessions/${SESSION_ID}/stop`)[0]?.body).toEqual({
        force: false,
      }),
    );
  });

  it('forces a stop only once the VM’s name is typed', async () => {
    const api = base({
      [`GET ${OPTIONS_PATH}`]: running,
      [`POST /admin/sessions/${SESSION_ID}/stop`]: session({ forceRequested: true }),
    });
    const view = await section();
    fireEvent.click(await view.findByRole('button', { name: 'Force stop…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Force Win98 to stop' }));
    const confirm = dialog.getByRole('button', { name: 'Force stop' });
    expect(disabled(confirm)).toBe(true);
    fireEvent.change(dialog.getByLabelText(/to confirm/), { target: { value: 'Win95' } });
    expect(disabled(confirm)).toBe(true);
    fireEvent.change(dialog.getByLabelText(/to confirm/), { target: { value: 'win98' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/sessions/${SESSION_ID}/stop`)[0]?.body).toEqual({
        force: true,
        confirmVmName: 'win98',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers dismissal, not a stop, when the agent cannot tell', async () => {
    const api = base({
      [`GET ${OPTIONS_PATH}`]: {
        modes: MODES,
        agents: [
          agent({
            activeSession: session({
              state: 'unknown',
              error: { code: 'process_state_unknown', message: 'Cannot tell.' },
              recovery: 'Check that computer, then dismiss the session.',
            }),
          }),
        ],
      },
      [`POST /admin/sessions/${SESSION_ID}/dismiss`]: session({ state: 'interrupted' }),
    });
    const view = await section();
    expect(await view.findByText('Check that computer, then dismiss the session.')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Stop' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Dismiss…' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(/to confirm/), { target: { value: 'Win98' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/sessions/${SESSION_ID}/dismiss`)[0]?.body).toEqual({
        confirmVmName: 'Win98',
      }),
    );
  });

  it('shows the history', async () => {
    base({
      'GET /admin/sessions': {
        sessions: [session({ state: 'exited', endedAt: PAST, exitCode: 0 })],
      },
    });
    const view = await section();
    const table = await view.findByRole('table');
    expect(within(table).getByText('Exited')).toBeTruthy();
    expect(within(table).getByText(/exit 0/)).toBeTruthy();
  });
});

describe('verifying', () => {
  it('starts a verification and shows a modified copy with its paths', async () => {
    const api = base({
      [`GET ${OPTIONS_PATH}`]: {
        modes: MODES,
        agents: [
          agent({
            lastVerification: verification({
              status: 'modified',
              modified: { count: 3, paths: ['disk.qcow2', 'nvram.bin'] },
            }),
          }),
        ],
      },
      'POST /admin/verifications': verification({ state: 'requested', status: null }),
    });
    const view = await section();
    expect(await view.findByText('Modified: differs from the master')).toBeTruthy();
    expect(view.getByText('disk.qcow2')).toBeTruthy();
    expect(view.getByText('and 1 more')).toBeTruthy();
    expect(view.getByText(/Screenshots are not part of the check/)).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Verify local copy' }));
    await waitFor(() =>
      expect(api.callsTo('POST', '/admin/verifications')[0]?.body).toEqual({
        agentId: AGENT_ID,
        emulatorType: 'qemu',
        vmName: 'Win98',
      }),
    );
  });

  it('cannot verify a running VM', async () => {
    base({
      [`GET ${OPTIONS_PATH}`]: {
        modes: MODES,
        agents: [
          agent({
            activeSession: session(),
            verify: { eligible: false, reason: 'session_active' },
            launch: { eligible: false, reason: 'session_active', problem: null },
          }),
        ],
      },
    });
    const view = await section();
    expect(disabled(await view.findByRole('button', { name: 'Verify local copy' }))).toBe(true);
    expect(disabled(view.getByRole('button', { name: 'Launch' }))).toBe(true);
  });
});

describe('the catalog', () => {
  it('marks a running VM for administrators', async () => {
    const page = emptyPage();
    mockApi({
      ...signedInAsAdmin,
      'GET /admin/vms': {
        ...page,
        items: [
          {
            emulatorType: 'qemu',
            vmName: 'Win98',
            displayName: null,
            summary: null,
            visibility: 'private',
            mainMediaId: null,
            publicCover: 'vm_private',
            mediaCount: 0,
            activeSessions: 1,
            updatedAt: PAST,
          },
        ],
        pagination: { ...page.pagination, total: 1, totalPages: 1 },
      },
    });
    renderAt('/admin/catalog');
    expect(await screen.findByText(/Running/)).toBeTruthy();
  });
});
