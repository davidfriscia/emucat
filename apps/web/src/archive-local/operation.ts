import { LocalArchiveError } from './errors';

/**
 * One operation's cancellation and deadline, checked cooperatively. Long loops call `checkpoint()` between slices of
 * work; it yields to the event loop (so a cancel message can arrive), then throws if the operation was cancelled or
 * ran out of time. A worker that never reaches a checkpoint is still stopped by terminating it.
 */
export class Operation {
  private cancelled = false;
  private lastYield = Date.now();
  readonly deadline: number;

  constructor(timeoutMs: number) {
    this.deadline = Date.now() + timeoutMs;
  }

  cancel(): void {
    this.cancelled = true;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Throws when cancelled or late, without yielding. */
  check(): void {
    if (this.cancelled) throw new LocalArchiveError('cancelled');
    if (Date.now() > this.deadline) throw new LocalArchiveError('timeout');
  }

  /** Yields to the event loop at most every few milliseconds, then checks. */
  async checkpoint(): Promise<void> {
    this.check();
    const now = Date.now();
    if (now - this.lastYield < 8) return;
    this.lastYield = now;
    await yieldToEventLoop();
    this.check();
  }
}

/** A macrotask, so that messages queued for this thread are handled before work goes on. */
export function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** An operation that never ends early, for synchronous helpers and tests. */
export const unbounded = (): Operation => new Operation(Number.MAX_SAFE_INTEGER / 2);
