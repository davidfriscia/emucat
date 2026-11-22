import { createHash } from 'node:crypto';
import type { EmulatorType } from '@emucat/contracts';
import {
  isDirectoryName,
  readCentralDirectory,
  readSmallEntry,
  unixMode,
  ZipFormatError,
  type RandomAccess,
  type ZipEntry,
} from './zip.js';

/**
 * The EmuCat manifest (decision 0014) and the checks a restore makes on an archive before extracting anything,
 * ported from the agent (`extraction.rs`) so that the server refuses exactly what an agent would refuse. A clone the
 * server writes must pass an agent's restore, and an archive the server lists has passed the same checks.
 */

export const MANIFEST_ENTRY_NAME = '.emucat-manifest.json';
export const MANIFEST_VERSION = 1;

export interface ManifestEntry {
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  sha256?: string;
}

export interface Manifest {
  manifestVersion: number;
  emulatorType: EmulatorType;
  vmName: string;
  fileCount: number;
  totalUncompressedBytes: number;
  entries: ManifestEntry[];
}

export class ArchiveCheckError extends Error {
  override readonly name = 'ArchiveCheckError';

  constructor(
    readonly kind: 'malformed' | 'limit' | 'integrity' | 'identity',
    message: string,
  ) {
    super(message);
  }
}

export interface ArchiveLimits {
  maxEntries: number;
  maxDirectoryBytes: number;
  maxManifestBytes: number;
}

/** What the server reads at most. Below the agent's own defaults, so nothing it lists would be refused there. */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 500_000,
  maxDirectoryBytes: 128 * 1024 * 1024,
  maxManifestBytes: 128 * 1024 * 1024,
};

