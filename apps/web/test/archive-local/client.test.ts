/**
 * The page's side of the archive worker (decision 0058): cancellation, stale answers, worker failure, the open
 * slots and cleanup. The worker is the real handler, run in the same thread; where an answer must be held, the test
 * holds it.
 */
import { describe, expect, it } from 'vitest';
import { LocalArchiveClient, type WorkerLike } from '../../src/archive-local/client';
import { LocalArchiveError } from '../../src/archive-local/errors';
import { DEFAULT_LOCAL_LIMITS } from '../../src/archive-local/limits';
import type { WorkerRequest, WorkerResponse } from '../../src/archive-local/protocol';
import { serveArchiveRequests } from '../../src/archive-local/worker-handler';
import { text, zip } from './fixtures';

class HeldWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  terminated = false;
  received: WorkerRequest[] = [];
  /** Answers held back, until `flush()`. */
  held: WorkerResponse[] = [];
  hold = false;
  private readonly scope = {
    onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
    postMessage: (message: WorkerResponse) => {
      if (this.hold) this.held.push(message);
      else this.deliver(message);
    },
  };

  constructor() {
    serveArchiveRequests(this.scope);
  }

  private deliver(message: WorkerResponse) {
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
    }, 0);
  }

  flush() {
    this.hold = false;
    for (const message of this.held.splice(0)) this.deliver(message);
  }

  postMessage(message: WorkerRequest): void {
    this.received.push(message);
    setTimeout(() => this.scope.onmessage?.({ data: message } as MessageEvent<WorkerRequest>), 0);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const archive = () =>
  zip([
    { name: 'a.txt', data: text('first') },
    { name: 'b.txt', data: text('second') },
  ]).buffer as ArrayBuffer;

/** Until a condition holds, a turn at a time: no fixed delay. */
async function until(condition: () => boolean) {
  for (let turn = 0; turn < 1000 && !condition(); turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  expect(condition()).toBe(true);
}

describe('LocalArchiveClient', () => {
  it('starts no worker until it is needed, and terminates it on dispose', async () => {
    let worker: HeldWorker | null = null;
    let created = 0;
    const client = new LocalArchiveClient(DEFAULT_LOCAL_LIMITS, () => {
      created += 1;
      worker = new HeldWorker();
      return worker;
    });
    expect(client.started).toBe(false);
    await client.open({ id: 'a', name: 'a.zip', bytes: archive(), pinned: [] });
    expect(client.started).toBe(true);
    expect(client.heldIds()).toEqual(['a']);
    const released: string[][] = [];
    client.onReleased((ids) => released.push(ids));
    client.dispose();
    expect((worker as unknown as HeldWorker).terminated).toBe(true);
    expect(released).toEqual([['a']]);
    expect(client.heldIds()).toEqual([]);
    // Not final (React's StrictMode disposes once on mount): a later request gets a new, empty worker.
    await expect(client.read('a', 0, 'text', 0)).rejects.toMatchObject({ code: 'evicted' });
    expect(created).toBe(2);
  });

  it('answers an aborted request at once, tells the worker, and drops its late answer', async () => {
    const worker = new HeldWorker();
    const client = new LocalArchiveClient(DEFAULT_LOCAL_LIMITS, () => worker);
    await client.open({ id: 'a', name: 'a.zip', bytes: archive(), pinned: [] });
    worker.hold = true;
    const controller = new AbortController();
    const slow = client.read('a', 0, 'text', 0, controller.signal);
    await until(() => worker.received.some((message) => message.type === 'read'));
    controller.abort();
    await expect(slow).rejects.toMatchObject({ name: 'AbortError' });
    await until(() => worker.received.some((message) => message.type === 'cancel'));
    // The next request is answered with its own bytes, whatever the earlier one sends late.
    const next = client.read('a', 1, 'text', 0);
    await until(() => worker.held.length >= 2);
    worker.flush();
    const read = await next;
    expect(new TextDecoder().decode(read.bytes)).toBe('second');
  });

  it('releases an archive whose open was cancelled, leaving nothing in the worker', async () => {
    const worker = new HeldWorker();
    const client = new LocalArchiveClient(DEFAULT_LOCAL_LIMITS, () => worker);
    const controller = new AbortController();
    const opening = client.open(
      { id: 'x', name: 'x.zip', bytes: archive(), pinned: [] },
      controller.signal,
    );
    controller.abort();
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    await until(() => worker.received.some((message) => message.type === 'cancel'));
    expect(client.heldIds()).toEqual([]);
    const stats = await client.stats();
    expect(stats.archives).toBe(0);
    expect(stats.retainedBytes).toBe(0);
  });

  it('fails every pending request when the worker fails, reports what it held, and starts afresh', async () => {
    const workers: HeldWorker[] = [];
    const client = new LocalArchiveClient(DEFAULT_LOCAL_LIMITS, () => {
      const worker = new HeldWorker();
      workers.push(worker);
      return worker;
    });
    const released: string[][] = [];
    client.onReleased((ids) => released.push(ids));
    await client.open({ id: 'a', name: 'a.zip', bytes: archive(), pinned: [] });
    (workers[0] as HeldWorker).hold = true;
    const pending = client.read('a', 0, 'text', 0);
    await until(() =>
      (workers[0] as HeldWorker).received.some((message) => message.type === 'read'),
    );
    (workers[0] as HeldWorker).onerror?.(new Event('error'));
    await expect(pending).rejects.toMatchObject({ code: 'worker_failed' });
    expect(released).toEqual([['a']]);
    expect((workers[0] as HeldWorker).terminated).toBe(true);
    await client.open({ id: 'b', name: 'b.zip', bytes: archive(), pinned: [] });
    expect(workers).toHaveLength(2);
  });

  it('opens at most two archives at once, lets a few wait, and refuses more', async () => {
    const client = new LocalArchiveClient(
      { ...DEFAULT_LOCAL_LIMITS, maxConcurrentOpens: 2, maxQueuedOpens: 1 },
      () => new HeldWorker(),
    );
    const first = await client.acquireOpenSlot();
    const second = await client.acquireOpenSlot();
    let thirdIn = false;
    const third = client.acquireOpenSlot().then((free) => {
      thirdIn = true;
      return free;
    });
    await expect(client.acquireOpenSlot()).rejects.toMatchObject({ code: 'busy' });
    expect(thirdIn).toBe(false);
    first();
    const freeThird = await third;
    expect(thirdIn).toBe(true);
    second();
    freeThird();
    // A waiting request that is aborted leaves the queue.
    const a = await client.acquireOpenSlot();
    const b = await client.acquireOpenSlot();
    const controller = new AbortController();
    const waiting = client.acquireOpenSlot(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    a();
    b();
    client.dispose();
  });

  it('carries the worker’s error codes and words, never a library’s', async () => {
    const client = new LocalArchiveClient(DEFAULT_LOCAL_LIMITS, () => new HeldWorker());
    const failure = await client
      .open({
        id: 'a',
        name: 'a.zip',
        bytes: new TextEncoder().encode('not an archive at all').buffer as ArrayBuffer,
        pinned: [],
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LocalArchiveError);
    expect((failure as LocalArchiveError).code).toBe('malformed');
    expect((failure as LocalArchiveError).message).toBe(
      'The archive is damaged or is not the format it appears to be.',
    );
    client.dispose();
  });
});
