import { mkdir, readdir, rm, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TransferPolicy } from './policy.js';

/**
 * The server's staging directory (decision 0055): `transfers/<id>/` for each relayed transfer and `clones/<id>/`
 * for each server-side clone, nothing else. Names are server-issued UUIDs only, so no request can name a path.
 * Space is reserved before anything is written, against both the configured capacity and what the disk has free,
 * and a reservation is held until its directory is removed. One API process owns the directory (decision 0003), so
 * the reservations are counted here.
 */

export class StagingFullError extends Error {
  override readonly name = 'StagingFullError';
  readonly code = 'transfer_staging_full';
}

export class StagingBusyError extends Error {
  override readonly name = 'StagingBusyError';
  readonly code = 'transfer_busy';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type StagingKind = 'transfers' | 'clones';

export interface Reservation {
  readonly bytes: number;
  release(): void;
}

export class StagingArea {
  readonly root: string;
  private readonly reservations = new Map<string, number>();
  private readonly slots = new Set<string>();

  constructor(
    private readonly policy: TransferPolicy,
    private readonly freeBytesOf: (path: string) => Promise<number | null> = diskFree,
  ) {
    this.root = resolve(policy.stagingPath);
  }

  async prepare(): Promise<void> {
    await mkdir(join(this.root, 'transfers'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, 'clones'), { recursive: true, mode: 0o700 });
  }

  /** The directory of one transfer or clone. Only a UUID is ever accepted as its name. */
  directory(kind: StagingKind, id: string): string {
    if (!UUID.test(id)) throw new Error('A staging directory is named by a UUID');
    return join(this.root, kind, id);
  }

  async create(kind: StagingKind, id: string): Promise<string> {
    const path = this.directory(kind, id);
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }

  async remove(kind: StagingKind, id: string): Promise<void> {
    await rm(this.directory(kind, id), { recursive: true, force: true });
  }

  /**
   * What is in `transfers/` or `clones/` and is not a UUID-named entry: nothing EmuCat made. It is reported, never
   * removed, since only names the server issued are ever deleted (assessment R8).
   */
  async unexpected(kind: StagingKind): Promise<string[]> {
    try {
      return (await readdir(join(this.root, kind))).filter((name) => !UUID.test(name)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private reportedUnexpected = '';

  /**
   * Logs unexpected artifacts once, and again only when what is there changes, so that a persistent stray file does
   * not fill the log. Names are truncated and never interpreted as paths.
   */
  async reportUnexpected(log: {
    warn(object: object, message: string): void;
    info(object: object, message: string): void;
  }): Promise<void> {
    const found: Record<StagingKind, string[]> = {
      transfers: await this.unexpected('transfers'),
      clones: await this.unexpected('clones'),
    };
    const signature = JSON.stringify(found);
    if (signature === this.reportedUnexpected) return;
    const hadAny =
      this.reportedUnexpected !== '' && this.reportedUnexpected !== '{"transfers":[],"clones":[]}';
    this.reportedUnexpected = signature;
    const count = found.transfers.length + found.clones.length;
    if (count === 0) {
      if (hadAny) log.info({}, 'The staging area no longer holds unexpected files');
      return;
    }
    const sample = (names: string[]) => names.slice(0, 10).map((name) => name.slice(0, 80));
    log.warn(
      {
        stagingRoot: this.root,
        transfers: sample(found.transfers),
        clones: sample(found.clones),
        count,
      },
      'The staging area holds files EmuCat did not create (not UUID-named). They are left in place: check and remove them by hand',
    );
  }

  /** The UUID-named directories present, for recovery: whatever no record claims is removed. */
  async present(kind: StagingKind): Promise<string[]> {
    try {
      return (await readdir(join(this.root, kind))).filter((name) => UUID.test(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  get reservedBytes(): number {
    let total = 0;
    for (const bytes of this.reservations.values()) total += bytes;
    return total;
  }

  get activeCount(): number {
    return this.slots.size;
  }

  /** Records a reservation that already exists (after a restart), whatever the limits now say. */
  adopt(id: string, bytes: number): Reservation {
    this.reservations.set(id, bytes);
    return { bytes, release: () => this.reservations.delete(id) };
  }

  /**
   * Reserves room for `bytes`. Refused when the configured capacity would be exceeded, or when the disk would keep
   * less than the configured minimum free. A repeated reservation for the same ID replaces the earlier one.
   */
  async reserve(id: string, bytes: number): Promise<Reservation> {
    const others = this.reservedBytes - (this.reservations.get(id) ?? 0);
    if (others + bytes > this.policy.maxStagingBytes) {
      throw new StagingFullError(
        'The server’s transfer staging is full. Try again once other transfers finish.',
      );
    }
    const free = await this.freeBytesOf(this.root);
    // Reservations not yet written still need their room.
    const unwritten = Math.max(0, others);
    if (free !== null && free - unwritten - bytes < this.policy.minFreeBytes) {
      throw new StagingFullError(
        'The server’s staging disk does not have room for this transfer. Try again later.',
      );
    }
    return this.adopt(id, bytes);
  }

  /** One of the configured number of concurrent transfers and clones. */
  claimSlot(id: string): () => void {
    if (!this.slots.has(id) && this.slots.size >= this.policy.maxConcurrent) {
      throw new StagingBusyError(
        'The server is running as many transfers as it allows. Try again shortly.',
      );
    }
    this.slots.add(id);
    return () => this.slots.delete(id);
  }

  hasSlot(id: string): boolean {
    return this.slots.has(id);
  }

  freeSlots(): number {
    return Math.max(0, this.policy.maxConcurrent - this.slots.size);
  }
}

async function diskFree(path: string): Promise<number | null> {
  try {
    const stats = await statfs(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}
