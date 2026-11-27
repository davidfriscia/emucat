/**
 * Operation visibility (decision 0060): what Version History and General show of the VM's snapshots and clones, from
 * the one listing the server keeps, through navigation, a refresh, an offline agent, an unavailable status, a failure
 * and several operations at once.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  ExecutionOptionsResponse,
  RegistrationOperation,
  VersionNode,
  VmOperationListResponse,
} from '@emucat/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminVm, mockApi, renderAt, signedInAsAdmin } from './mock-api';
import { registrationOperation } from './registration-fixture';

const VM_PATH = '/admin/vms/qemu/Win98';
const AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9001';
const MASTER = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9010';
const SNAP_A = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9011';
const SNAP_C = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9013';
const SHA = 'a'.repeat(64);

function node(
  id: string,
  parent: string | null,
  minute: number,
  children: string[] = [],
): VersionNode {
  return {
    id,
    kind: parent === null ? 'master' : 'snapshot',
    parentVersionId: parent,
    childVersionIds: children,
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
  };
}

/** master ─▶ A ─▶ C. */
function tree() {
  return {
    emulatorType: 'qemu',
    vmName: 'Win98',
    rootVersionId: MASTER,
    versions: [
      node(MASTER, null, 0, [SNAP_A]),
      node(SNAP_A, MASTER, 1, [SNAP_C]),
      node(SNAP_C, SNAP_A, 3),
    ],
  };
}

let sequence = 0;
function id(): string {
  sequence += 1;
  return `018f47a0-7c2b-4f7e-9a3d-${String(sequence).padStart(12, '0')}`;
}

function snapshotOn(
  parent: string,
  overrides: Partial<RegistrationOperation> = {},
): RegistrationOperation {
  return {
    ...registrationOperation(),
    id: id(),
    versionId: id(),
    mode: 'snapshot',
    state: 'uploading',
    parentVersionId: parent,
    snapshotName: `Win98_20261127${String(sequence).padStart(4, '0')}`,
    localCopy: null,
    error: null,
    recovery: null,
    finishedAt: null,
    committedAt: null,
    archive: null,
    progress: { doneBytes: 30, totalBytes: 120 },
    ...overrides,
  };
}

function cloneOf(
  source: string,
  overrides: Partial<RegistrationOperation> = {},
): RegistrationOperation {
  return {
    ...snapshotOn(source),
    mode: 'clone',
    vmName: 'Win98_Copy',
    parentVersionId: null,
    snapshotName: null,
    performedBy: 'server',
    agentId: null,
    agentName: null,
    agentOnline: false,
    state: 'archiving',
    cloneSource: { vmName: 'Win98', versionId: source },
    ...overrides,
  };
}

function listing(...operations: RegistrationOperation[]): VmOperationListResponse {
  return {
    operations: operations.map((operation) => ({
      relation: operation.mode === 'clone' ? 'clone_source' : 'this_vm',
      operation,
      transport: operation.performedBy === 'server' ? 'server' : 'relay',
    })),
    retentionHours: 24,
    serverTime: new Date().toISOString(),
  };
}

const MODES: ExecutionOptionsResponse['modes'] = [
  { mode: 'local', available: true, reason: null },
  { mode: 'remote_volatile', available: true, reason: null },
  { mode: 'remote_snapshot', available: true, reason: null },
];

function executionOptions(): ExecutionOptionsResponse {
  return {
    modes: MODES,
    agents: [
      {
        agentId: AGENT_ID,
        agentName: 'Study PC',
        online: true,
        launch: { eligible: true, reason: null, problem: null },
        verify: { eligible: true, reason: null },
        remote: {
          remote_volatile: { eligible: true, reason: null, problem: null },
          remote_snapshot: { eligible: true, reason: null, problem: null },
        },
        activeWorkspaceId: null,
        local: {
          present: true,
          contentStatus: 'verified',
          sourceVersionId: MASTER,
          lastVerifiedAt: null,
        },
        activeSession: null,
        lastSession: null,
        lastVerification: null,
      },
    ],
  } as ExecutionOptionsResponse;
}

