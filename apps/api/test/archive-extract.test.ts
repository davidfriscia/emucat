/**
 * Selective extraction (decision 0056): one entry of a ZIP, ZIP64 or TAR archive read through random access, with
 * every claim of the archive checked against its bytes, bounded memory and reads, integrity checks, and cancellation.
 * No database is needed: sources are in memory and count every byte read.
 */
import { randomBytes } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  EntryVerifier,
  ExtractError,
  entryChunks,
  readEntry,
  type EntryLocator,
  type ZipLocator,
} from '../src/archives/extract.js';
import { decodePcxSteps, decodeTgaSteps } from '../src/archives/legacy-images.js';
import { readTar } from '../src/archives/tar.js';
import { readCentralDirectory } from '../src/archives/zip.js';
import { bufferSource, zerosCrc, zip64Archive, type CountingSource } from './archive-sources.js';
import { buildTar, buildZip, sha256 } from './zip-builder.js';

async function locatorFor(source: CountingSource, name: string): Promise<ZipLocator> {
  const { entries, directoryOffset } = await readCentralDirectory(source, {
    maxEntries: 1000,
    maxDirectoryBytes: 1 << 20,
  });
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`no ${name}`);
  return {
    format: 'zip',
    name: entry.name,
    localHeaderOffset: entry.localHeaderOffset,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    method: entry.method,
    crc32: entry.crc32 >>> 0,
    flags: entry.flags,
    limit: directoryOffset,
  };
}

const kinds = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof ExtractError ? error.kind : String(error);
  }
};

const text = Buffer.from('[General]\nmachine = ibmpc\n'.repeat(200));
const noise = Buffer.from(Array.from({ length: 300_000 }, (_, index) => (index * 7919) % 251));

