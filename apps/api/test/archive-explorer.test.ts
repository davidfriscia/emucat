/**
 * Archive Explorer (decision 0056) end to end: a real SSH/SFTP server holds real archives, and administrators ask the
 * API for one file's details, previews and download. The SFTP server counts every byte it serves, so these tests
 * also show that only the needed byte ranges are ever read, that connections and handles are always released, and
 * that nothing is written to disk.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  ARCHIVE_PREVIEW_HEADERS as H,
  archiveEntryDetailsSchema,
  type ArchiveEntryDetails,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { Slots } from '../src/archives/explorer.js';
import { ArchiveInspection } from '../src/archives/inspection.js';
import { DEFAULT_ARCHIVE_POLICY, type ArchivePolicy } from '../src/archives/policy.js';
import { contentDisposition } from '../src/routes/admin-archives.js';
import { ADMIN_PASSWORD, insertVm, TestClient } from './browser-app.js';
import { closeServers, serverWorld, type ServerWorld } from './server-world.js';
import { closeWorlds } from './version-world.js';
import { redirectTemporaryDirectory } from './platform.js';
import { buildTar, buildZip, manifestFor, sha256 } from './zip-builder.js';

afterEach(async () => {
  await closeWorlds();
  await closeServers();
});

function policy(overrides: {
  inspection?: Partial<ArchivePolicy['inspection']>;
  cache?: Partial<ArchivePolicy['cache']>;
  preview?: Partial<ArchivePolicy['preview']>;
  download?: Partial<ArchivePolicy['download']>;
}): ArchivePolicy {
  const base = DEFAULT_ARCHIVE_POLICY;
  return {
    inspection: { ...base.inspection, ...overrides.inspection },
    cache: { ...base.cache, ...overrides.cache },
    preview: { ...base.preview, ...overrides.preview },
    download: { ...base.download, ...overrides.download },
  };
}

// --- Fixtures --------------------------------------------------------------------------------------------------

function bmp2x2(): Buffer {
  const rowBytes = 8; // 2 pixels × 3 bytes, padded to 4
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + rowBytes * 2, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(2, 18);
  header.writeInt32LE(2, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  return Buffer.concat([header, Buffer.alloc(rowBytes * 2, 0x80)]);
}

function pcx(width: number, height: number): Buffer {
  const header = Buffer.alloc(128);
  header[0] = 0x0a;
  header[1] = 5;
  header[2] = 1;
  header[3] = 8;
  header.writeUInt16LE(width - 1, 8);
  header.writeUInt16LE(height - 1, 10);
  header[65] = 1;
  header.writeUInt16LE(width, 66);
  const palette = Buffer.alloc(769, 0x40);
  palette[0] = 0x0c;
  return Buffer.concat([header, Buffer.alloc(width * height, 7), palette]);
}

function tga(width: number, height: number): Buffer {
  const header = Buffer.alloc(18);
  header[2] = 2;
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = 24;
  return Buffer.concat([header, Buffer.alloc(width * height * 3, 0x33)]);
}

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj ' +
    '3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

async function fixtures() {
  const png = await sharp({
    create: { width: 4, height: 3, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  const tiff = await sharp({
    create: { width: 5, height: 2, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .tiff()
    .toBuffer();
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico[6] = 4;
  ico[7] = 3;
  ico.writeUInt32LE(png.length, 14);
  ico.writeUInt32LE(22, 18);
  return {
    'vm.cfg': Buffer.from('[General]\nmachine = ibm5150\n'),
    README: Buffer.from('Read me first.\nThis VM runs DOS.\n'),
    'docs/notes.md': Buffer.from(
      '# Notes\n\n<script>alert(1)</script>\n![x](https://example.com/x.png)\n',
    ),
    'docs/page.html': Buffer.from('<html><body onload="alert(1)">Hi</body></html>\n'),
    'docs/logo.svg': Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n',
    ),
    'docs/manual.pdf': PDF,
    'docs/utf16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Héllo\n', 'utf16le')]),
    'docs/dos.txt': Buffer.from([0xc9, 0xcd, 0xcd, 0xbb, 0x0d, 0x0a, 0xba, 0x82, 0xba, 0x0d, 0x0a]),
    'img/photo.png': png,
    'img/renamed.jpg': png,
    'img/shot.bmp': bmp2x2(),
    'img/icon.ico': Buffer.concat([ico, png]),
    'img/screen.ppm': Buffer.concat([Buffer.from('P6\n2 2\n255\n'), Buffer.alloc(12, 0x99)]),
    'img/scan.tif': tiff,
    'img/art.pcx': pcx(3, 2),
    'img/art.tga': tga(2, 2),
    'img/broken.png': Buffer.concat([png.subarray(0, 24), Buffer.alloc(40, 0)]),
    'rom/bios.bin': randomBytes(200_000),
    'nvr/ibm5150.nvr': Buffer.from([0, 1, 2, 3, 0xff, 0xfe]),
  } satisfies Record<string, Buffer>;
}

async function explorerVersion(
  w: ServerWorld,
  files: Record<string, Buffer>,
  options: {
    stored?: string[];
    vmName?: string;
    snapshotOf?: string;
  } = {},
) {
  const vmName = options.vmName ?? 'DOS622';
  const [existing] = await w.context.pool.execute<import('mysql2').RowDataPacket[]>(
    "SELECT 1 FROM virtual_machines WHERE emulator_type = '86box' AND vm_name = ?",
    [vmName],
  );
  if (existing.length === 0) await insertVm(w.context.pool, { emulatorType: '86box', vmName });
  const { bytes, entries } = manifestFor('86box', vmName, files);
  for (const entry of entries) if (options.stored?.includes(entry.name)) entry.stored = true;
  const zip = buildZip(entries);
  const { id, key } = await w.insertVersion(zip, {
    vm: { emulatorType: '86box', vmName },
    ...(options.snapshotOf
      ? {
          kind: 'snapshot' as const,
          parentVersionId: options.snapshotOf,
          snapshotName: 'After setup',
        }
      : {}),
  });
  await w.context.pool.execute(
    `INSERT INTO registration_operations
       (id, agent_id, repository_id, emulator_type, vm_name, mode, state, version_id, archive_key,
        archive_size_bytes, archive_sha256, manifest_version, manifest_sha256, committed_at, finished_at, local_copy)
     VALUES (?, ?, ?, '86box', ?, 'copy', 'succeeded', ?, ?, ?, ?, 1, ?, UTC_TIMESTAMP(3),
       UTC_TIMESTAMP(3), 'preserved')`,
    [
      randomUUID(),
      w.paired.agentId,
      w.repository.id,
      vmName,
      id,
      key,
      zip.length,
      sha256(zip),
      sha256(bytes),
    ],
  );
  const base = `/admin/vms/86box/${vmName}/versions/${id}/archive`;
  return { id, key, zip, base };
}

const q = (path: string, extra: Record<string, string> = {}, view = 'logical') =>
  new URLSearchParams({ view, path, ...extra }).toString();

async function details(w: ServerWorld, base: string, path: string, view = 'logical') {
  const response = await w.admin.get(`${base}/entry?${q(path, {}, view)}`);
  expect(response.statusCode, response.body).toBe(200);
  return archiveEntryDetailsSchema.parse(response.json()) as ArchiveEntryDetails;
}

/** Polls a condition, for steps whose timing depends on the database and the network. */
async function until(condition: () => boolean, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Waits until the repository server has nothing open from this test. */
async function released(w: ServerWorld) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (w.sftp.openConnections() === 0 && w.sftp.openHandles() === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect({ connections: w.sftp.openConnections(), handles: w.sftp.openHandles() }).toEqual({
    connections: 0,
    handles: 0,
  });
}

/** A real HTTP request on its own socket, as a browser's download is, which the test can drop at any time. */
function rawGet(w: ServerWorld, url: string): Promise<{ response: IncomingMessage; drop(): void }> {
  const address = w.context.app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        path: `/api/v1${url}`,
        agent: false,
        headers: { host: 'emucat.test', cookie: `${w.admin.cookieName}=${w.admin.cookie}` },
      },
      (response) => resolve({ response, drop: () => request.destroy() }),
    );
    request.once('error', reject);
    request.end();
  });
}

