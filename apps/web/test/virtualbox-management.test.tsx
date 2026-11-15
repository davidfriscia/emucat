import type {
  DiscoveryOperation,
  ExecutionOptionsResponse,
  VersionNode,
  VirtualBoxManagementResponse,
  VirtualBoxOperation,
  VirtualBoxSource,
  VmSession,
} from '@emucat/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminVm,
  apiError,
  mockApi,
  Reply,
  renderAt,
  resetApiState,
  signedInAsAdmin,
} from './mock-api';

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
const OLD_AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f64';
const DISCOVERY_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f65';
const MASTER = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f72';
const SNAPSHOT = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f74';
const IMPORT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f75';
const SESSION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f73';
const MACHINE = '2acda0fc-cea6-406b-8a55-746fac380687';
const SPARE = '3bcda0fc-cea6-406b-8a55-746fac380688';
const RUNNING_MACHINE = '97910566-2cc6-492b-9dc7-6cc6ee66ffd6';
const IMPORTED = '5b0a7f0e-91c4-4d8e-b0c2-0f5f8d0a1e11';
const VM_PATH = '/admin/vms/virtualbox/xenix-386';
const MANAGEMENT_PATH = `${VM_PATH}/virtualbox`;
const WHEN = '2026-11-15T10:00:00.000Z';
const SHA = 'a'.repeat(64);
const disabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled;

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

function operation(overrides: Partial<VirtualBoxOperation> = {}): VirtualBoxOperation {
  return {
    id: IMPORT_ID,
    kind: 'import',
    state: 'succeeded',
    stage: null,
    agentId: AGENT_ID,
    agentName: 'Desk PC',
    vmName: 'xenix-386',
    versionId: MASTER,
    targetName: 'Xenix 386 (Master)',
    machineUuid: IMPORTED,
    machineName: 'Xenix 386 (Master)',
    machineState: 'powered_off',
    previousMachineUuid: null,
    strayMachines: [],
    filesRemoved: null,
    progress: { doneBytes: null, totalBytes: null },
    error: null,
    requestedByDisplayName: 'Ada Admin',
    createdAt: WHEN,
    updatedAt: WHEN,
    finishedAt: WHEN,
    ...overrides,
  };
}

function management(
  overrides: Partial<VirtualBoxManagementResponse> = {},
): VirtualBoxManagementResponse {
  return {
    source: source(),
    sourceVersionId: MASTER,
    agents: [
      { agentId: AGENT_ID, agentName: 'Desk PC', online: true, virtualbox: true, management: true },
      {
        agentId: OLD_AGENT_ID,
        agentName: 'Old PC',
        online: true,
        virtualbox: true,
        management: false,
      },
    ],
    operations: [],
    ...overrides,
  };
}

function version(
  id: string,
  parent: string | null,
  overrides: Partial<VersionNode> = {},
): VersionNode {
  return {
    id,
    kind: parent === null ? 'master' : 'snapshot',
    parentVersionId: parent,
    childVersionIds: parent === null ? [SNAPSHOT] : [],
    snapshotName: parent === null ? null : 'xenix-386_202611151000',
    createdAt: WHEN,
    archiveSizeBytes: 4096,
    archiveSha256: SHA,
    manifest: null,
    repositoryName: 'NAS',
    available: true,
    createdByAgentName: 'Desk PC',
    createdByDisplayName: 'Ada Admin',
    holders: [],
    deletion: null,
    deletable:
      parent === null
        ? { eligible: false, reason: 'master_cannot_be_deleted' }
        : { eligible: true, reason: null },
    ...overrides,
  };
}

function options(): ExecutionOptionsResponse {
  return {
    modes: [
      { mode: 'local', available: true, reason: null },
      { mode: 'remote_volatile', available: false, reason: 'mode_not_supported' },
      { mode: 'remote_snapshot', available: false, reason: 'mode_not_supported' },
    ],
    agents: [],
    virtualbox: source(),
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
    emulators: [],
    vms: [],
    skipped: [],
    expiresAt: '2030-01-01T00:00:00.000Z',
    fromCurrentConnection: true,
    virtualbox: {
      status: 'ok',
      version: '7.1.4',
      truncated: false,
      vms: [
        machine(MACHINE, 'Xenix 386', 'powered_off'),
        machine(SPARE, 'Xenix spare', 'powered_off'),
        machine(RUNNING_MACHINE, 'Windows XP', 'running'),
      ],
    },
    virtualboxRegistrations: [{ machineUuid: MACHINE, vmName: 'xenix-386' }],
  };
}

