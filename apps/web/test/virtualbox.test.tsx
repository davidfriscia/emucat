import type {
  AgentSummary,
  DiscoveryOperation,
  ExecutionOptionsResponse,
  RegistrationOperation,
  RepositorySummary,
  VirtualBoxSource,
  VmSession,
} from '@emucat/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogNameFor } from '../src/components/VirtualBox';
import { adminVm, emptyPage, mockApi, renderAt, resetApiState, signedInAsAdmin } from './mock-api';

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
const SESSION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f73';
const MACHINE = '2acda0fc-cea6-406b-8a55-746fac380687';
const RUNNING_MACHINE = '97910566-2cc6-492b-9dc7-6cc6ee66ffd6';
const AGENT_PATH = `/admin/agents/${AGENT_ID}`;
const VM_PATH = '/admin/vms/virtualbox/xenix-386';
const OPTIONS_PATH = `${VM_PATH}/execution-options`;
const WHEN = '2026-01-31T15:30:00.000Z';
const disabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled;

function agent(): AgentSummary {
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
  };
}

function repository(): RepositorySummary {
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
  };
}

type Machine = NonNullable<DiscoveryOperation['virtualbox']>['vms'][number];
const machine = (overrides: Partial<Machine> = {}): Machine => ({
  uuid: MACHINE,
  name: 'Xenix 386',
  osType: 'Other/Unknown',
  state: 'powered_off',
  rawState: 'poweroff',
  stateChangedAt: WHEN,
  accessible: true,
  memoryMb: 4,
  cpus: 1,
  error: null,
  ...overrides,
});

function discovery(overrides: Partial<DiscoveryOperation> = {}): DiscoveryOperation {
  return {
    id: DISCOVERY_ID,
    agentId: AGENT_ID,
    status: 'completed',
    startedAt: WHEN,
    finishedAt: WHEN,
    failure: null,
    hostPlatform: 'windows',
    emulators: [],
    vms: [],
    skipped: [],
    expiresAt: null,
    fromCurrentConnection: true,
    virtualbox: {
      status: 'ok',
      version: '7.1.10r169112',
      truncated: false,
      vms: [
        machine(),
        machine({
          uuid: RUNNING_MACHINE,
          name: 'Windows XP',
          state: 'running',
          rawState: 'running',
        }),
        machine({
          uuid: '14883fa7-b01e-46cc-ba51-04f36f2d7478',
          name: '<inaccessible>',
          state: 'inaccessible',
          rawState: null,
          accessible: false,
        }),
      ],
    },
    virtualboxRegistrations: [],
    ...overrides,
  };
}

function registration(overrides: Partial<RegistrationOperation> = {}): RegistrationOperation {
  return {
    id: OPERATION_ID,
    agentId: AGENT_ID,
    agentName: 'Desk PC',
    agentOnline: true,
    repositoryId: REPOSITORY_ID,
    repositoryName: 'NAS',
    emulatorType: 'virtualbox',
    vmName: 'xenix-386',
    mode: 'copy',
    state: 'queued',
    versionId: VERSION_ID,
    parentVersionId: null,
    snapshotName: null,
    workspaceId: null,
    archiveKey: `archives/virtualbox/xenix-386/${VERSION_ID}.ova`,
    progress: { doneBytes: null, totalBytes: null },
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
    virtualboxUuid: MACHINE,
    ...overrides,
  };
}

function agentRoutes(overrides: Record<string, unknown> = {}) {
  return {
    ...signedInAsAdmin,
    [`GET ${AGENT_PATH}`]: agent(),
    [`GET ${AGENT_PATH}/discovery`]: { operation: discovery() },
    'GET /admin/repositories': { repositories: [repository()] },
    'GET /admin/registrations': { operations: [], nextCursor: null },
    ...overrides,
  };
}

async function machines() {
  renderAt(AGENT_PATH);
  const heading = await screen.findByRole('heading', { name: /VirtualBox — Discovered machines/ });
  const table = within(heading.closest('section') as HTMLElement).getByRole('table', {
    name: 'Machines registered with VirtualBox',
  });
  return within(table).getAllByRole('row').slice(1);
}

