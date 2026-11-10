import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  ExecutionAgentOption,
  ExecutionOptionsResponse,
  RemoteSession,
  RestoreOptionsResponse,
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
const SNAPSHOT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7007';
const WORKSPACE_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7008';
const NEW_VERSION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7009';
const REPOSITORY_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7010';
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
    remote: {
      remote_volatile: { eligible: false, reason: 'mode_not_supported', problem: null },
      remote_snapshot: { eligible: false, reason: 'mode_not_supported', problem: null },
    },
    activeWorkspaceId: null,
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
    [`GET ${VM_PATH}/workspaces`]: { workspaces: [] },
    ...routes,
  });
}

const ALL_MODES: ExecutionOptionsResponse['modes'] = [
  { mode: 'local', available: true, reason: null },
  { mode: 'remote_volatile', available: true, reason: null },
  { mode: 'remote_snapshot', available: true, reason: null },
];

const REMOTE_OK = { eligible: true, reason: null, problem: null };

function versions(): RestoreOptionsResponse {
  const version = (id: string, kind: 'master' | 'snapshot', name: string | null) => ({
    versionId: id,
    repositoryId: REPOSITORY_ID,
    repositoryName: 'NAS',
    repositoryEnabled: true,
    archiveSizeBytes: 2048,
    archiveSha256: 'a'.repeat(64),
    createdAt: PAST,
    manifestSha256: 'a'.repeat(64),
    fileCount: 3,
    totalUncompressedBytes: 4096,
    kind,
    parentVersionId: kind === 'master' ? null : VERSION_ID,
    snapshotName: name,
  });
  const master = version(VERSION_ID, 'master', null);
  return {
    master,
    versions: [master, version(SNAPSHOT_ID, 'snapshot', 'Win98_after_setup')],
    agents: [],
  };
}

function remoteSession(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: WORKSPACE_ID,
    agentId: AGENT_ID,
    agentName: 'Study PC',
    agentOnline: true,
    emulatorType: 'qemu',
    vmName: 'Win98',
    purpose: 'remote_snapshot',
    state: 'running',
    baseVersionId: SNAPSHOT_ID,
    sourceVersionId: SNAPSHOT_ID,
    mayHaveChanges: true,
    launchOnReady: true,
    restoreOperationId: null,
    sessionId: null,
    snapshotOperationId: null,
    publishAttempts: 0,
    nextRetryAt: null,
    abandonedAt: null,
    snapshotVersionId: null,
    localDirectory: null,
    error: null,
    requestedByDisplayName: 'Ada Admin',
    createdAt: PAST,
    updatedAt: PAST,
    finishedAt: null,
    restore: null,
    session: null,
    snapshot: null,
    recovery: null,
    ...overrides,
  };
}

