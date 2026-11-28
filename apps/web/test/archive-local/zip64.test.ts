/**
 * ZIP64 in the browser-local reader (decision 0061, applied to decision 0058's nested archives). Every case mirrors
 * one of the server's (apps/api/test/zip64.test.ts) so the two readers cannot drift apart: each fixed field that is
 * 0xFFFFFFFF is resolved over every ZIP64 record of its central record, a placeholder yields to a real value, equal
 * values agree, and contradictions, truncations and out-of-range values are refused. The browser's own, smaller
 * limits still apply to whatever the records resolve to.
 */
import { describe, expect, it } from 'vitest';
import { LocalArchive } from '../../src/archive-local/engine';
import { LocalArchiveError } from '../../src/archive-local/errors';
import { ArchiveHost } from '../../src/archive-local/host';
import { DEFAULT_LOCAL_LIMITS, type LocalArchiveLimits } from '../../src/archive-local/limits';
import { unbounded } from '../../src/archive-local/operation';
import {
  extraField,
  text,
  zip,
  zip64Data,
  zip64Layout,
  type Zip64Fields,
  type Zip64LayoutEntry,
} from './fixtures';

const limits = (overrides: Partial<LocalArchiveLimits> = {}): LocalArchiveLimits => ({
  ...DEFAULT_LOCAL_LIMITS,
  ...overrides,
});

const open = (bytes: Uint8Array, overrides: Partial<LocalArchiveLimits> = {}) =>
  LocalArchive.open(bytes, 'test.zip', limits(overrides), unbounded(), true);

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
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

async function readAll(bytes: Uint8Array): Promise<string[]> {
  const archive = await open(bytes);
  const out: string[] = [];
  for (const entry of archive.index.entries) {
    const read = await archive.whole(entry.index, 1 * MiB, 'download_too_large', unbounded());
    expect(read.integrity).toBe('verified');
    out.push(decode(read.data));
  }
  return out;
}

const README = text('Utilities for DOS 6.22\r\n'.repeat(20));
const MOUSE = text('MOUSE.COM driver bytes');

/** The agent's layout (decision 0061): a stored and a deflated entry, each with a placeholder record, then the real. */
const agentArchive = (extra: Partial<Zip64LayoutEntry> = {}, end64 = false) =>
  zip64Layout(
    [
      { name: 'README.TXT', data: README, method: 8, ...extra },
      { name: 'MOUSE.COM', data: MOUSE, method: 0, ...extra },
    ],
    { end64 },
  );

