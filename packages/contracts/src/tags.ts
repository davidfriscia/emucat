import { z } from 'zod';

/**
 * Tags: one central catalog of short labels, reused by VMs, versions (masters and snapshots) and screenshots.
 * See docs/domain-model.md#tags.
 *
 * A tag is stored without the `#` that the interface always shows in front of it. `#` is a presentation
 * convention: typing it is accepted and ignored, so `#retro`, `retro` and ` Retro ` are the same tag.
 */

/** In characters (code points), as MariaDB's `CHAR_LENGTH` counts them. */
export const TAG_NAME_MAX_LENGTH = 48;
/** How many tags one VM, version or screenshot may carry. */
export const TAGS_PER_ENTITY_MAX = 32;
export const TAG_SEARCH_LIMIT_DEFAULT = 20;
export const TAG_SEARCH_LIMIT_MAX = 50;
export const TAG_SEARCH_MAX_LENGTH = 100;

/**
 * A letter or digit first, then letters, digits, combining marks and `.`, `_`, `+` or `-`. No spaces, no
 * `#`, nothing that could be confused with markup or a path.
 */
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._+-]*$/u;

export type TagNormalization =
  { ok: true; name: string; normalizedName: string } | { ok: false; message: string };

const characters = (value: string): number => Array.from(value).length;

/** What is compared: the display name in lower case. Locale-independent, so the same everywhere. */
export function normalizedTagKey(name: string): string {
  return name.toLowerCase();
}

/**
 * Turns what a person typed into a tag name, or says why it cannot be one. In order: Unicode NFKC, surrounding
 * whitespace and every leading `#` go, and each run of inner whitespace becomes one `-`. The case typed is kept
 * for display; uniqueness ignores it.
 */
export function normalizeTagInput(raw: string): TagNormalization {
  const name = raw.normalize('NFKC').trim().replace(/^#+/u, '').trim().replace(/\s+/gu, '-');
  if (name === '') return { ok: false, message: 'A tag cannot be empty' };
  if (characters(name) > TAG_NAME_MAX_LENGTH) {
    return { ok: false, message: `A tag has at most ${TAG_NAME_MAX_LENGTH} characters` };
  }
  if (!TAG_PATTERN.test(name)) {
    return {
      ok: false,
      message:
        'A tag starts with a letter or digit, and has only letters, digits and . _ + - after it',
    };
  }
  return { ok: true, name, normalizedName: normalizedTagKey(name) };
}

/** How a tag is always shown. */
export function formatTag(name: string): string {
  return `#${name}`;
}

/**
 * How a catalog search term is matched against tags. A leading `#` asks for that exact tag and nothing else;
 * plain text also matches any tag that contains it, beside names and descriptions.
 */
export function tagSearchTerm(q: string): { tagOnly: boolean; term: string } | null {
  const trimmed = q.normalize('NFKC').trim();
  const tagOnly = trimmed.startsWith('#');
  const term = normalizedTagKey(trimmed.replace(/^#+/u, '').trim().replace(/\s+/gu, '-'));
  if (term === '') return null;
  return { tagOnly, term };
}

/** A tag as every response gives it: the display name, without `#`. */
export const tagSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
});
export type Tag = z.infer<typeof tagSchema>;

/** Accepts what a person typed, `#` and all; the server stores the normalized form. */
export const tagNameInputSchema = z
  .string()
  .max(4 * TAG_NAME_MAX_LENGTH)
  .superRefine((value, context) => {
    const result = normalizeTagInput(value);
    if (!result.ok) context.addIssue({ code: 'custom', message: result.message });
  });

export const createTagRequestSchema = z.strictObject({ name: tagNameInputSchema });
export type CreateTagRequest = z.infer<typeof createTagRequestSchema>;

/** `created` is false when a tag with the same normalized name already existed: that one is returned. */
export const createTagResponseSchema = z.strictObject({ tag: tagSchema, created: z.boolean() });
export type CreateTagResponse = z.infer<typeof createTagResponseSchema>;

export const tagListQuerySchema = z.strictObject({
  q: z.string().max(TAG_SEARCH_MAX_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(TAG_SEARCH_LIMIT_MAX).default(TAG_SEARCH_LIMIT_DEFAULT),
});
export type TagListQuery = z.infer<typeof tagListQuerySchema>;

export const tagListResponseSchema = z.strictObject({ tags: z.array(tagSchema) });
export type TagListResponse = z.infer<typeof tagListResponseSchema>;

/**
 * Replaces one entity's tags with exactly these, in one transaction. Every ID must name an existing tag. The
 * order does not matter: tags are always listed by name.
 */
export const setEntityTagsRequestSchema = z.strictObject({
  tagIds: z
    .array(z.uuid())
    .max(TAGS_PER_ENTITY_MAX, `At most ${TAGS_PER_ENTITY_MAX} tags`)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
      message: 'A tag is listed twice',
    }),
});
export type SetEntityTagsRequest = z.infer<typeof setEntityTagsRequestSchema>;

export const entityTagsResponseSchema = z.strictObject({ tags: z.array(tagSchema) });
export type EntityTagsResponse = z.infer<typeof entityTagsResponseSchema>;
