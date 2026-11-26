import type { ArchiveEntryDetails, ArchivePreviewMode } from '@emucat/contracts';
import {
  BROWSER_IMAGE_FORMATS,
  PREVIEW_IMAGE_MIME,
  detectContent,
  type PreviewImageFormat,
} from '@emucat/contracts/archive-preview';
import { crc32, hex8 } from './bytes';
import {
  archiveFormatFromName,
  isDiskImageName,
  sniffArchive,
  sniffUnsupportedArchive,
  unsupportedArchiveFromName,
} from './detect';
import { LocalArchiveError } from './errors';
import { gunzipBounded } from './gzip';
import { LEGACY_DECODERS, browserImageSize, checkImageSize, type RgbaImage } from './images';
import { inflateBounded } from './inflate';
import type { LocalArchiveLimits } from './limits';
import {
  indexWeight,
  type LocalArchiveFormat,
  type LocalArchiveIndex,
  type LocalEntry,
} from './model';
import type { Operation } from './operation';
import { baseName } from './paths';
import { looksLikeTar, readTar, type TarLocator } from './tar';
import { readZip, zipEntryData, type ZipLocator } from './zip';

/**
 * One archive opened in the browser (decision 0058): its bytes, its index and how to read each entry, with every
 * limit applied to actual bytes. Pure: no DOM, no messaging. The worker owns instances; tests use them directly.
 */

const SNIFF_BYTES = 4096;
const SIGNATURE_BYTES = 512;

type Locator =
  { kind: 'zip'; zip: ZipLocator } | { kind: 'tar'; tar: TarLocator } | { kind: 'whole' };

export type LocalIntegrity = 'verified' | 'complete' | 'partial';

export interface LocalRead {
  bytes: Uint8Array;
  offset: number;
  totalBytes: number;
  truncated: boolean;
  integrity: LocalIntegrity;
}

export interface LocalImageRead extends LocalRead {
  contentType: string;
  image: { format: string; width: number; height: number; converted: boolean };
  /** For a legacy format, the decoded pixels, which the page turns into a PNG; `bytes` is then empty. */
  rgba: RgbaImage | null;
}

export class LocalArchive {
  private constructor(
    readonly format: LocalArchiveFormat,
    /** The bytes entries are read from: the archive itself, or a decompressed TAR. */
    readonly bytes: Uint8Array,
    readonly index: LocalArchiveIndex,
    private readonly locators: Locator[],
    private readonly directoryOffset: number,
    /** Bytes this archive holds beyond what its parent already holds (a view into a parent costs nothing). */
    readonly ownedBytes: number,
  ) {}

  get indexBytes(): number {
    return indexWeight(this.index.entries);
  }

