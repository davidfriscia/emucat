import type {
  DiscoveryOperation,
  ExecutionOptionsResponse,
  VersionNode,
  VirtualBoxManagementResponse,
  VirtualBoxOperation,
  VirtualBoxSource,
  VmSession,
} from '@emucat/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    autoLink: null,
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
    title: null,
    description: null,
    tags: [],
    promotedAt: null,
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

/** Ten minutes either side of now: inside and outside the server's validity window, whenever the test runs. */
const soon = () => new Date(Date.now() + 10 * 60_000).toISOString();
const ago = () => new Date(Date.now() - 10 * 60_000).toISOString();

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
    expiresAt: soon(),
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
    ...overrides,
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

describe('linking a machine from the latest discovery', () => {
  const DISCOVERY_PATH = `/admin/agents/${AGENT_ID}/discovery`;
  const OLD_DISCOVERY_PATH = `/admin/agents/${OLD_AGENT_ID}/discovery`;

  async function openLinkDialog(button = 'Change machine…') {
    renderAt(VM_PATH);
    fireEvent.click(await screen.findByRole('button', { name: button }));
    return within(await screen.findByRole('dialog'));
  }

  async function expectGuidance(
    dialog: ReturnType<typeof within>,
    title: string,
    submit = 'Replace link',
  ) {
    const status = await dialog.findByText(title);
    expect(dialog.queryAllByRole('radio')).toHaveLength(0);
    expect(disabled(dialog.getByRole('button', { name: submit }))).toBe(true);
    const link = dialog.getByRole('link', { name: 'Go to Agent page' });
    expect(link.getAttribute('href')).toBe(`/admin/agents/${AGENT_ID}`);
    return status;
  }

  it('explains what to do when the agent has no discovery', async () => {
    routes({
      [`GET ${MANAGEMENT_PATH}`]: management({ source: null }),
      [`GET ${DISCOVERY_PATH}`]: { operation: null },
    });
    const dialog = await openLinkDialog('Link a machine…');
    await expectGuidance(dialog, 'No recent VirtualBox discovery available', 'Link');
    expect(dialog.getByText(/open the Agent page and run VirtualBox discovery/)).toBeTruthy();
  });

  it('does not offer the machines of an expired discovery', async () => {
    routes({ [`GET ${DISCOVERY_PATH}`]: { operation: discovery({ expiresAt: ago() }) } });
    const dialog = await openLinkDialog();
    await expectGuidance(dialog, 'No recent VirtualBox discovery available');
    expect(dialog.queryByText(/Xenix spare/)).toBeNull();
  });

  it('treats a discovery without a readable expiry as expired', async () => {
    routes({ [`GET ${DISCOVERY_PATH}`]: { operation: discovery({ expiresAt: null }) } });
    const dialog = await openLinkDialog();
    await expectGuidance(dialog, 'No recent VirtualBox discovery available');
  });

  it('does not offer the machines of a discovery from an earlier connection', async () => {
    routes({
      [`GET ${DISCOVERY_PATH}`]: { operation: discovery({ fromCurrentConnection: false }) },
    });
    const dialog = await openLinkDialog();
    await expectGuidance(dialog, 'No recent VirtualBox discovery available');
    expect(dialog.queryByText(/Xenix spare/)).toBeNull();
  });

  it('says a running discovery is not complete yet', async () => {
    routes({
      [`GET ${DISCOVERY_PATH}`]: {
        operation: discovery({ status: 'running', finishedAt: null, expiresAt: null }),
      },
    });
    const dialog = await openLinkDialog();
    await expectGuidance(dialog, 'VirtualBox discovery is not complete');
    expect(dialog.getByText(/return when it has finished/)).toBeTruthy();
  });

  it('says a failed discovery failed, and to run it again', async () => {
    routes({
      [`GET ${DISCOVERY_PATH}`]: {
        operation: discovery({
          status: 'failed',
          expiresAt: null,
          failure: { code: 'timeout', message: 'The agent did not answer in time.' },
        }),
      },
    });
    const dialog = await openLinkDialog();
    await expectGuidance(dialog, 'The latest VirtualBox discovery failed');
    expect(dialog.getByText('The agent did not answer in time.')).toBeTruthy();
    expect(dialog.getByText(/run VirtualBox discovery again/)).toBeTruthy();
  });

  it('offers the eligible machines of a valid discovery, and links only once one is chosen', async () => {
    routes();
    const dialog = await openLinkDialog();
    const spare = await dialog.findByLabelText(/Xenix spare/);
    expect(dialog.queryByText('No recent VirtualBox discovery available')).toBeNull();
    expect(dialog.queryByRole('link', { name: 'Go to Agent page' })).toBeNull();
    const submit = dialog.getByRole('button', { name: 'Replace link' });
    expect(disabled(submit)).toBe(true);
    fireEvent.click(spare);
    expect(disabled(submit)).toBe(false);
  });

  it('says so when no machine of the discovery can be linked, and still says why for each', async () => {
    routes({
      [`GET ${DISCOVERY_PATH}`]: {
        operation: discovery({
          virtualboxRegistrations: [
            { machineUuid: MACHINE, vmName: 'xenix-386' },
            { machineUuid: SPARE, vmName: 'os2-warp' },
          ],
        }),
      },
    });
    const dialog = await openLinkDialog();
    expect(
      await dialog.findByText(
        'No eligible VirtualBox machines were found in the latest discovery.',
      ),
    ).toBeTruthy();
    expect(dialog.getByText(/Linked to this VM now/)).toBeTruthy();
    expect(dialog.getByText(/Linked to os2-warp/)).toBeTruthy();
    expect(dialog.getByText(/Power it off first/)).toBeTruthy();
    expect(disabled(dialog.getByRole('button', { name: 'Replace link' }))).toBe(true);
  });

  it('reads the other agent’s discovery when the agent changes, and forgets the choice', async () => {
    const api = routes({
      [`GET ${OLD_DISCOVERY_PATH}`]: { operation: null },
    });
    const dialog = await openLinkDialog();
    fireEvent.click(await dialog.findByLabelText(/Xenix spare/));
    const submit = dialog.getByRole('button', { name: 'Replace link' });
    expect(disabled(submit)).toBe(false);
    fireEvent.change(dialog.getByLabelText('Agent'), { target: { value: OLD_AGENT_ID } });
    expect(await dialog.findByText('No recent VirtualBox discovery available')).toBeTruthy();
    expect(api.callsTo('GET', OLD_DISCOVERY_PATH)).toHaveLength(1);
    expect(dialog.getByRole('link', { name: 'Go to Agent page' }).getAttribute('href')).toBe(
      `/admin/agents/${OLD_AGENT_ID}`,
    );
    expect(disabled(submit)).toBe(true);
    // Back to the first agent: its discovery is read again, and nothing is chosen.
    fireEvent.change(dialog.getByLabelText('Agent'), { target: { value: AGENT_ID } });
    const spare = (await dialog.findByLabelText(/Xenix spare/)) as HTMLInputElement;
    expect(spare.checked).toBe(false);
    expect(disabled(submit)).toBe(true);
    expect(api.callsTo('GET', DISCOVERY_PATH)).toHaveLength(2);
  });

  it('reads the discovery again each time the dialog opens', async () => {
    let reply: unknown = { operation: null };
    const api = routes({ [`GET ${DISCOVERY_PATH}`]: () => reply });
    const view = await machineSection();
    fireEvent.click(view.getByRole('button', { name: 'Change machine…' }));
    let dialog = within(await screen.findByRole('dialog'));
    await dialog.findByText('No recent VirtualBox discovery available');
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Discovery was run on the agent's page in the meantime.
    reply = { operation: discovery() };
    fireEvent.click(view.getByRole('button', { name: 'Change machine…' }));
    dialog = within(await screen.findByRole('dialog'));
    expect(await dialog.findByLabelText(/Xenix spare/)).toBeTruthy();
    expect(api.callsTo('GET', DISCOVERY_PATH)).toHaveLength(2);
  });

  it('runs no discovery from the dialog, and leads to the agent’s page', async () => {
    const api = routes({
      [`GET ${DISCOVERY_PATH}`]: { operation: null },
      [`GET /admin/agents/${AGENT_ID}`]: new Promise(() => undefined),
    });
    const dialog = await openLinkDialog();
    const link = await dialog.findByRole('link', { name: 'Go to Agent page' });
    expect(dialog.queryByRole('button', { name: /discover/i })).toBeNull();
    fireEvent.click(link);
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(`/admin/agents/${AGENT_ID}`),
    );
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('chooses no agent for the user when the linked machine’s agent cannot be used', async () => {
    const api = routes({
      [`GET ${MANAGEMENT_PATH}`]: management({
        source: source({ agentId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f99', agentName: 'Gone PC' }),
      }),
      [`GET ${OLD_DISCOVERY_PATH}`]: { operation: discovery({ agentId: OLD_AGENT_ID }) },
    });
    const dialog = await openLinkDialog();
    const select = dialog.getByLabelText('Agent') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(dialog.getByText(/Gone PC cannot link a VirtualBox machine now/)).toBeTruthy();
    expect(api.calls.filter((call) => call.path.endsWith('/discovery'))).toHaveLength(0);
    fireEvent.change(select, { target: { value: OLD_AGENT_ID } });
    expect(await dialog.findByLabelText(/Xenix spare/)).toBeTruthy();
  });

  it('says when no agent can link a machine at all', async () => {
    routes({ [`GET ${MANAGEMENT_PATH}`]: management({ source: null, agents: [] }) });
    const dialog = await openLinkDialog('Link a machine…');
    expect(dialog.getByText('No agent can link a VirtualBox machine')).toBeTruthy();
    expect(dialog.getByRole('link', { name: 'Go to Agents page' }).getAttribute('href')).toBe(
      '/admin/agents',
    );
    expect(disabled(dialog.getByRole('button', { name: 'Link' }))).toBe(true);
  });

  it('leaves linking an imported machine from its history as it was, without discovery', async () => {
    const api = routes({
      [`GET ${MANAGEMENT_PATH}`]: management({ source: null, operations: [operation()] }),
      [`GET ${DISCOVERY_PATH}`]: { operation: null },
      [`POST ${MANAGEMENT_PATH}/link`]: operation({ kind: 'link' }),
    });
    renderAt(VM_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Link this machine…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Link the imported machine' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Link' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `${MANAGEMENT_PATH}/link`)[0]?.body).toEqual({
        agentId: AGENT_ID,
        machineUuid: IMPORTED,
        importOperationId: IMPORT_ID,
        replaceMachineUuid: null,
      }),
    );
    expect(api.calls.filter((call) => call.path.endsWith('/discovery'))).toHaveLength(0);
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
    // The VM has a machine, and replacing it was not chosen: it stays linked.
    expect(body).toMatchObject({
      agentId: AGENT_ID,
      targetName: 'Xenix test',
      replaceMachineUuid: MACHINE,
      replaceSource: false,
    });
    expect(typeof body.requestId).toBe('string');
    expect(api.callsTo('POST', `${MANAGEMENT_PATH}/link`)).toHaveLength(0);
  });

  it('links the new machine by itself when the VM has none', async () => {
    const api = routes({
      [`GET ${MANAGEMENT_PATH}`]: management({ source: null, sourceVersionId: null }),
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
    expect(dialog.getByText(/the new machine is linked to xenix-386/)).toBeTruthy();
    expect(dialog.queryByLabelText(/Replace this link/)).toBeNull();
    fireEvent.click(dialog.getByRole('button', { name: 'Import' }));
    const path = `${VM_PATH}/versions/${MASTER}/virtualbox-import`;
    await waitFor(() => expect(api.callsTo('POST', path)).toHaveLength(1));
    expect(api.callsTo('POST', path)[0]?.body).toMatchObject({
      replaceMachineUuid: null,
      replaceSource: false,
    });
  });

  it('replaces the linked machine only once that is explicitly confirmed', async () => {
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
    // The current link is named by its UUID, and kept unless replacing it is chosen.
    expect(dialog.getByText(MACHINE)).toBeTruthy();
    expect((dialog.getByLabelText(/Keep this link/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(dialog.getByLabelText('Replace this link with the new machine'));
    expect(dialog.getByText(/is not deleted or changed/)).toBeTruthy();
    const submit = dialog.getByRole('button', { name: 'Import and replace link' });
    expect(disabled(submit)).toBe(true);
    fireEvent.click(dialog.getByLabelText('Replace the link to Xenix 386'));
    expect(disabled(submit)).toBe(false);
    fireEvent.click(submit);
    const path = `${VM_PATH}/versions/${MASTER}/virtualbox-import`;
    await waitFor(() => expect(api.callsTo('POST', path)).toHaveLength(1));
    expect(api.callsTo('POST', path)[0]?.body).toMatchObject({
      replaceMachineUuid: MACHINE,
      replaceSource: true,
    });
  });

  it('cannot replace a machine that is not powered off', async () => {
    const api = routes({
      [`GET ${MANAGEMENT_PATH}`]: management({ source: source({ state: 'running' }) }),
    });
    renderAt(VM_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Import Master into VirtualBox' }));
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Import Master into VirtualBox' }),
    );
    fireEvent.click(dialog.getByLabelText('Replace this link with the new machine'));
    expect(dialog.getByText(/It is not powered off/)).toBeTruthy();
    expect(disabled(dialog.getByLabelText('Replace the link to Xenix 386'))).toBe(true);
    expect(disabled(dialog.getByRole('button', { name: 'Import and replace link' }))).toBe(true);
    expect(api.callsTo('POST', `${VM_PATH}/versions/${MASTER}/virtualbox-import`)).toHaveLength(0);
  });

  it('reports an import whose link failed, and retries only the link', async () => {
    const failed = operation({
      autoLink: {
        intent: 'link',
        state: 'failed',
        linkOperationId: null,
        error: { code: 'virtualbox_already_registered', message: 'Linked to another VM.' },
      },
    });
    const api = routes({
      [`GET ${MANAGEMENT_PATH}`]: management({ source: null, operations: [failed] }),
      [`POST ${MANAGEMENT_PATH}/operations/${IMPORT_ID}/link`]: operation({
        autoLink: { intent: 'link', state: 'linked', linkOperationId: SPARE, error: null },
      }),
    });
    renderAt(VM_PATH);
    const alert = within(await screen.findByText(/Imported, but not linked/)).getByText(
      /Imported, but not linked/,
    ).parentElement as HTMLElement;
    expect(alert.textContent).toMatch(/virtualbox_already_registered/);
    expect(alert.textContent).toMatch(/does not import again/);
    const optionsBefore = api.callsTo('GET', `${VM_PATH}/execution-options`).length;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry linking' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `${MANAGEMENT_PATH}/operations/${IMPORT_ID}/link`)).toHaveLength(
        1,
      ),
    );
    // The run panel hears that the machine changed.
    await waitFor(() =>
      expect(api.callsTo('GET', `${VM_PATH}/execution-options`).length).toBeGreaterThan(
        optionsBefore,
      ),
    );
    expect(api.callsTo('POST', `${VM_PATH}/versions/${MASTER}/virtualbox-import`)).toHaveLength(0);
  });

  it('shows an import that linked its machine', async () => {
    routes({
      [`GET ${MANAGEMENT_PATH}`]: management({
        source: source({ machineUuid: IMPORTED, displayName: 'Xenix 386 (Master)' }),
        operations: [
          operation({
            previousMachineUuid: MACHINE,
            autoLink: { intent: 'relink', state: 'linked', linkOperationId: SPARE, error: null },
          }),
        ],
      }),
    });
    renderAt(VM_PATH);
    expect(await screen.findByText('Linked automatically')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry linking' })).toBeNull();
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

describe('polling the page of a VirtualBox VM', () => {
  function ended(id: string): VmSession {
    return {
      id,
      agentId: AGENT_ID,
      agentName: 'Desk PC',
      agentOnline: true,
      emulatorType: 'virtualbox',
      vmName: 'xenix-386',
      mode: 'local',
      state: 'stopped',
      versionId: null,
      workspaceId: null,
      pid: null,
      processStartedAt: null,
      requestedAt: WHEN,
      startedAt: WHEN,
      endedAt: WHEN,
      exitCode: 0,
      stopRequested: false,
      forceRequested: false,
      gracefulStopAvailable: true,
      error: null,
      recovery: null,
      requestedByDisplayName: 'Ada Admin',
      updatedAt: WHEN,
    };
  }

  it('reads the machine once for every panel, and each ended session’s screenshots once', async () => {
    const sessions = [
      '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f81',
      '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f82',
      '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f83',
    ];
    const api = routes({
      'GET /admin/sessions': { sessions: sessions.map(ended) },
      ...Object.fromEntries(
        sessions.map((id) => [
          `GET /admin/sessions/${id}/screenshots`,
          { available: false, reason: null, operation: null },
        ]),
      ),
    });
    renderAt(VM_PATH);
    await screen.findByRole('button', { name: 'Import Master into VirtualBox' });
    await screen.findByText('Earlier sessions');
    await waitFor(() => {
      for (const id of sessions) {
        expect(api.callsTo('GET', `/admin/sessions/${id}/screenshots`)).toHaveLength(1);
      }
    });
    // Long enough for any of the old 1.5-second polls to have fired again.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    for (const id of sessions) {
      expect(api.callsTo('GET', `/admin/sessions/${id}/screenshots`)).toHaveLength(1);
    }
    expect(api.callsTo('GET', MANAGEMENT_PATH)).toHaveLength(1);
    expect(api.callsTo('GET', `${VM_PATH}/workspaces`)).toHaveLength(1);
    expect(api.callsTo('GET', `${VM_PATH}/restore-options`)).toHaveLength(1);
  });
});

/**
 * The traffic of the whole page, measured: every request the page makes, by endpoint, over simulated time. The
 * scenario is the one that made about 600 requests in 224 seconds, 444 of them for the screenshots of three ended
 * sessions: a running session, three ended ones, the machine panel and the version history.
 */
describe('the requests the page of a VirtualBox VM makes', () => {
  const ENDED = [
    '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f81',
    '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f82',
    '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f83',
  ];
  let hidden = false;

  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  function session(id: string, state: VmSession['state']): VmSession {
    return {
      id,
      agentId: AGENT_ID,
      agentName: 'Desk PC',
      agentOnline: true,
      emulatorType: 'virtualbox',
      vmName: 'xenix-386',
      mode: 'local',
      state,
      versionId: null,
      workspaceId: null,
      pid: null,
      processStartedAt: null,
      requestedAt: WHEN,
      startedAt: WHEN,
      endedAt: state === 'running' ? null : WHEN,
      exitCode: state === 'running' ? null : 0,
      stopRequested: false,
      forceRequested: false,
      gracefulStopAvailable: true,
      error: null,
      recovery: null,
      requestedByDisplayName: 'Ada Admin',
      updatedAt: WHEN,
    };
  }

  /** The page with a running machine; `machine` answers the machine panel's poll. */
  function page(machine: () => VirtualBoxManagementResponse = () => management()) {
    const running = session(SESSION_ID, 'running');
    const execution = options();
    execution.virtualbox = source({ state: 'running', rawState: 'running' });
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
        activeSession: running,
        lastSession: null,
        lastVerification: null,
      },
    ] as ExecutionOptionsResponse['agents'];
    const screenshots = { available: true, reason: null, operation: null };
    return routes({
      [`GET ${VM_PATH}/execution-options`]: execution,
      [`GET ${MANAGEMENT_PATH}`]: () => machine(),
      'GET /admin/sessions': {
        sessions: [running, ...ENDED.map((id) => session(id, 'stopped'))],
      },
      [`GET /admin/sessions/${SESSION_ID}/screenshots`]: screenshots,
      ...Object.fromEntries(
        ENDED.map((id) => [`GET /admin/sessions/${id}/screenshots`, { ...screenshots }]),
      ),
    });
  }

  async function elapse(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /** Renders the page and lets every first request, and what it leads to, finish. */
  async function open() {
    renderAt(VM_PATH);
    for (let step = 0; step < 20; step++) await elapse(0);
  }

  function byEndpoint(calls: { method: string; path: string }[]) {
    const counts: Record<string, number> = {};
    for (const call of calls) {
      const key = `${call.method} ${call.path}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  it('reads ended sessions once, and polls the rest at their own pace, over 224 seconds', async () => {
    const api = page();
    await open();
    await elapse(224_000);
    const counts = byEndpoint(api.calls);
    expect(counts).toEqual({
      'GET /auth/session': 1,
      'GET /ready': 15, // every 15 s
      [`GET ${VM_PATH}`]: 1,
      [`GET ${VM_PATH}/media`]: 1,
      // The run panel of a running machine: every 10 s.
      [`GET ${VM_PATH}/execution-options`]: 23,
      'GET /admin/sessions': 23,
      // The machine, once for both panels that show it: every 30 s.
      [`GET ${MANAGEMENT_PATH}`]: 8,
      // The version history: versions every 30 s, the rest once.
      [`GET ${VM_PATH}/versions`]: 8,
      [`GET ${VM_PATH}/workspaces`]: 1,
      [`GET ${VM_PATH}/restore-options`]: 1,
      // Remasters: once, since nothing is in progress.
      [`GET ${VM_PATH}/remasters`]: 1,
      // The running session's screenshots: every 15 s. Each ended session's: once.
      [`GET /admin/sessions/${SESSION_ID}/screenshots`]: 15,
      ...Object.fromEntries(ENDED.map((id) => [`GET /admin/sessions/${id}/screenshots`, 1])),
    });
    // Was 601, 444 of them for the three ended sessions.
    expect(api.calls).toHaveLength(101);
  });

  it('requests nothing while the tab is hidden, and catches up when it shows', async () => {
    const api = page();
    await open();
    const before = api.calls.length;
    act(() => {
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await elapse(224_000);
    expect(api.calls.length).toBe(before);
    act(() => {
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    for (let step = 0; step < 5; step++) await elapse(0);
    const caughtUp = byEndpoint(api.calls.slice(before));
    // What was due is read once; what is read once is not read again.
    expect(caughtUp).toEqual({
      'GET /ready': 1,
      [`GET ${VM_PATH}/execution-options`]: 1,
      'GET /admin/sessions': 1,
      [`GET ${MANAGEMENT_PATH}`]: 1,
      [`GET ${VM_PATH}/versions`]: 1,
      [`GET /admin/sessions/${SESSION_ID}/screenshots`]: 1,
    });
  });

  it('follows an import every 2 seconds, then refreshes the run panel once it is done', async () => {
    let state: VirtualBoxOperation['state'] = 'running';
    const api = page(() =>
      management({
        operations: [
          operation({
            state,
            stage: state === 'running' ? 'importing' : null,
            autoLink:
              state === 'running'
                ? { intent: 'relink', state: 'pending', linkOperationId: null, error: null }
                : { intent: 'relink', state: 'linked', linkOperationId: SPARE, error: null },
          }),
        ],
      }),
    );
    await open();
    const machine = () => api.callsTo('GET', MANAGEMENT_PATH).length;
    const runPanel = () => api.callsTo('GET', `${VM_PATH}/execution-options`).length;
    const first = machine();
    await elapse(10_000);
    expect(machine() - first).toBe(5);

    state = 'succeeded';
    const optionsBefore = runPanel();
    await elapse(2_000);
    for (let step = 0; step < 5; step++) await elapse(0);
    // Done: the run panel hears of it at once, not at its next poll.
    expect(runPanel()).toBe(optionsBefore + 1);
    // And the machine goes back to every 30 seconds.
    const settled = machine();
    await elapse(29_000);
    expect(machine()).toBe(settled);
    await elapse(1_000);
    expect(machine()).toBe(settled + 1);
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
