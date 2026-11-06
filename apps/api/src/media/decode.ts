/**
 * What a file really is, from its first bytes, and decoders for the two formats `sharp` does not read.
 * Nothing here believes a file name, a MIME type or a size somebody else stated. Each decoder checks the
 * dimensions in the header against the limits before it allocates anything, which is what makes a small
 * file claiming to be enormous harmless.
 */

export type ImageFormat = 'png' | 'jpeg' | 'bmp' | 'ppm';

export const IMAGE_MIME_TYPES: Readonly<Record<ImageFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  bmp: 'image/bmp',
  ppm: 'image/x-portable-pixmap',
};

export const IMAGE_EXTENSIONS: Readonly<Record<ImageFormat, string>> = {
  png: 'png',
  jpeg: 'jpg',
  bmp: 'bmp',
  ppm: 'ppm',
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Needs the first 16 bytes. Anything it does not recognize is not an image EmuCat accepts. */
export function sniffImageFormat(head: Buffer): ImageFormat | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) return 'bmp';
  if (head.length >= 3 && head[0] === 0x50 && (head[1] === 0x36 || head[1] === 0x33)) {
    const next = head[2] as number;
    if (next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d || next === 0x23) {
      return 'ppm';
    }
  }
  return null;
}

export interface ImageLimits {
  maxPixels: number;
  maxDimension: number;
}

export type DecodeFailure = 'invalid' | 'unsupported' | 'too_large';

export class ImageDecodeError extends Error {
  override readonly name = 'ImageDecodeError';

  constructor(
    readonly failure: DecodeFailure,
    message: string,
  ) {
    super(message);
  }
}

const invalid = (message: string) => new ImageDecodeError('invalid', message);

export function checkDimensions(width: number, height: number, limits: ImageLimits): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw invalid('The image has no valid dimensions');
  }
  if (width > limits.maxDimension || height > limits.maxDimension) {
    throw new ImageDecodeError(
      'too_large',
      `The image is ${width} × ${height}, and the longest side allowed is ${limits.maxDimension}`,
    );
  }
  if (width * height > limits.maxPixels) {
    throw new ImageDecodeError(
      'too_large',
      `The image has ${width * height} pixels, and the limit is ${limits.maxPixels}`,
    );
  }
}

/** Uncompressed pixels, top to bottom, ready to hand to `sharp` as raw input. */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
}

function isPpmSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0b;
}

/** Reads one header number, skipping whitespace and comments. */
function readPpmNumber(data: Buffer, start: number): { value: number; next: number } {
  let position = start;
  for (;;) {
    const byte = data[position];
    if (byte === undefined) throw invalid('The PPM header is truncated');
    if (isPpmSpace(byte)) {
      position += 1;
    } else if (byte === 0x23) {
      while (position < data.length && data[position] !== 0x0a && data[position] !== 0x0d) {
        position += 1;
      }
    } else {
      break;
    }
  }
  let value = 0;
  let digits = 0;
  while (position < data.length) {
    const byte = data[position] as number;
    if (byte < 0x30 || byte > 0x39) break;
    value = value * 10 + (byte - 0x30);
    digits += 1;
    position += 1;
    if (digits > 9) throw invalid('A PPM header number is out of range');
  }
  if (digits === 0) throw invalid('The PPM header holds something other than a number');
  return { value, next: position };
}

/** Binary (`P6`, which is what QEMU's `screendump` writes) and text (`P3`), up to 16 bits a channel. */
export function decodePpm(data: Buffer, limits: ImageLimits): RawImage {
  const binary = data[1] === 0x36;
  const widthField = readPpmNumber(data, 2);
  const heightField = readPpmNumber(data, widthField.next);
  const maxField = readPpmNumber(data, heightField.next);
  const { value: width } = widthField;
  const { value: height } = heightField;
  const { value: maxValue } = maxField;
  if (maxValue < 1 || maxValue > 65535) throw invalid('The PPM maximum value is out of range');
  checkDimensions(width, height, limits);

  const samples = width * height * 3;
  const output = Buffer.allocUnsafe(samples);
  const scale = maxValue === 255 ? null : 255 / maxValue;

  if (binary) {
    // Exactly one whitespace byte separates the header from the samples.
    const whitespace = data[maxField.next];
    if (whitespace === undefined || !isPpmSpace(whitespace)) {
      throw invalid('The PPM header does not end correctly');
    }
    const start = maxField.next + 1;
    const wide = maxValue > 255;
    if (data.length - start < samples * (wide ? 2 : 1)) {
      throw invalid('The PPM file is shorter than its header says');
    }
    if (!wide && scale === null) {
      data.copy(output, 0, start, start + samples);
    } else {
      for (let index = 0; index < samples; index += 1) {
        const value = wide ? data.readUInt16BE(start + index * 2) : (data[start + index] as number);
        output[index] = Math.min(255, Math.round(value * (scale as number)));
      }
    }
  } else {
    let position = maxField.next;
    for (let index = 0; index < samples; index += 1) {
      const sample = readPpmNumber(data, position);
      if (sample.value > maxValue) throw invalid('A PPM sample is above the maximum value');
      output[index] = scale === null ? sample.value : Math.round(sample.value * scale);
      position = sample.next;
    }
  }
  return { data: output, width, height, channels: 3 };
}