function machine(uuid: string, name: string, state: 'powered_off' | 'running') {
  return {
    uuid,
    name,
    state,
    rawState: state === 'running' ? 'running' : 'poweroff',
    stateChangedAt: WHEN,
    osType: null,
    accessible: true,
    memoryMb: 64,
    cpus: 1,
    error: null,
  } as NonNullable<DiscoveryOperation['virtualbox']>['vms'][number];
}

function routes(overrides: Record<string, unknown> = {}) {
  return mockApi({
    ...signedInAsAdmin,
    [`GET ${VM_PATH}`]: adminVm({
      emulatorType: 'virtualbox',
      vmName: 'xenix-386',
      displayName: 'Xenix 386',
    }),
    [`GET ${VM_PATH}/media`]: { media: [] },
    [`GET ${VM_PATH}/execution-options`]: options(),
    [`GET ${MANAGEMENT_PATH}`]: management(),
    [`GET ${VM_PATH}/versions`]: {
      emulatorType: 'virtualbox',
      vmName: 'xenix-386',
      rootVersionId: MASTER,
      versions: [version(MASTER, null), version(SNAPSHOT, MASTER)],
    },
    [`GET ${VM_PATH}/workspaces`]: { workspaces: [] },
    [`GET ${VM_PATH}/restore-options`]: { agents: [] },
    'GET /admin/sessions': { sessions: [] },
    [`GET /admin/agents/${AGENT_ID}/discovery`]: { operation: discovery() },
    ...overrides,
  });
}

async function machineSection() {
  renderAt(VM_PATH);
  const heading = await screen.findByRole('heading', { name: 'VirtualBox machine' });
  const section = within(heading.closest('section') as HTMLElement);
  await section.findByText('Linked to');
  return section;
}

