import { z } from 'zod';
import { API_PREFIX } from './api.js';
import { emulatorTypeSchema, type EmulatorType } from './emulator.js';
import { mediaVisibilitySchema } from './media.js';
import { sha256HexSchema, timestampSchema } from './version.js';
import { vmNameSchema, type VmIdentity } from './vm-name.js';

export const VM_VISIBILITIES = ['private', 'public'] as const;
export const vmVisibilitySchema = z.enum(VM_VISIBILITIES);
export type VmVisibility = z.infer<typeof vmVisibilitySchema>;

export const EMULATOR_LABELS: Readonly<Record<EmulatorType, string>> = {
  '86box': '86Box',
  qemu: 'QEMU',
};

export const VM_DISPLAY_NAME_MAX_LENGTH = 255;
/** At four bytes per character this always fits the `TEXT` column. */
export const VM_DESCRIPTION_MAX_LENGTH = 10_000;
export const CATALOG_SEARCH_MAX_LENGTH = 100;
export const CATALOG_PAGE_SIZE_DEFAULT = 24;
export const CATALOG_PAGE_SIZE_MAX = 100;
/** Length of the description excerpt returned in catalog listings. */
export const CATALOG_SUMMARY_LENGTH = 240;

const CONTROL_CHARACTERS = /\p{Cc}/u;
const CONTROL_CHARACTERS_EXCEPT_LINES = /[^\P{Cc}\n\r\t]/u;

export const vmDisplayNameSchema = z
  .string()
  .trim()
  .min(1, 'A display name cannot be blank. Use null to clear it.')
  .max(VM_DISPLAY_NAME_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTERS.test(value), 'Control characters are not allowed');

export const vmDescriptionSchema = z
  .string()
  .max(VM_DESCRIPTION_MAX_LENGTH)
  .refine(
    (value) => !CONTROL_CHARACTERS_EXCEPT_LINES.test(value),
    'Control characters are not allowed',
  );

/**
 * The fields of a registered VM that an administrator may change. The identity is not here and
 * unknown keys are rejected, so a request can never rename a VM or move it to another emulator.
 */
export const updateVmMetadataRequestSchema = z
  .strictObject({
    displayName: vmDisplayNameSchema.nullable().optional(),
    description: vmDescriptionSchema.nullable().optional(),
  })
  .refine(
    (value) => value.displayName !== undefined || value.description !== undefined,
    'Provide at least one field to change',
  );
export type UpdateVmMetadataRequest = z.infer<typeof updateVmMetadataRequestSchema>;

export const updateVmVisibilityRequestSchema = z.strictObject({ visibility: vmVisibilitySchema });
export type UpdateVmVisibilityRequest = z.infer<typeof updateVmVisibilityRequestSchema>;

export const updateMediaVisibilityRequestSchema = z.strictObject({
  visibility: mediaVisibilitySchema,
});
export type UpdateMediaVisibilityRequest = z.infer<typeof updateMediaVisibilityRequestSchema>;

export const selectMainMediaRequestSchema = z.strictObject({ mediaId: z.uuid() });
export type SelectMainMediaRequest = z.infer<typeof selectMainMediaRequestSchema>;

const pageParameter = z.coerce.number().int().min(1).max(1_000_000).default(1);
const pageSizeParameter = z.coerce
  .number()
  .int()
  .min(1)
  .max(CATALOG_PAGE_SIZE_MAX)
  .default(CATALOG_PAGE_SIZE_DEFAULT);
const searchParameter = z.string().trim().max(CATALOG_SEARCH_MAX_LENGTH).optional();

export const publicCatalogQuerySchema = z.strictObject({
  q: searchParameter,
  emulatorType: emulatorTypeSchema.optional(),
  page: pageParameter,
  pageSize: pageSizeParameter,
});
export type PublicCatalogQuery = z.infer<typeof publicCatalogQuerySchema>;

export const adminCatalogQuerySchema = publicCatalogQuerySchema.extend({
  visibility: vmVisibilitySchema.optional(),
});
export type AdminCatalogQuery = z.infer<typeof adminCatalogQuerySchema>;

export const vmPathParamsSchema = z.strictObject({
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
});

export const paginationSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const MEDIA_VARIANTS = ['thumbnail', 'full'] as const;
export const mediaVariantSchema = z.enum(MEDIA_VARIANTS);
export type MediaVariant = z.infer<typeof mediaVariantSchema>;

/** Administrators can also fetch the uploaded file itself. The public never can. */
export const ADMIN_MEDIA_VARIANTS = [...MEDIA_VARIANTS, 'original'] as const;
export const adminMediaVariantSchema = z.enum(ADMIN_MEDIA_VARIANTS);
export type AdminMediaVariant = z.infer<typeof adminMediaVariantSchema>;