/** The VM's pages, answering the operations listing with whatever `current` returns at the time. */
function page(
  current: () => VmOperationListResponse | Error,
  routes: Record<string, unknown> = {},
) {
  return mockApi({
    ...signedInAsAdmin,
    [`GET ${VM_PATH}`]: adminVm(),
    [`GET ${VM_PATH}/versions`]: tree(),
    [`GET ${VM_PATH}/workspaces`]: { workspaces: [] },
    [`GET ${VM_PATH}/restore-options`]: {
      master: {
        versionId: MASTER,
        repositoryId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9030',
        repositoryName: 'NAS',
        repositoryEnabled: true,
        archiveSizeBytes: 2048,
        archiveSha256: SHA,
        createdAt: '2026-01-01T00:00:00.000Z',
        manifestSha256: SHA,
        fileCount: 3,
        totalUncompressedBytes: 4096,
      },
      versions: [],
      agents: [],
    },
    [`GET ${VM_PATH}/remasters`]: { remasters: [] },
    [`GET ${VM_PATH}/execution-options`]: executionOptions(),
    'GET /admin/sessions': { sessions: [] },
    [`GET ${VM_PATH}/operations`]: () => {
      const value = current();
      if (value instanceof Error) throw value;
      return value;
    },
    ...routes,
  });
}

async function versionHistory() {
  renderAt(`${VM_PATH}/versions`);
  return screen.findByRole('tree', { name: 'Versions of Win98' });
}

const item = (scope: HTMLElement, index: number) =>
  within(scope).getAllByRole('treeitem')[index] as HTMLElement;
/** A version's own card, without the cards of its children. */
const card = (scope: HTMLElement, index: number) =>
  item(scope, index).querySelector(':scope > .version-card') as HTMLElement;

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // jsdom always has it.
  }
});
afterEach(() => {
  sequence = 0;
});