  /**
   * Confirms the format from the bytes and reads the index. `name` only helps tell an OVA from another TAR and
   * names a single GZIP file; it never decides that bytes are an archive.
   */
  static async open(
    bytes: Uint8Array,
    name: string,
    limits: LocalArchiveLimits,
    operation: Operation,
    owned: boolean,
  ): Promise<LocalArchive> {
    if (bytes.length > limits.maxArchiveBytes) throw new LocalArchiveError('archive_too_large');
    const sniffed = sniffArchive(bytes.subarray(0, SIGNATURE_BYTES));
    const listLimits = { maxEntries: limits.maxEntries, maxPathBytes: limits.maxPathBytes };
    if (sniffed === 'zip-spanned') throw new LocalArchiveError('multi_volume');
    if (sniffed === 'zip') {
      const listing = readZip(bytes, listLimits);
      const archive = new LocalArchive(
        'zip',
        bytes,
        { format: 'zip', entries: listing.entries, warnings: [], checksummed: true },
        listing.locators.map((zip) => ({ kind: 'zip', zip })),
        listing.directoryOffset,
        owned ? bytes.length : 0,
      );
      await archive.annotate(operation);
      return archive;
    }
    if (sniffed === 'tar') {
      return LocalArchive.fromTar(
        bytes,
        /\.ova$/iu.test(name) ? 'ova' : 'tar',
        listLimits,
        operation,
        owned ? bytes.length : 0,
      );
    }
    if (sniffed === 'gzip') {
      const { header, data } = await gunzipBounded(bytes, limits.maxArchiveBytes, operation);
      // The compressed bytes are not kept: only what was decompressed.
      const extra = data.length;
      if (looksLikeTar(data) || (data.length >= 1024 && data.every((byte) => byte === 0))) {
        return LocalArchive.fromTar(data, 'tar.gz', listLimits, operation, extra);
      }
      const inner =
        header.name && !header.name.includes('/') && !header.name.includes('\\')
          ? header.name
          : baseName(name).replace(/\.gz$/iu, '') || 'contents';
      const entry: LocalEntry = {
        index: 0,
        path: inner,
        name: inner,
        type: 'file',
        sizeBytes: data.length,
        compressedSizeBytes: bytes.length,
        method: 'deflated',
        crc32: hex8(header.crc32),
        modifiedAt: header.modifiedAt,
        unsafePath: false,
        problem: null,
        archive: null,
        unsupportedArchive: null,
      };
      const archive = new LocalArchive(
        'gzip',
        data,
        { format: 'gzip', entries: [entry], warnings: [], checksummed: true },
        [{ kind: 'whole' }],
        data.length,
        extra,
      );
      await archive.annotate(operation);
      return archive;
    }
    const unsupported = sniffUnsupportedArchive(bytes.subarray(0, SIGNATURE_BYTES));
    if (unsupported) {
      throw new LocalArchiveError(
        'unsupported_format',
        `${unsupported} archives cannot be opened in the browser.`,
      );
    }
    throw new LocalArchiveError(archiveFormatFromName(name) ? 'malformed' : 'unsupported_format');
  }

  private static async fromTar(
    bytes: Uint8Array,
    format: 'tar' | 'ova' | 'tar.gz',
    limits: { maxEntries: number; maxPathBytes: number },
    operation: Operation,
    ownedBytes: number,
  ): Promise<LocalArchive> {
    const listing = readTar(bytes, limits);
    const warnings: string[] = [];
    if (format === 'ova') {
      const nested = listing.entries.some(
        (entry) => entry.path.includes('/') || entry.type !== 'file',
      );
      const first = listing.entries[0];
      if (nested) warnings.push('This OVA is not flat: VirtualBox would not import it as it is.');
      if (!first || !first.name.toLowerCase().endsWith('.ovf')) {
        warnings.push('This OVA does not start with its OVF descriptor.');
      }
    }
    const archive = new LocalArchive(
      format,
      bytes,
      { format, entries: listing.entries, warnings, checksummed: false },
      listing.locators.map((tar) => ({ kind: 'tar', tar })),
      bytes.length,
      ownedBytes,
    );
    await archive.annotate(operation);
    return archive;
  }

