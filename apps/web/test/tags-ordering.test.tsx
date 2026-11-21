import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AdminMedia, Tag } from '@emucat/contracts';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moveItem } from '../src/components/ReorderScreenshots';
import { TagSelector } from '../src/components/Tags';
import { TagList } from '../src/components/TagList';
import {
  adminMedia,
  apiError,
  emptyPage,
  MEDIA_ID,
  mockApi,
  OTHER_MEDIA_ID,
  Reply,
  renderAt,
  resetApiState,
  signedInAsAdmin,
} from './mock-api';

const VM = { emulatorType: 'qemu' as const, vmName: 'Win98' };
const VM_PATH = '/admin/vms/qemu/Win98';
const MEDIA_PATH = `${VM_PATH}/media`;
const THIRD_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f72';

const RETRO: Tag = { id: '018f47a0-7c2b-4f7e-9a3d-00000000a001', name: 'retro' };
const RACING: Tag = { id: '018f47a0-7c2b-4f7e-9a3d-00000000a002', name: 'Racing' };
const NEW_TAG: Tag = { id: '018f47a0-7c2b-4f7e-9a3d-00000000a003', name: 'windows-98' };

// The selector waits briefly before searching, and dragging takes animation frames: allow for a busy machine.
configure({ asyncUtilTimeout: 4000 });

beforeEach(() => resetApiState());
afterEach(() => {
  vi.restoreAllMocks();
});

function Harness({ initial = [], onSaved }: { initial?: Tag[]; onSaved?: (tags: Tag[]) => void }) {
  const [tags, setTags] = useState<Tag[]>(initial);
  return (
    <>
      <TagSelector
        target={{ kind: 'vm', vm: VM }}
        value={tags}
        onChange={(next) => {
          setTags(next);
          onSaved?.(next);
        }}
        label="Tags"
      />
      <TagList tags={tags} label="Saved tags" />
    </>
  );
}

const input = () => screen.getByLabelText('Tags') as HTMLInputElement;

function type(text: string) {
  fireEvent.focus(input());
  fireEvent.change(input(), { target: { value: text } });
}

const saved = () =>
  within(screen.queryByRole('list', { name: 'Saved tags' }) ?? document.createElement('ul'))
    .queryAllByRole('listitem')
    .map((item) => item.textContent);

