import { z } from 'zod';

/**
 * A version's title and description (decision 0048): optional, plain text, chosen by an administrator, and never
 * part of the archive. Editing them changes nothing that identifies or verifies the version.
 */

// Titles and descriptions.

export const VERSION_TITLE_MAX_LENGTH = 120;
export const VERSION_DESCRIPTION_MAX_LENGTH = 2000;

/** Characters, as MariaDB's `CHAR_LENGTH` counts them: code points, not UTF-16 units. */
export const characterCount = (value: string): number => Array.from(value).length;

/** A title is one line: no control character at all, tabs and line breaks included. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const TITLE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
/** A description may have tabs and line breaks, and nothing else of the kind. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const DESCRIPTION_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

/** Trimmed; nothing left means no title. */
export function normalizeVersionTitle(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Line breaks become `\n`, and the whitespace around the whole text goes; the lines themselves, blank ones
 * included, are kept as written. Nothing left means no description.
 */
export function normalizeVersionDescription(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  return normalized === '' ? null : normalized;
}

/** Accepts what a form sends, and gives what is stored: trimmed, or `null` for nothing. Plain text, never HTML. */
export const versionTitleSchema = z
  .string()
  .max(4 * VERSION_TITLE_MAX_LENGTH)
  .nullable()
  .transform(normalizeVersionTitle)
  .refine((value) => value === null || characterCount(value) <= VERSION_TITLE_MAX_LENGTH, {
    message: `A title has at most ${VERSION_TITLE_MAX_LENGTH} characters`,
  })
  .refine((value) => value === null || !TITLE_FORBIDDEN.test(value), {
    message: 'A title is one line of text, without control characters',
  });

export const versionDescriptionSchema = z
  .string()
  .max(4 * VERSION_DESCRIPTION_MAX_LENGTH)
  .nullable()
  .transform(normalizeVersionDescription)
  .refine((value) => value === null || characterCount(value) <= VERSION_DESCRIPTION_MAX_LENGTH, {
    message: `A description has at most ${VERSION_DESCRIPTION_MAX_LENGTH} characters`,
  })
  .refine((value) => value === null || !DESCRIPTION_FORBIDDEN.test(value), {
    message: 'A description is plain text: line breaks and tabs, and no other control characters',
  });

/**
 * Edits a version's title and description, and nothing else: no archive, hash, lineage or creation time
 * changes, and nothing is exported or uploaded. Both are given, `null` or empty to clear one.
 */
export const updateVersionDetailsRequestSchema = z.strictObject({
  title: versionTitleSchema,
  description: versionDescriptionSchema,
});
export type UpdateVersionDetailsRequest = z.input<typeof updateVersionDetailsRequestSchema>;

export const versionDetailsSchema = z.object({
  versionId: z.uuid(),
  title: z.string().nullable(),
  description: z.string().nullable(),
});
export type VersionDetails = z.infer<typeof versionDetailsSchema>;
