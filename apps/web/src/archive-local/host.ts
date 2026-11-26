import { LocalArchive, type LocalDetails, type LocalImageRead, type LocalRead } from './engine';
import { LocalArchiveError, depthLimitError } from './errors';
import type { LocalArchiveLimits } from './limits';
import type { LocalArchiveIndex } from './model';
import { Operation } from './operation';

/**
 * The archives the worker holds, and the cache that bounds them (decision 0058). Kept apart from the messaging so that
 * it can be tested without a worker.
 *
 * Every archive has a parent (another archive held here) or none (a top-level nested archive, whose bytes the page
 * downloaded through the existing single-file API and handed over). The retained cost of an archive is the bytes it
 * owns (a view into its parent costs nothing, a decompressed copy costs its size) plus an estimate of its index.
 * When admitting a new archive would exceed the budget, the least recently used archives are released, together
 * with everything opened inside them, except the ones the page says are in use (the ancestors of what is shown) and
 * the new archive's own ancestors. If that is not enough, the new archive is refused instead.
 */

interface Held {
  id: string;
  parentId: string | null;
  depth: number;
  archive: LocalArchive;
  cost: number;
  lastUsed: number;
}

export interface OpenResult {
  id: string;
  index: LocalArchiveIndex;
  payloadBytes: number;
  depth: number;
  /** Archives released to make room, descendants included. */
  evicted: string[];
  retainedBytes: number;
  indexMs: number;
}

export interface HostStats {
  archives: number;
  retainedBytes: number;
  budgetBytes: number;
}

export class ArchiveHost {
  private readonly held = new Map<string, Held>();
  private clock = 0;

  constructor(readonly limits: LocalArchiveLimits) {}

  stats(): HostStats {
    return {
      archives: this.held.size,
      retainedBytes: this.retained(),
      budgetBytes: this.limits.cacheBytes,
    };
  }

  has(id: string): boolean {
    return this.held.has(id);
  }

  private retained(): number {
    let total = 0;
    for (const item of this.held.values()) total += item.cost;
    return total;
  }

  private get(id: string): Held {
    const item = this.held.get(id);
    if (!item) throw new LocalArchiveError('evicted');
    item.lastUsed = ++this.clock;
    return item;
  }

  private ancestors(id: string | null): Set<string> {
    const chain = new Set<string>();
    for (let at = id; at !== null;) {
      const item = this.held.get(at);
      if (!item) break;
      chain.add(at);
      at = item.parentId;
    }
    return chain;
  }

  /** Releases an archive and every archive opened inside it. Returns their ids. */
  release(id: string): string[] {
    const released: string[] = [];
    const visit = (target: string) => {
      for (const item of [...this.held.values()]) if (item.parentId === target) visit(item.id);
      if (this.held.delete(target)) released.push(target);
    };
    visit(id);
    return released;
  }

  releaseAll(): void {
    this.held.clear();
  }

  /** Makes room for `cost` bytes, keeping `protect` and their ancestors. */
  private makeRoom(cost: number, protect: Set<string>): string[] {
    if (cost > this.limits.cacheBytes) throw new LocalArchiveError('memory_budget');
    const evicted: string[] = [];
    while (this.retained() + cost > this.limits.cacheBytes) {
      const candidates = [...this.held.values()]
        .filter((item) => !protect.has(item.id))
        .sort((a, b) => a.lastUsed - b.lastUsed);
      const victim = candidates[0];
      if (!victim) throw new LocalArchiveError('memory_budget');
      // Releasing a parent releases its children; a protected child keeps its parent protected (see below).
      evicted.push(...this.release(victim.id));
    }
    return evicted;
  }

  private protectedSet(pinned: readonly string[], parentId: string | null): Set<string> {
    const keep = new Set<string>();
    for (const id of [...pinned, ...(parentId ? [parentId] : [])]) {
      for (const ancestor of this.ancestors(id)) keep.add(ancestor);
    }
    return keep;
  }

  async open(request: {
    id: string;
    name: string;
    /** A top-level nested archive's bytes, as downloaded. */
    bytes?: Uint8Array;
    /** Or an entry of an archive held here. */
    parent?: { id: string; entryIndex: number };
    pinned: readonly string[];
    operation: Operation;
  }): Promise<OpenResult> {
    const started = Date.now();
    const { operation } = request;
    if (this.held.has(request.id))
      throw new LocalArchiveError('malformed', 'Duplicate archive id.');
    let bytes: Uint8Array;
    let owned: boolean;
    let depth = 1;
    let parentId: string | null = null;
    if (request.parent) {
      const parent = this.get(request.parent.id);
      parentId = parent.id;
      depth = parent.depth + 1;
      if (depth > this.limits.maxDepth) throw depthLimitError(this.limits.maxDepth);
      const read = await parent.archive.whole(
        request.parent.entryIndex,
        this.limits.maxArchiveBytes,
        'archive_too_large',
        operation,
      );
      bytes = read.data;
      owned = !read.view;
    } else if (request.bytes) {
      bytes = request.bytes;
      owned = true;
    } else {
      throw new LocalArchiveError('malformed');
    }
    if (bytes.length > this.limits.maxArchiveBytes)
      throw new LocalArchiveError('archive_too_large');
    const archive = await LocalArchive.open(bytes, request.name, this.limits, operation, owned);
    operation.check();
    const cost = archive.ownedBytes + archive.indexBytes;
    // A cancelled or failed open never reaches this point, so it never leaves anything in the cache.
    const evicted = this.makeRoom(cost, this.protectedSet(request.pinned, parentId));
    if (parentId && !this.held.has(parentId)) throw new LocalArchiveError('evicted');
    this.held.set(request.id, {
      id: request.id,
      parentId,
      depth,
      archive,
      cost,
      lastUsed: ++this.clock,
    });
    return {
      id: request.id,
      index: archive.index,
      payloadBytes: archive.bytes.length,
      depth,
      evicted,
      retainedBytes: this.retained(),
      indexMs: Date.now() - started,
    };
  }

  async details(id: string, entryIndex: number, operation: Operation): Promise<LocalDetails> {
    return this.get(id).archive.details(entryIndex, this.limits, operation);
  }

  async read(
    id: string,
    entryIndex: number,
    kind: 'text' | 'pdf' | 'hex',
    offset: number,
    operation: Operation,
  ): Promise<LocalRead> {
    const { archive } = this.get(id);
    if (kind === 'text') return archive.text(entryIndex, this.limits, operation);
    if (kind === 'pdf') return archive.pdf(entryIndex, this.limits, operation);
    return archive.range(entryIndex, offset, this.limits.hexBytes, this.limits, operation);
  }

  async image(id: string, entryIndex: number, operation: Operation): Promise<LocalImageRead> {
    return this.get(id).archive.image(entryIndex, this.limits, operation);
  }

  async download(
    id: string,
    entryIndex: number,
    operation: Operation,
  ): Promise<{ data: Uint8Array; integrity: 'verified' | 'complete'; view: boolean }> {
    const read = await this.get(id).archive.whole(
      entryIndex,
      this.limits.downloadBytes,
      'download_too_large',
      operation,
    );
    return read;
  }
}

export const newOperation = (limits: LocalArchiveLimits): Operation =>
  new Operation(limits.operationTimeoutMs);
