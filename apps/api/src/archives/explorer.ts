import { once } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import {
  ARCHIVE_INSPECTION_ERROR_TEXT,
  ARCHIVE_PREVIEW_HEADERS,
  detectContent,
  findPdfHeader,
  type ArchiveEntryDetails,
  type ArchiveEntryQuery,
  type ArchivePreviewMode,
  type ArchivePreviewQuery,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import { ApiError } from '../errors.js';
import {
  EntryVerifier,
  ExtractError,
  compressionOf,
  entryChunks,
  entrySize,
  readEntry,
  seekable,
  type Extracted,
} from './extract.js';
import { cancelledError, type ArchiveInspection, type ResolvedEntry } from './inspection.js';
import { DEFAULT_ARCHIVE_POLICY, type ArchivePolicy } from './policy.js';
import { ImagePreviewError, prepareImage } from './preview-image.js';

/**
 * Archive Explorer (decision 0056): one file of a version's archive, previewed or downloaded by the server over its
 * own repository connection. Read-only and diskless: the file is resolved through the authorized index, only its own
 * bytes are read, in bounded chunks, and nothing is written to disk, staged or cached. Previews and downloads have
 * separate concurrency limits and deadlines, and every one stops, closing its repository connection, as soon as the
 * browser goes away.
 */

const problem = (status: number, code: string, message?: string) =>
  new ApiError(status, code, message ?? ARCHIVE_INSPECTION_ERROR_TEXT[code] ?? code);

/** How many bytes are read to tell what a file is. */
const SNIFF_BYTES = 4096;
const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${Math.round((bytes / 1024 / 1024) * 10) / 10} MiB`
    : `${Math.round(bytes / 1024)} KiB`;

/**
 * A fixed number of slots. A request that finds them all taken waits a little, in a short queue, since a person
 * clicking through files produces bursts that end quickly; when the queue is full, or the wait is over, it is refused.
 * A waiting request holds nothing but its place, and leaves the queue as soon as its browser goes away.
 */
export class Slots {
  private used = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly size: number,
    private readonly busyCode: string,
    private readonly maxWaiting: number,
    private readonly waitMs = 10_000,
  ) {}

  get inUse(): number {
    return this.used;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /** A release that hands the slot straight to the next in the queue, so that nobody can take it in between. */
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.used -= 1;
    };
  }

  async take(signal?: AbortSignal): Promise<() => void> {
    if (this.used < this.size && this.waiting.length === 0) {
      this.used += 1;
      return this.releaser();
    }
    if (this.waiting.length >= this.maxWaiting) throw problem(503, this.busyCode);
    if (signal?.aborted) throw cancelledError();
    await new Promise<void>((resolve, reject) => {
      const turn = () => {
        cleanup();
        resolve();
      };
      const leave = (error: unknown) => {
        const index = this.waiting.indexOf(turn);
        if (index !== -1) this.waiting.splice(index, 1);
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => leave(problem(503, this.busyCode)), this.waitMs);
      const onAbort = () => leave(cancelledError());
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(turn);
    });
    // The slot was handed over by its last holder, already counted.
    return this.releaser();
  }
}

/**
 * A signal for one operation: the request's own (the browser went away) and a deadline, whose reason is the error the
 * request then fails with.
 */
export function operationSignal(request: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(problem(504, 'archive_timeout')), timeoutMs);
  timer.unref();
  const onAbort = () => controller.abort(cancelledError());
  if (request?.aborted) onAbort();
  request?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    abort: (reason: unknown) => controller.abort(reason),
    dispose: () => {
      clearTimeout(timer);
      request?.removeEventListener('abort', onAbort);
    },
  };
}

function extractProblem(error: unknown): unknown {
  if (error instanceof ExtractError) {
    switch (error.kind) {
      case 'encrypted':
        return problem(422, 'entry_unsupported');
      case 'unsupported_compression':
        return problem(422, 'unsupported_compression');
      case 'integrity':
        return problem(422, 'integrity_failed');
      case 'seek_unsupported':
        return problem(422, 'preview_offset_unsupported');
      default:
        return problem(422, 'archive_malformed');
    }
  }
  if (error instanceof ImagePreviewError) {
    if (error.kind === 'too_large') return problem(413, 'image_too_large');
    if (error.kind === 'timeout') return problem(503, 'resource_limit');
    if (error.kind === 'unsupported') return problem(415, 'preview_unavailable');
    return problem(422, 'image_invalid');
  }
  return error;
}

export interface Preview {
  body: Buffer;
  contentType: string;
  headers: Record<string, string>;
}

export interface Download {
  stream: Readable;
  fileName: string;
  sizeBytes: number;
}

export class ArchiveExplorer {
  private readonly previews: Slots;
  private readonly downloads: Slots;

  constructor(
    private readonly inspection: ArchiveInspection,
    private readonly log: FastifyBaseLogger,
    private readonly policy: ArchivePolicy = DEFAULT_ARCHIVE_POLICY,
  ) {
    this.previews = new Slots(
      policy.preview.maxConcurrent,
      'preview_busy',
      policy.preview.maxQueued,
    );
    this.downloads = new Slots(
      policy.download.maxConcurrent,
      'download_busy',
      policy.download.maxQueued,
    );
  }

  get activity(): { previews: number; downloads: number } {
    return { previews: this.previews.inUse, downloads: this.downloads.inUse };
  }

  /** A bounded preview operation: one slot, one deadline, one repository connection at most. */
  private async previewing<T>(
    request: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const release = await this.previews.take(request);
    const { signal, dispose } = operationSignal(request, this.policy.preview.timeoutMs);
    try {
      return await work(signal);
    } catch (error) {
      if (signal.aborted)
        throw signal.reason instanceof ApiError ? signal.reason : cancelledError();
      throw extractProblem(error);
    } finally {
      dispose();
      release();
    }
  }

  private read(
    resolved: ResolvedEntry,
    signal: AbortSignal,
    maxBytes: number,
    start = 0,
  ): Promise<Extracted> {
    return this.inspection.withArchive(resolved, signal, (source) =>
      readEntry(source, resolved.locator, maxBytes, {
        start,
        signal,
        maxSeekBytes: this.policy.preview.maxSeekBytes,
        sha256: resolved.verifySha256,
      }),
    );
  }

  async details(
    vm: VmIdentity,
    versionId: string,
    query: ArchiveEntryQuery,
    request?: AbortSignal,
  ): Promise<ArchiveEntryDetails> {
    return this.previewing(request, async (signal) => {
      const resolved = await this.inspection.entry(vm, versionId, query.view, query.path, signal);
      const size = entrySize(resolved.locator);
      const head =
        size === 0 ? Buffer.alloc(0) : (await this.read(resolved, signal, SNIFF_BYTES)).data;
      const detected = detectContent(resolved.entry.path, head);
      const { preview, download } = this.policy;
      const modes: ArchivePreviewMode[] = [];
      const unavailable: Record<string, string> = {};
      if (detected.kind === 'image') {
        if (size <= preview.imageBytes) modes.push('image');
        else unavailable.image = `Images are previewed up to ${formatBytes(preview.imageBytes)}.`;
      } else if (detected.kind === 'pdf') {
        if (size <= preview.pdfBytes) modes.push('pdf');
        else unavailable.pdf = `PDF files are previewed up to ${formatBytes(preview.pdfBytes)}.`;
      } else if (detected.kind === 'markdown') {
        modes.push('rendered', 'text');
      } else if (detected.kind === 'text') {
        modes.push('text');
      }
      modes.push('hex');
      const canSeek = seekable(resolved.locator);
      return {
        view: resolved.view,
        entry: resolved.entry,
        compression: compressionOf(resolved.locator),
        crc32:
          resolved.locator.format === 'zip'
            ? (resolved.locator.crc32 >>> 0).toString(16).padStart(8, '0')
            : null,
        manifestSha256: resolved.verifySha256,
        detected: {
          kind: detected.kind,
          format: detected.format,
          language: detected.language,
          encoding: detected.encoding,
        },
        modes,
        unavailable,
        hex: {
          seekable: canSeek,
          maxOffset: Math.max(0, canSeek ? size - 1 : Math.min(size - 1, preview.maxSeekBytes)),
          windowBytes: preview.hexBytes,
        },
        download: {
          allowed: download.maxBytes > 0 && size <= download.maxBytes,
          maxBytes: download.maxBytes,
        },
        limits: {
          textBytes: preview.textBytes,
          imageBytes: preview.imageBytes,
          pdfBytes: preview.pdfBytes,
          imagePixels: preview.imagePixels,
        },
      };
    });
  }

  async preview(
    vm: VmIdentity,
    versionId: string,
    query: ArchivePreviewQuery,
    request?: AbortSignal,
  ): Promise<Preview> {
    return this.previewing(request, async (signal) => {
      const resolved = await this.inspection.entry(vm, versionId, query.view, query.path, signal);
      const size = entrySize(resolved.locator);
      const { preview } = this.policy;
      const rangeHeaders = (extracted: Extracted): Record<string, string> => ({
        [ARCHIVE_PREVIEW_HEADERS.offset]: String(extracted.start),
        [ARCHIVE_PREVIEW_HEADERS.length]: String(extracted.data.length),
        [ARCHIVE_PREVIEW_HEADERS.total]: String(extracted.totalBytes),
        [ARCHIVE_PREVIEW_HEADERS.truncated]: String(extracted.truncated),
        [ARCHIVE_PREVIEW_HEADERS.integrity]: extracted.integrity,
      });

      if (query.kind === 'text' || query.kind === 'hex') {
        const maxBytes = query.kind === 'text' ? preview.textBytes : preview.hexBytes;
        const start = query.kind === 'hex' ? query.offset : 0;
        if (start > 0 && start >= size) throw problem(422, 'preview_offset_unsupported');
        const extracted = await this.read(resolved, signal, maxBytes, start);
        return {
          body: extracted.data,
          contentType: 'application/octet-stream',
          headers: rangeHeaders(extracted),
        };
      }

      const limit = query.kind === 'image' ? preview.imageBytes : preview.pdfBytes;
      if (size > limit) throw problem(413, 'preview_too_large');
      // A whole file, verified before any of it is returned.
      const extracted = await this.read(resolved, signal, limit);
      if (query.kind === 'pdf') {
        if (findPdfHeader(extracted.data.subarray(0, 1024)) < 0) {
          throw problem(415, 'preview_unavailable');
        }
        return {
          body: extracted.data,
          // Never `application/pdf`: opened directly, this response must not start a PDF viewer.
          contentType: 'application/octet-stream',
          headers: rangeHeaders(extracted),
        };
      }
      const image = await prepareImage(
        extracted.data,
        resolved.entry.path,
        { maxPixels: preview.imagePixels, timeoutMs: preview.timeoutMs },
        signal,
      );
      return {
        body: image.body,
        contentType: image.contentType,
        headers: {
          ...rangeHeaders(extracted),
          [ARCHIVE_PREVIEW_HEADERS.length]: String(image.body.length),
          [ARCHIVE_PREVIEW_HEADERS.format]: image.format,
          [ARCHIVE_PREVIEW_HEADERS.width]: String(image.width),
          [ARCHIVE_PREVIEW_HEADERS.height]: String(image.height),
          [ARCHIVE_PREVIEW_HEADERS.converted]: String(image.converted),
        },
      };
    });
  }

  /**
   * One file, streamed. The stream is returned once its first bytes are ready (or the whole file, when it is one
   * chunk), so that a failure found before then is an ordinary error response. The last chunk is held back until the
   * whole file has been checked against its CRC-32 and SHA-256: with `Content-Length` set, a download that fails its
   * check can never complete, and the failure is logged.
   */
  async download(
    vm: VmIdentity,
    versionId: string,
    query: ArchiveEntryQuery,
    request?: AbortSignal,
  ): Promise<Download> {
    const { download } = this.policy;
    const release = await this.downloads.take(request);
    const { signal, abort, dispose } = operationSignal(request, download.timeoutMs);
    const finish = () => {
      dispose();
      release();
    };
    let resolved: ResolvedEntry;
    try {
      resolved = await this.inspection.entry(vm, versionId, query.view, query.path, signal);
      if (download.maxBytes === 0 || entrySize(resolved.locator) > download.maxBytes) {
        throw problem(413, 'download_too_large');
      }
    } catch (error) {
      finish();
      if (signal.aborted)
        throw signal.reason instanceof ApiError ? signal.reason : cancelledError();
      throw error;
    }

    const out = new PassThrough({ highWaterMark: 1024 * 1024 });
    let started = false;
    let markReady: () => void = () => undefined;
    let failEarly: (error: unknown) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failEarly = reject;
    });
    const send = async (chunk: Buffer) => {
      if (!started) {
        started = true;
        markReady();
      }
      if (!out.write(chunk)) await once(out, 'drain', { signal });
    };
    const { locator, verifySha256 } = resolved;
    const job = this.inspection.withArchive(resolved, signal, async (source) => {
      const verifier = new EntryVerifier(locator, verifySha256);
      let held: Buffer | null = null;
      for await (const chunk of entryChunks(source, locator, { signal })) {
        verifier.update(chunk);
        if (held) await send(held);
        held = chunk;
      }
      const integrity = verifier.finish();
      if (held) await send(held);
      if (!started) {
        started = true;
        markReady();
      }
      out.end();
      return integrity;
    });
    // The browser leaving destroys the stream; that ends the job too.
    out.once('close', () => {
      if (!out.writableFinished) abort(cancelledError());
    });
    job
      .then((integrity) => {
        this.log.info(
          { versionId, path: resolved.entry.path, bytes: entrySize(locator), integrity },
          'Archive file downloaded',
        );
      })
      .catch((error: unknown) => {
        const mapped = signal.aborted
          ? signal.reason instanceof ApiError
            ? signal.reason
            : cancelledError()
          : extractProblem(error);
        if (!started) failEarly(mapped);
        else {
          const level =
            mapped instanceof ApiError && mapped.code === 'request_cancelled' ? 'info' : 'error';
          this.log[level](
            {
              versionId,
              path: resolved.entry.path,
              code: mapped instanceof ApiError ? mapped.code : 'internal_error',
            },
            'An archive file download stopped before it was complete; the browser does not have the whole file',
          );
          out.destroy(mapped instanceof Error ? mapped : new Error('Download failed'));
        }
      })
      .finally(finish);
    await ready;
    return {
      stream: out,
      fileName: resolved.entry.name,
      sizeBytes: entrySize(locator),
    };
  }
}
