/**
 * Browser-local archive reading (decision 0058): ZIP, ZIP64, TAR, OVA (including the 0057 endings), GZIP and TAR.GZ,
 * with every limit applied to actual bytes and every unsafe entry listed but never read.
 */
import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { crc32 } from '../../src/archive-local/bytes';
import { LocalArchive } from '../../src/archive-local/engine';
import { LocalArchiveError } from '../../src/archive-local/errors';
import { ArchiveHost } from '../../src/archive-local/host';
import { inflateBounded } from '../../src/archive-local/inflate';
import { DEFAULT_LOCAL_LIMITS, type LocalArchiveLimits } from '../../src/archive-local/limits';
import { Operation, unbounded } from '../../src/archive-local/operation';
import { PNG_1X1, PDF_MINIMAL, PPM_2X1, gzip, tar, text, zip } from './fixtures';

const limits = (overrides: Partial<LocalArchiveLimits> = {}): LocalArchiveLimits => ({
  ...DEFAULT_LOCAL_LIMITS,
  ...overrides,
});

const open = (bytes: Uint8Array, name = 'test.zip', overrides: Partial<LocalArchiveLimits> = {}) =>
  LocalArchive.open(bytes, name, limits(overrides), unbounded(), true);

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LocalArchiveError) return error.code;
    throw error;
  }
  throw new Error('Expected a failure');
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('ZIP', () => {
  it('lists files and directories, reads stored and deflated entries, and verifies CRC-32', async () => {
    const archive = await open(
      zip([
        { name: 'README.TXT', data: text('Hello from a nested ZIP\r\n') },
        { name: 'docs/', directory: true },
        { name: 'docs/manual.txt', data: text('Manual'), method: 0 },
      ]),
    );
    expect(archive.format).toBe('zip');
    expect(archive.index.entries.map((entry) => [entry.path, entry.type])).toEqual([
      ['README.TXT', 'file'],
      ['docs', 'directory'],
      ['docs/manual.txt', 'file'],
    ]);
    const readme = await archive.text(0, limits(), unbounded());
    expect(decode(readme.bytes)).toBe('Hello from a nested ZIP\r\n');
    expect(readme.integrity).toBe('verified');
    const manual = await archive.whole(2, 1024, 'download_too_large', unbounded());
    expect(decode(manual.data)).toBe('Manual');
    expect(manual.view).toBe(true);
  });

  it('reads ZIP64 end records and entry fields', async () => {
    const archive = await open(
      zip(
        [
          { name: 'big.bin', data: text('ZIP64 contents') },
          { name: 'b.txt', data: text('b') },
        ],
        {
          zip64: true,
        },
      ),
    );
    expect(archive.index.entries).toHaveLength(2);
    expect(decode((await archive.whole(0, 1024, 'download_too_large', unbounded())).data)).toBe(
      'ZIP64 contents',
    );
  });

  it('reads an empty archive', async () => {
    const archive = await open(zip([]));
    expect(archive.index.entries).toEqual([]);
  });

  it('decodes names without the UTF-8 flag as code page 437', async () => {
    const archive = await open(
      zip([
        {
          name: '',
          rawName: Uint8Array.from([0x80, 0x41, 0x2e, 0x54, 0x58, 0x54]),
          data: text('x'),
        },
      ]),
    );
    expect(archive.index.entries[0]?.path).toBe('ÇA.TXT');
  });

  it('fails a corrupt entry on its CRC-32, never returning its bytes', async () => {
    const archive = await open(zip([{ name: 'bad.txt', data: text('corrupt'), crc: 0x12345678 }]));
    expect(await code(archive.text(0, limits(), unbounded()))).toBe('integrity_failed');
    expect(await code(archive.whole(0, 1024, 'download_too_large', unbounded()))).toBe(
      'integrity_failed',
    );
  });

  it('lists encrypted, unsupported, linked and unsafe entries, and reads none of them', async () => {
    const archive = await open(
      zip([
        { name: 'secret.txt', data: text('x'), flags: 0x0801, method: 0 },
        { name: 'bzip2.bin', data: text('x'), method: 12 },
        { name: 'link', data: text('/etc/passwd'), mode: 0o120777, method: 0 },
        { name: '../escape.txt', data: text('x') },
        { name: '/etc/absolute', data: text('x') },
        { name: 'C:/drive.txt', data: text('x') },
        { name: 'dev', data: new Uint8Array(0), mode: 0o020644, method: 0 },
      ]),
    );
    const entries = archive.index.entries;
    expect(entries.map((entry) => entry.problem !== null)).toEqual(Array(7).fill(true));
    expect(entries[0]?.problem).toMatch(/encrypted/);
    expect(entries[1]?.problem).toMatch(/BZIP2/);
    expect(entries[2]?.type).toBe('link');
    expect(entries[3]?.unsafePath).toBe(true);
    expect(entries[3]?.path).toBe('../escape.txt');
    expect(entries[4]?.unsafePath).toBe(true);
    expect(entries[5]?.unsafePath).toBe(true);
    expect(entries[6]?.type).toBe('special');
    expect(await code(archive.text(0, limits(), unbounded()))).toBe('encrypted');
    expect(await code(archive.text(1, limits(), unbounded()))).toBe('unsupported_compression');
    for (const index of [2, 3, 4, 5, 6]) {
      expect(await code(archive.text(index, limits(), unbounded()))).toBe('entry_unreadable');
    }
    expect(archive.index.warnings.join(' ')).toMatch(/unsafe path/);
  });

  it('keeps duplicate paths as separate entries, each read by its own position', async () => {
    const archive = await open(
      zip([
        { name: 'same.txt', data: text('first') },
        { name: 'same.txt', data: text('second') },
      ]),
    );
    expect(archive.index.entries.map((entry) => entry.index)).toEqual([0, 1]);
    expect(decode((await archive.text(0, limits(), unbounded())).bytes)).toBe('first');
    expect(decode((await archive.text(1, limits(), unbounded())).bytes)).toBe('second');
    expect(archive.index.warnings.join(' ')).toMatch(/same path/);
  });

  it('refuses truncated, corrupted, multi-volume and over-large archives', async () => {
    const good = zip([{ name: 'a.txt', data: text('aaaa') }]);
    expect(await code(open(good.subarray(0, good.length - 5)))).toBe('malformed');
    const spanned = Uint8Array.from([0x50, 0x4b, 0x07, 0x08, ...good]);
    expect(await code(open(spanned))).toBe('multi_volume');
    const multiDisk = good.slice();
    multiDisk[multiDisk.length - 22 + 4] = 1;
    expect(await code(open(multiDisk))).toBe('multi_volume');
    expect(await code(open(good, 'a.zip', { maxArchiveBytes: 10 }))).toBe('archive_too_large');
    const many = zip(
      Array.from({ length: 30 }, (_, index) => ({ name: `f${index}`, data: text('x') })),
    );
    expect(await code(open(many, 'a.zip', { maxEntries: 20 }))).toBe('too_many_entries');
  });

  it('refuses a damaged local header and an entry that lies about its size', async () => {
    const good = zip([{ name: 'a.txt', data: text('aaaa'), method: 0 }]);
    const damaged = good.slice();
    damaged[30] = 0x58; // the local name no longer matches the central one
    const listed = await open(damaged);
    expect(listed.index.entries[0]?.problem).toMatch(/local header/);
    expect(await code(listed.text(0, limits(), unbounded()))).toBe('entry_unreadable');
    const deflated = zip([{ name: 'a.txt', data: text('aaaa') }]).slice();
    deflated[30] = 0x58;
    expect(await code((await open(deflated)).text(0, limits(), unbounded()))).toBe('malformed');
    const lying = await open(zip([{ name: 'a.txt', data: text('aaaa aaaa'), size: 4 }]));
    expect(await code(lying.whole(0, 1024, 'download_too_large', unbounded()))).toBe(
      'decompression_limit',
    );
  });

  it('stops a decompression bomb at the size it declares, and at the limit it is given', async () => {
    const bomb = new Uint8Array(32 * 1024 * 1024);
    const archive = await open(zip([{ name: 'bomb.bin', data: bomb }]));
    expect((archive.index.entries[0]?.compressedSizeBytes ?? 0) < 100_000).toBe(true);
    expect(await code(archive.whole(0, 1024 * 1024, 'download_too_large', unbounded()))).toBe(
      'download_too_large',
    );
    // A prefix decompresses only what it needs.
    const head = await archive.prefix(0, 4096, unbounded());
    expect(head.length).toBe(4096);
    // An entry that claims to be small and is not is stopped once it has produced what it claimed.
    const liar = await open(zip([{ name: 'liar.bin', data: bomb, size: 1000 }]));
    expect(await code(liar.whole(0, 1024 * 1024, 'download_too_large', unbounded()))).toBe(
      'decompression_limit',
    );
  });

  it('marks nested archives by signature when stored, and by name when compressed', async () => {
    const inner = zip([{ name: 'x.txt', data: text('x') }]);
    const archive = await open(
      zip([
        { name: 'stored.dat', data: inner, method: 0 },
        { name: 'deflated.zip', data: inner },
        { name: 'fake.zip', data: text('not an archive'), method: 0 },
        { name: 'disk.img', data: inner, method: 0 },
        {
          name: 'tools.7z',
          data: Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]),
          method: 0,
        },
      ]),
    );
    const [stored, deflated, fake, disk, sevenZip] = archive.index.entries;
    expect(stored?.archive).toEqual({ format: 'zip', by: 'signature' });
    expect(deflated?.archive).toEqual({ format: 'zip', by: 'name' });
    expect(fake?.archive).toBeNull();
    expect(disk?.archive).toBeNull();
    expect(sevenZip?.archive).toBeNull();
    expect(sevenZip?.unsupportedArchive).toBe('7z');
  });

  it('reads hex windows at any offset when stored, and within the seek limit when deflated', async () => {
    const data = Uint8Array.from({ length: 200_000 }, (_, index) => index % 251);
    const archive = await open(
      zip([
        { name: 'stored.bin', data, method: 0 },
        { name: 'deflated.bin', data },
      ]),
    );
    const window = await archive.range(0, 150_000, 16, limits(), unbounded());
    expect([...window.bytes]).toEqual([...data.subarray(150_000, 150_016)]);
    expect(window.integrity).toBe('partial');
    const inflated = await archive.range(1, 100_000, 16, limits(), unbounded());
    expect([...inflated.bytes]).toEqual([...data.subarray(100_000, 100_016)]);
    expect(
      await code(archive.range(1, 150_000, 16, limits({ maxSeekBytes: 100_000 }), unbounded())),
    ).toBe('offset_unsupported');
  });

  it('truncates text previews to the limit and says so', async () => {
    const archive = await open(zip([{ name: 'long.txt', data: text('x'.repeat(10_000)) }]));
    const preview = await archive.text(0, limits({ textBytes: 1000 }), unbounded());
    expect(preview.bytes.length).toBe(1000);
    expect(preview.truncated).toBe(true);
    expect(preview.integrity).toBe('partial');
  });
});

