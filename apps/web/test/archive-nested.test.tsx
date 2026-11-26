/**
 * Recursive archive browsing in Archive Explorer (decision 0058), in the browser: a nested archive is downloaded once
 * through the existing single-file API, read by the archive worker (here in the same thread, through the worker's
 * real message handler), and its files are previewed, located and downloaded without any other request. Limits,
 * errors, cancellation and cleanup are proved at the interface.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ARCHIVE_PREVIEW_HEADERS as H, type VersionNode } from '@emucat/contracts';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerLike } from '../src/archive-local/client';
import { DEFAULT_LOCAL_LIMITS, type LocalArchiveLimits } from '../src/archive-local/limits';
import type { WorkerRequest, WorkerResponse } from '../src/archive-local/protocol';
import { serveArchiveRequests } from '../src/archive-local/worker-handler';
import { ArchiveExplorerDialog } from '../src/components/ArchiveExplorer';
import { PDF_MINIMAL, PNG_1X1, tar, text, zip } from './archive-local/fixtures';
import { mockApi, type RecordedCall } from './mock-api';

vi.mock('vditor', () => ({ default: { md2html: async () => '<p>md</p>' } }));
const pdf = { rendered: [] as number[], destroyed: 0, opened: [] as number[] };
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { ENABLE: 1 },
  getDocument: ({ data }: { data: Uint8Array }) => {
    pdf.opened.push(data.length);
    return {
      promise: Promise.resolve({
        numPages: 2,
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
    };
  },
}));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({
  default: '/assets/pdf.worker.js',
}));

const VERSION = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8010';
const SHA = 'a'.repeat(64);
const VM = { emulatorType: '86box' as const, vmName: 'DOS622' };
const ARCHIVE = `/admin/vms/86box/DOS622/versions/${VERSION}/archive`;

const INSTALL = text('Run INSTALL.EXE from drive A:\r\n');
const DRIVERS = zip([
  { name: 'MOUSE.COM', data: Uint8Array.from([0xe9, 0x10, 0x00, 0x4d, 0x5a]) },
  { name: 'INSTALL.TXT', data: INSTALL },
  { name: 'extras.tar', data: tar([{ name: 'README.TXT', data: text('deep readme') }]), method: 0 },
]);
const UTILITIES = zip([
  { name: 'README.TXT', data: text('Utilities for DOS 6.22\r\n') },
  { name: 'docs/', directory: true },
  { name: 'docs/manual.pdf', data: PDF_MINIMAL },
  { name: 'docs/setup.png', data: PNG_1X1 },
  { name: 'drivers.zip', data: DRIVERS },
  { name: 'broken.zip', data: text('PK\u0003\u0004 this is not a real archive'), method: 0 },
  { name: 'README.TXT', data: text('A second README with the same path') },
]);

function node(): VersionNode {
  return {
    id: VERSION,
    kind: 'master',
    parentVersionId: null,
    childVersionIds: [],
    snapshotName: null,
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

const summary = {
  vm: { emulatorType: '86box', vmName: 'DOS622', title: 'MS-DOS 6.22' },
  version: {
    id: VERSION,
    kind: 'master',
    snapshotName: null,
    title: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  archive: {
    format: 'zip',
    fileName: `${VERSION}.zip`,
    repositoryName: 'NAS',
    sizeBytes: 4096,
    sha256: SHA,
  },
  complete: true,
  manifest: {
    manifestVersion: 1,
    vmName: 'DOS622',
    fileCount: 3,
    directoryCount: 0,
    totalUncompressedBytes: 3000,
    sha256: SHA,
    matchesRegistration: true,
  },
  physical: {
    entryCount: 4,
    fileCount: 4,
    directoryCount: 0,
    compressedBytes: 2000,
    uncompressedBytes: 3000,
  },
  views: ['logical'],
  warnings: [],
};

const entry = (path: string, sizeBytes: number) => ({
  name: path,
  path,
  type: 'file',
  sizeBytes,
  compressedSizeBytes: null,
  method: null,
  sha256: SHA,
  modifiedAt: null,
  childCount: null,
});

const ROOT = [
  entry('86box.cfg', 100),
  entry('utilities.zip', UTILITIES.length),
  entry('huge.zip', 900_000_000),
  entry('disk.img', 10_000),
];

const details = (path: string, size: number) => ({
  view: 'logical',
  entry: entry(path, size),
  compression: 'deflated',
  crc32: '0badf00d',
  manifestSha256: SHA,
  detected: { kind: 'binary', format: 'binary', language: null, encoding: null },
  modes: ['hex'],
  unavailable: {},
  hex: { seekable: false, maxOffset: 1000, windowBytes: 65_536 },
  download: { allowed: true, maxBytes: 104_857_600 },
  limits: {
    textBytes: 262_144,
    imageBytes: 20_971_520,
    pdfBytes: 26_214_400,
    imagePixels: 16_777_216,
  },
});

function routes(overrides: Record<string, unknown> = {}) {
  return {
    [`GET ${ARCHIVE}`]: summary,
    [`GET ${ARCHIVE}/entries`]: {
      view: 'logical',
      path: '',
      q: null,
      entries: ROOT,
      total: ROOT.length,
      nextOffset: null,
    },
    [`GET ${ARCHIVE}/entry`]: (call: RecordedCall) => {
      const path = call.query.get('path') ?? '';
      return details(path, ROOT.find((item) => item.path === path)?.sizeBytes ?? 0);
    },
    [`GET ${ARCHIVE}/entry/download`]: (call: RecordedCall) =>
      new Response(call.query.get('path') === 'utilities.zip' ? (UTILITIES as BodyInit) : 'x', {
        headers: { 'content-type': 'application/octet-stream' },
      }),
    [`GET ${ARCHIVE}/entry/preview`]: () =>
      new Response('[General]\n', { headers: { [H.integrity]: 'verified', [H.total]: '10' } }),
    ...overrides,
  };
}

/** The real worker handler, answering in the same thread, a turn later, as a worker would. */
class InThreadWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  terminated = false;
  received: WorkerRequest[] = [];
  private readonly scope = {
    onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
    postMessage: (message: WorkerResponse) => {
      setTimeout(() => {
        if (!this.terminated) this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
      }, 0);
    },
  };

  constructor() {
    serveArchiveRequests(this.scope);
  }

  postMessage(message: WorkerRequest): void {
    if (this.terminated) return;
    this.received.push(message);
    setTimeout(() => this.scope.onmessage?.({ data: message } as MessageEvent<WorkerRequest>), 0);
  }

  terminate(): void {
    this.terminated = true;
  }
}

