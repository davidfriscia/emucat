/**
 * ZIP64 in the server's ZIP reader and writer (F-4): the central records the agent's zip 7.3 writes, with a
 * placeholder ZIP64 record before the real one, for an entry from a file of 3.75 GiB or more (condition A) and for
 * every entry beyond 4 GiB of archive data (condition B); standard ZIP64; and the malformed and ambiguous records
 * that must still be refused. Archives beyond 4 GiB are virtual: their zeros are made only when read.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { entryChunks, type ZipLocator } from '../src/archives/extract.js';
import {
  canonicalManifestBytes,
  inspectZip,
  MANIFEST_ENTRY_NAME,
} from '../src/archives/manifest.js';
import {
  hashEntry,
  openLocal,
  readCentralDirectory,
  readSmallEntry,
  rewriteZip,
  type RandomAccess,
  type ZipEntry,
} from '../src/archives/zip.js';
import {
  AGENT_ZIP64_THRESHOLD,
  buildZip64Layout,
  vmZip64,
  zerosSha256,
  zip64Data,
  type LayoutEntry,
} from './archive-sources.js';
import { buildZip, sha256 } from './zip-builder.js';

const MAX_U32 = 0xffffffff;
const GIB = 1024 * 1024 * 1024;
const LIMITS = { maxEntries: 1000, maxDirectoryBytes: 1 << 20 };

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'emucat-zip64-'));
  directories.push(directory);
  return directory;
}

const memory = (data: Buffer): RandomAccess => ({
  sizeBytes: data.length,
  read: async (offset, length) => data.subarray(offset, offset + length),
});

const read = (source: RandomAccess) => readCentralDirectory(source, LIMITS);
const zip = (entries: LayoutEntry[]) => buildZip64Layout(entries);
const byName = (entries: ZipEntry[], name: string) => {
  const entry = entries.find((item) => item.name === name);
  if (!entry) throw new Error(`No ${name}`);
  return entry;
};

/** The ZIP64 values of the extra field, record by record, and the other records' IDs, as stored. */
function rawExtras(extra: Buffer): { zip64: bigint[][]; others: number[] } {
  const zip64: bigint[][] = [];
  const others: number[] = [];
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (id === 1) {
      const values: bigint[] = [];
      for (let field = 0; field + 8 <= length; field += 8) {
        values.push(extra.readBigUInt64LE(at + 4 + field));
      }
      zip64.push(values);
    } else others.push(id);
    at += 4 + length;
  }
  return { zip64, others };
}