describe('TAR and OVA', () => {
  it('reads a TAR with directories, links and special files, reading only regular files', async () => {
    const archive = await open(
      tar([
        { name: 'dir/', type: '5' },
        { name: 'dir/INSTALL.TXT', data: text('Install me') },
        { name: 'hard', type: '1', linkName: 'dir/INSTALL.TXT' },
        { name: 'soft', type: '2', linkName: '/etc/passwd' },
        { name: 'fifo', type: '6' },
      ]),
      'files.tar',
    );
    expect(archive.format).toBe('tar');
    expect(archive.index.entries.map((entry) => [entry.path, entry.type])).toEqual([
      ['dir', 'directory'],
      ['dir/INSTALL.TXT', 'file'],
      ['hard', 'link'],
      ['soft', 'link'],
      ['fifo', 'special'],
    ]);
    const install = await archive.text(1, limits(), unbounded());
    expect(decode(install.bytes)).toBe('Install me');
    expect(install.integrity).toBe('complete');
    expect(await code(archive.text(2, limits(), unbounded()))).toBe('entry_unreadable');
  });

  it('reads an OVA that ends exactly at an entry boundary, without an end marker (decision 0057)', async () => {
    const files = [
      { name: 'vm.ovf', data: text('<Envelope/>') },
      { name: 'disk.vmdk', data: new Uint8Array(1024) },
      { name: 'vm.mf', data: text('SHA1(vm.ovf)= 00') },
    ];
    for (const end of [0, 1, 2] as const) {
      const archive = await open(tar(files, { end }), 'vm.ova');
      expect(archive.format).toBe('ova');
      expect(archive.index.entries.map((entry) => entry.name)).toEqual([
        'vm.ovf',
        'disk.vmdk',
        'vm.mf',
      ]);
      expect(archive.index.warnings).toEqual([]);
    }
  });

  it('refuses truncated TARs, damaged headers and data after the end marker', async () => {
    const good = tar([{ name: 'a.txt', data: text('a'.repeat(700)) }], { end: 0 });
    // Inside the data, inside the padding, inside a header.
    expect(await code(open(good.subarray(0, 800), 'a.tar'))).toBe('truncated');
    expect(await code(open(good.subarray(0, good.length - 10), 'a.tar'))).toBe('truncated');
    const withPartialHeader = Uint8Array.from([...good, ...new Uint8Array(100)]);
    expect(await code(open(withPartialHeader, 'a.tar'))).toBe('truncated');
    const damaged = good.slice();
    damaged[0] = 0x42;
    // Its checksum no longer matches: not a TAR header at all, so not read as one.
    expect(await code(open(damaged, 'a.tar'))).toBe('malformed');
    expect(await code(open(damaged, 'a.bin'))).toBe('unsupported_format');
    const ended = tar([{ name: 'a.txt', data: text('a') }], { end: 1 });
    const trailing = Uint8Array.from([...ended, ...tar([{ name: 'b.txt', data: text('b') }])]);
    expect(await code(open(trailing, 'a.tar'))).toBe('malformed');
    // A PAX header with no entry after it.
    const pax = tar([{ name: 'PaxHeader', type: 'x', data: text('16 path=abc.txt\n') }], {
      end: 0,
    });
    expect(await code(open(pax, 'a.tar'))).toBe('truncated');
  });

  it('warns about an OVA that is not flat or does not start with its descriptor', async () => {
    const archive = await open(
      tar([{ name: 'disk.vmdk', data: text('d') }, { name: 'dir/vm.ovf' }]),
      'odd.ova',
    );
    expect(archive.index.warnings.join(' ')).toMatch(/not flat/);
    expect(archive.index.warnings.join(' ')).toMatch(/OVF descriptor/);
  });
});