let workers: InThreadWorker[] = [];
const createWorker = () => {
  const worker = new InThreadWorker();
  workers.push(worker);
  return worker;
};

function open(limits?: Partial<LocalArchiveLimits>) {
  const props = {
    vm: VM,
    node: node(),
    onClose: () => undefined,
    createWorker,
    localLimits: limits ? { ...DEFAULT_LOCAL_LIMITS, ...limits } : undefined,
  };
  // StrictMode, as the application renders: effects are cleaned up once on mount, which nothing may break.
  return render(
    <StrictMode>
      <ArchiveExplorerDialog {...props} />
    </StrictMode>,
  );
}

async function dialog() {
  return within(await screen.findByRole('dialog', { name: 'Archive Explorer' }));
}

/** Expands a tree row from the keyboard, as a person would. */
async function expand(name: string | RegExp) {
  const view = await dialog();
  const tree = await view.findByRole('tree');
  const row = await within(tree).findByRole('treeitem', { name });
  row.focus();
  fireEvent.focus(row);
  fireEvent.keyDown(tree, { key: 'ArrowRight' });
  return row;
}

async function select(name: string | RegExp) {
  const view = await dialog();
  const row = await view.findByRole('treeitem', { name });
  fireEvent.click(row);
  return within(await view.findByRole('region', { name: /^File / }));
}

