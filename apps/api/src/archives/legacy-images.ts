import {
  checkDimensions,
  ImageDecodeError,
  type ImageLimits,
  type RawImage,
} from '../media/decode.js';

/**
 * Decoders for two legacy image formats no installed library reads (decision 0056): ZSoft PCX and Truevision TGA,
 * as DOS and early Windows tools wrote them. Like the screenshot decoders (decision 0025) they check dimensions before
 * allocating, never read past their input, and yield every few rows so that a deadline can stop them.
 *
 * Supported variants, and nothing else:
 * - PCX: RLE-encoded, 8 bits in 1 plane with a 256-colour palette (or grey when the file has none), 8 bits in 3
 *   planes (24-bit RGB), 1 bit in 1 plane (monochrome) and 1 bit in 4 planes (16-colour EGA, header palette).
 * - TGA: types 1, 2, 3 (colour-mapped, true-colour, grey) and their RLE forms 9, 10, 11; 8-bit maps and grey; 15,
 *   16, 24 and 32 bits per pixel; either vertical origin. Right-to-left images are not mirrored.
 */

const invalid = (message: string) => new ImageDecodeError('invalid', message);
const unsupported = (message: string) => new ImageDecodeError('unsupported', message);
const ROWS_PER_SLICE = 64;

export function* decodePcxSteps(data: Buffer, limits: ImageLimits): Generator<void, RawImage> {
  if (data.length < 128 || data[0] !== 0x0a || data[2] !== 1) throw invalid('Not a PCX image');
  const bitsPerPixel = data[3] as number;
  const width = data.readUInt16LE(8) - data.readUInt16LE(4) + 1;
  const height = data.readUInt16LE(10) - data.readUInt16LE(6) + 1;
  const planes = data[65] as number;
  const bytesPerLine = data.readUInt16LE(66);
  checkDimensions(width, height, limits);
  const layout = `${bitsPerPixel}x${planes}`;
  if (!['8x1', '8x3', '1x1', '1x4'].includes(layout)) {
    throw unsupported(`PCX with ${bitsPerPixel} bits in ${planes} planes is not supported`);
  }
  if (bytesPerLine * 8 < width * bitsPerPixel || bytesPerLine === 0) {
    throw invalid('The PCX line length is too short for its width');
  }
  const lineBytes = bytesPerLine * planes;
  // RLE can compress at most 63:1, so a file this short cannot hold the image it claims.
  if ((data.length - 128) * 63 < lineBytes * height) throw invalid('The PCX file is truncated');

  let palette: Buffer | null = null;
  if (layout === '8x1' && data.length >= 128 + 769 && data[data.length - 769] === 0x0c) {
    palette = data.subarray(data.length - 768);
  }
  const ega = data.subarray(16, 64);
  const output = Buffer.alloc(width * height * 3);
  const line = Buffer.alloc(lineBytes);
  let position = 128;
  for (let y = 0; y < height; y += 1) {
    let filled = 0;
    while (filled < lineBytes) {
      if (position >= data.length) throw invalid('The PCX image data ends early');
      const byte = data[position++] as number;
      if ((byte & 0xc0) === 0xc0) {
        if (position >= data.length) throw invalid('The PCX image data ends early');
        const value = data[position++] as number;
        const count = Math.min(byte & 0x3f, lineBytes - filled);
        line.fill(value, filled, filled + count);
        filled += count;
      } else {
        line[filled++] = byte;
      }
    }
    const row = y * width * 3;
    for (let x = 0; x < width; x += 1) {
      const at = row + x * 3;
      if (layout === '8x3') {
        output[at] = line[x] as number;
        output[at + 1] = line[bytesPerLine + x] as number;
        output[at + 2] = line[2 * bytesPerLine + x] as number;
        continue;
      }
      let index: number;
      if (layout === '8x1') index = line[x] as number;
      else {
        const bit = 7 - (x & 7);
        const byteAt = x >> 3;
        index = 0;
        for (let plane = 0; plane < planes; plane += 1) {
          index |= (((line[plane * bytesPerLine + byteAt] as number) >> bit) & 1) << plane;
        }
      }
      if (layout === '8x1') {
        if (palette) palette.copy(output, at, index * 3, index * 3 + 3);
        else output.fill(index, at, at + 3);
      } else if (layout === '1x1') {
        output.fill(index ? 255 : 0, at, at + 3);
      } else {
        ega.copy(output, at, index * 3, index * 3 + 3);
      }
    }
    if (y % ROWS_PER_SLICE === ROWS_PER_SLICE - 1) yield;
  }
  return { data: output, width, height, channels: 3 };
}