describe('GZIP', () => {
  it('opens a TAR.GZ as a TAR, and a single GZIP file as one entry', async () => {
    const tgz = await open(gzip(tar([{ name: 'README', data: text('inside tgz') }])), 'x.tgz');
    expect(tgz.format).toBe('tar.gz');
    expect(decode((await tgz.text(0, limits(), unbounded())).bytes)).toBe('inside tgz');
    const single = await open(gzip(text('just one file'), 'notes.txt'), 'notes.txt.gz');
    expect(single.format).toBe('gzip');
    expect(single.index.entries[0]?.name).toBe('notes.txt');
    const read = await single.text(0, limits(), unbounded());
    expect(decode(read.bytes)).toBe('just one file');
    expect(read.integrity).toBe('verified');
    const unnamed = await open(gzip(text('x')), 'config.sys.gz');
    expect(unnamed.index.entries[0]?.name).toBe('config.sys');
  });

  it('refuses a GZIP whose contents do not match its trailer, or that is larger than allowed', async () => {
    const good = gzip(text('hello hello hello'));
    const corrupt = good.slice();
    corrupt[corrupt.length - 8] = (corrupt[corrupt.length - 8] ?? 0) ^ 0xff;
    expect(await code(open(corrupt, 'a.gz'))).toBe('integrity_failed');
    const bomb = gzip(new Uint8Array(8 * 1024 * 1024));
    expect(await code(open(bomb, 'a.gz', { maxArchiveBytes: 1024 * 1024 }))).toBe(
      'archive_too_large',
    );
  });
});