describe('valid ZIP64 layouts', () => {
  it('reads an ordinary ZIP32 archive as before', async () => {
    const bytes = zip64Layout([
      { name: 'a.txt', data: text('stored'), method: 0, zip64: false },
      { name: 'b.txt', data: text('deflated'), zip64: false },
    ]);
    expect(await readAll(bytes)).toEqual(['stored', 'deflated']);
  });

  it('reads a standard archive with one ZIP64 record per entry and ZIP64 end records', async () => {
    const bytes = zip64Layout(
      [
        {
          name: 'a.txt',
          data: text('one record'),
          zip64: { fields: { offset: true }, records: 'single' },
        },
        {
          name: 'b.txt',
          data: text('second'),
          zip64: { fields: { offset: true }, records: 'single' },
        },
      ],
      { end64: true },
    );
    expect(await readAll(bytes)).toEqual(['one record', 'second']);
  });

  it('takes the real sizes after the agent’s placeholder record, stored and deflated (F-4)', async () => {
    for (const end64 of [false, true]) {
      const archive = await open(agentArchive({}, end64));
      const [readme, mouse] = archive.index.entries;
      expect(readme?.sizeBytes).toBe(README.length);
      expect(readme?.method).toBe('deflated');
      expect((readme?.compressedSizeBytes ?? 0) < README.length).toBe(true);
      expect(mouse?.sizeBytes).toBe(MOUSE.length);
      expect(mouse?.compressedSizeBytes).toBe(MOUSE.length);
      expect(mouse?.method).toBe('stored');
      expect(readme?.problem).toBeNull();
      expect(mouse?.problem).toBeNull();
      expect(await readAll(agentArchive({}, end64))).toEqual([decode(README), decode(MOUSE)]);
    }
  });

  it('takes real sizes and offsets after the agent’s placeholder', async () => {
    const bytes = agentArchive({ zip64: { fields: { offset: true } } }, true);
    expect(await readAll(bytes)).toEqual([decode(README), decode(MOUSE)]);
  });

  it('reads an archive whose only ZIP64 field is the offset, in one record or the agent’s two', async () => {
    for (const records of ['single', 'agent'] as const) {
      const bytes = agentArchive({
        zip64: { fields: { uncompressed: false, compressed: false, offset: true }, records },
      });
      expect(await readAll(bytes)).toEqual([decode(README), decode(MOUSE)]);
    }
  });

  it('accepts every combination of fields in ZIP64, one record or the agent’s two', async () => {
    const flags = [false, true];
    let combinations = 0;
    for (const uncompressed of flags) {
      for (const compressed of flags) {
        for (const offset of flags) {
          const fields: Zip64Fields = { uncompressed, compressed, offset };
          if (!uncompressed && !compressed && !offset) continue;
          for (const records of ['single', 'agent'] as const) {
            const archive = await open(agentArchive({ zip64: { fields, records } }));
            expect(archive.index.entries.map((entry) => entry.sizeBytes)).toEqual([
              README.length,
              MOUSE.length,
            ]);
            expect(await readAll(agentArchive({ zip64: { fields, records } }))).toEqual([
              decode(README),
              decode(MOUSE),
            ]);
            combinations += 1;
          }
        }
      }
    }
    expect(combinations).toBe(14);
  });

  it('accepts the same real values repeated, and ignores bytes after the fields a record must hold', async () => {
    const data = text('repeated');
    const real = (stored: number) => zip64Data(data.length, stored, 0);
    const stored = zip64Layout([{ name: 'a.txt', data, method: 0 }]);
    expect(await readAll(stored)).toEqual(['repeated']);
    const repeated = zip64Layout([
      {
        name: 'a.txt',
        data,
        method: 0,
        zip64: {
          fields: { offset: true },
          records: [real(data.length), real(data.length), real(data.length)],
        },
      },
    ]);
    expect(await readAll(repeated)).toEqual(['repeated']);
    // A trailing disk number (4 bytes) after the three values, as some writers add.
    const withDisk = zip64Layout([
      {
        name: 'a.txt',
        data,
        method: 0,
        zip64: {
          fields: { offset: true },
          records: [
            Uint8Array.from([...zip64Data(0xffffffff, 0xffffffff, 0), 0, 0, 0, 0]),
            Uint8Array.from([...real(data.length), 0, 0, 0, 0]),
          ],
        },
      },
    ]);
    expect(await readAll(withDisk)).toEqual(['repeated']);
  });

  it('keeps unknown extra fields before and after the ZIP64 records out of the resolution', async () => {
    const timestamp = extraField(0x5455, [1, 0x00, 0x00, 0x00, 0x60]);
    const unix = extraField(0x7875, [1, 4, 0xe8, 0x03, 0, 0, 4, 0xe8, 0x03, 0, 0]);
    // An unknown record that looks like a ZIP64 value is never taken as one.
    const decoy = extraField(0x9999, zip64Data(0x1234, 0x5678));
    const bytes = agentArchive({
      extraBefore: timestamp,
      extraAfter: new Uint8Array([...unix, ...decoy]),
    });
    expect(await readAll(bytes)).toEqual([decode(README), decode(MOUSE)]);
  });
});

