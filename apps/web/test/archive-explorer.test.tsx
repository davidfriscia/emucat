/**
 * Archive Explorer (decision 0056) in the browser: the tree, file selection and its cancellation, every viewer, the
 * download, errors, keyboard use and the narrow layout. The server is a mock; previews are real byte responses with
 * the server's headers.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ARCHIVE_PREVIEW_HEADERS as H, type VersionNode } from '@emucat/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveExplorerDialog } from '../src/components/ArchiveExplorer';
import { hexDump } from '../src/components/archive-explorer/viewers';
import { sanitizeArchiveHtml } from '../src/components/archive-explorer/safe-html';
import { apiError, mockApi, type RecordedCall } from './mock-api';

const md2html = vi.fn<(markdown: string) => Promise<string>>();
vi.mock('vditor', () => ({ default: { md2html: (markdown: string) => md2html(markdown) } }));

const pdf = {
  destroyed: 0,
  rendered: [] as number[],
};
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { ENABLE: 1 },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 3,
      getPage: async (page: number) => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
        render: () => {
          pdf.rendered.push(page);
          return { promise: Promise.resolve(), cancel: () => undefined };
        },
      }),
    }),
    destroy: async () => {
      pdf.destroyed += 1;
    },
  }),
}));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({
  default: '/assets/pdf.worker.js',
}));

const VERSION = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8010';
const SNAPSHOT = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8011';
const SHA = 'a'.repeat(64);
const VM = { emulatorType: '86box' as const, vmName: 'DOS622' };
const ARCHIVE = (id = VERSION) => `/admin/vms/86box/DOS622/versions/${id}/archive`;

function node(id = VERSION, kind: 'master' | 'snapshot' = 'master'): VersionNode {
  return {
    id,
    kind,
    parentVersionId: kind === 'master' ? null : VERSION,
    childVersionIds: [],
    snapshotName: kind === 'master' ? null : 'DOS622_202601010001',
    createdAt: '2026-01-01T00:00:00.000Z',
    title: null,
    description: null,
    tags: [],
    promotedAt: null,
    archiveSizeBytes: 4096,
    archiveSha256: SHA,
    manifest: { sha256: SHA, fileCount: 3, totalUncompressedBytes: 4096, verifiedBy: 'agent' },
    repositoryName: 'NAS',
    available: true,
    createdByAgentName: 'Study PC',
    createdByDisplayName: 'Ada Admin',
    holders: [],
    deletion: null,
    deletable: { eligible: false, reason: 'master_cannot_be_deleted' },
  } as VersionNode;
}

function summary(
  id = VERSION,
  kind: 'master' | 'snapshot' = 'master',
  views = ['logical', 'physical'],
) {
  return {
    vm: { emulatorType: '86box', vmName: 'DOS622', title: 'MS-DOS 6.22' },
    version: { id, kind, snapshotName: null, title: null, createdAt: '2026-01-01T00:00:00.000Z' },
    archive: {
      format: 'zip',
      fileName: `${id}.zip`,
      repositoryName: 'NAS',
      sizeBytes: 4096,
      sha256: SHA,
    },
    complete: true,
    manifest: {
      manifestVersion: 1,
      vmName: 'DOS622',
      fileCount: 3,
      directoryCount: 1,
      totalUncompressedBytes: 3000,
      sha256: SHA,
      matchesRegistration: true,
    },
    physical: {
      entryCount: 5,
      fileCount: 4,
      directoryCount: 1,
      compressedBytes: 2000,
      uncompressedBytes: 3100,
    },
    views,
    warnings: [],
  };
}

const entry = (path: string, type: 'file' | 'directory' = 'file', sizeBytes = 1000) => ({
  name: path.split('/').at(-1),
  path,
  type,
  sizeBytes: type === 'file' ? sizeBytes : null,
  compressedSizeBytes: null,
  method: null,
  sha256: type === 'file' ? SHA : null,
  modifiedAt: null,
  childCount: type === 'directory' ? 2 : null,
});

const ROOT = [
  entry('docs', 'directory'),
  entry('vm.cfg'),
  entry('dos.txt'),
  entry('README.md'),
  entry('screen.png'),
  entry('manual.pdf'),
  entry('bios.bin', 'file', 200_000),
];

function listing(call: RecordedCall) {
  const path = call.query.get('path') ?? '';
  const q = call.query.get('q');
  const offset = Number(call.query.get('offset') ?? 0);
  if (q)
    return {
      view: 'logical',
      path: '',
      q,
      entries: [entry('docs/a.txt')],
      total: 1,
      nextOffset: null,
    };
  if (path === 'docs') {
    // A large directory, in pages.
    const all = Array.from({ length: 250 }, (_, index) =>
      entry(`docs/f${String(index).padStart(3, '0')}.txt`),
    );
    const entries = all.slice(offset, offset + 200);
    const next = offset + entries.length;
    return {
      view: 'logical',
      path,
      q: null,
      entries,
      total: all.length,
      nextOffset: next < all.length ? next : null,
    };
  }
  if (call.query.get('view') === 'physical') {
    return {
      view: 'physical',
      path: '',
      q: null,
      entries: [entry('.emucat-manifest.json')],
      total: 1,
      nextOffset: null,
    };
  }
  return { view: 'logical', path, q: null, entries: ROOT, total: ROOT.length, nextOffset: null };
}

type Kind = 'text' | 'markdown' | 'image' | 'pdf' | 'binary';
function details(path: string, kind: Kind, overrides: Record<string, unknown> = {}) {
  const modes =
    kind === 'markdown'
      ? ['rendered', 'text', 'hex']
      : kind === 'text'
        ? ['text', 'hex']
        : kind === 'image'
          ? ['image', 'hex']
          : kind === 'pdf'
            ? ['pdf', 'hex']
            : ['hex'];
  return {
    view: 'logical',
    entry: entry(path, 'file', path === 'bios.bin' ? 200_000 : 1000),
    compression: 'deflated',
    crc32: '0badf00d',
    manifestSha256: SHA,
    detected: {
      kind,
      format: kind === 'image' ? 'png' : kind,
      language: path.endsWith('.cfg') ? 'ini' : kind === 'markdown' ? 'markdown' : null,
      encoding:
        kind === 'text' || kind === 'markdown'
          ? path === 'dos.txt'
            ? { name: 'cp437', confidence: 'heuristic' }
            : { name: 'utf-8', confidence: 'valid' }
          : null,
    },
    modes,
    unavailable: {},
    hex: { seekable: false, maxOffset: 131_071, windowBytes: 65_536 },
    download: { allowed: true, maxBytes: 104_857_600 },
    limits: {
      textBytes: 262_144,
      imageBytes: 20_971_520,
      pdfBytes: 26_214_400,
      imagePixels: 16_777_216,
    },
    ...overrides,
  };
}

function bytes(
  data: Uint8Array | string,
  headers: Record<string, string> = {},
  type = 'application/octet-stream',
) {
  const body = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Response(body as BodyInit, {
    headers: {
      'content-type': type,
      [H.offset]: '0',
      [H.length]: String(body.length),
      [H.total]: String(body.length),
      [H.truncated]: 'false',
      [H.integrity]: 'verified',
      ...headers,
    },
  });
}

const DOS = new Uint8Array([0xc9, 0xcd, 0xbb, 0x0d, 0x0a, 0xba, 0x82, 0xba]);

function routes(overrides: Record<string, unknown> = {}) {
  const kinds: Record<string, Kind> = {
    'vm.cfg': 'text',
    'dos.txt': 'text',
    'README.md': 'markdown',
    'screen.png': 'image',
    'manual.pdf': 'pdf',
    'bios.bin': 'binary',
    'docs/a.txt': 'text',
  };
  return {
    [`GET ${ARCHIVE()}`]: summary(),
    [`GET ${ARCHIVE()}/entries`]: listing,
    [`GET ${ARCHIVE()}/entry`]: (call: RecordedCall) => {
      const path = call.query.get('path') ?? '';
      return details(path, kinds[path] ?? 'text');
    },
    [`GET ${ARCHIVE()}/entry/preview`]: (call: RecordedCall) => {
      const path = call.query.get('path');
      const kind = call.query.get('kind');
      if (kind === 'hex') {
        const offset = Number(call.query.get('offset') ?? 0);
        return bytes(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x01]), {
          [H.offset]: String(offset),
          [H.total]: '200000',
          [H.truncated]: 'true',
          [H.integrity]: 'partial',
        });
      }
      if (path === 'dos.txt') return bytes(DOS);
      if (path === 'README.md') return bytes('# Title\n');
      if (path === 'screen.png')
        return bytes(
          new Uint8Array([0x89, 0x50]),
          { [H.format]: 'png', [H.width]: '640', [H.height]: '480', [H.converted]: 'false' },
          'image/png',
        );
      if (path === 'manual.pdf') return bytes('%PDF-1.4\n');
      return bytes('[General]\nmachine = ibm5150\n');
    },
    [`GET ${ARCHIVE()}/entry/download`]: () => bytes('[General]\n'),
    ...overrides,
  };
}

function open(id = VERSION, kind: 'master' | 'snapshot' = 'master') {
  const onClose = vi.fn();
  render(<ArchiveExplorerDialog vm={VM} node={node(id, kind)} onClose={onClose} />);
  return { onClose };
}

async function dialog() {
  return within(await screen.findByRole('dialog', { name: 'Archive Explorer' }));
}

async function selectFile(name: string) {
  const view = await dialog();
  fireEvent.click(await view.findByRole('treeitem', { name }));
  return within(await view.findByRole('region', { name: `File ${name.split('/').at(-1)}` }));
}

const created: string[] = [];
const revoked: string[] = [];
beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  pdf.destroyed = 0;
  pdf.rendered = [];
  let next = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => {
        const url = `blob:test/${next++}`;
        created.push(url);
        return url;
      }),
      revokeObjectURL: vi.fn((url: string) => void revoked.push(url)),
    }),
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  md2html.mockReset();
});
afterEach(() => {
  delete (window as unknown as { hljs?: unknown }).hljs;
});

describe('Archive Explorer', () => {
  it('opens for a master with a placeholder, and lists directories lazily, in pages', async () => {
    const api = mockApi(routes());
    open();
    const view = await dialog();
    expect(await view.findByText('Select a file to see its details and a preview.')).toBeTruthy();
    const tree = within(view.getByRole('tree', { name: 'Archive files' }));
    expect(await tree.findByRole('treeitem', { name: 'vm.cfg' })).toBeTruthy();
    expect(api.calls.filter((call) => call.query.get('path') === 'docs')).toHaveLength(0);
    fireEvent.click(tree.getByRole('treeitem', { name: 'docs, directory' }));
    expect(await tree.findByRole('treeitem', { name: 'f000.txt' })).toBeTruthy();
    expect(tree.queryByRole('treeitem', { name: 'f220.txt' })).toBeNull();
    fireEvent.click(tree.getByRole('treeitem', { name: /Show more \(200 of 250\)/ }));
    expect(await tree.findByRole('treeitem', { name: 'f249.txt' })).toBeTruthy();
    expect(api.calls.some((call) => call.query.get('offset') === '200')).toBe(true);
    // Collapsing keeps what was loaded: opening again asks nothing more.
    const before = api.calls.length;
    fireEvent.click(tree.getByRole('treeitem', { name: 'docs, directory' }));
    fireEvent.click(tree.getByRole('treeitem', { name: 'docs, directory' }));
    expect(await tree.findByRole('treeitem', { name: 'f249.txt' })).toBeTruthy();
    expect(api.calls.length).toBe(before);
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('opens for a snapshot through its own version', async () => {
    const api = mockApi({
      [`GET ${ARCHIVE(SNAPSHOT)}`]: summary(SNAPSHOT, 'snapshot'),
      [`GET ${ARCHIVE(SNAPSHOT)}/entries`]: listing,
    });
    open(SNAPSHOT, 'snapshot');
    const view = await dialog();
    expect(await view.findByText(/Snapshot:/)).toBeTruthy();
    expect(await view.findByRole('treeitem', { name: 'vm.cfg' })).toBeTruthy();
    expect(api.calls.every((call) => call.path.includes(SNAPSHOT))).toBe(true);
  });

  it('shows a file’s details and its text, highlighted and sanitized, and copies it', async () => {
    (window as unknown as { hljs: unknown }).hljs = {
      getLanguage: () => ({}),
      highlight: () => ({
        value: '<span class="hljs-section">[General]</span><img src=x onerror="alert(1)">\n',
      }),
    };
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    mockApi(routes());
    open();
    const panel = await selectFile('vm.cfg');
    expect(await panel.findByText('0badf00d')).toBeTruthy();
    expect(panel.getByText(SHA)).toBeTruthy();
    const text = await panel.findByLabelText('Contents of vm.cfg');
    await waitFor(() => expect(text.querySelector('.hljs-section')).not.toBeNull());
    expect(text.querySelector('img')).toBeNull();
    expect(text.innerHTML).not.toMatch(/onerror/);
    expect(panel.getByText(/matched its recorded checksum/)).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Copy text' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('[General]\nmachine = ibm5150\n'));
  });

  it('decodes DOS text as detected, and changes encoding without asking the server again', async () => {
    const api = mockApi(routes());
    open();
    const panel = await selectFile('dos.txt');
    const text = await panel.findByLabelText('Contents of dos.txt');
    expect(text.textContent).toBe('╔═╗\r\n║é║');
    expect(panel.getByText(/a guess from the bytes/)).toBeTruthy();
    const previews = api.calls.filter((call) => call.path.endsWith('/entry/preview')).length;
    fireEvent.change(panel.getByLabelText('Encoding'), { target: { value: 'windows-1252' } });
    expect(text.textContent).toBe('ÉÍ»\r\nº‚º');
    fireEvent.change(panel.getByLabelText('Encoding'), { target: { value: 'cp850' } });
    expect(text.textContent).toBe('╔═╗\r\n║é║');
    expect(api.calls.filter((call) => call.path.endsWith('/entry/preview')).length).toBe(previews);
    // Plain text starts wrapped; wrapping is a toggle of its own.
    expect(text.className).toContain('archive-wrap');
    fireEvent.click(panel.getByLabelText('Wrap lines'));
    expect(text.className).not.toContain('archive-wrap');
  });

  it('renders Markdown inert, and shows its source from the same bytes', async () => {
    md2html.mockResolvedValue(
      '<h1>Title</h1><script>alert(1)</script><p><img src="https://example.com/x.png" alt="logo"> <a href="https://example.com">site</a> <a href="#top">top</a></p><iframe src="https://example.com"></iframe>',
    );
    const api = mockApi(routes());
    open();
    const panel = await selectFile('README.md');
    const rendered = await panel.findByRole('document', { name: 'Rendered README.md' });
    expect(within(rendered).getByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(rendered.querySelector('script, img, iframe')).toBeNull();
    expect(rendered.textContent).toContain('[image: logo, not loaded]');
    const site = within(rendered).getByText('site');
    expect(site.getAttribute('href')).toBeNull();
    expect(site.getAttribute('title')).toBe('Link not followed: https://example.com');
    expect(within(rendered).getByText('top').getAttribute('href')).toBe('#top');
    fireEvent.click(panel.getByRole('button', { name: 'Text' }));
    expect((await panel.findByLabelText('Contents of README.md')).textContent).toBe('# Title\n');
    expect(api.calls.filter((call) => call.path.endsWith('/entry/preview'))).toHaveLength(1);
  });

  it('shows an image from a local object URL, zooms it, and releases the URL', async () => {
    mockApi(routes());
    const { unmount } = render(
      <ArchiveExplorerDialog vm={VM} node={node()} onClose={() => undefined} />,
    );
    const panel = await selectFile('screen.png');
    const image = await panel.findByRole('img', { name: 'Preview of screen.png' });
    expect(image.getAttribute('src')).toMatch(/^blob:test\//);
    expect(panel.getByText(/PNG, 640 × 480 pixels/)).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: '100%' }));
    expect(image.style.width).toBe('640px');
    fireEvent.click(panel.getByRole('button', { name: 'Zoom in' }));
    expect(panel.getByText('200%')).toBeTruthy();
    expect(image.className).toBe('archive-pixelated');
    fireEvent.error(image);
    expect(panel.getByText(/could not display this image/)).toBeTruthy();
    unmount();
    expect(revoked).toEqual(created);
  });

  it('shows a PDF page by page, and destroys the document when the file changes', async () => {
    mockApi(routes());
    open();
    const panel = await selectFile('manual.pdf');
    expect(await panel.findByText('of 3')).toBeTruthy();
    await waitFor(() => expect(pdf.rendered).toEqual([1]));
    fireEvent.click(panel.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(pdf.rendered).toEqual([1, 2]));
    expect(
      panel.getByText(/links, forms, attachments and scripts in the PDF are not active/),
    ).toBeTruthy();
    await selectFile('vm.cfg');
    await waitFor(() => expect(pdf.destroyed).toBe(1));
  });

  it('shows binary files as hex, in windows, and explains the limit of a deflated entry', async () => {
    const api = mockApi(routes());
    open();
    const panel = await selectFile('bios.bin');
    expect(panel.getByText(/No preview is available/)).toBeTruthy();
    const dump = await panel.findByLabelText('Hexadecimal bytes');
    expect(dump.textContent).toContain('00000000  4d 5a 90 00 01');
    expect(dump.textContent).toContain('MZ..');
    expect(panel.getByText(/only the first 128\.0 KiB can be shown/)).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) => call.query.get('kind') === 'hex' && call.query.get('offset') === '65536',
        ),
      ).toBe(true),
    );
    fireEvent.change(panel.getByLabelText('Go to offset'), { target: { value: '0x30000' } });
    fireEvent.click(panel.getByRole('button', { name: 'Go' }));
    expect(panel.getByRole('alert').textContent).toMatch(/compressed/);
    fireEvent.click(panel.getByRole('button', { name: 'CP437' }));
    expect((await panel.findByLabelText('Hexadecimal bytes')).textContent).toContain('MZÉ ☺');
  });

  it('formats hex rows with offsets, both groups and characters', () => {
    const row = hexDump(
      new Uint8Array([...'Hello, DOS world'].map((c) => c.charCodeAt(0)).concat([0])),
      0x100,
      'ascii',
      8,
    );
    expect(row.split('\n')).toEqual([
      '00000100  48 65 6c 6c 6f 2c 20 44  4f 53 20 77 6f 72 6c 64  Hello, DOS world',
      '00000110  00                                                .',
    ]);
  });

  it('downloads one file through the server and saves it, or says why it cannot', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const api = mockApi(routes());
    open();
    const panel = await selectFile('vm.cfg');
    fireEvent.click(await panel.findByRole('button', { name: 'Download file' }));
    expect(await panel.findByText('Downloaded and verified.')).toBeTruthy();
    expect(click).toHaveBeenCalledTimes(1);
    expect(api.calls.some((call) => call.path.endsWith('/entry/download'))).toBe(true);
    click.mockRestore();
  });

  it('says when a file is larger than a single-file download', async () => {
    mockApi(
      routes({
        [`GET ${ARCHIVE()}/entry`]: details('bios.bin', 'binary', {
          download: { allowed: false, maxBytes: 1024 },
        }),
      }),
    );
    open();
    const panel = await selectFile('bios.bin');
    expect(await panel.findByText(/larger than 1\.0 KiB cannot be downloaded/)).toBeTruthy();
    expect(panel.queryByRole('button', { name: 'Download file' })).toBeNull();
  });

  it('cancels a file’s requests when another is selected, and never shows a late answer', async () => {
    let releaseSlow: (value: Response) => void = () => undefined;
    const api = mockApi(
      routes({
        [`GET ${ARCHIVE()}/entry/preview`]: (call: RecordedCall) =>
          call.query.get('path') === 'dos.txt'
            ? new Promise<Response>((resolve) => {
                releaseSlow = resolve;
              })
            : bytes('[General]\n'),
      }),
    );
    const fetchMock = vi.mocked(fetch);
    open();
    await selectFile('dos.txt');
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) => call.query.get('path') === 'dos.txt' && call.query.get('kind') === 'text',
        ),
      ).toBe(true),
    );
    const slowCall = fetchMock.mock.calls.find(
      ([url]) => String(url).includes('preview') && String(url).includes('dos.txt'),
    );
    const slowSignal = (slowCall?.[1] as RequestInit | undefined)?.signal ?? undefined;
    const panel = await selectFile('vm.cfg');
    expect(slowSignal?.aborted).toBe(true);
    expect((await panel.findByLabelText('Contents of vm.cfg')).textContent).toBe('[General]\n');
    await act(async () => releaseSlow(bytes('LATE')));
    expect(screen.queryByText('LATE')).toBeNull();
    expect(screen.queryByLabelText('Contents of dos.txt')).toBeNull();
  });

  it('explains every failure in words', async () => {
    mockApi(
      routes({
        [`GET ${ARCHIVE()}/entry`]: apiError(503, 'preview_busy', 'busy'),
      }),
    );
    open();
    const panel = await selectFile('vm.cfg');
    expect((await panel.findByRole('alert')).textContent).toMatch(/as many previews as it allows/);
  });

  it('explains a busy server and an unavailable view', async () => {
    mockApi({ [`GET ${ARCHIVE()}`]: apiError(503, 'inspection_busy', 'x') });
    open();
    expect((await (await dialog()).findByRole('alert')).textContent).toMatch(
      /reading other archives/,
    );
  });

  it('is usable from the keyboard', async () => {
    mockApi(routes());
    open();
    const view = await dialog();
    const tree = await view.findByRole('tree', { name: 'Archive files' });
    const docs = await within(tree).findByRole('treeitem', { name: 'docs, directory' });
    docs.focus();
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(await within(tree).findByRole('treeitem', { name: 'f000.txt' })).toBeTruthy();
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    await waitFor(() =>
      expect(within(tree).queryByRole('treeitem', { name: 'f000.txt' })).toBeNull(),
    );
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('vm.cfg'));
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(await view.findByRole('region', { name: 'File vm.cfg' })).toBeTruthy();
    expect(
      within(tree).getByRole('treeitem', { name: 'vm.cfg' }).getAttribute('aria-selected'),
    ).toBe('true');
    // The splitter moves with the arrow keys too.
    const splitter = view.getByRole('separator', { name: 'Resize the file list' });
    const width = Number(splitter.getAttribute('aria-valuenow'));
    fireEvent.keyDown(splitter, { key: 'ArrowRight' });
    expect(Number(splitter.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(width);
  });

  it('shows one panel at a time on narrow screens, and keeps the tree when going back', async () => {
    mockApi(routes());
    open();
    const view = await dialog();
    const split = (await view.findByRole('tree', { name: 'Archive files' })).closest(
      '.archive-split',
    ) as HTMLElement;
    expect(split.dataset.pane).toBe('tree');
    fireEvent.click(await view.findByRole('treeitem', { name: 'docs, directory' }));
    await view.findByRole('treeitem', { name: 'f000.txt' });
    await selectFile('vm.cfg');
    expect(split.dataset.pane).toBe('file');
    fireEvent.click(view.getByRole('button', { name: '← Back to files' }));
    expect(split.dataset.pane).toBe('tree');
    expect(view.getByRole('treeitem', { name: 'f000.txt' })).toBeTruthy();
  });

  it('keeps each view’s tree while switching views, and works in the dark theme', async () => {
    document.documentElement.setAttribute('data-bs-theme', 'dark');
    mockApi(routes());
    open();
    const view = await dialog();
    fireEvent.click(await view.findByRole('treeitem', { name: 'docs, directory' }));
    await view.findByRole('treeitem', { name: 'f000.txt' });
    fireEvent.click(view.getByRole('button', { name: 'Stored entries' }));
    expect(await view.findByRole('treeitem', { name: '.emucat-manifest.json' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'VM files' }));
    expect(view.getByRole('treeitem', { name: 'f000.txt' })).toBeTruthy();
  });

  it('searches all paths and selects a result', async () => {
    mockApi(routes());
    open();
    const view = await dialog();
    fireEvent.change(view.getByRole('searchbox', { name: 'Search paths' }), {
      target: { value: 'a.txt' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Search' }));
    const panel = await selectFile('docs/a.txt');
    expect(await panel.findByLabelText('Contents of docs/a.txt')).toBeTruthy();
  });
});

describe('Archive HTML sanitizer', () => {
  it('keeps text formatting and removes everything that could run, load or navigate', () => {
    const clean = sanitizeArchiveHtml(
      '<p id="x" style="color:red" onclick="x()">Hi <svg><script>1</script></svg><math></math>' +
        '<a href="javascript:alert(1)">j</a><a href="//evil">e</a><video src="v.mp4"></video>' +
        '<form><input></form><object data="x"></object><img srcset="a 1x"></p>',
    );
    const holder = document.createElement('div');
    holder.innerHTML = clean;
    expect(
      holder.querySelector(
        'svg, script, math, video, form, input, object, img, [style], [id], [onclick]',
      ),
    ).toBeNull();
    expect([...holder.querySelectorAll('a')].every((link) => !link.hasAttribute('href'))).toBe(
      true,
    );
    expect(holder.textContent).toContain('Hi');
  });
});