/** One TGA pixel (or colour-map entry) of `depth` bits at `at`, as RGBA. */
function tgaColor(
  data: Buffer,
  at: number,
  depth: number,
  alpha: boolean,
  out: Buffer,
  to: number,
) {
  if (depth === 8) {
    const grey = data[at] as number;
    out[to] = grey;
    out[to + 1] = grey;
    out[to + 2] = grey;
    out[to + 3] = 255;
  } else if (depth === 15 || depth === 16) {
    const value = data.readUInt16LE(at);
    out[to] = (((value >> 10) & 0x1f) * 255) / 31;
    out[to + 1] = (((value >> 5) & 0x1f) * 255) / 31;
    out[to + 2] = ((value & 0x1f) * 255) / 31;
    out[to + 3] = depth === 16 && alpha ? (value & 0x8000 ? 255 : 0) : 255;
  } else {
    out[to] = data[at + 2] as number;
    out[to + 1] = data[at + 1] as number;
    out[to + 2] = data[at] as number;
    out[to + 3] = depth === 32 && alpha ? (data[at + 3] as number) : 255;
  }
}

export function* decodeTgaSteps(data: Buffer, limits: ImageLimits): Generator<void, RawImage> {
  if (data.length < 18) throw invalid('Not a TGA image');
  const idLength = data[0] as number;
  const colorMapType = data[1] as number;
  const type = data[2] as number;
  const mapFirst = data.readUInt16LE(3);
  const mapLength = data.readUInt16LE(5);
  const mapDepth = data[7] as number;
  const width = data.readUInt16LE(12);
  const height = data.readUInt16LE(14);
  const depth = data[16] as number;
  const descriptor = data[17] as number;
  if (![1, 2, 3, 9, 10, 11].includes(type))
    throw unsupported('This TGA image type is not supported');
  checkDimensions(width, height, limits);
  const mapped = type === 1 || type === 9;
  const rle = type >= 9;
  if (mapped && (colorMapType !== 1 || depth !== 8)) throw invalid('The TGA colour map is wrong');
  if ((type === 3 || type === 11) && depth !== 8) throw invalid('A grey TGA has 8 bits a pixel');
  if (!mapped && type !== 3 && type !== 11 && ![15, 16, 24, 32].includes(depth)) {
    throw unsupported(`TGA with ${depth} bits a pixel is not supported`);
  }
  const alpha = (descriptor & 0x0f) > 0;
  const mapEntryBytes = colorMapType === 1 ? Math.ceil(mapDepth / 8) : 0;
  if (colorMapType === 1 && ![15, 16, 24, 32].includes(mapDepth)) {
    throw unsupported('This TGA colour map depth is not supported');
  }
  const mapStart = 18 + idLength;
  let position = mapStart + mapLength * mapEntryBytes;
  if (position > data.length) throw invalid('The TGA file is truncated');
  const pixelBytes = Math.ceil(depth / 8);
  const pixels = width * height;
  if (!rle && data.length - position < pixels * pixelBytes)
    throw invalid('The TGA file is truncated');
  // RLE stores at most 128 pixels in one packet of 1 + pixelBytes bytes.
  if (rle && (data.length - position) * 128 < pixels) throw invalid('The TGA file is truncated');

  const map = mapped ? Buffer.alloc(mapLength * 4) : null;
  if (map) {
    for (let index = 0; index < mapLength; index += 1) {
      tgaColor(data, mapStart + index * mapEntryBytes, mapDepth, alpha, map, index * 4);
    }
  }
  const output = Buffer.alloc(pixels * 4);
  const topDown = (descriptor & 0x20) !== 0;
  const put = (pixel: number, from: number) => {
    const y = Math.floor(pixel / width);
    const row = topDown ? y : height - 1 - y;
    const to = (row * width + (pixel % width)) * 4;
    if (map) {
      const index = (data[from] as number) - mapFirst;
      if (index < 0 || index >= mapLength) throw invalid('A TGA pixel is outside its colour map');
      map.copy(output, to, index * 4, index * 4 + 4);
    } else {
      tgaColor(data, from, depth, alpha, output, to);
    }
  };
  const slice = width * ROWS_PER_SLICE;
  let pixel = 0;
  let nextYield = slice;
  while (pixel < pixels) {
    if (rle) {
      if (position >= data.length) throw invalid('The TGA image data ends early');
      const header = data[position++] as number;
      const count = Math.min((header & 0x7f) + 1, pixels - pixel);
      if (header & 0x80) {
        if (position + pixelBytes > data.length) throw invalid('The TGA image data ends early');
        for (let index = 0; index < count; index += 1) put(pixel++, position);
        position += pixelBytes;
      } else {
        if (position + count * pixelBytes > data.length) {
          throw invalid('The TGA image data ends early');
        }
        for (let index = 0; index < count; index += 1) {
          put(pixel++, position);
          position += pixelBytes;
        }
      }
    } else {
      put(pixel++, position);
      position += pixelBytes;
    }
    if (pixel >= nextYield) {
      nextYield = pixel + slice;
      yield;
    }
  }
  return { data: output, width, height, channels: 4 };
}
