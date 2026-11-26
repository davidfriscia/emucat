/**
 * How an OVA's TAR ends (decision 0057). The server reads an OVA as the agent's import does (decision 0049, M6.1.1):
 * after a zero block, or exactly at the end of the last entry's padding with no end marker, as VirtualBox writes
 * some exports (a real Xenix 386 OVA from VirtualBox 7.1.10 ends this way). Every other ending is refused: a cut in a
 * header, in a file's data or in its padding, an extended header with nothing after it, a partial block, data after
 * an empty header. No database is needed: sources are in memory and count every byte read.
 *
 * An optional check against a real OVA runs when EMUCAT_OVA_FIXTURE names one; it is skipped otherwise.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { entryChunks, readEntry, type TarLocator } from '../src/archives/extract.js';
import { checkOvaLayout, readTar, TarFormatError, type TarEntry } from '../src/archives/tar.js';
import { openLocal } from '../src/archives/zip.js';
import { bufferSource } from './archive-sources.js';
import { buildTar, tarHeader } from './zip-builder.js';

const descriptor = Buffer.from('<?xml version="1.0"?>\n<Envelope ovf:version="1.0"/>\n');
const disk = Buffer.from(Array.from({ length: 512 * 40 }, (_, index) => (index * 31) % 251));
const manifest = Buffer.from('SHA1 (Xenix 386.ovf) = 00\nSHA1 (Xenix 386-disk001.vmdk) = 00\n');

/** The Xenix layout: descriptor, a disk of whole blocks (no padding), a short manifest last. */
const terminated = buildTar([
  ['Xenix 386.ovf', descriptor],
  ['Xenix 386-disk001.vmdk', disk],
  ['Xenix 386.mf', manifest],
]);
/** The same archive as VirtualBox wrote it: no end marker, the file ends with the manifest's padding. */
const unterminated = terminated.subarray(0, terminated.length - 1024);

const withTail = (tail: Buffer) => Buffer.concat([unterminated, tail]);

async function refusal(bytes: Buffer): Promise<string> {
  try {
    await readTar(bufferSource(bytes));
  } catch (error) {
    if (error instanceof TarFormatError && error.kind === 'malformed') return error.message;
    throw error;
  }
  throw new Error('accepted');
}

/** A PAX record is "<length> <key>=<value>\n", the length counting its own digits. */
function paxRecord(key: string, value: string): string {
  const line = ` ${key}=${value}\n`;
  let length = line.length + 1;
  while (String(length).length + line.length !== length)
    length = String(length).length + line.length;
  return `${length}${line}`;
}