  /** Marks duplicates, unreadable entries and entries that look like archives. */
  private async annotate(operation: Operation): Promise<void> {
    const { entries, warnings } = this.index;
    const seen = new Map<string, number>();
    let duplicates = 0;
    let unreadable = 0;
    let unsafe = 0;
    for (const entry of entries) {
      if (entry.index % 512 === 511) await operation.checkpoint();
      if (entry.unsafePath) unsafe += 1;
      else if (entry.problem) unreadable += 1;
      if (entry.type !== 'file' || entry.unsafePath) continue;
      const count = seen.get(entry.path) ?? 0;
      seen.set(entry.path, count + 1);
      if (count > 0) duplicates += 1;
      if (entry.problem) continue;
      if (isDiskImageName(entry.name)) continue;
      const byName = archiveFormatFromName(entry.name);
      const unsupportedByName = unsupportedArchiveFromName(entry.name);
      const locator = this.locators[entry.index];
      const direct =
        locator?.kind === 'tar' || (locator?.kind === 'zip' && locator.zip.method === 0);
      if (direct && entry.sizeBytes > 0) {
        // Stored bytes are at hand: the signature decides, and a name that says otherwise is ignored.
        let head: Uint8Array;
        try {
          head = this.directSlice(entry.index, 0, SIGNATURE_BYTES);
        } catch {
          entry.problem = 'Not read: its local header does not match the archive’s directory.';
          unreadable += 1;
          continue;
        }
        const sniffed = sniffArchive(head);
        if (sniffed && sniffed !== 'zip-spanned') {
          entry.archive = {
            format: sniffed === 'tar' && /\.ova$/iu.test(entry.name) ? 'ova' : sniffed,
            by: 'signature',
          };
        } else {
          entry.unsupportedArchive =
            sniffUnsupportedArchive(head) ?? (byName ? null : unsupportedByName);
        }
      } else if (byName) {
        entry.archive = { format: byName, by: 'name' };
      } else {
        entry.unsupportedArchive = unsupportedByName;
      }
    }
    if (duplicates > 0) {
      warnings.push(
        `${duplicates} ${duplicates === 1 ? 'entry has' : 'entries have'} the same path as another. Each is listed and read on its own.`,
      );
    }
    if (unsafe > 0) {
      warnings.push(
        `${unsafe} ${unsafe === 1 ? 'entry has' : 'entries have'} an unsafe path (absolute, “..” or control characters): listed at the top, never read.`,
      );
    }
    if (unreadable > 0) {
      warnings.push(
        `${unreadable} ${unreadable === 1 ? 'entry cannot' : 'entries cannot'} be read: links, special files, encrypted entries or unsupported compression.`,
      );
    }
  }

  entry(index: number): LocalEntry {
    const entry = this.index.entries[index];
    if (!entry) throw new LocalArchiveError('entry_unreadable');
    return entry;
  }

  private readable(index: number): { entry: LocalEntry; locator: Locator } {
    const entry = this.entry(index);
    const locator = this.locators[index];
    if (!locator || entry.type !== 'file' || entry.problem) {
      throw new LocalArchiveError(
        entry.problem?.includes('encrypted')
          ? 'encrypted'
          : entry.problem?.includes('compressed with')
            ? 'unsupported_compression'
            : 'entry_unreadable',
        entry.problem ?? undefined,
      );
    }
    return { entry, locator };
  }

  /** Whether an entry's bytes can be read at any offset without decompressing. */
  private isDirect(locator: Locator): boolean {
    return locator.kind !== 'zip' || locator.zip.method === 0;
  }

  /** Bytes of a stored entry (a view, no copy). */
  private directSlice(index: number, offset: number, length: number): Uint8Array {
    const locator = this.locators[index] as Locator;
    const entry = this.index.entries[index] as LocalEntry;
    const start = Math.min(offset, entry.sizeBytes);
    const end = Math.min(entry.sizeBytes, start + length);
    if (locator.kind === 'tar') {
      return this.bytes.subarray(locator.tar.dataOffset + start, locator.tar.dataOffset + end);
    }
    if (locator.kind === 'whole') return this.bytes.subarray(start, end);
    const data = zipEntryData(this.bytes, locator.zip, this.directoryOffset);
    if (data.length !== entry.sizeBytes) throw new LocalArchiveError('malformed');
    return data.subarray(start, end);
  }

  /** The first `length` bytes of an entry, decompressing no more than needed. */
  async prefix(index: number, length: number, operation: Operation): Promise<Uint8Array> {
    const { entry, locator } = this.readable(index);
    if (this.isDirect(locator)) return this.directSlice(index, 0, length);
    const zip = (locator as { kind: 'zip'; zip: ZipLocator }).zip;
    const compressed = zipEntryData(this.bytes, zip, this.directoryOffset);
    const result = await inflateBounded(compressed, {
      wanted: Math.min(length, entry.sizeBytes),
      maxOutput: entry.sizeBytes,
      whole: false,
      operation,
    });
    return result.data;
  }