/** Reads a response to its end; rejects if it ends early, as a browser's download then fails. */
function readAll(response: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.once('aborted', () => reject(new Error('aborted')));
    response.once('error', reject);
    response.once('end', () => {
      const body = Buffer.concat(chunks);
      const expected = Number(response.headers['content-length']);
      if (Number.isFinite(expected) && body.length !== expected) reject(new Error('short body'));
      else resolve(body);
    });
  });
}

const errorCode = (response: { json(): unknown }) =>
  (response.json() as { error: { code: string } }).error.code;

// --- Tests -----------------------------------------------------------------------------------------------------

describe('Archive Explorer: details and detection', () => {
  it('detects what each file is from its bytes, and offers the modes that fit', async () => {
    const w = await serverWorld();
    const { base } = await explorerVersion(w, await fixtures());
    const cases: Array<[string, string, string, string[]]> = [
      ['vm.cfg', 'text', 'text', ['text', 'hex']],
      ['README', 'text', 'text', ['text', 'hex']],
      ['docs/notes.md', 'markdown', 'markdown', ['rendered', 'text', 'hex']],
      ['docs/page.html', 'text', 'xml', ['text', 'hex']],
      ['docs/logo.svg', 'text', 'svg', ['text', 'hex']],
      ['docs/manual.pdf', 'pdf', 'pdf', ['pdf', 'hex']],
      ['img/photo.png', 'image', 'png', ['image', 'hex']],
      ['img/renamed.jpg', 'image', 'png', ['image', 'hex']],
      ['img/shot.bmp', 'image', 'bmp', ['image', 'hex']],
      ['img/scan.tif', 'image', 'tiff', ['image', 'hex']],
      ['img/art.pcx', 'image', 'pcx', ['image', 'hex']],
      ['rom/bios.bin', 'binary', 'binary', ['hex']],
      ['nvr/ibm5150.nvr', 'binary', 'binary', ['hex']],
    ];
    for (const [path, kind, format, modes] of cases) {
      const found = await details(w, base, path);
      expect({
        path,
        kind: found.detected.kind,
        format: found.detected.format,
        modes: found.modes,
      }).toEqual({
        path,
        kind,
        format,
        modes,
      });
    }
    const cfg = await details(w, base, 'vm.cfg');
    expect(cfg).toMatchObject({
      compression: 'deflated',
      detected: { language: 'ini', encoding: { name: 'utf-8', confidence: 'valid' } },
      download: { allowed: true },
      hex: { seekable: false },
    });
    expect(cfg.crc32).toMatch(/^[0-9a-f]{8}$/);
    expect(cfg.manifestSha256).toBe(sha256('[General]\nmachine = ibm5150\n'));
    expect((await details(w, base, 'docs/utf16.txt')).detected.encoding).toEqual({
      name: 'utf-16le',
      confidence: 'bom',
    });
    expect((await details(w, base, 'docs/dos.txt')).detected.encoding).toEqual({
      name: 'cp437',
      confidence: 'heuristic',
    });
    // The physical view resolves the same file, with the manifest's hash to verify against.
    expect((await details(w, base, 'vm.cfg', 'physical')).manifestSha256).toBe(cfg.manifestSha256);
    await released(w);
  });

  it('refuses directories, missing files, traversal and unknown views', async () => {
    const w = await serverWorld();
    const { base } = await explorerVersion(w, await fixtures());
    const directory = await w.admin.get(`${base}/entry?${q('docs')}`);
    expect([directory.statusCode, errorCode(directory)]).toEqual([409, 'entry_not_file']);
    const missing = await w.admin.get(`${base}/entry?${q('docs/nothing.txt')}`);
    expect([missing.statusCode, errorCode(missing)]).toEqual([404, 'entry_not_found']);
    for (const path of ['../vm.cfg', '/etc/passwd', 'docs/../vm.cfg']) {
      expect((await w.admin.get(`${base}/entry?${q(path)}`)).statusCode).toBe(400);
    }
    // A path is matched exactly: no normalization reaches another file.
    expect((await w.admin.get(`${base}/entry?${q('docs//notes.md')}`)).statusCode).toBe(404);
    expect((await w.admin.get(`${base}/entry?${q('VM.CFG')}`)).statusCode).toBe(404);
    // The manifest itself is a physical entry only.
    expect((await w.admin.get(`${base}/entry?${q('.emucat-manifest.json')}`)).statusCode).toBe(404);
    expect(
      (await w.admin.get(`${base}/entry?${q('.emucat-manifest.json', {}, 'physical')}`)).statusCode,
    ).toBe(200);
  });
});