describe('TagList', () => {
  it('shows every tag with its #, and nothing at all without tags', () => {
    const { container, rerender } = render(<TagList tags={[RETRO, RACING]} />);
    expect(
      within(screen.getByRole('list', { name: 'Tags' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['#retro', '#Racing']);
    rerender(<TagList tags={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('TagSelector', () => {
  it('searches existing tags and assigns the one selected', async () => {
    const api = mockApi({
      'GET /admin/tags': (call: { query: URLSearchParams }) => ({
        tags: call.query.get('q') === 'ret' ? [RETRO] : [RETRO, RACING],
      }),
      [`PUT ${VM_PATH}/tags`]: { tags: [RETRO] },
    });
    render(<Harness />);
    type('ret');
    const option = await screen.findByRole('option', { name: '#retro' });
    // A shorter name that does not exist yet could still be created.
    expect(screen.getByRole('option', { name: 'Create #ret' })).toBeTruthy();
    fireEvent.click(option);
    await waitFor(() => expect(saved()).toEqual(['#retro']));
    expect(api.callsTo('PUT', `${VM_PATH}/tags`)[0]?.body).toEqual({ tagIds: [RETRO.id] });
    expect(api.callsTo('GET', '/admin/tags').at(-1)?.query.get('q')).toBe('ret');
  });

  it('offers to create a tag nothing matches, and assigns the new tag', async () => {
    const api = mockApi({
      'GET /admin/tags': { tags: [] },
      'POST /admin/tags': new Reply(201, { tag: NEW_TAG, created: true }),
      [`PUT ${VM_PATH}/tags`]: { tags: [RETRO, NEW_TAG] },
    });
    render(<Harness initial={[RETRO]} />);
    type('#windows-98');
    const create = await screen.findByRole('option', { name: 'Create #windows-98' });
    fireEvent.click(create);
    await waitFor(() => expect(saved()).toEqual(['#retro', '#windows-98']));
    expect(api.callsTo('POST', '/admin/tags')[0]?.body).toEqual({ name: '#windows-98' });
    expect(api.callsTo('PUT', `${VM_PATH}/tags`)[0]?.body).toEqual({
      tagIds: [RETRO.id, NEW_TAG.id],
    });
  });

  it('does not offer to create a tag that exists, whatever its case or #, or one already assigned', async () => {
    mockApi({
      'GET /admin/tags': (call: { query: URLSearchParams }) => ({
        tags: call.query.get('q')?.toLowerCase() === 'retro' ? [RETRO] : [RACING],
      }),
    });
    render(<Harness initial={[RETRO]} />);
    type('#RACING');
    expect(await screen.findByRole('option', { name: '#Racing' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();

    type('Retro');
    await waitFor(() => expect(screen.queryByRole('option', { name: /Create/ })).toBeNull());
    expect(await screen.findByText('#retro is already assigned')).toBeTruthy();
  });

  it('explains why something cannot be a tag', async () => {
    mockApi({ 'GET /admin/tags': { tags: [] } });
    render(<Harness />);
    type('semi;colon');
    expect(await screen.findByText(/A tag starts with a letter or digit/)).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
  });

  it('removes a tag, and keeps it shown if the server refuses', async () => {
    let fail = true;
    const api = mockApi({
      'GET /admin/tags': { tags: [] },
      [`PUT ${VM_PATH}/tags`]: () =>
        fail ? apiError(503, 'unavailable', 'The server is busy') : { tags: [RACING] },
    });
    const onSaved = vi.fn();
    render(<Harness initial={[RETRO, RACING]} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove #retro' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'The tags were not saved: The server is busy',
    );
    expect(saved()).toEqual(['#retro', '#Racing']);
    expect(onSaved).not.toHaveBeenCalled();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Remove #retro' }));
    await waitFor(() => expect(saved()).toEqual(['#Racing']));
    expect(api.callsTo('PUT', `${VM_PATH}/tags`).at(-1)?.body).toEqual({ tagIds: [RACING.id] });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows nothing it did not save when creating fails', async () => {
    mockApi({
      'GET /admin/tags': { tags: [] },
      'POST /admin/tags': apiError(400, 'invalid_tag', 'A tag cannot be empty'),
    });
    render(<Harness />);
    type('brand-new');
    fireEvent.click(await screen.findByRole('option', { name: 'Create #brand-new' }));
    expect((await screen.findByRole('alert')).textContent).toContain('A tag cannot be empty');
    expect(saved()).toEqual([]);
  });

  it('can be used with the keyboard alone', async () => {
    mockApi({
      'GET /admin/tags': { tags: [RETRO, RACING] },
      [`PUT ${VM_PATH}/tags`]: { tags: [RACING] },
    });
    render(<Harness />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    await screen.findByRole('option', { name: '#retro' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(saved()).toEqual(['#Racing']));
  });
});

describe('the gallery shows tags', () => {
  it('on public catalog cards', async () => {
    mockApi({
      'GET /catalog/vms': {
        ...emptyPage(),
        items: [
          {
            emulatorType: 'qemu',
            vmName: 'Win98',
            displayName: 'Windows 98',
            summary: null,
            mainImage: null,
            tags: [RETRO],
          },
        ],
        pagination: { page: 1, pageSize: 24, total: 1, totalPages: 1 },
      },
    });
    renderAt('/');
    const list = await screen.findByRole('list', { name: 'Tags of Windows 98' });
    expect(list.textContent).toBe('#retro');
  });
});

const three: AdminMedia[] = [
  adminMedia({ id: MEDIA_ID, originalFilename: 'boot.png' }),
  adminMedia({ id: OTHER_MEDIA_ID, originalFilename: 'desktop.png', isMain: true }),
  adminMedia({ id: THIRD_ID, originalFilename: 'game.png', tags: [RACING] }),
];
const SYNC = { agents: [] };

function rowNames(): string[] {
  const dialog = screen.getByRole('dialog', { name: 'Reorder screenshots' });
  return within(dialog)
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('.reorder-name .media-filename')?.textContent ?? '');
}

describe('reordering screenshots', () => {
  it('moves rows without calling the server, then saves the whole order once', async () => {
    const reordered = [three[1], three[2], three[0]] as AdminMedia[];
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: three },
      [`GET ${VM_PATH}/media-sync`]: SYNC,
      [`PUT ${VM_PATH}/media-order`]: { media: reordered },
    });
    renderAt(MEDIA_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Reorder Screenshots' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Reorder screenshots' }));
    expect(rowNames()).toEqual(['boot.png', 'desktop.png', 'game.png']);
    const save = dialog.getByRole('button', { name: 'Save Order' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(dialog.queryByText('Unsaved changes')).toBeNull();
    expect(
      (dialog.getByRole('button', { name: 'Move boot.png up' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(dialog.getByRole('button', { name: 'Move boot.png down' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Move boot.png down' }));
    expect(rowNames()).toEqual(['desktop.png', 'game.png', 'boot.png']);
    expect(dialog.getByText('Unsaved changes')).toBeTruthy();
    expect(api.callsTo('PUT', `${VM_PATH}/media-order`)).toEqual([]);

    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.callsTo('PUT', `${VM_PATH}/media-order`).map((call) => call.body)).toEqual([
      { mediaIds: [OTHER_MEDIA_ID, THIRD_ID, MEDIA_ID] },
    ]);
    expect(screen.getByText('The new order is saved. Every gallery shows it.')).toBeTruthy();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((item) => item.textContent);
    expect(headings.filter((text) => text?.endsWith('.png'))).toEqual([
      'desktop.png',
      'game.png',
      'boot.png',
    ]);
    // Reordering never changes the main image.
    expect(screen.getAllByText('Main image')).toHaveLength(1);
  });

  it('discards unsaved changes on Cancel', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: three },
      [`GET ${VM_PATH}/media-sync`]: SYNC,
    });
    renderAt(MEDIA_PATH);
    const open = await screen.findByRole('button', { name: 'Reorder Screenshots' });
    fireEvent.click(open);
    let dialog = within(screen.getByRole('dialog', { name: 'Reorder screenshots' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Move game.png up' }));
    expect(rowNames()).toEqual(['boot.png', 'game.png', 'desktop.png']);
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(open);
    expect(api.callsTo('PUT', `${VM_PATH}/media-order`)).toEqual([]);

    fireEvent.click(open);
    dialog = within(screen.getByRole('dialog', { name: 'Reorder screenshots' }));
    expect(rowNames()).toEqual(['boot.png', 'desktop.png', 'game.png']);
    expect(dialog.queryByText('Unsaved changes')).toBeNull();
  });

  it('keeps the dialog and the order when saving fails, and says why', async () => {
    let release: (value: unknown) => void = () => undefined;
    mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: three },
      [`GET ${VM_PATH}/media-sync`]: SYNC,
      [`PUT ${VM_PATH}/media-order`]: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    renderAt(MEDIA_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Reorder Screenshots' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Reorder screenshots' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Move game.png up' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save Order' }));
    const saving = (await dialog.findByRole('button', { name: 'Saving…' })) as HTMLButtonElement;
    expect(saving.disabled).toBe(true);
    expect((dialog.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => {
      release(
        apiError(
          409,
          'media_order_conflict',
          'The screenshots changed since this order was made. Reload them and try again',
        ),
      );
    });
    expect((await dialog.findByRole('alert')).textContent).toContain('The screenshots changed');
    expect(rowNames()).toEqual(['boot.png', 'game.png', 'desktop.png']);
    expect(dialog.getByText('Unsaved changes')).toBeTruthy();
  });

  it('reorders with the keyboard through the drag handles', async () => {
    // jsdom has no layout: give each row a place, so that the keyboard sensor can find its neighbours.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const row = this.closest('tr[data-media-id]');
      const index = row
        ? three.findIndex((item) => item.id === row.getAttribute('data-media-id'))
        : -1;
      const top = index < 0 ? 0 : index * 60;
      const height = index < 0 ? 0 : 60;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        width: 600,
        height,
        right: 600,
        bottom: top + height,
        toJSON: () => ({}),
      } as DOMRect;
    });
    mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: three },
      [`GET ${VM_PATH}/media-sync`]: SYNC,
    });
    renderAt(MEDIA_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Reorder Screenshots' }));
    const handle = screen.getByRole('button', { name: 'Drag boot.png, at position 1 of 3' });
    handle.focus();
    fireEvent.keyDown(handle, { key: ' ', code: 'Space' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.keyDown(document.activeElement ?? handle, { key: 'ArrowDown', code: 'ArrowDown' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.keyDown(document.activeElement ?? handle, { key: ' ', code: 'Space' });
    await waitFor(() => expect(rowNames()).toEqual(['desktop.png', 'boot.png', 'game.png']));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('cannot be opened with fewer than two screenshots', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: [three[0]] },
      [`GET ${VM_PATH}/media-sync`]: SYNC,
    });
    renderAt(MEDIA_PATH);
    const open = (await screen.findByRole('button', {
      name: 'Reorder Screenshots',
    })) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
  });

  it('moves items as the move helper says', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b', 'c'], 1, 5)).toEqual(['a', 'b', 'c']);
  });
});

describe('screenshot management', () => {
  it('shows each screenshot’s tags, and edits them in a dialog', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: three },
      [`GET ${VM_PATH}/media-sync`]: SYNC,
      'GET /admin/tags': { tags: [RETRO] },
      [`PUT ${VM_PATH}/media/${THIRD_ID}/tags`]: { tags: [RETRO, RACING] },
    });
    renderAt(MEDIA_PATH);
    expect((await screen.findByRole('list', { name: 'Tags of game.png' })).textContent).toBe(
      '#Racing',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tags of game.png' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Screenshot tags' }));
    fireEvent.change(dialog.getByLabelText('Tags'), { target: { value: 'ret' } });
    fireEvent.click(await dialog.findByRole('option', { name: '#retro' }));
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'Tags of game.png' }).textContent).toBe(
        '#retro#Racing',
      ),
    );
    expect(api.callsTo('PUT', `${VM_PATH}/media/${THIRD_ID}/tags`)[0]?.body).toEqual({
      tagIds: [RACING.id, RETRO.id],
    });
  });

  it('shows the deletion in progress, prevents a second one, and keeps the screenshot if it fails', async () => {
    let release: (value: unknown) => void = () => undefined;
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: three },
      [`GET ${VM_PATH}/media-sync`]: SYNC,
      [`DELETE ${VM_PATH}/media/${MEDIA_ID}`]: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    renderAt(MEDIA_PATH);
    const card = (await screen.findByRole('heading', { name: 'boot.png' })).closest(
      'article',
    ) as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Delete' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Delete this screenshot?' }));
    const confirm = dialog.getByRole('button', { name: 'Delete screenshot' });
    fireEvent.click(confirm);
    const working = (await dialog.findByRole('button', { name: 'Working…' })) as HTMLButtonElement;
    expect(working.disabled).toBe(true);
    fireEvent.click(working);
    expect(api.callsTo('DELETE', `${VM_PATH}/media/${MEDIA_ID}`)).toHaveLength(1);
    await act(async () => {
      release(apiError(500, 'internal_error', 'Something failed on the server'));
    });
    expect((await dialog.findByRole('alert')).textContent).toContain(
      'Something failed on the server',
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Keep' }));
    expect(screen.getByRole('heading', { name: 'boot.png' })).toBeTruthy();
  });
});