beforeEach(() => {
  workers = [];
  pdf.rendered = [];
  pdf.destroyed = 0;
  pdf.opened = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  let next = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:test/${next++}`),
      revokeObjectURL: vi.fn(),
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Nested archives in Archive Explorer', () => {
  it('shows archives as expandable nodes, and never downloads one that is not expanded', async () => {
    const api = mockApi(routes());
    open();
    const view = await dialog();
    const utilities = await view.findByRole('treeitem', { name: 'utilities.zip, ZIP archive' });
    expect(utilities.getAttribute('aria-expanded')).toBe('false');
    // A disk image is a file: it never expands.
    expect(
      (await view.findByRole('treeitem', { name: 'disk.img' })).getAttribute('aria-expanded'),
    ).toBeNull();
    // Selecting an archive shows it as a file, with its own download; nothing is fetched whole.
    const panel = await select('utilities.zip, ZIP archive');
    expect(await panel.findByLabelText('Hexadecimal bytes')).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Browse this archive' })).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Download file' })).toBeTruthy();
    expect(api.calls.some((call) => call.path.endsWith('/entry/download'))).toBe(false);
    expect(workers).toHaveLength(0);
  });

  it('opens a nested ZIP with one download, browses it, and previews its files in the browser', async () => {
    const api = mockApi(routes());
    open();
    await expand('utilities.zip, ZIP archive');
    const view = await dialog();
    expect(await view.findByRole('treeitem', { name: 'docs, directory' })).toBeTruthy();
    const downloads = api.calls.filter((call) => call.path.endsWith('/entry/download'));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.query.get('path')).toBe('utilities.zip');
    expect(downloads[0]?.query.get('view')).toBe('logical');
    const before = api.calls.length;

    // Two entries with the same path stay two rows, each read on its own.
    const readmes = await view.findAllByRole('treeitem', { name: 'README.TXT' });
    expect(readmes).toHaveLength(2);
    fireEvent.click(readmes[1] as HTMLElement);
    let panel = within(await view.findByRole('region', { name: 'File README.TXT' }));
    expect((await panel.findByLabelText('Contents of README.TXT')).textContent).toBe(
      'A second README with the same path',
    );
    fireEvent.click(readmes[0] as HTMLElement);
    panel = within(await view.findByRole('region', { name: 'File README.TXT' }));
    await waitFor(async () =>
      expect((await panel.findByLabelText('Contents of README.TXT')).textContent).toBe(
        'Utilities for DOS 6.22\r\n',
      ),
    );
    expect(panel.getByText(/matched the CRC-32 its archive records/)).toBeTruthy();

    // Its information says what rests on what: no SHA-256 is borrowed from the outer manifest.
    fireEvent.click(panel.getByRole('button', { name: 'File information' }));
    const info = within(panel.getByRole('dialog', { name: 'README.TXT' }));
    expect(info.getByText(/Not recorded/)).toBeTruthy();
    expect(info.getByText(/Declared by the nested archive/)).toBeTruthy();
    expect(info.getByText(/ZIP, level 1/)).toBeTruthy();
    expect(info.queryByText(SHA)).toBeNull();

    // A directory inside it, a PDF and an image, all from the bytes already in the browser.
    await expand('docs, directory');
    panel = await select('manual.pdf');
    await waitFor(() => expect(pdf.rendered).toContain(1));
    // Every document PDF.js was given (StrictMode opens it twice, destroying the first) is the whole file.
    expect(new Set(pdf.opened)).toEqual(new Set([PDF_MINIMAL.length]));
    const crumbs = within(panel.getByRole('navigation', { name: 'Location' }));
    expect(crumbs.getByRole('button', { name: 'utilities.zip' })).toBeTruthy();
    expect(crumbs.getByRole('button', { name: 'docs' })).toBeTruthy();
    panel = await select('setup.png');
    const image = await panel.findByRole('img', { name: 'Preview of docs/setup.png' });
    expect(image.getAttribute('src')).toMatch(/^blob:test\//);
    expect(panel.getByText(/PNG, 1 × 1 pixels/)).toBeTruthy();

    // Nothing of this reached the server.
    expect(api.calls.length).toBe(before);
  });

  it('opens archives inside nested archives, locally, and downloads an inner file with its exact bytes', async () => {
    const api = mockApi(routes());
    const saved: Blob[] = [];
    vi.mocked(URL.createObjectURL).mockImplementation((blob) => {
      saved.push(blob as Blob);
      return 'blob:test/saved';
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    open();
    await expand('utilities.zip, ZIP archive');
    await expand('drivers.zip, ZIP archive');
    await expand('extras.tar, TAR archive');
    const view = await dialog();
    expect(await view.findByRole('treeitem', { name: 'MOUSE.COM' })).toBeTruthy();
    const panel = await select('INSTALL.TXT');
    expect((await panel.findByLabelText('Contents of INSTALL.TXT')).textContent).toBe(
      'Run INSTALL.EXE from drive A:\r\n',
    );
    const crumbs = within(panel.getByRole('navigation', { name: 'Location' }));
    expect(crumbs.getByRole('button', { name: 'drivers.zip' })).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Download file' }));
    expect(
      await panel.findByText(/Saved from the nested archive, after matching its CRC-32/),
    ).toBeTruthy();
    expect(click).toHaveBeenCalledTimes(1);
    const bytes = new Uint8Array(await (saved.at(-1) as Blob).arrayBuffer());
    expect([...bytes]).toEqual([...INSTALL]);
    // One download in all: the outermost nested archive. Deeper levels were read in the browser.
    expect(api.calls.filter((call) => call.path.endsWith('/entry/download'))).toHaveLength(1);
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
    // A breadcrumb leads back to its archive.
    fireEvent.click(crumbs.getByRole('button', { name: 'drivers.zip' }));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        'drivers.zip, ZIP archive, opened',
      ),
    );
  });

  it('refuses what is over the limits or damaged, says why, and keeps the rest usable', async () => {
    const api = mockApi(routes());
    open();
    const view = await dialog();
    // Larger than the browser opens: refused before anything is downloaded.
    await expand('huge.zip, ZIP archive');
    expect((await view.findByRole('alert')).textContent).toMatch(
      /browser opens archives inside an archive up to 64\.0 MiB/,
    );
    expect(api.calls.some((call) => call.query.get('path') === 'huge.zip')).toBe(false);
    // Damaged: its first bytes say ZIP, its structure does not.
    await expand('utilities.zip, ZIP archive');
    await expand('broken.zip, ZIP archive');
    await waitFor(() =>
      expect(
        view.getAllByRole('alert').some((alert) => /damaged/.test(alert.textContent ?? '')),
      ).toBe(true),
    );
    // And the rest still works, inside the same nested archive and outside it.
    let panel = await select('INSTALL.TXT').catch(() => null);
    expect(panel).toBeNull();
    panel = await select('86box.cfg');
    expect(await panel.findByLabelText('Hexadecimal bytes')).toBeTruthy();
    panel = await select(/^drivers\.zip/u);
    expect(await panel.findByLabelText('Hexadecimal bytes')).toBeTruthy();
  });

  it('refuses archives nested deeper than the limit', async () => {
    mockApi(routes());
    open({ maxDepth: 1 });
    const view = await dialog();
    await expand('utilities.zip, ZIP archive');
    await expand('drivers.zip, ZIP archive');
    expect((await view.findByRole('alert')).textContent).toMatch(/at most 1 level deep/);
    // The archive that could be opened still is.
    expect(view.getByRole('treeitem', { name: 'docs, directory' })).toBeTruthy();
  });

  it('refuses an archive that would not fit the memory budget, and keeps what is open', async () => {
    mockApi(routes());
    open({ cacheBytes: UTILITIES.length + 4000 });
    const view = await dialog();
    await expand('utilities.zip, ZIP archive');
    await view.findByRole('treeitem', { name: 'docs, directory' });
    // drivers.zip is deflated, so it needs a copy of its own, and utilities.zip, its parent, cannot be released.
    await expand('drivers.zip, ZIP archive');
    expect((await view.findByRole('alert')).textContent).toMatch(/memory budget/);
    expect(view.getByRole('treeitem', { name: 'docs, directory' })).toBeTruthy();
  });

  it('searches only the archives opened here, and says so', async () => {
    const api = mockApi(routes());
    open();
    await expand('utilities.zip, ZIP archive');
    await expand('drivers.zip, ZIP archive');
    const view = await dialog();
    await view.findByRole('treeitem', { name: 'INSTALL.TXT' });
    fireEvent.change(view.getByLabelText('Search in'), { target: { value: 'loaded' } });
    fireEvent.change(view.getByRole('searchbox', { name: 'Search paths' }), {
      target: { value: 'install' },
    });
    const before = api.calls.length;
    fireEvent.click(view.getByRole('button', { name: 'Search' }));
    expect(
      await view.findByText(/1 path matches “install” in the 2 archives opened here/),
    ).toBeTruthy();
    expect(view.getByText(/Archives not opened were not searched/)).toBeTruthy();
    expect(api.calls.length).toBe(before);
    const panel = await select(/drivers\.zip › INSTALL\.TXT/u);
    expect(await panel.findByLabelText('Contents of INSTALL.TXT')).toBeTruthy();
  });

  it('stops a download when the explorer closes, and terminates its worker', async () => {
    let release: (response: Response) => void = () => undefined;
    mockApi(
      routes({
        [`GET ${ARCHIVE}/entry/download`]: () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      }),
    );
    const fetchMock = vi.mocked(fetch);
    const { unmount } = open();
    await expand('utilities.zip, ZIP archive');
    const view = await dialog();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/entry/download'))).toBe(
        true,
      ),
    );
    const downloadSignal =
      (
        fetchMock.mock.calls.find(([url]) => String(url).includes('/entry/download'))?.[1] as
          RequestInit | undefined
      )?.signal ?? undefined;
    expect(view.getByText(/Opening utilities\.zip|Downloading utilities\.zip/)).toBeTruthy();
    unmount();
    expect(downloadSignal?.aborted).toBe(true);
    await act(async () => release(new Response(UTILITIES as BodyInit)));
    // The worker had not even been needed yet: none was left running.
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it('keeps a collapsed archive for later, and terminates the worker with all it held on close', async () => {
    const api = mockApi(routes());
    const { unmount } = open();
    const row = await expand('utilities.zip, ZIP archive');
    const view = await dialog();
    await view.findByRole('treeitem', { name: 'docs, directory' });
    expect(workers).toHaveLength(1);
    fireEvent.keyDown(view.getByRole('tree'), { key: 'ArrowLeft' });
    await waitFor(() => expect(row.getAttribute('aria-expanded')).toBe('false'));
    const before = api.calls.length;
    fireEvent.keyDown(view.getByRole('tree'), { key: 'ArrowRight' });
    expect(await view.findByRole('treeitem', { name: 'docs, directory' })).toBeTruthy();
    expect(api.calls.length).toBe(before);
    unmount();
    expect(workers[0]?.terminated).toBe(true);
  });

  it('collapsing an archive while it opens cancels it, and a late answer changes nothing', async () => {
    let release: (response: Response) => void = () => undefined;
    mockApi(
      routes({
        [`GET ${ARCHIVE}/entry/download`]: () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      }),
    );
    open();
    const row = await expand('utilities.zip, ZIP archive');
    const view = await dialog();
    await view.findByText(/Opening utilities\.zip|Downloading utilities\.zip/);
    fireEvent.keyDown(view.getByRole('tree'), { key: 'ArrowLeft' });
    await waitFor(() => expect(row.getAttribute('aria-expanded')).toBe('false'));
    await act(async () => release(new Response(UTILITIES as BodyInit)));
    expect(view.queryByRole('treeitem', { name: 'docs, directory' })).toBeNull();
    expect(
      workers.flatMap((worker) => worker.received).some((message) => message.type === 'open'),
    ).toBe(false);
  });

  it('keeps archives in memory only, and makes no request outside the API', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const api = mockApi(routes());
    open();
    await expand('utilities.zip, ZIP archive');
    await (await dialog()).findByRole('treeitem', { name: 'docs, directory' });
    await select('INSTALL.TXT').catch(() => undefined);
    expect(setItem.mock.calls.every(([key]) => key === 'emucat.archiveExplorer.split')).toBe(true);
    expect(api.calls.every((call) => call.path.startsWith(ARCHIVE))).toBe(true);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith('/api/'))).toBe(
      true,
    );
  });
});