describe('malformed and contradictory ZIP64 records', () => {
  it('refuses an entry that needs ZIP64 and has no record', async () => {
    expect(await code(open(agentArchive({ zip64: { records: 'none' } })))).toBe('malformed');
    // A ZIP64 record that is not needed is not read, as before.
    expect(
      await readAll(
        agentArchive({
          zip64: { fields: { uncompressed: false, compressed: false }, records: [zip64Data(1)] },
        }),
      ),
    ).toEqual([decode(README), decode(MOUSE)]);
  });

  it('refuses a record shorter than the fields it must hold, first or second', async () => {
    const data = text('short');
    const full = zip64Data(data.length, data.length);
    for (const records of [
      [zip64Data(0xffffffff), full],
      [full, zip64Data(data.length)],
      [new Uint8Array(0), full],
      [full, new Uint8Array(15)],
    ]) {
      expect(
        await code(open(zip64Layout([{ name: 'a.txt', data, method: 0, zip64: { records } }]))),
      ).toBe('malformed');
    }
  });

  it('refuses an extra field whose framing runs past its end', async () => {
    const data = text('framing');
    const record = extraField(1, zip64Data(data.length, data.length));
    for (const centralExtra of [
      record.subarray(0, record.length - 1),
      Uint8Array.from([...record, 0x55, 0x54, 0x09, 0x00, 1]),
      Uint8Array.from([0x55, 0x54, 0x40, 0x00, ...record]),
    ]) {
      expect(
        await code(open(zip64Layout([{ name: 'a.txt', data, method: 0, centralExtra }]))),
      ).toBe('malformed');
    }
  });

  it('refuses records that give two different real values, whichever comes first', async () => {
    const data = text('contradiction');
    const real = zip64Data(data.length, data.length);
    const other = zip64Data(data.length + 1, data.length);
    for (const records of [
      [real, other],
      [other, real],
      [zip64Data(0xffffffff, 0xffffffff), real, other],
    ]) {
      expect(
        await code(open(zip64Layout([{ name: 'a.txt', data, method: 0, zip64: { records } }]))),
      ).toBe('malformed');
    }
    // A contradiction in the offset alone.
    const offsetOnly = { uncompressed: false, compressed: false, offset: true };
    expect(
      await code(
        open(
          zip64Layout([
            {
              name: 'a.txt',
              data,
              method: 0,
              zip64: { fields: offsetOnly, records: [zip64Data(0), zip64Data(1)] },
            },
          ]),
        ),
      ),
    ).toBe('malformed');
  });

  it('never reads an unresolved compressed size placeholder as 4 GiB of data', async () => {
    const data = text('unresolved');
    const placeholder = zip64Data(0xffffffff, 0xffffffff);
    expect(
      await code(
        open(
          zip64Layout([
            { name: 'a.txt', data, method: 0, zip64: { records: [placeholder, placeholder] } },
          ]),
        ),
      ),
    ).toBe('malformed');
  });

  it('refuses a resolved offset or compressed size that does not fit the archive', async () => {
    const data = text('bounds');
    const offsetOnly = { uncompressed: false, compressed: false, offset: true };
    // Beyond the archive.
    expect(
      await code(
        open(
          zip64Layout([
            {
              name: 'a.txt',
              data,
              method: 0,
              zip64: { fields: offsetOnly, records: [zip64Data(10 * MiB)] },
            },
          ]),
        ),
      ),
    ).toBe('malformed');
    // Within the archive, but not where a local header is: listed and marked, never read.
    const misplaced = await open(
      zip64Layout([
        {
          name: 'a.txt',
          data,
          method: 0,
          zip64: { fields: offsetOnly, records: [zip64Data(0xffffffff), zip64Data(1)] },
        },
        {
          name: 'b.txt',
          data,
          zip64: { fields: offsetOnly, records: [zip64Data(0xffffffff), zip64Data(1)] },
        },
      ]),
    );
    expect(misplaced.index.entries[0]?.problem).toMatch(/local header/);
    expect(await code(misplaced.whole(0, MiB, 'download_too_large', unbounded()))).toBe(
      'entry_unreadable',
    );
    expect(await code(misplaced.whole(1, MiB, 'download_too_large', unbounded()))).toBe(
      'malformed',
    );
    // A compressed size that runs into the central directory.
    expect(
      await code(open(zip64Layout([{ name: 'a.txt', data, real: { compressed: 4096 } }]))),
    ).toBe('malformed');
  });

  it('refuses values beyond what can be represented, even in a placeholder record', async () => {
    const data = text('too large');
    const real = zip64Data(data.length, data.length);
    for (const records of [
      [zip64Data(2n ** 53n, data.length)],
      [real, zip64Data(data.length, 0xffffffffffffffffn)],
      [zip64Data(2n ** 60n, 0xffffffff), real],
    ]) {
      expect(
        await code(open(zip64Layout([{ name: 'a.txt', data, method: 0, zip64: { records } }]))),
      ).toBe('malformed');
    }
  });

  it('fails a ZIP64 entry on its CRC-32, stored or deflated', async () => {
    const archive = await open(agentArchive({ crc: 0x0badf00d }));
    expect(await code(archive.whole(0, MiB, 'download_too_large', unbounded()))).toBe(
      'integrity_failed',
    );
    expect(await code(archive.whole(1, MiB, 'download_too_large', unbounded()))).toBe(
      'integrity_failed',
    );
  });

  it('lists a ZIP64 entry with an unsupported method and reads none of it', async () => {
    const archive = await open(
      zip64Layout([{ name: 'a.bz2data', data: text('BZh9'), method: 12 }]),
    );
    expect(archive.index.entries[0]?.problem).toMatch(/BZIP2/);
    expect(await code(archive.whole(0, MiB, 'download_too_large', unbounded()))).toBe(
      'unsupported_compression',
    );
  });
});