describe('the machine of a VirtualBox VM', () => {
  it('shows the linked machine by UUID, and what can be done with it', async () => {
    routes();
    const view = await machineSection();
    expect(view.getByText(MACHINE)).toBeTruthy();
    expect(disabled(view.getByRole('button', { name: 'Change machine…' }))).toBe(false);
    expect(disabled(view.getByRole('button', { name: 'Unlink…' }))).toBe(false);
    expect(disabled(view.getByRole('button', { name: 'Delete from VirtualBox…' }))).toBe(false);
  });

  it('changes nothing about a running machine', async () => {
    routes({
      [`GET ${MANAGEMENT_PATH}`]: management({ source: source({ state: 'running' }) }),
    });
    const view = await machineSection();
    for (const name of ['Change machine…', 'Unlink…', 'Delete from VirtualBox…']) {
      expect(disabled(view.getByRole('button', { name })), name).toBe(true);
    }
    expect(view.getByText(/Power the machine off first/)).toBeTruthy();
  });

  it('relinks to a machine the discovery saw, naming the link it replaces', async () => {
    const api = routes({
      [`POST ${MANAGEMENT_PATH}/link`]: operation({ kind: 'relink', machineUuid: SPARE }),
    });
    const view = await machineSection();
    fireEvent.click(view.getByRole('button', { name: 'Change machine…' }));
    const dialog = within(await screen.findByRole('dialog'));
    const spare = await dialog.findByLabelText(/Xenix spare/);
    // The linked machine and a running one cannot be chosen.
    expect((dialog.getByLabelText(/Windows XP/) as HTMLInputElement).disabled).toBe(true);
    expect((dialog.getByLabelText(/Linked to this VM now/) as HTMLInputElement).disabled).toBe(
      true,
    );
    const submit = dialog.getByRole('button', { name: 'Replace link' });
    expect(disabled(submit)).toBe(true);
    fireEvent.click(spare);
    fireEvent.click(submit);
    await waitFor(() => expect(api.callsTo('POST', `${MANAGEMENT_PATH}/link`)).toHaveLength(1));
    expect(api.callsTo('POST', `${MANAGEMENT_PATH}/link`)[0]?.body).toEqual({
      agentId: AGENT_ID,
      machineUuid: SPARE,
      discoveryOperationId: DISCOVERY_ID,
      replaceMachineUuid: MACHINE,
    });
  });

  it('unlinks only once confirmed, by UUID', async () => {
    const api = routes({
      [`POST ${MANAGEMENT_PATH}/unlink`]: operation({ kind: 'unlink', machineUuid: MACHINE }),
    });
    const view = await machineSection();
    fireEvent.click(view.getByRole('button', { name: 'Unlink…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Unlink xenix-386' }));
    expect(dialog.getByText(/stays in VirtualBox, unchanged/)).toBeTruthy();
    expect(api.callsTo('POST', `${MANAGEMENT_PATH}/unlink`)).toHaveLength(0);
    fireEvent.click(dialog.getByRole('button', { name: 'Unlink' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `${MANAGEMENT_PATH}/unlink`)[0]?.body).toEqual({
        machineUuid: MACHINE,
      }),
    );
  });

  it('deletes from VirtualBox only once the exact name is typed', async () => {
    const api = routes({
      [`POST ${MANAGEMENT_PATH}/delete`]: new Reply(
        202,
        operation({ kind: 'delete', state: 'queued', machineUuid: MACHINE }),
      ),
    });
    const view = await machineSection();
    fireEvent.click(view.getByRole('button', { name: 'Delete from VirtualBox…' }));
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Delete Xenix 386 from VirtualBox' }),
    );
    expect(dialog.getByRole('alert').textContent).toMatch(/cannot be undone/);
    expect(dialog.getByText(/Every version, OVA and screenshot of xenix-386 is kept/)).toBeTruthy();
    const confirm = dialog.getByRole('button', { name: 'Delete from VirtualBox' });
    const input = dialog.getByLabelText(/exactly to confirm/);
    // The catalog name, or the right name in the wrong case, is not enough.
    for (const typed of ['xenix-386', 'xenix 386', 'Xenix 386 ']) {
      fireEvent.change(input, { target: { value: typed } });
      expect(disabled(confirm), typed).toBe(true);
    }
    fireEvent.change(input, { target: { value: 'Xenix 386' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.callsTo('POST', `${MANAGEMENT_PATH}/delete`)).toHaveLength(1));
    const body = api.callsTo('POST', `${MANAGEMENT_PATH}/delete`)[0]?.body as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      agentId: AGENT_ID,
      machineUuid: MACHINE,
      confirmMachineName: 'Xenix 386',
    });
    expect(typeof body.requestId).toBe('string');
  });

  it('shows why the server refused a deletion', async () => {
    routes({
      [`POST ${MANAGEMENT_PATH}/delete`]: apiError(
        409,
        'vm_not_powered_off',
        'The machine is not powered off.',
      ),
    });
    const view = await machineSection();
    fireEvent.click(view.getByRole('button', { name: 'Delete from VirtualBox…' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(/exactly to confirm/), {
      target: { value: 'Xenix 386' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Delete from VirtualBox' }));
    expect(await dialog.findByText(/not powered off/)).toBeTruthy();
  });

  it('offers to link an imported machine, and never links it by itself', async () => {
    const api = routes({
      [`GET ${MANAGEMENT_PATH}`]: management({ operations: [operation()] }),
      [`POST ${MANAGEMENT_PATH}/link`]: operation({ kind: 'relink' }),
    });
    const view = await machineSection();
    expect(api.callsTo('POST', `${MANAGEMENT_PATH}/link`)).toHaveLength(0);
    fireEvent.click(await view.findByRole('button', { name: 'Replace link with this machine…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Replace the link' }));
    expect(dialog.getByText(/stays in VirtualBox, unchanged/)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'Replace link' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `${MANAGEMENT_PATH}/link`)[0]?.body).toEqual({
        agentId: AGENT_ID,
        machineUuid: IMPORTED,
        importOperationId: IMPORT_ID,
        replaceMachineUuid: MACHINE,
      }),
    );
  });

  it('reports an uncertain import and the machines it may have left, offering nothing to link', async () => {
    routes({
      [`GET ${MANAGEMENT_PATH}`]: management({
        operations: [
          operation({
            state: 'uncertain',
            machineUuid: null,
            machineName: null,
            error: { code: 'import_ambiguous', message: 'Several machines appeared.' },
            strayMachines: [{ uuid: IMPORTED, name: 'Xenix 386 (Master)', state: 'powered_off' }],
          }),
        ],
      }),
    });
    const view = await machineSection();
    expect((await view.findByRole('alert')).textContent).toMatch(/EmuCat removes none of them/);
    expect(view.getByText(IMPORTED)).toBeTruthy();
    expect(view.queryByRole('button', { name: /Link this machine|Replace link with/ })).toBeNull();
  });
});

describe('importing a version into VirtualBox', () => {
  it('imports under a valid name, on an agent that can, and links nothing', async () => {
    const api = routes({
      [`POST ${VM_PATH}/versions/${MASTER}/virtualbox-import`]: new Reply(
        202,
        operation({ state: 'queued', machineUuid: null, machineName: null }),
      ),
    });
    renderAt(VM_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Import Master into VirtualBox' }));
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Import Master into VirtualBox' }),
    );
    // An agent that predates management is not offered.
    const agent = dialog.getByLabelText('Agent') as HTMLSelectElement;
    expect([...agent.options].map((option) => option.textContent)).toEqual(['Desk PC']);
    const name = dialog.getByLabelText('Name in VirtualBox') as HTMLInputElement;
    expect(name.value).toBe('Xenix 386 (Master)');
    const submit = dialog.getByRole('button', { name: 'Import' });
    fireEvent.change(name, { target: { value: '--vsys=1' } });
    expect(disabled(submit)).toBe(true);
    fireEvent.change(name, { target: { value: 'C:\\Windows' } });
    expect(disabled(submit)).toBe(true);
    fireEvent.change(name, { target: { value: 'Xenix test' } });
    fireEvent.click(submit);
    const path = `${VM_PATH}/versions/${MASTER}/virtualbox-import`;
    await waitFor(() => expect(api.callsTo('POST', path)).toHaveLength(1));
    const body = api.callsTo('POST', path)[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ agentId: AGENT_ID, targetName: 'Xenix test' });
    expect(typeof body.requestId).toBe('string');
    expect(api.callsTo('POST', `${MANAGEMENT_PATH}/link`)).toHaveLength(0);
  });

  it('cannot import while another operation runs', async () => {
    routes({
      [`GET ${MANAGEMENT_PATH}`]: management({
        operations: [operation({ state: 'running', stage: 'downloading' })],
      }),
    });
    renderAt(VM_PATH);
    const button = await screen.findByRole('button', { name: 'Import Master into VirtualBox' });
    await waitFor(() => expect(disabled(button)).toBe(true));
  });
});