  /**
   * An entry read whole, at most `maxBytes`, and checked: its size, and for ZIP its CRC-32. `limitCode` says which
   * limit a larger entry breaks.
   */
  async whole(
    index: number,
    maxBytes: number,
    limitCode: 'preview_too_large' | 'download_too_large' | 'archive_too_large',
    operation: Operation,
  ): Promise<{ data: Uint8Array; integrity: 'verified' | 'complete'; view: boolean }> {
    const { entry, locator } = this.readable(index);
    if (entry.sizeBytes > maxBytes) throw new LocalArchiveError(limitCode);
    if (locator.kind === 'tar') {
      return {
        data: this.directSlice(index, 0, entry.sizeBytes),
        integrity: 'complete',
        view: true,
      };
    }
    if (locator.kind === 'whole') {
      // A GZIP's single file: decompressed and checked against the trailer's CRC-32 when the archive was opened.
      return { data: this.bytes, integrity: 'verified', view: true };
    }
    const zip = locator.zip;
    if (zip.method === 0) {
      const data = this.directSlice(index, 0, entry.sizeBytes);
      for (let at = 0, crc = 0; ; at += 1 << 20) {
        crc = crc32(data.subarray(at, at + (1 << 20)), crc);
        if (at + (1 << 20) >= data.length) {
          if (crc !== zip.crc32 >>> 0) throw new LocalArchiveError('integrity_failed');
          break;
        }
        await operation.checkpoint();
      }
      return { data, integrity: 'verified', view: true };
    }
    const compressed = zipEntryData(this.bytes, zip, this.directoryOffset);
    const result = await inflateBounded(compressed, {
      wanted: entry.sizeBytes,
      maxOutput: entry.sizeBytes,
      whole: true,
      operation,
    });
    if (result.crc32 !== zip.crc32 >>> 0) throw new LocalArchiveError('integrity_failed');
    return { data: result.data, integrity: 'verified', view: false };
  }

  /** A hex window. A deflated entry is decompressed from its start, so it may only start within `maxSeekBytes`. */
  async range(
    index: number,
    offset: number,
    length: number,
    limits: LocalArchiveLimits,
    operation: Operation,
  ): Promise<LocalRead> {
    const { entry, locator } = this.readable(index);
    const start = Math.min(offset, entry.sizeBytes);
    let bytes: Uint8Array;
    if (this.isDirect(locator)) bytes = this.directSlice(index, start, length);
    else {
      if (start > limits.maxSeekBytes) throw new LocalArchiveError('offset_unsupported');
      const head = await this.prefix(index, start + length, operation);
      bytes = head.subarray(start);
    }
    return {
      bytes,
      offset: start,
      totalBytes: entry.sizeBytes,
      truncated: start + bytes.length < entry.sizeBytes || start > 0,
      integrity: 'partial',
    };
  }

  /** What the file is and which previews fit, as the server's details describe a top-level file. */
  async details(
    index: number,
    limits: LocalArchiveLimits,
    operation: Operation,
  ): Promise<LocalDetails> {
    const { entry, locator } = this.readable(index);
    const head =
      entry.sizeBytes === 0 ? new Uint8Array(0) : await this.prefix(index, SNIFF_BYTES, operation);
    const detected = detectContent(entry.path, head);
    const modes: ArchivePreviewMode[] = [];
    const unavailable: Record<string, string> = {};
    const size = entry.sizeBytes;
    if (detected.kind === 'image') {
      const format = detected.format as PreviewImageFormat;
      if (!BROWSER_IMAGE_FORMATS.has(format) && !LEGACY_DECODERS[format]) {
        unavailable.image = `${format.toUpperCase()} images inside a nested archive cannot be decoded in the browser.`;
      } else if (size > limits.imageBytes) {
        unavailable.image = `Images are previewed up to ${Math.round(limits.imageBytes / 1048576)} MiB.`;
      } else modes.push('image');
    } else if (detected.kind === 'pdf') {
      if (size <= limits.pdfBytes) modes.push('pdf');
      else
        unavailable.pdf = `PDF files are previewed up to ${Math.round(limits.pdfBytes / 1048576)} MiB.`;
    } else if (detected.kind === 'markdown') {
      modes.push('rendered', 'text');
    } else if (detected.kind === 'text') {
      modes.push('text');
    }
    modes.push('hex');
    const direct = this.isDirect(locator);
    return {
      entry,
      compression: direct ? 'stored' : 'deflated',
      crc32: entry.crc32,
      detected: {
        kind: detected.kind,
        format: detected.format,
        language: detected.language,
        encoding: detected.encoding,
      },
      modes,
      unavailable,
      hex: {
        seekable: direct,
        maxOffset: Math.max(0, direct ? size - 1 : Math.min(size - 1, limits.maxSeekBytes)),
        windowBytes: limits.hexBytes,
      },
      download: { allowed: size <= limits.downloadBytes, maxBytes: limits.downloadBytes },
      limits: {
        textBytes: limits.textBytes,
        imageBytes: limits.imageBytes,
        pdfBytes: limits.pdfBytes,
        imagePixels: limits.imagePixels,
      },
      checksummed: this.index.checksummed,
    };
  }

