import { open, readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import {
  checkDimensions,
  decodeBmp,
  decodePpm,
  IMAGE_EXTENSIONS,
  IMAGE_MIME_TYPES,
  ImageDecodeError,
  sniffImageFormat,
  type ImageFormat,
  type ImageLimits,
  type RawImage,
} from './decode.js';

/** The longest side of a thumbnail. Smaller images are never scaled up. */
export const THUMBNAIL_MAX_DIMENSION = 400;
const FULL_JPEG_QUALITY = 92;
const THUMBNAIL_JPEG_QUALITY = 82;
/** JPEG has no transparency. Screenshots rarely have any, and white is what a viewer would assume. */
export const ALPHA_BACKGROUND = '#ffffff';

export interface ProcessingLimits extends ImageLimits {
  timeoutSeconds: number;
}

export interface ProcessedImage {
  format: ImageFormat;
  mimeType: string;
  extension: string;
  widthPx: number;
  heightPx: number;
}

/** An image that was examined and refused. Trying again with the same bytes cannot help. */
export class ImageRejectedError extends Error {
  override readonly name = 'ImageRejectedError';

  constructor(
    readonly code: 'invalid_image' | 'unsupported_image' | 'image_too_large',
    message: string,
  ) {
    super(message);
  }
}

/** The server ran out of time, which depends on how busy it is, so a later attempt may succeed. */
export class ImageTimeoutError extends Error {
  override readonly name = 'ImageTimeoutError';
}

const HEAD_BYTES = 16;

async function readHead(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function toRejection(error: unknown): unknown {
  if (error instanceof ImageDecodeError) {
    const code =
      error.failure === 'invalid'
        ? 'invalid_image'
        : error.failure === 'unsupported'
          ? 'unsupported_image'
          : 'image_too_large';
    return new ImageRejectedError(code, error.message);
  }
  return error;
}

/** `sharp` says "timeout" for its own limit, and something about pixels for its input limit. */
function fromSharp(error: unknown): unknown {
  if (error instanceof ImageRejectedError || error instanceof ImageTimeoutError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) return new ImageTimeoutError('Image processing took too long');
  if (/pixel limit/i.test(message)) {
    return new ImageRejectedError('image_too_large', 'The image has too many pixels');
  }
  // Library messages can hold paths, so they go to the log and not into a response.
  return new ImageRejectedError('invalid_image', 'The image could not be decoded');
}

function pipeline(input: string | RawImage, limits: ProcessingLimits): sharp.Sharp {
  const shared = {
    limitInputPixels: limits.maxPixels,
    failOn: 'error',
  } as const;
  const image =
    typeof input === 'string'
      ? sharp(input, shared)
      : sharp(input.data, {
          ...shared,
          raw: { width: input.width, height: input.height, channels: input.channels },
        });
  return image.timeout({ seconds: limits.timeoutSeconds });
}

/**
 * Examines the uploaded file, and writes the two JPEGs next to it. It only writes to the paths it is
 * given: nothing becomes visible until the caller publishes them. Metadata is dropped from both, so a
 * camera's or a tool's details in an original never reach what the public can see.
 */
export async function processImage(
  originalPath: string,
  fullPath: string,
  thumbnailPath: string,
  limits: ProcessingLimits,
): Promise<ProcessedImage> {
  const format = sniffImageFormat(await readHead(originalPath));
  if (!format) {
    throw new ImageRejectedError('unsupported_image', 'This is not a PNG, JPEG, BMP or PPM image');
  }

  let input: string | RawImage = originalPath;
  try {
    if (format === 'ppm' || format === 'bmp') {
      // These are decoded here, since the file size is already bounded by the upload limit.
      if ((await stat(originalPath)).size === 0) {
        throw new ImageRejectedError('invalid_image', 'The file is empty');
      }
      const data = await readFile(originalPath);
      input = format === 'ppm' ? decodePpm(data, limits) : decodeBmp(data, limits);
    } else {
      // A header is enough to refuse an image with absurd dimensions, without decoding a pixel.
      const metadata = await pipeline(originalPath, limits).metadata();
      checkDimensions(metadata.width, metadata.height, limits);
      const actual = metadata.format === 'jpeg' ? 'jpeg' : metadata.format;
      if (actual !== format) {
        throw new ImageRejectedError('invalid_image', 'The file’s contents do not match its type');
      }
    }
  } catch (error) {
    throw fromSharp(toRejection(error));
  }

  try {
    const full = await pipeline(input, limits)
      .rotate()
      .flatten({ background: ALPHA_BACKGROUND })
      .toColourspace('srgb')
      .jpeg({ quality: FULL_JPEG_QUALITY, chromaSubsampling: '4:4:4' })
      .toFile(fullPath);
    await pipeline(input, limits)
      .rotate()
      .flatten({ background: ALPHA_BACKGROUND })
      .resize({
        width: THUMBNAIL_MAX_DIMENSION,
        height: THUMBNAIL_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toColourspace('srgb')
      .jpeg({ quality: THUMBNAIL_JPEG_QUALITY })
      .toFile(thumbnailPath);
    return {
      format,
      mimeType: IMAGE_MIME_TYPES[format],
      extension: IMAGE_EXTENSIONS[format],
      widthPx: full.width,
      heightPx: full.height,
    };
  } catch (error) {
    throw fromSharp(error);
  }
}
