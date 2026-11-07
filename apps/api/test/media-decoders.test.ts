/**
 * Resource limits on the two hand-written decoders. What matters here is what happens to a file written by
 * someone who wants to hurt the server: nothing large is allocated on its word, a deadline really stops
 * the work, and other requests carry on in the meantime.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeBmp,
  decodeBmpSteps,
  decodePpm,
  decodePpmSteps,
  decodeWithDeadline,
  ImageDecodeError,
} from '../src/media/decode.js';
import { ImageRejectedError, ImageTimeoutError, processImage } from '../src/media/process.js';

const LIMITS = { maxPixels: 1_000_000, maxDimension: 4096 };

function bmpHeader(
  width: number,
  height: number,
  bits: number,
  { compression = 0, pixelOffset = 54, fileSize = 54 } = {},
): Buffer {
  const header = Buffer.alloc(fileSize);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(fileSize, 2);
  header.writeUInt32LE(pixelOffset, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(bits, 28);
  header.writeUInt32LE(compression, 30);
  return header;
}

describe('malformed PPM', () => {
  it.each([
    ['truncated header', 'P6\n10'],
    ['no maximum', 'P6\n10 10\n'],
    ['letters in a dimension', 'P6\nabc 10\n255\n'],
    ['a number that never ends', `P6\n${'9'.repeat(40)} 1\n255\n`],
    ['maximum of zero', 'P6\n1 1\n0\n\0\0\0'],
    ['maximum too large', 'P6\n1 1\n70000\n\0\0\0'],
    ['zero width', 'P6\n0 1\n255\n'],
    ['zero height', 'P6\n1 0\n255\n'],
    ['too few samples', 'P6\n2 2\n255\n\0\0\0'],
    ['no separator after the header', 'P6\n1 1\n255'],
    ['text sample too large', 'P3\n1 1\n15\n99 0 0\n'],
    ['text samples missing', 'P3\n2 2\n255\n1 2 3\n'],
    ['text sample that is not a number', 'P3\n1 1\n255\n1 x 3\n'],
  ])('refuses %s', (_label, text) => {
    expect(() => decodePpm(Buffer.from(text, 'latin1'), LIMITS)).toThrow(ImageDecodeError);
  });

  it('survives a comment that never ends', () => {
    expect(() => decodePpm(Buffer.from(`P6\n# ${'x'.repeat(100_000)}`), LIMITS)).toThrow(
      ImageDecodeError,
    );
  });
});

describe('malformed BMP', () => {
  it.each([
    ['shorter than a header', Buffer.from('BM')],
    [
      'an unknown header size',
      (() => {
        const header = bmpHeader(1, 1, 24, { fileSize: 60 });
        header.writeUInt32LE(4000, 14);
        return header;
      })(),
    ],
    [
      'a header longer than the file',
      (() => {
        const header = bmpHeader(1, 1, 24);
        header.writeUInt32LE(124, 14);
        return header;
      })(),
    ],
    ['zero width', bmpHeader(0, 1, 24)],
    ['negative width', bmpHeader(-5, 1, 24)],
    ['an unsupported depth', bmpHeader(1, 1, 16, { fileSize: 60 })],
    ['compression', bmpHeader(1, 1, 24, { compression: 1, fileSize: 60 })],
    ['pixels past the end of the file', bmpHeader(10, 10, 24, { fileSize: 60 })],
    ['a pixel offset inside the header', bmpHeader(1, 1, 24, { pixelOffset: 10, fileSize: 60 })],
    [
      'a pixel offset past the end',
      bmpHeader(1, 1, 24, { pixelOffset: 4_000_000_000, fileSize: 60 }),
    ],
    [
      'a palette past the pixels',
      (() => {
        const header = bmpHeader(1, 1, 8, { pixelOffset: 58, fileSize: 70 });
        header.writeUInt32LE(256, 46);
        return header;
      })(),
    ],
    [
      'a palette larger than possible',
      (() => {
        const header = bmpHeader(1, 1, 8, { pixelOffset: 58, fileSize: 70 });
        header.writeUInt32LE(100_000, 46);
        return header;
      })(),
    ],
  ])('refuses %s', (_label, data) => {
    expect(() => decodeBmp(data, LIMITS)).toThrow(ImageDecodeError);
  });

  it('refuses a palette index outside a short palette', () => {
    const data = bmpHeader(1, 1, 8, { pixelOffset: 58, fileSize: 62 });
    data.writeUInt32LE(1, 46);
    data[58] = 200;
    expect(() => decodeBmp(data, LIMITS)).toThrow(/palette/);
  });
});

describe('extreme dimensions', () => {
  it.each([
    ['longer than the longest side', 'P6\n5000 1\n255\n'],
    ['more pixels than allowed', 'P6\n2000 2000\n255\n'],
    ['absurd width', 'P6\n999999999 999999999\n255\n'],
  ])('refuses a PPM %s, before allocating', (_label, text) => {
    const allocate = vi.spyOn(Buffer, 'allocUnsafe');
    expect(() => decodePpm(Buffer.from(text), LIMITS)).toThrow(/too|limit|longest/i);
    expect(allocate).not.toHaveBeenCalled();
    allocate.mockRestore();
  });

  it.each([
    ['too wide', bmpHeader(5000, 1, 24)],
    ['too many pixels', bmpHeader(2000, 2000, 24)],
    ['upside down and absurd', bmpHeader(1000, -2_000_000_000, 24)],
  ])('refuses a BMP %s, before allocating', (_label, data) => {
    const allocate = vi.spyOn(Buffer, 'allocUnsafe');
    expect(() => decodeBmp(data, LIMITS)).toThrow(/too|limit|longest/i);
    expect(allocate).not.toHaveBeenCalled();
    allocate.mockRestore();
  });

  it('allocates nothing for a tiny file claiming the most pixels allowed', () => {
    const allocate = vi.spyOn(Buffer, 'allocUnsafe');
    for (const text of ['P6\n1000 1000\n255\n', 'P3\n1000 1000\n255\n', 'P6\n1000 1000\n65535\n']) {
      expect(() => decodePpm(Buffer.from(text), LIMITS)).toThrow(/shorter/);
    }
    expect(() => decodeBmp(bmpHeader(1000, 1000, 24, { fileSize: 100 }), LIMITS)).toThrow(
      /shorter/,
    );
    expect(allocate).not.toHaveBeenCalled();
    allocate.mockRestore();
  });
});

describe('deadlines', () => {
  const big = () => {
    const side = 800;
    const header = Buffer.from(`P6\n${side} ${side}\n65535\n`);
    return Buffer.concat([header, Buffer.alloc(side * side * 3 * 2)]);
  };

  it('stops at the deadline, even though decoding is synchronous underneath', async () => {
    await expect(decodeWithDeadline(decodePpmSteps(big(), LIMITS), Date.now() - 1)).rejects.toThrow(
      /too long/,
    );
  });

  it('finishes within the deadline with the same result as one go', async () => {
    const data = big();
    const decoded = await decodeWithDeadline(decodePpmSteps(data, LIMITS), Date.now() + 60_000);
    expect(decoded.data.equals(decodePpm(data, LIMITS).data)).toBe(true);
  });

  it('lets other work run while a large image is decoded', async () => {
    let turns = 0;
    const timer = setInterval(() => {
      turns += 1;
    }, 0);
    await decodeWithDeadline(decodePpmSteps(big(), LIMITS), Date.now() + 60_000);
    clearInterval(timer);
    expect(turns).toBeGreaterThan(1);
  });

  it('applies to BMP as well', async () => {
    const side = 1000;
    const stride = side * 3;
    const data = Buffer.concat([bmpHeader(side, side, 24), Buffer.alloc(stride * side)]);
    await expect(decodeWithDeadline(decodeBmpSteps(data, LIMITS), Date.now() - 1)).rejects.toThrow(
      /too long/,
    );
    const decoded = await decodeWithDeadline(decodeBmpSteps(data, LIMITS), Date.now() + 60_000);
    expect(decoded.width).toBe(side);
  });
});

describe('processing an upload', () => {
  // A test can process more than one file, and each gets its own directory.
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function run(data: Buffer, limits: Parameters<typeof processImage>[3]) {
    const directory = await mkdtemp(join(tmpdir(), 'emucat-decoders-'));
    directories.push(directory);
    const original = join(directory, 'original');
    await writeFile(original, data);
    return processImage(
      original,
      join(directory, 'full.jpg'),
      join(directory, 'thumb.jpg'),
      limits,
    );
  }

  const limits = { ...LIMITS, timeoutSeconds: 30 };

  it('refuses a file over the input limit before reading it', async () => {
    const data = Buffer.concat([Buffer.from('P6\n2 2\n255\n'), Buffer.alloc(100)]);
    await expect(run(data, { ...limits, maxInputBytes: 16 })).rejects.toMatchObject({
      name: ImageRejectedError.name,
      code: 'image_too_large',
    });
  });

  it('reports malformed files as a rejection, which a retry cannot fix', async () => {
    await expect(run(Buffer.from('P6\n2 2\n255\n\0'), limits)).rejects.toMatchObject({
      name: ImageRejectedError.name,
      code: 'invalid_image',
    });
    await expect(run(Buffer.from('BM garbage garbage garbage'), limits)).rejects.toBeInstanceOf(
      ImageRejectedError,
    );
  });

  it('reports running out of time as a timeout, which a retry may fix', async () => {
    const side = 900;
    const data = Buffer.concat([
      Buffer.from(`P6\n${side} ${side}\n65535\n`),
      Buffer.alloc(side * side * 3 * 2),
    ]);
    await expect(run(data, { ...limits, timeoutSeconds: 0 })).rejects.toBeInstanceOf(
      ImageTimeoutError,
    );
  });

  it('still converts a well-formed file', async () => {
    const data = Buffer.concat([Buffer.from('P6\n2 2\n255\n'), Buffer.alloc(12, 0x80)]);
    const processed = await run(data, limits);
    expect(processed).toMatchObject({ format: 'ppm', widthPx: 2, heightPx: 2 });
  });
});