function remoteBase(sessions: RemoteSession[], routes: Record<string, unknown> = {}) {
  return base({
    [`GET ${OPTIONS_PATH}`]: {
      modes: ALL_MODES,
      agents: [agent({ remote: { remote_volatile: REMOTE_OK, remote_snapshot: REMOTE_OK } })],
    },
    [`GET ${VM_PATH}/restore-options`]: versions(),
    [`GET ${VM_PATH}/workspaces`]: { workspaces: sessions },
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
    const volatile = view.getByRole('radio', { name: 'Remote Volatile (not available)' });
    expect(disabled(volatile)).toBe(true);
    expect(disabled(view.getByRole('radio', { name: 'Remote Snapshot (not available)' }))).toBe(
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
    expect(await view.findByText('Modified: differs from its version')).toBeTruthy();
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

describe('remote modes', () => {
  it('chooses a version, says per agent why a mode cannot start, and needs no local copy', async () => {
    base({
      [`GET ${OPTIONS_PATH}`]: {
        modes: ALL_MODES,
        agents: [
          agent({
            local: {
              present: false,
              contentStatus: null,
              sourceVersionId: null,
              lastVerifiedAt: null,
            },
            launch: { eligible: false, reason: 'vm_not_on_agent', problem: null },
            remote: {
              remote_volatile: REMOTE_OK,
              remote_snapshot: { eligible: false, reason: 'mode_not_supported', problem: null },
            },
          }),
        ],
      },
      [`GET ${VM_PATH}/restore-options`]: versions(),
    });
    const view = await section();
    fireEvent.click(await view.findByRole('radio', { name: 'Remote Volatile' }));
    const select = view.getByLabelText('Version') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(VERSION_ID));
    expect(within(select).getByRole('option', { name: /Win98_after_setup/ })).toBeTruthy();
    expect(view.getByText(/Remote modes do not need one/)).toBeTruthy();
    expect(disabled(view.getByRole('button', { name: 'Start Remote Volatile' }))).toBe(false);

    fireEvent.click(view.getByRole('radio', { name: 'Remote Snapshot' }));
    expect(disabled(view.getByRole('button', { name: 'Start Remote Snapshot' }))).toBe(true);
    expect(
      view.getByText(/Cannot start Remote Snapshot on Study PC: its version cannot run this mode/),
    ).toBeTruthy();
  });

  it('starts a session of exactly the chosen version, and retries with the same request ID', async () => {
    const api = remoteBase([], {
      [`POST ${VM_PATH}/workspaces`]: apiError(503, 'unavailable', 'Try again'),
    });
    const view = await section();
    fireEvent.click(await view.findByRole('radio', { name: 'Remote Snapshot' }));
    const select = view.getByLabelText('Version') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(VERSION_ID));
    fireEvent.change(select, { target: { value: SNAPSHOT_ID } });
    const start = view.getByRole('button', { name: 'Start Remote Snapshot' });
    fireEvent.click(start);
    await view.findByText('Try again');
    fireEvent.click(start);
    await waitFor(() => expect(api.callsTo('POST', `${VM_PATH}/workspaces`)).toHaveLength(2));
    const [first, second] = api.callsTo('POST', `${VM_PATH}/workspaces`);
    expect(first?.body).toMatchObject({
      agentId: AGENT_ID,
      versionId: SNAPSHOT_ID,
      mode: 'remote_snapshot',
    });
    expect(Object.keys(first?.body as object).sort()).toEqual([
      'agentId',
      'mode',
      'requestId',
      'versionId',
    ]);
    expect((first?.body as { requestId: string }).requestId).toBe(
      (second?.body as { requestId: string }).requestId,
    );

    // Another version is another request.
    fireEvent.change(select, { target: { value: VERSION_ID } });
    fireEvent.click(start);
    await waitFor(() => expect(api.callsTo('POST', `${VM_PATH}/workspaces`)).toHaveLength(3));
    const third = api.callsTo('POST', `${VM_PATH}/workspaces`)[2];
    expect((third?.body as { requestId: string }).requestId).not.toBe(
      (first?.body as { requestId: string }).requestId,
    );
  });

  it('follows a session through its steps, with the running emulator controls', async () => {
    remoteBase([
      remoteSession({
        state: 'running',
        sessionId: SESSION_ID,
        session: session({ mode: 'remote_snapshot', workspaceId: WORKSPACE_ID }),
      }),
    ]);
    const view = await section();
    const card = within(
      await view.findByRole('article', { name: 'Remote Snapshot session on Study PC' }),
    );
    expect(card.getByText(/whose parent is Win98_after_setup/)).toBeTruthy();
    const steps = card.getByRole('list', { name: 'Steps of this session' });
    const current = within(steps)
      .getAllByRole('listitem')
      .find((item) => item.getAttribute('aria-current') === 'step');
    expect(current?.textContent).toContain('Run the emulator');
    expect(within(steps).getByText('Publish the snapshot')).toBeTruthy();
    expect(card.getByText(/PID 4242/)).toBeTruthy();
    expect(card.getByRole('button', { name: 'Stop' })).toBeTruthy();
    // The emulator's session is shown once, inside its remote session.
    expect(view.getAllByText(/PID 4242/)).toHaveLength(1);
  });

  it('shows a volatile session without a publication step', async () => {
    remoteBase([remoteSession({ purpose: 'remote_volatile', state: 'discarding' })]);
    const view = await section();
    const card = within(
      await view.findByRole('article', { name: 'Remote Volatile session on Study PC' }),
    );
    expect(card.queryByText('Publish the snapshot')).toBeNull();
    expect(card.getByText(/every change is discarded/)).toBeTruthy();
  });

  it('retries a failed publication, and abandons it only once the VM name is typed', async () => {
    const failed = remoteSession({
      state: 'publish_failed',
      publishAttempts: 3,
      error: { code: 'repository_unreachable', message: 'The repository could not be reached.' },
      recovery: 'The temporary copy is kept, and nothing was published.',
    });
    const api = remoteBase([failed], {
      [`POST /admin/workspaces/${WORKSPACE_ID}/retry-publication`]: remoteSession({
        state: 'publishing',
      }),
      [`POST /admin/workspaces/${WORKSPACE_ID}/discard`]: remoteSession({
        state: 'discarding',
        abandonedAt: PAST,
      }),
    });
    const view = await section();
    const card = within(
      await view.findByRole('article', { name: 'Remote Snapshot session on Study PC' }),
    );
    expect(card.getByText('The repository could not be reached.')).toBeTruthy();
    expect(card.getByText(/temporary copy is kept/)).toBeTruthy();
    const steps = card.getByRole('list', { name: 'Steps of this session' });
    expect(within(steps).getByText('(failed)').parentElement?.textContent).toContain(
      'Publish the snapshot',
    );
    fireEvent.click(card.getByRole('button', { name: 'Retry publication' }));
    await waitFor(() =>
      expect(
        api.callsTo('POST', `/admin/workspaces/${WORKSPACE_ID}/retry-publication`)[0]?.body,
      ).toEqual({}),
    );

    fireEvent.click(card.getByRole('button', { name: 'Abandon snapshot…' }));
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Abandon the snapshot of Win98' }),
    );
    expect(dialog.getByText(/lost for good/)).toBeTruthy();
    const confirm = dialog.getByRole('button', { name: 'Abandon snapshot' });
    expect(disabled(confirm)).toBe(true);
    fireEvent.change(dialog.getByLabelText(/to confirm/), { target: { value: 'Win98' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/workspaces/${WORKSPACE_ID}/discard`)[0]?.body).toEqual({
        confirmVmName: 'Win98',
      }),
    );
  });

  it('resumes a held session only once the VM name is typed', async () => {
    const api = remoteBase(
      [
        remoteSession({
          state: 'held',
          recovery: 'Check that it no longer runs on that computer, then resume.',
        }),
      ],
      {
        [`POST /admin/workspaces/${WORKSPACE_ID}/resume`]: remoteSession({ state: 'publishing' }),
      },
    );
    const view = await section();
    const card = within(
      await view.findByRole('article', { name: 'Remote Snapshot session on Study PC' }),
    );
    expect(card.getByText('Waiting for confirmation')).toBeTruthy();
    expect(card.queryByRole('button', { name: 'Retry publication' })).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Resume…' }));
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Resume this session of Win98' }),
    );
    fireEvent.change(dialog.getByLabelText(/to confirm/), { target: { value: 'win98' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Resume' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/workspaces/${WORKSPACE_ID}/resume`)[0]?.body).toEqual({
        confirmVmName: 'win98',
      }),
    );
  });

  it('lists finished sessions with what became of them', async () => {
    remoteBase([
      remoteSession({
        state: 'discarded',
        snapshotVersionId: NEW_VERSION_ID,
        finishedAt: PAST,
      }),
      remoteSession({
        id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7011',
        purpose: 'remote_volatile',
        state: 'discarded',
        finishedAt: PAST,
      }),
    ]);
    const view = await section();
    const heading = await view.findByRole('heading', { name: 'Recent remote sessions' });
    const table = within(heading.parentElement as HTMLElement).getByRole('table');
    expect(within(table).getByText(`Published as ${NEW_VERSION_ID.slice(0, 8)}`)).toBeTruthy();
    expect(within(table).getByText('Ended, temporary copy removed')).toBeTruthy();
    expect(view.getByText('Nothing is running.')).toBeTruthy();
  });

  it('labels a manual working copy session as such, without reinterpreting it', async () => {
    remoteBase([remoteSession({ purpose: 'manual', state: 'ready' })], {
      'GET /admin/sessions': {
        sessions: [
          session({
            mode: 'remote_snapshot',
            workspaceId: WORKSPACE_ID,
            state: 'exited',
            endedAt: PAST,
          }),
        ],
      },
    });
    const view = await section();
    expect(await view.findByText('Remote Snapshot (manual working copy)')).toBeTruthy();
    expect(view.queryByRole('article', { name: /session on Study PC/ })).toBeNull();
  });
});
