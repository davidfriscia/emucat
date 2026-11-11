import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { RestoreOperation, RestoreOptionsResponse } from '@emucat/contracts';
import { describe, expect, it } from 'vitest';
import { adminVm, apiError, mockApi, renderAt, Reply, signedInAsAdmin } from './mock-api';

const VM_PATH = '/admin/vms/qemu/Win98';
const OPTIONS_PATH = `${VM_PATH}/restore-options`;
const AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6001';
const OTHER_AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6002';
const VERSION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6003';
const REPOSITORY_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6004';
const OPERATION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6005';
const SHA = 'a'.repeat(64);
const PAST = '2026-01-01T00:00:00.000Z';

function agentOption(overrides: object = {}) {
  return {
    agentId: AGENT_ID,
    agentName: 'Study PC',
    online: true,
    eligible: true,
    ineligibleReason: null,
    destination: 'C:\\vms\\qemu\\Win98',
    local: {
      availability: 'none',
      contentStatus: null,
      sourceVersionId: null,
      lastVerifiedAt: null,
    },
    replace: { eligible: false, reason: 'no_local_copy' },
    cacheUsedBytes: 0,
    cacheMaxBytes: 1000,
    ...overrides,
  };
}

function options(overrides: Partial<RestoreOptionsResponse> = {}): RestoreOptionsResponse {
  return {
    master: {
      versionId: VERSION_ID,
      repositoryId: REPOSITORY_ID,
      repositoryName: 'NAS',
      repositoryEnabled: true,
      archiveSizeBytes: 2048,
      archiveSha256: SHA,
      createdAt: PAST,
      manifestSha256: SHA,
      fileCount: 3,
      totalUncompressedBytes: 4096,
    },
    versions: [],
    agents: [agentOption()] as RestoreOptionsResponse['agents'],
    ...overrides,
  };
}

function operation(overrides: Partial<RestoreOperation> = {}): RestoreOperation {
  return {
    id: OPERATION_ID,
    agentId: AGENT_ID,
    agentName: 'Study PC',
    agentOnline: true,
    repositoryId: REPOSITORY_ID,
    repositoryName: 'NAS',
    emulatorType: 'qemu',
    vmName: 'Win98',
    versionId: VERSION_ID,
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
    createdAt: PAST,
    updatedAt: PAST,
    finishedAt: null,
    ...overrides,
  };
}

function base(routes: Record<string, unknown> = {}) {
  return mockApi({
    ...signedInAsAdmin,
    [`GET ${VM_PATH}`]: adminVm(),
    [`GET ${VM_PATH}/media`]: { media: [] },
    [`GET ${OPTIONS_PATH}`]: options(),
    'GET /admin/restores': { operations: [] },
    ...routes,
  });
}

async function openDialog() {
  renderAt(VM_PATH);
  fireEvent.click(await screen.findByRole('button', { name: 'Restore…' }));
  return screen.findByRole('dialog', { name: 'Restore Win98' });
}

