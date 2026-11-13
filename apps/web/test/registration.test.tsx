import {
  isRegistrationTerminal,
  registrationNeedsAttention,
  type AgentSummary,
  type DiscoveryOperation,
  type RegistrationOperation,
  type RepositorySummary,
} from '@emucat/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockApi, renderAt, resetApiState, signedInAsAdmin } from './mock-api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  resetApiState();
});

const AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f63';
const REPOSITORY_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f70';
const DISCOVERY_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f65';
const OPERATION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f71';
const VERSION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f72';
const AGENT_PATH = `/admin/agents/${AGENT_ID}`;
const WHEN = '2026-01-31T15:30:00.000Z';
const SHA = 'a'.repeat(64);

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: AGENT_ID,
    name: 'Desk PC',
    platform: 'windows',
    architecture: 'x86_64',
    agentVersion: '0.2.0',
    protocolVersion: 1,
    pairingStatus: 'paired',
    online: true,
    ownerDisplayName: 'Ada Admin',
    pairedAt: WHEN,
    lastConnectedAt: WHEN,
    lastSeenAt: WHEN,
    revokedAt: null,
    ...overrides,
  };
}

function repository(overrides: Partial<RepositorySummary> = {}): RepositorySummary {
  return {
    id: REPOSITORY_ID,
    name: 'NAS',
    provider: 'sftp',
    host: 'nas.example',
    port: 22,
    username: 'emucat',
    remoteRoot: '/srv/emucat',
    enabled: true,
    status: 'healthy',
    lastSuccessfulCheckAt: WHEN,
    agents: [
      {
        agentId: AGENT_ID,
        agentName: 'Desk PC',
        online: true,
        revoked: false,
        checkInProgress: false,
        lastCheckedAt: WHEN,
        lastSuccessAt: WHEN,
        errorCode: null,
        errorMessage: null,
        hostKeyFingerprint: 'SHA256:abcdef',
        freeBytes: 1024 * 1024 * 1024,
      },
    ],
    configurationErrors: [],
    ...overrides,
  };
}

function discovery(): DiscoveryOperation {
  return {
    id: DISCOVERY_ID,
    agentId: AGENT_ID,
    status: 'completed',
    startedAt: WHEN,
    finishedAt: WHEN,
    failure: null,
    hostPlatform: 'windows',
    emulators: [{ emulatorType: 'qemu', status: 'ok', truncated: false }],
    vms: [
      {
        emulatorType: 'qemu',
        vmName: 'Win98',
        markers: ['run.bat'],
        hostCompatible: true,
        registered: false,
      },
      {
        emulatorType: 'qemu',
        vmName: 'Already',
        markers: ['run.bat'],
        hostCompatible: true,
        registered: true,
      },
    ],
    skipped: [],
    expiresAt: null,
    fromCurrentConnection: true,
  };
}

function operation(overrides: Partial<RegistrationOperation> = {}): RegistrationOperation {
  return {
    id: OPERATION_ID,
    agentId: AGENT_ID,
    agentName: 'Desk PC',
    agentOnline: true,
    repositoryId: REPOSITORY_ID,
    repositoryName: 'NAS',
    emulatorType: 'qemu',
    vmName: 'Win98',
    mode: 'copy',
    state: 'uploading',
    versionId: VERSION_ID,
    parentVersionId: null,
    snapshotName: null,
    workspaceId: null,
    archiveKey: `archives/qemu/win98/${VERSION_ID}.zip`,
    progress: { doneBytes: 512 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024 },
    archive: null,
    localCopy: null,
    error: null,
    recovery: null,
    cancelRequested: false,
    requestedByDisplayName: 'Ada Admin',
    createdAt: WHEN,
    updatedAt: WHEN,
    committedAt: null,
    finishedAt: null,
    acknowledgedAt: null,
    acknowledgedByDisplayName: null,
    parentSnapshotName: null,
    versionDeletion: null,
    ...overrides,
  };
}

