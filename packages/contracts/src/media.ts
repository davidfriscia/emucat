import { z } from 'zod';
import { emulatorTypeSchema } from './emulator.js';
import { sha256HexSchema, timestampSchema } from './version.js';
import { sameVmIdentity, vmNameSchema, type VmIdentity } from './vm-name.js';

export const MEDIA_VISIBILITIES = ['private', 'published'] as const;
export const mediaVisibilitySchema = z.enum(MEDIA_VISIBILITIES);
export type MediaVisibility = z.infer<typeof mediaVisibilitySchema>;

/** Media are private until explicitly published. */
export const DEFAULT_MEDIA_VISIBILITY: MediaVisibility = 'private';

export const vmMediaSchema = z.object({
  id: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
  visibility: mediaVisibilitySchema.default(DEFAULT_MEDIA_VISIBILITY),
  isMain: z.boolean().default(false),
  originalFilename: z.string().min(1).max(255),
  originalSha256: sha256HexSchema,
  originalSizeBytes: z.number().int().nonnegative(),
  jpegKey: z.string().min(1),
  thumbnailKey: z.string().min(1),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  capturedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type VmMedia = z.infer<typeof vmMediaSchema>;

export type CatalogCardImage = { kind: 'media'; mediaId: string } | { kind: 'placeholder' };

/**
 * Chooses the image for a public catalog card: the VM's main media if it is published, otherwise a
 * placeholder. It never falls back to another item, so unpublishing or deleting the main media can
 * only ever result in the placeholder.
 */
export function resolvePublicCardImage(
  identity: VmIdentity,
  media: readonly Pick<VmMedia, 'id' | 'emulatorType' | 'vmName' | 'visibility' | 'isMain'>[],
): CatalogCardImage {
  const main = media.find((item) => item.isMain && sameVmIdentity(item, identity));
  return main?.visibility === 'published'
    ? { kind: 'media', mediaId: main.id }
    : { kind: 'placeholder' };
}

/**
 * Whether two uploads are the same media item. Deduplication is per VM: the same image uploaded
 * for two different VMs is two items, each with its own visibility.
 */
export function isSameMedia(
  a: Pick<VmMedia, 'emulatorType' | 'vmName' | 'originalSha256'>,
  b: Pick<VmMedia, 'emulatorType' | 'vmName' | 'originalSha256'>,
): boolean {
  return sameVmIdentity(a, b) && a.originalSha256 === b.originalSha256;
}

/**
 * Returns the VM's media with `mediaId` as the only main item. Throws if the item does not belong
 * to this VM, so a selection can never cross VMs.
 */
export function selectMainMedia<
  T extends Pick<VmMedia, 'id' | 'emulatorType' | 'vmName' | 'isMain'>,
>(identity: VmIdentity, media: readonly T[], mediaId: string): T[] {
  const own = media.filter((item) => sameVmIdentity(item, identity));
  if (!own.some((item) => item.id === mediaId)) {
    throw new Error('Main media must belong to the same VM');
  }
  return own.map((item) => ({ ...item, isMain: item.id === mediaId }));
}