describe('the VM’s page', () => {
  it('shows the master, the repository and what each agent holds', async () => {
    base({
      [`GET ${OPTIONS_PATH}`]: options({
        agents: [
          agentOption({
            local: {
              availability: 'present',
              contentStatus: 'verified',
              sourceVersionId: VERSION_ID,
              lastVerifiedAt: PAST,
            },
            eligible: false,
            ineligibleReason: 'local_copy_exists',
            replace: { eligible: false, reason: 'vm_running' },
          }),
          agentOption({
            agentId: OTHER_AGENT_ID,
            agentName: 'Laptop',
            online: false,
            eligible: false,
            ineligibleReason: 'agent_offline',
            local: {
              availability: 'absent',
              contentStatus: null,
              sourceVersionId: null,
              lastVerifiedAt: null,
            },
          }),
        ] as RestoreOptionsResponse['agents'],
      }),
    });
    renderAt(VM_PATH);
    const section = (
      await screen.findByRole('heading', { name: 'Local copies and restores' })
    ).closest('section') as HTMLElement;
    expect(await within(section).findByTitle(VERSION_ID)).toBeTruthy();
    expect(within(section).getByText(/in NAS/)).toBeTruthy();
    const table = within(
      within(section).getByRole('table', { name: 'Persistent copies of Win98' }),
    );
    const [, studyPc, laptop] = table.getAllByRole('row');
    expect(within(studyPc as HTMLElement).getByText(/Verified copy, as of/)).toBeTruthy();
    expect(within(studyPc as HTMLElement).getByText('Master')).toBeTruthy();
    expect(
      within(studyPc as HTMLElement).getByText('Not now: the VM is running there'),
    ).toBeTruthy();
    expect(within(laptop as HTMLElement).getByText(/No longer present on this agent/)).toBeTruthy();
    expect(within(laptop as HTMLElement).getByText('Offline')).toBeTruthy();
    expect(
      (within(section).getByRole('button', { name: 'Restore…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(section).getByText(/No agent can restore this VM right now/)).toBeTruthy();
  });

  it('says so when the local copy differs, and never that it is unchanged', async () => {
    base({
      [`GET ${OPTIONS_PATH}`]: options({
        agents: [
          agentOption({
            eligible: false,
            ineligibleReason: 'local_copy_exists',
            local: {
              availability: 'present',
              contentStatus: 'modified',
              sourceVersionId: VERSION_ID,
              lastVerifiedAt: null,
            },
          }),
        ] as RestoreOptionsResponse['agents'],
      }),
    });
    renderAt(VM_PATH);
    expect(await screen.findByText(/differs from its version/)).toBeTruthy();
  });

  it('has no restore for a VM with no master', async () => {
    base({ [`GET ${OPTIONS_PATH}`]: { master: null, versions: [], agents: [] } });
    renderAt(VM_PATH);
    expect(await screen.findByText('This VM has no master version to restore.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restore…' })).toBeNull();
  });

  it('keeps working when this part cannot be loaded', async () => {
    base({ [`GET ${OPTIONS_PATH}`]: apiError(500, 'internal_error', 'No') });
    renderAt(VM_PATH);
    expect(await screen.findByText('This information is not available right now.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Windows 98 SE' })).toBeTruthy();
  });
});

describe('the dialog', () => {
  it('states what will happen, and everything it was asked to show', async () => {
    base();
    const dialog = await openDialog();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const view = within(dialog);
    expect(view.getByText(/creates a local copy of the immutable version you choose/)).toBeTruthy();
    expect(view.getByText(/the VM is not started/)).toBeTruthy();
    expect(view.getByText(VERSION_ID)).toBeTruthy();
    expect(view.getByText('2.0 KiB')).toBeTruthy();
    expect(view.getByText('NAS')).toBeTruthy();
    expect(view.getByText('C:\\vms\\qemu\\Win98')).toBeTruthy();
    expect(view.getByText('No local copy')).toBeTruthy();
    expect(view.getByText(/Up to 6.0 KiB/)).toBeTruthy();
    expect(view.getByText('QEMU')).toBeTruthy();
  });

  it('offers no way to type a path', async () => {
    base();
    const dialog = await openDialog();
    expect(dialog.querySelector('input')).toBeNull();
    expect(dialog.querySelector('textarea')).toBeNull();
  });

  it('allows only eligible agents to be chosen', async () => {
    base({
      [`GET ${OPTIONS_PATH}`]: options({
        agents: [
          agentOption({
            agentId: OTHER_AGENT_ID,
            agentName: 'Laptop',
            online: false,
            eligible: false,
            ineligibleReason: 'agent_offline',
          }),
          agentOption(),
        ] as RestoreOptionsResponse['agents'],
      }),
    });
    const dialog = await openDialog();
    const select = within(dialog).getByRole('combobox', {
      name: 'Target agent',
    }) as HTMLSelectElement;
    expect(select.value).toBe(AGENT_ID);
    const offline = within(select).getByRole('option', {
      name: 'Laptop (offline)',
    }) as HTMLOptionElement;
    expect(offline.disabled).toBe(true);
  });

  it('sends identities and nothing else, then shows the operation', async () => {
    const api = base({
      'POST /admin/restores': operation(),
    });
    const dialog = await openDialog();
    (api.routes as Record<string, unknown>)['GET /admin/restores'] = {
      operations: [
        operation({
          state: 'downloading',
          progress: { doneBytes: 512, totalBytes: 2048 },
          cache: { hit: false, downloadedBytes: null, archiveCached: null, totalBytes: null },
        }),
      ],
    };
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.callsTo('POST', '/admin/restores')[0]?.body).toEqual({
      agentId: AGENT_ID,
      emulatorType: 'qemu',
      vmName: 'Win98',
      versionId: VERSION_ID,
    });
    expect(await screen.findByText('512 bytes of 2.0 KiB')).toBeTruthy();
    expect(screen.getByText(/so it is being downloaded/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Restore…' }));
  });

  it('shows a refusal, and stays open', async () => {
    base({
      'POST /admin/restores': apiError(409, 'local_copy_exists', 'This agent already holds a copy'),
    });
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await within(dialog).findByText('This agent already holds a copy')).toBeTruthy();
  });

  it('traps focus, closes with Escape, and returns focus', async () => {
    base();
    const dialog = await openDialog();
    const select = within(dialog).getByRole('combobox', { name: 'Target agent' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(select);
    cancel.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(select);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Restore…' }));
  });
});

describe('replacing a local copy', () => {
  const SNAPSHOT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6010';
  const holding = (contentStatus: 'verified' | 'modified' | 'unverified') =>
    options({
      versions: [
        {
          ...(options().master as NonNullable<RestoreOptionsResponse['master']>),
          kind: 'master',
          parentVersionId: null,
          snapshotName: null,
        },
        {
          ...(options().master as NonNullable<RestoreOptionsResponse['master']>),
          versionId: SNAPSHOT_ID,
          kind: 'snapshot',
          parentVersionId: VERSION_ID,
          snapshotName: 'Win98_after_setup',
        },
      ],
      agents: [
        agentOption({
          eligible: false,
          ineligibleReason: 'local_copy_exists',
          replace: { eligible: true, reason: null },
          local: {
            availability: 'present',
            contentStatus,
            sourceVersionId: VERSION_ID,
            lastVerifiedAt: contentStatus === 'verified' ? PAST : null,
          },
        }),
      ] as RestoreOptionsResponse['agents'],
    });

  const openReplacement = async () => {
    renderAt(VM_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore…' }));
    return within(await screen.findByRole('dialog', { name: 'Replace the local copy of Win98' }));
  };

  it('shows what is installed and what replaces it, and confirms with a button, not a typed name', async () => {
    const api = base({
      [`GET ${OPTIONS_PATH}`]: holding('verified'),
      'POST /admin/restores': operation({
        replacement: { replacedVersionId: VERSION_ID, discardLocalChanges: false },
      }),
    });
    const dialog = await openReplacement();
    fireEvent.change(dialog.getByLabelText('Version'), { target: { value: SNAPSHOT_ID } });
    expect(dialog.getByText('Installed now')).toBeTruthy();
    expect(dialog.getByText('Replaced by')).toBeTruthy();
    expect(
      dialog.getByText('Target agent', { selector: 'dt' }).nextElementSibling?.textContent,
    ).toBe('Study PC');
    expect(dialog.getByText('Local changes').nextElementSibling?.textContent).toMatch(/^None/);
    expect(dialog.getByText(/the current copy is left as it is/)).toBeTruthy();
    // Every replacement says what it does to the current copy; a verified one needs no further warning.
    const alerts = dialog.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toMatch(/will be replaced.*may be permanently lost/);
    expect(dialog.queryByRole('textbox')).toBeNull();
    expect(dialog.queryByLabelText(/to confirm/)).toBeNull();

    const replace = dialog.getByRole('button', {
      name: 'Replace existing VM',
    }) as HTMLButtonElement;
    expect(replace.disabled).toBe(false);
    expect(replace.className).toMatch(/btn-danger/);
    expect(dialog.getByRole('button', { name: 'Cancel' }).className).not.toMatch(/btn-danger/);
    fireEvent.click(replace);
    await waitFor(() => expect(api.callsTo('POST', '/admin/restores')).toHaveLength(1));
    expect(api.callsTo('POST', '/admin/restores')[0]?.body).toEqual({
      agentId: AGENT_ID,
      emulatorType: 'qemu',
      vmName: 'Win98',
      versionId: SNAPSHOT_ID,
      replace: { expectedVersionId: VERSION_ID, discardLocalChanges: false },
    });
  });

  it('names the discard on the button once it is acknowledged', async () => {
    const api = base({
      [`GET ${OPTIONS_PATH}`]: holding('verified'),
      'POST /admin/restores': operation({
        replacement: { replacedVersionId: VERSION_ID, discardLocalChanges: true },
      }),
    });
    const dialog = await openReplacement();
    fireEvent.click(dialog.getByLabelText('Discard any changes in the current copy'));
    expect(dialog.queryByRole('button', { name: 'Replace existing VM' })).toBeNull();
    fireEvent.click(dialog.getByRole('button', { name: 'Discard changes and replace VM' }));
    await waitFor(() => expect(api.callsTo('POST', '/admin/restores')).toHaveLength(1));
    expect(api.callsTo('POST', '/admin/restores')[0]?.body).toMatchObject({
      replace: { expectedVersionId: VERSION_ID, discardLocalChanges: true },
    });
  });

  it('requires discarding the changes of a modified copy, and offers a snapshot first', async () => {
    const api = base({
      [`GET ${OPTIONS_PATH}`]: holding('modified'),
      [`POST ${VM_PATH}/snapshots`]: new Reply(202, {}),
    });
    const dialog = await openReplacement();
    expect(dialog.getByText('Local changes').nextElementSibling?.textContent).toMatch(/^Modified/);
    const warnings = dialog.getAllByRole('alert').map((alert) => alert.textContent);
    expect(warnings.some((text) => /removes them for good/.test(text ?? ''))).toBe(true);
    const replace = dialog.getByRole('button', {
      name: 'Replace existing VM',
    }) as HTMLButtonElement;
    expect(replace.disabled).toBe(true);
    fireEvent.click(dialog.getByLabelText('Discard any changes in the current copy'));
    const confirm = dialog.getByRole('button', {
      name: 'Discard changes and replace VM',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(dialog.getByLabelText('Discard any changes in the current copy'));
    expect(
      (dialog.getByRole('button', { name: 'Replace existing VM' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(dialog.getByRole('button', { name: 'Snapshot it first…' }));
    const snapshot = within(
      await screen.findByRole('dialog', { name: 'Create a snapshot from Study PC' }),
    );
    expect(snapshot.getByText('Master')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Replace the local copy of Win98' })).toBeNull();
    fireEvent.click(snapshot.getByRole('button', { name: 'Create snapshot' }));
    await waitFor(() => expect(api.callsTo('POST', `${VM_PATH}/snapshots`)).toHaveLength(1));
    expect(api.callsTo('POST', `${VM_PATH}/snapshots`)[0]?.body).toMatchObject({
      agentId: AGENT_ID,
      parentVersionId: VERSION_ID,
    });
    expect(api.callsTo('POST', '/admin/restores')).toHaveLength(0);
  });

  it('warns that an unverified copy may hold changes, without requiring the discard', async () => {
    base({ [`GET ${OPTIONS_PATH}`]: holding('unverified') });
    const dialog = await openReplacement();
    const warnings = dialog.getAllByRole('alert').map((alert) => alert.textContent);
    expect(warnings.some((text) => /may hold changes/.test(text ?? ''))).toBe(true);
    expect(dialog.getByText('Local changes').nextElementSibling?.textContent).toMatch(/^Not known/);
    expect(
      (dialog.getByRole('button', { name: 'Replace existing VM' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(dialog.getByText(/verifies the current copy against its version/)).toBeTruthy();
  });

  it('says why a copy cannot be replaced now', async () => {
    const refused = holding('verified');
    refused.agents = [
      {
        ...(refused.agents[0] as RestoreOptionsResponse['agents'][number]),
        replace: { eligible: false, reason: 'vm_running' },
      },
    ];
    base({ [`GET ${OPTIONS_PATH}`]: refused });
    renderAt(VM_PATH);
    expect(await screen.findByText('Not now: the VM is running there')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Restore…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('an operation', () => {
  const show = async (shown: Partial<RestoreOperation>) => {
    const api = base({ 'GET /admin/restores': { operations: [operation(shown)] } });
    renderAt(VM_PATH);
    await screen.findByRole('article', { name: 'Restore on Study PC' });
    return api;
  };

  it('lists every stage, and marks the current one', async () => {
    await show({ state: 'extracting' });
    const stages = screen.getByRole('list', { name: 'Stages of this restore' });
    const current = within(stages)
      .getAllByRole('listitem')
      .find((item) => item.getAttribute('aria-current') === 'step');
    expect(current?.textContent).toContain('Extracting and verifying files');
    expect(within(stages).getByText(/Validating/).textContent).toContain('✓');
    expect(within(stages).getByText('Recording the local copy')).toBeTruthy();
  });

  it('shows no invented numbers when there are no measurements', async () => {
    await show({ state: 'validating' });
    expect(document.querySelector('progress')).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('can be cancelled while that means something', async () => {
    const api = base({
      'GET /admin/restores': { operations: [operation({ state: 'downloading' })] },
      [`POST /admin/restores/${OPERATION_ID}/cancel`]: operation({
        state: 'downloading',
        cancelRequested: true,
      }),
    });
    renderAt(VM_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/admin/restores/${OPERATION_ID}/cancel`)).toHaveLength(1),
    );
  });

  it('cannot be cancelled once the VM is being put in place', async () => {
    await show({ state: 'publishing_local' });
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  /** A finished restore is a row of the history, with its details in a dialog. */
  const details = async (shown: Partial<RestoreOperation>) => {
    base({ 'GET /admin/restores': { operations: [operation(shown)] } });
    renderAt(VM_PATH);
    const button = await screen.findByRole('button', {
      name: /Details of the restore on Study PC/,
    });
    fireEvent.click(button);
    return { button, dialog: await screen.findByRole('dialog', { name: 'Restore details' }) };
  };

  it('reports a finished restore in full, and that nothing was started', async () => {
    const { button, dialog } = await details({
      state: 'succeeded',
      finishedAt: PAST,
      localDirectory: 'C:\\vms\\qemu\\Win98',
      verified: {
        manifestVersion: 1,
        manifestSha256: SHA,
        fileCount: 3,
        totalUncompressedBytes: 4096,
        verifiedBy: 'agent',
      },
      cache: { hit: true, downloadedBytes: 0, archiveCached: true, totalBytes: 2048 },
    });
    // Finished restores are not cards any more: they are rows.
    expect(screen.queryByRole('article', { name: 'Restore on Study PC' })).toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const view = within(dialog);
    expect(view.getByText('Restored')).toBeTruthy();
    expect(view.getByText('C:\\vms\\qemu\\Win98')).toBeTruthy();
    expect(view.getAllByText(VERSION_ID).length).toBeGreaterThan(0);
    expect(view.getByText(/3 files were verified by the agent/)).toBeTruthy();
    expect(view.getByText(/Nothing was downloaded/)).toBeTruthy();
    expect(view.getByText(/The VM was not started/)).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Cancel' })).toBeNull();
    // Focus goes in, and comes back to the row it was opened from.
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it('shows a failure with what to do about it', async () => {
    const { dialog } = await details({
      state: 'failed',
      finishedAt: PAST,
      error: { code: 'restore_destination_exists', message: 'Win98 already exists' },
      recovery: 'Move it away yourself if you want to restore here.',
    });
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toContain('restore_destination_exists');
    expect(alert.textContent).toContain('Win98 already exists');
    expect(alert.textContent).toContain('Move it away yourself');
  });

  it('lists the history as a table, and marks replacements', async () => {
    base({
      'GET /admin/restores': {
        operations: [
          operation({
            state: 'succeeded',
            finishedAt: PAST,
            replacement: { replacedVersionId: VERSION_ID, discardLocalChanges: true },
          }),
          operation({
            id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6006',
            state: 'cancelled',
            finishedAt: PAST,
          }),
        ],
      },
    });
    renderAt(VM_PATH);
    const table = await screen.findByRole('table', { name: 'Restore history, newest first' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('Replacement')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('Master')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Cancelled')).toBeTruthy();
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: /Details/ }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Restore details' }));
    expect(dialog.getByText(/its local changes discarded on request/)).toBeTruthy();
    // Identities and hashes only: nothing about how the repository is reached.
    expect(dialog.queryByText(/password|sftp:|host/i)).toBeNull();
  });

  it('says when the agent is away, without claiming anything failed', async () => {
    await show({ state: 'downloading', agentOnline: false });
    expect(screen.getByText('Agent offline')).toBeTruthy();
  });
});

describe('the agent’s page', () => {
  const agent = {
    id: AGENT_ID,
    name: 'Study PC',
    platform: 'windows',
    architecture: 'x86_64',
    agentVersion: '0.1.0',
    protocolVersion: 1,
    online: true,
    pairingStatus: 'paired',
    pairedAt: PAST,
    ownerDisplayName: 'Ada Admin',
    lastConnectedAt: PAST,
    lastSeenAt: PAST,
    revokedAt: null,
  };

  it('lists its restores, naming each VM', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET /admin/agents/${AGENT_ID}`]: agent,
      [`GET /admin/agents/${AGENT_ID}/discovery`]: { operation: null },
      'GET /admin/registrations': { operations: [] },
      'GET /admin/repositories': { repositories: [] },
      'GET /admin/restores': { operations: [operation({ state: 'extracting' })] },
    });
    renderAt(`/admin/agents/${AGENT_ID}`);
    const heading = await screen.findByRole('heading', { name: 'Restores' });
    const section = heading.closest('section') as HTMLElement;
    expect(within(section).getAllByText('Win98').length).toBeGreaterThan(0);
    expect(within(section).getByRole('table')).toBeTruthy();
    expect(within(section).getAllByText('Extracting and verifying files').length).toBeGreaterThan(
      0,
    );
  });
});