describe('operations on the version they concern', () => {
  it('draw a snapshot on its parent, and a clone of a snapshot on that snapshot, never on the master', async () => {
    const snapshot = snapshotOn(MASTER);
    const clone = cloneOf(SNAP_A);
    page(() => listing(snapshot, clone));
    const drawn = await versionHistory();
    const master = card(drawn, 0);
    const a = card(drawn, 1);
    expect(
      await within(master).findByRole('button', {
        name: 'Creating snapshot of Master: Transferring 25%',
      }),
    ).toBeTruthy();
    const cloning = within(a).getByRole('button', {
      name: 'Cloning VM of Win98_202601010001: Copying the source archive 25%',
    });
    expect(cloning.querySelector('.icon-spin')).not.toBeNull();
    // Each indicator is in its card's own toolbar, just before Info.
    const toolbar = within(a).getAllByRole('toolbar')[0] as HTMLElement;
    const controls = within(toolbar).getAllByRole('button');
    const at = controls.indexOf(cloning);
    expect(controls[at + 1]?.getAttribute('aria-label')).toBe(
      'Information about Win98_202601010001',
    );
    expect(within(master).queryByRole('button', { name: /Cloning VM/ })).toBeNull();
    expect(within(card(drawn, 2)).queryByRole('button', { name: /Creating|Cloning/ })).toBeNull();
  });

  it('show several operations at once without one hiding another, and count them for the page', async () => {
    const first = snapshotOn(MASTER);
    const second = snapshotOn(MASTER, {
      state: 'queued',
      progress: { doneBytes: null, totalBytes: null },
    });
    const clone = cloneOf(SNAP_C);
    page(() => listing(first, second, clone));
    const drawn = await versionHistory();
    const master = item(drawn, 0);
    const both = await within(master).findByRole('button', {
      name: 'Operations of Master: 2 of 2 operations running',
    });
    fireEvent.click(both);
    const panel = within(
      await within(master).findByRole('dialog', { name: 'Operations of Master' }),
    );
    expect(panel.getByText(first.id)).toBeTruthy();
    expect(panel.getByText(second.id)).toBeTruthy();
    expect(panel.getByText('Transferring: 30 bytes of 120 bytes (25%).')).toBeTruthy();
    expect(panel.getByText('Queued; this phase is not measured.')).toBeTruthy();
    fireEvent.keyDown(panel.getByText(first.id), { key: 'Escape' });
    expect(
      screen.getByRole('button', { name: 'Operations of this VM: 3 operations running' }),
    ).toBeTruthy();
  });

  it('still count an operation on a collapsed branch, and keep the branch collapsed when it ends', async () => {
    let clone = cloneOf(SNAP_C);
    const api = page(() => listing(clone));
    const drawn = await versionHistory();
    await within(item(drawn, 2)).findByRole('button', {
      name: /^Cloning VM of Win98_202601010003/,
    });
    fireEvent.click(
      within(item(drawn, 1)).getByRole('button', { name: 'Collapse Win98_202601010001' }),
    );
    expect(within(drawn).getAllByRole('treeitem')).toHaveLength(2);
    const summary = screen.getByRole('button', {
      name: 'Operations of this VM: 1 operation running',
    });
    fireEvent.click(summary);
    const panel = within(await screen.findByRole('dialog', { name: 'Operations of this VM' }));
    // Named by the version it concerns, found by identifier.
    expect(panel.getByText('· Win98_202601010003')).toBeTruthy();
    fireEvent.keyDown(panel.getByText(clone.id), { key: 'Escape' });

    const reads = api.callsTo('GET', `${VM_PATH}/versions`).length;
    clone = cloneOf(SNAP_C, {
      id: clone.id,
      state: 'succeeded',
      progress: { doneBytes: null, totalBytes: null },
      finishedAt: new Date().toISOString(),
    });
    await waitFor(
      () => expect(api.callsTo('GET', `${VM_PATH}/versions`).length).toBeGreaterThan(reads),
      {
        timeout: 5_000,
      },
    );
    // Read again, drawn again, as it was left.
    expect(within(drawn).getAllByRole('treeitem')).toHaveLength(2);
    expect(
      within(item(drawn, 1)).getByRole('button', { name: 'Expand Win98_202601010001' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Operations of this VM: 1 recent operation' }),
    ).toBeTruthy();
  });

  it('say an agent is offline as waiting for it, without a spinner', async () => {
    page(() => listing(snapshotOn(MASTER, { agentOnline: false, state: 'archiving' })));
    const drawn = await versionHistory();
    const waiting = await within(item(drawn, 0)).findByRole('button', {
      name: 'Creating snapshot of Master: Waiting for the agent',
    });
    expect(waiting.querySelector('.icon-spin')).toBeNull();
    expect(waiting.className).toMatch(/operation-tone-warning/);
  });

  it('never show 100% while verification and publication remain', async () => {
    page(() => listing(snapshotOn(MASTER, { progress: { doneBytes: 120, totalBytes: 120 } })));
    const drawn = await versionHistory();
    const indicator = await within(item(drawn, 0)).findByRole('button', {
      name: 'Creating snapshot of Master: Transferring',
    });
    expect(indicator.textContent).not.toMatch(/%/);
  });
});

describe('the state of operations, kept by the server', () => {
  it('say when the status cannot be read, stop the spinner, and recover by themselves', async () => {
    let failing = false;
    const running = snapshotOn(MASTER);
    page(() => (failing ? new TypeError('Failed to fetch') : listing(running)));
    const drawn = await versionHistory();
    const master = item(drawn, 0);
    await within(master).findByRole('button', {
      name: 'Creating snapshot of Master: Transferring 25%',
    });
    failing = true;
    const stale = await within(master).findByRole(
      'button',
      { name: 'Creating snapshot of Master: Transferring 25%, status unavailable' },
      { timeout: 5_000 },
    );
    // Neither a failure nor still known to run: the last state, without the animation.
    expect(stale.querySelector('.icon-spin')).toBeNull();
    expect(stale.textContent).toMatch(/status unavailable/);
    expect(screen.queryByRole('list', { name: 'Ended operations' })).toBeNull();
    fireEvent.click(stale);
    expect(await within(master).findByText(/The status cannot be read right now/)).toBeTruthy();
    fireEvent.keyDown(stale, { key: 'Escape' });
    failing = false;
    const back = await within(master).findByRole(
      'button',
      { name: 'Creating snapshot of Master: Transferring 25%' },
      { timeout: 5_000 },
    );
    expect(back.querySelector('.icon-spin')).not.toBeNull();
  });

  it('keep a failure in view, with what to do, across navigation, until it is dismissed', async () => {
    const failed = cloneOf(MASTER, {
      state: 'failed',
      progress: { doneBytes: null, totalBytes: null },
      error: { code: 'repository_unreachable', message: 'The repository did not answer.' },
      recovery: 'Check that the SSH server is running and reachable, and try again.',
      finishedAt: new Date().toISOString(),
    });
    page(() => listing(failed));
    const drawn = await versionHistory();
    const notices = within(await screen.findByRole('list', { name: 'Ended operations' }));
    expect(notices.getByText('Clone failed: Win98_Copy')).toBeTruthy();
    expect(notices.getByText('The repository did not answer.')).toBeTruthy();
    expect(notices.getByText(/SSH server is running/)).toBeTruthy();
    expect(notices.getByText('Clone failed: Win98_Copy').closest('.alert-danger')).not.toBeNull();
    const indicator = within(item(drawn, 0)).getByRole('button', {
      name: 'Clone failed of Master: Failed',
    });
    expect(indicator.className).toMatch(/operation-tone-danger/);

    // General shows the same, from the same list.
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'VM' })).getByRole('link', { name: 'General' }),
    );
    const onGeneral = within(await screen.findByRole('list', { name: 'Ended operations' }));
    expect(onGeneral.getByText('Clone failed: Win98_Copy')).toBeTruthy();
    fireEvent.click(onGeneral.getByRole('button', { name: 'Dismiss: Clone failed: Win98_Copy' }));
    expect(screen.queryByRole('list', { name: 'Ended operations' })).toBeNull();
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'VM' })).getByRole('link', {
        name: 'Version History',
      }),
    );
    await screen.findByRole('tree', { name: 'Versions of Win98' });
    expect(screen.queryByRole('list', { name: 'Ended operations' })).toBeNull();
    // Dismissed here only: the record itself was never touched.
  });

  it('come back after a refresh, and are followed by one request loop for every section', async () => {
    const running = snapshotOn(MASTER, {
      state: 'verifying',
      progress: { doneBytes: 60, totalBytes: 120 },
    });
    const api = page(() => listing(running));
    const first = renderAt(`${VM_PATH}/versions`);
    await screen.findByRole('button', { name: 'Creating snapshot of Master: Verifying 50%' });
    first.unmount();

    // A new page load: nothing is remembered in the browser, and the server still lists it.
    renderAt(VM_PATH);
    const now = within(await screen.findByRole('region', { name: 'Now' }));
    expect(
      await now.findByRole('button', { name: 'Creating snapshot of Master: Verifying 50%' }),
    ).toBeTruthy();
    expect(now.getByText('No VM session is running.')).toBeTruthy();
    expect(now.queryByText('Nothing is running.')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Operations of this VM: 1 operation running' }),
    ).toBeTruthy();

    const before = api.callsTo('GET', `${VM_PATH}/operations`).length;
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'VM' })).getByRole('link', {
        name: 'Version History',
      }),
    );
    await screen.findByRole('button', { name: 'Creating snapshot of Master: Verifying 50%' });
    // The list is the layout's: changing section asks for nothing new.
    expect(api.callsTo('GET', `${VM_PATH}/operations`).length).toBe(before);
  });

  it('announce an ending once, and never each progress update', async () => {
    let running = snapshotOn(MASTER);
    page(() => listing(running));
    await versionHistory();
    const live = document.querySelector('.operation-announcer') as HTMLElement;
    await screen.findByRole('button', { name: /Transferring 25%/ });
    running = { ...running, progress: { doneBytes: 90, totalBytes: 120 } };
    await screen.findByRole('button', { name: /Transferring 75%/ }, { timeout: 5_000 });
    expect(live.textContent).toBe('');
    running = {
      ...running,
      state: 'failed',
      progress: { doneBytes: null, totalBytes: null },
      error: { code: 'hash_mismatch', message: 'The uploaded archive did not match.' },
      finishedAt: new Date().toISOString(),
    };
    await waitFor(() => expect(live.textContent).toBe(`Snapshot failed: ${running.snapshotName}`), {
      timeout: 5_000,
    });
  });
});

