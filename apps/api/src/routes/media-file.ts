import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import { InvalidStorageKeyError, type MediaStorage } from '../storage/media-storage.js';

/**
 * Sends a stored image, or a 404. A storage key is relative and resolved under the storage root, and
 * one that fails that check is logged and treated as missing rather than read.
 */
export async function sendMediaFile(
  request: FastifyRequest,
  reply: FastifyReply,
  storage: MediaStorage,
  key: string | null,
  cacheControl: string,
): Promise<FastifyReply> {
  const notFound = () => new ApiError(404, 'media_not_found', 'Media not found');
  if (key === null) throw notFound();
  let file: Awaited<ReturnType<MediaStorage['open']>>;
  try {
    file = await storage.open(key);
  } catch (error) {
    if (!(error instanceof InvalidStorageKeyError)) throw error;
    request.log.error({ err: error }, 'Refused to read an unsafe media storage key');
    throw notFound();
  }
  if (!file) throw notFound();
  return reply
    .type('image/jpeg')
    .header('content-length', file.sizeBytes)
    .header('cache-control', cacheControl)
    .send(file.stream);
}
