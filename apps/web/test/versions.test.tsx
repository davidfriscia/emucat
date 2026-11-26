import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  RegistrationOperation,
  RemasterOperation,
  RemasterPreview,
  RemasterVersion,
  RestoreOptionsResponse,
  VersionNode,
  RemoteSession,
} from '@emucat/contracts';
import { describe, expect, it } from 'vitest';
import { adminVm, apiError, mockApi, renderAt, signedInAsAdmin } from './mock-api';
import { registrationOperation } from './registration-fixture';

const VM_PATH = '/admin/vms/qemu/Win98';
const PUBLIC_PATH = '/catalog/vms/qemu/Win98';
const AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8001';
const MASTER = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8010';
const SNAP_A = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8011';
const SNAP_B = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8012';
const SNAP_C = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8013';
const WORKSPACE = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8020';
const REPOSITORY_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8030';
const SHA = 'a'.repeat(64);

function node(
  id: string,
  parent: string | null,
  minute: number,
  overrides: Partial<VersionNode> = {},
): VersionNode {
  return {
    id,
    kind: parent === null ? 'master' : 'snapshot',
    parentVersionId: parent,
    childVersionIds: [],
    snapshotName: parent === null ? null : `Win98_2026010100${String(minute).padStart(2, '0')}`,
    createdAt: `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`,
    title: null,
    description: null,
    tags: [],
    promotedAt: null,
    archiveSizeBytes: 2048,
    archiveSha256: SHA,
    manifest: { sha256: SHA, fileCount: 3, totalUncompressedBytes: 4096, verifiedBy: 'agent' },
    repositoryName: 'NAS',
    available: true,
    createdByAgentName: 'Study PC',
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

/** master ─▶ A ─▶ C, and master ─▶ B, with the local copy on B. */
function branchingTree() {
  return {
    emulatorType: 'qemu',
    vmName: 'Win98',
    rootVersionId: MASTER,
    versions: [
      node(MASTER, null, 0, { childVersionIds: [SNAP_A, SNAP_B] }),
      node(SNAP_A, MASTER, 1, { childVersionIds: [SNAP_C] }),
      node(SNAP_B, MASTER, 2, {
        holders: [
          {
            agentId: AGENT_ID,
            agentName: 'Study PC',
            kind: 'local',
            contentStatus: 'modified',
            workspaceId: null,
          },
        ],
      }),
      node(SNAP_C, SNAP_A, 3),
    ],
  };
}

function restoreOptions(): RestoreOptionsResponse {
  const version = (id: string, kind: 'master' | 'snapshot', parent: string | null) => ({
    versionId: id,
    repositoryId: REPOSITORY_ID,
    repositoryName: 'NAS',
    repositoryEnabled: true,
    archiveSizeBytes: 2048,
    archiveSha256: SHA,
    createdAt: '2026-01-01T00:00:00.000Z',
    manifestSha256: SHA,
    fileCount: 3,
    totalUncompressedBytes: 4096,
    kind,
    parentVersionId: parent,
    snapshotName: kind === 'master' ? null : `Win98_${id.slice(-2)}`,
  });
  const [master, ...rest] = [
    version(MASTER, 'master', null),
    version(SNAP_A, 'snapshot', MASTER),
    version(SNAP_B, 'snapshot', MASTER),
    version(SNAP_C, 'snapshot', SNAP_A),
  ];
  return {
    master: master ?? null,
    versions: [master!, ...rest],
    agents: [
      {
        agentId: AGENT_ID,
        agentName: 'Study PC',
        online: true,
        eligible: true,
        ineligibleReason: null,
        destination: 'C:\\vms\\qemu\\Win98',
        local: {
          availability: 'absent',
          contentStatus: null,
          sourceVersionId: null,
          lastVerifiedAt: null,
        },
        replace: { eligible: false, reason: 'no_local_copy' },
        running: false,
        remove: { eligible: false, reason: 'no_local_copy' },
        cacheUsedBytes: 0,
        cacheMaxBytes: 1000,
      },
    ],
  } as RestoreOptionsResponse;
}

function workspace(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: WORKSPACE,
    agentId: AGENT_ID,
    agentName: 'Study PC',
    agentOnline: true,
    emulatorType: 'qemu',
    vmName: 'Win98',
    purpose: 'manual',
    state: 'ready',
    baseVersionId: SNAP_A,
    sourceVersionId: SNAP_A,
    mayHaveChanges: true,
    launchOnReady: false,
    restoreOperationId: null,
    sessionId: null,
    snapshotOperationId: null,
    publishAttempts: 0,
    nextRetryAt: null,
    abandonedAt: null,
    snapshotVersionId: null,
    localDirectory: 'C:\\state\\workspaces\\x\\Win98',
    error: null,
    requestedByDisplayName: 'Ada Admin',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    restore: null,
    session: null,
    snapshot: null,
    recovery: null,
    ...overrides,
  };
}

function snapshotOperation(overrides: Partial<RegistrationOperation> = {}): RegistrationOperation {
  return {
    ...registrationOperation(),
    mode: 'snapshot',
    state: 'uploading',
    parentVersionId: SNAP_B,
    snapshotName: 'Win98_202601010010',
    localCopy: null,
    error: null,
    recovery: null,
    progress: { doneBytes: 50, totalBytes: 100 },
    ...overrides,
  };
}

function base(routes: Record<string, unknown> = {}) {
  return mockApi({
    ...signedInAsAdmin,
    [`GET ${VM_PATH}`]: adminVm(),
    [`GET ${VM_PATH}/media`]: { media: [] },
    [`GET ${VM_PATH}/restore-options`]: restoreOptions(),
    'GET /admin/restores': { operations: [] },
    [`GET ${VM_PATH}/versions`]: branchingTree(),
    [`GET ${VM_PATH}/workspaces`]: { workspaces: [] },
    'GET /admin/local-copy-removals': { removals: [] },
    ...routes,
  });
}

async function history() {
  renderAt(`${VM_PATH}/versions`);
  const tree = await screen.findByRole('tree', { name: 'Versions of Win98' });
  return tree;
}

describe('the version tree', () => {
  it('draws branches as branches, with each version’s facts', async () => {
    base();
    const tree = await history();
    const items = within(tree).getAllByRole('treeitem');
    expect(items.map((item) => item.getAttribute('aria-level'))).toEqual(['1', '2', '3', '2']);
    const master = items[0] as HTMLElement;
    expect(within(master).getByRole('heading', { name: 'Master' })).toBeTruthy();
    expect(within(master).getByText('2 branches')).toBeTruthy();
    expect(within(master).getByText('None (root)')).toBeTruthy();

    // C is under A, not after B: the history is not flattened into a list.
    const a = items[1] as HTMLElement;
    expect(within(a).getByRole('heading', { name: 'Win98_202601010001' })).toBeTruthy();
    expect(within(a).getByRole('heading', { name: 'Win98_202601010003' })).toBeTruthy();
    const b = items[3] as HTMLElement;
    expect(within(b).queryByRole('heading', { name: 'Win98_202601010003' })).toBeNull();
    expect(within(b).getByText(/Local copy on Study PC \(modified since\)/)).toBeTruthy();
    expect(within(b).getAllByText(/Verified by the agent when published: 3 files/)).toHaveLength(1);
    expect(within(b).getByTitle(SNAP_B)).toBeTruthy();
  });

  it('tells apart versions whose labels are the same, by their identity', async () => {
    const twins = branchingTree();
    // Snapshot labels are minutes: two snapshots in one minute share one.
    twins.versions[3] = {
      ...(twins.versions[3] as VersionNode),
      snapshotName: 'Win98_202601010001',
    };
    base({ [`GET ${VM_PATH}/versions`]: twins });
    const tree = await history();
    const buttons = within(tree).getAllByRole('button', { name: /in Remote Snapshot$/ });
    const names = buttons.map((button) => button.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain(`Run Win98_202601010001 (${SNAP_A.slice(-8)}) in Remote Snapshot`);
    expect(names).toContain(`Run Win98_202601010001 (${SNAP_C.slice(-8)}) in Remote Snapshot`);
    // A label that is unique stays as it is.
    expect(names).toContain('Run Win98_202601010002 in Remote Snapshot');
  });

  it('collapses and expands a branch', async () => {
    base();
    const tree = await history();
    const toggle = within(tree).getByRole('button', { name: 'Collapse Win98_202601010001' });
    fireEvent.click(toggle);
    expect(within(tree).queryByRole('heading', { name: 'Win98_202601010003' })).toBeNull();
    fireEvent.click(within(tree).getByRole('button', { name: 'Expand Win98_202601010001' }));
    expect(within(tree).getByRole('heading', { name: 'Win98_202601010003' })).toBeTruthy();
  });

  it('refuses to draw an inconsistent tree', async () => {
    const broken = branchingTree();
    broken.versions = broken.versions.filter((version) => version.id !== SNAP_A);
    base({ [`GET ${VM_PATH}/versions`]: broken });
    renderAt(`${VM_PATH}/versions`);
    expect(
      await screen.findByText(/version history is inconsistent \(unknown parent\)/),
    ).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('says so when there are no versions', async () => {
    base({
      [`GET ${VM_PATH}/versions`]: {
        emulatorType: 'qemu',
        vmName: 'Win98',
        rootVersionId: null,
        versions: [],
      },
    });
    renderAt(`${VM_PATH}/versions`);
    expect(await screen.findByText('This VM has no versions yet.')).toBeTruthy();
  });

  it('marks a version whose repository is disabled as unavailable', async () => {
    const tree = branchingTree();
    tree.versions[3] = { ...(tree.versions[3] as VersionNode), available: false };
    base({ [`GET ${VM_PATH}/versions`]: tree });
    const drawn = await history();
    const c = within(drawn).getAllByRole('treeitem')[2] as HTMLElement;
    expect(within(c).getByText(/Repository disabled/)).toBeTruthy();
    expect(
      (within(c).getByRole('button', { name: 'Restore…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('creating a snapshot', () => {
  it('confirms, names the version the copy came from as the parent, and follows progress', async () => {
    const api = base({
      [`POST ${VM_PATH}/snapshots`]: snapshotOperation(),
      [`GET /admin/registrations/${registrationOperation().id}`]: snapshotOperation({
        state: 'succeeded',
        progress: { doneBytes: null, totalBytes: null },
      }),
    });
    const tree = await history();
    // Only the version the local copy came from offers a snapshot from it.
    const buttons = within(tree).getAllByRole('button', { name: 'Create snapshot from Study PC…' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Create a snapshot from Study PC' });
    expect(within(dialog).getByText(/whose parent is/)).toBeTruthy();
    expect(within(dialog).getByText('Win98_202601010002')).toBeTruthy();
    expect(within(dialog).getByText(/must not be running/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create snapshot' }));

    await waitFor(() => expect(api.callsTo('POST', `${VM_PATH}/snapshots`)).toHaveLength(1));
    const body = api.callsTo('POST', `${VM_PATH}/snapshots`)[0]?.body as Record<string, string>;
    expect(body.agentId).toBe(AGENT_ID);
    expect(body.parentVersionId).toBe(SNAP_B);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(body).sort()).toEqual(['agentId', 'parentVersionId', 'requestId']);
    expect(await screen.findByText(/Snapshot created/)).toBeTruthy();
  });

  it('shows why a snapshot was refused, and keeps the dialog open', async () => {
    base({
      [`POST ${VM_PATH}/snapshots`]: apiError(
        409,
        'vm_running',
        'This VM is running on this agent, or may be.',
      ),
    });
    const tree = await history();
    fireEvent.click(within(tree).getByRole('button', { name: 'Create snapshot from Study PC…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a snapshot from Study PC' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create snapshot' }));
    expect(await within(dialog).findByText(/running on this agent/)).toBeTruthy();
  });
});

describe('restoring a historical version', () => {
  it('opens the restore dialog on the chosen version', async () => {
    const api = base({ 'POST /admin/restores': { ...restoreOperationStub() } });
    const tree = await history();
    const a = within(tree).getAllByRole('treeitem')[1] as HTMLElement;
    fireEvent.click(within(a).getAllByRole('button', { name: 'Restore…' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Restore Win98' });
    const select = within(dialog).getByLabelText('Version') as HTMLSelectElement;
    expect(select.value).toBe(SNAP_A);
    expect(within(dialog).getByText(/branches from this version/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.callsTo('POST', '/admin/restores')).toHaveLength(1));
    expect(api.callsTo('POST', '/admin/restores')[0]?.body).toEqual({
      agentId: AGENT_ID,
      emulatorType: 'qemu',
      vmName: 'Win98',
      versionId: SNAP_A,
    });
  });
});

function restoreOperationStub() {
  return {
    id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8040',
    agentId: AGENT_ID,
    agentName: 'Study PC',
    agentOnline: true,
    repositoryId: REPOSITORY_ID,
    repositoryName: 'NAS',
    emulatorType: 'qemu',
    vmName: 'Win98',
    versionId: SNAP_A,
    workspaceId: null,
    replacement: null,
    state: 'queued',
    archive: { sizeBytes: 2048, sha256: SHA },
    progress: { doneBytes: null, totalBytes: null },
    verified: null,
    localDirectory: null,
    cache: { hit: null, downloadedBytes: null, archiveCached: null, totalBytes: null },
    error: null,
    recovery: null,
    cancelRequested: false,
    requestedByDisplayName: 'Ada Admin',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
  };
}

function executionOptions() {
  const remote = { eligible: true, reason: null, problem: null };
  return {
    modes: [
      { mode: 'local', available: true, reason: null },
      { mode: 'remote_volatile', available: true, reason: null },
      { mode: 'remote_snapshot', available: true, reason: null },
    ],
    agents: [
      {
        agentId: AGENT_ID,
        agentName: 'Study PC',
        online: true,
        launch: { eligible: false, reason: 'vm_not_on_agent', problem: null },
        verify: { eligible: false, reason: 'vm_not_on_agent' },
        remote: { remote_volatile: remote, remote_snapshot: remote },
        activeWorkspaceId: null,
        local: { present: false, contentStatus: null, sourceVersionId: null, lastVerifiedAt: null },
        activeSession: null,
        lastSession: null,
        lastVerification: null,
      },
    ],
  };
}

describe('running a version', () => {
  it('chooses the version and mode in the run panel, which is where it starts', async () => {
    const api = base({
      [`GET ${VM_PATH}/execution-options`]: executionOptions(),
      'GET /admin/sessions': { sessions: [] },
      [`POST ${VM_PATH}/workspaces`]: workspace({
        purpose: 'remote_snapshot',
        state: 'preparing',
        baseVersionId: SNAP_C,
        sourceVersionId: SNAP_C,
      }),
    });
    const tree = await history();
    const c = within(tree).getAllByRole('treeitem')[2] as HTMLElement;
    fireEvent.click(
      within(c).getByRole('button', { name: 'Run Win98_202601010003 in Remote Snapshot' }),
    );
    // Nothing starts from the history itself: it only chooses, and opens General, where the run panel is.
    expect(api.callsTo('POST', `${VM_PATH}/workspaces`)).toHaveLength(0);
    const heading = await screen.findByRole('heading', { name: 'Run and verify' });
    expect(screen.getByTestId('location').textContent).toBe(VM_PATH);
    expect(
      within(screen.getByRole('navigation', { name: 'VM' }))
        .getByRole('link', { name: 'General' })
        .getAttribute('aria-current'),
    ).toBe('page');
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const panel = within(heading.closest('section') as HTMLElement);
    expect(
      (panel.getByRole('radio', { name: 'Remote Snapshot' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect((panel.getByLabelText('Version') as HTMLSelectElement).value).toBe(SNAP_C);
    expect(panel.getByText(/parent is exactly this version/)).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Start Remote Snapshot' }));
    await waitFor(() => expect(api.callsTo('POST', `${VM_PATH}/workspaces`)).toHaveLength(1));
    const body = api.callsTo('POST', `${VM_PATH}/workspaces`)[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ agentId: AGENT_ID, versionId: SNAP_C, mode: 'remote_snapshot' });
    expect(Object.keys(body).sort()).toEqual(['agentId', 'mode', 'requestId', 'versionId']);
  });

  it('chooses Remote Volatile the same way, and another version replaces the first choice', async () => {
    base({
      [`GET ${VM_PATH}/execution-options`]: executionOptions(),
      'GET /admin/sessions': { sessions: [] },
    });
    const tree = await history();
    const items = within(tree).getAllByRole('treeitem');
    fireEvent.click(
      within(items[2] as HTMLElement).getByRole('button', {
        name: 'Run Win98_202601010003 in Remote Volatile',
      }),
    );
    let panel = within(
      (await screen.findByRole('heading', { name: 'Run and verify' })).closest(
        'section',
      ) as HTMLElement,
    );
    await waitFor(() =>
      expect((panel.getByLabelText('Version') as HTMLSelectElement).value).toBe(SNAP_C),
    );
    expect(
      (panel.getByRole('radio', { name: 'Remote Volatile' }) as HTMLInputElement).checked,
    ).toBe(true);
    // Back to the history, through the VM's sidebar, for another choice.
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'VM' })).getByRole('link', {
        name: 'Version History',
      }),
    );
    const again = await screen.findByRole('tree', { name: 'Versions of Win98' });
    fireEvent.click(
      within(within(again).getAllByRole('treeitem')[1] as HTMLElement).getAllByRole('button', {
        name: 'Run Win98_202601010001 in Remote Snapshot',
      })[0] as HTMLElement,
    );
    panel = within(
      (await screen.findByRole('heading', { name: 'Run and verify' })).closest(
        'section',
      ) as HTMLElement,
    );
    await waitFor(() =>
      expect((panel.getByLabelText('Version') as HTMLSelectElement).value).toBe(SNAP_A),
    );
    expect(
      (panel.getByRole('radio', { name: 'Remote Snapshot' }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('lists remote sessions in the run panel, not among the manual working copies', async () => {
    base({
      [`GET ${VM_PATH}/workspaces`]: {
        workspaces: [workspace({ purpose: 'remote_volatile', state: 'running' })],
      },
    });
    await history();
    expect(screen.queryByRole('heading', { name: 'Manual working copies' })).toBeNull();
  });
});

describe('manual working copies', () => {
  it('preserves a stopped working copy only when asked', async () => {
    const api = base({
      [`GET ${VM_PATH}/workspaces`]: { workspaces: [workspace()] },
      [`POST /admin/workspaces/${WORKSPACE}/snapshot`]: snapshotOperation({
        parentVersionId: SNAP_A,
      }),
      [`GET /admin/registrations/${registrationOperation().id}`]: snapshotOperation(),
    });
    renderAt(`${VM_PATH}/versions`);
    expect(await screen.findByText('May have unpreserved changes')).toBeTruthy();
    expect(api.callsTo('POST', `/admin/workspaces/${WORKSPACE}/snapshot`)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Preserve as snapshot…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Preserve as a new snapshot' });
    expect(within(dialog).getByText(SNAP_A.slice(0, 8))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create snapshot' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/workspaces/${WORKSPACE}/snapshot`)).toHaveLength(1),
    );
    expect(await screen.findByText(/Uploading to the repository/)).toBeTruthy();
  });

  it('asks for the VM’s name before discarding changes that may not be preserved', async () => {
    const api = base({
      [`GET ${VM_PATH}/workspaces`]: { workspaces: [workspace()] },
      [`POST /admin/workspaces/${WORKSPACE}/discard`]: workspace({ state: 'discarding' }),
    });
    renderAt(`${VM_PATH}/versions`);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard this working copy' });
    expect(within(dialog).getByText(/will be lost/)).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Discard' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'win98' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/workspaces/${WORKSPACE}/discard`)).toHaveLength(1),
    );
    expect(api.callsTo('POST', `/admin/workspaces/${WORKSPACE}/discard`)[0]?.body).toEqual({
      confirmVmName: 'win98',
    });
  });

  it('discards a fully preserved working copy without typing the name', async () => {
    base({
      [`GET ${VM_PATH}/workspaces`]: { workspaces: [workspace({ mayHaveChanges: false })] },
    });
    renderAt(`${VM_PATH}/versions`);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard this working copy' });
    expect(within(dialog).queryByLabelText(/to confirm/)).toBeNull();
    expect(within(dialog).getByText(/already in a snapshot/)).toBeTruthy();
  });

  it('shows a lost or failed working copy with its reason, and no actions', async () => {
    base({
      [`GET ${VM_PATH}/workspaces`]: {
        workspaces: [
          workspace({
            state: 'lost',
            finishedAt: '2026-01-01T00:00:00.000Z',
            error: {
              code: 'workspace_missing',
              message: 'The agent no longer has this working copy.',
            },
          }),
        ],
      },
    });
    renderAt(`${VM_PATH}/versions`);
    expect(await screen.findByText('The agent no longer has this working copy.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Discard…' })).toBeNull();
  });
});

describe('the public VM page', () => {
  const detail = {
    emulatorType: 'qemu',
    vmName: 'Win98',
    displayName: 'Windows 98 SE',
    description: null,
    mainImage: null,
    gallery: [],
  };

  it('shows no version history to visitors, and never asks for it', async () => {
    const api = mockApi({ [`GET ${PUBLIC_PATH}`]: detail });
    renderAt('/vms/qemu/Win98');
    await screen.findByRole('heading', { level: 1, name: 'Windows 98 SE' });
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByText('Version history')).toBeNull();
    expect(api.callsTo('GET', `${VM_PATH}/versions`)).toHaveLength(0);
  });

  it('gives administrators a tab beside the gallery, which stays the default', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${PUBLIC_PATH}`]: detail,
      [`GET ${VM_PATH}/versions`]: branchingTree(),
      [`GET ${VM_PATH}/workspaces`]: { workspaces: [] },
      [`GET ${VM_PATH}/restore-options`]: restoreOptions(),
    });
    renderAt('/vms/qemu/Win98');
    const screenshots = await screen.findByRole('tab', { name: 'Screenshots' });
    expect(screenshots.getAttribute('aria-selected')).toBe('true');
    expect(api.callsTo('GET', `${VM_PATH}/versions`)).toHaveLength(0);
    const versions = screen.getByRole('tab', { name: 'Version history' });
    fireEvent.keyDown(screenshots, { key: 'ArrowRight' });
    expect(versions.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(versions);
    expect(await screen.findByRole('tree', { name: 'Versions of Win98' })).toBeTruthy();
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(versions.id);
  });

  it('opens the launcher on the chosen version and mode, where there is no run panel', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${PUBLIC_PATH}`]: detail,
      [`GET ${VM_PATH}/versions`]: branchingTree(),
      [`GET ${VM_PATH}/workspaces`]: { workspaces: [] },
      [`GET ${VM_PATH}/restore-options`]: restoreOptions(),
      [`GET ${VM_PATH}/execution-options`]: executionOptions(),
      'GET /admin/sessions': { sessions: [] },
    });
    renderAt('/vms/qemu/Win98');
    fireEvent.click(await screen.findByRole('tab', { name: 'Version history' }));
    const tree = await screen.findByRole('tree', { name: 'Versions of Win98' });
    const a = within(tree).getAllByRole('treeitem')[1] as HTMLElement;
    fireEvent.click(
      within(a).getAllByRole('button', {
        name: 'Run Win98_202601010001 in Remote Volatile',
      })[0] as HTMLElement,
    );
    const dialog = within(await screen.findByRole('dialog', { name: 'Launch Win98' }));
    await waitFor(() =>
      expect((dialog.getByLabelText('Version') as HTMLSelectElement).value).toBe(SNAP_A),
    );
    expect(
      (dialog.getByRole('radio', { name: 'Remote Volatile' }) as HTMLInputElement).checked,
    ).toBe(true);
  });
});

describe('deleting a snapshot', () => {
  /** A has a child, B is installed, C is a leaf nobody uses. */
  function deletableTree() {
    const tree = branchingTree();
    const [master, a, b, c] = tree.versions as [VersionNode, VersionNode, VersionNode, VersionNode];
    tree.versions = [
      master,
      { ...a, deletable: { eligible: false, reason: 'snapshot_has_descendants' } },
      { ...b, deletable: { eligible: false, reason: 'snapshot_installed' } },
      c,
    ];
    return tree;
  }
  const deletion = () => ({
    versionId: SNAP_C,
    emulatorType: 'qemu',
    vmName: 'Win98',
    snapshotName: 'Win98_202601010003',
    parentVersionId: SNAP_A,
    repositoryName: 'NAS',
    archiveSizeBytes: 2048,
    archiveSha256: SHA,
    versionCreatedAt: '2026-01-01T00:03:00.000Z',
    state: 'deleting',
    archiveOutcome: null,
    attempts: 1,
    nextRetryAt: null,
    error: null,
    requestedByDisplayName: 'Ada Admin',
    requestedAt: '2026-01-02T00:00:00.000Z',
    completedAt: null,
  });
  const item = (tree: HTMLElement, label: string) =>
    within(tree)
      .getAllByRole('treeitem')
      .find((element) => element.getAttribute('aria-labelledby')?.endsWith(label)) as HTMLElement;

  it('is never offered for the master, and says why other snapshots cannot be deleted', async () => {
    base({ [`GET ${VM_PATH}/versions`]: deletableTree() });
    const tree = await history();
    const master = item(tree, MASTER);
    const a = item(tree, SNAP_A);
    const b = item(tree, SNAP_B);
    const c = item(tree, SNAP_C);
    expect(within(master).queryByRole('button', { name: /^Delete Master/ })).toBeNull();
    const deleteA = within(a).getByRole('button', { name: 'Delete Win98_202601010001' });
    expect((deleteA as HTMLButtonElement).disabled).toBe(true);
    expect(deleteA.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(a).getByText(/Other versions were created from this snapshot/)).toBeTruthy();
    const deleteB = within(b).getByRole('button', { name: 'Delete Win98_202601010002' });
    expect((deleteB as HTMLButtonElement).disabled).toBe(true);
    expect(within(b).getByText(/holds a persistent copy of this snapshot/)).toBeTruthy();
    const deleteC = within(c).getByRole('button', { name: 'Delete Win98_202601010003' });
    expect((deleteC as HTMLButtonElement).disabled).toBe(false);
  });

  it('names the exact version, warns that it cannot be undone, and sends only its ID', async () => {
    const api = base({
      [`GET ${VM_PATH}/versions`]: deletableTree(),
      [`POST ${VM_PATH}/versions/${SNAP_C}/deletion`]: deletion(),
    });
    const tree = await history();
    fireEvent.click(within(tree).getByRole('button', { name: 'Delete Win98_202601010003' }));
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Permanently delete this snapshot' }),
    );
    const fact = (term: string) =>
      dialog.getByText(term, { selector: 'dt' }).nextElementSibling?.textContent;
    expect(fact('Version ID')).toBe(SNAP_C);
    expect(fact('VM')).toBe('Win98');
    expect(fact('Snapshot')).toBe('Win98_202601010003');
    expect(fact('Parent')).toContain('Win98_202601010001');
    expect(fact('Parent')).toContain(SNAP_A);
    expect(fact('Archive size')).toBe('2.0 KiB');
    expect(fact('Repository')).toMatch(/^NAS/);
    expect(dialog.getByRole('alert').textContent).toMatch(/cannot be undone/);
    expect(dialog.queryByRole('textbox')).toBeNull();
    fireEvent.click(dialog.getByRole('button', { name: 'Permanently delete snapshot' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `${VM_PATH}/versions/${SNAP_C}/deletion`)).toHaveLength(1),
    );
    const body = api.callsTo('POST', `${VM_PATH}/versions/${SNAP_C}/deletion`)[0]?.body as Record<
      string,
      string
    >;
    expect(body.versionId).toBe(SNAP_C);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(body).sort()).toEqual(['requestId', 'versionId']);
  });

  it('marks a snapshot being deleted as unusable, with its last failure and a retry', async () => {
    const tree = deletableTree();
    tree.versions[3] = {
      ...(tree.versions[3] as VersionNode),
      available: false,
      deletable: { eligible: false, reason: null },
      deletion: {
        requestedAt: '2026-01-02T00:00:00.000Z',
        attempts: 2,
        error: { code: 'repository_unreachable', message: 'The SSH server did not answer.' },
      },
    };
    const api = base({
      [`GET ${VM_PATH}/versions`]: tree,
      [`POST ${VM_PATH}/versions/${SNAP_C}/deletion/retry`]: deletion(),
    });
    const c = item(await history(), SNAP_C);
    expect(within(c).getByText('Being deleted')).toBeTruthy();
    expect(within(c).queryByRole('button', { name: /^Delete/ })).toBeNull();
    expect(
      (within(c).getByRole('button', { name: 'Restore…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (
        within(c).getByRole('button', {
          name: 'Run Win98_202601010003 in Remote Volatile',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(within(c).getByText('repository_unreachable')).toBeTruthy();
    fireEvent.click(
      within(c).getByRole('button', { name: 'Retry deleting Win98_202601010003 now' }),
    );
    await waitFor(() =>
      expect(api.callsTo('POST', `${VM_PATH}/versions/${SNAP_C}/deletion/retry`)).toHaveLength(1),
    );
  });
});

const REMASTER_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8040';
const REVISION = 'b'.repeat(64);

function brief(id: string, parent: string | null, minute: number): RemasterVersion {
  const full = node(id, parent, minute);
  return {
    id,
    kind: full.kind,
    parentVersionId: parent,
    snapshotName: full.snapshotName,
    title: null,
    createdAt: full.createdAt,
    archiveSizeBytes: full.archiveSizeBytes,
  };
}

function promotionPreview(overrides: Partial<RemasterPreview> = {}): RemasterPreview {
  return {
    kind: 'snapshot',
    emulatorType: 'qemu',
    vmName: 'Win98',
    revision: REVISION,
    currentMaster: brief(MASTER, null, 0),
    promoted: brief(SNAP_A, MASTER, 1),
    retained: [brief(SNAP_A, MASTER, 1), brief(SNAP_C, SNAP_A, 3)],
    removed: [brief(MASTER, null, 0), brief(SNAP_B, MASTER, 2)],
    removedBytes: 4096,
    source: null,
    lineageConflicts: [],
    cleanupAvailable: true,
    refusal: null,
    ...overrides,
  };
}

function remasterOperation(overrides: Partial<RemasterOperation> = {}): RemasterOperation {
  return {
    id: REMASTER_ID,
    kind: 'snapshot',
    emulatorType: 'qemu',
    vmName: 'Win98',
    state: 'cleaning',
    phase: 'cleaning',
    previousMasterVersionId: MASTER,
    newMasterVersionId: SNAP_A,
    agentId: null,
    agentName: null,
    registrationOperationId: null,
    progress: { doneBytes: null, totalBytes: null },
    retainedCount: 2,
    removedCount: 2,
    removedBytes: 4096,
    cleanup: { total: 2, deleted: 0, complete: false, items: [] },
    error: null,
    requestedByDisplayName: 'Ada Admin',
    createdAt: '2026-01-01T01:00:00.000Z',
    committedAt: '2026-01-01T01:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

describe('titles and descriptions', () => {
  it('shows a title prominently and a description as plain text, never markup', async () => {
    const tree = branchingTree();
    tree.versions[1] = {
      ...(tree.versions[1] as VersionNode),
      title: 'Clean install',
      description: 'Line one\n<b>not bold</b>',
    };
    base({ [`GET ${VM_PATH}/versions`]: tree });
    const drawn = await history();
    const a = within(drawn).getAllByRole('treeitem')[1] as HTMLElement;
    expect(within(a).getByRole('heading', { name: 'Clean install' })).toBeTruthy();
    expect(within(a).getByText('Win98_202601010001')).toBeTruthy();
    const description = within(a).getByText(/Line one/);
    expect(description.textContent).toBe('Line one\n<b>not bold</b>');
    expect(description.querySelector('b')).toBeNull();
  });

  it('edits only the title and description', async () => {
    const api = base({
      [`PATCH ${VM_PATH}/versions/${SNAP_B}`]: {
        versionId: SNAP_B,
        title: 'Patched',
        description: 'With the fixes',
      },
    });
    const tree = await history();
    fireEvent.click(
      within(tree).getByRole('button', { name: 'Edit details of Win98_202601010002' }),
    );
    const dialog = await screen.findByRole('dialog', { name: /Edit details/ });
    fireEvent.change(within(dialog).getByLabelText(/Title/), { target: { value: '  Patched ' } });
    fireEvent.change(within(dialog).getByLabelText(/Description/), {
      target: { value: 'With the fixes' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.callsTo('PATCH', `${VM_PATH}/versions/${SNAP_B}`)).toHaveLength(1),
    );
    expect(api.callsTo('PATCH', `${VM_PATH}/versions/${SNAP_B}`)[0]?.body).toEqual({
      title: '  Patched ',
      description: 'With the fixes',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('will not save a title over its limit', async () => {
    base();
    const tree = await history();
    fireEvent.click(within(tree).getByRole('button', { name: 'Edit details of Master' }));
    const dialog = await screen.findByRole('dialog', { name: /Edit details/ });
    fireEvent.change(within(dialog).getByLabelText(/Title/), {
      target: { value: 't'.repeat(121) },
    });
    expect(within(dialog).getByText('121 / 120 characters')).toBeTruthy();
    expect(
      (within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('sends a new snapshot’s title and description when they are given', async () => {
    const api = base({
      [`POST ${VM_PATH}/snapshots`]: snapshotOperation(),
      [`GET /admin/registrations/${registrationOperation().id}`]: snapshotOperation(),
    });
    const tree = await history();
    fireEvent.click(within(tree).getByRole('button', { name: 'Create snapshot from Study PC…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a snapshot from Study PC' });
    fireEvent.change(within(dialog).getByLabelText(/Title/), { target: { value: 'Before SP1' } });
    fireEvent.change(within(dialog).getByLabelText(/Description/), {
      target: { value: 'Two\nlines' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create snapshot' }));
    await waitFor(() => expect(api.callsTo('POST', `${VM_PATH}/snapshots`)).toHaveLength(1));
    const body = api.callsTo('POST', `${VM_PATH}/snapshots`)[0]?.body as Record<string, string>;
    expect(body.title).toBe('Before SP1');
    expect(body.description).toBe('Two\nlines');
  });
});

describe('promoting a snapshot to master', () => {
  it('offers no promotion for the master', async () => {
    base();
    const tree = await history();
    expect(within(tree).queryByRole('button', { name: 'Promote Master to master' })).toBeNull();
    expect(
      within(tree).getByRole('button', { name: 'Promote Win98_202601010001 to master' }),
    ).toBeTruthy();
  });

  it('previews what is kept and deleted, then promotes against that history', async () => {
    const api = base({
      [`GET ${VM_PATH}/versions/${SNAP_A}/promotion`]: promotionPreview(),
      [`POST ${VM_PATH}/versions/${SNAP_A}/promotion`]: remasterOperation(),
      [`GET /admin/remasters/${REMASTER_ID}`]: remasterOperation(),
      [`GET ${VM_PATH}/remasters`]: { remasters: [] },
    });
    const tree = await history();
    fireEvent.click(
      within(tree).getByRole('button', { name: 'Promote Win98_202601010001 to master' }),
    );
    const dialog = await screen.findByRole('dialog', { name: /to master/ });
    expect(await within(dialog).findByText('Kept (2)')).toBeTruthy();
    expect(within(dialog).getByText(/Permanently deleted \(2/)).toBeTruthy();
    expect(within(dialog).getByText(/cannot be undone/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote to master' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `${VM_PATH}/versions/${SNAP_A}/promotion`)).toHaveLength(1),
    );
    const body = api.callsTo('POST', `${VM_PATH}/versions/${SNAP_A}/promotion`)[0]?.body as Record<
      string,
      unknown
    >;
    expect(body.expectedRevision).toBe(REVISION);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).not.toHaveProperty('acknowledgeLineageConflicts');
    expect(await screen.findByText(/Cleaning obsolete archives/, { selector: 'div' })).toBeTruthy();
  });

  it('needs lineage conflicts acknowledged first', async () => {
    const api = base({
      [`GET ${VM_PATH}/versions/${SNAP_A}/promotion`]: promotionPreview({
        lineageConflicts: [
          { agentId: AGENT_ID, agentName: 'Study PC', versionId: SNAP_B, versionLabel: 'B' },
        ],
      }),
      [`POST ${VM_PATH}/versions/${SNAP_A}/promotion`]: remasterOperation(),
      [`GET /admin/remasters/${REMASTER_ID}`]: remasterOperation(),
    });
    const tree = await history();
    fireEvent.click(
      within(tree).getByRole('button', { name: 'Promote Win98_202601010001 to master' }),
    );
    const dialog = await screen.findByRole('dialog', { name: /to master/ });
    const confirm = (await within(dialog).findByRole('button', {
      name: 'Promote to master',
    })) as HTMLButtonElement;
    await within(dialog).findByText(/need a restore \(|need a restore before/, { selector: 'p' });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.callsTo('POST', `${VM_PATH}/versions/${SNAP_A}/promotion`)).toHaveLength(1),
    );
    expect(
      (
        api.callsTo('POST', `${VM_PATH}/versions/${SNAP_A}/promotion`)[0]?.body as Record<
          string,
          unknown
        >
      ).acknowledgeLineageConflicts,
    ).toBe(true);
  });

  it('cannot be confirmed when the preview is refused, and shows a stale history', async () => {
    base({
      [`GET ${VM_PATH}/versions/${SNAP_A}/promotion`]: promotionPreview({
        refusal: { code: 'version_in_use', message: 'A copy of a removed version is in use.' },
      }),
    });
    const tree = await history();
    fireEvent.click(
      within(tree).getByRole('button', { name: 'Promote Win98_202601010001 to master' }),
    );
    const dialog = await screen.findByRole('dialog', { name: /to master/ });
    expect(await within(dialog).findByText(/A copy of a removed version is in use/)).toBeTruthy();
    expect(
      (within(dialog).getByRole('button', { name: 'Promote to master' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('keeps the dialog open with the reason when the history changed meanwhile', async () => {
    base({
      [`GET ${VM_PATH}/versions/${SNAP_A}/promotion`]: promotionPreview(),
      [`POST ${VM_PATH}/versions/${SNAP_A}/promotion`]: apiError(
        409,
        'version_history_stale',
        'The version history changed since it was shown.',
      ),
    });
    const tree = await history();
    fireEvent.click(
      within(tree).getByRole('button', { name: 'Promote Win98_202601010001 to master' }),
    );
    const dialog = await screen.findByRole('dialog', { name: /to master/ });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Promote to master' }));
    expect(await within(dialog).findByText(/changed since it was shown/)).toBeTruthy();
  });
});

describe('remastering from a local copy', () => {
  function localPreview(): RemasterPreview {
    return promotionPreview({
      kind: 'local_copy',
      promoted: null,
      retained: [],
      removed: [
        brief(MASTER, null, 0),
        brief(SNAP_A, MASTER, 1),
        brief(SNAP_B, MASTER, 2),
        brief(SNAP_C, SNAP_A, 3),
      ],
      source: {
        agentId: AGENT_ID,
        agentName: 'Study PC',
        online: true,
        sourceName: 'Win98',
        machineUuid: null,
        localSourceVersionId: SNAP_B,
        contentStatus: 'modified',
      },
    });
  }

  it('needs the exact VM name typed, then follows each phase', async () => {
    const api = base({
      [`GET ${VM_PATH}/remaster/local`]: localPreview(),
      [`POST ${VM_PATH}/remaster/local`]: remasterOperation({
        kind: 'local_copy',
        state: 'exporting',
        phase: 'uploading',
        newMasterVersionId: null,
        agentId: AGENT_ID,
        agentName: 'Study PC',
        progress: { doneBytes: 25, totalBytes: 100 },
      }),
      [`GET /admin/remasters/${REMASTER_ID}`]: remasterOperation({
        kind: 'local_copy',
        state: 'exporting',
        phase: 'uploading',
        newMasterVersionId: null,
        agentId: AGENT_ID,
        agentName: 'Study PC',
        progress: { doneBytes: 25, totalBytes: 100 },
      }),
    });
    await history();
    fireEvent.click(screen.getByRole('button', { name: 'Remaster from local copy…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remaster from a local copy' });
    expect(await within(dialog).findByText(/Permanently deleted \(4/)).toBeTruthy();
    expect(api.callsTo('GET', `${VM_PATH}/remaster/local`)[0]?.query.get('agentId')).toBe(AGENT_ID);
    const confirm = within(dialog).getByRole('button', {
      name: 'Replace the history',
    }) as HTMLButtonElement;
    const name = within(dialog).getByLabelText(/to confirm/);
    fireEvent.change(name, { target: { value: 'win98' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Win98' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(api.callsTo('POST', `${VM_PATH}/remaster/local`)).toHaveLength(1));
    expect(api.callsTo('POST', `${VM_PATH}/remaster/local`)[0]?.body).toMatchObject({
      agentId: AGENT_ID,
      expectedRevision: REVISION,
      confirmVmName: 'Win98',
    });
    const progress = await screen.findByText(/Remaster from a local copy/, { selector: 'strong' });
    const status = progress.closest('[role="status"]') as HTMLElement;
    expect(within(status).getByText(/Uploading \(25%\)/)).toBeTruthy();
    expect(within(status).getByText('Committing new master')).toBeTruthy();
  });

  it('shows a failed cleanup with its reason and retries it', async () => {
    const failing = remasterOperation({
      cleanup: {
        total: 2,
        deleted: 1,
        complete: false,
        items: [
          {
            versionId: SNAP_B,
            label: 'Win98_202601010002',
            state: 'deleting',
            archiveOutcome: null,
            attempts: 2,
            error: { code: 'repository_unavailable', message: 'The NAS did not answer.' },
          },
        ],
      },
    });
    const api = base({
      [`GET ${VM_PATH}/remasters`]: { remasters: [failing] },
      [`GET /admin/remasters/${REMASTER_ID}`]: failing,
      [`POST /admin/remasters/${REMASTER_ID}/cleanup/retry`]: failing,
    });
    await history();
    expect(await screen.findByText(/The NAS did not answer/)).toBeTruthy();
    expect(screen.getByText(/1 of 2 obsolete archives deleted/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry cleanup now' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/remasters/${REMASTER_ID}/cleanup/retry`)).toHaveLength(1),
    );
  });
});

describe('version tags', () => {
  const GOLD = { id: '018f47a0-7c2b-4f7e-9a3d-00000000b001', name: 'gold' };
  const BETA = { id: '018f47a0-7c2b-4f7e-9a3d-00000000b002', name: 'beta' };

  it('shows each version’s own tags, and edits a snapshot’s without touching its master', async () => {
    const tree = branchingTree();
    tree.versions[0] = { ...(tree.versions[0] as VersionNode), tags: [GOLD] };
    const api = base({
      [`GET ${VM_PATH}/versions`]: tree,
      'GET /admin/tags': { tags: [GOLD, BETA] },
      [`PUT ${VM_PATH}/versions/${SNAP_B}/tags`]: { tags: [BETA] },
    });
    const drawn = await history();
    expect(within(drawn).getByRole('list', { name: 'Tags of Master' }).textContent).toBe('#gold');
    expect(within(drawn).queryByRole('list', { name: 'Tags of Win98_202601010002' })).toBeNull();

    fireEvent.click(within(drawn).getByRole('button', { name: 'Tags of Win98_202601010002' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Snapshot tags' }));
    fireEvent.change(dialog.getByLabelText('Tags'), { target: { value: 'be' } });
    fireEvent.click(await dialog.findByRole('option', { name: '#beta' }, { timeout: 4000 }));
    await waitFor(
      () =>
        expect(
          within(drawn).getByRole('list', { name: 'Tags of Win98_202601010002' }).textContent,
        ).toBe('#beta'),
      { timeout: 4000 },
    );
    expect(api.callsTo('PUT', `${VM_PATH}/versions/${SNAP_B}/tags`)[0]?.body).toEqual({
      tagIds: [BETA.id],
    });
    // The master keeps its own.
    expect(within(drawn).getByRole('list', { name: 'Tags of Master' }).textContent).toBe('#gold');
  });
});

describe('view archive contents', () => {
  const ARCHIVE = `${VM_PATH}/versions/${MASTER}/archive`;
  function summary() {
    return {
      vm: { emulatorType: 'qemu', vmName: 'Win98', title: 'Windows 98 SE' },
      version: {
        id: MASTER,
        kind: 'master',
        snapshotName: null,
        title: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      archive: {
        format: 'zip',
        fileName: `${MASTER}.zip`,
        repositoryName: 'NAS',
        sizeBytes: 4096,
        sha256: SHA,
      },
      complete: true,
      manifest: {
        manifestVersion: 1,
        vmName: 'Win98',
        fileCount: 2,
        directoryCount: 1,
        totalUncompressedBytes: 3000,
        sha256: SHA,
        matchesRegistration: true,
      },
      physical: {
        entryCount: 4,
        fileCount: 3,
        directoryCount: 1,
        compressedBytes: 2000,
        uncompressedBytes: 3100,
      },
      views: ['logical', 'physical'],
      warnings: [],
    };
  }
  const entry = (path: string, type: 'file' | 'directory', extra = {}) => ({
    name: path.split('/').at(-1),
    path,
    type,
    sizeBytes: type === 'file' ? 1000 : null,
    compressedSizeBytes: null,
    method: null,
    sha256: type === 'file' ? SHA : null,
    modifiedAt: null,
    childCount: type === 'directory' ? 1 : null,
    ...extra,
  });
  const listing = (call: { query: URLSearchParams }) => {
    const view = call.query.get('view');
    const path = call.query.get('path') ?? '';
    const q = call.query.get('q');
    const entries =
      view === 'physical'
        ? [entry('.emucat-manifest.json', 'file', { method: 'deflated', compressedSizeBytes: 90 })]
        : q
          ? [entry('disks/hdd0.img', 'file')]
          : path === 'disks'
            ? [entry('disks/hdd0.img', 'file')]
            : [entry('disks', 'directory'), entry('vm.cfg', 'file')];
    return { view, path, q, entries, total: entries.length, nextOffset: null };
  };

  it('opens Archive Explorer, which browses the archive one directory at a time, read-only', async () => {
    const api = base({
      [`GET ${ARCHIVE}`]: summary(),
      [`GET ${ARCHIVE}/entries`]: listing,
    });
    const tree = await history();
    fireEvent.click(
      within(tree).getAllByRole('button', { name: /View the archive contents of Master/ })[0]!,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Archive Explorer' });
    const files = within(await within(dialog).findByRole('tree', { name: 'Archive files' }));
    expect(await files.findByRole('treeitem', { name: 'vm.cfg' })).toBeTruthy();
    // The archive's details are on demand, in Archive information.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive information' }));
    expect(within(dialog).getByText(`${MASTER}.zip`)).toBeTruthy();
    expect(within(dialog).getByText(/complete archive/)).toBeTruthy();
    expect(within(dialog).getByText(/verified when this version was registered/)).toBeTruthy();

    fireEvent.click(files.getByRole('treeitem', { name: 'disks, directory' }));
    expect(await files.findByRole('treeitem', { name: 'hdd0.img' })).toBeTruthy();
    expect(
      files.getByRole('treeitem', { name: 'disks, directory' }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(api.calls.some((call) => call.query.get('path') === 'disks')).toBe(true);

    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Search paths' }), {
      target: { value: 'hdd' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Search' }));
    const results = within(await within(dialog).findByRole('tree', { name: 'Search results' }));
    expect(await results.findByRole('treeitem', { name: 'disks/hdd0.img' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Stored entries' }));
    expect(
      await within(dialog).findByRole('treeitem', { name: '.emucat-manifest.json' }),
    ).toBeTruthy();
    // Nothing but reads.
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('explains why an archive cannot be listed', async () => {
    base({
      [`GET ${ARCHIVE}`]: apiError(503, 'server_repository_unavailable', 'unavailable'),
    });
    const tree = await history();
    fireEvent.click(
      within(tree).getAllByRole('button', { name: /View the archive contents of Master/ })[0]!,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Archive Explorer' });
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(
      /no connection of its own/,
    );
  });
});