describe('browser-local limits on resolved ZIP64 values', () => {
  /** 1 MiB of zeros deflates to about 1 KiB. */
  const zeros = new Uint8Array(MiB);

  it('lists a small archive that declares a 5 GiB entry, previews its start, and refuses to read it whole', async () => {
    const archive = await open(
      zip64Layout([{ name: 'disk.raw', data: zeros, real: { uncompressed: 5 * GiB } }]),
    );
    const entry = archive.index.entries[0];
    expect(entry?.sizeBytes).toBe(5 * GiB);
    expect((entry?.compressedSizeBytes ?? 0) < 10_000).toBe(true);
    // Refused on the declared size, before anything is decompressed or allocated.
    expect(await code(archive.whole(0, 100 * MiB, 'download_too_large', unbounded()))).toBe(
      'download_too_large',
    );
    // Only what a preview needs is decompressed.
    expect((await archive.prefix(0, 4096, unbounded())).length).toBe(4096);
    const window = await archive.range(0, 0, 64, limits(), unbounded());
    expect(window.bytes.length).toBe(64);
    expect(window.totalBytes).toBe(5 * GiB);
    expect(await code(archive.range(0, 32 * MiB, 64, limits(), unbounded()))).toBe(
      'offset_unsupported',
    );
  });

  it('treats a real value of 0xFFFFFFFF as a size, which the browser then refuses to read whole', async () => {
    const placeholder = zip64Data(0xffffffff);
    const archive = await open(
      zip64Layout([
        {
          name: 'exact.bin',
          data: zeros,
          zip64: { fields: { compressed: false }, records: [placeholder, placeholder] },
        },
      ]),
    );
    expect(archive.index.entries[0]?.sizeBytes).toBe(0xffffffff);
    expect(await code(archive.whole(0, 100 * MiB, 'download_too_large', unbounded()))).toBe(
      'download_too_large',
    );
  });

  it('stops an entry whose ZIP64 size is smaller than what it decompresses to', async () => {
    for (const records of [undefined, 'single'] as const) {
      const archive = await open(
        zip64Layout([
          { name: 'liar.bin', data: zeros, real: { uncompressed: 1000 }, zip64: { records } },
        ]),
      );
      expect(archive.index.entries[0]?.sizeBytes).toBe(1000);
      expect(await code(archive.whole(0, 100 * MiB, 'download_too_large', unbounded()))).toBe(
        'decompression_limit',
      );
    }
  });

  it('opens a nested ZIP64 archive within the size and memory limits only', async () => {
    const inner = agentArchive();
    const outerFor = (data: Uint8Array, real?: { uncompressed: number }) =>
      zip64Layout([{ name: 'inner.zip', data, real }]);

    // A nested archive that declares more than the browser opens is refused before it is decompressed.
    const big = new ArchiveHost(limits());
    await big.open({
      id: 'a',
      name: 'outer.zip',
      bytes: outerFor(zeros, { uncompressed: 5 * GiB }),
      pinned: [],
      operation: unbounded(),
    });
    expect(
      await code(
        big.open({
          id: 'b',
          name: 'inner.zip',
          parent: { id: 'a', entryIndex: 0 },
          pinned: [],
          operation: unbounded(),
        }),
      ),
    ).toBe('archive_too_large');

    // Below the archive limit the browser is given, but above it in what it would decompress to.
    const small = new ArchiveHost(limits({ maxArchiveBytes: 64 * 1024 }));
    await small.open({
      id: 'a',
      name: 'outer.zip',
      bytes: outerFor(zeros, { uncompressed: 1000 }),
      pinned: [],
      operation: unbounded(),
    });
    expect(
      await code(
        small.open({
          id: 'b',
          name: 'inner.zip',
          parent: { id: 'a', entryIndex: 0 },
          pinned: [],
          operation: unbounded(),
        }),
      ),
    ).toBe('decompression_limit');

    // A top-level nested archive larger than the browser opens.
    expect(
      await code(
        new ArchiveHost(limits({ maxArchiveBytes: 100 })).open({
          id: 'a',
          name: 'outer.zip',
          bytes: inner,
          pinned: [],
          operation: unbounded(),
        }),
      ),
    ).toBe('archive_too_large');

    // A deflated nested ZIP64 archive is a copy, counted against the memory budget.
    const padded = zip64Layout([
      {
        name: 'data.bin',
        data: Uint8Array.from({ length: 150_000 }, (_, i) => (i * 7) % 256),
        method: 0,
      },
    ]);
    const tight = new ArchiveHost(limits({ cacheBytes: 120_000 }));
    await tight.open({
      id: 'a',
      name: 'outer.zip',
      bytes: outerFor(padded),
      pinned: [],
      operation: unbounded(),
    });
    expect(
      await code(
        tight.open({
          id: 'b',
          name: 'inner.zip',
          parent: { id: 'a', entryIndex: 0 },
          pinned: [],
          operation: unbounded(),
        }),
      ),
    ).toBe('memory_budget');
    expect(tight.stats().archives).toBe(1);
  });

  it('stops nested ZIP64 archives at the depth limit', async () => {
    let bomb = agentArchive();
    for (let level = 0; level < 7; level += 1) {
      bomb = zip64Layout([{ name: 'again.zip', data: bomb, method: level % 2 === 0 ? 0 : 8 }]);
    }
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

  it('refuses malformed ZIP64 sizes while listing, before any entry is read', async () => {
    // A compressed size of 1 TiB cannot fit a nested archive: refused by the bounds check, nothing is allocated.
    expect(
      await code(
        open(zip64Layout([{ name: 'a.bin', data: zeros, real: { compressed: 2 ** 40 } }])),
      ),
    ).toBe('malformed');
    // A declared 2^52 bytes is a size the browser lists and never reads whole.
    const archive = await open(
      zip64Layout([{ name: 'a.bin', data: zeros, real: { uncompressed: 2 ** 52 } }]),
    );
    expect(await code(archive.whole(0, 100 * MiB, 'download_too_large', unbounded()))).toBe(
      'download_too_large',
    );
  });
});

describe('nested ZIP64 archives', () => {
  it('opens a ZIP64 archive with the agent’s records inside an ordinary ZIP and inside a ZIP64 one', async () => {
    const inner = agentArchive({ zip64: { fields: { offset: true } } }, true);
    for (const outer of [
      zip([{ name: 'drivers.zip', data: inner }]),
      zip([{ name: 'drivers.zip', data: inner, method: 0 }]),
      zip64Layout([{ name: 'drivers.zip', data: inner }]),
      zip64Layout(
        [{ name: 'drivers.zip', data: inner, method: 0, zip64: { fields: { offset: true } } }],
        { end64: true },
      ),
    ]) {
      const host = new ArchiveHost(limits());
      await host.open({
        id: 'a',
        name: 'utilities.zip',
        bytes: outer,
        pinned: [],
        operation: unbounded(),
      });
      const nested = await host.open({
        id: 'b',
        name: 'drivers.zip',
        parent: { id: 'a', entryIndex: 0 },
        pinned: [],
        operation: unbounded(),
      });
      expect(nested.depth).toBe(2);
      expect(nested.index.entries.map((entry) => entry.path)).toEqual(['README.TXT', 'MOUSE.COM']);
      const read = await host.read('b', 0, 'text', 0, unbounded());
      expect(decode(read.bytes)).toBe(decode(README));
      expect(read.integrity).toBe('verified');
      const saved = await host.download('b', 1, unbounded());
      expect(decode(saved.data)).toBe(decode(MOUSE));
    }
  });
});
