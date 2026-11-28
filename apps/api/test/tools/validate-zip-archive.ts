/**
 * Optional validation of a real VM archive through the server's own ZIP code (decision 0061, F-4), for archives too
 * large for the normal suite: the central directory as resolved, inspection with the manifest, every file hashed
 * (or, above `--hash-max`, its first 4 MiB read through the extraction path), and optionally a server-clone rewrite,
 * inspected and hashed again. Reads the archive only; writes only the `--rewrite` target, which must not exist.
 *
 *   pnpm --filter @emucat/api exec tsx test/tools/validate-zip-archive.ts <archive.zip>
 *     [--hash-max <bytes>] [--rewrite <target.zip> <new VM name>]
 *
 * Prints one JSON object. Not part of any test run, and not shipped in the API image.
 */
import { createHash } from 'node:crypto';
import { entryChunks, type ZipLocator } from '../../src/archives/extract.js';
import {
  canonicalManifestBytes,
  inspectZip,
  MANIFEST_ENTRY_NAME,
  type Manifest,
} from '../../src/archives/manifest.js';
import {
  hashEntry,
  openLocal,
  readCentralDirectory,
  readSmallEntry,
  rewriteZip,
  type ZipEntry,
} from '../../src/archives/zip.js';

const LIMITS = { maxEntries: 500_000, maxDirectoryBytes: 128 * 1024 * 1024 };
const PREFIX_BYTES = 4 * 1024 * 1024;

const args = process.argv.slice(2);
const path = args[0];
if (!path || path.startsWith('--')) {
  console.error(
    'Usage: validate-zip-archive.ts <archive.zip> [--hash-max <bytes>] [--rewrite <target.zip> <vm>]',
  );
  process.exit(2);
}
const option = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args.slice(index + 1);
};
const hashMax = Number(option('--hash-max')?.[0] ?? 64 * 1024 * 1024);
const rewrite = option('--rewrite');
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const crc = (entry: ZipEntry) => (entry.crc32 >>> 0).toString(16).padStart(8, '0');
const describe = (entry: ZipEntry) => ({
  name: entry.name,
  method: entry.method,
  crc32: crc(entry),
  compressedSize: entry.compressedSize,
  uncompressedSize: entry.uncompressedSize,
  localHeaderOffset: entry.localHeaderOffset,
  zip64: entry.zip64,
  otherExtraBytes: entry.extra.length,
});

/** Every file of the manifest hashed, or for a large one, its first bytes read as a preview would. */
async function files(
  archivePath: string,
  source: Awaited<ReturnType<typeof openLocal>>,
  entries: ZipEntry[],
  manifest: Manifest,
  directoryOffset: number,
) {
  const result: Record<string, unknown> = {};
  for (const listed of manifest.entries) {
    if (listed.type !== 'file') continue;
    const entry = entries.find((item) => item.name === listed.path);
    if (!entry) throw new Error(`${listed.path} is not in the archive`);
    if (entry.uncompressedSize > hashMax) {
      const locator: ZipLocator = {
        format: 'zip',
        name: entry.name,
        localHeaderOffset: entry.localHeaderOffset,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        method: entry.method,
        crc32: entry.crc32,
        flags: entry.flags,
        limit: directoryOffset,
      };
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of entryChunks(source, locator)) {
        hash.update(chunk);
        bytes += chunk.length;
        if (bytes >= PREFIX_BYTES) break;
      }
      result[listed.path] = { prefixBytes: bytes, prefixSha256: hash.digest('hex') };
      continue;
    }
    const started = performance.now();
    const digest = await hashEntry(archivePath, source, entry, () => undefined);
    result[listed.path] = {
      sha256: digest,
      matchesManifest: digest === listed.sha256,
      ms: Math.round(performance.now() - started),
    };
  }
  return result;
}

const out: Record<string, unknown> = { path };
const source = await openLocal(path);
try {
  let started = performance.now();
  const { entries, directoryOffset } = await readCentralDirectory(source, LIMITS);
  out.centralDirectory = {
    ms: +(performance.now() - started).toFixed(1),
    directoryOffset,
    entries: entries.map(describe),
  };
  const manifestEntry = entries.find((entry) => entry.name === MANIFEST_ENTRY_NAME);
  if (!manifestEntry) throw new Error(`No ${MANIFEST_ENTRY_NAME}`);
  const raw = await readSmallEntry(source, manifestEntry, 1024 * 1024);
  const claimed = JSON.parse(raw.toString('utf8')) as Manifest;
  started = performance.now();
  const inspected = await inspectZip(source, {
    emulatorType: claimed.emulatorType,
    vmName: claimed.vmName,
    manifestSha256: sha256(raw),
  });
  out.inspectZip = {
    ms: +(performance.now() - started).toFixed(1),
    emulatorType: inspected.manifest.emulatorType,
    vmName: inspected.manifest.vmName,
    manifestSha256: inspected.manifestSha256,
    fileCount: inspected.manifest.fileCount,
  };
  out.files = await files(path, source, entries, inspected.manifest, directoryOffset);

  if (rewrite) {
    const [target, vmName] = rewrite;
    if (!target || !vmName) throw new Error('--rewrite needs a target and a VM name');
    const renamed = canonicalManifestBytes({ ...inspected.manifest, vmName });
    started = performance.now();
    await rewriteZip(
      path,
      target,
      MANIFEST_ENTRY_NAME,
      MANIFEST_ENTRY_NAME,
      renamed,
      LIMITS,
      () => undefined,
    );
    const ms = Math.round(performance.now() - started);
    const clone = await openLocal(target);
    try {
      const again = await inspectZip(clone, {
        emulatorType: inspected.manifest.emulatorType,
        vmName,
        manifestSha256: sha256(renamed),
      });
      out.rewrite = {
        ms,
        target,
        sizeBytes: clone.sizeBytes,
        manifestSha256: again.manifestSha256,
        entries: again.entries.map(describe),
        files: await files(target, clone, again.entries, again.manifest, again.directoryOffset),
      };
    } finally {
      await clone.close();
    }
  }
} catch (error) {
  out.error = `${(error as Error).name}: ${(error as Error).message}`;
  process.exitCode = 1;
} finally {
  await source.close();
}
console.log(JSON.stringify(out, null, 1));