describe('Remote Snapshot', () => {
  it('shows the emulator running as a session, and only its publication as an operation', async () => {
    const workspace = {
      id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9020',
      agentId: AGENT_ID,
      agentName: 'Study PC',
      agentOnline: true,
      emulatorType: 'qemu',
      vmName: 'Win98',
      purpose: 'remote_snapshot',
      state: 'running',
      baseVersionId: MASTER,
      sourceVersionId: MASTER,
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
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: null,
      restore: null,
      session: null,
      snapshot: null,
      recovery: null,
    };
    let publishing: RegistrationOperation | null = null;
    page(() => listing(...(publishing ? [publishing] : [])), {
      [`GET ${VM_PATH}/workspaces`]: { workspaces: [workspace] },
    });
    renderAt(VM_PATH);
    const now = within(await screen.findByRole('region', { name: 'Now' }));
    // The emulator runs: a remote session, not a synchronization, and nothing turns for an operation.
    await waitFor(() => expect(now.queryByText('Nothing is running.')).toBeNull());
    expect(now.queryByText('Archive operations')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Operations of this VM/ })).toBeNull();

    // The emulator ended; the server publishes the working copy as a snapshot.
    publishing = snapshotOn(MASTER, {
      workspaceId: workspace.id,
      state: 'archiving',
      progress: { doneBytes: null, totalBytes: null },
    });
    expect(
      await now.findByRole(
        'button',
        { name: 'Publishing Remote Snapshot of Master: Packaging' },
        { timeout: 20_000 },
      ),
    ).toBeTruthy();
  }, 30_000);
});

describe('the spinner', () => {
  it('turns slowly where less motion is asked for, and is named in words, not by its motion', async () => {
    const css = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8');
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.icon-spin\s*\{\s*animation-duration: 3s;/,
    );
    page(() => listing(snapshotOn(MASTER)));
    const drawn = await versionHistory();
    const indicator = await within(item(drawn, 0)).findByRole('button', {
      name: /Creating snapshot/,
    });
    const icon = indicator.querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(indicator.getAttribute('aria-label')).toMatch(/Transferring 25%/);
    void act;
  });
});
