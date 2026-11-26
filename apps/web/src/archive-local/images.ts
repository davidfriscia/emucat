import type { PreviewImageFormat } from '@emucat/contracts/archive-preview';
import { u16, u32 } from './bytes';
import { LocalArchiveError } from './errors';

/**
 * Images of files inside a nested archive, in the browser (decision 0058).
 *
 * PNG, JPEG, GIF, WebP, BMP and ICO are drawn by the browser itself, as for a top-level file; their dimensions are
 * read from their headers first, so that one claiming more than the pixel limit is never handed to the decoder.
 * PPM, PCX and TGA are decoded here to RGBA by ports of the server's own bounded decoders (decisions 0025 and 0056):
 * dimensions are checked before anything is allocated, input is never read past its end, and the decoders yield
 * every few rows so that a cancel or a deadline can stop them. TIFF has no such decoder in the browser and is shown
 * as bytes only.
 */

export interface ImageSize {
  width: number;
  height: number;
}

export interface RgbaImage extends ImageSize {
  /** Four bytes a pixel, rows top to bottom. */
  data: Uint8ClampedArray;
}

const invalid = () => new LocalArchiveError('image_invalid');

/** The longest side a canvas is asked to hold. */
export const MAX_IMAGE_SIDE = 16_384;

export function checkImageSize(size: ImageSize, maxPixels: number): void {
  const { width, height } = size;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw invalid();
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > maxPixels) {
    throw new LocalArchiveError('image_too_large');
  }
}

const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u32be = (b: Uint8Array, at: number) => ((u16be(b, at) << 16) | u16be(b, at + 2)) >>> 0;

function jpegSize(bytes: Uint8Array): ImageSize | null {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] as number;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = u16be(bytes, at + 2);
    if (length < 2) return null;
    // Start of frame: baseline, extended, progressive and lossless, not DHT (C4), JPG (C8) or DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): ImageSize | null {
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === 'VP8X' && bytes.length >= 30) {
    const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
    const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
    return { width, height };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = u32(bytes, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return { width: u16(bytes, 26) & 0x3fff, height: u16(bytes, 28) & 0x3fff };
  }
  return null;
}

function icoSize(bytes: Uint8Array): ImageSize | null {
  const count = u16(bytes, 4);
  let best: ImageSize | null = null;
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    if (at + 16 > bytes.length) return null;
    const width = (bytes[at] as number) || 256;
    const height = (bytes[at + 1] as number) || 256;
    if (!best || width * height > best.width * best.height) best = { width, height };
  }
  return best;
}

/** Dimensions of an image the browser draws itself, from its header only, or `null` when they cannot be read. */
export function browserImageSize(bytes: Uint8Array, format: PreviewImageFormat): ImageSize | null {
  switch (format) {
    case 'png':
      return bytes.length >= 24 ? { width: u32be(bytes, 16), height: u32be(bytes, 20) } : null;
    case 'gif':
      return bytes.length >= 10 ? { width: u16(bytes, 6), height: u16(bytes, 8) } : null;
    case 'bmp': {
      if (bytes.length < 26) return null;
      if (u32(bytes, 14) === 12) return { width: u16(bytes, 18), height: u16(bytes, 20) };
      const width = u32(bytes, 18) | 0;
      const height = u32(bytes, 22) | 0;
      return { width: Math.abs(width), height: Math.abs(height) };
    }
    case 'jpeg':
      return jpegSize(bytes);
    case 'webp':
      return webpSize(bytes);
    case 'ico':
      return icoSize(bytes);
    default:
      return null;
  }
}

// --- Legacy decoders ------------------------------------------------------------------------------------------

const ROWS_PER_SLICE = 64;

function isPpmSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0b;
}

function readPpmNumber(data: Uint8Array, start: number): { value: number; next: number } {
  let position = start;
  for (;;) {
    const byte = data[position];
    if (byte === undefined) throw invalid();
    if (isPpmSpace(byte)) position += 1;
    else if (byte === 0x23) {
      while (position < data.length && data[position] !== 0x0a && data[position] !== 0x0d)
        position += 1;
    } else break;
  }
  let value = 0;
  let digits = 0;
  while (position < data.length) {
    const byte = data[position] as number;
    if (byte < 0x30 || byte > 0x39) break;
    value = value * 10 + (byte - 0x30);
    digits += 1;
    position += 1;
    if (digits > 9) throw invalid();
  }
  if (digits === 0) throw invalid();
  return { value, next: position };
}