describe('registering a VirtualBox machine', () => {
  it('offers a powered-off machine, and says why the others cannot be', async () => {
    mockApi(agentRoutes());
    const [off, running, inaccessible] = await machines();
    const register = await within(off!).findByRole('button', { name: 'Register Xenix 386' });
    await waitFor(() => expect(disabled(register)).toBe(false));
    expect(disabled(within(running!).getByRole('button', { name: 'Register Windows XP' }))).toBe(
      true,
    );
    expect(within(running!).getByText('Power it off first')).toBeTruthy();
    expect(within(inaccessible!).getByText('VirtualBox cannot read it')).toBeTruthy();
  });

  it('links a machine already in the catalog instead', async () => {
    mockApi(
      agentRoutes({
        [`GET ${AGENT_PATH}/discovery`]: {
          operation: discovery({
            virtualboxRegistrations: [{ machineUuid: MACHINE, vmName: 'xenix-386' }],
          }),
        },
      }),
    );
    const [off] = await machines();
    const link = await within(off!).findByRole('link', { name: 'xenix-386' });
    expect(link.getAttribute('href')).toBe(VM_PATH);
    expect(within(off!).queryByRole('button')).toBeNull();
  });

  it('exports by UUID, as a copy, under the name chosen', async () => {
    const api = mockApi(agentRoutes({ 'POST /admin/registrations': () => registration() }));
    const [off] = await machines();
    const register = await within(off!).findByRole('button', { name: 'Register Xenix 386' });
    await waitFor(() => expect(disabled(register)).toBe(false));
    fireEvent.click(register);
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Register a VirtualBox machine' }),
    );
    expect(dialog.getByText(MACHINE)).toBeTruthy();
    expect(dialog.getByText(/NAS \(nas\.example:22\)/)).toBeTruthy();
    expect(dialog.getByText(/stay powered off until the export finishes/)).toBeTruthy();
    const name = dialog.getByLabelText('Catalog name') as HTMLInputElement;
    expect(name.value).toBe('Xenix-386');
    fireEvent.change(name, { target: { value: 'bad..' } });
    expect(disabled(dialog.getByRole('button', { name: 'Export and register' }))).toBe(true);
    fireEvent.change(name, { target: { value: 'xenix-386' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Export and register' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.callsTo('POST', '/admin/registrations')[0]?.body).toEqual({
      agentId: AGENT_ID,
      repositoryId: REPOSITORY_ID,
      emulatorType: 'virtualbox',
      vmName: 'xenix-386',
      mode: 'copy',
      discoveryOperationId: DISCOVERY_ID,
      virtualboxUuid: MACHINE,
    });
  });

  it('can be left with Escape, sending nothing', async () => {
    const api = mockApi(agentRoutes());
    const [off] = await machines();
    const register = await within(off!).findByRole('button', { name: 'Register Xenix 386' });
    await waitFor(() => expect(disabled(register)).toBe(false));
    fireEvent.click(register);
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.callsTo('POST', '/admin/registrations')).toEqual([]);
  });

  it('makes a catalog name VM names allow from any VirtualBox name', () => {
    expect(catalogNameFor('Xenix 386')).toBe('Xenix-386');
    expect(catalogNameFor('Windows XP (SP3)')).toBe('Windows-XP-SP3');
    expect(catalogNameFor('日本語')).toBe('virtualbox-vm');
  });
});

function source(overrides: Partial<VirtualBoxSource> = {}): VirtualBoxSource {
  return {
    machineUuid: MACHINE,
    agentId: AGENT_ID,
    agentName: 'Desk PC',
    agentOnline: true,
    displayName: 'Xenix 386',
    state: 'powered_off',
    rawState: 'poweroff',
    present: true,
    accessible: true,
    observedAt: WHEN,
    ...overrides,
  };
}

function session(overrides: Partial<VmSession> = {}): VmSession {
  return {
    id: SESSION_ID,
    agentId: AGENT_ID,
    agentName: 'Desk PC',
    agentOnline: true,
    emulatorType: 'virtualbox',
    vmName: 'xenix-386',
    mode: 'local',
    state: 'running',
    versionId: null,
    workspaceId: null,
    pid: null,
    processStartedAt: null,
    requestedAt: WHEN,
    startedAt: WHEN,
    endedAt: null,
    exitCode: null,
    stopRequested: false,
    forceRequested: false,
    gracefulStopAvailable: true,
    error: null,
    recovery: null,
    requestedByDisplayName: 'Ada Admin',
    updatedAt: WHEN,
    ...overrides,
  };
}

function options(
  overrides: Partial<ExecutionOptionsResponse['agents'][number]> = {},
  vbox: VirtualBoxSource | null = source(),
): ExecutionOptionsResponse {
  return {
    modes: [
      { mode: 'local', available: true, reason: null },
      { mode: 'remote_volatile', available: false, reason: 'mode_not_supported' },
      { mode: 'remote_snapshot', available: false, reason: 'mode_not_supported' },
    ],
    agents: [
      {
        agentId: AGENT_ID,
        agentName: 'Desk PC',
        online: true,
        launch: { eligible: true, reason: null, problem: null },
        verify: { eligible: false, reason: 'not_supported' },
        remote: {
          remote_volatile: { eligible: false, reason: 'mode_not_supported', problem: null },
          remote_snapshot: { eligible: false, reason: 'mode_not_supported', problem: null },
        },
        activeWorkspaceId: null,
        local: { present: false, contentStatus: null, sourceVersionId: null, lastVerifiedAt: null },
        activeSession: null,
        lastSession: null,
        lastVerification: null,
        ...overrides,
      },
    ],
    virtualbox: vbox,
  };
}

