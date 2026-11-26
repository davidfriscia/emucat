/**
 * Archive Explorer in a real browser (decision 0058): the production bundle (built by `e2e/vite.config.ts`), served
 * as the web container's nginx serves it, against a stand-in for the archive routes of the API. It proves what the
 * jsdom tests cannot: the archive worker and PDF.js load as module workers from this origin with nginx's types,
 * nested archives open and preview with real decoders, canvases and downloads, nothing leaves the origin, nothing
 * logs an error, and the page stays responsive while the worker works.
 *
 * Run with `pnpm --filter @emucat/web test:browser`. The browser is Edge or Chrome, or `EMUCAT_BROWSER_PATH`.
 * Screenshots are written to `EMUCAT_BROWSER_SCREENSHOTS` when set; measurements are printed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crc32 } from '../src/archive-local/bytes';
import { tar, text, zip } from '../test/archive-local/fixtures';
import { startServer, type HarnessServer, type RecordedRequest } from './server';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(WEB, 'e2e', 'dist');
const SHOTS = process.env.EMUCAT_BROWSER_SCREENSHOTS ?? null;
const VERSION = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8010';
const SHA = 'a'.repeat(64);
const ARCHIVE = `/admin/vms/86box/DOS622/versions/${VERSION}/archive`;

// --- Synthetic fixtures -------------------------------------------------------------------------------------------

function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...Buffer.from(type, 'latin1'), ...data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.set(body, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      raw[at] = (x * 255) / width;
      raw[at + 1] = (y * 255) / height;
      raw[at + 2] = 160;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function ppm(width: number, height: number): Uint8Array {
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 3] = (index % width) * 4;
    pixels[index * 3 + 1] = 64;
    pixels[index * 3 + 2] = Math.floor(index / width) * 5;
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

function pdf(title: string): Uint8Array {
  const stream = `BT /F1 20 Tf 40 120 Td (${title}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return text(body);
}

const INSTALL = text('INSTALL.TXT\r\n\r\nRun SETUP.EXE from drive A: and follow the prompts.\r\n');
const CONFIG = text(
  '[General]\nvid_renderer = qt_software\nmachine = ibm5150\n\n[Input devices]\nmouse_type = none\n',
);
const EXTRAS = tar([{ name: 'extras/README.TXT', data: text('The deepest level.') }]);
const DRIVERS = zip([
  { name: 'MOUSE.COM', data: Uint8Array.from([0xe9, 0x10, 0x00, 0x4d, 0x5a, 0x90]) },
  { name: 'INSTALL.TXT', data: INSTALL },
  { name: 'extras.tar', data: EXTRAS, method: 0 },
]);
const UTILITIES = zip([
  {
    name: 'README.TXT',
    data: text('Utilities for MS-DOS 6.22\r\n\r\nSee docs/ for the manual.\r\n'),
  },
  { name: 'docs/', directory: true },
  { name: 'docs/manual.pdf', data: pdf('EmuCat nested manual') },
  { name: 'docs/setup.png', data: png(320, 200) },
  { name: 'docs/logo.ppm', data: ppm(64, 48) },
  { name: 'docs/notes.md', data: text('# Notes\n\nA *nested* Markdown file.\n') },
  { name: 'drivers.zip', data: DRIVERS },
]);

const entry = (path: string, sizeBytes: number, type: 'file' | 'directory' = 'file') => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type,
  sizeBytes: type === 'file' ? sizeBytes : null,
  compressedSizeBytes: null,
  method: null,
  sha256: type === 'file' ? SHA : null,
  modifiedAt: null,
  childCount: type === 'directory' ? 3 : null,
});

const ROOT = [
  entry('nvr', 0, 'directory'),
  entry('86box.cfg', CONFIG.length),
  entry('utilities.zip', UTILITIES.length),
  entry('slow.zip', UTILITIES.length),
  entry('huge.zip', 900_000_000),
  entry('disk.img', 10_485_760),
];
const NVR = [entry('nvr/486sp3c.bin', 131_072), entry('nvr/486sp3c.nvr', 128)];

const details = (path: string, size: number, kind: 'text' | 'binary') => ({
  view: 'logical',
  entry: entry(path, size),
  compression: 'deflated',
  crc32: '0badf00d',
  manifestSha256: SHA,
  detected:
    kind === 'text'
      ? {
          kind: 'text',
          format: 'text',
          language: 'ini',
          encoding: { name: 'utf-8', confidence: 'valid' },
        }
      : { kind: 'binary', format: 'binary', language: null, encoding: null },
  modes: kind === 'text' ? ['text', 'hex'] : ['hex'],
  unavailable: {},
  hex: { seekable: false, maxOffset: 16_777_216, windowBytes: 65_536 },
  download: { allowed: true, maxBytes: 104_857_600 },
  limits: {
    textBytes: 262_144,
    imageBytes: 20_971_520,
    pdfBytes: 26_214_400,
    imagePixels: 16_777_216,
  },
});

/** A synthetic archive of about `mebibytes` MiB: incompressible stored files and one deflated text file. */
function perfArchive(mebibytes: number): Uint8Array {
  const files = [];
  const textBytes = Math.min(8, Math.max(1, Math.floor(mebibytes / 4))) * 1024 * 1024;
  const line = 'C:\\>DIR /W  86BOX.CFG  NVR  UTILS  DOCS  ';
  files.push({
    name: 'big.txt',
    data: text(line.repeat(Math.ceil(textBytes / line.length)).slice(0, textBytes)),
  });
  let remaining = mebibytes * 1024 * 1024 - textBytes / 50;
  let index = 0;
  while (remaining > 0) {
    const size = Math.min(remaining, 4 * 1024 * 1024);
    const data = new Uint8Array(size);
    for (let at = 0; at < size; at += 65_536) {
      crypto.getRandomValues(data.subarray(at, Math.min(size, at + 65_536)));
    }
    files.push({ name: `data/blob${index++}.bin`, data, method: 0 });
    remaining -= size;
  }
  for (let file = 0; file < 500; file += 1)
    files.push({ name: `small/file${file}.txt`, data: text(`file ${file}\n`) });
  return zip(files);
}