export function* decodePpm(data: Uint8Array, maxPixels: number): Generator<void, RgbaImage> {
  if (data[0] !== 0x50 || (data[1] !== 0x36 && data[1] !== 0x33)) throw invalid();
  const binary = data[1] === 0x36;
  const widthField = readPpmNumber(data, 2);
  const heightField = readPpmNumber(data, widthField.next);
  const maxField = readPpmNumber(data, heightField.next);
  const width = widthField.value;
  const height = heightField.value;
  const maxValue = maxField.value;
  if (maxValue < 1 || maxValue > 65535) throw invalid();
  checkImageSize({ width, height }, maxPixels);
  const pixels = width * height;
  const scale = 255 / maxValue;
  const wide = maxValue > 255;
  let position = maxField.next;
  if (binary) {
    if (!isPpmSpace(data[position] ?? 0)) throw invalid();
    position += 1;
    if (data.length - position < pixels * 3 * (wide ? 2 : 1)) throw invalid();
  } else if (data.length - position < pixels * 6 - 1) {
    throw invalid();
  }
  const output = new Uint8ClampedArray(pixels * 4);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      let value: number;
      if (binary) {
        value = wide ? u16be(data, position) : (data[position] as number);
        position += wide ? 2 : 1;
      } else {
        const sample = readPpmNumber(data, position);
        if (sample.value > maxValue) throw invalid();
        value = sample.value;
        position = sample.next;
      }
      output[pixel * 4 + channel] = Math.round(value * scale);
    }
    output[pixel * 4 + 3] = 255;
    if (pixel % (width * ROWS_PER_SLICE) === width * ROWS_PER_SLICE - 1) yield;
  }
  return { data: output, width, height };
}

export function* decodePcx(data: Uint8Array, maxPixels: number): Generator<void, RgbaImage> {
  if (data.length < 128 || data[0] !== 0x0a || data[2] !== 1) throw invalid();
  const bitsPerPixel = data[3] as number;
  const width = u16(data, 8) - u16(data, 4) + 1;
  const height = u16(data, 10) - u16(data, 6) + 1;
  const planes = data[65] as number;
  const bytesPerLine = u16(data, 66);
  checkImageSize({ width, height }, maxPixels);
  const layout = `${bitsPerPixel}x${planes}`;
  if (!['8x1', '8x3', '1x1', '1x4'].includes(layout)) throw invalid();
  if (bytesPerLine * 8 < width * bitsPerPixel || bytesPerLine === 0) throw invalid();
  const lineBytes = bytesPerLine * planes;
  if ((data.length - 128) * 63 < lineBytes * height) throw invalid();
  let palette: Uint8Array | null = null;
  if (layout === '8x1' && data.length >= 128 + 769 && data[data.length - 769] === 0x0c) {
    palette = data.subarray(data.length - 768);
  }
  const ega = data.subarray(16, 64);
  const output = new Uint8ClampedArray(width * height * 4);
  const line = new Uint8Array(lineBytes);
  let position = 128;
  for (let y = 0; y < height; y += 1) {
    let filled = 0;
    while (filled < lineBytes) {
      if (position >= data.length) throw invalid();
      const byte = data[position++] as number;
      if ((byte & 0xc0) === 0xc0) {
        if (position >= data.length) throw invalid();
        const value = data[position++] as number;
        const count = Math.min(byte & 0x3f, lineBytes - filled);
        line.fill(value, filled, filled + count);
        filled += count;
      } else {
        line[filled++] = byte;
      }
    }
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      output[at + 3] = 255;
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
        const source = palette ?? null;
        for (let channel = 0; channel < 3; channel += 1) {
          output[at + channel] = source ? (source[index * 3 + channel] as number) : index;
        }
      } else if (layout === '1x1') {
        output.fill(index ? 255 : 0, at, at + 3);
      } else {
        for (let channel = 0; channel < 3; channel += 1)
          output[at + channel] = ega[index * 3 + channel] as number;
      }
    }
    if (y % ROWS_PER_SLICE === ROWS_PER_SLICE - 1) yield;
  }
  return { data: output, width, height };
}

