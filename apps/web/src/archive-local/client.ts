import type { LocalDetails, LocalImageRead, LocalRead } from './engine';
import { LocalArchiveError, type LocalArchiveErrorCode } from './errors';
import type { HostStats, OpenResult } from './host';
import { DEFAULT_LOCAL_LIMITS, type LocalArchiveLimits } from './limits';
import type { WorkerRequest, WorkerResponse, WorkerResult } from './protocol';

/**
 * The page's side of the archive worker (decision 0058). One client per open Archive Explorer: the worker is started
 * on the first nested archive opened, and terminated by `dispose()`, which releases everything it holds at once.
 *
 * `dispose()` is not final: React's StrictMode runs an effect's cleanup once on mount, so a request after it simply
 * starts a new worker, which holds nothing.
 *
 * An aborted request is answered at once with an `AbortError`, and the worker is told to stop it; whatever the worker
 * answers later for it is dropped, so a late answer can never replace a newer one. If the worker fails, every
 * pending request fails, the archives it held are reported released, and the next request starts a new worker.
 */

export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export const createArchiveWorker = (): WorkerLike =>
  new Worker(new URL('./archive.worker.ts', import.meta.url), {
    type: 'module',
    name: 'emucat-archive',
  }) as unknown as WorkerLike;

type Request = WorkerRequest extends infer R
  ? R extends WorkerRequest
    ? Omit<R, 'op'>
    : never
  : never;

interface Pending {
  resolve: (value: WorkerResult) => void;
  reject: (error: unknown) => void;
}

const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

export class LocalArchiveClient {
  private worker: WorkerLike | null = null;
  private nextOp = 1;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly held = new Set<string>();
  private readonly releaseListeners = new Set<(ids: string[]) => void>();
  private activeOpens = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    readonly limits: LocalArchiveLimits = DEFAULT_LOCAL_LIMITS,
    private readonly create: () => WorkerLike = createArchiveWorker,
  ) {}

  /** A new archive id, unique for this client. */
  newId(): string {
    return `nested-${this.nextId++}`;
  }

  /** Called with the ids of archives the worker no longer holds (released for memory, or lost with the worker). */
  onReleased(listener: (ids: string[]) => void): () => void {
    this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }

  get started(): boolean {
    return this.worker !== null;
  }

  heldIds(): string[] {
    return [...this.held];
  }

  private released(ids: string[]): void {
    const gone = ids.filter((id) => this.held.delete(id));
    if (gone.length === 0) return;
    for (const listener of this.releaseListeners) listener(gone);
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.create();
    worker.onmessage = (event) => {
      const response = event.data;
      const pending = this.pending.get(response.op);
      if (!pending) return;
      this.pending.delete(response.op);
      if (response.ok) pending.resolve(response.value);
      else
        pending.reject(
          new LocalArchiveError(response.code as LocalArchiveErrorCode, response.message),
        );
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      this.fail();
    };
    this.worker = worker;
    if (this.limits !== DEFAULT_LOCAL_LIMITS) {
      worker.postMessage({ op: this.nextOp++, type: 'configure', limits: { ...this.limits } });
    }
    return worker;
  }

  private fail(): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(new LocalArchiveError('worker_failed'));
    this.released([...this.held]);
  }

  private send(
    request: Request,
    signal?: AbortSignal,
    transfer: Transferable[] = [],
  ): Promise<WorkerResult> {
    if (signal?.aborted) return Promise.reject(abortError());
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(error);
    }
    const op = this.nextOp++;
    return new Promise<WorkerResult>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(op)) return;
        this.worker?.postMessage({ op: this.nextOp++, type: 'cancel', target: op });
        reject(abortError());
      };
      this.pending.set(op, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.postMessage({ ...request, op } as WorkerRequest, transfer);
    });
  }

  /**
   * Waits for one of the few slots for opening an archive (download and index), or refuses at once when too many
   * already wait. Returns the function that frees the slot.
   */
  async acquireOpenSlot(signal?: AbortSignal): Promise<() => void> {
    if (this.activeOpens >= this.limits.maxConcurrentOpens) {
      if (this.waiting.length >= this.limits.maxQueuedOpens) throw new LocalArchiveError('busy');
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const at = this.waiting.indexOf(wake);
          if (at >= 0) this.waiting.splice(at, 1);
          reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiting.push(wake);
      });
    }
    this.activeOpens += 1;
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      this.activeOpens -= 1;
      this.waiting.shift()?.();
    };
  }

  async open(
    request: {
      id: string;
      name: string;
      bytes?: ArrayBuffer;
      parent?: { id: string; entryIndex: number };
      pinned: string[];
    },
    signal?: AbortSignal,
  ): Promise<OpenResult> {
    let result: WorkerResult;
    try {
      result = await this.send(
        { type: 'open', ...request },
        signal,
        request.bytes ? [request.bytes] : [],
      );
    } catch (error) {
      // The worker may have finished opening it before it heard of the cancel: it is released, in order, after.
      if (signal?.aborted && this.worker) {
        void this.send({ type: 'release', ids: [request.id] }).catch(() => undefined);
      }
      throw error;
    }
    const { result: opened } = result as Extract<WorkerResult, { type: 'open' }>;
    this.released(opened.evicted);
    if (signal?.aborted) {
      // Opened after all, but no longer wanted: released at once, so nothing half-used stays in memory.
      void this.release([opened.id]);
      throw abortError();
    }
    this.held.add(opened.id);
    return opened;
  }

  async details(id: string, entryIndex: number, signal?: AbortSignal): Promise<LocalDetails> {
    const result = await this.send({ type: 'details', id, entryIndex }, signal);
    return (result as Extract<WorkerResult, { type: 'details' }>).result;
  }

  async read(
    id: string,
    entryIndex: number,
    kind: 'text' | 'pdf' | 'hex',
    offset: number,
    signal?: AbortSignal,
  ): Promise<LocalRead> {
    const result = await this.send({ type: 'read', id, entryIndex, kind, offset }, signal);
    return (result as Extract<WorkerResult, { type: 'read' }>).result;
  }

  async image(id: string, entryIndex: number, signal?: AbortSignal): Promise<LocalImageRead> {
    const result = await this.send({ type: 'image', id, entryIndex }, signal);
    return (result as Extract<WorkerResult, { type: 'image' }>).result;
  }

  async download(
    id: string,
    entryIndex: number,
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; integrity: 'verified' | 'complete' }> {
    const result = await this.send({ type: 'download', id, entryIndex }, signal);
    return (result as Extract<WorkerResult, { type: 'download' }>).result;
  }

  async release(ids: string[]): Promise<void> {
    if (!this.worker || ids.length === 0) return;
    const result = await this.send({ type: 'release', ids });
    this.released((result as Extract<WorkerResult, { type: 'release' }>).released);
  }

  async stats(): Promise<HostStats> {
    const result = await this.send({ type: 'stats' });
    return (result as Extract<WorkerResult, { type: 'stats' }>).result;
  }

  /**
   * Terminates the worker, releasing every archive it held at once, and fails what was still pending. Listeners are
   * told what was released. A later request starts a new, empty worker.
   */
  dispose(): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(abortError());
    for (const wake of this.waiting.splice(0)) wake();
    this.released([...this.held]);
  }
}