describe('a snapshot of a VirtualBox VM', () => {
  it('is offered from the version the linked machine comes from, when it is powered off', async () => {
    const api = routes({
      [`POST ${VM_PATH}/snapshots`]: {
        id: IMPORT_ID,
      },
    });
    renderAt(VM_PATH);
    const create = await screen.findByRole('button', {
      name: 'Create snapshot of Xenix 386 from Master',
    });
    // Only from the machine's own version.
    expect(screen.queryAllByRole('button', { name: /^Create snapshot of/ })).toHaveLength(1);
    fireEvent.click(create);
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/VirtualBox snapshots are neither made nor used/)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'Create snapshot' }));
    await waitFor(() => expect(api.callsTo('POST', `${VM_PATH}/snapshots`)).toHaveLength(1));
    expect(api.callsTo('POST', `${VM_PATH}/snapshots`)[0]?.body).toMatchObject({
      agentId: AGENT_ID,
      parentVersionId: MASTER,
    });
  });

  it('is not offered while the machine runs, nor without a linked machine', async () => {
    routes({
      [`GET ${MANAGEMENT_PATH}`]: management({ source: source({ state: 'running' }) }),
    });
    renderAt(VM_PATH);
    const create = await screen.findByRole('button', {
      name: 'Create snapshot of Xenix 386 from Master',
    });
    expect(disabled(create)).toBe(true);
    expect(screen.getByText(/Power the machine off to create a snapshot/)).toBeTruthy();
  });
});

describe('a screenshot of a VirtualBox session', () => {
  function running(): VmSession {
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
    };
  }

  it('can be captured from the running session', async () => {
    const execution = options();
    execution.agents = [
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
        activeSession: running(),
        lastSession: null,
        lastVerification: null,
      },
    ] as ExecutionOptionsResponse['agents'];
    const api = routes({
      [`GET ${VM_PATH}/execution-options`]: execution,
      [`GET /admin/sessions/${SESSION_ID}/screenshots`]: {
        available: true,
        reason: null,
        operation: null,
      },
      [`POST /admin/sessions/${SESSION_ID}/screenshots`]: new Reply(202, {
        id: IMPORT_ID,
        sessionId: SESSION_ID,
        state: 'requested',
        sha256: null,
        mediaId: null,
        code: null,
        message: null,
        retryAttempts: 0,
        createdAt: WHEN,
        updatedAt: WHEN,
      }),
    });
    renderAt(VM_PATH);
    const capture = within(
      await screen.findByRole('region', { name: 'VirtualBox screenshot capture' }),
    );
    const button = capture.getByRole('button', { name: 'Capture screenshot' });
    await waitFor(() => expect(disabled(button)).toBe(false));
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/sessions/${SESSION_ID}/screenshots`)).toHaveLength(1),
    );
  });
});