describe('Archive Explorer: previews', () => {
  it('returns text as bytes, verified when whole, and says when it is truncated', async () => {
    const big = Buffer.from('line of text\n'.repeat(1000));
    const w = await serverWorld({
      overrides: { archives: policy({ preview: { textBytes: 4096 } }) },
    });
    const { base } = await explorerVersion(w, {
      'vm.cfg': Buffer.from('[General]\n'),
      'log.txt': big,
    });
    const whole = await w.admin.get(`${base}/entry/preview?${q('vm.cfg', { kind: 'text' })}`);
    expect(whole.statusCode).toBe(200);
    expect(whole.rawPayload.toString()).toBe('[General]\n');
    expect(whole.headers).toMatchObject({
      [H.integrity]: 'verified',
      [H.truncated]: 'false',
      [H.total]: '10',
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    expect(String(whole.headers['content-disposition'])).toMatch(/^attachment;/);
    const partial = await w.admin.get(`${base}/entry/preview?${q('log.txt', { kind: 'text' })}`);
    expect(partial.rawPayload.equals(big.subarray(0, 4096))).toBe(true);
    expect(partial.headers).toMatchObject({ [H.integrity]: 'partial', [H.truncated]: 'true' });
  });

  it('shows hex windows at any offset of a stored entry, and only near the start of a deflated one', async () => {
    const rom = randomBytes(300_000);
    const w = await serverWorld({
      overrides: { archives: policy({ preview: { hexBytes: 1024, maxSeekBytes: 8192 } }) },
    });
    const { base } = await explorerVersion(
      w,
      { 'stored.rom': rom, 'deflated.rom': rom },
      {
        stored: ['stored.rom'],
      },
    );
    const window = await w.admin.get(
      `${base}/entry/preview?${q('stored.rom', { kind: 'hex', offset: '250000' })}`,
    );
    expect(window.rawPayload.equals(rom.subarray(250_000, 251_024))).toBe(true);
    expect(window.headers).toMatchObject({ [H.offset]: '250000', [H.length]: '1024' });
    expect((await details(w, base, 'stored.rom')).hex).toEqual({
      seekable: true,
      maxOffset: 299_999,
      windowBytes: 1024,
    });
    const near = await w.admin.get(
      `${base}/entry/preview?${q('deflated.rom', { kind: 'hex', offset: '4096' })}`,
    );
    expect(near.rawPayload.equals(rom.subarray(4096, 5120))).toBe(true);
    const far = await w.admin.get(
      `${base}/entry/preview?${q('deflated.rom', { kind: 'hex', offset: '250000' })}`,
    );
    expect([far.statusCode, errorCode(far)]).toEqual([422, 'preview_offset_unsupported']);
    const past = await w.admin.get(
      `${base}/entry/preview?${q('stored.rom', { kind: 'hex', offset: '300000' })}`,
    );
    expect(past.statusCode).toBe(422);
  });

  it('passes browser images through after a dimension check, and converts legacy ones to PNG', async () => {
    const w = await serverWorld();
    const files = await fixtures();
    const { base } = await explorerVersion(w, files);
    const image = (path: string) =>
      w.admin.get(`${base}/entry/preview?${q(path, { kind: 'image' })}`);
    const png = await image('img/photo.png');
    expect(png.headers).toMatchObject({
      'content-type': 'image/png',
      [H.format]: 'png',
      [H.width]: '4',
      [H.height]: '3',
      [H.converted]: 'false',
    });
    expect(png.rawPayload.equals(files['img/photo.png'])).toBe(true);
    // The name says JPEG; the bytes say PNG, and PNG is what is served.
    expect((await image('img/renamed.jpg')).headers['content-type']).toBe('image/png');
    expect((await image('img/shot.bmp')).headers).toMatchObject({
      'content-type': 'image/bmp',
      [H.width]: '2',
    });
    expect((await image('img/icon.ico')).headers).toMatchObject({ 'content-type': 'image/x-icon' });
    for (const [path, format, width, height] of [
      ['img/screen.ppm', 'ppm', 2, 2],
      ['img/scan.tif', 'tiff', 5, 2],
      ['img/art.pcx', 'pcx', 3, 2],
      ['img/art.tga', 'tga', 2, 2],
    ] as const) {
      const converted = await image(path);
      expect(converted.statusCode, `${path}: ${converted.body}`).toBe(200);
      expect(converted.headers).toMatchObject({
        'content-type': 'image/png',
        [H.format]: format,
        [H.converted]: 'true',
      });
      const metadata = await sharp(converted.rawPayload).metadata();
      expect([metadata.format, metadata.width, metadata.height]).toEqual(['png', width, height]);
    }
    const broken = await image('img/broken.png');
    expect([broken.statusCode, errorCode(broken)]).toEqual([422, 'image_invalid']);
    // Text is never served as an image, whatever the request asks.
    expect((await image('docs/logo.svg')).statusCode).toBe(415);
  });

  it('refuses images with too many pixels and files larger than a preview allows', async () => {
    const w = await serverWorld({
      overrides: {
        archives: policy({
          preview: { imagePixels: 4096, pdfBytes: 64 * 1024, imageBytes: 200_000 },
        }),
      },
    });
    const large = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();
    const { base } = await explorerVersion(w, {
      'big.png': large,
      'huge.pdf': Buffer.concat([PDF, randomBytes(100_000)]),
      'many.bmp': Buffer.concat([bmp2x2(), randomBytes(300_000)]),
    });
    const pixels = await w.admin.get(`${base}/entry/preview?${q('big.png', { kind: 'image' })}`);
    expect([pixels.statusCode, errorCode(pixels)]).toEqual([413, 'image_too_large']);
    const pdf = await w.admin.get(`${base}/entry/preview?${q('huge.pdf', { kind: 'pdf' })}`);
    expect([pdf.statusCode, errorCode(pdf)]).toEqual([413, 'preview_too_large']);
    const found = await details(w, base, 'huge.pdf');
    expect(found.modes).toEqual(['hex']);
    expect(found.unavailable.pdf).toMatch(/64 KiB/);
    expect((await details(w, base, 'many.bmp')).modes).toEqual(['hex']);
  });

  it('returns a PDF as inert bytes, and only a PDF', async () => {
    const w = await serverWorld();
    const { base } = await explorerVersion(w, await fixtures());
    const pdf = await w.admin.get(`${base}/entry/preview?${q('docs/manual.pdf', { kind: 'pdf' })}`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.equals(PDF)).toBe(true);
    expect(pdf.headers['content-type']).toBe('application/octet-stream');
    expect(pdf.headers[H.integrity]).toBe('verified');
    const notPdf = await w.admin.get(`${base}/entry/preview?${q('vm.cfg', { kind: 'pdf' })}`);
    expect([notPdf.statusCode, errorCode(notPdf)]).toEqual([415, 'preview_unavailable']);
  });

  it('serves HTML and SVG only as bytes, never as a document or an image', async () => {
    const w = await serverWorld();
    const { base } = await explorerVersion(w, await fixtures());
    for (const path of ['docs/page.html', 'docs/logo.svg']) {
      const response = await w.admin.get(`${base}/entry/preview?${q(path, { kind: 'text' })}`);
      expect(response.headers['content-type']).toBe('application/octet-stream');
      expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(String(response.headers['content-disposition'])).toMatch(/^attachment/);
    }
  });
});

describe('Archive Explorer: download', () => {
  it('streams one file with safe headers, verified, reading only that file', async () => {
    const disk = randomBytes(3 * 1024 * 1024);
    const w = await serverWorld();
    const { base, zip } = await explorerVersion(
      w,
      { 'disk.img': disk, 'vm.cfg': Buffer.from('[General]\n') },
      { stored: ['disk.img'] },
    );
    await w.admin.get(base);
    w.sftp.resetStats();
    const response = await w.admin.get(`${base}/entry/download?${q('vm.cfg')}`);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.toString()).toBe('[General]\n');
    expect(response.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'content-length': '10',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="vm.cfg"; filename*=UTF-8''vm.cfg`,
    );
    // Measured: the small file's local header and data, and nothing of the 3 MiB disk before it.
    expect(w.sftp.stats.bytesRead).toBeLessThan(200);
    expect(zip.length).toBeGreaterThan(3 * 1024 * 1024);

    const large = await w.admin.get(`${base}/entry/download?${q('disk.img')}`);
    expect(large.rawPayload.equals(disk)).toBe(true);
    await released(w);
  });

  it('refuses a file larger than the download limit, and says so in the details', async () => {
    const w = await serverWorld({
      overrides: { archives: policy({ download: { maxBytes: 1000 } }) },
    });
    const { base } = await explorerVersion(w, {
      'big.bin': randomBytes(5000),
      'ok.cfg': Buffer.from('x'),
    });
    const refused = await w.admin.get(`${base}/entry/download?${q('big.bin')}`);
    expect([refused.statusCode, errorCode(refused)]).toEqual([413, 'download_too_large']);
    expect((await details(w, base, 'big.bin')).download).toEqual({
      allowed: false,
      maxBytes: 1000,
    });
    expect((await w.admin.get(`${base}/entry/download?${q('ok.cfg')}`)).statusCode).toBe(200);
  });

  it('never completes a download whose bytes do not match, and fails a small one with an error', async () => {
    const disk = randomBytes(3 * 1024 * 1024);
    const w = await serverWorld();
    const { base, key, zip } = await explorerVersion(
      w,
      { 'disk.img': disk, 'small.bin': randomBytes(1000) },
      {
        stored: ['disk.img', 'small.bin'],
      },
    );
    await w.admin.get(base);
    // Same size, same structure, one changed byte near the end of each file's data.
    const damaged = Buffer.from(zip);
    const at = zip.indexOf(disk.subarray(disk.length - 64)) + 10;
    damaged.writeUInt8(damaged.readUInt8(at) ^ 0xff, at);
    const small = zip.indexOf(Buffer.from('small.bin')) + 'small.bin'.length + 500;
    damaged.writeUInt8(damaged.readUInt8(small) ^ 0xff, small);
    await w.put(key, damaged);
    // Keep the modification time, so that only the content check can notice.
    const path = join(w.sftp.root, key);
    utimesSync(path, new Date(0), new Date(0));
    w.context.app.log.level = 'silent';
    // The cached index has the old modification time: it is refused as changed. Rebuilt from the damaged object, the
    // archive's structure is intact and only the contents are wrong.
    const changed = await w.admin.get(`${base}/entry/download?${q('disk.img')}`);
    expect([changed.statusCode, errorCode(changed)]).toEqual([409, 'archive_changed']);

    const smallResult = await w.admin.get(`${base}/entry/download?${q('small.bin')}`);
    expect([smallResult.statusCode, errorCode(smallResult)]).toEqual([422, 'integrity_failed']);

    const { response } = await rawGet(w, `${base}/entry/download?${q('disk.img')}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-length']).toBe(String(disk.length));
    // The body stops short: the last chunk was held back, and the stream ended in an error.
    await expect(readAll(response)).rejects.toThrow();
    await released(w);
  });

  it('sanitizes file names in Content-Disposition', () => {
    expect(contentDisposition('evil"\r\nX-Injected: 1;.txt')).toBe(
      `attachment; filename="evil___X-Injected_ 1_.txt"; filename*=UTF-8''evil___X-Injected_%201_.txt`,
    );
    expect(contentDisposition('Café.TXT')).toBe(
      `attachment; filename="Caf_.TXT"; filename*=UTF-8''Caf%C3%A9.TXT`,
    );
    expect(contentDisposition('..')).toMatch(/filename="download"/);
    expect(contentDisposition('a/b\\c')).toMatch(/filename="a_b_c"/);
  });
});

describe('Archive Explorer: authorization and identity', () => {
  it('is for administrators only, and checks the VM, the version and the origin on every request', async () => {
    const w = await serverWorld();
    const { base, id } = await explorerVersion(w, await fixtures());
    const urls = [
      `${base}/entry?${q('vm.cfg')}`,
      `${base}/entry/preview?${q('vm.cfg', { kind: 'text' })}`,
      `${base}/entry/download?${q('vm.cfg')}`,
    ];
    expect((await w.admin.get(urls[0] as string)).statusCode).toBe(200);
    const anonymous = new TestClient(w.context.app);
    await w.context.pool.execute(
      `INSERT INTO users (id, username, display_name, password_hash, role) VALUES (UUID(), 'viewer', 'V', ?, 'user')`,
      [await w.context.dependencies.passwords.hash(ADMIN_PASSWORD)],
    );
    const user = new TestClient(w.context.app);
    expect((await user.login('viewer', ADMIN_PASSWORD)).statusCode).toBe(200);
    for (const url of urls) {
      expect((await anonymous.get(url)).statusCode).toBe(401);
      expect((await user.get(url)).statusCode).toBe(403);
      const crossSite = await w.admin.request({ url, headers: { 'sec-fetch-site': 'cross-site' } });
      expect(crossSite.statusCode).toBe(403);
      // The same version through another VM, or another emulator, is not found.
      const other = url.replace('/86box/DOS622/', '/86box/Other/');
      expect((await w.admin.get(other)).statusCode).toBe(404);
      expect((await w.admin.get(url.replace('/86box/DOS622/', '/qemu/DOS622/'))).statusCode).toBe(
        404,
      );
    }
    void id;
  });

  it('never hands a shared, still-loading index to a request for another VM (assessment R1)', async () => {
    const w = await serverWorld();
    const { base, id } = await explorerVersion(w, await fixtures());
    await insertVm(w.context.pool, { emulatorType: '86box', vmName: 'Other' });
    w.sftp.readDelayMs = 30;
    const right = w.admin.get(`${base}/entries?view=logical`);
    // Both start while the first load is still reading the archive.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const wrong = w.admin.get(`/admin/vms/86box/Other/versions/${id}/archive/entries?view=logical`);
    const wrongEntry = w.admin.get(
      `/admin/vms/86box/Other/versions/${id}/archive/entry?${q('vm.cfg')}`,
    );
    const [ok, refused, refusedEntry] = await Promise.all([right, wrong, wrongEntry]);
    expect(ok.statusCode).toBe(200);
    expect(refused.statusCode).toBe(404);
    expect(refusedEntry.statusCode).toBe(404);
    expect(refused.body).not.toContain('vm.cfg');
  });

  it('refuses to read through a cached index once the object in the repository has changed (R10)', async () => {
    const w = await serverWorld();
    const { base, key, zip } = await explorerVersion(w, await fixtures());
    expect(
      (await w.admin.get(`${base}/entry/preview?${q('vm.cfg', { kind: 'text' })}`)).statusCode,
    ).toBe(200);
    // Replaced in place with the same bytes, as a careless copy would: a new modification time.
    await w.put(key, zip);
    utimesSync(join(w.sftp.root, key), new Date(), new Date(Date.now() + 60_000));
    const changed = await w.admin.get(`${base}/entry/preview?${q('vm.cfg', { kind: 'text' })}`);
    expect([changed.statusCode, errorCode(changed)]).toEqual([409, 'archive_changed']);
    // The stale index was dropped; the next request indexes the archive again.
    expect(
      (await w.admin.get(`${base}/entry/preview?${q('vm.cfg', { kind: 'text' })}`)).statusCode,
    ).toBe(200);
  });

  it('works the same for a snapshot', async () => {
    const w = await serverWorld();
    const master = await explorerVersion(w, await fixtures());
    const { base } = await explorerVersion(w, await fixtures(), { snapshotOf: master.id });
    const response = await w.admin.get(`${base}/entry/preview?${q('vm.cfg', { kind: 'text' })}`);
    expect(response.statusCode).toBe(200);
    expect((await w.admin.get(`${base}/entry/download?${q('rom/bios.bin')}`)).statusCode).toBe(200);
  });

  it('reads OVA files through the physical view only', async () => {
    const w = await serverWorld();
    await insertVm(w.context.pool, { emulatorType: 'virtualbox', vmName: 'XP' });
    const disk = randomBytes(100_000);
    const ova = buildTar([
      ['xp.ovf', Buffer.from('<?xml version="1.0"?>\n<Envelope/>\n')],
      ['xp-disk001.vmdk', disk],
    ]);
    const { id } = await w.insertVersion(ova, { vm: { emulatorType: 'virtualbox', vmName: 'XP' } });
    const base = `/admin/vms/virtualbox/XP/versions/${id}/archive`;
    const ovf = await details(w, base, 'xp.ovf', 'physical');
    expect(ovf).toMatchObject({
      compression: 'stored',
      crc32: null,
      detected: { kind: 'text', language: 'xml' },
    });
    const text = await w.admin.get(
      `${base}/entry/preview?${q('xp.ovf', { kind: 'text' }, 'physical')}`,
    );
    expect(text.headers[H.integrity]).toBe('complete');
    const hex = await w.admin.get(
      `${base}/entry/preview?${q('xp-disk001.vmdk', { kind: 'hex', offset: '90000' }, 'physical')}`,
    );
    expect(hex.rawPayload.equals(disk.subarray(90_000))).toBe(true);
    const logical = await w.admin.get(`${base}/entry?${q('xp.ovf')}`);
    expect([logical.statusCode, errorCode(logical)]).toEqual([409, 'archive_view_unavailable']);
    expect(
      (
        await w.admin.get(`${base}/entry/download?${q('xp-disk001.vmdk', {}, 'physical')}`)
      ).rawPayload.equals(disk),
    ).toBe(true);
  });
});

describe('Archive Explorer: resources', () => {
  it('reads only what it needs from a large archive, and writes nothing anywhere', async () => {
    const disk = randomBytes(24 * 1024 * 1024);
    const w = await serverWorld();
    const { base, zip } = await explorerVersion(
      w,
      { 'disks/hdd0.img': disk, 'vm.cfg': Buffer.from('[General]\nmachine = at\n') },
      { stored: ['disks/hdd0.img'] },
    );
    // This worker's temporary directory, empty, for the duration: whatever the server wrote would land in it.
    // TMPDIR on POSIX, TEMP and TMP on Windows: see platform.ts.
    const scratch = mkdtempSync(join(tmpdir(), 'emucat-explorer-'));
    const restoreTemporary = redirectTemporaryDirectory(scratch);
    const staging = readdirSync(w.sftp.directory).sort();
    let listing: number, preview: number, download: number, hex: number;
    try {
      w.sftp.resetStats();
      expect((await w.admin.get(base)).statusCode).toBe(200);
      listing = w.sftp.stats.bytesRead;
      w.sftp.resetStats();
      expect(
        (await w.admin.get(`${base}/entry/preview?${q('vm.cfg', { kind: 'text' })}`)).statusCode,
      ).toBe(200);
      preview = w.sftp.stats.bytesRead;
      w.sftp.resetStats();
      expect((await w.admin.get(`${base}/entry/download?${q('vm.cfg')}`)).statusCode).toBe(200);
      download = w.sftp.stats.bytesRead;
      w.sftp.resetStats();
      expect(
        (await w.admin.get(`${base}/entry/preview?${q('disks/hdd0.img', { kind: 'hex' })}`))
          .statusCode,
      ).toBe(200);
      hex = w.sftp.stats.bytesRead;
    } finally {
      restoreTemporary();
    }

    // Measured byte counts, reported by the implementation report.
    console.info(
      JSON.stringify({ archiveBytes: zip.length, listing, preview, download, hexOfDisk: hex }),
    );
    expect(listing).toBeLessThan(70 * 1024);
    // A preview's details read 4 KiB at most; the text itself and its header, a few hundred bytes.
    expect(preview).toBeLessThan(1024);
    expect(download).toBeLessThan(1024);
    expect(hex).toBeLessThan(65 * 1024 + 4 * 1024);
    expect(readdirSync(scratch)).toEqual([]);
    rmSync(scratch, { recursive: true });
    expect(readdirSync(w.sftp.directory).sort()).toEqual(staging);
    await released(w);
  });

  it('refuses previews beyond its concurrency, and stops at its deadline, releasing the connection', async () => {
    const w = await serverWorld({
      overrides: {
        archives: policy({ preview: { maxConcurrent: 1, maxQueued: 0, timeoutMs: 400 } }),
      },
    });
    const { base } = await explorerVersion(
      w,
      { 'rom.bin': randomBytes(300_000) },
      { stored: ['rom.bin'] },
    );
    await w.admin.get(base);
    w.sftp.readDelayMs = 150;
    const first = w.admin.get(`${base}/entry/preview?${q('rom.bin', { kind: 'hex' })}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await w.admin.get(`${base}/entry/preview?${q('rom.bin', { kind: 'hex' })}`);
    expect([second.statusCode, errorCode(second)]).toEqual([503, 'preview_busy']);
    w.sftp.readDelayMs = 2000;
    const slow = await first;
    expect([slow.statusCode, errorCode(slow)]).toEqual([504, 'archive_timeout']);
    w.sftp.readDelayMs = 0;
    await released(w);
  });

  it('stops and releases the repository connection when the browser goes away', async () => {
    const w = await serverWorld();
    const { base } = await explorerVersion(
      w,
      { 'disk.img': randomBytes(8 * 1024 * 1024) },
      {
        stored: ['disk.img'],
      },
    );
    await w.admin.get(base);
    w.sftp.readDelayMs = 20;
    const { response, drop } = await rawGet(w, `${base}/entry/download?${q('disk.img')}`);
    await new Promise((resolve) => response.once('data', resolve));
    drop();
    await released(w);
    w.sftp.resetStats();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Nothing more is read once the browser has gone.
    expect(w.sftp.stats.bytesRead).toBe(0);
    w.sftp.readDelayMs = 0;
  });
});

describe('Archive index cache', () => {
  const noop = () => undefined;
  const silent = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => silent,
  } as unknown as FastifyBaseLogger;
  const vm = { emulatorType: '86box' as const, vmName: 'DOS622' };

  it('keeps indexes within their count and byte budget, and refuses one that does not fit', async () => {
    const w = await serverWorld();
    const one = await explorerVersion(w, { 'a.cfg': Buffer.from('a') });
    const two = await explorerVersion(w, { 'b.cfg': Buffer.from('b') }, { snapshotOf: one.id });
    const lru = new ArchiveInspection(
      w.context.pool,
      w.access,
      silent,
      policy({ cache: { maxIndexes: 1 } }),
    );
    await lru.summary(vm, one.id);
    await lru.summary(vm, two.id);
    expect(lru.stats().indexes).toBe(1);
    w.sftp.resetStats();
    await lru.summary(vm, two.id);
    expect(w.sftp.stats.bytesRead).toBe(0);
    await lru.summary(vm, one.id);
    expect(w.sftp.stats.bytesRead).toBeGreaterThan(0);

    const budget = new ArchiveInspection(
      w.context.pool,
      w.access,
      silent,
      policy({ cache: { maxBytes: 6000 } }),
    );
    await budget.summary(vm, one.id);
    const first = budget.stats().estimatedBytes;
    expect(first).toBeGreaterThan(0);
    await budget.summary(vm, two.id);
    expect(budget.stats().estimatedBytes).toBeLessThanOrEqual(6000);
    expect(budget.stats().indexes).toBe(1);

    const tiny = new ArchiveInspection(
      w.context.pool,
      w.access,
      silent,
      policy({ cache: { maxBytes: 100 } }),
    );
    expect((await tiny.summary(vm, one.id)).manifest?.fileCount).toBe(1);
    expect(tiny.stats()).toEqual({ indexes: 0, estimatedBytes: 0, loading: 0, waiting: 0 });

    const expiring = new ArchiveInspection(
      w.context.pool,
      w.access,
      silent,
      policy({ cache: { ttlMs: 0 } }),
    );
    await expiring.summary(vm, one.id);
    w.sftp.resetStats();
    await expiring.summary(vm, one.id);
    expect(w.sftp.stats.bytesRead).toBeGreaterThan(0);
  });

  // Cancellation (R2). Every step waits on a state, never on time: the SFTP server holds READ answers until the test
  // releases them, and stats() says how many requests wait on a load.

  it('shares one load between requests, which can each give up without stopping the others (R2)', async () => {
    const w = await serverWorld();
    const { id } = await explorerVersion(w, await fixtures());
    const inspection = new ArchiveInspection(
      w.context.pool,
      w.access,
      silent,
      DEFAULT_ARCHIVE_POLICY,
    );
    const release = w.sftp.holdReads();
    const leaving = new AbortController();
    const staying = new AbortController();
    const first = inspection.summary(vm, id, leaving.signal);
    const second = inspection.summary(vm, id, staying.signal);
    // Both have joined the one load, and it is waiting on the repository.
    await until(() => inspection.stats().waiting === 2 && w.sftp.heldReads() > 0);
    expect(inspection.stats().loading).toBe(1);
    leaving.abort();
    await expect(first).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(inspection.stats()).toMatchObject({ loading: 1, waiting: 1 });
    release();
    expect((await second).manifest?.fileCount).toBeGreaterThan(0);
    // A completed load is cached, and cancelling after completion changes nothing.
    expect(inspection.stats()).toMatchObject({ indexes: 1, loading: 0, waiting: 0 });
    staying.abort();
    expect(inspection.stats().indexes).toBe(1);
    expect((await inspection.summary(vm, id)).manifest?.fileCount).toBeGreaterThan(0);
    await released(w);
  });

  it('stops a load when every requester has gone, at any read, and caches nothing (R2)', async () => {
    const w = await serverWorld();
    const { id } = await explorerVersion(w, await fixtures());
    const inspection = new ArchiveInspection(
      w.context.pool,
      w.access,
      silent,
      DEFAULT_ARCHIVE_POLICY,
    );
    // How many reads a whole load takes: the first ones find the directory, the last ones read the manifest that
    // the index is built from.
    w.sftp.resetStats();
    await inspection.summary(vm, id);
    const reads = w.sftp.stats.reads.length;
    expect(reads).toBeGreaterThan(1);
    for (const after of [0, Math.floor(reads / 2), reads - 1]) {
      inspection.evict(id);
      await released(w);
      w.sftp.resetStats();
      const release = w.sftp.holdReads(after);
      const a = new AbortController();
      const b = new AbortController();
      const pending = [inspection.summary(vm, id, a.signal), inspection.summary(vm, id, b.signal)];
      await until(() => inspection.stats().waiting === 2 && w.sftp.heldReads() > 0);
      a.abort();
      b.abort();
      const settled = await Promise.allSettled(pending);
      for (const result of settled) {
        expect(result, `held after ${after} reads`).toMatchObject({
          status: 'rejected',
          reason: { code: 'request_cancelled' },
        });
      }
      // The load stops by itself, with its answer still held: cancellation does not wait for the repository.
      await until(() => inspection.stats().loading === 0);
      release();
      await released(w);
      expect(inspection.stats(), `held after ${after} reads`).toMatchObject({
        indexes: 0,
        loading: 0,
        waiting: 0,
      });
    }
  });

  it('starts no load for a request cancelled before it reaches the repository (R2)', async () => {
    const w = await serverWorld();
    const { id } = await explorerVersion(w, await fixtures());
    const inspection = new ArchiveInspection(
      w.context.pool,
      w.access,
      silent,
      DEFAULT_ARCHIVE_POLICY,
    );
    w.sftp.resetStats();
    const aborted = new AbortController();
    aborted.abort();
    await expect(inspection.summary(vm, id, aborted.signal)).rejects.toMatchObject({
      code: 'request_cancelled',
    });
    // Cancelled while its version record is read from the database: summary() has not reached the repository yet
    // when it returns, so the abort below lands in that window. No load may start for nobody.
    const late = new AbortController();
    const request = inspection.summary(vm, id, late.signal);
    late.abort();
    await expect(request).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(inspection.stats()).toMatchObject({ indexes: 0, loading: 0, waiting: 0 });
    expect(w.sftp.stats.reads).toEqual([]);
    expect(w.sftp.openConnections()).toBe(0);
    // And the version is still listed normally afterwards.
    expect((await inspection.summary(vm, id)).manifest?.fileCount).toBeGreaterThan(0);
    await released(w);
  });

  it('refuses more concurrent loads than allowed, and stops a load at its deadline', async () => {
    const w = await serverWorld();
    const one = await explorerVersion(w, { 'a.cfg': Buffer.from('a') });
    const two = await explorerVersion(w, { 'b.cfg': Buffer.from('b') }, { snapshotOf: one.id });
    const inspection = new ArchiveInspection(
      w.context.pool,
      w.access,
      silent,
      policy({ inspection: { maxConcurrent: 1, timeoutMs: 300 } }),
    );
    w.sftp.readDelayMs = 500;
    const slow = inspection.summary(vm, one.id);
    await until(() => inspection.stats().loading === 1);
    await expect(inspection.summary(vm, two.id)).rejects.toMatchObject({ code: 'inspection_busy' });
    await expect(slow).rejects.toMatchObject({ code: 'archive_timeout' });
    w.sftp.readDelayMs = 0;
    await released(w);
  });
});

describe('Preview and download slots', () => {
  it('queue a short burst, refuse beyond the queue, and leave the queue when cancelled', async () => {
    const slots = new Slots(1, 'preview_busy', 2, 200);
    const first = await slots.take();
    const order: string[] = [];
    const second = slots.take().then((release) => {
      order.push('second');
      return release;
    });
    const leaving = new AbortController();
    const third = slots.take(leaving.signal);
    await expect(slots.take()).rejects.toMatchObject({ code: 'preview_busy' });
    leaving.abort();
    await expect(third).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(slots.queued).toBe(1);
    first();
    const releaseSecond = await second;
    expect(order).toEqual(['second']);
    // The slot was handed over: never more holders than slots.
    expect(slots.inUse).toBe(1);
    const late = slots.take();
    await expect(late).rejects.toMatchObject({ code: 'preview_busy' });
    releaseSecond();
    expect(slots.inUse).toBe(0);
  });
});