const ARCHIVE = {
  sizeBytes: 2048,
  sha256: SHA,
  manifestVersion: 1,
  manifestSha256: 'b'.repeat(64),
  fileCount: 3,
  totalUncompressedBytes: 4096,
  verifiedBy: 'agent' as const,
};

function routes(overrides: Record<string, unknown> = {}) {
  return {
    ...signedInAsAdmin,
    [`GET ${AGENT_PATH}`]: agent(),
    [`GET ${AGENT_PATH}/discovery`]: { operation: discovery() },
    'GET /admin/repositories': { repositories: [repository()] },
    'GET /admin/registrations': listing([] as RegistrationOperation[]),
    ...overrides,
  };
}

/** The listing as the server answers each view: what needs attention, or what has ended. */
function listing(operations: RegistrationOperation[]) {
  return (call: { query: URLSearchParams }) => {
    const view = call.query.get('view') ?? 'all';
    const selected = operations.filter((item) =>
      view === 'attention'
        ? registrationNeedsAttention(item)
        : view === 'history'
          ? isRegistrationTerminal(item.state)
          : true,
    );
    return {
      operations: selected,
      nextCursor: null,
      ...(view === 'attention' ? { total: selected.length } : {}),
    };
  };
}

const articleOf = (element: HTMLElement) => element.closest('article') as HTMLElement;