const BI_RGB = 0;
const BI_BITFIELDS = 3;
const BI_ALPHABITFIELDS = 6;
const LE_MASKS = { red: 0x00ff0000, green: 0x0000ff00, blue: 0x000000ff };

/**
 * Uncompressed Windows bitmaps: 8-bit palette, 24-bit and 32-bit, which is what 86Box and the tools
 * around it write. Compressed and exotic variants are refused rather than guessed at.
 */
export function decodeBmp(data: Buffer, limits: ImageLimits): RawImage {
  if (data.length < 26) throw invalid('The BMP header is truncated');
  const pixelOffset = data.readUInt32LE(10);
  const headerSize = data.readUInt32LE(14);
  if (headerSize < 40 || headerSize > 124) {
    throw new ImageDecodeError('unsupported', 'This BMP header version is not supported');
  }
  if (data.length < 14 + headerSize) throw invalid('The BMP header is truncated');

  const width = data.readInt32LE(18);
  const rawHeight = data.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const bitsPerPixel = data.readUInt16LE(28);
  const compression = data.readUInt32LE(30);
  checkDimensions(width, height, limits);
  if (bitsPerPixel !== 8 && bitsPerPixel !== 24 && bitsPerPixel !== 32) {
    throw new ImageDecodeError('unsupported', `A ${bitsPerPixel}-bit BMP is not supported`);
  }

  let hasAlpha = false;
  if (compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) {
    if (bitsPerPixel !== 32 || data.length < 14 + 40 + 12) {
      throw new ImageDecodeError('unsupported', 'This BMP layout is not supported');
    }
    const red = data.readUInt32LE(54);
    const green = data.readUInt32LE(58);
    const blue = data.readUInt32LE(62);
    if (red !== LE_MASKS.red || green !== LE_MASKS.green || blue !== LE_MASKS.blue) {
      throw new ImageDecodeError('unsupported', 'This BMP channel layout is not supported');
    }
    hasAlpha = headerSize >= 56 && data.length >= 70 && data.readUInt32LE(66) === 0xff000000;
  } else if (compression !== BI_RGB) {
    throw new ImageDecodeError('unsupported', 'A compressed BMP is not supported');
  }

  const stride = Math.ceil((width * bitsPerPixel) / 32) * 4;
  if (pixelOffset < 14 + headerSize || pixelOffset + stride * height > data.length) {
    throw invalid('The BMP file is shorter than its header says');
  }

  let palette: Buffer | null = null;
  if (bitsPerPixel === 8) {
    const colors = data.readUInt32LE(46) || 256;
    const paletteStart = 14 + headerSize;
    if (colors > 256 || paletteStart + colors * 4 > pixelOffset) {
      throw invalid('The BMP palette is out of range');
    }
    palette = data.subarray(paletteStart, paletteStart + colors * 4);
  }

  const channels = hasAlpha ? 4 : 3;
  const output = Buffer.allocUnsafe(width * height * channels);
  let target = 0;
  for (let row = 0; row < height; row += 1) {
    const source = pixelOffset + (topDown ? row : height - 1 - row) * stride;
    for (let column = 0; column < width; column += 1) {
      if (palette) {
        const index = (data[source + column] as number) * 4;
        if (index + 2 >= palette.length) throw invalid('A BMP pixel is outside the palette');
        output[target] = palette[index + 2] as number;
        output[target + 1] = palette[index + 1] as number;
        output[target + 2] = palette[index] as number;
      } else {
        const pixel = source + column * (bitsPerPixel / 8);
        output[target] = data[pixel + 2] as number;
        output[target + 1] = data[pixel + 1] as number;
        output[target + 2] = data[pixel] as number;
        if (hasAlpha) output[target + 3] = data[pixel + 3] as number;
      }
      target += channels;
    }
  }
  return { data: output, width, height, channels };
}