describe('Detection', () => {
  it('decides by bytes: a ZIP named .tar is read as ZIP, text named .zip is refused', async () => {
    const archive = await open(zip([{ name: 'a', data: text('a') }]), 'wrong.tar');
    expect(archive.format).toBe('zip');
    expect(await code(open(text('not really a zip, just some text'.repeat(20)), 'fake.zip'))).toBe(
      'malformed',
    );
    expect(await code(open(text('plain'.repeat(200)), 'plain.bin'))).toBe('unsupported_format');
    const rar = Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, ...new Uint8Array(600)]);
    const error = await open(rar, 'x.rar').catch(
      (failure: unknown) => failure as LocalArchiveError,
    );
    expect((error as LocalArchiveError).code).toBe('unsupported_format');
    expect((error as LocalArchiveError).message).toMatch(/RAR/);
  });
});

describe('Previews', () => {
  it('decodes browser images by header and legacy images to pixels, within the pixel limit', async () => {
    const archive = await open(
      zip([
        { name: 'one.png', data: PNG_1X1 },
        { name: 'two.ppm', data: PPM_2X1 },
        { name: 'manual.pdf', data: PDF_MINIMAL },
      ]),
    );
    const png = await archive.image(0, limits(), unbounded());
    expect(png.image).toEqual({ format: 'png', width: 1, height: 1, converted: false });
    expect(png.contentType).toBe('image/png');
    const ppm = await archive.image(1, limits(), unbounded());
    expect(ppm.image).toEqual({ format: 'ppm', width: 2, height: 1, converted: true });
    expect([...(ppm.rgba?.data ?? [])]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
    expect(await code(archive.image(0, limits({ imagePixels: 0 }), unbounded()))).toBe(
      'image_too_large',
    );
    const details = await archive.details(2, limits(), unbounded());
    expect(details.modes).toEqual(['pdf', 'hex']);
    expect((await archive.pdf(2, limits(), unbounded())).integrity).toBe('verified');
  });

  it('describes text, Markdown and binary entries as the server does', async () => {
    const archive = await open(
      zip([
        { name: 'cfg.ini', data: text('[General]\nkey=value\n') },
        { name: 'README.md', data: text('# Title\n') },
        { name: 'bios.bin', data: Uint8Array.from({ length: 300 }, (_, index) => index % 256) },
      ]),
    );
    expect((await archive.details(0, limits(), unbounded())).modes).toEqual(['text', 'hex']);
    expect((await archive.details(1, limits(), unbounded())).modes).toEqual([
      'rendered',
      'text',
      'hex',
    ]);
    const binary = await archive.details(2, limits(), unbounded());
    expect(binary.detected.kind).toBe('binary');
    expect(binary.modes).toEqual(['hex']);
  });
});

describe('Bounded inflation', () => {
  it('produces exactly what is wanted and checks the end of a whole stream', async () => {
    const data = text('abc'.repeat(10_000));
    const compressed = deflateSync(data);
    const whole = await inflateBounded(compressed, {
      wanted: data.length,
      maxOutput: data.length,
      whole: true,
      operation: unbounded(),
    });
    expect(whole.crc32).toBe(crc32(data));
    expect(
      await code(
        inflateBounded(compressed.subarray(0, 20), {
          wanted: data.length,
          maxOutput: data.length,
          whole: true,
          operation: unbounded(),
        }),
      ),
    ).toBe('truncated');
  });

  it('stops when cancelled or late', async () => {
    const compressed = deflateSync(new Uint8Array(16 * 1024 * 1024));
    const cancelled = new Operation(60_000);
    cancelled.cancel();
    const options = { wanted: 16 * 1024 * 1024, maxOutput: 16 * 1024 * 1024, whole: true };
    expect(await code(inflateBounded(compressed, { ...options, operation: cancelled }))).toBe(
      'cancelled',
    );
    const late = new Operation(-1);
    expect(await code(inflateBounded(compressed, { ...options, operation: late }))).toBe('timeout');
  });
});

describe('Recursive archives and the cache', () => {
  const level3 = zip([{ name: 'extras/README.TXT', data: text('deepest') }]);
  const level2 = tar([
    { name: 'MOUSE.COM', data: text('MZ') },
    { name: 'extras.zip', data: level3 },
  ]);
  const level1 = zip([
    { name: 'README.TXT', data: text('top') },
    { name: 'drivers.tar', data: level2 },
  ]);

  it('opens archives inside archives, each from its parent, to the depth limit', async () => {
    const host = new ArchiveHost(limits());
    const first = await host.open({
      id: 'a',
      name: 'utilities.zip',
      bytes: level1,
      pinned: [],
      operation: unbounded(),
    });
    expect(first.depth).toBe(1);
    const second = await host.open({
      id: 'b',
      name: 'drivers.tar',
      parent: { id: 'a', entryIndex: 1 },
      pinned: [],
      operation: unbounded(),
    });
    expect(second.depth).toBe(2);
    expect(second.index.entries[1]?.archive).toEqual({ format: 'zip', by: 'signature' });
    const third = await host.open({
      id: 'c',
      name: 'extras.zip',
      parent: { id: 'b', entryIndex: 1 },
      pinned: [],
      operation: unbounded(),
    });
    expect(third.depth).toBe(3);
    const read = await host.read('c', 0, 'text', 0, unbounded());
    expect(decode(read.bytes)).toBe('deepest');

    const shallow = new ArchiveHost(limits({ maxDepth: 2 }));
    await shallow.open({
      id: 'a',
      name: 'u.zip',
      bytes: level1,
      pinned: [],
      operation: unbounded(),
    });
    await shallow.open({
      id: 'b',
      name: 'd.tar',
      parent: { id: 'a', entryIndex: 1 },
      pinned: [],
      operation: unbounded(),
    });
    expect(
      await code(
        shallow.open({
          id: 'c',
          name: 'e.zip',
          parent: { id: 'b', entryIndex: 1 },
          pinned: [],
          operation: unbounded(),
        }),
      ),
    ).toBe('depth_limit');
  });

  it('refuses a recursive archive bomb: a ZIP that contains itself, level after level', async () => {
    let bomb = zip([{ name: 'x', data: text('x') }]);
    for (let level = 0; level < 8; level += 1) bomb = zip([{ name: 'again.zip', data: bomb }]);
    const host = new ArchiveHost(limits());
    await host.open({
      id: 'l1',
      name: 'bomb.zip',
      bytes: bomb,
      pinned: [],
      operation: unbounded(),
    });
    let parent = 'l1';
    let failure = '';
    for (let level = 2; level <= 10 && !failure; level += 1) {
      const id = `l${level}`;
      failure = await host
        .open({
          id,
          name: 'again.zip',
          parent: { id: parent, entryIndex: 0 },
          pinned: [],
          operation: unbounded(),
        })
        .then(() => '')
        .catch((error: LocalArchiveError) => error.code);
      parent = id;
    }
    expect(failure).toBe('depth_limit');
    expect(host.stats().archives).toBe(5);
  });

  it('evicts the least recently used branch, with its descendants, and never what is in use', async () => {
    const payload = (seed: number) =>
      zip([
        {
          name: 'data.bin',
          data: Uint8Array.from({ length: 40_000 }, (_, i) => (i * seed) % 256),
          method: 0,
        },
      ]);
    const host = new ArchiveHost(limits({ cacheBytes: 100_000 }));
    await host.open({
      id: 'a',
      name: 'a.zip',
      bytes: payload(3),
      pinned: [],
      operation: unbounded(),
    });
    await host.open({
      id: 'b',
      name: 'b.zip',
      bytes: payload(5),
      pinned: [],
      operation: unbounded(),
    });
    const third = await host.open({
      id: 'c',
      name: 'c.zip',
      bytes: payload(7),
      pinned: ['a'],
      operation: unbounded(),
    });
    expect(third.evicted).toEqual(['b']);
    expect(host.has('a')).toBe(true);
    expect(host.stats().retainedBytes).toBeLessThanOrEqual(100_000);
    expect(await code(host.read('b', 0, 'text', 0, unbounded()))).toBe('evicted');
    // Nothing can be evicted: the new archive is refused, and what is in use stays.
    expect(
      await code(
        host.open({
          id: 'd',
          name: 'd.zip',
          bytes: payload(9),
          pinned: ['a', 'c'],
          operation: unbounded(),
        }),
      ),
    ).toBe('memory_budget');
    expect(host.has('a') && host.has('c')).toBe(true);
    expect(host.has('d')).toBe(false);
  });

  it('releases a parent with every archive opened inside it', async () => {
    const host = new ArchiveHost(limits());
    await host.open({ id: 'a', name: 'u.zip', bytes: level1, pinned: [], operation: unbounded() });
    await host.open({
      id: 'b',
      name: 'd.tar',
      parent: { id: 'a', entryIndex: 1 },
      pinned: [],
      operation: unbounded(),
    });
    await host.open({
      id: 'c',
      name: 'e.zip',
      parent: { id: 'b', entryIndex: 1 },
      pinned: [],
      operation: unbounded(),
    });
    expect(host.release('a').sort()).toEqual(['a', 'b', 'c']);
    expect(host.stats()).toMatchObject({ archives: 0, retainedBytes: 0 });
  });

  it('counts a stored nested archive as a view of its parent, and a deflated one as its own copy', async () => {
    const inner = zip([{ name: 'x.txt', data: text('x'.repeat(5000)) }]);
    const outer = zip([
      { name: 'stored.zip', data: inner, method: 0 },
      { name: 'deflated.zip', data: inner },
    ]);
    const host = new ArchiveHost(limits());
    await host.open({ id: 'o', name: 'o.zip', bytes: outer, pinned: [], operation: unbounded() });
    const before = host.stats().retainedBytes;
    await host.open({
      id: 's',
      name: 'stored.zip',
      parent: { id: 'o', entryIndex: 0 },
      pinned: [],
      operation: unbounded(),
    });
    const afterStored = host.stats().retainedBytes;
    expect(afterStored - before).toBeLessThan(1000);
    await host.open({
      id: 'd',
      name: 'deflated.zip',
      parent: { id: 'o', entryIndex: 1 },
      pinned: [],
      operation: unbounded(),
    });
    expect(host.stats().retainedBytes - afterStored).toBeGreaterThanOrEqual(inner.length);
  });
});