/** Exactly the agent's `Manifest::canonical_bytes`: compact JSON, fixed key order, and a newline. */
export function canonicalManifestBytes(manifest: Manifest): Buffer {
  const ordered = {
    manifestVersion: manifest.manifestVersion,
    emulatorType: manifest.emulatorType,
    vmName: manifest.vmName,
    fileCount: manifest.fileCount,
    totalUncompressedBytes: manifest.totalUncompressedBytes,
    entries: manifest.entries.map((entry) =>
      entry.type === 'file'
        ? { path: entry.path, type: entry.type, sizeBytes: entry.sizeBytes, sha256: entry.sha256 }
        : { path: entry.path, type: entry.type },
    ),
  };
  return Buffer.from(`${JSON.stringify(ordered)}\n`, 'utf8');
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const WINDOWS_DEVICES = new Set(
  ['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'].concat(
    Array.from({ length: 9 }, (_, index) => [`COM${index + 1}`, `LPT${index + 1}`]).flat(),
    ['COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³'],
  ),
);

function segmentProblem(segment: string): string | null {
  if (segment === '' || segment === '.' || segment === '..') {
    return 'has an empty or relative path segment';
  }
  if (Buffer.byteLength(segment, 'utf8') > 255) return 'has a path segment that is too long';
  if (/[\p{Cc}<>:"|?*\\/]/u.test(segment))
    return 'has a character that is not allowed in a file name';
  if (segment.endsWith('.') || segment.endsWith(' ')) return 'ends with a dot or a space';
  const stem = segment.split('.')[0] ?? segment;
  if (WINDOWS_DEVICES.has(stem.toUpperCase())) return 'is a reserved device name on Windows';
  return null;
}

/** Whether a path, as written in an archive, is one no VM may use on any system. `null` when it is fine. */
export function entryPathProblem(path: string): string | null {
  if (path === '') return 'has an empty name';
  if (Buffer.byteLength(path, 'utf8') > 4096) return 'has a path that is too long';
  if (path.startsWith('/')) return 'has an absolute path';
  if (path.includes('\\')) return 'uses a backslash, which could escape on Windows';
  if (path.includes(':')) return 'has a drive letter or an alternate data stream';
  for (const segment of path.split('/')) {
    const problem = segmentProblem(segment);
    if (problem) return problem;
  }
  return null;
}

const unsafe = (name: string, why: string) =>
  new ArchiveCheckError('malformed', `The entry ${JSON.stringify(name.slice(0, 200))} ${why}`);

function checkEntryKind(entry: ZipEntry): void {
  if ((entry.flags & (0x0001 | 0x0020 | 0x0040)) !== 0) throw unsafe(entry.name, 'is encrypted');
  if (entry.method !== 0 && entry.method !== 8) {
    throw unsafe(entry.name, 'uses an unsupported compression method');
  }
  const mode = unixMode(entry);
  if ((entry.externalAttributes & 0x0400) !== 0 && mode === null) {
    throw unsafe(entry.name, 'is a reparse point');
  }
  if (mode !== null) {
    const type = mode & 0o170000;
    if (type === 0o120000) throw unsafe(entry.name, 'is a symbolic link');
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) {
      throw unsafe(entry.name, 'is a special file');
    }
    if (type === 0o040000 && !isDirectoryName(entry)) {
      throw unsafe(entry.name, 'says it is a directory, and has a file’s name');
    }
    if (type === 0o100000 && isDirectoryName(entry)) {
      throw unsafe(entry.name, 'says it is a file, and has a directory’s name');
    }
  }
  if (isDirectoryName(entry) && entry.uncompressedSize !== 0) {
    throw unsafe(entry.name, 'is a directory holding data');
  }
}

const manifestProblem = (message: string) => new ArchiveCheckError('malformed', message);
const SHA256 = /^[0-9a-f]{64}$/;

export interface ArchiveExpectation {
  emulatorType: EmulatorType;
  vmName: string;
  /** What the registration verified, when known. */
  manifestSha256: string | null;
}

/** A manifest has to be what a registration would have written, for this VM, and consistent with itself. */
export function validateManifest(
  manifest: Manifest,
  raw: Buffer,
  expected: ArchiveExpectation,
): void {
  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    throw manifestProblem(
      `The server reads manifest version ${MANIFEST_VERSION}, and the archive has version ${manifest.manifestVersion}`,
    );
  }
  if (!canonicalManifestBytes(manifest).equals(raw)) {
    throw manifestProblem(
      'The manifest is not in canonical form, so it was not written by a registration',
    );
  }
  if (manifest.emulatorType !== expected.emulatorType) {
    throw new ArchiveCheckError('identity', 'The manifest describes a VM of another emulator');
  }
  if (manifest.vmName.toLowerCase() !== expected.vmName.toLowerCase()) {
    throw new ArchiveCheckError('identity', 'The manifest describes another VM');
  }
  if (expected.manifestSha256 !== null && sha256Hex(raw) !== expected.manifestSha256) {
    throw new ArchiveCheckError(
      'integrity',
      'The manifest is not the one its registration verified',
    );
  }
  let previous: Buffer | null = null;
  let files = 0;
  let total = 0;
  const directories = new Set<string>();
  for (const entry of manifest.entries) {
    const current = Buffer.from(entry.path, 'utf8');
    if (previous && Buffer.compare(previous, current) >= 0) {
      throw manifestProblem('The manifest’s entries are not in canonical order');
    }
    previous = current;
    const problem = entryPathProblem(entry.path);
    if (problem) throw unsafe(entry.path, problem);
    if (entry.type === 'file') {
      if (
        typeof entry.sizeBytes !== 'number' ||
        !Number.isSafeInteger(entry.sizeBytes) ||
        entry.sizeBytes < 0 ||
        typeof entry.sha256 !== 'string'
      ) {
        throw manifestProblem(`${entry.path} is a file with no size or hash`);
      }
      if (!SHA256.test(entry.sha256)) throw manifestProblem(`${entry.path} has an invalid hash`);
      files += 1;
      total += entry.sizeBytes;
    } else if (entry.type === 'directory') {
      if (entry.sizeBytes !== undefined || entry.sha256 !== undefined) {
        throw manifestProblem(`${entry.path} is a directory with a size or a hash`);
      }
      directories.add(entry.path);
    } else {
      throw manifestProblem('The manifest has an entry of an unknown type');
    }
  }
  if (files !== manifest.fileCount || total !== manifest.totalUncompressedBytes) {
    throw manifestProblem('The manifest’s totals do not match its entries');
  }
  for (const entry of manifest.entries) {
    const slash = entry.path.lastIndexOf('/');
    if (slash > 0 && !directories.has(entry.path.slice(0, slash))) {
      throw manifestProblem(`${entry.path} is in a directory the manifest does not list`);
    }
  }
}

function parseManifest(raw: Buffer): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw manifestProblem('The manifest cannot be read');
  }
  const value = parsed as Partial<Manifest> | null;
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.manifestVersion !== 'number' ||
    typeof value.emulatorType !== 'string' ||
    typeof value.vmName !== 'string' ||
    typeof value.fileCount !== 'number' ||
    typeof value.totalUncompressedBytes !== 'number' ||
    !Array.isArray(value.entries)
  ) {
    throw manifestProblem('The manifest cannot be read');
  }
  return value as Manifest;
}

