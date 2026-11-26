import {
  BROWSER_IMAGE_FORMATS,
  PREVIEW_IMAGE_MIME,
  sniffPreviewImage,
  type PreviewImageFormat,
} from '@emucat/contracts';
import sharp from 'sharp';
import {
  checkDimensions,
  decodePpmSteps,
  decodeWithDeadline,
  ImageDecodeError,
  type RawImage,
} from '../media/decode.js';
import { decodePcxSteps, decodeTgaSteps } from './legacy-images.js';

/**
 * An archive image made ready for a browser (decision 0056), entirely in memory. The format is the one its bytes
 * show, never its name's. Dimensions are read from the header and checked before any pixel is decoded. Formats a
 * browser shows itself are passed through unchanged after that check; PPM, TIFF, PCX and TGA are decoded and
 * re-encoded as PNG, so that the browser only ever decodes a format it knows. SVG is never an image here: it is shown
 * as text.
 */

export interface ImageLimitsForPreview {
  maxPixels: number;
  timeoutMs: number;
}

export interface PreparedImage {
  body: Buffer;
  contentType: string;
  format: PreviewImageFormat;
  width: number;
  height: number;
  converted: boolean;
}

export class ImagePreviewError extends Error {
  override readonly name = 'ImagePreviewError';

  constructor(
    readonly kind: 'invalid' | 'too_large' | 'unsupported' | 'timeout',
    message: string,
  ) {
    super(message);
  }
}

const MAX_DIMENSION = 32_768;
const MAX_FRAMES = 1000;

function bmpDimensions(data: Buffer): { width: number; height: number } {
  if (data.length < 26) throw new ImagePreviewError('invalid', 'The BMP header is truncated');
  const headerSize = data.readUInt32LE(14);
  if (headerSize === 12) return { width: data.readUInt16LE(18), height: data.readUInt16LE(20) };
  return { width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) };
}

function icoDimensions(data: Buffer): { width: number; height: number } {
  const count = data.readUInt16LE(4);
  if (data.length < 6 + 16 * count) throw new ImagePreviewError('invalid', 'The icon is truncated');
  let width = 0;
  let height = 0;
  for (let index = 0; index < count; index += 1) {
    const at = 6 + 16 * index;
    const size = data.readUInt32LE(at + 8);
    const offset = data.readUInt32LE(at + 12);
    if (offset + size > data.length || size === 0) {
      throw new ImagePreviewError('invalid', 'An icon image lies outside the file');
    }
    width = Math.max(width, data[at] || 256);
    height = Math.max(height, data[at + 1] || 256);
  }
  return { width, height };
}

function limitsOf(limits: ImageLimitsForPreview) {
  return { maxPixels: limits.maxPixels, maxDimension: MAX_DIMENSION };
}

function fromDecoder(error: unknown): never {
  if (error instanceof ImagePreviewError) throw error;
  if (error instanceof ImageDecodeError) {
    throw new ImagePreviewError(
      error.failure === 'too_large'
        ? 'too_large'
        : error.failure === 'timeout'
          ? 'timeout'
          : error.failure === 'unsupported'
            ? 'unsupported'
            : 'invalid',
      error.message,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message))
    throw new ImagePreviewError('timeout', 'Converting the image took too long');
  if (/pixel limit/i.test(message))
    throw new ImagePreviewError('too_large', 'The image has too many pixels');
  // Library messages are not passed on: they go nowhere but here.
  throw new ImagePreviewError('invalid', 'The image could not be decoded');
}

async function toPng(input: RawImage | Buffer, limits: ImageLimitsForPreview): Promise<Buffer> {
  const options = { limitInputPixels: limits.maxPixels, failOn: 'error' } as const;
  const image = Buffer.isBuffer(input)
    ? sharp(input, { ...options, pages: 1 })
    : sharp(input.data, {
        ...options,
        raw: { width: input.width, height: input.height, channels: input.channels },
      });
  return image
    .timeout({ seconds: Math.max(1, Math.ceil(limits.timeoutMs / 1000)) })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

export async function prepareImage(
  data: Buffer,
  name: string,
  limits: ImageLimitsForPreview,
  signal?: AbortSignal,
): Promise<PreparedImage> {
  const format = sniffPreviewImage(data, name);
  if (!format)
    throw new ImagePreviewError('unsupported', 'This is not an image format the server reads');
  const deadline = Date.now() + limits.timeoutMs;
  try {
    let width: number;
    let height: number;
    if (format === 'bmp' || format === 'ico') {
      ({ width, height } = format === 'bmp' ? bmpDimensions(data) : icoDimensions(data));
      checkDimensions(width, height, limitsOf(limits));
    } else if (
      format === 'png' ||
      format === 'jpeg' ||
      format === 'gif' ||
      format === 'webp' ||
      format === 'tiff'
    ) {
      const metadata = await sharp(data, { failOn: 'error', limitInputPixels: false }).metadata();
      if (metadata.format !== format) {
        throw new ImagePreviewError('invalid', 'The image’s contents do not match its signature');
      }
      width = metadata.width;
      height = metadata.height;
      checkDimensions(width, height, limitsOf(limits));
      if ((metadata.pages ?? 1) > MAX_FRAMES) {
        throw new ImagePreviewError('too_large', 'The image has too many frames');
      }
    } else {
      width = 0;
      height = 0;
    }
    if (signal?.aborted) throw signal.reason;
    if (BROWSER_IMAGE_FORMATS.has(format)) {
      return {
        body: data,
        contentType: PREVIEW_IMAGE_MIME[format],
        format,
        width,
        height,
        converted: false,
      };
    }
    let body: Buffer;
    if (format === 'tiff') {
      body = await toPng(data, limits);
    } else {
      const decoder =
        format === 'ppm'
          ? decodePpmSteps(data, limitsOf(limits))
          : format === 'pcx'
            ? decodePcxSteps(data, limitsOf(limits))
            : decodeTgaSteps(data, limitsOf(limits));
      const raw = await decodeWithDeadline(decoder, deadline);
      if (signal?.aborted) throw signal.reason;
      width = raw.width;
      height = raw.height;
      body = await toPng(raw, limits);
    }
    return { body, contentType: 'image/png', format, width, height, converted: true };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return fromDecoder(error);
  }
}
