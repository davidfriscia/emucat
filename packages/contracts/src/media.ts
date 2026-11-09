import { z } from 'zod';
import type { VmVisibility } from './catalog.js';
import { emulatorTypeSchema } from './emulator.js';
import { sha256HexSchema, timestampSchema } from './version.js';
import { sameVmIdentity, vmNameSchema, type VmIdentity } from './vm-name.js';

/**
 * A media item has no visibility of its own: it is public exactly while its VM is public. See
 * decision 0036. The `vm_media.visibility` column that once said otherwise is kept, and ignored.
 */
export const vmMediaSchema = z.object({
  id: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
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
 * Chooses the image for a public catalog card: the VM's main media while the VM is public, otherwise a
 * placeholder. It never falls back to another item, so clearing or deleting the main media can only
 * ever result in the placeholder.
 */
export function resolvePublicCardImage(
  vm: VmIdentity & { visibility: VmVisibility },
  media: readonly Pick<VmMedia, 'id' | 'emulatorType' | 'vmName' | 'isMain'>[],
): CatalogCardImage {
  if (vm.visibility !== 'public') return { kind: 'placeholder' };
  const main = media.find((item) => item.isMain && sameVmIdentity(item, vm));
  return main ? { kind: 'media', mediaId: main.id } : { kind: 'placeholder' };
}

/**
 * Whether two uploads are the same media item. Deduplication is per VM: the same image uploaded
 * for two different VMs is two items, each public or private with its own VM.
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

// Screenshot synchronization. Bytes travel over authenticated HTTP(S) to the API, never over SFTP and
// never in a WebSocket message. See docs/media.md.

export const AGENT_MEDIA_API_PATH = '/api/v1/agent/media';
/** Sent with every agent media request, so that a mismatch gets a precise answer. */
export const MEDIA_PROTOCOL_HEADER = 'x-emucat-protocol-version';
/** The VM-relative path the file was found at, percent-encoded. A label: never used as a path. */
export const MEDIA_SOURCE_PATH_HEADER = 'x-emucat-source-path';
/** When the file was last modified, as RFC 3339. A label for display. */
export const MEDIA_CAPTURED_AT_HEADER = 'x-emucat-captured-at';

/** How many hashes one acknowledgement query can ask about. */
export const MEDIA_ACK_QUERY_MAX = 256;
/** How many VMs one status message can describe, which keeps it far below the message limit. */
export const MEDIA_STATUS_MAX_VMS = 100;

export const agentMediaVmSchema = z.strictObject({
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
});

/** The VMs this agent may synchronize. The server's word is what counts, not a local directory. */
export const agentMediaVmListResponseSchema = z.strictObject({
  vms: z.array(agentMediaVmSchema),
  maxUploadBytes: z.number().int().positive(),
});
export type AgentMediaVmListResponse = z.infer<typeof agentMediaVmListResponseSchema>;

export const mediaAcknowledgementRequestSchema = z.strictObject({
  sha256: z.array(sha256HexSchema).max(MEDIA_ACK_QUERY_MAX),
});
export type MediaAcknowledgementRequest = z.infer<typeof mediaAcknowledgementRequestSchema>;

/** The hashes the server holds for this VM, which is the only proof that a screenshot is preserved. */
export const mediaAcknowledgementResponseSchema = z.strictObject({
  acknowledged: z.array(sha256HexSchema),
});
export type MediaAcknowledgementResponse = z.infer<typeof mediaAcknowledgementResponseSchema>;

export const mediaUploadResponseSchema = z.strictObject({
  mediaId: z.uuid(),
  sha256: sha256HexSchema,
  /** False when these bytes were already stored for this VM. */
  created: z.boolean(),
});
export type MediaUploadResponse = z.infer<typeof mediaUploadResponseSchema>;

const mediaCountSchema = z.number().int().nonnegative();

/** One VM's synchronization as this agent sees it. */
export const mediaSyncVmStatusSchema = z.strictObject({
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
  pending: mediaCountSchema,
  uploading: mediaCountSchema,
  synchronized: mediaCountSchema,
  failed: mediaCountSchema,
  lastError: z
    .strictObject({
      code: z.string().min(1).max(64),
      message: z.string().max(256),
      sourcePath: z.string().max(256).nullable(),
    })
    .nullable(),
});
export type MediaSyncVmStatus = z.infer<typeof mediaSyncVmStatusSchema>;

/** Informational, and sent again after each welcome. Nothing is decided on it. */
export const mediaSyncStatusPayloadSchema = z.strictObject({
  vms: z.array(mediaSyncVmStatusSchema).max(MEDIA_STATUS_MAX_VMS),
  truncated: z.boolean(),
});
export type MediaSyncStatusPayload = z.infer<typeof mediaSyncStatusPayloadSchema>;

/** What the administration page shows: each agent holding this VM, and what it last reported. */
export const adminMediaSyncResponseSchema = z.strictObject({
  agents: z.array(
    z.strictObject({
      agentId: z.uuid(),
      agentName: z.string(),
      online: z.boolean(),
      /** `null` until the agent has reported on this VM since the server started. */
      status: z
        .strictObject({
          pending: mediaCountSchema,
          uploading: mediaCountSchema,
          synchronized: mediaCountSchema,
          failed: mediaCountSchema,
          lastError: z
            .strictObject({
              code: z.string(),
              message: z.string(),
              sourcePath: z.string().nullable(),
            })
            .nullable(),
          reportedAt: timestampSchema,
        })
        .nullable(),
    }),
  ),
});
export type AdminMediaSyncResponse = z.infer<typeof adminMediaSyncResponseSchema>;
