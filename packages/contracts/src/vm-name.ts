import { z } from 'zod';
import { emulatorTypeSchema } from './emulator.js';

/** Leaves room for the snapshot suffix and for long base paths on Windows. */
export const VM_NAME_MAX_LENGTH = 64;

export const VM_NAME_ERROR_CODES = [
  'empty',
  'invalid_characters',
  'too_long',
  'invalid_boundary',
  'repeated_separator',
  'reserved_name',
  'snapshot_suffix',
] as const;
export type VmNameErrorCode = (typeof VM_NAME_ERROR_CODES)[number];

export type VmNameValidation = { ok: true } | { ok: false; code: VmNameErrorCode };

const ALLOWED_CHARACTERS = /^[A-Za-z0-9._ -]+$/;
const ALPHANUMERIC_BOUNDARIES = /^[A-Za-z0-9](?:.*[A-Za-z0-9])?$/;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/;
const SNAPSHOT_SUFFIX = /_[0-9]{12}$/;

/**
 * Validates a VM name. A name is also a directory name on every supported OS and part of remote
 * object keys, so the rules are the intersection of what is safe everywhere:
 *
 * - ASCII letters, digits, `.`, `_`, `-` and space only. This excludes path separators, control
 *   characters, Windows-reserved punctuation, and Unicode names that are ambiguous under
 *   normalization (macOS) or look-alike characters.
 * - Starts and ends with a letter or digit. This excludes `.`, `..`, hidden files, option-like
 *   names (`-rf`), and the trailing dots and spaces that Windows silently strips.
 * - No `..` and no consecutive spaces.
 * - Not a Windows device name, with or without an extension (`NUL`, `com1.vm`).
 * - Does not end in `_YYYYMMDDhhmm`-shaped digits, which would be indistinguishable from a snapshot
 *   name of another VM.
 *
 * Names are compared case-insensitively; see {@link vmNameKey}.
 *
 * The agent implements the same rules, and both are tested against `fixtures/vm-names.json`.
 */
export function validateVmName(name: string): VmNameValidation {
  if (name.length === 0) return { ok: false, code: 'empty' };
  if (!ALLOWED_CHARACTERS.test(name)) return { ok: false, code: 'invalid_characters' };
  if (name.length > VM_NAME_MAX_LENGTH) return { ok: false, code: 'too_long' };
  if (!ALPHANUMERIC_BOUNDARIES.test(name)) return { ok: false, code: 'invalid_boundary' };
  if (name.includes('..') || name.includes('  ')) return { ok: false, code: 'repeated_separator' };

  const stem = (name.split('.')[0] ?? '').trimEnd().toUpperCase();
  if (WINDOWS_DEVICE_NAME.test(stem)) return { ok: false, code: 'reserved_name' };

  if (SNAPSHOT_SUFFIX.test(name)) return { ok: false, code: 'snapshot_suffix' };
  return { ok: true };
}

export function isValidVmName(name: string): boolean {
  return validateVmName(name).ok;
}

export const vmNameSchema = z.string().superRefine((name, context) => {
  const result = validateVmName(name);
  if (!result.ok) {
    context.addIssue({ code: 'custom', message: `Invalid VM name: ${result.code}` });
  }
});

/**
 * Canonical comparison key. `Win98` and `win98` would be the same directory on Windows and on
 * default macOS volumes, so they are the same VM everywhere. The original spelling is preserved
 * for display and for the directory name.
 */
export function vmNameKey(name: string): string {
  return name.toLowerCase();
}

export const vmIdentitySchema = z.object({
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
});
export type VmIdentity = z.infer<typeof vmIdentitySchema>;

export function sameVmIdentity(a: VmIdentity, b: VmIdentity): boolean {
  return a.emulatorType === b.emulatorType && vmNameKey(a.vmName) === vmNameKey(b.vmName);
}
