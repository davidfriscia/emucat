import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  CloneOptionsResponse,
  RegistrationOperation,
  VersionNode,
  VmNotes,
} from '@emucat/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminVm, apiError, mockApi, renderAt, Reply, signedInAsAdmin } from './mock-api';
import { registrationOperation } from './registration-fixture';

/**
 * Vditor itself needs a real browser (it loads its Markdown engine at run time). Here it is a stand-in that keeps
 * what it was given and lets a test type, so that the page's use of it is what is tested: one editor per mount, the
 * options that keep it safe, its theme, and its destruction.
 */
const vditor = vi.hoisted(() => {
  const state = {
    instances: [] as Instance[],
    previews: [] as { markdown: string; options: Record<string, unknown> }[],
  };
  class Instance {
    destroyed = false;
    themes: string[] = [];
    constructor(
      readonly element: HTMLElement,
      readonly options: Record<string, unknown> & {
        value: string;
        input: (value: string) => void;
        after: () => void;
        preview: { transform: (html: string) => string };
      },
    ) {
      state.instances.push(this);
      const area = document.createElement('textarea');
      area.value = options.value;
      area.addEventListener('input', () => options.input(area.value));
      element.append(area);
      queueMicrotask(() => options.after());
    }
    destroy() {
      this.destroyed = true;
      this.element.replaceChildren();
    }
    setTheme(theme: string) {
      this.themes.push(theme);
    }
    static preview(
      element: HTMLElement,
      markdown: string,
      options: Record<string, unknown> & { transform: (html: string) => string },
    ) {
      state.previews.push({ markdown, options });
      // What Lute would render, unsafe on purpose: the page must not trust it.
      element.innerHTML = options.transform(
        `<p>${markdown}</p><img src="x" onerror="window.__xss = 1"><script>window.__xss = 2</script>` +
          '<a href="javascript:alert(1)">bad</a><a href="https://example.com/">good</a>',
      );
    }
  }
  return { state, Instance };
});

vi.mock('vditor', () => ({ default: vditor.Instance }));
vi.mock('vditor/dist/index.css', () => ({}));

const VM_PATH = '/admin/vms/qemu/Win98';
const NOTES_PATH = `${VM_PATH}/notes`;
const ETAG_EMPTY = `"${'0'.repeat(64)}"`;
const ETAG_ONE = `"${'1'.repeat(64)}"`;
const ETAG_TWO = `"${'2'.repeat(64)}"`;
const MASTER = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9010';
const AGENT = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9001';
const OTHER_AGENT = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9002';
const SHA = 'a'.repeat(64);

function notes(markdown: string, etag = ETAG_ONE): VmNotes {
  return {
    markdown,
    exists: markdown !== '',
    etag: markdown === '' ? ETAG_EMPTY : etag,
    updatedAt: markdown === '' ? null : '2026-02-01T00:00:00.000Z',
    sizeBytes: markdown.length,
  };
}

function master(): VersionNode {
  return {
    id: MASTER,
    kind: 'master',
    parentVersionId: null,
    childVersionIds: [],
    snapshotName: null,
    createdAt: '2026-01-01T00:00:00.000Z',
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
    deletable: { eligible: false, reason: 'master_cannot_be_deleted' },
  };
}

function page(routes: Record<string, unknown> = {}) {
  return mockApi({
    ...signedInAsAdmin,
    [`GET ${VM_PATH}`]: adminVm(),
    [`GET ${VM_PATH}/media`]: { media: [] },
    [`GET ${VM_PATH}/restore-options`]: { master: null, versions: [], agents: [] },
    'GET /admin/restores': { operations: [] },
    [`GET ${VM_PATH}/versions`]: {
      emulatorType: 'qemu',
      vmName: 'Win98',
      rootVersionId: MASTER,
      versions: [master()],
    },
    [`GET ${VM_PATH}/workspaces`]: { workspaces: [] },
    [`GET ${VM_PATH}/remasters`]: { remasters: [] },
    'GET /admin/local-copy-removals': { removals: [] },
    [`GET ${NOTES_PATH}`]: notes(''),
    ...routes,
  });
}