function vmRoutes(overrides: Record<string, unknown> = {}) {
  return mockApi({
    ...signedInAsAdmin,
    [`GET ${VM_PATH}`]: adminVm({
      emulatorType: 'virtualbox',
      vmName: 'xenix-386',
      displayName: 'Xenix 386',
    }),
    [`GET ${VM_PATH}/media`]: { media: [] },
    [`GET ${OPTIONS_PATH}`]: options(),
    'GET /admin/sessions': { sessions: [] },
    'GET /admin/vms': emptyPage(),
    ...overrides,
  });
}

async function runSection() {
  renderAt(VM_PATH);
  const heading = await screen.findByRole('heading', { name: 'Run in VirtualBox' });
  return within(heading.closest('section') as HTMLElement);
}

describe('running a VirtualBox VM', () => {
  it('shows the machine VirtualBox runs, and only Local', async () => {
    vmRoutes();
    const view = await runSection();
    expect(await view.findByText(MACHINE)).toBeTruthy();
    expect(view.getByText('Powered off')).toBeTruthy();
    expect(view.getByText(/Only Local/)).toBeTruthy();
    expect(view.queryByText(/^Remote Volatile$|^Remote Snapshot$/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Run and verify' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Verify|Restore/ })).toBeNull();
  });

  it('starts it locally, on the agent that registered it', async () => {
    const api = vmRoutes({ 'POST /admin/sessions': session({ state: 'requested' }) });
    const view = await runSection();
    const start = await view.findByRole('button', { name: 'Start' });
    await waitFor(() => expect(disabled(start)).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(api.callsTo('POST', '/admin/sessions')).toHaveLength(1));
    const body = api.callsTo('POST', '/admin/sessions')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      agentId: AGENT_ID,
      emulatorType: 'virtualbox',
      vmName: 'xenix-386',
      mode: 'local',
    });
    expect(body.workspaceId).toBeUndefined();
  });

  it('says why it cannot start', async () => {
    vmRoutes({
      [`GET ${OPTIONS_PATH}`]: options({
        launch: { eligible: false, reason: 'source_unavailable', problem: null },
      }),
    });
    const view = await runSection();
    expect(disabled(await view.findByRole('button', { name: 'Start' }))).toBe(true);
    expect(view.getByText(/VirtualBox no longer lists or cannot read the machine/)).toBeTruthy();
  });

  it('warns when VirtualBox no longer lists the machine', async () => {
    vmRoutes({ [`GET ${OPTIONS_PATH}`]: options({}, source({ present: false, state: null })) });
    const view = await runSection();
    expect((await view.findByRole('status')).textContent).toMatch(/no longer lists this machine/);
  });

  it('shuts a running machine down through ACPI', async () => {
    const api = vmRoutes({
      [`GET ${OPTIONS_PATH}`]: options(
        { activeSession: session() },
        source({ state: 'running', rawState: 'running' }),
      ),
      [`POST /admin/sessions/${SESSION_ID}/stop`]: session({ stopRequested: true }),
    });
    const view = await runSection();
    fireEvent.click(await view.findByRole('button', { name: 'Shut down (ACPI)' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/sessions/${SESSION_ID}/stop`)[0]?.body).toEqual({
        force: false,
      }),
    );
  });

  it('powers it off only once its name is typed', async () => {
    const api = vmRoutes({
      [`GET ${OPTIONS_PATH}`]: options(
        { activeSession: session() },
        source({ state: 'running', rawState: 'running' }),
      ),
      [`POST /admin/sessions/${SESSION_ID}/stop`]: session({ forceRequested: true }),
    });
    const view = await runSection();
    fireEvent.click(await view.findByRole('button', { name: 'Power off…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Power off xenix-386' }));
    expect(dialog.getByText(/never deleted/)).toBeTruthy();
    const confirm = dialog.getByRole('button', { name: 'Power off' });
    expect(disabled(confirm)).toBe(true);
    fireEvent.change(dialog.getByLabelText(/to confirm/), { target: { value: 'xenix-386' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/sessions/${SESSION_ID}/stop`)[0]?.body).toEqual({
        force: true,
        confirmVmName: 'xenix-386',
      }),
    );
  });
});