function tgaColor(
  data: Uint8Array,
  at: number,
  depth: number,
  alpha: boolean,
  out: Uint8ClampedArray,
  to: number,
) {
  if (depth === 8) {
    const grey = data[at] as number;
    out[to] = grey;
    out[to + 1] = grey;
    out[to + 2] = grey;
    out[to + 3] = 255;
  } else if (depth === 15 || depth === 16) {
    const value = u16(data, at);
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

export function* decodeTga(data: Uint8Array, maxPixels: number): Generator<void, RgbaImage> {
  if (data.length < 18) throw invalid();
  const idLength = data[0] as number;
  const colorMapType = data[1] as number;
  const type = data[2] as number;
  const mapFirst = u16(data, 3);
  const mapLength = u16(data, 5);
  const mapDepth = data[7] as number;
  const width = u16(data, 12);
  const height = u16(data, 14);
  const depth = data[16] as number;
  const descriptor = data[17] as number;
  if (![1, 2, 3, 9, 10, 11].includes(type)) throw invalid();
  checkImageSize({ width, height }, maxPixels);
  const mapped = type === 1 || type === 9;
  const rle = type >= 9;
  if (mapped && (colorMapType !== 1 || depth !== 8)) throw invalid();
  if ((type === 3 || type === 11) && depth !== 8) throw invalid();
  if (!mapped && type !== 3 && type !== 11 && ![15, 16, 24, 32].includes(depth)) throw invalid();
  const alpha = (descriptor & 0x0f) > 0;
  const mapEntryBytes = colorMapType === 1 ? Math.ceil(mapDepth / 8) : 0;
  if (colorMapType === 1 && ![15, 16, 24, 32].includes(mapDepth)) throw invalid();
  const mapStart = 18 + idLength;
  let position = mapStart + mapLength * mapEntryBytes;
  if (position > data.length) throw invalid();
  const pixelBytes = Math.ceil(depth / 8);
  const pixels = width * height;
  if (!rle && data.length - position < pixels * pixelBytes) throw invalid();
  if (rle && (data.length - position) * 128 < pixels) throw invalid();
  const map = mapped ? new Uint8ClampedArray(mapLength * 4) : null;
  if (map) {
    for (let index = 0; index < mapLength; index += 1) {
      tgaColor(data, mapStart + index * mapEntryBytes, mapDepth, alpha, map, index * 4);
    }
  }
  const output = new Uint8ClampedArray(pixels * 4);
  const topDown = (descriptor & 0x20) !== 0;
  const put = (pixel: number, from: number) => {
    const y = Math.floor(pixel / width);
    const row = topDown ? y : height - 1 - y;
    const to = (row * width + (pixel % width)) * 4;
    if (map) {
      const index = (data[from] as number) - mapFirst;
      if (index < 0 || index >= mapLength) throw invalid();
      output.set(map.subarray(index * 4, index * 4 + 4), to);
    } else {
      tgaColor(data, from, depth, alpha, output, to);
    }
  };
  const slice = width * ROWS_PER_SLICE;
  let pixel = 0;
  let nextYield = slice;
  while (pixel < pixels) {
    if (rle) {
      if (position >= data.length) throw invalid();
      const header = data[position++] as number;
      const count = Math.min((header & 0x7f) + 1, pixels - pixel);
      if (header & 0x80) {
        if (position + pixelBytes > data.length) throw invalid();
        for (let index = 0; index < count; index += 1) put(pixel++, position);
        position += pixelBytes;
      } else {
        if (position + count * pixelBytes > data.length) throw invalid();
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
  return { data: output, width, height };
}

export const LEGACY_DECODERS: Partial<
  Record<PreviewImageFormat, (data: Uint8Array, maxPixels: number) => Generator<void, RgbaImage>>
> = { ppm: decodePpm, pcx: decodePcx, tga: decodeTga };