/** Every central record of a ZIP in memory, as stored: fixed fields and extras. */
function centralRecords(data: Buffer) {
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let directoryOffset = data.readUInt32LE(end + 16);
  if (directoryOffset === MAX_U32) {
    const record = Number(data.readBigUInt64LE(end - 20 + 8));
    directoryOffset = Number(data.readBigUInt64LE(record + 48));
  }
  const records = [];
  for (let at = directoryOffset; data.readUInt32LE(at) === 0x02014b50;) {
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    records.push({
      name: data.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      compressed: data.readUInt32LE(at + 20),
      uncompressed: data.readUInt32LE(at + 24),
      offset: data.readUInt32LE(at + 42),
      versionNeeded: data.readUInt16LE(at + 6),
      ...rawExtras(data.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength)),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return records;
}

const CFG = Buffer.from('[General]\nmachine = ibmpc\n');
const NOTES = Buffer.from('notes '.repeat(500));
/** Small files, with the record layout the agent writes for a large one forced on them. */
const AGENT_SIZES = { zip64: { fields: { uncompressed: true, compressed: true } } } as const;

// --- Central directory --------------------------------------------------------------------------------------

describe('ZIP64 central records', () => {
  it('reads a plain ZIP as before', async () => {
    const { entries } = await read(
      memory(
        buildZip([
          { name: 'vm.cfg', data: CFG },
          { name: 'raw.bin', data: NOTES, stored: true },
        ]),
      ),
    );
    expect(entries.map((entry) => [entry.name, entry.zip64, entry.uncompressedSize])).toEqual([
      ['vm.cfg', false, CFG.length],
      ['raw.bin', false, NOTES.length],
    ]);
  });

  it('reads a standard archive with one ZIP64 record', async () => {
    const archive = zip([
      { name: 'vm.cfg', data: CFG, zip64: { ...AGENT_SIZES.zip64, records: 'single' } },
    ]);
    const [entry] = (await read(archive)).entries;
    expect(entry).toMatchObject({
      zip64: true,
      uncompressedSize: CFG.length,
      localHeaderOffset: 0,
      extra: Buffer.alloc(0),
    });
    expect(await readSmallEntry(archive, entry as ZipEntry, 1 << 20)).toEqual(CFG);
  });

  it('takes the real sizes after the agent’s placeholder record, stored or deflated (F-4, condition A)', async () => {
    const archive = zip([
      { name: 'vm.cfg', data: CFG, ...AGENT_SIZES },
      { name: 'notes.txt', data: NOTES, stored: true, ...AGENT_SIZES },
    ]);
    // What zip 7.3 writes: the fixed sizes are 0xFFFFFFFF, and two ZIP64 records follow, placeholder first.
    const raw = centralRecords(archive.toBuffer());
    expect(raw[0]).toMatchObject({ compressed: MAX_U32, uncompressed: MAX_U32 });
    expect(raw[0]?.zip64[0]).toEqual([BigInt(MAX_U32), BigInt(MAX_U32)]);
    expect(raw[0]?.zip64[1]?.[0]).toBe(BigInt(CFG.length));

    const { entries } = await read(archive);
    const cfg = byName(entries, 'vm.cfg');
    const notes = byName(entries, 'notes.txt');
    expect(cfg).toMatchObject({ method: 8, uncompressedSize: CFG.length, zip64: true });
    expect(cfg.compressedSize).toBeLessThan(CFG.length + 10);
    expect(notes).toMatchObject({
      method: 0,
      uncompressedSize: NOTES.length,
      compressedSize: NOTES.length,
    });
    expect(await readSmallEntry(archive, cfg, 1 << 20)).toEqual(CFG);
    expect(await readSmallEntry(archive, notes, 1 << 20)).toEqual(NOTES);
  });

  it('accepts every combination of fields in ZIP64, one record or the agent’s two', async () => {
    const combinations: Array<{ uncompressed: boolean; compressed: boolean }> = [
      { uncompressed: true, compressed: false },
      { uncompressed: false, compressed: true },
      { uncompressed: true, compressed: true },
    ];
    for (const fields of combinations) {
      for (const records of ['single', 'agent'] as const) {
        const archive = zip([
          { name: 'vm.cfg', data: CFG },
          { name: 'notes.txt', data: NOTES, zip64: { fields, records } },
        ]);
        const notes = byName((await read(archive)).entries, 'notes.txt');
        expect(notes.uncompressedSize, JSON.stringify({ fields, records })).toBe(NOTES.length);
        expect(await readSmallEntry(archive, notes, 1 << 20)).toEqual(NOTES);
      }
    }
  });

  it('accepts the same real values repeated', async () => {
    const real = zip64Data(NOTES.length, NOTES.length);
    const twice = zip([
      {
        name: 'notes.txt',
        data: NOTES,
        stored: true,
        zip64: { ...AGENT_SIZES.zip64, records: [real, real] },
      },
    ]);
    const entry = byName((await read(twice)).entries, 'notes.txt');
    expect(entry.uncompressedSize).toBe(NOTES.length);
    expect(await readSmallEntry(twice, entry, 1 << 20)).toEqual(NOTES);
  });

  it('keeps every other extra field, and drops every ZIP64 record from what it keeps', async () => {
    const timestamp = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
    const archive = zip([{ name: 'vm.cfg', data: CFG, ...AGENT_SIZES, centralExtra: timestamp }]);
    const [entry] = (await read(archive)).entries;
    expect(entry?.extra).toEqual(timestamp);
  });
});

describe('ZIP64 beyond 4 GiB (virtual archives)', () => {
  // A stored disk of 4 GiB + 1 MiB of zeros, then small entries whose local headers are beyond 4 GiB.
  const DISK = 4 * GIB + 1024 * 1024;
  const beyond = (layout: Partial<LayoutEntry> = {}) =>
    zip([
      { name: 'disk.img', zeros: DISK, stored: true },
      { name: 'vm.cfg', data: CFG, ...layout },
    ]);

  it('reads sizes and offsets after the agent’s placeholder (condition B)', async () => {
    const archive = beyond();
    const { entries, directoryOffset } = await read(archive);
    expect(directoryOffset).toBeGreaterThan(MAX_U32);
    const disk = byName(entries, 'disk.img');
    const cfg = byName(entries, 'vm.cfg');
    expect(disk).toMatchObject({
      uncompressedSize: DISK,
      compressedSize: DISK,
      localHeaderOffset: 0,
    });
    expect(cfg.localHeaderOffset).toBeGreaterThan(MAX_U32);
    expect(cfg.uncompressedSize).toBe(CFG.length);
    expect(await readSmallEntry(archive, cfg, 1 << 20)).toEqual(CFG);
  });

  it('reads a standard archive whose only ZIP64 field is the offset', async () => {
    const archive = beyond({
      zip64: {
        fields: { uncompressed: false, compressed: false, offset: true },
        records: 'single',
      },
    });
    const cfg = byName((await read(archive)).entries, 'vm.cfg');
    expect(cfg.localHeaderOffset).toBe(DISK + 30 + 'disk.img'.length + 20);
    expect(await readSmallEntry(archive, cfg, 1 << 20)).toEqual(CFG);
    // Sizes and offset, offset only: both are the standard layout.
    const both = beyond({
      zip64: { fields: { uncompressed: true, offset: true, compressed: false }, records: 'single' },
    });
    expect(
      await readSmallEntry(both, byName((await read(both)).entries, 'vm.cfg'), 1 << 20),
    ).toEqual(CFG);
  });

  it('accepts real values equal to 0xFFFFFFFF: a file of 4,294,967,295 bytes, an entry at that offset', async () => {
    // Both of the agent's records give 0xFFFFFFFF for the sizes: that is the value, and the data's bounds agree.
    const archive = zip([
      { name: 'exact.img', zeros: MAX_U32, stored: true },
      { name: 'vm.cfg', data: CFG },
    ]);
    const { entries } = await read(archive);
    expect(byName(entries, 'exact.img')).toMatchObject({
      uncompressedSize: MAX_U32,
      compressedSize: MAX_U32,
    });
    expect(await readSmallEntry(archive, byName(entries, 'vm.cfg'), 1 << 20)).toEqual(CFG);
    // A local header exactly at 0xFFFFFFFF, in one record or in the agent's two.
    for (const records of ['single', 'agent'] as const) {
      const atSentinel = zip([
        { name: 'pad.img', zeros: MAX_U32 - 30 - 'pad.img'.length - 20, stored: true },
        { name: 'vm.cfg', data: CFG, zip64: { records } },
      ]);
      const cfg = byName((await read(atSentinel)).entries, 'vm.cfg');
      expect(cfg.localHeaderOffset).toBe(MAX_U32);
      expect(await readSmallEntry(atSentinel, cfg, 1 << 20)).toEqual(CFG);
    }
  });

  it('inspects a realistic agent archive beyond 4 GiB, manifest last and in ZIP64', async () => {
    const { zip: archive, manifestSha256 } = vmZip64('86box', 'Big', [
      { name: 'disk.img', zeros: DISK, stored: true },
      { name: 'vm.cfg', data: CFG },
    ]);
    const inspected = await inspectZip(archive, {
      emulatorType: '86box',
      vmName: 'Big',
      manifestSha256,
    });
    const manifest = byName(inspected.entries, MANIFEST_ENTRY_NAME);
    expect(manifest.zip64).toBe(true);
    expect(manifest.localHeaderOffset).toBeGreaterThan(MAX_U32);
    expect(inspected.manifest.entries).toEqual([
      { path: 'disk.img', type: 'file', sizeBytes: DISK, sha256: zerosSha256(DISK) },
      { path: 'vm.cfg', type: 'file', sizeBytes: CFG.length, sha256: sha256(CFG) },
    ]);
  });

  it('lists and previews a deflated file of 3.75 GiB whose data is small (condition A)', async () => {
    const { zip: archive, manifestSha256 } = vmZip64('qemu', 'Large', [
      { name: 'disk.qcow2', zeros: AGENT_ZIP64_THRESHOLD },
      { name: 'vm.json', data: Buffer.from('{}') },
    ]);
    expect(archive.sizeBytes).toBeLessThan(5_000_000);
    const inspected = await inspectZip(archive, {
      emulatorType: 'qemu',
      vmName: 'Large',
      manifestSha256,
    });
    const disk = byName(inspected.entries, 'disk.qcow2');
    expect(disk).toMatchObject({ method: 8, uncompressedSize: AGENT_ZIP64_THRESHOLD, zip64: true });
    expect(disk.compressedSize).toBeLessThan(5_000_000);
    // The extraction path reads the first bytes through the same values, as a preview does.
    const locator: ZipLocator = {
      format: 'zip',
      name: disk.name,
      localHeaderOffset: disk.localHeaderOffset,
      compressedSize: disk.compressedSize,
      uncompressedSize: disk.uncompressedSize,
      method: disk.method,
      crc32: disk.crc32,
      flags: disk.flags,
      limit: inspected.directoryOffset,
    };
    const chunks = entryChunks(archive, locator);
    const first = await chunks.next();
    await chunks.return(undefined);
    expect(first.done).toBe(false);
    expect((first.value as Buffer).length).toBeGreaterThan(0);
    expect((first.value as Buffer).every((byte) => byte === 0)).toBe(true);
  });
});

// --- Malformed and ambiguous records --------------------------------------------------------------------------

describe('malformed and ambiguous ZIP64 records', () => {
  const real = zip64Data(NOTES.length, NOTES.length);
  const notes = (records: LayoutEntry['zip64'], extra: Partial<LayoutEntry> = {}) =>
    zip([{ name: 'notes.txt', data: NOTES, stored: true, zip64: records, ...extra }]);
  const fields = { uncompressed: true, compressed: true };

  it('refuses an entry that needs ZIP64 and has no record', async () => {
    await expect(read(notes({ fields, records: [] }))).rejects.toThrow(
      'An entry needs ZIP64 and has no ZIP64 field',
    );
  });

  it('refuses a record shorter than the fields it must hold, first or second', async () => {
    for (const records of [
      [zip64Data(NOTES.length)],
      [zip64Data(MAX_U32, MAX_U32), zip64Data(NOTES.length)],
      [zip64Data(NOTES.length), real],
    ]) {
      await expect(read(notes({ fields, records }))).rejects.toThrow('A ZIP64 field is truncated');
    }
  });

  it('refuses an extra field whose framing runs past its end', async () => {
    const broken = Buffer.from([0x0a, 0x00, 0x10, 0x00, 0x01, 0x02]);
    await expect(
      read(notes({ fields, records: 'agent' }, { centralExtra: broken })),
    ).rejects.toThrow('An extra field is truncated');
  });

  it('never reads an unresolved placeholder as a 4 GiB size', async () => {
    // Only placeholders, one record or two: the data would overlap the directory.
    for (const records of [
      [zip64Data(MAX_U32, MAX_U32)],
      [zip64Data(MAX_U32, MAX_U32), zip64Data(MAX_U32, MAX_U32)],
    ]) {
      await expect(read(notes({ fields, records }))).rejects.toThrow(
        'An entry’s data overlaps the central directory',
      );
    }
    // A placeholder for the uncompressed size alone: listed, then refused by the manifest and the size check.
    const { zip: archive } = vmZip64('86box', 'Vm', [
      {
        name: 'notes.txt',
        data: NOTES,
        zip64: { fields: { uncompressed: true, compressed: false }, records: [zip64Data(MAX_U32)] },
      },
    ]);
    const entry = byName((await read(archive)).entries, 'notes.txt');
    expect(entry.uncompressedSize).toBe(MAX_U32);
    await expect(
      inspectZip(archive, { emulatorType: '86box', vmName: 'Vm', manifestSha256: null }),
    ).rejects.toMatchObject({ kind: 'integrity' });
    await expect(readSmallEntry(archive, entry, 1 << 20)).rejects.toMatchObject({ kind: 'limit' });
  });

  it('refuses records that give two different real values, whichever comes first', async () => {
    const other = zip64Data(NOTES.length + 1, NOTES.length + 1);
    for (const records of [
      [real, other],
      [other, real],
      [zip64Data(MAX_U32, MAX_U32), real, other],
    ]) {
      await expect(read(notes({ fields, records }))).rejects.toThrow(
        'An entry’s ZIP64 records contradict each other',
      );
    }
    // The offset, too.
    const archive = zip([
      { name: 'vm.cfg', data: CFG },
      {
        name: 'notes.txt',
        data: NOTES,
        zip64: { fields: { offset: true }, records: [zip64Data(1), zip64Data(2)] },
      },
    ]);
    await expect(read(archive)).rejects.toThrow('An entry’s ZIP64 records contradict each other');
  });

  it('refuses a resolved offset or compressed size that does not fit the archive', async () => {
    // An offset into the middle of the first entry: no local header there.
    const misplaced = zip([
      { name: 'vm.cfg', data: CFG },
      {
        name: 'notes.txt',
        data: NOTES,
        zip64: { fields: { offset: true }, records: [zip64Data(5)] },
      },
    ]);
    const entry = byName((await read(misplaced)).entries, 'notes.txt');
    await expect(readSmallEntry(misplaced, entry, 1 << 20)).rejects.toThrow(/local header/);
    // An offset past the directory, a compressed size running into it.
    await expect(
      read(
        zip([
          {
            name: 'notes.txt',
            data: NOTES,
            zip64: { fields: { offset: true }, records: [zip64Data(1 << 20)] },
          },
        ]),
      ),
    ).rejects.toThrow('An entry’s data overlaps the central directory');
    await expect(
      read(
        notes({
          fields,
          records: [zip64Data(MAX_U32, MAX_U32), zip64Data(NOTES.length, NOTES.length + 100)],
        }),
      ),
    ).rejects.toThrow('An entry’s data overlaps the central directory');
    // A compressed size too short for its data: the size and CRC check refuses what is read.
    const short = notes({
      fields,
      records: [zip64Data(MAX_U32, MAX_U32), zip64Data(NOTES.length, NOTES.length - 1)],
    });
    const shortEntry = byName((await read(short)).entries, 'notes.txt');
    await expect(readSmallEntry(short, shortEntry, 1 << 20)).rejects.toThrow(/size or CRC/);
  });

  it('refuses values beyond what can be represented, even in a placeholder record', async () => {
    const huge = 2n ** 53n;
    for (const records of [
      [zip64Data(huge, huge)],
      [zip64Data(huge, huge), real],
      [real, zip64Data(huge, 1)],
    ]) {
      await expect(read(notes({ fields, records }))).rejects.toThrow(
        'A size or offset is too large',
      );
    }
  });
});

// --- Hashing and rewriting -----------------------------------------------------------------------------------

describe('hashing and rewriting agent ZIP64 archives', () => {
  const TIMESTAMP = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);

  it('hashes, rewrites for a clone with one canonical ZIP64 record per entry, and the clone passes', async () => {
    const directory = await scratch();
    const { zip: archive, manifestSha256 } = vmZip64(
      '86box',
      'DOS622',
      [
        {
          name: 'disk.img',
          data: Buffer.alloc(300_000, 9),
          stored: true,
          ...AGENT_SIZES,
          centralExtra: TIMESTAMP,
        },
        { name: 'vm.cfg', data: CFG, ...AGENT_SIZES },
        { name: 'plain.txt', data: NOTES },
      ],
      AGENT_SIZES,
    );
    const source = join(directory, 'source.zip');
    const target = join(directory, 'clone.zip');
    const sourceBytes = archive.toBuffer();
    await writeFile(source, sourceBytes);
    const inspected = await inspectZip(memory(sourceBytes), {
      emulatorType: '86box',
      vmName: 'DOS622',
      manifestSha256,
    });
    const local = await openLocal(source);
    try {
      for (const listed of inspected.manifest.entries) {
        if (listed.type !== 'file') continue;
        const entry = byName(inspected.entries, listed.path);
        expect(await hashEntry(source, local, entry, () => undefined)).toBe(listed.sha256);
      }
    } finally {
      await local.close();
    }

    const renamed = canonicalManifestBytes({ ...inspected.manifest, vmName: 'DOS622-Copy' });
    await rewriteZip(
      source,
      target,
      MANIFEST_ENTRY_NAME,
      MANIFEST_ENTRY_NAME,
      renamed,
      LIMITS,
      () => undefined,
    );
    const written = await readFile(target);
    const clone = await inspectZip(memory(written), {
      emulatorType: '86box',
      vmName: 'DOS622-Copy',
      manifestSha256: sha256(renamed),
    });
    expect(clone.manifest.entries).toEqual(inspected.manifest.entries);

    // One ZIP64 record each, with the real values and no placeholder; the other extra fields kept.
    const records = centralRecords(written);
    expect(records.map((record) => record.name)).toEqual([
      'disk.img',
      'vm.cfg',
      'plain.txt',
      MANIFEST_ENTRY_NAME,
    ]);
    const disk = records[0];
    expect(disk).toMatchObject({
      compressed: MAX_U32,
      uncompressed: MAX_U32,
      offset: 0,
      versionNeeded: 45,
    });
    expect(disk?.zip64).toEqual([[300_000n, 300_000n]]);
    expect(disk?.others).toEqual([0x5455]);
    const cfg = byName(clone.entries, 'vm.cfg');
    expect(records[1]?.zip64).toEqual([[BigInt(CFG.length), BigInt(cfg.compressedSize)]]);
    expect(records[2]).toMatchObject({ zip64: [], others: [], uncompressed: NOTES.length });
    expect(records[3]).toMatchObject({ zip64: [], uncompressed: renamed.length });

    // Every file reads back with the CRC and SHA-256 it had.
    const copy = await openLocal(target);
    try {
      for (const listed of clone.manifest.entries) {
        if (listed.type !== 'file') continue;
        const entry = byName(clone.entries, listed.path);
        expect(entry.crc32).toBe(byName(inspected.entries, listed.path).crc32);
        expect(entry.method).toBe(byName(inspected.entries, listed.path).method);
        expect(await hashEntry(target, copy, entry, () => undefined)).toBe(listed.sha256);
      }
    } finally {
      await copy.close();
    }
    // The source is untouched.
    expect(sha256(await readFile(source))).toBe(sha256(sourceBytes));
  });

  it('rewrites a plain archive exactly as before: no ZIP64 anywhere', async () => {
    const directory = await scratch();
    const { zip: archive } = vmZip64('86box', 'Plain', [
      { name: 'vm.cfg', data: CFG },
      { name: 'notes.txt', data: NOTES, stored: true },
    ]);
    const source = join(directory, 'source.zip');
    const target = join(directory, 'clone.zip');
    await writeFile(source, archive.toBuffer());
    const manifest = Buffer.from('{}\n');
    await rewriteZip(
      source,
      target,
      MANIFEST_ENTRY_NAME,
      MANIFEST_ENTRY_NAME,
      manifest,
      LIMITS,
      () => undefined,
    );
    const records = centralRecords(await readFile(target));
    expect(
      records.every((record) => record.zip64.length === 0 && record.versionNeeded === 20),
    ).toBe(true);
  });
});