export interface InspectedZip {
  entries: ZipEntry[];
  manifest: Manifest;
  manifestRaw: Buffer;
  manifestSha256: string;
}

/**
 * Everything that can be decided without decompressing a file: the structure, every entry, and a manifest that is
 * canonical, describes the expected VM, matches the registration when that is known, and lists exactly what the
 * archive holds. Reads the central directory and the manifest only.
 */
export async function inspectZip(
  source: RandomAccess,
  expected: ArchiveExpectation,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<InspectedZip> {
  let entries: ZipEntry[];
  try {
    ({ entries } = await readCentralDirectory(source, {
      maxEntries: limits.maxEntries,
      maxDirectoryBytes: limits.maxDirectoryBytes,
    }));
  } catch (error) {
    throw toCheckError(error);
  }

  const seenLower = new Set<string>();
  const seenUpper = new Set<string>();
  const byName = new Map<string, ZipEntry>();
  let manifestEntries = 0;
  for (const entry of entries) {
    checkEntryKind(entry);
    const path = entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name;
    const problem = entryPathProblem(path);
    if (problem) throw unsafe(entry.name, problem);
    const lower = path.toLowerCase();
    const upper = path.toUpperCase();
    if (seenLower.has(lower) || seenUpper.has(upper)) {
      throw unsafe(entry.name, 'duplicates another entry, at least when capitalization is ignored');
    }
    seenLower.add(lower);
    seenUpper.add(upper);
    byName.set(path, entry);
    if (entry.name.toLowerCase() === MANIFEST_ENTRY_NAME) {
      if (entry.name !== MANIFEST_ENTRY_NAME)
        throw unsafe(entry.name, 'imitates the manifest’s name');
      manifestEntries += 1;
    }
  }
  const manifestEntry = byName.get(MANIFEST_ENTRY_NAME);
  if (manifestEntries === 0 || !manifestEntry) {
    throw manifestProblem(`The archive has no ${MANIFEST_ENTRY_NAME}`);
  }
  let raw: Buffer;
  try {
    raw = await readSmallEntry(source, manifestEntry, limits.maxManifestBytes);
  } catch (error) {
    throw toCheckError(error);
  }
  const manifest = parseManifest(raw);
  validateManifest(manifest, raw, expected);

  for (const listed of manifest.entries) {
    const stored = byName.get(listed.path);
    if (!stored) throw manifestProblem(`${listed.path} is missing from the archive`);
    if (listed.type === 'file') {
      if (isDirectoryName(stored)) {
        throw manifestProblem(
          `${listed.path} is a file in the manifest and a directory in the archive`,
        );
      }
      if (stored.uncompressedSize !== listed.sizeBytes) {
        throw new ArchiveCheckError(
          'integrity',
          `${listed.path} has a different size in the archive and the manifest`,
        );
      }
    } else if (!isDirectoryName(stored)) {
      throw manifestProblem(
        `${listed.path} is a directory in the manifest and a file in the archive`,
      );
    }
  }
  if (entries.length !== manifest.entries.length + 1) {
    const listed = new Set(manifest.entries.map((entry) => entry.path));
    const extra =
      entries
        .map((entry) => (entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name))
        .find((name) => name !== MANIFEST_ENTRY_NAME && !listed.has(name)) ?? 'An entry';
    throw manifestProblem(`${extra} is in the archive and not in the manifest`);
  }
  return { entries, manifest, manifestRaw: raw, manifestSha256: sha256Hex(raw) };
}

export function toCheckError(error: unknown): ArchiveCheckError {
  if (error instanceof ArchiveCheckError) return error;
  if (error instanceof ZipFormatError) {
    return new ArchiveCheckError(error.kind === 'limit' ? 'limit' : 'malformed', error.message);
  }
  if (error instanceof TypeError && /decode|encoded/i.test(error.message)) {
    return new ArchiveCheckError('malformed', 'An entry’s name is not valid UTF-8');
  }
  throw error;
}
