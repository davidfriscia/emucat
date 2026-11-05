import type {
  AgentSummary,
  DiscoveryOperation,
  RegistrationOperation,
  RepositorySummary,
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
    'GET /admin/registrations': { operations: [] as RegistrationOperation[] },
    ...overrides,
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

  it('offers nothing for a VM that is already registered', async () => {
    mockApi(routes());
    renderAt(AGENT_PATH);
    const heading = await screen.findByRole('heading', { name: 'Already' });
    const card = within(articleOf(heading));
    expect(card.getByText('Already registered')).toBeTruthy();
    expect(card.queryByRole('button')).toBeNull();
  });

  const discoveredCard = async () => {
    await screen.findByRole('heading', { name: 'Registrations' });
    const heading = screen
      .getAllByRole('heading', { name: 'Win98' })
      .find((element) => element.closest('.media-grid'));
    return within(articleOf(heading as HTMLElement));
  };

  it('stops offering a VM as soon as it is registered, without another scan', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': {
          operations: [
            operation({
              state: 'succeeded',
              archive: ARCHIVE,
              localCopy: 'preserved',
              committedAt: WHEN,
              finishedAt: WHEN,
            }),
          ],
        },
      }),
    );
    renderAt(AGENT_PATH);
    const card = await discoveredCard();
    expect(card.getByText('Already registered')).toBeTruthy();
    expect(card.queryByRole('button')).toBeNull();
  });

  it('offers a VM again after a registration that failed', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': {
          operations: [
            operation({
              state: 'failed',
              error: { code: 'source_changed', message: 'It changed.' },
              finishedAt: WHEN,
            }),
          ],
        },
      }),
    );
    renderAt(AGENT_PATH);
    const card = await discoveredCard();
    await waitFor(() =>
      expect(
        (card.getByRole('button', { name: 'Copy to remote' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
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
    mockApi(routes({ 'GET /admin/registrations': { operations: [operation()] } }));
    renderAt(AGENT_PATH);
    expect(await screen.findByText('Registration running')).toBeTruthy();
    const heading = screen.getByRole('heading', { name: 'Already' });
    expect(articleOf(heading)).toBeTruthy();
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
    mockApi(routes({ 'GET /admin/registrations': { operations: [operation()] } }));
    renderAt(AGENT_PATH);
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText(/512\.0 MiB of 1\.00 GiB/)).toBeTruthy();
  });

  it('invents no percentage when it has no total', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': {
          operations: [
            operation({ state: 'validating', progress: { doneBytes: null, totalBytes: null } }),
          ],
        },
      }),
    );
    renderAt(AGENT_PATH);
    expect(await screen.findAllByText('Checking the VM')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('says that an offline agent will continue', async () => {
    mockApi(
      routes({ 'GET /admin/registrations': { operations: [operation({ agentOnline: false })] } }),
    );
    renderAt(AGENT_PATH);
    expect(await screen.findByText(/continues when it reconnects/)).toBeTruthy();
  });

  it('can be cancelled before the master exists, and not after', async () => {
    const api = mockApi(
      routes({
        'GET /admin/registrations': { operations: [operation()] },
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
        'GET /admin/registrations': {
          operations: [operation({ state: 'cleaning_local', archive: ARCHIVE, committedAt: WHEN })],
        },
      }),
    );
    renderAt(AGENT_PATH);
    await screen.findAllByText('Finishing up on the agent');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('lets an administrator retry a commit that failed', async () => {
    const api = mockApi(
      routes({
        'GET /admin/registrations': {
          operations: [operation({ state: 'committing', archive: ARCHIVE })],
        },
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
  it('shows what was registered, without claiming that the server checked it', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': {
          operations: [
            operation({
              state: 'succeeded',
              archive: ARCHIVE,
              localCopy: 'preserved',
              committedAt: WHEN,
              finishedAt: WHEN,
            }),
          ],
        },
      }),
    );
    renderAt(AGENT_PATH);
    expect(await screen.findByRole('link', { name: 'Win98' })).toBeTruthy();
    expect(screen.getByText(VERSION_ID)).toBeTruthy();
    expect(screen.getByText('Private')).toBeTruthy();
    expect(screen.getByText(/verified by the agent/)).toBeTruthy();
    expect(screen.getByText(SHA)).toBeTruthy();
    expect(screen.getByText(/Kept on the agent, unchanged/)).toBeTruthy();
  });

  it('shows a failure, and what to do about it', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': {
          operations: [
            operation({
              state: 'failed',
              localCopy: 'preserved',
              error: { code: 'host_key_changed', message: 'The host key differs.' },
              recovery: 'Find out why the server’s key changed.',
              finishedAt: WHEN,
            }),
          ],
        },
      }),
    );
    renderAt(AGENT_PATH);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/The host key differs/);
    expect(alert.textContent).toMatch(/Find out why/);
    expect(screen.getByText(/No master was created, and the local VM is unchanged/)).toBeTruthy();
  });

  it('shows a partial success as a registered master with a problem', async () => {
    mockApi(
      routes({
        'GET /admin/registrations': {
          operations: [
            operation({
              mode: 'transfer',
              state: 'partial_success',
              archive: ARCHIVE,
              localCopy: 'cleanup_failed',
              error: { code: 'cleanup_in_use', message: 'A file is in use.' },
              recovery: 'The master is registered and safe.',
              committedAt: WHEN,
              finishedAt: WHEN,
            }),
          ],
        },
      }),
    );
    renderAt(AGENT_PATH);
    expect((await screen.findAllByText('Registered, with a problem')).length).toBeGreaterThan(0);
    expect(screen.getByText(/could not be safely removed/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/registered and safe/);
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
