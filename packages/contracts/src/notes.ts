import { z } from 'zod';
import { timestampSchema } from './version.js';

/**
 * Per-VM Markdown notes (decision 0053). One Markdown file per VM on the server's filesystem, which is the only
 * copy. Administrative and private: never part of a public response.
 */

/** The largest notes document accepted, in UTF-8 bytes. Long technical notes fit with room to spare. */
export const VM_NOTES_MAX_BYTES = 1024 * 1024;

/** An entity tag, quoted as HTTP requires: a SHA-256 of the content. */
export const notesEtagSchema = z.string().regex(/^"[0-9a-f]{64}"$/);

export const vmNotesSchema = z.object({
  /** The Markdown, exactly as stored. Empty when there are no notes. */
  markdown: z.string(),
  /** Whether a notes file exists. A missing file is an empty document. */
  exists: z.boolean(),
  /** Changes whenever the content does. Send it back as `If-Match` to save. */
  etag: notesEtagSchema,
  updatedAt: timestampSchema.nullable(),
  sizeBytes: z.number().int().nonnegative(),
});
export type VmNotes = z.infer<typeof vmNotesSchema>;

/** The whole document. An empty string removes the file. */
export const saveVmNotesRequestSchema = z.strictObject({
  markdown: z
    .string()
    .refine((text) => new TextEncoder().encode(text).length <= VM_NOTES_MAX_BYTES, {
      message: `Notes are limited to ${VM_NOTES_MAX_BYTES} bytes`,
    })
    .refine((text) => !text.includes('\0'), { message: 'Notes cannot contain NUL characters' }),
});
export type SaveVmNotesRequest = z.infer<typeof saveVmNotesRequestSchema>;

/** The file name of a VM's notes inside its directory: `<vm name> - notes.md`. */
export function notesFileName(vmName: string): string {
  return `${vmName} - notes.md`;
}