describe('ZIP entries', () => {
  it('reads a stored and a deflated entry whole and verifies CRC-32 and SHA-256', async () => {
    const zip = buildZip([
      { name: 'a.cfg', data: text },
      { name: 'b.bin', data: noise, stored: true },
    ]);
    const source = bufferSource(zip);
    const deflated = await readEntry(source, await locatorFor(source, 'a.cfg'), 1 << 20, {
      sha256: sha256(text),
    });
    expect(deflated.data.equals(text)).toBe(true);
    expect(deflated).toMatchObject({ truncated: false, integrity: 'verified' });
    const stored = await readEntry(source, await locatorFor(source, 'b.bin'), 1 << 20);
    expect(stored.data.equals(noise)).toBe(true);
  });

  it('reads a prefix only, reports it as partial, and reads little more than it returns', async () => {
    const zip = buildZip([
      { name: 'first.bin', data: noise, stored: true },
      { name: 'small.txt', data: text },
    ]);
    const source = bufferSource(zip);
    const locator = await locatorFor(source, 'first.bin');
    source.bytesRead = 0;
    const prefix = await readEntry(source, locator, 4096);
    expect(prefix.data.equals(noise.subarray(0, 4096))).toBe(true);
    expect(prefix).toMatchObject({
      truncated: true,
      integrity: 'partial',
      totalBytes: noise.length,
    });
    // The local header (30 + name) and the prefix itself.
    expect(source.bytesRead).toBeLessThan(4096 + 100);
    // An entry that is not the one asked for is never read.
    const small = await locatorFor(source, 'small.txt');
    source.bytesRead = 0;
    source.reads = [];
    await readEntry(source, small, 1 << 20);
    for (const [offset] of source.reads)
      expect(offset).toBeGreaterThanOrEqual(small.localHeaderOffset);
  });

  it('seeks into stored entries, and into deflated ones only within the seek limit', async () => {
    const zip = buildZip([
      { name: 'stored.bin', data: noise, stored: true },
      { name: 'deflated.bin', data: noise },
    ]);
    const source = bufferSource(zip);
    const stored = await readEntry(source, await locatorFor(source, 'stored.bin'), 16, {
      start: 250_000,
    });
    expect(stored.data.equals(noise.subarray(250_000, 250_016))).toBe(true);
    const deflated = await locatorFor(source, 'deflated.bin');
    const near = await readEntry(source, deflated, 16, { start: 1000, maxSeekBytes: 4096 });
    expect(near.data.equals(noise.subarray(1000, 1016))).toBe(true);
    expect(
      await kinds(readEntry(source, deflated, 16, { start: 250_000, maxSeekBytes: 4096 })),
    ).toBe('seek_unsupported');
  });

  it('reads ZIP64 entries beyond 4 GiB and larger than 4 GiB, touching only what is needed', async () => {
    const big = 5 * 1024 ** 3;
    const crc = zerosCrc(big);
    const source = zip64Archive([
      { name: 'disk.img', data: { zeros: big, crc } },
      { name: 'late.cfg', data: text, gapBefore: 1024 },
    ]);
    expect(source.sizeBytes).toBeGreaterThan(2 ** 32);
    const late = await locatorFor(source, 'late.cfg');
    expect(late.localHeaderOffset).toBeGreaterThan(2 ** 32);
    source.bytesRead = 0;
    const whole = await readEntry(source, late, 1 << 20);
    expect(whole.data.equals(text)).toBe(true);
    expect(whole.integrity).toBe('verified');
    expect(source.bytesRead).toBeLessThan(text.length + 200);

    const disk = await locatorFor(source, 'disk.img');
    expect(disk.uncompressedSize).toBe(big);
    source.bytesRead = 0;
    const window = await readEntry(source, disk, 65_536, { start: big - 65_536 });
    expect(window).toMatchObject({ truncated: false, integrity: 'partial', start: big - 65_536 });
    expect(source.bytesRead).toBeLessThan(65_536 + 200);
  });

  it('refuses a local header that disagrees with the central directory', async () => {
    const zip = buildZip([{ name: 'a.cfg', data: text }]);
    const locator = await locatorFor(bufferSource(zip), 'a.cfg');
    const renamed = Buffer.from(zip);
    renamed.write('b', 30);
    expect(await kinds(readEntry(bufferSource(renamed), locator, 1 << 20))).toBe('malformed');
    const method = Buffer.from(zip);
    method.writeUInt16LE(0, 8);
    expect(await kinds(readEntry(bufferSource(method), locator, 1 << 20))).toBe('malformed');
    const signature = Buffer.from(zip);
    signature.writeUInt32LE(0, 0);
    expect(await kinds(readEntry(bufferSource(signature), locator, 1 << 20))).toBe('malformed');
  });

  it('refuses offsets and sizes that leave the entry, whatever the locator says', async () => {
    const zip = buildZip([{ name: 'a.cfg', data: text }]);
    const source = bufferSource(zip);
    const locator = await locatorFor(source, 'a.cfg');
    expect(await kinds(readEntry(source, { ...locator, localHeaderOffset: 5 }, 100))).toBe(
      'malformed',
    );
    expect(await kinds(readEntry(source, { ...locator, compressedSize: zip.length }, 100))).toBe(
      'malformed',
    );
    expect(await kinds(readEntry(source, { ...locator, limit: zip.length + 10 }, 100))).toBe(
      'malformed',
    );
    expect(await kinds(readEntry(source, { ...locator, localHeaderOffset: -1 }, 100))).toBe(
      'malformed',
    );
  });

  it('refuses unsupported compression and encrypted entries', async () => {
    const zip = buildZip([{ name: 'a.cfg', data: text }]);
    const source = bufferSource(zip);
    const locator = await locatorFor(source, 'a.cfg');
    expect(await kinds(readEntry(source, { ...locator, method: 14 }, 100))).toBe(
      'unsupported_compression',
    );
    expect(await kinds(readEntry(source, { ...locator, flags: locator.flags | 1 }, 100))).toBe(
      'encrypted',
    );
  });

  it('stops a ZIP bomb at its recorded size, and refuses ratios deflate cannot produce', async () => {
    const zeros = Buffer.alloc(8 * 1024 * 1024);
    const zip = buildZip([{ name: 'bomb.bin', data: zeros }]);
    const source = bufferSource(zip);
    const locator = await locatorFor(source, 'bomb.bin');
    // The central directory lies: it claims 1 KiB. Inflation stops right past that.
    const lying = { ...locator, uncompressedSize: 1024 };
    expect(await kinds(readEntry(source, lying, 1 << 30))).toBe('malformed');
    // A claim beyond deflate's maximum ratio is refused before anything is inflated.
    source.bytesRead = 0;
    expect(await kinds(readEntry(source, { ...locator, compressedSize: 10 }, 100))).toBe(
      'malformed',
    );
    expect(source.bytesRead).toBe(0);
  });

  it('reports a CRC mismatch on a complete read, and not on a partial one', async () => {
    const zip = buildZip([{ name: 'n.bin', data: noise, stored: true }]);
    const locator = await locatorFor(bufferSource(zip), 'n.bin');
    const damaged = Buffer.from(zip);
    const at = locator.localHeaderOffset + 30 + 5 + 200_000;
    damaged.writeUInt8(damaged.readUInt8(at) ^ 0xff, at);
    expect(await kinds(readEntry(bufferSource(damaged), locator, 1 << 20))).toBe('integrity');
    const prefix = await readEntry(bufferSource(damaged), locator, 1000);
    expect(prefix.integrity).toBe('partial');
    // And a SHA-256 mismatch, when the CRC is right.
    expect(
      await kinds(readEntry(bufferSource(zip), locator, 1 << 20, { sha256: 'f'.repeat(64) })),
    ).toBe('integrity');
  });

  it('refuses damaged deflate data', async () => {
    const compressed = deflateRawSync(text);
    const garbage = Buffer.from(compressed);
    garbage.fill(0xff, 2, 40);
    const zip = buildZip([{ name: 'a.cfg', data: text }]);
    const source = bufferSource(zip);
    const locator = await locatorFor(source, 'a.cfg');
    const damaged = Buffer.from(zip);
    garbage.copy(damaged, locator.localHeaderOffset + 30 + 5);
    expect(await kinds(readEntry(bufferSource(damaged), locator, 1 << 20))).toMatch(
      /malformed|integrity/,
    );
  });

  it('stops when cancelled, between reads and during inflation', async () => {
    // Incompressible, so that inflating it takes many reads.
    const zip = buildZip([{ name: 'n.bin', data: randomBytes(300_000) }]);
    const source = bufferSource(zip);
    const locator = await locatorFor(source, 'n.bin');
    const controller = new AbortController();
    let reads = 0;
    source.beforeRead = () => {
      reads += 1;
      if (reads === 3) controller.abort(new Error('gone'));
    };
    await expect(
      readEntry(source, locator, 1 << 20, { signal: controller.signal, chunkBytes: 16 * 1024 }),
    ).rejects.toThrow('gone');
    const before = source.bytesRead;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(source.bytesRead).toBe(before);
  });

  it('streams in bounded chunks', async () => {
    const zip = buildZip([{ name: 'n.bin', data: noise, stored: true }]);
    const source = bufferSource(zip);
    const locator = await locatorFor(source, 'n.bin');
    let largest = 0;
    let total = 0;
    for await (const chunk of entryChunks(source, locator, { chunkBytes: 32 * 1024 })) {
      largest = Math.max(largest, chunk.length);
      total += chunk.length;
    }
    expect(total).toBe(noise.length);
    expect(largest).toBeLessThanOrEqual(32 * 1024);
  });
});

