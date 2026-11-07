import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { RestoreOperation, RestoreOptionsResponse } from '@emucat/contracts';
import { describe, expect, it } from 'vitest';
import { adminVm, apiError, mockApi, renderAt, signedInAsAdmin } from './mock-api';

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
      await screen.findByRole('heading', { name: 'Master and local copies' })
    ).closest('section') as HTMLElement;
    await within(section).findByText(VERSION_ID);
    expect(within(section).getByText('NAS')).toBeTruthy();
    expect(within(section).getByText(/Verified copy, as of/)).toBeTruthy();
    expect(within(section).getByText(/No longer present on this agent/)).toBeTruthy();
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
    expect(await screen.findByText(/differs from the master/)).toBeTruthy();
  });

  it('has no restore for a VM with no master', async () => {
    base({ [`GET ${OPTIONS_PATH}`]: { master: null, agents: [] } });
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
    expect(view.getByText(/creates a local copy of the immutable master/)).toBeTruthy();
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

  it('reports a finished restore in full, and that nothing was started', async () => {
    await show({
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
    const card = screen.getByRole('article', { name: 'Restore on Study PC' });
    const view = within(card);
    expect(view.getByText('Restored')).toBeTruthy();
    expect(view.getByText('C:\\vms\\qemu\\Win98')).toBeTruthy();
    expect(view.getByText(VERSION_ID)).toBeTruthy();
    expect(view.getByText(/3 files were verified by the agent/)).toBeTruthy();
    expect(view.getByText(/Nothing was downloaded/)).toBeTruthy();
    expect(view.getByText('2.0 KiB')).toBeTruthy();
    expect(view.getByText(/The VM was not started/)).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('shows a failure with what to do about it', async () => {
    await show({
      state: 'failed',
      finishedAt: PAST,
      error: { code: 'restore_destination_exists', message: 'Win98 already exists' },
      recovery: 'Move it away yourself if you want to restore here.',
    });
    expect(screen.getByRole('alert').textContent).toContain('restore_destination_exists');
    expect(screen.getByRole('alert').textContent).toContain('Win98 already exists');
    expect(screen.getByRole('alert').textContent).toContain('Move it away yourself');
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
    expect(within(section).getByText('Win98')).toBeTruthy();
    expect(within(section).getAllByText('Extracting and verifying files').length).toBeGreaterThan(
      0,
    );
  });
});