/** What the public may know about an image: no filenames, hashes or storage keys. */
export const publicMediaSchema = z.strictObject({
  id: z.uuid(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
});
export type PublicMedia = z.infer<typeof publicMediaSchema>;

export const publicVmCardSchema = z.strictObject({
  emulatorType: emulatorTypeSchema,
  vmName: z.string(),
  displayName: z.string().nullable(),
  summary: z.string().nullable(),
  /** The main image when every rule allows it. `null` means show the placeholder. */
  mainImage: publicMediaSchema.nullable(),
});
export type PublicVmCard = z.infer<typeof publicVmCardSchema>;

export const publicCatalogResponseSchema = z.strictObject({
  items: z.array(publicVmCardSchema),
  pagination: paginationSchema,
});
export type PublicCatalogResponse = z.infer<typeof publicCatalogResponseSchema>;

export const publicVmDetailSchema = z.strictObject({
  emulatorType: emulatorTypeSchema,
  vmName: z.string(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  mainImage: publicMediaSchema.nullable(),
  /** Every published image of this VM, including the main image. */
  gallery: z.array(publicMediaSchema),
});
export type PublicVmDetail = z.infer<typeof publicVmDetailSchema>;

export const adminVmCardSchema = z.strictObject({
  emulatorType: emulatorTypeSchema,
  vmName: z.string(),
  displayName: z.string().nullable(),
  summary: z.string().nullable(),
  visibility: vmVisibilitySchema,
  /** The selected main image, whether or not the public can see it. */
  mainMediaId: z.uuid().nullable(),
  mediaCount: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
});
export type AdminVmCard = z.infer<typeof adminVmCardSchema>;

export const adminCatalogResponseSchema = z.strictObject({
  items: z.array(adminVmCardSchema),
  pagination: paginationSchema,
});
export type AdminCatalogResponse = z.infer<typeof adminCatalogResponseSchema>;

export const adminVmDetailSchema = z.strictObject({
  emulatorType: emulatorTypeSchema,
  vmName: z.string(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  visibility: vmVisibilitySchema,
  mainMediaId: z.uuid().nullable(),
  mediaCount: z.number().int().nonnegative(),
  versionCount: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type AdminVmDetail = z.infer<typeof adminVmDetailSchema>;

export const adminMediaSchema = z.strictObject({
  id: z.uuid(),
  visibility: mediaVisibilitySchema,
  isMain: z.boolean(),
  originalFilename: z.string(),
  originalSizeBytes: z.number().int().nonnegative(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  capturedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  /** Whether the public catalog shows this item as the main image right now. */
  shownAsPublicMain: z.boolean(),
});
export type AdminMedia = z.infer<typeof adminMediaSchema>;

/** One item in full. The list leaves out what only this view needs. */
export const adminMediaDetailSchema = adminMediaSchema.extend({
  originalSha256: sha256HexSchema,
  /** Worked out from the bytes when they were uploaded. `null` for media that predates uploads. */
  originalMimeType: z.string().nullable(),
  /** The agent that uploaded it, while that agent still exists. */
  uploadedByAgentId: z.uuid().nullable(),
  uploadedByAgentName: z.string().nullable(),
});
export type AdminMediaDetail = z.infer<typeof adminMediaDetailSchema>;

export const adminMediaListResponseSchema = z.strictObject({ media: z.array(adminMediaSchema) });
export type AdminMediaListResponse = z.infer<typeof adminMediaListResponseSchema>;

export const adminSummaryResponseSchema = z.strictObject({
  vms: z.strictObject({
    total: z.number().int().nonnegative(),
    public: z.number().int().nonnegative(),
    private: z.number().int().nonnegative(),
  }),
  media: z.strictObject({
    total: z.number().int().nonnegative(),
    published: z.number().int().nonnegative(),
    private: z.number().int().nonnegative(),
  }),
});
export type AdminSummaryResponse = z.infer<typeof adminSummaryResponseSchema>;

/** The catalog title: the display name when there is one, otherwise the VM name. */
export function vmTitle(vm: { displayName: string | null; vmName: string }): string {
  return vm.displayName ?? vm.vmName;
}

function vmSegments({ emulatorType, vmName }: VmIdentity): string {
  return `${emulatorType}/${encodeURIComponent(vmName)}`;
}

export function publicMediaPath(mediaId: string, variant: MediaVariant): string {
  return `${API_PREFIX}/catalog/media/${mediaId}/${variant}`;
}

export function adminMediaPath(
  vm: VmIdentity,
  mediaId: string,
  variant: AdminMediaVariant,
): string {
  return `${API_PREFIX}/admin/vms/${vmSegments(vm)}/media/${mediaId}/${variant}`;
}

export function publicVmApiPath(vm: VmIdentity): string {
  return `${API_PREFIX}/catalog/vms/${vmSegments(vm)}`;
}

export function adminVmApiPath(vm: VmIdentity): string {
  return `${API_PREFIX}/admin/vms/${vmSegments(vm)}`;
}

/** Web application routes. */
export function publicVmRoute(vm: VmIdentity): string {
  return `/vms/${vmSegments(vm)}`;
}

export function adminVmRoute(vm: VmIdentity): string {
  return `/admin/vms/${vmSegments(vm)}`;
}