describe('TAR entries', () => {
  const ova = buildTar([
    ['xp.ovf', Buffer.from('<Envelope/>')],
    ['xp-disk001.vmdk', noise],
    ['xp.mf', Buffer.from('SHA256(xp.ovf)= 00\n')],
  ]);

  it('reads a regular file at its data offset, and nothing before it', async () => {
    const source = bufferSource(ova);
    const entries = await readTar(source);
    const disk = entries.find((entry) => entry.name === 'xp-disk001.vmdk');
    if (!disk) throw new Error('no disk');
    const locator: EntryLocator = {
      format: 'tar',
      dataOffset: disk.dataOffset,
      sizeBytes: disk.sizeBytes,
    };
    source.bytesRead = 0;
    source.reads = [];
    const whole = await readEntry(source, locator, 1 << 20);
    expect(whole.data.equals(noise)).toBe(true);
    expect(whole.integrity).toBe('complete');
    expect(source.bytesRead).toBe(noise.length);
    expect(source.reads[0]?.[0]).toBe(disk.dataOffset);
    const window = await readEntry(source, locator, 32, { start: 123_456 });
    expect(window.data.equals(noise.subarray(123_456, 123_488))).toBe(true);
  });

  it('refuses an entry that runs past the end of the archive', async () => {
    const source = bufferSource(ova);
    expect(
      await kinds(
        readEntry(source, { format: 'tar', dataOffset: 512, sizeBytes: ova.length }, 100),
      ),
    ).toBe('malformed');
  });

  it('reads PAX long names, and refuses links and special files outright', async () => {
    const longName = `${'a'.repeat(150)}.ovf`;
    // A PAX record is "<length> <key>=<value>\n", the length counting its own digits.
    const paxRecord = (key: string, value: string) => {
      const line = ` ${key}=${value}\n`;
      let length = line.length + 1;
      while (String(length).length + line.length !== length)
        length = String(length).length + line.length;
      return `${length}${line}`;
    };
    const body = Buffer.from(paxRecord('path', longName));
    const tar = buildTar([
      ['PaxHeader', body],
      ['ignored', Buffer.from('<Envelope/>')],
    ]);
    // Mark the first header as a PAX header ('x').
    tar[156] = 'x'.charCodeAt(0);
    let sum = 0;
    tar.fill(0x20, 148, 156);
    for (let index = 0; index < 512; index += 1) sum += tar[index] as number;
    tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    const entries = await readTar(bufferSource(tar));
    expect(entries.map((entry) => entry.name)).toEqual([longName]);

    for (const type of ['1', '2', '3', '4', '6']) {
      await expect(
        readTar(bufferSource(buildTar([['x.ovf', Buffer.from('x')]], type))),
      ).rejects.toThrow(/regular files/);
    }
  });
});