beforeEach(() => {
  vditor.state.instances.length = 0;
  vditor.state.previews.length = 0;
});

const notesSection = async () =>
  (await screen.findByRole('heading', { name: 'Notes' })).closest('section') as HTMLElement;

describe('VM notes', () => {
  it('shows an empty document, then edits, saves with the ETag and renders the result safely', async () => {
    const api = page({
      [`PUT ${NOTES_PATH}`]: (call: { body: { markdown: string } }) => notes(call.body.markdown),
    });
    renderAt(`${VM_PATH}/notes`);
    const section = await notesSection();
    expect(await within(section).findByText(/No notes yet/)).toBeTruthy();
    expect(within(section).getByText(/Private to administrators/)).toBeTruthy();

    fireEvent.click(within(section).getByRole('button', { name: 'Edit notes of Windows 98 SE' }));
    await waitFor(() => expect(vditor.state.instances).toHaveLength(1));
    const editor = vditor.state.instances[0]!;
    // The options that keep it self-hosted, private and safe.
    expect(editor.options).toMatchObject({
      cdn: expect.stringMatching(/^\/vendor\/vditor\/\d+\.\d+\.\d+$/),
      cache: { enable: false },
      lang: 'en_US',
      theme: 'classic',
      preview: { markdown: { sanitize: true } },
    });
    expect(editor.options).not.toHaveProperty('upload');
    expect(JSON.stringify(editor.options.toolbar)).not.toMatch(/upload|record|export/);

    const area = await within(section).findByRole('textbox');
    await waitFor(() =>
      expect(area.getAttribute('aria-label')).toBe('Notes of Windows 98 SE, in Markdown'),
    );
    const save = within(section).getByRole('button', { name: 'Save notes' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.input(area, { target: { value: '# Install\n\nBoot from floppy' } });
    expect(await within(section).findByText('Unsaved changes')).toBeTruthy();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    expect(await within(section).findByText('Notes saved.')).toBeTruthy();
    const [put] = api.callsTo('PUT', NOTES_PATH);
    expect(put?.body).toEqual({ markdown: '# Install\n\nBoot from floppy' });
    expect(put?.headers['if-match']).toBe(ETAG_EMPTY);
    // The editor is gone, and nothing is left of it.
    expect(editor.destroyed).toBe(true);
    expect(within(section).queryByText('Unsaved changes')).toBeNull();

    // Rendered for reading: Lute's sanitizer is asked for, and the result is cleaned again.
    const view = await within(section).findByRole('document', { name: 'Notes of Windows 98 SE' });
    expect(vditor.state.previews.at(-1)?.options).toMatchObject({ markdown: { sanitize: true } });
    expect(view.querySelector('script')).toBeNull();
    expect(view.innerHTML).not.toMatch(/onerror|javascript:/);
    const anchors = [...view.querySelectorAll('a')];
    expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual([
      null,
      'https://example.com/',
    ]);
    expect(within(view).getByRole('link', { name: 'good' }).getAttribute('rel')).toBe(
      'noopener noreferrer nofollow',
    );
    expect((window as { __xss?: number }).__xss).toBeUndefined();
  });

  it('asks before discarding unsaved changes, and keeps the saved notes', async () => {
    const api = page({ [`GET ${NOTES_PATH}`]: notes('Saved text') });
    renderAt(`${VM_PATH}/notes`);
    const section = await notesSection();
    fireEvent.click(await within(section).findByRole('button', { name: /Edit notes of/ }));
    const area = await within(section).findByRole('textbox');
    fireEvent.input(area, { target: { value: 'Changed' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard your changes?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(within(section).getByRole('textbox')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard changes' }),
    );
    await waitFor(() => expect(within(section).queryByRole('textbox')).toBeNull());
    expect(api.callsTo('PUT', NOTES_PATH)).toHaveLength(0);
    expect(vditor.state.instances.every((instance) => instance.destroyed)).toBe(true);
    expect(vditor.state.previews.at(-1)?.markdown).toBe('Saved text');
  });

  it('cancels without asking when nothing changed', async () => {
    page({ [`GET ${NOTES_PATH}`]: notes('Saved text') });
    renderAt(`${VM_PATH}/notes`);
    const section = await notesSection();
    fireEvent.click(await within(section).findByRole('button', { name: /Edit notes of/ }));
    await within(section).findByRole('textbox');
    fireEvent.click(within(section).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(within(section).queryByRole('textbox')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a section of the VM’s sidebar, and opening it reads the notes without writing anything', async () => {
    const api = page();
    renderAt(VM_PATH);
    const sidebar = within(await screen.findByRole('navigation', { name: 'VM' }));
    fireEvent.click(sidebar.getByRole('link', { name: 'Notes' }));
    const section = await notesSection();
    expect(await within(section).findByText(/No notes yet/)).toBeTruthy();
    expect(sidebar.getByRole('link', { name: 'Notes' }).getAttribute('aria-current')).toBe('page');
    expect(api.callsTo('GET', NOTES_PATH)).toHaveLength(1);
    expect(api.calls.filter((call) => call.path === NOTES_PATH && call.method !== 'GET')).toEqual(
      [],
    );
  });

  it('asks before leaving for another section with unsaved changes, and stays when told to', async () => {
    const api = page({ [`GET ${VM_PATH}/media-sync`]: { agents: [] } });
    renderAt(`${VM_PATH}/notes`);
    const section = await notesSection();
    fireEvent.click(
      await within(section).findByRole('button', { name: 'Edit notes of Windows 98 SE' }),
    );
    const area = await within(section).findByRole('textbox');
    fireEvent.input(area, { target: { value: 'Draft' } });
    await within(section).findByText('Unsaved changes');

    const sidebar = within(screen.getByRole('navigation', { name: 'VM' }));
    fireEvent.click(sidebar.getByRole('link', { name: 'Screenshots' }));
    let dialog = within(
      await screen.findByRole('dialog', { name: 'Leave without saving your notes?' }),
    );
    expect(screen.getByTestId('location').textContent).toBe(`${VM_PATH}/notes`);
    fireEvent.click(dialog.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Still editing, with the draft.
    expect((within(section).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Draft');

    // The global header asks too.
    fireEvent.click(
      within(screen.getAllByRole('navigation')[0]!).getByRole('link', { name: 'Catalog' }),
    );
    dialog = within(
      await screen.findByRole('dialog', { name: 'Leave without saving your notes?' }),
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(sidebar.getByRole('link', { name: 'Screenshots' }));
    dialog = within(
      await screen.findByRole('dialog', { name: 'Leave without saving your notes?' }),
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Leave without saving' }));
    await screen.findByRole('heading', { name: 'Screenshots' });
    expect(screen.getByTestId('location').textContent).toBe(`${VM_PATH}/screenshots`);
    expect(api.callsTo('PUT', NOTES_PATH)).toEqual([]);
  });

  it('leaves without asking when nothing changed', async () => {
    page({ [`GET ${VM_PATH}/media-sync`]: { agents: [] } });
    renderAt(`${VM_PATH}/notes`);
    const section = await notesSection();
    fireEvent.click(
      await within(section).findByRole('button', { name: 'Edit notes of Windows 98 SE' }),
    );
    await within(section).findByRole('textbox');
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'VM' })).getByRole('link', {
        name: 'Screenshots',
      }),
    );
    await screen.findByRole('heading', { name: 'Screenshots' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so when the notes changed elsewhere, and reloads them into a new editor', async () => {
    let reads = 0;
    page({
      [`GET ${NOTES_PATH}`]: () => (reads++ === 0 ? notes('Mine') : notes('Theirs', ETAG_TWO)),
      [`PUT ${NOTES_PATH}`]: apiError(412, 'notes_conflict', 'The notes were changed'),
    });
    renderAt(`${VM_PATH}/notes`);
    const section = await notesSection();
    fireEvent.click(await within(section).findByRole('button', { name: /Edit notes of/ }));
    fireEvent.input(await within(section).findByRole('textbox'), {
      target: { value: 'Mine, changed' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Save notes' }));
    expect(await within(section).findByText(/changed elsewhere/)).toBeTruthy();
    // Still editing, with nothing lost.
    expect((within(section).getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'Mine, changed',
    );
    fireEvent.click(within(section).getByRole('button', { name: 'Reload current notes' }));
    await waitFor(() => expect(vditor.state.instances).toHaveLength(2));
    expect(vditor.state.instances[0]?.destroyed).toBe(true);
    expect(vditor.state.instances[1]?.options.value).toBe('Theirs');
  });

  it('shows a loading state, and an error with a retry', async () => {
    let fail = true;
    page({
      [`GET ${NOTES_PATH}`]: () =>
        fail
          ? apiError(503, 'notes_unavailable', 'The notes directory cannot be written.')
          : notes(''),
    });
    renderAt(`${VM_PATH}/notes`);
    const section = await notesSection();
    expect(await within(section).findByText(/The notes directory cannot be written/)).toBeTruthy();
    fail = false;
    fireEvent.click(within(section).getByRole('button', { name: 'Try again' }));
    expect(await within(section).findByText(/No notes yet/)).toBeTruthy();
  });

  it('follows the page theme, in the editor and in the rendered notes', async () => {
    // The user's choice, as the theme menu saves it.
    localStorage.setItem('emucat.theme', 'dark');
    page({ [`GET ${NOTES_PATH}`]: notes('Dark text') });
    renderAt(`${VM_PATH}/notes`);
    const section = await notesSection();
    await waitFor(() => expect(vditor.state.previews.at(-1)?.options.mode).toBe('dark'));
    fireEvent.click(within(section).getByRole('button', { name: /Edit notes of/ }));
    await waitFor(() => expect(vditor.state.instances).toHaveLength(1));
    expect(vditor.state.instances[0]?.options.theme).toBe('dark');
    await within(section).findByRole('textbox');
    act(() => document.documentElement.setAttribute('data-bs-theme', 'light'));
    await waitFor(() => expect(vditor.state.instances[0]?.themes).toContain('classic'));
    // Still one editor: a theme change never makes a second.
    expect(vditor.state.instances).toHaveLength(1);
  });

  it('clears the notes after a confirmation, with the ETag', async () => {
    const api = page({
      [`GET ${NOTES_PATH}`]: notes('To be removed'),
      [`DELETE ${NOTES_PATH}`]: notes(''),
    });
    renderAt(`${VM_PATH}/notes`);
    const section = await notesSection();
    fireEvent.click(await within(section).findByRole('button', { name: 'Clear…' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear notes' }),
    );
    expect(await within(section).findByText(/No notes yet/)).toBeTruthy();
    expect(api.callsTo('DELETE', NOTES_PATH)[0]?.headers['if-match']).toBe(ETAG_ONE);
  });
});

describe('the Markdown editor component', () => {
  it('makes one editor per mount and destroys it on unmount, even before it is ready', async () => {
    const { MarkdownEditor } = await import('../src/components/MarkdownEditor');
    const view = render(
      <MarkdownEditor initialValue="x" onChange={() => undefined} label="Notes" theme="light" />,
    );
    expect(vditor.state.instances).toHaveLength(1);
    // Unmounted before `after` ran: it is destroyed as soon as it can be.
    view.unmount();
    await waitFor(() => expect(vditor.state.instances[0]?.destroyed).toBe(true));

    const second = render(
      <MarkdownEditor initialValue="y" onChange={() => undefined} label="Notes" theme="light" />,
    );
    await waitFor(() => expect(second.container.querySelector('textarea')).toBeTruthy());
    second.rerender(
      <MarkdownEditor
        initialValue="changed"
        onChange={() => undefined}
        label="Notes"
        theme="light"
      />,
    );
    expect(vditor.state.instances).toHaveLength(2);
    second.unmount();
    expect(vditor.state.instances[1]?.destroyed).toBe(true);
  });

  it('sanitizes what it renders: no script, no handler, no javascript: link', async () => {
    const { sanitizeHtml } = await import('../src/components/MarkdownEditor');
    const clean = sanitizeHtml(
      '<p onclick="x()">a</p><svg><script>x()</script></svg><iframe src="https://x"></iframe>' +
        '<a href="javascript:x()">b</a><a href="//evil.example/">c</a><img src="data:image/svg+xml,x">' +
        '<form action="/x"><input></form><style>body{}</style>',
    );
    expect(clean).not.toMatch(
      /onclick|<script|<iframe|javascript:|\/\/evil|data:|<form|<input|<style/,
    );
    expect(clean).toContain('<p>a</p>');
  });
});

describe('cloning a version', () => {
  function options(overrides: Partial<CloneOptionsResponse> = {}): CloneOptionsResponse {
    return {
      source: {
        emulatorType: 'qemu',
        vmName: 'Win98',
        versionId: MASTER,
        kind: 'master',
        snapshotName: null,
        title: null,
        archiveSizeBytes: 2048,
      },
      refusal: null,
      agents: [
        {
          agentId: OTHER_AGENT,
          agentName: 'Old PC',
          online: true,
          eligible: false,
          reason: 'agent_cannot_clone',
        },
        { agentId: AGENT, agentName: 'Study PC', online: true, eligible: true, reason: null },
      ],
      ...overrides,
    };
  }

  function cloneOperation(overrides: Partial<RegistrationOperation> = {}): RegistrationOperation {
    return {
      ...registrationOperation(),
      mode: 'clone',
      state: 'archiving',
      vmName: 'Win98 - Office',
      localCopy: null,
      error: null,
      recovery: null,
      progress: { doneBytes: 25, totalBytes: 100 },
      cloneSource: { vmName: 'Win98', versionId: MASTER },
      ...overrides,
    };
  }

  async function openDialog() {
    renderAt(`${VM_PATH}/versions`);
    const tree = await screen.findByRole('tree', { name: 'Versions of Win98' });
    fireEvent.click(within(tree).getByRole('button', { name: 'Clone Master into a new VM' }));
    return screen.findByRole('dialog', { name: 'Clone VM' });
  }

  it('names the source and version, validates the name, and starts the clone', async () => {
    let polls = 0;
    const operation = cloneOperation();
    const api = page({
      [`GET ${VM_PATH}/versions/${MASTER}/clone-options`]: options(),
      [`POST ${VM_PATH}/versions/${MASTER}/clone`]: new Reply(202, operation),
      [`GET /admin/registrations/${operation.id}`]: () =>
        polls++ === 0
          ? operation
          : cloneOperation({ state: 'succeeded', progress: { doneBytes: null, totalBytes: null } }),
    });
    const dialog = await openDialog();
    expect(within(dialog).getByText(/Windows 98 SE/)).toBeTruthy();
    expect(within(dialog).getByText(/Master: Master/)).toBeTruthy();
    expect(within(dialog).getByText(/new, independent qemu VM/)).toBeTruthy();
    expect(await within(dialog).findByRole('combobox')).toBeTruthy();
    // The eligible agent is chosen; the other says why it cannot.
    expect((within(dialog).getByRole('combobox') as HTMLSelectElement).value).toBe(AGENT);
    expect(
      within(dialog).getByRole('option', { name: /Old PC — The agent is too old/ }),
    ).toBeTruthy();

    const name = within(dialog).getByRole('textbox', { name: 'New VM name' });
    const submit = within(dialog).getByRole('button', { name: 'Clone VM' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    for (const [value, message] of [
      ['a/b', /letters, digits, spaces/i],
      ['WIN98', /name of its own/],
      ['-x', /Start and end with a letter/],
      ['CON', /reserved by Windows/],
    ] as const) {
      fireEvent.change(name, { target: { value } });
      fireEvent.blur(name);
      expect(within(dialog).getByText(message)).toBeTruthy();
      expect(name.getAttribute('aria-invalid')).toBe('true');
      expect(submit.disabled).toBe(true);
    }
    fireEvent.change(name, { target: { value: 'Win98 - Office' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [post] = api.callsTo('POST', `${VM_PATH}/versions/${MASTER}/clone`);
    expect(post?.body).toMatchObject({ agentId: AGENT, vmName: 'Win98 - Office' });
    expect((post?.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
    const status = await screen.findByText(/Clone Win98 - Office/);
    expect(status.closest('[role="status"]')?.textContent).toMatch(
      /Downloading and writing the clone \(25%\)/,
    );
    const link = await screen.findByRole(
      'link',
      { name: 'Open Win98 - Office' },
      { timeout: 5_000 },
    );
    expect(link.getAttribute('href')).toBe('/admin/vms/qemu/Win98%20-%20Office');
  });

  it('shows the server’s refusal, and a version that cannot be cloned', async () => {
    page({
      [`GET ${VM_PATH}/versions/${MASTER}/clone-options`]: options(),
      [`POST ${VM_PATH}/versions/${MASTER}/clone`]: apiError(
        409,
        'vm_already_registered',
        'A qemu VM named Copy already exists. Names ignore case.',
      ),
    });
    const dialog = await openDialog();
    await within(dialog).findByRole('combobox');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'New VM name' }), {
      target: { value: 'copy' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clone VM' }));
    expect(await within(dialog).findByText(/already exists/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('cannot start while the version cannot be cloned', async () => {
    page({
      [`GET ${VM_PATH}/versions/${MASTER}/clone-options`]: options({
        refusal: 'remaster_in_progress',
      }),
    });
    const dialog = await openDialog();
    expect(await within(dialog).findByText(/A remaster of this VM is running/)).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'New VM name' }), {
      target: { value: 'Copy' },
    });
    expect(
      (within(dialog).getByRole('button', { name: 'Clone VM' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows where a clone came from, with a link while the source exists and text once it is gone', async () => {
    const provenance = {
      sourceEmulatorType: 'qemu' as const,
      sourceVmName: 'Windows 95',
      sourceDisplayName: null,
      sourceVersionId: MASTER,
      sourceVersionKind: 'snapshot' as const,
      sourceSnapshotName: 'Windows 95_202601311530',
      sourceVersionTitle: 'After Office Installation',
      clonedAt: '2026-02-01T00:00:00.000Z',
      clonedByDisplayName: 'Ada Admin',
      sourceExists: true,
    };
    page({ [`GET ${VM_PATH}`]: adminVm({ clonedFrom: provenance }) });
    const first = renderAt(VM_PATH);
    const link = await screen.findByRole('link', { name: 'Windows 95' });
    expect(link.getAttribute('href')).toBe('/admin/vms/qemu/Windows%2095');
    expect(screen.getByText(/Snapshot — After Office Installation/)).toBeTruthy();
    first.unmount();

    page({ [`GET ${VM_PATH}`]: adminVm({ clonedFrom: { ...provenance, sourceExists: false } }) });
    renderAt(VM_PATH);
    expect(await screen.findByText(/no longer in the catalog/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Windows 95' })).toBeNull();
  });
});