  async text(index: number, limits: LocalArchiveLimits, operation: Operation): Promise<LocalRead> {
    const { entry } = this.readable(index);
    if (entry.sizeBytes <= limits.textBytes) {
      const read = await this.whole(index, limits.textBytes, 'preview_too_large', operation);
      return {
        bytes: read.data,
        offset: 0,
        totalBytes: entry.sizeBytes,
        truncated: false,
        integrity: read.integrity,
      };
    }
    const bytes = await this.prefix(index, limits.textBytes, operation);
    return { bytes, offset: 0, totalBytes: entry.sizeBytes, truncated: true, integrity: 'partial' };
  }

  async pdf(index: number, limits: LocalArchiveLimits, operation: Operation): Promise<LocalRead> {
    const { entry } = this.readable(index);
    const read = await this.whole(index, limits.pdfBytes, 'preview_too_large', operation);
    return {
      bytes: read.data,
      offset: 0,
      totalBytes: entry.sizeBytes,
      truncated: false,
      integrity: read.integrity,
    };
  }

  async image(
    index: number,
    limits: LocalArchiveLimits,
    operation: Operation,
  ): Promise<LocalImageRead> {
    const { entry } = this.readable(index);
    const read = await this.whole(index, limits.imageBytes, 'preview_too_large', operation);
    const detected = detectContent(entry.path, read.data.subarray(0, SNIFF_BYTES));
    if (detected.kind !== 'image') throw new LocalArchiveError('image_invalid');
    const format = detected.format as PreviewImageFormat;
    const base = {
      offset: 0,
      totalBytes: entry.sizeBytes,
      truncated: false,
      integrity: read.integrity,
    };
    if (BROWSER_IMAGE_FORMATS.has(format)) {
      const size = browserImageSize(read.data, format);
      if (!size) throw new LocalArchiveError('image_invalid');
      checkImageSize(size, limits.imagePixels);
      return {
        ...base,
        bytes: read.data,
        contentType: PREVIEW_IMAGE_MIME[format],
        image: { format, width: size.width, height: size.height, converted: false },
        rgba: null,
      };
    }
    const decoder = LEGACY_DECODERS[format];
    if (!decoder) throw new LocalArchiveError('image_invalid');
    const steps = decoder(read.data, limits.imagePixels);
    let step = steps.next();
    while (!step.done) {
      await operation.checkpoint();
      step = steps.next();
    }
    const rgba = step.value;
    return {
      ...base,
      bytes: new Uint8Array(0),
      contentType: 'image/png',
      image: { format, width: rgba.width, height: rgba.height, converted: true },
      rgba,
    };
  }
}

export type LocalDetails = Omit<ArchiveEntryDetails, 'view' | 'entry' | 'manifestSha256'> & {
  entry: LocalEntry;
  /** Whether the archive format records a checksum per entry. */
  checksummed: boolean;
};