describe('the discovery list', () => {
  it('shows launchers and registration status, and offers both actions', async () => {
    mockApi(routes());
    renderAt(AGENT_PATH);
    const heading = await screen.findByRole('heading', { name: 'Win98' });
    const card = within(articleOf(heading));
    expect(card.getByText(/Launchers: run\.bat/)).toBeTruthy();
    expect(card.getByText('Has a launcher for this host')).toBeTruthy();
    expect(card.getByText('Not registered')).toBeTruthy();
    await waitFor(() =>
      expect(
        (card.getByRole('button', { name: 'Copy to remote' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(
      (card.getByRole('button', { name: 'Transfer to remote' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('keeps registered VMs behind a toggle, linked to the catalog and offering nothing', async () => {
    mockApi(routes());
    renderAt(AGENT_PATH);
    await screen.findByRole('heading', { name: 'Win98' });
    expect(screen.queryByRole('heading', { name: 'Already' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 already registered VM' }));
    const card = within(articleOf(screen.getByRole('heading', { name: 'Already' })));
    expect(card.getByText('Already registered')).toBeTruthy();
    expect(card.queryByRole('button')).toBeNull();
    expect(card.getByRole('link', { name: 'Open Already in the catalog' })).toBeTruthy();
  });

  it('says so when every VM found is already registered', async () => {
    const report = discovery();
    report.vms = report.vms.map((vm) => ({ ...vm, registered: true }));
    mockApi(routes({ [`GET ${AGENT_PATH}/discovery`]: { operation: report } }));
    renderAt(AGENT_PATH);
    expect(
      await screen.findByRole('heading', { name: 'Every VM found is already registered' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy to remote' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show 2 already registered VMs' })).toBeTruthy();
  });

  /** The VM's card in the discovery list, rather than an operation's card with the same name. */
  const discoveredCard = async () => {
    await screen.findAllByRole('heading', { name: 'Win98' });
    const heading = screen
      .getAllByRole('heading', { name: 'Win98' })
      .find((element) => element.closest('.media-grid'));
    return within(articleOf(heading as HTMLElement));
  };

  it('follows a registration from not registered to registered, without another scan', async () => {
    // What the server says now: first the operation runs, then it commits, then it has ended and the
    // catalog has the VM. The report is only ever read again, never scanned again.
    let phase: 'running' | 'committed' | 'ended' = 'running';
    const running = operation();
    const committed = operation({ state: 'cleaning_local', archive: ARCHIVE, committedAt: WHEN });
    const ended = operation({
      state: 'succeeded',
      archive: ARCHIVE,
      localCopy: 'preserved',
      committedAt: WHEN,
      finishedAt: WHEN,
    });
    const api = mockApi(
      routes({
        'GET /admin/registrations': (call: { query: URLSearchParams }) =>
          listing([phase === 'running' ? running : phase === 'committed' ? committed : ended])(
            call,
          ),
        [`GET ${AGENT_PATH}/discovery`]: () => {
          const report = discovery();
          if (phase === 'ended') report.vms[0]!.registered = true;
          return { operation: report };
        },
      }),
    );
    renderAt(AGENT_PATH);
    let card = await discoveredCard();
    expect(await card.findByText('Registration running')).toBeTruthy();
    expect(card.queryByRole('button')).toBeNull();

    phase = 'committed';
    const inUnregisteredList = () =>
      screen
        .queryAllByRole('heading', { name: 'Win98' })
        .filter((element) => element.closest('.media-grid'));
    // Committed: the master exists, so it leaves the VMs that can be registered at once.
    await waitFor(() => expect(inUnregisteredList()).toEqual([]), { timeout: 4000 });
    expect(screen.getByRole('button', { name: 'Show 2 already registered VMs' })).toBeTruthy();
    const reads = api.callsTo('GET', `${AGENT_PATH}/discovery`).length;
    phase = 'ended';
    // Once it has ended, the report is read again and the server's own answer takes over.
    await waitFor(
      () => {
        expect(api.callsTo('GET', `${AGENT_PATH}/discovery`).length).toBeGreaterThan(reads);
        expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull();
      },
      { timeout: 4000 },
    );
    expect(inUnregisteredList()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 already registered VMs' }));
    card = await discoveredCard();
    expect(card.getByText('Already registered')).toBeTruthy();
    expect(card.queryByRole('button')).toBeNull();
    expect(api.callsTo('POST', `${AGENT_PATH}/discovery`)).toEqual([]);
    // The ended registration is now a row of the recent history, not a card.
    const recent = await screen.findByRole('region', { name: 'Recent registrations' });
    expect(within(recent).getByText('Registered')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull();
  }, 15_000);

  it('offers a VM again after a registration that failed', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': listing([
          operation({
            state: 'failed',
            error: { code: 'source_changed', message: 'It changed.' },
            finishedAt: WHEN,
          }),
        ]),
      }),
    );
    renderAt(AGENT_PATH);
    await screen.findByRole('region', { name: 'Recent registrations' });
    const card = await discoveredCard();
    await waitFor(() =>
      expect(
        (card.getByRole('button', { name: 'Copy to remote' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    // A failure that changed nothing is history, not something needing attention.
    expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull();
  });

  it('offers nothing from a report that has expired, or that predates a reconnection', async () => {
    const expired = { ...discovery(), expiresAt: '2026-01-31T15:45:00.000Z' };
    mockApi(routes({ [`GET ${AGENT_PATH}/discovery`]: { operation: expired } }));
    const { unmount } = renderAt(AGENT_PATH);
    expect(await screen.findByText(/This report has expired/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy to remote' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Win98' })).toBeTruthy();
    unmount();
    resetApiState();

    const replaced = { ...discovery(), fromCurrentConnection: false };
    mockApi(routes({ [`GET ${AGENT_PATH}/discovery`]: { operation: replaced } }));
    renderAt(AGENT_PATH);
    expect(await screen.findByText(/reconnected since this report was made/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Transfer to remote' })).toBeNull();
  });

  it('expires a report while the page is open', async () => {
    const soon = { ...discovery(), expiresAt: new Date(Date.now() + 300).toISOString() };
    mockApi(routes({ [`GET ${AGENT_PATH}/discovery`]: { operation: soon } }));
    renderAt(AGENT_PATH);
    expect(await screen.findByRole('button', { name: 'Copy to remote' })).toBeTruthy();
    expect(await screen.findByText(/This report has expired/, {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy to remote' })).toBeNull();
  });

  it('says when no discovery has run yet', async () => {
    mockApi(routes({ [`GET ${AGENT_PATH}/discovery`]: { operation: null } }));
    renderAt(AGENT_PATH);
    expect(await screen.findByRole('heading', { name: 'No discovery yet' })).toBeTruthy();
    expect(screen.getByText(/No discovery has run since the server started/)).toBeTruthy();
  });

  it('disables the actions without a repository, and says what to do', async () => {
    mockApi(routes({ 'GET /admin/repositories': { repositories: [repository({ agents: [] })] } }));
    renderAt(AGENT_PATH);
    await screen.findByRole('heading', { name: 'Win98' });
    expect(await screen.findByRole('link', { name: 'allow this agent' })).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Copy to remote' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/not allowed to use a repository/);
  });

  it('disables the actions for an offline or revoked agent', async () => {
    mockApi(routes({ [`GET ${AGENT_PATH}`]: agent({ online: false }) }));
    renderAt(AGENT_PATH);
    await screen.findByRole('heading', { name: 'Win98' });
    const button = screen.getByRole('button', { name: 'Copy to remote' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/offline/);
  });

  it('shows a running registration, and disables starting another', async () => {
    mockApi(routes({ 'GET /admin/registrations': listing([operation()]) }));
    renderAt(AGENT_PATH);
    expect(await screen.findByText('Registration running')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Needs attention' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show 1 already registered VM' })).toBeTruthy();
  });
});

describe('the page layout', () => {
  const ended = (index: number) =>
    operation({
      id: `018f47a0-7c2b-4f7e-9a3d-1b2c3d4e${String(6000 + index)}`,
      vmName: `Old${index}`,
      state: index % 2 ? 'failed' : 'succeeded',
      archive: index % 2 ? null : ARCHIVE,
      error: index % 2 ? { code: 'source_changed', message: 'It changed.' } : null,
      committedAt: index % 2 ? null : WHEN,
      finishedAt: WHEN,
    });

  it('puts discovery before the history, and shows ended operations as rows, not cards', async () => {
    const api = mockApi(
      routes({
        'GET /admin/registrations': listing([
          operation(),
          ...Array.from({ length: 8 }, (_, index) => ended(index)),
        ]),
      }),
    );
    renderAt(AGENT_PATH);
    const recent = await screen.findByRole('region', { name: 'Recent registrations' });
    const discoveryRegion = screen.getByRole('region', { name: 'Discovery' });
    const attention = screen.getByRole('region', { name: 'Needs attention' });
    expect(
      discoveryRegion.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Only the running operation is a card; the eight that ended are rows.
    expect(within(attention).getAllByRole('article')).toHaveLength(1);
    expect(within(recent).queryAllByRole('article')).toEqual([]);
    expect(within(recent).getAllByRole('row')).toHaveLength(9);
    expect(
      within(recent).getByRole('link', { name: 'View full registration history' }),
    ).toBeTruthy();
    // Each list asks the server for a bounded page, never for the whole history.
    const views = api
      .callsTo('GET', '/admin/registrations')
      .map((call) => [call.query.get('view'), call.query.get('limit')]);
    expect(views).toContainEqual(['attention', '5']);
    expect(views).toContainEqual(['history', '8']);
    expect(views.every(([view]) => view === 'attention' || view === 'history')).toBe(true);
  });

  it('says how many need attention when they do not all fit', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': (call: { query: URLSearchParams }) =>
          call.query.get('view') === 'attention'
            ? { operations: [operation()], nextCursor: 'more', total: 7 }
            : { operations: [], nextCursor: null },
      }),
    );
    renderAt(AGENT_PATH);
    expect(await screen.findByText(/Showing 1 of 7/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'See all 7 that need attention' }).getAttribute('href'),
    ).toBe(`/admin/registrations?agentId=${AGENT_ID}&status=attention`);
  });
});

describe('the copy dialog', () => {
  async function open(name: string) {
    const button = await screen.findByRole('button', { name });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    return within(await screen.findByRole('dialog'));
  }

  it('explains what happens, and starts only when confirmed', async () => {
    const api = mockApi(
      routes({
        'POST /admin/registrations': () =>
          operation({ state: 'queued', progress: { doneBytes: null, totalBytes: null } }),
      }),
    );
    renderAt(AGENT_PATH);
    const dialog = await open('Copy to remote');
    expect(dialog.getByText('Desk PC')).toBeTruthy();
    expect(dialog.getByText(/NAS \(nas\.example:22\)/)).toBeTruthy();
    expect(dialog.getByText(/stays exactly as it is/)).toBeTruthy();
    expect(dialog.getByText(/never through this\s+server/)).toBeTruthy();
    expect(dialog.queryByRole('alert')).toBeNull();
    expect(api.callsTo('POST', '/admin/registrations')).toEqual([]);

    fireEvent.click(dialog.getByRole('button', { name: 'Start the copy' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [call] = api.callsTo('POST', '/admin/registrations');
    expect(call?.body).toEqual({
      agentId: AGENT_ID,
      repositoryId: REPOSITORY_ID,
      emulatorType: 'qemu',
      vmName: 'Win98',
      mode: 'copy',
      discoveryOperationId: DISCOVERY_ID,
    });
    expect(call?.headers['x-csrf-token']).toBe('test-csrf-token');
  });

  it('can be left without doing anything, also with Escape', async () => {
    const api = mockApi(routes());
    renderAt(AGENT_PATH);
    const dialog = await open('Copy to remote');
    fireEvent.click(dialog.getByRole('button', { name: 'Keep things as they are' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await open('Copy to remote');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.callsTo('POST', '/admin/registrations')).toEqual([]);
  });

  it('shows why the server refused, and stays open', async () => {
    mockApi(
      routes({
        'POST /admin/registrations': apiError(
          409,
          'discovery_stale',
          'This discovery is out of date.',
        ),
      }),
    );
    renderAt(AGENT_PATH);
    const dialog = await open('Copy to remote');
    fireEvent.click(dialog.getByRole('button', { name: 'Start the copy' }));
    expect(await dialog.findByText(/out of date/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('the transfer dialog', () => {
  async function open() {
    const button = await screen.findByRole('button', { name: 'Transfer to remote' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    return within(await screen.findByRole('dialog'));
  }

  it('warns explicitly, and cannot start until that is acknowledged', async () => {
    const api = mockApi(
      routes({ 'POST /admin/registrations': () => operation({ mode: 'transfer' }) }),
    );
    renderAt(AGENT_PATH);
    const dialog = await open();
    expect(dialog.getByRole('alert').textContent).toMatch(/This deletes the local VM/);
    expect(dialog.getByRole('alert').textContent).toMatch(/screenshots/);
    const start = dialog.getByRole('button', {
      name: 'Transfer and delete locally',
    }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    expect(api.callsTo('POST', '/admin/registrations')).toEqual([]);

    fireEvent.click(dialog.getByRole('checkbox', { name: /will be deleted/ }));
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(api.callsTo('POST', '/admin/registrations').length).toBe(1));
    expect(api.callsTo('POST', '/admin/registrations')[0]?.body).toMatchObject({
      mode: 'transfer',
      confirmDestructive: true,
    });
  });
});

describe('progress', () => {
  it('shows real bytes and a percentage only when there is a total', async () => {
    mockApi(routes({ 'GET /admin/registrations': listing([operation()]) }));
    renderAt(AGENT_PATH);
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText(/512\.0 MiB of 1\.00 GiB/)).toBeTruthy();
  });

  it('invents no percentage when it has no total', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': listing([
          operation({ state: 'validating', progress: { doneBytes: null, totalBytes: null } }),
        ]),
      }),
    );
    renderAt(AGENT_PATH);
    expect(await screen.findAllByText('Checking the VM')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('says that an offline agent will continue', async () => {
    mockApi(routes({ 'GET /admin/registrations': listing([operation({ agentOnline: false })]) }));
    renderAt(AGENT_PATH);
    expect(await screen.findByText(/continues when it reconnects/)).toBeTruthy();
  });

  it('can be cancelled before the master exists, and not after', async () => {
    const api = mockApi(
      routes({
        'GET /admin/registrations': listing([operation()]),
        [`POST /admin/registrations/${OPERATION_ID}/cancel`]: operation({ cancelRequested: true }),
      }),
    );
    renderAt(AGENT_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/registrations/${OPERATION_ID}/cancel`).length).toBe(1),
    );
  });

  it('offers no cancellation once the master is committed', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': listing([
          operation({ state: 'cleaning_local', archive: ARCHIVE, committedAt: WHEN }),
        ]),
      }),
    );
    renderAt(AGENT_PATH);
    await screen.findAllByText('Finishing up on the agent');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('lets an administrator retry a commit that failed', async () => {
    const api = mockApi(
      routes({
        'GET /admin/registrations': listing([operation({ state: 'committing', archive: ARCHIVE })]),
        [`POST /admin/registrations/${OPERATION_ID}/reconcile`]: operation({
          state: 'cleaning_local',
          archive: ARCHIVE,
          committedAt: WHEN,
        }),
      }),
    );
    renderAt(AGENT_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry recording it' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/registrations/${OPERATION_ID}/reconcile`).length).toBe(1),
    );
  });
});

describe('the outcome', () => {
  /** Opens an ended operation from the recent history, where it now lives. */
  async function details() {
    const recent = await screen.findByRole('region', { name: 'Recent registrations' });
    fireEvent.click(within(recent).getByRole('button', { name: /^Details of the/ }));
    return within(await screen.findByRole('dialog', { name: 'Registration details' }));
  }

  const succeeded = (overrides: Partial<RegistrationOperation> = {}) =>
    operation({
      state: 'succeeded',
      archive: ARCHIVE,
      localCopy: 'preserved',
      committedAt: WHEN,
      finishedAt: WHEN,
      ...overrides,
    });

  it('shows what was registered, without claiming that the server checked it', async () => {
    mockApi(routes({ 'GET /admin/registrations': listing([succeeded()]) }));
    renderAt(AGENT_PATH);
    const dialog = await details();
    expect(dialog.getByRole('link', { name: 'Win98' })).toBeTruthy();
    expect(dialog.getByText('Registered VM')).toBeTruthy();
    expect(dialog.getByText('Master version')).toBeTruthy();
    expect(dialog.getByRole('link', { name: VERSION_ID }).getAttribute('href')).toBe(
      `/admin/vms/qemu/Win98#version-${VERSION_ID}`,
    );
    expect(dialog.getByText('Private')).toBeTruthy();
    expect(dialog.getByText(/verified by the agent/)).toBeTruthy();
    expect(dialog.getByText(SHA)).toBeTruthy();
    expect(dialog.getByText(/Kept on the agent, unchanged/)).toBeTruthy();
  });

  it('calls a snapshot a snapshot, and names its parent', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': listing([
          succeeded({
            mode: 'snapshot',
            parentVersionId: OPERATION_ID,
            snapshotName: 'Win98 2026-01-31 15-30',
          }),
        ]),
      }),
    );
    renderAt(AGENT_PATH);
    const recent = await screen.findByRole('region', { name: 'Recent registrations' });
    expect(within(recent).getByText('Snapshot created')).toBeTruthy();
    expect(within(recent).getByText('Win98 2026-01-31 15-30')).toBeTruthy();
    const dialog = await details();
    expect(dialog.getByText('Snapshot version')).toBeTruthy();
    expect(dialog.queryByText('Master version')).toBeNull();
    expect(dialog.queryByText('Registered VM')).toBeNull();
    expect(dialog.getByText('Parent version')).toBeTruthy();
    expect(dialog.getByText(/^Master/)).toBeTruthy();
  });

  it('says that a failed snapshot created no snapshot, rather than no master', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': listing([
          operation({
            mode: 'snapshot',
            state: 'failed',
            parentVersionId: OPERATION_ID,
            snapshotName: 'Win98 2026-01-31 15-30',
            localCopy: 'preserved',
            error: {
              code: 'snapshot_lineage_unverified',
              message:
                'This agent’s record of where the local copy came from predates lineage checks',
            },
            finishedAt: WHEN,
          }),
        ]),
      }),
    );
    renderAt(AGENT_PATH);
    const dialog = await details();
    expect(dialog.getByText(/No snapshot was created, and the local VM is unchanged/)).toBeTruthy();
    expect(dialog.queryByText(/No master was created/)).toBeNull();
  });

  it('keeps a deleted version as history, without linking to it', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': listing([
          succeeded({
            mode: 'snapshot',
            parentVersionId: OPERATION_ID,
            parentSnapshotName: 'Win98 2026-01-30 10-00',
            snapshotName: 'Win98 2026-01-31 15-30',
            versionDeletion: 'deleted',
          }),
        ]),
      }),
    );
    renderAt(AGENT_PATH);
    const dialog = await details();
    expect(dialog.getByText('Deleted since')).toBeTruthy();
    expect(dialog.queryByRole('link', { name: VERSION_ID })).toBeNull();
    expect(dialog.getByText(/Win98 2026-01-30 10-00/)).toBeTruthy();
  });

  it('shows a failure, and what to do about it', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': listing([
          operation({
            state: 'failed',
            localCopy: 'preserved',
            error: { code: 'host_key_changed', message: 'The host key differs.' },
            recovery: 'Find out why the server’s key changed.',
            finishedAt: WHEN,
          }),
        ]),
      }),
    );
    renderAt(AGENT_PATH);
    const dialog = await details();
    const alert = dialog.getByRole('alert');
    expect(alert.textContent).toMatch(/The host key differs/);
    expect(alert.textContent).toMatch(/Find out why/);
    expect(dialog.getByText(/No master was created, and the local VM is unchanged/)).toBeTruthy();
  });

  it('keeps a partial success in view until it is acknowledged', async () => {
    const partial = operation({
      mode: 'transfer',
      state: 'partial_success',
      archive: ARCHIVE,
      localCopy: 'cleanup_failed',
      error: { code: 'cleanup_in_use', message: 'A file is in use.' },
      recovery: 'The master is registered and safe.',
      committedAt: WHEN,
      finishedAt: WHEN,
    });
    const api = mockApi(
      routes({
        'GET /admin/registrations': listing([partial]),
        [`POST /admin/registrations/${OPERATION_ID}/acknowledge`]: {
          ...partial,
          acknowledgedAt: WHEN,
          acknowledgedByDisplayName: 'Ada Admin',
        },
      }),
    );
    renderAt(AGENT_PATH);
    const attention = await screen.findByRole('region', { name: 'Needs attention' });
    expect(within(attention).getByText('Registered, with a problem')).toBeTruthy();
    expect(within(attention).getByText(/could not be safely removed/)).toBeTruthy();
    expect(within(attention).getByRole('alert').textContent).toMatch(/registered and safe/);
    // Not retryable, so only an acknowledgement takes it out of view.
    expect(within(attention).queryByRole('button', { name: 'Retry removal' })).toBeNull();
    fireEvent.click(within(attention).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/registrations/${OPERATION_ID}/acknowledge`)).toHaveLength(
        1,
      ),
    );
  });

  it('still offers to retry a removal that a screenshot blocked', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': listing([
          operation({
            mode: 'transfer',
            state: 'partial_success',
            archive: ARCHIVE,
            localCopy: 'preserved',
            error: { code: 'transfer_blocked_media', message: 'A screenshot is not synchronized.' },
            committedAt: WHEN,
            finishedAt: WHEN,
          }),
        ]),
      }),
    );
    renderAt(AGENT_PATH);
    const attention = await screen.findByRole('region', { name: 'Needs attention' });
    expect(within(attention).getByRole('button', { name: 'Retry removal' })).toBeTruthy();
    expect(within(attention).getByRole('button', { name: 'Acknowledge' })).toBeTruthy();
  });
});

describe('the repositories page', () => {
  const page = (overrides: Record<string, unknown> = {}) => ({
    ...signedInAsAdmin,
    'GET /admin/repositories': { repositories: [repository()] },
    'GET /admin/agents': { agents: [agent()] },
    ...overrides,
  });

  it('is offered to an administrator', async () => {
    mockApi(page());
    renderAt('/');
    expect(await screen.findByRole('link', { name: 'Repositories' })).toBeTruthy();
  });

  it('shows the summary, status and agents, and no credentials', async () => {
    mockApi(page());
    renderAt('/admin/repositories');
    expect(await screen.findByRole('heading', { name: 'NAS' })).toBeTruthy();
    expect(screen.getByText('Healthy')).toBeTruthy();
    expect(screen.getByText('nas.example:22')).toBeTruthy();
    expect(screen.getByText('/srv/emucat')).toBeTruthy();
    expect(screen.getByText(REPOSITORY_ID)).toBeTruthy();
    expect(screen.getByText('SHA256:abcdef')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/BEGIN OPENSSH|passphrase/i);
  });

  it('asks for no secret when creating a repository', async () => {
    const api = mockApi(
      page({
        'GET /admin/repositories': { repositories: [] },
        'POST /admin/repositories': () => repository(),
      }),
    );
    renderAt('/admin/repositories');
    expect(await screen.findByRole('heading', { name: 'No repository yet' })).toBeTruthy();
    expect(screen.queryByLabelText(/key|password|passphrase/i)).toBeNull();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'NAS' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'nas.example' } });
    fireEvent.change(screen.getByLabelText('SSH user'), { target: { value: 'emucat' } });
    fireEvent.change(screen.getByLabelText('Remote root'), { target: { value: '/srv/emucat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create the repository' }));
    await waitFor(() => expect(api.callsTo('POST', '/admin/repositories').length).toBe(1));
    expect(api.callsTo('POST', '/admin/repositories')[0]?.body).toEqual({
      name: 'NAS',
      host: 'nas.example',
      port: 22,
      username: 'emucat',
      remoteRoot: '/srv/emucat',
    });
  });

  it('runs a connectivity test through the agent, and shows a failure', async () => {
    const failing = repository({
      status: 'failing',
      configurationErrors: ['Desk PC: The host key differs'],
    });
    failing.agents[0]!.errorCode = 'host_key_changed';
    failing.agents[0]!.errorMessage = 'The host key differs';
    const path = `/admin/repositories/${REPOSITORY_ID}/agents/${AGENT_ID}/health-check`;
    const api = mockApi(
      page({
        'GET /admin/repositories': { repositories: [failing] },
        [`POST ${path}`]: failing,
      }),
    );
    renderAt('/admin/repositories');
    expect(await screen.findByText('Failing')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/host key differs/);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(api.callsTo('POST', path).length).toBe(1));
  });

  it('associates an agent', async () => {
    const other = agent({ id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f99', name: 'Attic' });
    const path = `/admin/repositories/${REPOSITORY_ID}/agents/${other.id}`;
    const api = mockApi(
      page({ 'GET /admin/agents': { agents: [agent(), other] }, [`PUT ${path}`]: repository() }),
    );
    renderAt('/admin/repositories');
    fireEvent.change(await screen.findByRole('combobox', { name: 'Agent to allow' }), {
      target: { value: other.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(api.callsTo('PUT', path).length).toBe(1));
  });
});
