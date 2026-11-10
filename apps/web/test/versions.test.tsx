import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  RegistrationOperation,
  RestoreOptionsResponse,
  VersionNode,
  VmWorkspace,
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
    archiveSizeBytes: 2048,
    archiveSha256: SHA,
    manifest: { sha256: SHA, fileCount: 3, totalUncompressedBytes: 4096, verifiedBy: 'agent' },
    repositoryName: 'NAS',
    available: true,
    createdByAgentName: 'Study PC',
    createdByDisplayName: 'Ada Admin',
    holders: [],
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
        cacheUsedBytes: 0,
        cacheMaxBytes: 1000,
      },
    ],
  } as RestoreOptionsResponse;
}

function workspace(overrides: Partial<VmWorkspace> = {}): VmWorkspace {
  return {
    id: WORKSPACE,
    agentId: AGENT_ID,
    agentName: 'Study PC',
    agentOnline: true,
    emulatorType: 'qemu',
    vmName: 'Win98',
    state: 'ready',
    baseVersionId: SNAP_A,
    sourceVersionId: SNAP_A,
    mayHaveChanges: true,
    launchOnReady: false,
    restoreOperationId: null,
    localDirectory: 'C:\\state\\workspaces\\x\\Win98',
    error: null,
    requestedByDisplayName: 'Ada Admin',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
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
    ...routes,
  });
}

async function history() {
  renderAt(VM_PATH);
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
    renderAt(VM_PATH);
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
    renderAt(VM_PATH);
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

describe('Remote Snapshot', () => {
  it('prepares and launches a working copy of the chosen version, after a confirmation', async () => {
    const api = base({
      [`POST ${VM_PATH}/workspaces`]: workspace({ state: 'preparing', launchOnReady: true }),
    });
    const tree = await history();
    const c = within(tree).getAllByRole('treeitem')[2] as HTMLElement;
    fireEvent.click(within(c).getByRole('button', { name: 'Launch in Remote Snapshot…' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Launch Win98_202601010003 in Remote Snapshot',
    });
    expect(within(dialog).getByText(/nothing is published/)).toBeTruthy();
    expect(within(dialog).getByText(/persistent local copy is not touched/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Prepare and launch' }));
    await waitFor(() => expect(api.callsTo('POST', `${VM_PATH}/workspaces`)).toHaveLength(1));
    const body = api.callsTo('POST', `${VM_PATH}/workspaces`)[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ agentId: AGENT_ID, versionId: SNAP_C, launch: true });
    expect(Object.keys(body).sort()).toEqual(['agentId', 'launch', 'requestId', 'versionId']);
  });

  it('preserves a stopped working copy only when asked', async () => {
    const api = base({
      [`GET ${VM_PATH}/workspaces`]: { workspaces: [workspace()] },
      [`POST /admin/workspaces/${WORKSPACE}/snapshot`]: snapshotOperation({
        parentVersionId: SNAP_A,
      }),
      [`GET /admin/registrations/${registrationOperation().id}`]: snapshotOperation(),
    });
    renderAt(VM_PATH);
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
    renderAt(VM_PATH);
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
    renderAt(VM_PATH);
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
    renderAt(VM_PATH);
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
});