describe('Verification', () => {
  it('distinguishes complete TAR reads from verified ZIP reads', () => {
    const tar = new EntryVerifier({ format: 'tar', dataOffset: 0, sizeBytes: 3 }, null);
    tar.update(Buffer.from('abc'));
    expect(tar.finish()).toBe('complete');
    const zip = new EntryVerifier(
      {
        format: 'zip',
        name: 'x',
        localHeaderOffset: 0,
        compressedSize: 3,
        uncompressedSize: 3,
        method: 0,
        crc32: crc32(Buffer.from('abc')) >>> 0,
        flags: 0,
        limit: 100,
      },
      null,
    );
    zip.update(Buffer.from('abc'));
    expect(zip.finish()).toBe('verified');
  });
});

describe('Legacy image decoders', () => {
  const limits = { maxPixels: 1 << 20, maxDimension: 4096 };
  const finish = <T>(generator: Generator<void, T>) => {
    for (;;) {
      const step = generator.next();
      if (step.done) return step.value;
    }
  };

  function pcx8(width: number, height: number, pixels: number[]): Buffer {
    const header = Buffer.alloc(128);
    header[0] = 0x0a;
    header[1] = 5;
    header[2] = 1;
    header[3] = 8;
    header.writeUInt16LE(width - 1, 8);
    header.writeUInt16LE(height - 1, 10);
    header[65] = 1;
    header.writeUInt16LE(width, 66);
    const body = Buffer.from(pixels.flatMap((value) => (value >= 0xc0 ? [0xc1, value] : [value])));
    const palette = Buffer.alloc(769);
    palette[0] = 0x0c;
    for (let index = 0; index < 256; index += 1) palette.fill(index, 1 + index * 3, 4 + index * 3);
    palette[1 + 200 * 3] = 255;
    palette[2 + 200 * 3] = 0;
    palette[3 + 200 * 3] = 0;
    return Buffer.concat([header, body, palette]);
  }

  it('decodes an 8-bit PCX with its palette', () => {
    const image = finish(decodePcxSteps(pcx8(2, 2, [200, 10, 10, 200]), limits));
    expect(image).toMatchObject({ width: 2, height: 2, channels: 3 });
    expect([...image.data.subarray(0, 6)]).toEqual([255, 0, 0, 10, 10, 10]);
  });

  it('refuses a PCX that claims more pixels than allowed, before allocating', () => {
    const huge = pcx8(1, 1, [1]);
    huge.writeUInt16LE(60_000, 8);
    huge.writeUInt16LE(60_000, 10);
    huge.writeUInt16LE(60_001, 66);
    expect(() => finish(decodePcxSteps(huge, limits))).toThrow(/longest side|pixels/);
  });

  it('decodes uncompressed and RLE TGAs, bottom-up and top-down', () => {
    const header = (type: number, descriptor: number) => {
      const value = Buffer.alloc(18);
      value[2] = type;
      value.writeUInt16LE(2, 12);
      value.writeUInt16LE(1, 14);
      value[16] = 24;
      value[17] = descriptor;
      return value;
    };
    const raw = finish(
      decodeTgaSteps(Buffer.concat([header(2, 0x20), Buffer.from([0, 0, 255, 255, 0, 0])]), limits),
    );
    expect([...raw.data]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
    const rle = finish(
      decodeTgaSteps(Buffer.concat([header(10, 0), Buffer.from([0x81, 0, 255, 0])]), limits),
    );
    expect([...rle.data]).toEqual([0, 255, 0, 255, 0, 255, 0, 255]);
    expect(() => finish(decodeTgaSteps(header(2, 0), limits))).toThrow(/truncated/);
  });
});