/** An extended header (PAX 'x' or 'g', GNU 'L') and its data, padded. */
function extended(type: 'x' | 'g' | 'L', body: Buffer): Buffer {
  return Buffer.concat([
    tarHeader('ext', body.length, type),
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
}

const names = (entries: TarEntry[]) => entries.map((entry) => entry.name);

describe('TAR termination', () => {
  it('accepts the canonical end marker of two zero blocks', async () => {
    expect(names(await readTar(bufferSource(terminated)))).toEqual([
      'Xenix 386.ovf',
      'Xenix 386-disk001.vmdk',
      'Xenix 386.mf',
    ]);
  });

  it('accepts an archive that ends exactly after its last entry, as VirtualBox writes them', async () => {
    expect(unterminated.length % 512).toBe(0);
    const source = bufferSource(unterminated);
    const entries = await readTar(source);
    expect(entries).toEqual(await readTar(bufferSource(terminated)));
    checkOvaLayout(entries);
    // Offsets are exact: header, data, header, data, header, data.
    expect(entries.map((entry) => [entry.dataOffset, entry.sizeBytes])).toEqual([
      [512, descriptor.length],
      [1536, disk.length],
      [1536 + disk.length + 512, manifest.length],
    ]);
    // Three headers, and nothing else: no data, and nothing past the end.
    expect(source.reads).toEqual([
      [0, 512],
      [1024, 512],
      [1536 + disk.length, 512],
    ]);
    expect(source.bytesRead).toBe(1536);
  });

  it('accepts a single zero block, and more zero padding than two blocks', async () => {
    expect(await readTar(bufferSource(withTail(Buffer.alloc(512))))).toHaveLength(3);
    // GNU tar pads to a 10 KiB record.
    expect(await readTar(bufferSource(withTail(Buffer.alloc(512 * 20))))).toHaveLength(3);
  });

  it('accepts a last entry that needs no padding, at the very end of the file', async () => {
    const bytes = buildTar([
      ['a.ovf', descriptor],
      ['a.vmdk', disk],
    ]);
    const entries = await readTar(bufferSource(bytes.subarray(0, bytes.length - 1024)));
    expect(entries.at(-1)?.sizeBytes).toBe(disk.length);
  });

  it('reads an empty archive as no entries, and refuses an empty file', async () => {
    expect(await readTar(bufferSource(Buffer.alloc(1024)))).toEqual([]);
    expect(await readTar(bufferSource(Buffer.alloc(512)))).toEqual([]);
    expect(await refusal(Buffer.alloc(0))).toMatch(/too small/);
    expect(await refusal(Buffer.alloc(100))).toMatch(/too small/);
  });

  it('refuses an archive cut anywhere but at an entry boundary', async () => {
    const entries = await readTar(bufferSource(unterminated));
    const last = entries[2] as TarEntry;
    const lastHeader = last.dataOffset - 512;
    const diskData = (entries[1] as TarEntry).dataOffset;
    const cases: Array<[number, RegExp]> = [
      [lastHeader + 100, /middle of a header/],
      [lastHeader + 511, /middle of a header/],
      [diskData + 1000, /middle of a file/],
      [last.dataOffset + last.sizeBytes - 1, /middle of a file/],
      [last.dataOffset + last.sizeBytes, /padding/],
      [unterminated.length - 1, /padding/],
      [1, /too small/],
    ];
    for (const [cut, message] of cases) {
      expect(await refusal(unterminated.subarray(0, cut)), `cut at ${cut}`).toMatch(message);
    }
    // Cut exactly after the disk, the archive is complete with two entries: the manifest is simply not there.
    expect(names(await readTar(bufferSource(unterminated.subarray(0, lastHeader))))).toEqual([
      'Xenix 386.ovf',
      'Xenix 386-disk001.vmdk',
    ]);
  });

  it('refuses an entry that declares more bytes than the file holds', async () => {
    const header = tarHeader('big.vmdk', 1_000_000);
    expect(await refusal(Buffer.concat([header, Buffer.alloc(4096)]))).toMatch(/middle of a file/);
    // In base-256, as GNU tar writes sizes of 8 GiB and more.
    const huge = Buffer.from(header);
    huge.fill(0, 124, 136);
    huge[124] = 0x80;
    huge.writeUIntBE(2 ** 40, 130, 6);
    huge.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of huge) sum += byte;
    huge.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    expect(await refusal(Buffer.concat([huge, Buffer.alloc(1024)]))).toMatch(/middle of a file/);
    // A PAX size is checked against the file too, not only the header's.
    const paxed = Buffer.concat([
      extended('x', Buffer.from(paxRecord('size', String(10 * 1024 * 1024)))),
      tarHeader('big.vmdk', 0),
      Buffer.alloc(1024),
    ]);
    expect(await refusal(paxed)).toMatch(/middle of a file/);
  });

  it('refuses partial blocks, data after an empty header, and damaged headers', async () => {
    expect(await refusal(withTail(Buffer.alloc(100)))).toMatch(/middle of a header/);
    expect(await refusal(withTail(tarHeader('next.vmdk', 10).subarray(0, 300)))).toMatch(
      /middle of a header/,
    );
    // Not a header: its checksum field is not even a number.
    expect(await refusal(withTail(Buffer.alloc(512, 0x41)))).toMatch(/checksum|invalid number/);
    expect(
      await refusal(withTail(Buffer.concat([Buffer.alloc(512), Buffer.alloc(512, 0x41)]))),
    ).toMatch(/data after an empty header/);
    const damaged = Buffer.from(tarHeader('next.vmdk', 0));
    damaged.writeUInt8((damaged[0] as number) ^ 0x20, 0);
    expect(await refusal(withTail(damaged))).toMatch(/checksum/);
    const firstDamaged = Buffer.from(unterminated);
    firstDamaged.writeUInt8((firstDamaged[10] as number) ^ 0x01, 10);
    expect(await refusal(firstDamaged)).toMatch(/checksum/);
  });

  it('refuses an extended header with no entry after it, with or without an end marker', async () => {
    const pax = extended('x', Buffer.from(paxRecord('path', 'next.vmdk')));
    expect(await refusal(withTail(pax))).toMatch(/after an extended header/);
    expect(await refusal(withTail(Buffer.concat([pax, Buffer.alloc(1024)])))).toMatch(
      /inside an extended header/,
    );
    const gnu = extended('L', Buffer.from('next.vmdk\0'));
    expect(await refusal(withTail(gnu))).toMatch(/after an extended header/);
  });

  it('reads PAX and GNU long names, and global PAX headers that set neither path nor size', async () => {
    const long = `${'x'.repeat(150)}.vmdk`;
    const bytes = Buffer.concat([
      unterminated,
      extended('g', Buffer.from(paxRecord('comment', 'exported'))),
      extended('x', Buffer.from(paxRecord('path', long))),
      tarHeader('ignored', 3),
      Buffer.from('abc'),
      Buffer.alloc(509),
      extended('L', Buffer.from(`${long}.2\0`)),
      tarHeader('ignored', 0),
    ]);
    const entries = await readTar(bufferSource(bytes));
    expect(names(entries).slice(3)).toEqual([long, `${long}.2`]);
    expect(entries[3]?.sizeBytes).toBe(3);
    const global = extended('g', Buffer.from(paxRecord('path', 'all.vmdk')));
    expect(await refusal(withTail(global))).toMatch(/global PAX/);
  });

  it('accepts signed header checksums and contiguous files, as the agent does', async () => {
    const header = Buffer.from(tarHeader('d\u00e9j\u00e0.vmdk', 4, '7'));
    header.fill(0x20, 148, 156);
    let signed = 0;
    for (const byte of header) signed += byte >= 0x80 ? byte - 0x100 : byte;
    header.write(`${signed.toString(8).padStart(6, '0')}\0 `, 148);
    const bytes = Buffer.concat([header, Buffer.from('abcd'), Buffer.alloc(508)]);
    expect(names(await readTar(bufferSource(bytes)))).toEqual(['d\u00e9j\u00e0.vmdk']);
  });

  it('extracts one entry of an archive without an end marker, reading only that entry', async () => {
    const source = bufferSource(unterminated);
    const entries = await readTar(source);
    for (const entry of entries) {
      const locator: TarLocator = {
        format: 'tar',
        dataOffset: entry.dataOffset,
        sizeBytes: entry.sizeBytes,
      };
      source.bytesRead = 0;
      source.reads = [];
      const read = await readEntry(source, locator, 1 << 20);
      expect(read.integrity).toBe('complete');
      expect(source.bytesRead).toBe(entry.sizeBytes);
      expect(source.reads[0]?.[0]).toBe(entry.dataOffset);
    }
    const last = entries[2] as TarEntry;
    const read = await readEntry(
      source,
      { format: 'tar', dataOffset: last.dataOffset, sizeBytes: last.sizeBytes },
      1 << 20,
    );
    expect(read.data.equals(manifest)).toBe(true);
  });
});

/**
 * A real OVA, read in place: EMUCAT_OVA_FIXTURE=C:\path\to\export.ova pnpm --filter @emucat/api exec vitest run
 * tar-termination. It checks every entry's SHA-1 against the OVA's own manifest, when it has SHA-1 lines.
 */
const fixture = process.env.EMUCAT_OVA_FIXTURE;
describe.skipIf(!fixture || !existsSync(fixture))('A real OVA (EMUCAT_OVA_FIXTURE)', () => {
  it('lists, extracts and verifies every entry against its manifest by random access', async () => {
    const local = await openLocal(fixture as string);
    try {
      let bytesRead = 0;
      const source = {
        sizeBytes: local.sizeBytes,
        read: async (offset: number, length: number) => {
          const data = await local.read(offset, length);
          bytesRead += data.length;
          return data;
        },
      };
      const entries = await readTar(source);
      checkOvaLayout(entries);
      expect(bytesRead).toBe(512 * entries.length);
      const manifestEntry = entries.find((entry) => entry.name.toLowerCase().endsWith('.mf'));
      const digests = new Map<string, string>();
      if (manifestEntry) {
        const { data } = await readEntry(
          source,
          { format: 'tar', ...manifestEntry },
          manifestEntry.sizeBytes,
        );
        for (const line of data.toString('utf8').split('\n')) {
          const match = /^SHA1 ?\((.+)\) ?= ?([0-9a-f]{40})$/iu.exec(line.trim());
          if (match) digests.set(match[1] as string, (match[2] as string).toLowerCase());
        }
      }
      for (const entry of entries) {
        const expected = digests.get(entry.name);
        if (!expected) continue;
        const hash = createHash('sha1');
        for await (const chunk of entryChunks(source, { format: 'tar', ...entry })) {
          hash.update(chunk);
        }
        expect(hash.digest('hex'), entry.name).toBe(expected);
      }
    } finally {
      await local.close();
    }
  });
});