// --- Harness ------------------------------------------------------------------------------------------------------

let server: HarnessServer;
let browser: Browser;
const externalRequests: string[] = [];
const consoleErrors: string[] = [];
let holdSlow: Promise<void> = Promise.resolve();
let releaseSlow: () => void = () => undefined;
const measurements: Record<string, unknown>[] = [];

async function launch(): Promise<Browser> {
  const executablePath = process.env.EMUCAT_BROWSER_PATH;
  if (executablePath) return chromium.launch({ executablePath, headless: true });
  return chromium
    .launch({ channel: 'msedge', headless: true })
    .catch(() => chromium.launch({ channel: 'chrome', headless: true }));
}

async function newPage(
  options: { theme?: 'light' | 'dark'; width?: number; height?: number } = {},
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: options.height ?? 800 },
    deviceScaleFactor: SHOTS ? 2 : 1,
    acceptDownloads: true,
    colorScheme: options.theme ?? 'light',
  });
  const page = await context.newPage();
  page.on('request', (request) => {
    if (
      !request.url().startsWith(server.url) &&
      !request.url().startsWith('blob:') &&
      !request.url().startsWith('data:')
    ) {
      externalRequests.push(request.url());
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.goto(`${server.url}/index.html?theme=${options.theme ?? 'light'}`);
  await page.getByRole('tree', { name: 'Archive files' }).waitFor();
  return page;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.jpg`), type: 'jpeg', quality: 82 });
}

const row = (page: Page, name: string | RegExp) =>
  page.getByRole('treeitem', { name, exact: typeof name === 'string' });

async function expand(page: Page, name: string) {
  await row(page, name).click();
  await row(page, name).press('ArrowRight');
}

const downloads = (path: string) =>
  server.requests.filter(
    (request: RecordedRequest) =>
      request.path.endsWith('/entry/download') && request.query.get('path') === path,
  );

beforeAll(async () => {
  execFileSync('npx', ['vite', 'build', '--config', 'e2e/vite.config.ts', '--logLevel', 'warn'], {
    cwd: WEB,
    stdio: 'inherit',
  });
  server = await startServer(DIST);
  server.routes.set(`GET ${ARCHIVE}`, () => ({
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
      repositoryName: 'My Storage',
      sizeBytes: 270_637_465,
      sha256: SHA,
    },
    complete: true,
    manifest: {
      manifestVersion: 1,
      vmName: 'DOS622',
      fileCount: 8,
      directoryCount: 1,
      totalUncompressedBytes: 900_000_000,
      sha256: SHA,
      matchesRegistration: true,
    },
    physical: {
      entryCount: 9,
      fileCount: 8,
      directoryCount: 1,
      compressedBytes: 270_000_000,
      uncompressedBytes: 900_000_000,
    },
    views: ['logical', 'physical'],
    warnings: [],
  }));
  server.routes.set(`GET ${ARCHIVE}/entries`, (request) => {
    const path = request.query.get('path') ?? '';
    const entries = path === 'nvr' ? NVR : ROOT;
    return { view: 'logical', path, q: null, entries, total: entries.length, nextOffset: null };
  });
  server.routes.set(`GET ${ARCHIVE}/entry`, (request) => {
    const path = request.query.get('path') ?? '';
    const size = [...ROOT, ...NVR].find((item) => item.path === path)?.sizeBytes ?? 0;
    return details(path, size, path.endsWith('.cfg') ? 'text' : 'binary');
  });
  server.routes.set(`GET ${ARCHIVE}/entry/preview`, (request) => {
    const kind = request.query.get('kind');
    const headers = {
      'content-type': 'application/octet-stream',
      'x-emucat-preview-offset': request.query.get('offset') ?? '0',
      'x-emucat-entry-size': String(CONFIG.length),
      'x-emucat-preview-truncated': 'false',
      'x-emucat-preview-integrity': kind === 'hex' ? 'partial' : 'verified',
    };
    return new Response((kind === 'hex' ? UTILITIES.subarray(0, 512) : CONFIG) as BodyInit, {
      headers,
    });
  });
  server.routes.set(`GET ${ARCHIVE}/entry/download`, async (request) => {
    const path = request.query.get('path');
    if (path === 'slow.zip') await holdSlow;
    const body = path === 'utilities.zip' || path === 'slow.zip' ? UTILITIES : CONFIG;
    return new Response(body as BodyInit, {
      headers: { 'content-type': 'application/octet-stream' },
    });
  });
  for (const size of [1, 10, 50, 64]) {
    const archive = perfArchive(size === 64 ? 63.5 : size);
    server.routes.set(`GET /perf/${size}.zip`, () => new Response(archive as BodyInit));
  }
  browser = await launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (measurements.length) {
    console.log(JSON.stringify(measurements, null, 2));
    if (SHOTS)
      writeFileSync(join(SHOTS, 'measurements.json'), JSON.stringify(measurements, null, 2));
  }
});

describe('Archive Explorer in a browser', () => {
  it('serves its worker and bundles from this origin as JavaScript', () => {
    const assets = readFileSync(join(DIST, 'index.html'), 'utf8');
    expect(assets).toMatch(/assets\/index-[\w-]+\.js/u);
    const built = execFileSync('ls', [join(DIST, 'assets')], { encoding: 'utf8' }).split('\n');
    expect(built.some((name) => /^archive\.worker-[\w-]+\.js$/u.test(name))).toBe(true);
    expect(built.some((name) => name.endsWith('.mjs') || name.endsWith('.wasm'))).toBe(false);
  });

  it('shows a compact toolbar, metadata on demand, and a preview that fills the panel', async () => {
    const page = await newPage();
    await shot(page, 'after-overview');
    await row(page, '86box.cfg').click();
    const contents = page.getByLabel('Contents of 86box.cfg');
    await expect.poll(() => contents.textContent()).toContain('machine = ibm5150');
    const toolbar = page.getByRole('toolbar', { name: 'File actions' });
    for (const name of [
      'Text',
      'Hex',
      'Wrap lines',
      'Highlight (ini)',
      'Copy text',
      'Download file',
      'File information',
    ]) {
      expect(await toolbar.getByRole('button', { name, exact: true }).count()).toBe(1);
    }
    const pane = await page.locator('.archive-file-pane').boundingBox();
    const preview = await page.locator('.archive-preview').boundingBox();
    expect(preview && pane && preview.height / pane.height).toBeGreaterThan(0.7);
    await page.getByRole('button', { name: 'File information' }).click();
    await expect.poll(() => page.getByRole('dialog', { name: '86box.cfg' }).isVisible()).toBe(true);
    // The popover lies over the preview: the preview keeps its size.
    expect((await page.locator('.archive-preview').boundingBox())?.height).toBe(preview?.height);
    await shot(page, 'after-file-info');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByRole('dialog', { name: '86box.cfg' }).count()).toBe(0);
    expect(await page.getByRole('dialog', { name: 'Archive Explorer' }).count()).toBe(1);
    await page.context().close();
  });

  it('opens nested archives with one download, and previews text, Markdown, images and PDF locally', async () => {
    const page = await newPage();
    const before = server.requests.length;
    await expand(page, 'utilities.zip, ZIP archive');
    await row(page, 'docs, directory').waitFor();
    expect(downloads('utilities.zip')).toHaveLength(1);
    const afterOpen = server.requests.filter((request) => request.path.startsWith('/api/')).length;
    await expand(page, 'docs, directory');

    await row(page, 'notes.md').click();
    await page.getByRole('document', { name: 'Rendered docs/notes.md' }).waitFor();

    await row(page, 'setup.png').click();
    const image = page.getByRole('img', { name: 'Preview of docs/setup.png' });
    await expect
      .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBe(320);
    await shot(page, 'after-nested-image');

    await row(page, 'logo.ppm').click();
    const legacy = page.getByRole('img', { name: 'Preview of docs/logo.ppm' });
    await expect
      .poll(() => legacy.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBe(64);
    expect(await page.getByText(/converted to PNG in your browser/).count()).toBe(1);

    await row(page, 'manual.pdf').click();
    await page
      .getByRole('img', { name: 'Page 1 of docs/manual.pdf' })
      .waitFor({ state: 'visible' });
    await expect.poll(() => page.getByText(/Page 1 of 1\./).count()).toBe(1);
    // PDF.js's worker came from this origin, as JavaScript.
    expect(
      server.requests.some((request) =>
        /\/assets\/pdf\.worker\.min-[\w-]+\.js$/u.test(request.path),
      ),
    ).toBe(true);
    await shot(page, 'after-nested-pdf');

    // Nothing of the nested files went to the API.
    const apiAfter = server.requests
      .slice(before)
      .filter((request) => request.path.startsWith('/api/'));
    expect(apiAfter.length).toBe(
      afterOpen -
        server.requests.slice(0, before).filter((request) => request.path.startsWith('/api/'))
          .length,
    );
    expect(
      server.requests.some((request) =>
        /\/assets\/archive\.worker-[\w-]+\.js$/u.test(request.path),
      ),
    ).toBe(true);
    await page.context().close();
  });

  it('opens deeper levels in the browser and downloads an inner file with its exact bytes', async () => {
    const page = await newPage();
    await expand(page, 'utilities.zip, ZIP archive');
    await expand(page, 'drivers.zip, ZIP archive');
    await expand(page, 'extras.tar, TAR archive');
    await row(page, 'extras, directory').waitFor();
    await row(page, 'INSTALL.TXT').click();
    await expect
      .poll(() => page.getByLabel('Contents of INSTALL.TXT').textContent())
      .toContain('SETUP.EXE');
    const crumbs = page.getByRole('navigation', { name: 'Location' });
    expect(await crumbs.textContent()).toBe('VM filesutilities.zipdrivers.zipINSTALL.TXT');
    await shot(page, 'after-nested-breadcrumb');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download file' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('INSTALL.TXT');
    const saved = readFileSync((await download.path()) as string);
    expect([...saved]).toEqual([...INSTALL]);
    expect(downloads('utilities.zip').length).toBeGreaterThanOrEqual(1);
    expect(server.requests.some((request) => request.query.get('path')?.includes('drivers'))).toBe(
      false,
    );
    await page.context().close();
  });

  it('refuses an archive over the limit, keeps working, and closes cleanly during a download', async () => {
    const page = await newPage();
    await expand(page, 'huge.zip, ZIP archive');
    await expect
      .poll(() => page.getByRole('alert').first().textContent())
      .toMatch(/browser opens archives inside an archive up to/);
    expect(downloads('huge.zip')).toHaveLength(0);
    await row(page, '86box.cfg').click();
    await page.getByLabel('Contents of 86box.cfg').waitFor();

    holdSlow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    await expand(page, 'slow.zip, ZIP archive');
    await expect.poll(() => downloads('slow.zip').length).toBe(1);
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Open Archive Explorer' }).waitFor();
    releaseSlow();
    await page.getByRole('button', { name: 'Open Archive Explorer' }).click();
    await expand(page, 'utilities.zip, ZIP archive');
    await row(page, 'docs, directory').waitFor();
    await page.context().close();
  });

  it('works in the dark theme and in a narrow window', async () => {
    const dark = await newPage({ theme: 'dark' });
    await expand(dark, 'utilities.zip, ZIP archive');
    await row(dark, 'README.TXT').click();
    await dark.getByLabel('Contents of README.TXT').waitFor();
    expect(await dark.evaluate(() => document.documentElement.getAttribute('data-bs-theme'))).toBe(
      'dark',
    );
    await shot(dark, 'after-dark');
    await dark.context().close();

    const narrow = await newPage({ width: 390, height: 844 });
    await row(narrow, '86box.cfg').click();
    await narrow.getByLabel('Contents of 86box.cfg').waitFor();
    // One panel at a time, and no horizontal scroll of the page.
    expect(await narrow.getByRole('tree', { name: 'Archive files' }).isVisible()).toBe(false);
    const overflow = await narrow.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(narrow, 'after-narrow');
    await narrow.getByRole('button', { name: 'Back to files' }).click();
    await narrow.getByRole('tree', { name: 'Archive files' }).waitFor();
    await narrow.context().close();
  });

  it('opens archives of 1 to 64 MiB in the worker without freezing the page', async () => {
    const page = await newPage();
    for (const size of [1, 10, 50, 64]) {
      const result = await page.evaluate(
        ([url]) =>
          (
            window as unknown as {
              emucatHarness: {
                measure: (url: string, entry: number) => Promise<Record<string, unknown>>;
              };
            }
          ).emucatHarness.measure(url as string, 0),
        [`${server.url}/perf/${size}.zip`],
      );
      measurements.push({ archiveMiB: size, ...result });
      // Indexing and decompressing in the worker leave the page's own timers running.
      expect(result.longestMainThreadGapMs as number).toBeLessThan(250);
    }
    await page.context().close();
  }, 180_000);

  it('made no request outside its origin and logged no error', () => {
    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
