export interface RateLimitRule {
  maxAttempts: number;
  windowSeconds: number;
}

export interface RateLimitKey {
  key: string;
  rule: RateLimitRule;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Bucket {
  attempts: number;
  resetsAt: number;
}

const MAX_TRACKED_KEYS = 50_000;

/**
 * Fixed-window attempt counter, held in this process. An attempt is counted when it starts and given
 * back if it succeeds, so a burst of parallel guesses cannot all pass the check before the first
 * failure is recorded.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one attempt against every key, or against none of them if any is exhausted. */
  attempt(keys: readonly RateLimitKey[]): RateLimitDecision {
    const now = this.now();
    let retryAfterMs = 0;
    for (const { key, rule } of keys) {
      const bucket = this.current(key, now);
      if (bucket && bucket.attempts >= rule.maxAttempts) {
        retryAfterMs = Math.max(retryAfterMs, bucket.resetsAt - now);
      }
    }
    if (retryAfterMs > 0) {
      return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
    }
    for (const { key, rule } of keys) {
      const bucket = this.current(key, now);
      if (bucket) {
        bucket.attempts += 1;
      } else {
        this.makeRoom(now);
        this.buckets.set(key, { attempts: 1, resetsAt: now + rule.windowSeconds * 1000 });
      }
    }
    return { allowed: true };
  }

  /** Gives back an attempt that turned out to be legitimate. */
  release(keys: readonly RateLimitKey[]): void {
    for (const { key } of keys) {
      const bucket = this.buckets.get(key);
      if (bucket) bucket.attempts = Math.max(0, bucket.attempts - 1);
    }
  }

  private current(key: string, now: number): Bucket | undefined {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.resetsAt <= now) {
      this.buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  private makeRoom(now: number): void {
    if (this.buckets.size < MAX_TRACKED_KEYS) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetsAt <= now) this.buckets.delete(key);
    }
    // Under a flood of distinct keys, the oldest go first. A Map iterates in insertion order.
    while (this.buckets.size >= MAX_TRACKED_KEYS) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) return;
      this.buckets.delete(oldest);
    }
  }
}
